/**
 * dsh-spec — pure client-side formatting helpers.
 *
 * This module is import-free ESM used twice:
 *  - `node --test` imports it directly (`tests/client-helpers.test.mjs`);
 *  - `tools/build.mjs` inlines it at the helper marker inside the browser
 *    factory (the `export ` keywords are stripped), so the helpers run
 *    as plain functions in the same closure as the panel components.
 *
 * Keep every function pure: locale text is passed in as a translate function
 * `t(key)`, never read from a module-level dictionary, and there is no I/O.
 * That keeps the panel's formatting testable without a DOM and keeps a single
 * implementation for the Markdown/React halves.
 *
 * @module dsh-spec/client-helpers
 */

/** Canonical display order for the well-known artifact ids (custom ids follow). */
const HELPER_ARTIFACT_ORDER = { proposal: 0, specs: 1, design: 2, tasks: 3 }

/** Delta operations in native display order. */
const HELPER_DELTA_OPERATIONS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']

/** Locale keys for each delta operation (`{count}` is replaced). */
const HELPER_DELTA_KEYS = {
  ADDED: 'deltaAdded',
  MODIFIED: 'deltaModified',
  REMOVED: 'deltaRemoved',
  RENAMED: 'deltaRenamed',
}

/** Locale keys for each artifact status chip. */
const HELPER_STATUS_KEYS = {
  done: 'artifactDone',
  skipped: 'artifactSkipped',
  ready: 'artifactReady',
  blocked: 'artifactBlocked',
}

/** Coerce to a non-negative integer, defaulting to 0. */
function helperNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Resolve one locale string and fill `{name}` placeholders.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {string} key - locale key; also the fallback text when `t` is absent.
 * @param {Record<string, unknown>} [vars] - placeholder values.
 * @returns {string} translated text with placeholders filled.
 */
function fillText(t, key, vars) {
  let text = typeof t === 'function' ? t(key) : key
  if (typeof text !== 'string') text = key
  if (vars !== undefined && vars !== null) {
    for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
  }
  return text
}

/**
 * Human label for an artifact id: `specs` -> `Specs`, `research` -> `Research`.
 *
 * @param {string} artifactId - schema artifact id.
 * @returns {string} display label (empty string for empty input).
 */
export function artifactLabel(artifactId) {
  const raw = String(artifactId ?? '').trim()
  if (raw === '') return ''
  return raw
    .split(/[-_/]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Display rank of an artifact: canonical ids first, custom ids afterwards.
 *
 * @param {string} artifactId - schema artifact id.
 * @returns {number} lower sorts earlier.
 */
export function artifactRank(artifactId) {
  const key = String(artifactId ?? '')
  return Object.prototype.hasOwnProperty.call(HELPER_ARTIFACT_ORDER, key) ? HELPER_ARTIFACT_ORDER[key] : 100
}

/**
 * Stable copy of an artifact list in display order (schema order kept for
 * custom ids, which therefore stay next to each other after the canonical set).
 *
 * @param {Array<{ id?: string }>} artifacts - `ChangeState.artifacts`.
 * @returns {Array<{ id?: string }>} ordered copy.
 */
export function sortArtifacts(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts.slice() : []
  return list.sort((left, right) => artifactRank(left?.id) - artifactRank(right?.id))
}

/**
 * Tone family for one native artifact status; the client maps it to a
 * `--dsw-*` color token.
 *
 * @param {string} status - `done` | `skipped` | `ready` | `blocked`.
 * @returns {'success'|'muted'|'business'|'warn'} tone key.
 */
export function artifactStatusTone(status) {
  if (status === 'done') return 'success'
  if (status === 'skipped') return 'muted'
  if (status === 'ready') return 'business'
  return 'warn'
}

/**
 * Localized artifact status chip text.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {string} status - `done` | `skipped` | `ready` | `blocked`.
 * @returns {string} chip text.
 */
export function artifactStatusText(t, status) {
  const key = HELPER_STATUS_KEYS[status] ?? 'artifactUnknown'
  return fillText(t, key)
}

/**
 * Counts per native artifact status.
 *
 * @param {Array<{ status?: string }>} artifacts - `ChangeState.artifacts`.
 * @returns {{done: number, skipped: number, ready: number, blocked: number}} counts.
 */
export function artifactStatusCounts(artifacts) {
  const counts = { done: 0, skipped: 0, ready: 0, blocked: 0 }
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const status = artifact?.status
    if (status === 'done' || status === 'skipped' || status === 'ready' || status === 'blocked') {
      counts[status] += 1
    }
  }
  return counts
}

/**
 * Planning progress across a change's artifacts: done and skipped both count as
 * satisfied, exactly like the native dependency graph.
 *
 * @param {Array<{ status?: string }>} artifacts - `ChangeState.artifacts`.
 * @returns {{done: number, total: number, percent: number}} progress summary.
 */
export function artifactProgress(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : []
  const counts = artifactStatusCounts(list)
  const done = counts.done + counts.skipped
  const total = list.length
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/**
 * Blocked artifacts with their missing dependencies.
 *
 * @param {Array<{ id?: string, status?: string, missingDeps?: string[] }>} artifacts - artifacts.
 * @returns {Array<{ id: string, missingDeps: string[] }>} blocked rows.
 */
export function blockedArtifacts(artifacts) {
  const rows = []
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (artifact?.status !== 'blocked') continue
    const id = String(artifact.id ?? '')
    const missingDeps = Array.isArray(artifact.missingDeps) ? artifact.missingDeps.map((dep) => String(dep)) : []
    rows.push({ id, missingDeps })
  }
  return rows
}

/**
 * Counts per delta operation from `ChangeState.delta`.
 *
 * @param {{ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number, files?: string[]}} [delta] - delta summary.
 * @returns {{ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number, total: number}} counts.
 */
export function deltaOperationCounts(delta) {
  const counts = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, total: 0 }
  for (const operation of HELPER_DELTA_OPERATIONS) {
    counts[operation] = helperNumber(delta?.[operation])
    counts.total += counts[operation]
  }
  return counts
}

