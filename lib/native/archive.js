/**
 * Deterministic archive planning and execution for OpenSpec-native changes.
 *
 * Archiving is a two-phase operation:
 *
 * 1. `planArchive` is pure. It gates on the change validation result (an ERROR
 *    refuses the archive, WARNINGs are surfaced but do not block), on the sync
 *    plan, on an existing archive target and on `skip_specs`, then returns
 *    `{ ok, issues, archiveRel, write, move }`. `previewArchive` renders that
 *    plan for the user.
 * 2. `executeArchive` performs it: it applies the planned main-spec writes
 *    first (`applySyncPlan`, which rolls itself back on failure), then moves the
 *    whole change tree to `openspec/changes/archive/YYYY-MM-DD-<name>/`. The
 *    move is a rename with a copy+remove fallback for cross-device moves. If the
 *    move fails after the spec writes were applied, the writes are restored
 *    from in-memory backups so the workspace returns to its pre-archive state.
 *
 * All filesystem operations go through an injectable `io` object (default
 * `node:fs/promises`) so tests can drive the engine with an in-memory fake.
 * Archive names are validated (no separators, no `..`, no non-portable
 * characters) and every move is containment-checked before it happens, so a
 * tampered plan cannot write or move outside the workspace.
 *
 * @module dsh-spec/native/archive
 */

import path from 'node:path'
import * as nodeFsPromises from 'node:fs/promises'
import { applySyncPlan } from './merge.js'
import { formatLocalDate } from './metadata.js'

/** Workspace-relative archive root. */
const ARCHIVE_ROOT = 'openspec/changes/archive'

/** Workspace-relative active-changes root. */
const CHANGES_ROOT = 'openspec/changes'

/** Change metadata file retained by the archive move. */
const METADATA_FILE = '.openspec.yaml'

/** Local-date archive prefix, as written by the native tool. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Rename failures that justify the copy+remove fallback. */
const MOVE_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EACCES', 'ENOSYS', 'ENOTDIR'])

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} error
 * @returns {string|undefined} errno-style code of an error
 */
function errorCode(error) {
  return error && typeof error === 'object'
    ? /** @type {{code?: string}} */ (error).code
    : undefined
}

/**
 * @param {unknown} error
 * @returns {boolean} whether the error means "path does not exist"
 */
function isMissingPathError(error) {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * @param {unknown} error
 * @returns {boolean} whether a rename failure should fall back to copy+remove
 */
function isMoveFallbackError(error) {
  const code = errorCode(error)
  return typeof code === 'string' && MOVE_FALLBACK_CODES.has(code)
}

/**
 * Validate a change name used to build a directory name.
 *
 * @param {unknown} value
 * @returns {string|null} error message, or null when valid
 */
function validateChangeName(value) {
  if (typeof value !== 'string' || value === '') {
    return 'changeName must be a non-empty string'
  }
  if (value !== value.trim()) {
    return 'changeName must not start or end with whitespace'
  }
  if (value === '.' || value === '..') {
    return 'changeName must not be "." or ".."'
  }
  if (value.startsWith('.')) {
    return `changeName must not start with ".": ${value}`
  }
  if (value.length > 200) {
    return 'changeName is too long'
  }
  if (/[\\/]/.test(value)) {
    return `changeName must not contain path separators: ${value}`
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(value)) {
    return `changeName contains characters that are not portable in a directory name: ${value}`
  }
  if (value.endsWith('.')) {
    return `changeName must not end with ".": ${value}`
  }
  return null
}

/**
 * Validate a `YYYY-MM-DD` local date.
 *
 * @param {unknown} value
 * @returns {string|null} error message, or null when valid
 */
function validateLocalDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return `localDate must be YYYY-MM-DD: ${String(value)}`
  }
  const [year, month, day] = value.split('-').map((part) => Number(part))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return `localDate is not a real calendar date: ${value}`
  }
  return null
}

