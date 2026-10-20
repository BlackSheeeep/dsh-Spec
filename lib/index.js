/**
 * dsh-spec — Host half.
 *
 * DSH front end for native OpenSpec content. The plugin owns no workflow state
 * of its own: every answer is derived from the workspace files by the pure-JS
 * engine in `./native/**`, and the browser half reads it through the read-only
 * `/dsh-spec` route below. Writes stay in commands (`src/commands.js`), so they
 * run inside a session and can be confirmed before touching disk.
 *
 * Contributions:
 * - nine `/opsx-*` / `/openspec-init` commands (`registerCommands`);
 * - the read-only `/dsh-spec` route used by the panel and the quick bar:
 *   `state`, `validate`, `instructions`, `sync-preview`, `document`, `init`;
 * - a workspace-aware fallback skill provider for the six core workflows when
 *   the DSH composition exposes `ctx.skills` and no native OpenSpec skill is
 *   present in the workspace.
 *
 * @module dsh-spec
 */

import { isAbsolute, relative } from 'node:path'

import { registerCommands } from './commands.js'
import { readProjectConfig } from './native/config.js'
import { isInside, listTree, readTextOrNull, toAbs } from './native/fsio.js'
import { ensureSkeleton } from './native/init.js'
import { planSync, previewSyncPlan } from './native/merge.js'
import { readChangeMetadata, resolveSchemaName } from './native/metadata.js'
import { loadProjectSchemas, resolveSchema } from './native/schema.js'
import { createFallbackProvider, detectNativeSkills } from './native/skills.js'
import { parseDeltaSpec } from './native/spec.js'
import { computeChangeState, computeWorkspaceState, validateChangeByName } from './native/state.js'
import { buildApplyPrompt, buildExplorePrompt, buildProposePrompt, buildUpdatePrompt } from './prompts.js'

/** Cordis plugin name; also the service key provided to other plugins. */
export const name = 'openSpec'

/** Commands register the slash family, workingDirectory resolves the session root, webServer + connection + workspaceRegistry serve the panel's read-only route. `skills` is optional and discovered through `ctx.get`. */
export const inject = ['commands', 'workingDirectory', 'webServer', 'connection', 'workspaceRegistry']

/** Absolute route the browser half calls for panel state, docs and direct actions. */
export const ROUTE = '/dsh-spec'

/** Largest request body accepted on the route, in bytes. */
const MAX_REQUEST_BYTES = 64_000

/** Default page size for `document` reads (the reader can ask for a later page). */
const DOCUMENT_PAGE_LINES = 400

/** Sort issues deterministically: path, then line, then level, then message. */
function sortIssues(issues) {
  return [...issues].sort((left, right) => {
    const pathOrder = String(left.path ?? '').localeCompare(String(right.path ?? ''))
    if (pathOrder !== 0) return pathOrder
    if ((left.line ?? 0) !== (right.line ?? 0)) return (left.line ?? 0) - (right.line ?? 0)
    if (left.level !== right.level) return left.level.localeCompare(right.level)
    return String(left.message).localeCompare(String(right.message))
  })
}

/** Count severity levels for one issue list. */
function summarizeIssues(issues) {
  const sorted = sortIssues(issues)
  let errors = 0
  let warnings = 0
  let infos = 0
  for (const issue of sorted) {
    if (issue.level === 'ERROR') errors += 1
    else if (issue.level === 'WARNING') warnings += 1
    else infos += 1
  }
  return { errors, warnings, infos, issues: sorted }
}

/** Accept only an absolute registry workspace path; reject everything else. */
async function resolveWorkspacePath(ctx, requested) {
  const raw = typeof requested === 'string' ? requested.trim() : ''
  if (raw.length === 0 || raw.length > 1000 || !isAbsolute(raw)) {
    throw new Error('cwd 必须是工作区的绝对路径')
  }
  const workspace = await ctx.workspaceRegistry.resolveByPath(raw)
  if (workspace === undefined) throw new Error('该路径不是已注册的工作区：拒绝在工作区之外读写')
  return workspace.path
}