/**
 * Localized one-line delta operation summary, e.g. `+2 新增 · 1 修改`.
 * Returns an empty string when the change has neither delta files nor counts.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number, files?: string[]}} [delta] - delta summary.
 * @returns {string} summary text (`·`-joined parts) or `''`.
 */
export function deltaSummaryText(t, delta) {
  const counts = deltaOperationCounts(delta)
  const hasFiles = Array.isArray(delta?.files) && delta.files.length > 0
  if (!hasFiles && counts.total === 0) return ''
  return HELPER_DELTA_OPERATIONS.map((operation) => fillText(t, HELPER_DELTA_KEYS[operation], { count: counts[operation] })).join(' · ')
}

/**
 * Change name of one archive row: `2026-10-20-add-dark-mode` -> `add-dark-mode`.
 *
 * @param {{name?: string, changeName?: string}} [entry] - archive row.
 * @returns {string} display name.
 */
export function archiveEntryLabel(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  if (typeof entry.changeName === 'string' && entry.changeName !== '') return entry.changeName
  const name = String(entry.name ?? '')
  const match = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(name)
  return match === null ? name : match[1]
}

/**
 * Local archive date of one row (explicit `date` first, then the name prefix).
 *
 * @param {{name?: string, date?: string}} [entry] - archive row.
 * @returns {string|null} `YYYY-MM-DD` or `null` when unknown.
 */
export function archiveEntryDate(entry) {
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return entry.date
  const name = String(entry.name ?? '')
  const match = /^(\d{4}-\d{2}-\d{2})-/.exec(name)
  return match === null ? null : match[1]
}

/**
 * Group archived changes by local archive date: newest date first, entries
 * alphabetically inside a group, unknown dates last.
 *
 * @param {Array<{name?: string, changeName?: string, date?: string}>} archived - `WorkspaceState.archived`.
 * @returns {Array<{date: string|null, entries: Array<object>}>} groups.
 */
export function groupArchivedByLocalDate(archived) {
  const groups = new Map()
  for (const entry of Array.isArray(archived) ? archived : []) {
    if (entry === null || typeof entry !== 'object') continue
    const date = archiveEntryDate(entry)
    const key = date === null ? '' : date
    let group = groups.get(key)
    if (group === undefined) {
      group = { date, entries: [] }
      groups.set(key, group)
    }
    group.entries.push(entry)
  }
  const list = [...groups.values()]
  list.sort((left, right) => {
    if (left.date === null && right.date === null) return 0
    if (left.date === null) return 1
    if (right.date === null) return -1
    return right.date.localeCompare(left.date)
  })
  for (const group of list) group.entries.sort((left, right) => archiveEntryLabel(left).localeCompare(archiveEntryLabel(right)))
  return list
}