/**
 * Accept either the `readChangeMetadata` result
 * (`{found, metadata, warnings, error}`) or a flat metadata object
 * (`ChangeState.metadata`).
 *
 * @param {unknown} metadata
 * @returns {{found: boolean, skip_specs: boolean, retire_capabilities: boolean, error: string|null}}
 */
function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return { found: false, skip_specs: false, retire_capabilities: false, error: null }
  }
  const record = /** @type {Record<string, unknown>} */ (metadata)
  const inner = record.metadata && typeof record.metadata === 'object'
    ? /** @type {Record<string, unknown>} */ (record.metadata)
    : record
  let error = null
  if (record.error) {
    if (typeof record.error === 'string') {
      error = record.error
    } else if (typeof record.error === 'object') {
      const message = /** @type {{message?: unknown}} */ (record.error).message
      error = typeof message === 'string' && message ? message : 'change metadata is invalid'
    }
  }
  const found = record.found === true
    || (record.found !== false && Object.keys(inner).length > 0)
  return {
    found,
    skip_specs: inner.skip_specs === true,
    retire_capabilities: inner.retire_capabilities === true,
    error,
  }
}

/**
 * Normalise a validation result into native issue objects. Accepts
 * `{issues, summary}` (validateChange) and `{errors, warnings, infos, issues}`
 * (ChangeState.validation).
 *
 * @param {unknown} validation
 * @returns {Array<{level: string, path?: string, line?: number, message: string}>|null}
 *   null when no validation result was supplied at all
 */
function collectValidationIssues(validation) {
  if (validation === undefined || validation === null) return null
  if (typeof validation !== 'object') {
    return [{ level: 'WARNING', message: 'the supplied validation result was not an object' }]
  }
  const record = /** @type {Record<string, unknown>} */ (validation)
  const rawIssues = Array.isArray(record.issues) ? record.issues : []
  const issues = []
  for (const rawIssue of rawIssues) {
    if (!rawIssue || typeof rawIssue !== 'object') continue
    const issue = /** @type {Record<string, unknown>} */ (rawIssue)
    const level = issue.level === 'ERROR' || issue.level === 'INFO' ? issue.level : 'WARNING'
    const normalized = {
      level,
      message: String(issue.message ?? 'validation issue'),
    }
    if (typeof issue.path === 'string' && issue.path) normalized.path = issue.path
    if (typeof issue.line === 'number') normalized.line = issue.line
    issues.push(normalized)
  }
  // When only a summary was supplied, turn its counts into one issue each so
  // the gate and the report keep working.
  const summary = record.summary && typeof record.summary === 'object'
    ? /** @type {Record<string, unknown>} */ (record.summary)
    : record
  if (issues.length === 0) {
    const errors = Number(summary.errors ?? 0)
    const warnings = Number(summary.warnings ?? 0)
    if (Number.isFinite(errors) && errors > 0) {
      issues.push({ level: 'ERROR', message: `change validation reported ${errors} error(s)` })
    }
    if (Number.isFinite(warnings) && warnings > 0) {
      issues.push({ level: 'WARNING', message: `change validation reported ${warnings} warning(s)` })
    }
  }
  return issues
}

/**
 * Resolve a workspace-relative path and prove it stays inside the workspace.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} relPath workspace-relative POSIX path
 * @param {string} label what the path is, for error messages
 * @returns {string} absolute path
 */