/** Read a change-side delta spec file list and parsed operations. */
async function readDeltas(cwd, changeName) {
  const root = `openspec/changes/${changeName}/specs`
  const files = await listTree(cwd, root)
  const deltas = []
  for (const entry of files) {
    if (entry.type !== 'file') continue
    if (!entry.rel.endsWith('.md')) continue
    const text = await readTextOrNull(cwd, entry.rel)
    if (text === null) continue
    deltas.push({ path: entry.rel, text, parsed: parseDeltaSpec(text) })
  }
  return deltas
}

/** Capability path from a delta spec path (`.../specs/<capability>/spec.md`). */
function capabilityOf(changeName, deltaPath) {
  const prefix = `openspec/changes/${changeName}/specs/`
  const rel = deltaPath.startsWith(prefix) ? deltaPath.slice(prefix.length) : deltaPath
  return rel.endsWith('/spec.md') ? rel.slice(0, -'/spec.md'.length) : rel.replace(/\.md$/, '')
}

/** Resolve the effective schema for an optional change, and return config + project schemas too. */
async function schemaContext(cwd, changeName) {
  const config = await readProjectConfig(cwd)
  const { schemas } = await loadProjectSchemas(cwd)
  let metadata = null
  if (typeof changeName === 'string' && changeName.length > 0) {
    const found = await readChangeMetadata(cwd, `openspec/changes/${changeName}`)
    metadata = found.metadata
  }
  const schemaName = resolveSchemaName({ changeMetadata: metadata, projectConfig: config })
  const resolved = resolveSchema({ name: schemaName, projectSchemas: schemas })
  return { config, projectSchemas: schemas, metadata, schemaName, resolved }
}

/** Select one change by explicit name, or the only active change. */
function pickChange(state, name) {
  const asked = typeof name === 'string' ? name.trim() : ''
  if (asked.length > 0) {
    const found = state.changes.find((change) => change.name === asked)
    if (found === undefined) {
      const known = state.changes.map((change) => change.name).join('、') || '（无）'
      throw new Error(`找不到变更 "${asked}"。进行中的变更：${known}`)
    }
    return found
  }
  if (state.changes.length === 1) return state.changes[0]
  if (state.changes.length === 0) throw new Error('没有进行中的变更')
  const known = state.changes.map((change) => change.name).join('、')
  throw new Error(`有 ${state.changes.length} 个进行中的变更（${known}），请指定 change 名`)
}

/** `state`: full native workspace snapshot. */
async function methodState(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  return computeWorkspaceState(cwd)
}

/** `validate`: one change, or a workspace-wide summary when no change is given. */
async function methodValidate(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const change = typeof payload.change === 'string' ? payload.change.trim() : ''
  if (change.length > 0) {
    const result = await validateChangeByName(cwd, change)
    return { name: result.name, validation: result.validation, metadata: result.metadata, schemaName: result.schemaName }
  }
  const state = await computeWorkspaceState(cwd)
  const issues = []
  for (const item of state.changes) {
    for (const issue of item.validation.issues) {
      issues.push({ ...issue, change: item.name, path: issue.path ? `openspec/changes/${item.name}/${issue.path}` : undefined })
    }
  }
  return { workspace: true, status: state.status, validation: summarizeIssues(issues), warnings: state.warnings }
}