/**
 * One page of a list, never silently dropping the tail: callers grow the
 * `pageSize` (or advance `offset`) until `hasNext` is false and show
 * {@link moreItemsText} for the rest.
 *
 * @param {Array<unknown>} items - full list.
 * @param {{offset?: number, pageSize?: number}} [options] - slice options.
 * @returns {{items: Array<unknown>, offset: number, pageSize: number, total: number, shown: number, hidden: number, nextOffset: number, hasPrev: boolean, hasNext: boolean}} page info.
 */
export function paginate(items, options) {
  const list = Array.isArray(items) ? items : []
  const pageSize = helperNumber(options?.pageSize) > 0 ? helperNumber(options?.pageSize) : 8
  let offset = helperNumber(options?.offset)
  if (offset > list.length) offset = list.length
  const slice = list.slice(offset, offset + pageSize)
  return {
    items: slice,
    offset,
    pageSize,
    total: list.length,
    shown: slice.length,
    hidden: Math.max(0, list.length - offset - slice.length),
    nextOffset: offset + slice.length,
    hasPrev: offset > 0,
    hasNext: offset + slice.length < list.length,
  }
}

/**
 * "There is more" text, used instead of silently truncating a list.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {number} count - hidden item count.
 * @returns {string} localized hint.
 */
export function moreItemsText(t, count) {
  return fillText(t, 'moreItems', { count: helperNumber(count) })
}

/**
 * Localized validation summary (`2 错误 · 1 警告`) or the clean-state text.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{errors?: number, warnings?: number}} [validation] - validation summary.
 * @returns {string} summary text.
 */
export function validationSummaryText(t, validation) {
  const errors = helperNumber(validation?.errors)
  const warnings = helperNumber(validation?.warnings)
  if (errors === 0 && warnings === 0) return fillText(t, 'validationClean')
  return fillText(t, 'validationSummary', { errors, warnings })
}

/**
 * One-line issue location: `path:line`, `path` or `line`.
 *
 * @param {{path?: string, line?: number}} [issue] - validation issue.
 * @returns {string} location label.
 */
export function validationIssueLocation(issue) {
  const path = typeof issue?.path === 'string' ? issue.path : ''
  const line = typeof issue?.line === 'number' && Number.isFinite(issue.line) && issue.line > 0 ? Math.floor(issue.line) : null
  if (path === '') return line === null ? '' : String(line)
  return line === null ? path : `${path}:${line}`
}

/**
 * Tone family for one validation issue level.
 *
 * @param {string} level - `ERROR` | `WARNING` | `INFO`.
 * @returns {'error'|'warn'|'info'} tone key.
 */
export function issueLevelTone(level) {
  if (level === 'ERROR') return 'error'
  if (level === 'WARNING') return 'warn'
  return 'info'
}

/**
 * Document-reader truncation notice (`{total} 行文档，仅显示前 {shown} 行`).
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{shown?: number, totalLines?: number|null}} [info] - reader state.
 * @returns {string} notice text.
 */
export function documentTruncationText(t, info) {
  const shown = helperNumber(info?.shown)
  const totalLines = typeof info?.totalLines === 'number' && Number.isFinite(info.totalLines) && info.totalLines > 0 ? Math.floor(info.totalLines) : null
  if (totalLines === null) return fillText(t, 'docTruncatedSimple', { shown })
  return fillText(t, 'docTruncated', { shown, total: totalLines })
}

/**
 * Number of lines a truncated reader has displayed so far.
 *
 * @param {string} text - displayed document text.
 * @returns {number} 1-based count of displayed lines (0 for empty text).
 */
export function documentShownLines(text) {
  const value = String(text ?? '')
  if (value === '') return 0
  return value.split(/\r?\n/).length
}

/**
 * Task progress from a `{total, done}` pair (`ChangeState.tasks`).
 *
 * @param {{total?: number, done?: number}|null} [tasks] - task counts.
 * @returns {{total: number, done: number, remaining: number, percent: number, complete: boolean}} progress.
 */