function toWorkspaceAbsolute(cwd, relPath, label) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('cwd must be a non-empty absolute workspace path')
  }
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, relPath)
  const relative = path.relative(root, absolute)
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes the workspace: ${relPath}`)
  }
  return absolute
}

/**
 * Classify a path through the injected io object.
 *
 * @param {object} io
 * @param {string} absolutePath
 * @returns {Promise<'missing'|'file'|'directory'|'other'>}
 */
async function statKind(io, absolutePath) {
  let stats
  try {
    stats = await io.stat(absolutePath)
  } catch (error) {
    if (isMissingPathError(error)) return 'missing'
    throw error
  }
  if (stats && typeof stats.isDirectory === 'function') {
    if (stats.isDirectory()) return 'directory'
    if (typeof stats.isFile !== 'function' || stats.isFile()) return 'file'
    return 'other'
  }
  return 'file'
}

/**
 * Recursively copy a directory tree through the injected io object.
 *
 * @param {object} io
 * @param {string} fromAbs
 * @param {string} toAbs
 * @returns {Promise<void>}
 */
async function copyTree(io, fromAbs, toAbs) {
  const names = await io.readdir(fromAbs)
  await io.mkdir(toAbs, { recursive: true })
  for (const name of names) {
    const source = path.join(fromAbs, name)
    const destination = path.join(toAbs, name)
    const kind = await statKind(io, source)
    if (kind === 'missing') continue
    if (kind === 'directory') {
      await copyTree(io, source, destination)
      continue
    }
    if (typeof io.copyFile === 'function') {
      await io.copyFile(source, destination)
    } else {
      await io.writeFile(destination, await io.readFile(source))
    }
  }
}

/**
 * Render the ERROR issues of a plan into a single-line suffix for throw
 * messages.
 *
 * @param {unknown} issues
 * @returns {string}
 */
function summarizeIssues(issues) {
  const list = Array.isArray(issues) ? issues : []
  const errors = list
    .filter((issue) => issue && typeof issue === 'object' && /** @type {any} */ (issue).level === 'ERROR')
    .map((issue) => String(/** @type {any} */ (issue).message ?? ''))
    .filter((message) => message !== '')
  return errors.length > 0 ? ` (${errors.join('; ')})` : ''
}

/**
 * Capture the current content of every main spec the sync plan would write.
 * Used to restore the workspace when the archive move fails afterwards.
 *
 * @param {object} io
 * @param {string} cwd
 * @param {unknown} syncPlan
 * @returns {Promise<Array<{absolute: string, content: string|null}>>}
 */
async function captureWriteBackups(io, cwd, syncPlan) {
  const backups = []
  if (!syncPlan || typeof syncPlan !== 'object') return backups
  const writes = Array.isArray(/** @type {any} */ (syncPlan).writes)
    ? /** @type {any} */ (syncPlan).writes
    : []
  for (const write of writes) {
    if (!write || typeof write !== 'object' || typeof write.path !== 'string') continue
    let absolute
    try {
      absolute = toWorkspaceAbsolute(cwd, write.path, 'plan write')
    } catch {
      // applySyncPlan rejects an unsafe write before touching anything.
      continue
    }
    let content = null
    try {
      content = String(await io.readFile(absolute, 'utf8'))
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      content = null
    }
    backups.push({ absolute, content })
  }
  return backups
}

/**
 * Restore main specs captured by `captureWriteBackups`.
 *
 * @param {object} io
 * @param {Array<{absolute: string, content: string|null}>} backups
 * @returns {Promise<string|null>} first restore error message, or null
 */
async function restoreWriteBackups(io, backups) {
  let firstError = null
  for (const backup of [...backups].reverse()) {
    try {
      if (backup.content === null) {
        await io.rm(backup.absolute, { force: true })
      } else {
        await io.mkdir(path.dirname(backup.absolute), { recursive: true })
        await io.writeFile(backup.absolute, backup.content, 'utf8')
      }
    } catch (error) {
      if (!firstError) firstError = error instanceof Error ? error.message : String(error)
    }
  }
  return firstError
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Plan the archive of one change. Pure: no filesystem access.
 *
 * The caller supplies `targetExists` (usually from a stat of the archive target)
 * because planning must stay testable without disk access; `executeArchive`
 * re-checks the target against the filesystem before moving anything.
 *
 * @param {{
 *   changeName: string,
 *   localDate?: string,
 *   metadata?: object,
 *   validation?: object,
 *   syncPlan?: object|null,
 *   targetExists?: boolean
 * }} input
 * @returns {{
 *   ok: boolean,
 *   issues: Array<{level: string, path?: string, line?: number, message: string}>,
 *   archiveRel: string,
 *   write: object|null,
 *   move: {from: string, to: string},
 *   changeName: string,
 *   localDate: string,
 *   skipSpecs: boolean,
 *   retireCapabilities: boolean
 * }}
 */
export function planArchive(input) {
  const options = input && typeof input === 'object' ? input : {}
  const issues = []
  const seen = new Set()
  const push = (level, message, extra = {}) => {
    const issue = { level, message }
    if (typeof extra.path === 'string' && extra.path) issue.path = extra.path
    if (typeof extra.line === 'number') issue.line = extra.line
    const key = [issue.level, issue.path ?? '', issue.line ?? '', issue.message].join('\u0000')
    if (seen.has(key)) return issue
    seen.add(key)
    issues.push(issue)
    return issue
  }

  // Change name and archive target.
  const changeName = typeof options.changeName === 'string' ? options.changeName.trim() : ''
  const nameError = validateChangeName(options.changeName)
  if (nameError) push('ERROR', nameError)

  const metadataInfo = normalizeMetadata(options.metadata)
  if (metadataInfo.error) {
    push('ERROR', `change metadata is invalid: ${metadataInfo.error}`, { path: METADATA_FILE })
  }

  let localDate = options.localDate
  if (localDate === undefined || localDate === null) {
    localDate = formatLocalDate()
  }
  const dateError = validateLocalDate(localDate)
  if (dateError) push('ERROR', dateError)

  const archiveRel = `${ARCHIVE_ROOT}/${localDate}-${changeName}`
  const move = {
    from: `${CHANGES_ROOT}/${changeName}`,
    to: archiveRel,
  }

  // Validation gate: ERROR refuses the archive, WARNING/INFO are surfaced.
  const validationIssues = collectValidationIssues(options.validation)
  if (validationIssues === null) {
    push('WARNING', 'no validation result was supplied; the validation gate was not applied')
  } else {
    for (const issue of validationIssues) {
      push(issue.level, issue.message, { path: issue.path, line: issue.line })
    }
  }

  // Sync plan: required unless skip_specs says the change touches no specs.
  let write = null
  if (metadataInfo.skip_specs) {
    const plannedWrites = options.syncPlan && Array.isArray(options.syncPlan.writes)
      ? options.syncPlan.writes.length
      : 0
    if (plannedWrites > 0) {
      push(
        'WARNING',
        `skip_specs is set; ignoring ${plannedWrites} planned main-spec write(s)`,
      )
    }
  } else if (
    !options.syncPlan
    || typeof options.syncPlan !== 'object'
    || typeof /** @type {any} */ (options.syncPlan).ok !== 'boolean'
  ) {
    push(
      'ERROR',
      'no valid sync plan was supplied; main-spec updates are required (set skip_specs to archive without them)',
    )
  } else {
    const syncPlan = options.syncPlan
    const syncIssues = Array.isArray(syncPlan.issues) ? syncPlan.issues : []
    if (syncPlan.ok !== true) {
      push('ERROR', 'the sync plan contains errors and cannot be applied')
      for (const issue of syncIssues) {
        if (issue && issue.level === 'ERROR') {
          push('ERROR', `sync: ${String(issue.message ?? '')}`, {
            path: typeof issue.path === 'string' ? issue.path : undefined,
            line: typeof issue.line === 'number' ? issue.line : undefined,
          })
        }
      }
    } else {
      write = syncPlan
      for (const issue of syncIssues) {
        if (!issue || issue.level === 'ERROR') continue
        push(issue.level === 'INFO' ? 'INFO' : 'WARNING', `sync: ${String(issue.message ?? '')}`, {
          path: typeof issue.path === 'string' ? issue.path : undefined,
          line: typeof issue.line === 'number' ? issue.line : undefined,
        })
      }
      if (!Array.isArray(syncPlan.writes) || syncPlan.writes.length === 0) {
        push('INFO', 'the sync plan contains no main-spec changes')
      }
    }
  }

  // The destination must not exist yet: a collision would leave specs merged
  // for an archive that never happened.
  if (options.targetExists === true) {
    push('ERROR', `archive target already exists: ${archiveRel}`, { path: archiveRel })
  }

  if (!metadataInfo.found) {
    push('INFO', `change has no ${METADATA_FILE}; the archived directory will not contain change metadata`)
  }

  const ok = issues.every((issue) => issue.level !== 'ERROR')
  return {
    ok,
    issues,
    archiveRel,
    write: ok ? write : null,
    move,
    changeName,
    localDate,
    skipSpecs: metadataInfo.skip_specs,
    retireCapabilities: metadataInfo.retire_capabilities,
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Render the human-readable (Chinese) dry-run preview for an archive plan.
 *
 * @param {{
 *   ok: boolean,
 *   changeName?: string,
 *   archiveRel?: string,
 *   move?: {from: string, to: string},
 *   write?: {writes?: Array<{path: string, action: string, summary?: string}>}|null,
 *   skipSpecs?: boolean,
 *   issues?: Array<{level: string, path?: string, line?: number, message: string}>
 * }} plan
 * @returns {{text: string, target: string}}
 */
export function previewArchive(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('previewArchive requires an archive plan object')
  }
  const issues = Array.isArray(plan.issues) ? plan.issues : []
  const target = typeof plan.archiveRel === 'string' ? plan.archiveRel : ''
  const move = plan.move && typeof plan.move === 'object' ? plan.move : { from: '', to: target }
  const lines = []
  lines.push(plan.changeName ? `变更 ${plan.changeName} 归档预览` : '归档预览')
  lines.push('')
  lines.push(`目标目录：${target || '(未知)'}`)
  lines.push('')

  const plannedWrites = plan.write && Array.isArray(plan.write.writes) ? plan.write.writes : []
  if (plan.skipSpecs) {
    lines.push('skip_specs：已声明，本次不写主 specs。')
  } else if (plannedWrites.length > 0) {
    lines.push(`主 specs 变更（${plannedWrites.length} 个文件）：`)
    for (const write of plannedWrites) {
      const label = write.action === 'create' ? '创建' : write.action === 'remove' ? '移除' : '更新'
      lines.push(`  - ${label} ${write.path}`)
      if (write.summary) lines.push(`      ${write.summary}`)
    }
  } else {
    lines.push('主 specs 无变更。')
  }

  lines.push('')
  lines.push(`移动：${move.from || '(未知)'} -> ${move.to || '(未知)'}`)

  const errors = issues.filter((issue) => issue.level === 'ERROR')
  const warnings = issues.filter((issue) => issue.level !== 'ERROR')
  if (warnings.length > 0) {
    lines.push('')
    lines.push(`警告（${warnings.length}）：`)
    for (const issue of warnings) lines.push(`  - ${formatIssue(issue)}`)
  }
  if (errors.length > 0) {
    lines.push('')
    lines.push(`错误（${errors.length}），本次不会归档：`)
    for (const issue of errors) lines.push(`  - ${formatIssue(issue)}`)
  }
  lines.push('')
  lines.push(plan.ok ? '确认后执行归档（--yes）。' : '存在错误，已拒绝归档。')
  return { text: lines.join('\n'), target }
}

/**
 * Format one issue as a single deterministic line.
 *
 * @param {{level: string, path?: string, line?: number, message: string}} issue
 * @returns {string}
 */
function formatIssue(issue) {
  const location = issue.path
    ? `${issue.path}${typeof issue.line === 'number' ? `:${issue.line}` : ''}: `
    : ''
  return `${issue.level}: ${location}${issue.message}`
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a planned archive: apply the sync writes, then move the change tree
 * under `openspec/changes/archive/`.
 *
 * All filesystem operations go through the injected `io` object (default
 * `node:fs/promises`). The archive target is re-checked against the filesystem,
 * both the source and destination are containment-checked, and a failed move
 * after successful spec writes restores those writes from in-memory backups.
 *
 * @param {{cwd: string, plan: object, io?: object}} input
 * @returns {Promise<{moved: boolean, target: string}>}
 */
export async function executeArchive(input) {
  const options = input && typeof input === 'object' ? input : {}
  const cwd = options.cwd
  const plan = options.plan
  const io = options.io ?? nodeFsPromises
  if (!plan || typeof plan !== 'object') {
    throw new Error('executeArchive requires an archive plan object')
  }
  if (plan.ok !== true) {
    throw new Error(`refusing to execute an unsafe archive plan${summarizeIssues(plan.issues)}`)
  }
  const changeName = typeof plan.changeName === 'string' ? plan.changeName : ''
  const nameError = validateChangeName(changeName)
  if (nameError) throw new Error(`invalid archive plan: ${nameError}`)
  const localDate = typeof plan.localDate === 'string' ? plan.localDate : ''
  const dateError = validateLocalDate(localDate)
  if (dateError) throw new Error(`invalid archive plan: ${dateError}`)
  const archiveRel = typeof plan.archiveRel === 'string' ? plan.archiveRel : ''
  const expectedRel = `${ARCHIVE_ROOT}/${localDate}-${changeName}`
  if (archiveRel !== expectedRel) {
    throw new Error(`archive plan target does not match its change/date: ${archiveRel}`)
  }
  if (plan.write && typeof plan.write === 'object' && plan.write.ok !== true) {
    throw new Error('refusing to execute an archive plan whose sync write plan is not ok')
  }

  const fromRel = `${CHANGES_ROOT}/${changeName}`
  const fromAbs = toWorkspaceAbsolute(cwd, fromRel, 'change directory')
  const targetAbs = toWorkspaceAbsolute(cwd, archiveRel, 'archive target')

  // Preflight: the change must exist and the destination must not.
  const sourceKind = await statKind(io, fromAbs)
  if (sourceKind === 'missing') throw new Error(`change directory does not exist: ${fromRel}`)
  if (sourceKind !== 'directory') throw new Error(`change path is not a directory: ${fromRel}`)
  const targetKind = await statKind(io, targetAbs)
  if (targetKind !== 'missing') throw new Error(`archive target already exists: ${archiveRel}`)

  // Snapshot the main specs the sync will write, so a move failure can restore
  // the workspace to its pre-archive state.
  const writeBackups = await captureWriteBackups(io, cwd, plan.write)
  let syncApplied = false
  let targetMayExist = false
  try {
    if (plan.write && Array.isArray(plan.write.writes) && plan.write.writes.length > 0) {
      await applySyncPlan({ cwd, plan: plan.write, io })
      syncApplied = true
    }

    await io.mkdir(path.dirname(targetAbs), { recursive: true })
    try {
      await io.rename(fromAbs, targetAbs)
    } catch (error) {
      if (!isMoveFallbackError(error)) throw error
      targetMayExist = true
      await copyTree(io, fromAbs, targetAbs)
      try {
        await io.rm(fromAbs, { recursive: true, force: true })
      } catch (removeError) {
        try {
          await io.rm(targetAbs, { recursive: true, force: true })
          targetMayExist = false
        } catch {
          // best effort; the move error below is the actionable one
        }
        throw removeError
      }
    }
    return { moved: true, target: archiveRel }
  } catch (error) {
    if (targetMayExist) {
      try {
        await io.rm(targetAbs, { recursive: true, force: true })
      } catch {
        // best effort cleanup of a partial copy
      }
    }
    let restoreError = null
    if (syncApplied) {
      restoreError = await restoreWriteBackups(io, writeBackups)
    }
    const message = error instanceof Error ? error.message : String(error)
    const restored = syncApplied
      ? (restoreError ? '; restoring the main specs also failed' : '; the main specs were restored')
      : ''
    const restoreDetail = restoreError ? ` (${restoreError})` : ''
    throw new Error(`archive failed: ${message}${restored}${restoreDetail}`)
  }
}