/** `instructions`: compose the native prompt for one workflow phase. */
async function methodInstructions(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const kind = typeof payload.kind === 'string' ? payload.kind : ''
  const topic = typeof payload.topic === 'string' ? payload.topic : ''
  const changeName = typeof payload.change === 'string' ? payload.change.trim() : ''

  if (kind === 'explore') {
    const config = await readProjectConfig(cwd)
    return { text: await buildExplorePrompt({ cwd, config, topic }), kind }
  }
  if (!['propose', 'apply', 'update'].includes(kind)) throw new Error(`未知的指令类型：${kind}`)

  const focus = await schemaContext(cwd, changeName)
  if (focus.resolved.schema === null) {
    throw new Error(`schema "${focus.schemaName}" 不存在：项目 openspec/schemas/ 与内置快照中都没有定义`)
  }
  const projectConfig = focus.config
  let change
  if (changeName.length === 0) {
    throw new Error('缺少 change 名称')
  }
  try {
    change = await computeChangeState(cwd, changeName, { projectConfig })
  } catch {
    if (kind !== 'propose') throw new Error(`变更 ${changeName} 不存在`)
    change = null
  }
  const schema = focus.resolved.schema
  if (kind === 'propose') {
    const text = await buildProposePrompt({ cwd, changeName, intent: topic, schema, config: projectConfig, change })
    return { text, kind, schemaName: focus.schemaName }
  }
  if (kind === 'apply') {
    if (change === null) throw new Error(`变更 ${changeName} 不存在`)
    const text = await buildApplyPrompt({ cwd, changeName, schema, config: projectConfig, change, artifactPrompt: '' })
    return { text, kind, schemaName: focus.schemaName }
  }
  if (change === null) throw new Error(`变更 ${changeName} 不存在`)
  const text = await buildUpdatePrompt({ cwd, changeName, schema, config: projectConfig, change })
  return { text, kind, schemaName: focus.schemaName }
}

/** `sync-preview`: dry-run deterministic merge plan (writes nothing). */
async function methodSyncPreview(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const change = typeof payload.change === 'string' ? payload.change.trim() : ''
  if (change.length === 0) throw new Error('缺少 change 名称')
  const projectConfig = await readProjectConfig(cwd)
  const state = await computeWorkspaceState(cwd)
  const changeState = state.changes.find((item) => item.name === change)
  if (changeState === undefined) throw new Error(`找不到进行中的变更 "${change}"`)
  const deltas = await readDeltas(cwd, change)
  const mainSpecs = []
  for (const delta of deltas) {
    const capability = capabilityOf(change, delta.path)
    const mainPath = `openspec/specs/${capability}/spec.md`
    const text = await readTextOrNull(cwd, mainPath)
    if (text !== null && !mainSpecs.some((spec) => spec.path === mainPath)) {
      mainSpecs.push({ path: mainPath, text })
    }
  }
  const plan = planSync({
    changeName: change,
    mainSpecs,
    deltas,
    retireCapabilities: changeState.metadata.retire_capabilities === true,
  })
  const preview = previewSyncPlan(plan)
  const validation = (await validateChangeByName(cwd, change)).validation
  return {
    change,
    validation,
    ok: plan.ok,
    issues: plan.issues,
    summary: plan.summary,
    writes: plan.writes.map((write) => ({ path: write.path, action: write.action, summary: write.summary })),
    text: preview.text,
    files: preview.files,
  }
}

/** `document`: one workspace-contained document read with an explicit truncation flag. */
async function methodDocument(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  let rel = typeof payload.path === 'string' ? payload.path.replaceAll('\\', '/') : ''
  if (isAbsolute(rel)) {
    if (!isInside(cwd, rel)) throw new Error('拒绝读取工作区之外的文件')
    rel = relative(cwd, rel).replaceAll('\\', '/')
  }
  rel = rel.replace(/^\/+/, '')
  if (rel.length === 0 || rel.includes('..')) throw new Error('文档路径无效')
  const absolute = toAbs(cwd, rel)
  if (!isInside(cwd, absolute)) throw new Error('拒绝读取工作区之外的文件')
  const text = await readTextOrNull(cwd, rel)
  if (text === null) throw new Error(`无法读取文档：${rel}`)
  const lines = text.split(/\r?\n/)
  const offset = Number.isFinite(payload.offset) && payload.offset > 0 ? Math.floor(payload.offset) : 1
  const limit = Number.isFinite(payload.limit) && payload.limit > 0 ? Math.min(Math.floor(payload.limit), 4000) : DOCUMENT_PAGE_LINES
  const start = Math.min(offset - 1, lines.length)
  const page = lines.slice(start, start + limit)
  const end = start + page.length
  return {
    path: rel,
    text: page.join('\n'),
    offset: start + 1,
    lines: page.length,
    totalLines: lines.length,
    truncated: end < lines.length,
    nextOffset: end < lines.length ? end + 1 : null,
  }
}

