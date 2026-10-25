/**
 * Mechanical write coordinator for multi-role OpenSpec work.
 *
 * The coordinator only governs the plugin's own `openspec_read_file` /
 * `openspec_write_file` tools. Native DSH `write` / `edit` / shell writes are
 * deliberately outside this boundary. Within the boundary:
 *
 * - a role may only write inside its task's change directory (plus its handoff);
 * - writes to the same absolute path are strictly serialized;
 * - an existing file must be read through the coordinator first, and the
 *   expected SHA-256 is checked again at write time;
 * - stale versions and lock timeouts are appended to `pm/conflicts.md` so the
 *   PM can decide what to do.
 *
 * @module dsh-spec/native/write-coordinator
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { joinRel, pathExists, readTextOrNull } from './fsio.js'
import { programRel, readProgram } from './orchestration.js'

/** Strict serialization is process-local; one plugin Host owns one workspace. */
const locks = new Map()
/** Lock wait before reporting a conflict. */
const LOCK_TIMEOUT_MS = 60_000
/** Session id → the role that Host actually started through `/opsx-role`. */
const writers = new Map()

/**
 * Bind one agent session to the role it was started for. The tool uses this
 * map as authority, so arguments cannot impersonate another role.
 */
export function registerWriter(agent, info) {
  const sessionId = agent?.session?.id ?? agent?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return
  writers.set(sessionId, {
    cwd: info.cwd,
    program: info.program,
    task: info.task,
    role: info.role,
  })
}

/** Resolve the writer bound to one agent session, if any. */
export function writerForAgent(agent) {
  const sessionId = agent?.session?.id ?? agent?.sessionId
  return typeof sessionId === 'string' ? (writers.get(sessionId) ?? null) : null
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Normalize a repo-relative path and reject absolute paths and traversal.
 * @param {string} value
 * @returns {string}
 */
export function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('path 不能为空')
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`path 必须是仓库内相对路径：${value}`)
  }
  if (path.posix.isAbsolute(normalized)) throw new Error(`path 必须是相对路径：${value}`)
  return normalized
}

/** Resolve the task's permitted write roots. */
function allowedRoots(program, task, role) {
  const scopes =
    Array.isArray(task.writeScope) && task.writeScope.length > 0
      ? task.writeScope.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      : ['.']
  return {
    ownChange: `openspec/changes/${task.change}/`,
    handoff: `${programRel(program.id)}/handoffs/${task.id}-${role}.md`,
    scopes,
  }
}

/** The coordinator never participates in VCS internals or dependencies. */
function isForbiddenPath(relPath) {
  return (
    relPath === '.git' ||
    relPath.startsWith('.git/') ||
    relPath === 'node_modules' ||
    relPath.startsWith('node_modules/') ||
    relPath.includes('/node_modules/')
  )
}

function scopeCovers(scope, relPath) {
  if (scope === '.' || scope === './' || scope === '') return true
  const normalized = scope.replace(/\/+$/, '')
  return relPath === normalized || relPath.startsWith(`${normalized}/`)
}

/** Validate one role/path pair and return the normalized relative path. */
export async function resolveRoleWrite(cwd, { program: programId, task: taskId, role, path: relPath }) {
  if (typeof programId !== 'string' || programId === '') throw new Error('program 不能为空')
  if (typeof taskId !== 'string' || taskId === '') throw new Error('task 不能为空')
  if (role !== 'dev') throw new Error(`未知角色：${role}（现在只有 dev 执行者）`)
  const program = await readProgram(cwd, programId)
  const task = program.tasks.find((entry) => entry.id === taskId)
  if (task === undefined) throw new Error(`找不到子任务：${taskId}`)
  if (!Array.isArray(task.roles) || !task.roles.includes(role)) {
    throw new Error(`子任务 ${taskId} 未启用角色：${role}`)
  }
  const normalized = normalizeRelativePath(relPath)
  if (isForbiddenPath(normalized)) throw new Error(`拒绝写入受保护路径：${normalized}`)
  const allowed = allowedRoots(program, task, role)
  const inOwnChange = normalized.startsWith(allowed.ownChange)
  const isHandoff = normalized === allowed.handoff
  if (normalized.startsWith('openspec/orchestration/') && !isHandoff) {
    throw new Error(`写入越界：角色不能修改程序元数据或 PM 文件：${normalized}`)
  }
  if (normalized.startsWith('openspec/changes/') && !inOwnChange) {
    throw new Error(`写入越界：${normalized} 属于其他 change，不能跨任务写`)
  }
  if (!inOwnChange && !isHandoff && !allowed.scopes.some((scope) => scopeCovers(scope, normalized))) {
    throw new Error(`写入越界：${normalized} 不在 ${taskId}/${role} 的允许范围内`)
  }
  return { program, task, path: normalized }
}

/** Wait for the per-path lock or fail with a conflict. */
async function acquire(key) {
  let lock = locks.get(key)
  if (lock === undefined) {
    lock = { busy: false, waiters: [] }
    locks.set(key, lock)
  }
  if (!lock.busy) {
    lock.busy = true
    return () => release(key, lock)
  }
  await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: undefined }
    waiter.timer = setTimeout(() => {
      lock.waiters = lock.waiters.filter((entry) => entry !== waiter)
      reject(new Error(`写入冲突：${path.basename(key)} 被其他角色占用超过 ${LOCK_TIMEOUT_MS / 1000} 秒`))
    }, LOCK_TIMEOUT_MS)
    lock.waiters.push(waiter)
  })
  return () => release(key, lock)
}