export function taskProgressInfo(tasks) {
  const total = helperNumber(tasks?.total)
  const done = Math.min(helperNumber(tasks?.done), total)
  return {
    total,
    done,
    remaining: total - done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    complete: total > 0 && done >= total,
  }
}

/**
 * Localized task progress text (`3/7`); empty when there is no task list.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{total?: number, done?: number}|null} [tasks] - task counts.
 * @returns {string} progress text.
 */
export function taskProgressText(t, tasks) {
  const info = taskProgressInfo(tasks)
  if (info.total === 0) return ''
  return fillText(t, 'taskProgress', { done: info.done, total: info.total })
}

/** Round an integer ratio to a whole percent (0 for an empty denominator). */
function helperPercent(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0
}

/**
 * Workspace overview progress: two independent meters, one per workflow stage.
 *
 * `artifacts` counts planning artifacts (done and skipped are both satisfied,
 * exactly like the native dependency graph); `tasks` counts tracked checkboxes
 * across the changes that have a task list. The two meters never merge — a fully
 * planned workspace can still have an unfinished task meter — which is what the
 * panel's dual rings show side by side.
 *
 * @param {Array<{artifacts?: object[], tasks?: {total?: number, done?: number}|null}>} changes - `WorkspaceState.changes`.
 * @returns {{changes: number, artifacts: {done: number, total: number, percent: number, empty: boolean}, tasks: {done: number, total: number, percent: number, empty: boolean}, hasContent: boolean}} stage meters.
 */
export function workspaceProgress(changes) {
  const list = Array.isArray(changes) ? changes : []
  let artifactDone = 0
  let artifactTotal = 0
  let taskDone = 0
  let taskTotal = 0
  for (const change of list) {
    if (change === null || typeof change !== 'object') continue
    const artifacts = artifactProgress(change.artifacts)
    artifactDone += artifacts.done
    artifactTotal += artifacts.total
    const tasks = taskProgressInfo(change.tasks)
    taskDone += tasks.done
    taskTotal += tasks.total
  }
  return {
    changes: list.length,
    artifacts: {
      done: artifactDone,
      total: artifactTotal,
      percent: helperPercent(artifactDone, artifactTotal),
      empty: artifactTotal === 0,
    },
    tasks: {
      done: taskDone,
      total: taskTotal,
      percent: helperPercent(taskDone, taskTotal),
      empty: taskTotal === 0,
    },
    hasContent: artifactTotal > 0 || taskTotal > 0,
  }
}

/**
 * Render view of one change's task checklist (`ChangeState.tasks`).
 *
 * `missing` marks "the Host sent no detail rows at all" (older Host, the panel
 * can only offer the raw `tasks.md`); `limited` marks "more tracked tasks exist
 * than the capped payload carries" (`total - items.length` remain unloaded).
 *
 * @param {{total?: number, done?: number, items?: Array<{id?: unknown, text?: unknown, done?: unknown, depth?: unknown}>}|null} [tasks] - `ChangeState.tasks`.
 * @returns {{total: number, done: number, remaining: number, percent: number, complete: boolean, items: Array<{id: string|null, text: string, done: boolean, depth: number}>, shown: number, hidden: number, missing: boolean, limited: boolean}} checklist view.
 */
export function taskChecklistView(tasks) {
  const info = taskProgressInfo(tasks)
  const raw = Array.isArray(tasks?.items) ? tasks.items : []
  const items = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    items.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : null,
      text: String(item.text ?? ''),
      done: item.done === true,
      depth: Number.isInteger(item.depth) && item.depth >= 0 ? Math.min(item.depth, 3) : 0,
    })
  }
  const hidden = items.length > 0 ? Math.max(0, info.total - items.length) : 0
  return {
    total: info.total,
    done: info.done,
    remaining: info.remaining,
    percent: info.percent,
    complete: info.complete,
    items,
    shown: items.length,
    hidden,
    missing: info.total > 0 && items.length === 0,
    limited: items.length > 0 && hidden > 0,
  }
}

/**
 * Native task checkbox count from `tasks.md` text (archive-view fallback where
 * the host state only exposes per-change task counts).
 * Parity with `src/native/tasks.js`: `-`/`*`/`+` bullets; `[x]`/`[X]` (either
 * side spacing) is done; any other marker is an unfinished task; a link bullet
 * like `- [docs](url)` is not a task; an empty task still counts.
 *
 * @param {string} text - `tasks.md` content.
 * @returns {{total: number, done: number}} task counts.
 */