/** `archive-detail`: one archived change rendered with the same native shape as an active change. */
async function methodArchiveDetail(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const rawPath = typeof payload.path === 'string' ? payload.path.replaceAll('\\', '/') : ''
  const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
  let rel = ''
  if (rawPath.length > 0) {
    rel = rawPath.replace(/^\/+/, '')
    if (!rel.startsWith('openspec/')) rel = `openspec/changes/archive/${rel.replace(/^archive\//, '')}`
  } else if (rawName.length > 0) {
    rel = `openspec/changes/archive/${rawName.replace(/^archive\//, '')}`
  } else {
    throw new Error('缺少归档路径或名称')
  }
  if (rel.includes('..') || !rel.startsWith('openspec/changes/archive/')) throw new Error('归档路径无效')
  if (!isInside(cwd, toAbs(cwd, rel))) throw new Error('归档路径不在工作区内')
  const projectConfig = await readProjectConfig(cwd)
  const suffix = rel.slice('openspec/changes/'.length)
  try {
    return { change: await computeChangeState(cwd, suffix, { projectConfig }) }
  } catch {
    throw new Error(`找不到已归档的变更：${rel}`)
  }
}

/** `init`: native scaffold, idempotent; returns the created list. */
async function methodInit(ctx, payload) {
  const cwd = await resolveWorkspacePath(ctx, payload.cwd)
  const { created, configContent } = await ensureSkeleton(cwd)
  const text =
    created.length === 0
      ? 'OpenSpec 已初始化过，没有需要补建的文件。'
      : `OpenSpec 骨架已就绪（新建：${created.join('、')}）。下一步：/opsx-explore 想清楚，或 /opsx-propose <change-name> 直接写计划。`
  return { ok: true, text, created, configLength: configContent.length }
}

/** Read and bound one request body. */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/** Register the read-only panel route on the DSH web server. */
function registerRoute(ctx) {
  const handlers = {
    state: methodState,
    validate: methodValidate,
    instructions: methodInstructions,
    'sync-preview': methodSyncPreview,
    document: methodDocument,
    'archive-detail': methodArchiveDetail,
    init: methodInit,
  }
  return ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const admission = ctx.connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          const respond = (rpcId, result, status = 200) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
          }
          let rpcId = ''
          try {
            const endpoint = new URL(req.url ?? '/', 'http://dsh-spec.invalid').pathname
              .slice(ROUTE.length)
              .replace(/^\//, '')
            const envelope = await readBody(req, MAX_REQUEST_BYTES)
            rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId.slice(0, 200) : ''
            if (envelope.type !== 'client-request' || rpcId.length === 0 || envelope.method !== endpoint) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('bad request envelope')
              return
            }
            const handler = handlers[endpoint]
            if (handler === undefined) throw new Error(`未知操作：${endpoint}`)
            const payload = envelope.payload !== null && typeof envelope.payload === 'object' ? envelope.payload : {}
            const value = await handler(ctx, payload)
            respond(rpcId, { ok: true, value })
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            if (rpcId.length === 0) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('bad request')
              return
            }
            respond(rpcId, { ok: false, error: { code: 'dsh-spec/failed', message: detail, details: {} } })
          }
        },
      }),
    'dsh-spec: /dsh-spec route',
  )
}

/** Register the fallback skill provider when the composition exposes `ctx.skills`. */
function registerFallbackSkills(ctx) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (skills === undefined || skills === null || typeof skills.registerProvider !== 'function') return
  const detect = (cwd, options = {}) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return { skills: [], rootsScanned: [], warnings: [] }
    return detectNativeSkills(cwd, { signal: options?.signal })
  }
  ctx.effect(
    () => skills.registerProvider(() => createFallbackProvider(detect)),
    'dsh-spec: native OpenSpec fallback skills',
  )
}

/** Register the command family, the panel route and the optional skill provider. */
export function apply(ctx) {
  registerCommands(ctx)
  registerRoute(ctx)
  registerFallbackSkills(ctx)
}