function release(key, lock) {
  const next = lock.waiters.shift()
  if (next !== undefined) {
    clearTimeout(next.timer)
    next.resolve()
    return
  }
  lock.busy = false
  locks.delete(key)
}

/** Append one conflict entry; never let reporting mask the original error. */
async function reportConflict(cwd, programId, entry) {
  try {
    const rel = joinRel(programRel(programId), 'pm', 'conflicts.md')
    const abs = path.join(cwd, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const block = [
      `## ${new Date().toISOString()} · ${entry.task}/${entry.role}`,
      '',
      `- path: \`${entry.path}\``,
      `- reason: ${entry.reason}`,
      `- expected: \`${entry.expected ?? 'none'}\``,
      `- actual: \`${entry.actual ?? 'none'}\``,
      '',
    ].join('\n')
    await fs.appendFile(abs, `${block}\n`, 'utf8')
  } catch {
    /* best effort */
  }
}

/** Read one in-scope file, returning the content hash needed by writes. */
export async function readForRole(cwd, input) {
  const resolved = await resolveRoleWrite(cwd, input)
  const text = await readTextOrNull(cwd, resolved.path)
  return {
    path: resolved.path,
    exists: text !== null,
    content: text ?? '',
    sha256: text === null ? '' : sha256(text),
  }
}

/**
 * Write one in-scope file through the mechanical coordinator.
 * Existing files require the SHA-256 returned by `readForRole`.
 */
export async function writeForRole(cwd, input) {
  const resolved = await resolveRoleWrite(cwd, input)
  const changePrefix = `openspec/changes/${resolved.task.change}/`
  if (input.role === 'dev' && !resolved.path.startsWith(changePrefix)) {
    const missing = []
    if (!(await pathExists(cwd, `${changePrefix}proposal.md`))) missing.push('proposal.md')
    if (!(await pathExists(cwd, `${changePrefix}tasks.md`))) missing.push('tasks.md')
    if (resolved.task.roles.includes('design') && !(await pathExists(cwd, `${changePrefix}design.md`))) {
      missing.push('design.md')
    }
    if (missing.length > 0) {
      throw new Error(`先完成 OpenSpec 文档再写代码，当前缺少：${missing.join('、')}`)
    }
  }
  const content = typeof input.content === 'string' ? input.content : ''
  const absolute = path.join(cwd, resolved.path)
  const key = `${path.resolve(cwd)}\0${path.resolve(absolute)}`
  let releaseLock
  try {
    releaseLock = await acquire(key)
  } catch (failure) {
    await reportConflict(cwd, resolved.program.id, {
      task: resolved.task.id,
      role: input.role,
      path: resolved.path,
      reason: failure instanceof Error ? failure.message : String(failure),
      expected: input.expectedSha256 ?? null,
      actual: null,
    })
    throw failure
  }
  try {
    const current = await readTextOrNull(cwd, resolved.path)
    const currentHash = current === null ? '' : sha256(current)
    if (current !== null) {
      if (typeof input.expectedSha256 !== 'string' || input.expectedSha256 === '') {
        await reportConflict(cwd, resolved.program.id, {
          task: resolved.task.id,
          role: input.role,
          path: resolved.path,
          reason: '覆盖已存在文件但未提供 expectedSha256；请先用 openspec_read_file 读取',
          expected: null,
          actual: currentHash,
        })
        throw new Error(`写入冲突：${resolved.path} 已存在。先 openspec_read_file 获取 sha256，再带 expectedSha256 重试。`)
      }
      if (input.expectedSha256 !== currentHash) {
        await reportConflict(cwd, resolved.program.id, {
          task: resolved.task.id,
          role: input.role,
          path: resolved.path,
          reason: '文件在读取后被其他角色修改（版本哈希不匹配）',
          expected: input.expectedSha256,
          actual: currentHash,
        })
        throw new Error(
          `写入冲突：${resolved.path} 已被修改。当前 sha256=${currentHash}，请重新读取后再写。`,
        )
      }
    } else if (typeof input.expectedSha256 === 'string' && input.expectedSha256 !== '') {
      await reportConflict(cwd, resolved.program.id, {
        task: resolved.task.id,
        role: input.role,
        path: resolved.path,
        reason: '目标文件不存在，但提供了 expectedSha256',
        expected: input.expectedSha256,
        actual: null,
      })
      throw new Error(`写入冲突：${resolved.path} 不存在，不能带 expectedSha256 创建新文件。`)
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temp, content, 'utf8')
    await fs.rename(temp, absolute)
    return { path: resolved.path, sha256: sha256(content), bytes: Buffer.byteLength(content, 'utf8') }
  } finally {
    releaseLock()
  }
}

/** Append a coordinator-level conflict without holding a path lock. */
export async function recordConflict(cwd, programId, entry) {
  await reportConflict(cwd, programId, entry)
}