export function countTaskCheckboxes(text) {
  let total = 0
  let done = 0
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^(\s*)[-*+]\s+\[([^\]]*)\](.*)$/.exec(line)
    if (match === null) continue
    const marker = match[2].trim()
    const rest = match[3]
    if (marker !== '' && /^\s*\(/.test(rest)) continue
    total += 1
    if (marker === 'x' || marker === 'X') done += 1
  }
  return { total, done }
}

/**
 * Localized schema source label (`项目` project-local / `内置` bundled snapshot).
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {string} [source] - `project` | `builtin`.
 * @returns {string} source label.
 */
export function schemaSourceText(t, source) {
  if (source === 'project') return fillText(t, 'schemaProject')
  if (source === 'builtin') return fillText(t, 'schemaBuiltin')
  return fillText(t, 'schemaUnknown')
}

/**
 * The native next step for one change, derived only from the host state
 * (never from the legacy four-phase ordering).
 *
 * @param {{name?: string, artifacts?: Array<{id?: string, status?: string}>, isPlanningComplete?: boolean, listStatus?: string}|undefined} change - `ChangeState`.
 * @returns {{kind: 'update'|'apply'|'archive'|'propose', labelKey: string, line: string}} next action.
 */
export function deriveNextAction(change) {
  if (change === null || change === undefined) {
    return { kind: 'propose', labelKey: 'nextActionPropose', line: '/opsx-propose ' }
  }
  const name = String(change.name ?? '')
  if (change.isPlanningComplete !== true) {
    return { kind: 'update', labelKey: 'nextActionUpdate', line: `/opsx-update ${name}` }
  }
  if (change.listStatus === 'complete') {
    // The panel/quick-bar "Archive" button fills the composer; appending --yes
    // makes that one-click path the deterministic archive (validate + merge +
    // move without a model turn). Typing /opsx-archive without flags still
    // starts the OPSX AI archive workflow.
    return { kind: 'archive', labelKey: 'nextActionArchive', line: `/opsx-archive ${name} --yes` }
  }
  return { kind: 'apply', labelKey: 'nextActionApply', line: `/opsx-apply ${name}` }
}

/**
 * Localized label for a {@link deriveNextAction} result.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{labelKey?: string}|undefined} action - next action.
 * @returns {string} button label.
 */
export function nextActionText(t, action) {
  return fillText(t, action?.labelKey ?? 'nextActionApply')
}

/** The host commands that act on one change and therefore take a change name. */
export const CHANGE_PICKER_COMMANDS = Object.freeze([
  'opsx-update',
  'opsx-apply',
  'opsx-sync',
  'opsx-archive',
  'opsx-validate',
])

/**
 * Whether the Web client's change picker should take over a bare change command.
 *
 * Only the ambiguous case needs the picker: two or more changes in motion. A
 * single change keeps the host's auto-selection, and a loading / missing / error
 * workspace keeps the host's own diagnostics, so the picker never hides a more
 * accurate host message.
 *
 * @param {{status?: string, changes?: Array<object>}|undefined} state - `WorkspaceState`.
 * @returns {boolean} true when the picker should intercept the command.
 */
export function changePickerAvailable(state) {
  if (state === null || state === undefined || state.status !== 'ready') return false
  const changes = Array.isArray(state.changes) ? state.changes : []
  return changes.length >= 2
}

/**
 * Composer line filled after one picker row is chosen:
 * `/opsx-<command> <change-name> ` — the trailing space lets the user append a
 * revision request or flags before submitting.
 *
 * @param {string} command - command name, with or without its leading slash ({@link CHANGE_PICKER_COMMANDS}).
 * @param {string} changeName - picked change name, preserved verbatim.
 * @returns {string} composer draft line.
 */
export function changePickerLine(command, changeName) {
  const name = String(command ?? '').replace(/^\/+/, '')
  const change = String(changeName ?? '').trim()
  return `/${name} ${change} `
}

/** Locale keys for the picker's per-change workflow state. */
const HELPER_PICKER_STATE_KEYS = {
  planning: 'pickerPlanning',
  apply: 'pickerApply',
  complete: 'pickerComplete',
}

/**
 * Compact native status summary for one change row.
 *
 * @param {object} change - `ChangeState`.
 * @param {((key: string) => string) | undefined} t - translate function.
 * @returns {string} ` · `-joined summary text.
 */
function changePickerDetail(change, t) {
  const parts = []
  let stateKey = HELPER_PICKER_STATE_KEYS.planning
  if (change.isPlanningComplete === true) {
    stateKey = change.listStatus === 'complete' ? HELPER_PICKER_STATE_KEYS.complete : HELPER_PICKER_STATE_KEYS.apply
  }
  parts.push(fillText(t, stateKey))
  const progress = taskProgressInfo(change.tasks)
  if (progress.total > 0) parts.push(fillText(t, 'pickerTasks', { done: progress.done, total: progress.total }))
  const errors = helperNumber(change?.validation?.errors)
  if (errors > 0) parts.push(fillText(t, 'pickerErrors', { count: errors }))
  const warnings = helperNumber(change?.validation?.warnings)
  if (warnings > 0) parts.push(fillText(t, 'pickerWarnings', { count: warnings }))
  if (change?.metadata?.skip_specs === true) parts.push(fillText(t, 'skipSpecs'))
  return parts.join(' · ')
}

/**
 * One picker row per change in motion: `label` is the change name (the popup
 * shell renders it) and `detail` is the compact native status summary. Rows
 * without a usable name are filtered instead of rendering an empty option.
 *
 * @param {{status?: string, changes?: Array<object>}|undefined} state - `WorkspaceState`.
 * @param {((key: string) => string) | undefined} t - translate function.
 * @returns {Array<{name: string, label: string, detail: string}>} picker options.
 */
export function changePickerOptions(state, t) {
  if (state === null || state === undefined || state.status !== 'ready') return []
  const changes = Array.isArray(state.changes) ? state.changes : []
  return changes
    .filter((change) => change !== null && typeof change === 'object' && typeof change.name === 'string' && change.name !== '')
    .map((change) => ({
      name: change.name,
      label: change.name,
      detail: changePickerDetail(change, t),
    }))
}

/**
 * Flatten capability specs into a nested-path ordered row list:
 * `identity/user-auth` renders as a group row `identity` plus a child row
 * `user-auth`, instead of one flat name containing slashes.
 *
 * @param {Array<{name?: string}>} specs - `WorkspaceState.specs`.
 * @returns {Array<{kind: 'group'|'spec', label: string, fullName: string, depth: number, spec?: object}>} rows.
 */
export function groupSpecsByPath(specs) {
  const list = (Array.isArray(specs) ? specs : []).filter((spec) => spec !== null && typeof spec === 'object' && typeof spec.name === 'string' && spec.name !== '')
  const rows = []
  const walk = (items, prefix, depth) => {
    const buckets = new Map()
    for (const spec of items) {
      const rest = prefix === '' ? spec.name : spec.name.slice(prefix.length + 1)
      const slash = rest.indexOf('/')
      const segment = slash === -1 ? rest : rest.slice(0, slash)
      let bucket = buckets.get(segment)
      if (bucket === undefined) {
        bucket = { segment, specs: [] }
        buckets.set(segment, bucket)
      }
      bucket.specs.push(spec)
    }
    const segments = [...buckets.keys()].sort((left, right) => left.localeCompare(right))
    for (const segment of segments) {
      const bucket = buckets.get(segment)
      const fullName = prefix === '' ? segment : `${prefix}/${segment}`
      const direct = bucket.specs.filter((spec) => (prefix === '' ? spec.name : spec.name.slice(prefix.length + 1)) === segment)
      const children = bucket.specs.filter((spec) => !direct.includes(spec))
      if (children.length > 0) {
        rows.push({ kind: 'group', label: segment, fullName, depth, spec: undefined })
      }
      const childDepth = children.length > 0 ? depth + 1 : depth
      for (const spec of direct.slice().sort((left, right) => left.name.localeCompare(right.name))) {
        rows.push({ kind: 'spec', label: segment, fullName, depth: childDepth, spec })
      }
      if (children.length > 0) walk(children, fullName, childDepth)
    }
  }
  walk(list.slice().sort((left, right) => left.name.localeCompare(right.name)), '', 0)
  return rows
}
