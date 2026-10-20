/**
 * dsh-spec — browser half (source).
 *
 * This file is NOT a module: tools/build.mjs inlines it into the
 * `window.__ModuleLoader__.load({ id, factory })` closure that the DSH client
 * module system serves, exactly like a shipped `lib/client.js`. It may use
 * only the platform modules the shell seeds — here: `react`.
 *
 * Surfaces registered here:
 *   - `main` (keyed PANEL_ID)         — the openspec monitoring page
 *   - `sidebar.panellist`             — the page's sidebar glyph
 *   - `conversation.composer.dock`    — the quick phase command bar under the composer
 *
 * All workflow state is derived by the Host from the workspace's `openspec/`
 * files and fetched through `ctx.connection.rpc.call('/dsh-spec', method, …)`
 * — the browser half holds no copy of the native model. Session file watches
 * are only a refresh trigger; session-less workspaces poll the same route.
 * The plugin stores nothing of its own; files are the truth.
 *
 * Visual language: the plugin is part of the Harness UI, so it copies the
 * host's management-page patterns (20px page title, 13px secondary text,
 * 960px content column, settings-card surface, 32px primary buttons on
 * `--dsw-alias-button-primary-*`) and Modal conventions (fixed mask, 28px
 * panel radius, Esc/backdrop close, restored focus). Only `--dsw-*` theme
 * tokens are used for color, so light/dark and custom themes follow the host.
 */

function createOpenSpecPlugin(require) {
  const React = require('react')
  const h = React.createElement
  const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React

  // tools/build.mjs inlines src/client-helpers.js here (pure formatting helpers
  // shared with node --test); the marker line must stay in the factory body.
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
function artifactLabel(artifactId) {
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
function artifactRank(artifactId) {
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
function sortArtifacts(artifacts) {
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
function artifactStatusTone(status) {
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
function artifactStatusText(t, status) {
  const key = HELPER_STATUS_KEYS[status] ?? 'artifactUnknown'
  return fillText(t, key)
}

/**
 * Counts per native artifact status.
 *
 * @param {Array<{ status?: string }>} artifacts - `ChangeState.artifacts`.
 * @returns {{done: number, skipped: number, ready: number, blocked: number}} counts.
 */
function artifactStatusCounts(artifacts) {
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
function artifactProgress(artifacts) {
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
function blockedArtifacts(artifacts) {
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
function deltaOperationCounts(delta) {
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
function deltaSummaryText(t, delta) {
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
function archiveEntryLabel(entry) {
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
function archiveEntryDate(entry) {
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
function groupArchivedByLocalDate(archived) {
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
function paginate(items, options) {
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
function moreItemsText(t, count) {
  return fillText(t, 'moreItems', { count: helperNumber(count) })
}

/**
 * Localized validation summary (`2 错误 · 1 警告`) or the clean-state text.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{errors?: number, warnings?: number}} [validation] - validation summary.
 * @returns {string} summary text.
 */
function validationSummaryText(t, validation) {
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
function validationIssueLocation(issue) {
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
function issueLevelTone(level) {
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
function documentTruncationText(t, info) {
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
function documentShownLines(text) {
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
function taskProgressInfo(tasks) {
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
function taskProgressText(t, tasks) {
  const info = taskProgressInfo(tasks)
  if (info.total === 0) return ''
  return fillText(t, 'taskProgress', { done: info.done, total: info.total })
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
function countTaskCheckboxes(text) {
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
function schemaSourceText(t, source) {
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
function deriveNextAction(change) {
  if (change === null || change === undefined) {
    return { kind: 'propose', labelKey: 'nextActionPropose', line: '/opsx-propose ' }
  }
  const name = String(change.name ?? '')
  if (change.isPlanningComplete !== true) {
    return { kind: 'update', labelKey: 'nextActionUpdate', line: `/opsx-update ${name}` }
  }
  if (change.listStatus === 'complete') {
    return { kind: 'archive', labelKey: 'nextActionArchive', line: `/opsx-archive ${name}` }
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
function nextActionText(t, action) {
  return fillText(t, action?.labelKey ?? 'nextActionApply')
}

/**
 * Flatten capability specs into a nested-path ordered row list:
 * `identity/user-auth` renders as a group row `identity` plus a child row
 * `user-auth`, instead of one flat name containing slashes.
 *
 * @param {Array<{name?: string}>} specs - `WorkspaceState.specs`.
 * @returns {Array<{kind: 'group'|'spec', label: string, fullName: string, depth: number, spec?: object}>} rows.
 */
function groupSpecsByPath(specs) {
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

  /** Sidebar row id and the `main` dispatch key — the SAME string in both. */
  const PANEL_ID = 'openspec'
  /** The composer-dock entry id. */
  const DOCK_ID = 'openspec-quickbar'
  /** Locale namespace registered in apply(). */
  const NS = 'openSpec'
  /** Host route: read-only native state plus the session-less init write. */
  const ROUTE = '/dsh-spec'
  /** Debounce for watch-driven refreshes. */
  const REFRESH_DEBOUNCE_MS = 400
  /** Session-less workspaces poll the Host route while the panel is open. */
  const POLL_MS = 4000
  /** Poll fallback for a session workspace whose directory watch failed. */
  const FALLBACK_POLL_MS = 8000
  /** Upper bound for one Host route call so a lost RPC cannot hang the UI. */
  const RPC_TIMEOUT_MS = 15000
  /** How long an inline result banner stays visible. */
  const NOTICE_MS = 5000
  /** List paging sizes — no list is silently truncated. */
  const CHANGE_PAGE_SIZE = 6
  const SPEC_PAGE_SIZE = 8
  const ARCHIVE_PAGE_SIZE = 10
  const ISSUE_PAGE_SIZE = 5
  /** Lines fetched per document page (the Host route reports truncation). */
  const DOC_PAGE_LINES = 2000

  /** All user-visible copy lives here. */
  const T = {
    zh: {
      panel: 'OpenSpec',
      title: 'OpenSpec 工作流',
      subtitle: '进度只存在于 openspec/ 的文件里，这里只是它的实时视图。',
      refresh: '刷新',
      refreshAll: '刷新全部',
      loading: '正在读取 openspec/ …',
      nosession: '这里还没有已知的工作区会话。',
      nosessionHint: '在这个工作区开始对话后，这里会显示对应的 openspec/ 状态。',
      missing: '此工作区还没有 openspec/',
      missingHint: '初始化会生成 config.yaml、specs/ 与 changes/archive/ 骨架；之后 AI 就能用 /opsx-* 命令开始规格流程。',
      init: '初始化 OpenSpec',
      initBusy: '初始化中…',
      retry: '重试',
      error: '读取失败',
      noChanges: '还没有进行中的变更',
      noChangesHint: '用「提案」开始一个变更，或用「探索」先想清楚要做什么。',
      newProposal: '新建提案',
      changeCount: '{count} 个变更',
      archived: '已归档 {count} 个变更',
      watchDown: '目录监听不可用，已改用轮询刷新。',
      pollingHint: '此工作区暂无会话，面板每 4 秒向 Host 轮询一次最新状态。',
      workspaceLabel: '工作区',
      specOverview: 'Spec 概览',
      activeChanges: '进行中的变更',
      capabilitySpecs: '已定稿 Spec',
      archivedChanges: '已归档',
      archivedHint: '按归档时间倒序沉底展示',
      noCapabilities: '还没有定稿的 Spec',
      noCapabilitiesHint: '实施并归档变更后，delta specs 会同步到这里。',
      noArchived: '还没有归档的变更。',
      noDocs: '没有可查看的文档',
      docs: '文档',
      taskList: '任务清单',
      tasksDone: '{done}/{total} 已完成',
      progressLabel: '任务进度',
      phaseDistribution: '阶段分布',
      statActive: '进行中',
      statSpecs: '能力 Spec',
      statArchived: '已归档',
      loadingDoc: '正在读取文档…',
      readDocFailed: '读取文档失败',
      docEmpty: '这个文档是空的。',
      viewDoc: '查看文档',
      expand: '展开',
      collapse: '收起',
      archiveDated: '{date} 归档',
      noTasks: '还没有任务清单',
      moreTasks: '还有 {count} 项',
      expandTasks: '展开剩余 {count} 项',
      collapseTasks: '收起',
      alignDoc: '去工作区对齐',
      alignDraft: '对齐这份文档：{path}',
      alignBusy: '正在新建会话…',
      requirementCount: '{count} 项需求',
      switchFailed: '没有可用会话，无法切换到该工作区',
      explore: '探索',
      propose: '提案',
      apply: '实施',
      applyContinue: '继续实施',
      archive: '归档',
      status: '状态',
      openPanel: '打开 OpenSpec 面板',
      phaseDraft: '草稿',
      phaseProposed: '待评审',
      phaseApply: '实施中',
      phaseReady: '待归档',
      files: '工件',
      cancel: '取消',
      close: '关闭',
      fillComposer: '填入输入框',
      exploreGo: '开始探索',
      proposeGo: '发送',
      insertFailed: '没找到输入框。',
      proposeTitle: '提案新变更',
      proposeDesc: '创建一个 OpenSpec 变更：proposal.md、delta specs 与 tasks.md。写完计划会停下等你评审，不写产品代码。',
      proposeField: '变更名',
      proposePlaceholder: '例如 add-dark-mode',
      proposeHint: '小写连字符命名，可附一句说明，例如 add-dark-mode 支持深色主题。',
      exploreTitle: '探索模式',
      exploreDesc: '调查代码、比较方案、给出建议；这个阶段不写任何文件。',
      exploreField: '想探索什么',
      explorePlaceholder: '可以留空，让我根据现状帮你选下一步',
      exploreHint: '留空也可以；Enter 直接开始，Esc 取消。',
      commandFailed: '命令执行失败',
      commandSent: '已发送',
      quickMissing: '未初始化',
      quickNoChange: '无进行中变更',
      switchChange: '切换变更',
      taskProgress: '{done}/{total}',
      enterHint: 'Enter 确认 · Esc 取消',
      artifactDone: '完成',
      artifactSkipped: '跳过',
      artifactReady: '可创建',
      artifactBlocked: '阻塞',
      artifactUnknown: '未知',
      artifactsLabel: '工件',
      artifactProgress: '工件进度',
      artifactSource: '工件 {id}',
      missingDeps: '缺少依赖：{deps}',
      skipSpecs: '跳过 specs',
      retireCaps: '归档后移除能力',
      schemaLabel: 'Schema',
      schemaProject: '项目',
      schemaBuiltin: '内置',
      schemaUnknown: '未知',
      configSection: '项目配置',
      configMissing: '未找到 openspec/config.yaml，使用默认 schema：{schema}',
      effectiveSchema: '生效 Schema',
      contextLabel: 'Context',
      contextEmpty: '未配置项目 context',
      contextShow: '展开完整 context',
      contextHide: '收起 context',
      rulesLabel: 'Rules',
      rulesEmpty: '没有按 artifact 配置的 rules',
      rulesCount: '{count} 条',
      operationsLabel: 'Operations',
      operationApply: 'apply 指导',
      operationArchive: 'archive 指导',
      schemasSection: '可用 Schema',
      schemaArtifacts: '工件：{items}',
      validationLabel: '校验',
      validationClean: '无校验问题',
      validationSummary: '{errors} 错误 · {warnings} 警告',
      issuesList: '校验问题',
      showMoreItems: '显示另外 {count} 个',
      moreItems: '还有 {count} 个',
      allItemsShown: '已显示全部 {count} 个',
      deltaSection: 'Delta 操作',
      deltaAdded: '+{count} 新增',
      deltaModified: '{count} 修改',
      deltaRemoved: '{count} 删除',
      deltaRenamed: '{count} 重命名',
      deltaEmpty: '没有 delta 文件',
      deltaFiles: 'delta 文件',
      nextSteps: '下一步建议',
      noNextSteps: '没有额外建议',
      nextActionPropose: '提案',
      nextActionUpdate: '继续规划',
      nextActionApply: '实施',
      nextActionArchive: '归档',
      metadataLabel: '.openspec.yaml',
      metaSchema: 'Schema',
      metaCreated: '创建',
      metaGoal: '目标',
      metaSkip: '跳过 specs',
      metaRetire: '归档后移除能力',
      metaMissing: '没有 .openspec.yaml（按项目配置推导）',
      metaNone: '—',
      capabilityTitle: '能力 Spec',
      capabilityPurpose: 'Purpose',
      scenarioCount: '{count} 场景',
      specIssues: '{count} 问题',
      archiveUnknownDate: '未知日期',
      archiveSectionTitle: '已归档变更',
      archiveTasks: '任务',
      archiveMetadata: '元数据',
      archiveArtifacts: '工件',
      archiveProbeNote: '归档详情按已知工件名读取；自定义/glob 工件请直接在仓库中查看。',
      archiveLoadFailed: '读取归档详情失败',
      archiveDetailLoading: '正在读取归档详情…',
      quickNext: '下一步',
      nativeSkills: '原生技能',
      nativeSkillsTitle: '检测到原生 OpenSpec skills：{names}',
      fallbackSkills: '内置技能',
      fallbackSkillsTitle: '未检测到原生 skills，使用插件内置的文件语义 fallback。',
      nativeSkillsCount: '{count} 个',
      docTruncated: '{total} 行文档，仅显示前 {shown} 行',
      docTruncatedSimple: '仅显示前 {shown} 行',
      docShowMore: '继续读取（{count} 行）',
      docReadMoreFailed: '读取后续内容失败',
      docAtLine: '已定位到第 {line} 行',
      validateAction: '校验',
      validating: '校验中…',
      validateTitle: '校验结果',
      validateDesc: '由 Host 原生校验引擎只读计算，不写任何文件。',
      validateFailed: '校验失败',
      syncPreviewAction: '同步预览',
      syncPreviewTitle: 'Spec 同步预览',
      syncPreviewDesc: '只读预览；确认无误后用 /opsx-sync 执行。',
      syncPreviewFailed: '同步预览失败',
      initCreated: '新建：{items}',
      initAlready: '没有需要新建的文件。',
      blockedCount: '{count} 阻塞',
      changesBlockedHint: '有 artifact 因缺少依赖被阻塞。',
      workspaceWarnings: '工作区警告',
      changeSchema: 'Schema {name}',
      noIssues: '没有校验问题',
      docsFromSchema: '按生效 schema 的 generates 列出',
      plannerComplete: '规划完成',
      planning: '规划中',
      loadingArchive: '正在读取归档…',
      customArtifactsNote: '自定义/glob 工件已按 generates 展开；未列出的内容不会静默丢弃。',
    },
    en: {
      panel: 'OpenSpec',
      title: 'OpenSpec workflow',
      subtitle: 'Progress lives only in the openspec/ files — this is its live view.',
      refresh: 'Refresh',
      refreshAll: 'Refresh all',
      loading: 'Reading openspec/ …',
      nosession: 'No known workspace session here yet.',
      nosessionHint: 'Start a conversation in this workspace and its openspec/ state appears here.',
      missing: 'This workspace has no openspec/ yet',
      missingHint: 'Initializing writes config.yaml, specs/ and changes/archive/; the AI can then run the /opsx-* spec loop.',
      init: 'Initialize OpenSpec',
      initBusy: 'Initializing…',
      retry: 'Retry',
      error: 'Read failed',
      noChanges: 'No change in motion',
      noChangesHint: 'Start one with Propose, or think it through with Explore first.',
      newProposal: 'New proposal',
      changeCount: '{count} changes',
      archived: '{count} archived changes',
      watchDown: 'Directory watch unavailable; falling back to polling.',
      pollingHint: 'No session in this workspace — the panel polls the Host for fresh state every 4s.',
      workspaceLabel: 'Workspace',
      specOverview: 'Spec overview',
      activeChanges: 'Changes in motion',
      capabilitySpecs: 'Capability specs',
      archivedChanges: 'Archived',
      archivedHint: 'Newest first, kept at the bottom',
      noCapabilities: 'No capability spec yet',
      noCapabilitiesHint: 'Archiving a change syncs its delta specs here.',
      noArchived: 'No archived change yet.',
      noDocs: 'No document to view',
      docs: 'Documents',
      taskList: 'Tasks',
      tasksDone: '{done}/{total} done',
      progressLabel: 'Task progress',
      phaseDistribution: 'Phase split',
      statActive: 'Active',
      statSpecs: 'Capabilities',
      statArchived: 'Archived',
      loadingDoc: 'Reading document…',
      readDocFailed: 'Failed to read the document',
      docEmpty: 'This document is empty.',
      viewDoc: 'View document',
      expand: 'Expand',
      collapse: 'Collapse',
      archiveDated: 'archived {date}',
      noTasks: 'No task list yet',
      moreTasks: '{count} more',
      expandTasks: 'Show remaining {count}',
      collapseTasks: 'Collapse',
      alignDoc: 'Align in workspace',
      alignDraft: 'Align on this document: {path}',
      alignBusy: 'Starting a session…',
      requirementCount: '{count} requirements',
      switchFailed: 'No session available to open this workspace.',
      explore: 'Explore',
      propose: 'Propose',
      apply: 'Apply',
      applyContinue: 'Continue',
      archive: 'Archive',
      status: 'Status',
      openPanel: 'Open the OpenSpec panel',
      phaseDraft: 'Draft',
      phaseProposed: 'Review',
      phaseApply: 'Applying',
      phaseReady: 'Ready',
      files: 'Artifacts',
      cancel: 'Cancel',
      close: 'Close',
      fillComposer: 'Fill composer',
      exploreGo: 'Start exploring',
      proposeGo: 'Send',
      insertFailed: 'Composer not found.',
      proposeTitle: 'Propose a change',
      proposeDesc: 'Creates an OpenSpec change: proposal.md, delta specs and tasks.md. It stops after the plan for your review and writes no product code.',
      proposeField: 'Change name',
      proposePlaceholder: 'e.g. add-dark-mode',
      proposeHint: 'Kebab-case name, optionally with a note, e.g. add-dark-mode support dark theme.',
      exploreTitle: 'Explore mode',
      exploreDesc: 'Investigate code, compare options, give advice; this phase writes no files.',
      exploreField: 'What to explore',
      explorePlaceholder: 'Leave empty and I will pick the next step from the current state',
      exploreHint: 'Empty is fine; Enter starts, Esc cancels.',
      commandFailed: 'Command failed',
      commandSent: 'Sent',
      quickMissing: 'Not initialized',
      quickNoChange: 'No change in motion',
      switchChange: 'Switch change',
      taskProgress: '{done}/{total}',
      enterHint: 'Enter to confirm · Esc to cancel',
      artifactDone: 'Done',
      artifactSkipped: 'Skipped',
      artifactReady: 'Ready',
      artifactBlocked: 'Blocked',
      artifactUnknown: 'Unknown',
      artifactsLabel: 'Artifacts',
      artifactProgress: 'Artifact progress',
      artifactSource: 'artifact {id}',
      missingDeps: 'Missing dependencies: {deps}',
      skipSpecs: 'skip_specs',
      retireCaps: 'retire capabilities after archive',
      schemaLabel: 'Schema',
      schemaProject: 'Project',
      schemaBuiltin: 'Builtin',
      schemaUnknown: 'Unknown',
      configSection: 'Project config',
      configMissing: 'No openspec/config.yaml found; using the default schema: {schema}',
      effectiveSchema: 'Effective schema',
      contextLabel: 'Context',
      contextEmpty: 'No project context configured',
      contextShow: 'Show full context',
      contextHide: 'Collapse context',
      rulesLabel: 'Rules',
      rulesEmpty: 'No per-artifact rules configured',
      rulesCount: '{count} rules',
      operationsLabel: 'Operations',
      operationApply: 'apply guidance',
      operationArchive: 'archive guidance',
      schemasSection: 'Available schemas',
      schemaArtifacts: 'Artifacts: {items}',
      validationLabel: 'Validation',
      validationClean: 'No validation issues',
      validationSummary: '{errors} errors · {warnings} warnings',
      issuesList: 'Validation issues',
      showMoreItems: 'Show {count} more',
      moreItems: '{count} more',
      allItemsShown: 'All {count} shown',
      deltaSection: 'Delta operations',
      deltaAdded: '+{count} added',
      deltaModified: '{count} modified',
      deltaRemoved: '{count} removed',
      deltaRenamed: '{count} renamed',
      deltaEmpty: 'No delta files',
      deltaFiles: 'Delta files',
      nextSteps: 'Suggested next steps',
      noNextSteps: 'No extra suggestion',
      nextActionPropose: 'Propose',
      nextActionUpdate: 'Keep planning',
      nextActionApply: 'Apply',
      nextActionArchive: 'Archive',
      metadataLabel: '.openspec.yaml',
      metaSchema: 'Schema',
      metaCreated: 'Created',
      metaGoal: 'Goal',
      metaSkip: 'skip_specs',
      metaRetire: 'retire capabilities',
      metaMissing: 'No .openspec.yaml (derived from project config)',
      metaNone: '—',
      capabilityTitle: 'Capability specs',
      capabilityPurpose: 'Purpose',
      scenarioCount: '{count} scenarios',
      specIssues: '{count} issues',
      archiveUnknownDate: 'Unknown date',
      archiveSectionTitle: 'Archived changes',
      archiveTasks: 'Tasks',
      archiveMetadata: 'Metadata',
      archiveArtifacts: 'Artifacts',
      archiveProbeNote: 'Archive details are probed by known artifact names; custom/glob artifacts are read from the repository.',
      archiveLoadFailed: 'Failed to read the archived change',
      archiveDetailLoading: 'Reading archived change…',
      quickNext: 'Next step',
      nativeSkills: 'Native skills',
      nativeSkillsTitle: 'Detected native OpenSpec skills: {names}',
      fallbackSkills: 'Builtin skills',
      fallbackSkillsTitle: 'No native skills detected; using the plugin file-semantics fallback.',
      nativeSkillsCount: '{count}',
      docTruncated: '{total}-line document — showing the first {shown} lines',
      docTruncatedSimple: 'Showing the first {shown} lines',
      docShowMore: 'Load {count} more lines',
      docReadMoreFailed: 'Failed to read more of the document',
      docAtLine: 'Located at line {line}',
      validateAction: 'Validate',
      validating: 'Validating…',
      validateTitle: 'Validation result',
      validateDesc: 'Computed read-only by the Host native validator; nothing is written.',
      validateFailed: 'Validation failed',
      syncPreviewAction: 'Sync preview',
      syncPreviewTitle: 'Spec sync preview',
      syncPreviewDesc: 'Read-only preview; run /opsx-sync to apply it.',
      syncPreviewFailed: 'Failed to build the sync preview',
      initCreated: 'Created: {items}',
      initAlready: 'Nothing to create.',
      blockedCount: '{count} blocked',
      changesBlockedHint: 'Some artifacts are blocked by missing dependencies.',
      workspaceWarnings: 'Workspace warnings',
      changeSchema: 'Schema {name}',
      noIssues: 'No validation issues',
      docsFromSchema: 'Listed from the effective schema generates paths',
      plannerComplete: 'Planning complete',
      planning: 'Planning',
      loadingArchive: 'Reading archive…',
      customArtifactsNote: 'Custom/glob artifacts are expanded from generates; nothing listed here is silently dropped.',
    },
  }

  /** Plugin-scoped styles; only --dsw-* theme tokens (plus host radii/elevation). */
  const CSS = `
.dshspec-root{height:100%;min-height:0;overflow-y:auto;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55}
.dshspec-page{max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 56px;display:flex;flex-direction:column;gap:20px}
.dshspec-pageHead{display:flex;align-items:flex-start;gap:16px}
.dshspec-pageHeadText{min-width:0;flex:1}
.dshspec-title{margin:0;font-size:20px;line-height:28px;font-weight:500;letter-spacing:0}
.dshspec-sub{margin-top:2px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshspec-pageActions{display:flex;align-items:center;gap:8px;flex:none}
.dshspec-space{flex:1}

/* Workspace switcher --------------------------------------------------- */
.dshspec-wsbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshspec-wsbarLabel{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshspec-wstabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dshspec-wstab{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;min-width:0;max-width:280px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.dshspec-wstab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-wstab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-wstab[data-active='true']{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
.dshspec-wstab .dshspec-icon{color:var(--dsw-alias-label-tertiary)}
.dshspec-wstabName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dshspec-wstabCount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* Detail toolbar ------------------------------------------------------- */
.dshspec-detail{display:flex;flex-direction:column;gap:16px}
.dshspec-detailBar{display:flex;align-items:center;gap:10px;min-width:0}
.dshspec-detailBarIcon{color:var(--dsw-alias-label-tertiary)}
.dshspec-detailBarPath{flex:1;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-detailActions{flex:none;display:flex;align-items:center;gap:8px}

/* Spec overview -------------------------------------------------------- */
.dshspec-summary{display:flex;align-items:center;gap:clamp(18px,3vw,32px);flex-wrap:wrap;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,16px);padding:16px 20px}
.dshspec-ringWrap{position:relative;width:72px;height:72px;flex:none}
.dshspec-ringText{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;pointer-events:none}
.dshspec-ringValue{font-size:16px;line-height:19px;font-weight:600;font-variant-numeric:tabular-nums}
.dshspec-ringLabel{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dshspec-summaryPhase{flex:1 1 240px;min-width:200px;display:flex;flex-direction:column;gap:8px}
.dshspec-summaryLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshspec-phaseBar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-phaseSeg{height:100%;min-width:3px;transition:flex-grow .24s ease}
.dshspec-phaseLegend{display:flex;flex-wrap:wrap;gap:6px 16px}
.dshspec-legendItem{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshspec-legendItem b{font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshspec-summaryStats{display:flex;align-items:flex-start;gap:clamp(16px,2.4vw,26px);flex:none}
.dshspec-stat{display:flex;flex-direction:column;gap:2px;min-width:48px}
.dshspec-statValue{font-size:18px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.dshspec-statLabel{font-size:11.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}

/* Sections ------------------------------------------------------------- */
.dshspec-section{display:flex;flex-direction:column;gap:8px}
.dshspec-sectionHead{display:flex;align-items:center;gap:8px;min-height:28px}
.dshspec-sectionTitle{font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-sectionCount{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:1px 7px;font-variant-numeric:tabular-nums}
.dshspec-sectionActions{margin-left:auto;display:flex;align-items:center;gap:6px}
.dshspec-sectionToggle{display:inline-flex;align-items:center;gap:8px;padding:2px 4px 2px 0;margin:0;border:none;border-radius:8px;background:transparent;font:inherit;color:inherit;cursor:pointer}
.dshspec-sectionToggle:hover .dshspec-sectionTitle{color:var(--dsw-alias-label-primary)}
.dshspec-sectionToggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-sectionBody{display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.dshspec-sectionEmpty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:24px 16px;text-align:center}
.dshspec-sectionEmptyIcon{width:36px;height:36px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-sectionEmptyTitle{font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-sectionEmptyHint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);max-width:420px}
.dshspec-sectionEmpty .dshspec-btn{margin-top:4px}
.dshspec-note{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}

/* Rows / collapsible items -------------------------------------------- */
.dshspec-rowItem{display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;border:none;background:transparent;font:inherit;text-align:left;color:inherit;cursor:pointer;min-width:0;transition:background .12s ease}
.dshspec-rowItem+.dshspec-rowItem{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-rowItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-rowItem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-rowIcon{flex:none;width:30px;height:30px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.dshspec-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshspec-rowName{font-size:13.5px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-rowMeta{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-rowEnd{flex:none;display:flex;align-items:center;gap:8px;color:var(--dshspec-label-tertiary,var(--dsw-alias-label-tertiary))}

.dshspec-item{display:flex;flex-direction:column;min-width:0}
.dshspec-item+.dshspec-item{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-itemHead{display:flex;align-items:center;gap:10px;padding:10px 14px;min-width:0;flex-wrap:wrap;cursor:pointer;user-select:none}
.dshspec-itemHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-itemChips{padding:0 14px 10px}
.dshspec-summaryWide{flex:1 0 100%}
.dshspec-itemHead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-itemHeadRow{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.dshspec-itemBody{display:flex;flex-direction:column;gap:12px;padding:12px 14px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-chev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dshspec-chevOpen{transform:rotate(90deg)}
.dshspec-changeName{font-size:13.5px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-changeButtons{flex:none;display:flex;align-items:center;gap:6px}
.dshspec-changeProgress{flex:0 1 150px;min-width:96px}
.dshspec-dateChip{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:1px 6px;font-variant-numeric:tabular-nums}
.dshspec-decoIcon{opacity:.5}

/* Documents & tasks inside an expanded item --------------------------- */
.dshspec-subHead{display:flex;align-items:center;gap:8px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshspec-subHead b{font-weight:400;color:var(--dsw-alias-label-secondary)}
.dshspec-docGrid{display:flex;flex-wrap:wrap;gap:8px}
.dshspec-docBtn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.dshspec-docBtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dshspec-docBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-docBtn .dshspec-icon{color:var(--dsw-alias-label-tertiary)}
.dshspec-docKind{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dshspec-taskBlock{display:flex;flex-direction:column;gap:6px}
.dshspec-taskList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.dshspec-task{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshspec-task .dshspec-icon{margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.dshspec-taskDone{color:var(--dsw-alias-label-tertiary)}
.dshspec-taskDone .dshspec-icon{color:var(--dsw-alias-state-success-primary)}
.dshspec-taskMore{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;margin-top:2px;padding:3px 8px 3px 5px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:17px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshspec-taskMore:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-taskMore:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-inlineLoad{display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}

/* Badges, progress, chips (shared) ------------------------------------ */
.dshspec-badge{flex:none;display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 8px 0 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap;font-weight:400}
.dshspec-badgeDot{width:5px;height:5px;border-radius:50%;flex:none}
.dshspec-progress{display:flex;align-items:center;gap:8px;flex:0 1 170px;min-width:110px;max-width:220px}
.dshspec-progressTrack{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.dshspec-progressFill{height:100%;border-radius:2px;transition:width .24s ease}
.dshspec-progressCount{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshspec-fileChip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap}

/* Buttons -------------------------------------------------------------- */
.dshspec-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;border:none;font:inherit;cursor:pointer;white-space:nowrap;border-radius:12px;transition:background .12s ease,border-color .12s ease,color .12s ease,opacity .12s ease;-webkit-app-region:no-drag}
.dshspec-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-btn:disabled{opacity:.4;cursor:default}
.dshspec-btn-md{height:32px;padding:0 13px;font-size:13px}
.dshspec-btn-sm{height:28px;padding:0 10px;font-size:12.5px;border-radius:10px}
.dshspec-btn-lg{height:36px;padding:0 16px;font-size:13.5px;border-radius:12px}
.dshspec-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshspec-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshspec-btn-outline{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.dshspec-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dshspec-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary)}
.dshspec-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-iconBtn{display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;cursor:pointer;transition:background .12s ease,color .12s ease;-webkit-app-region:no-drag}
.dshspec-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-iconBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-icon{display:block;flex:none}

/* Composer dock -------------------------------------------------------- */
.dshspec-dock{position:relative;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 2px 6px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);min-width:0}
.dshspec-dockStatus{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.dshspec-dockTargetWrap{position:relative;display:flex;align-items:center;min-width:0}
.dshspec-dockTarget{display:inline-flex;align-items:center;gap:7px;min-width:0;padding:2px 6px 2px 3px;margin-left:-3px;border:none;border-radius:8px;background:transparent;font:inherit;color:inherit;cursor:pointer;text-align:left}
.dshspec-dockTarget:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-dockTarget:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshspec-dockCaret{flex:none;color:var(--dsw-alias-label-tertiary)}
.dshspec-dockMenu{position:absolute;left:0;bottom:calc(100% + 8px);z-index:80;min-width:300px;max-width:min(380px,calc(100vw - 48px));max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:1px;padding:4px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-elevation-prominent);animation:dshspec-fade .12s ease-out}
.dshspec-dockMenuHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshspec-dockMenuItem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:none;border-radius:8px;background:transparent;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.dshspec-dockMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-dockMenuItem[data-active='true']{background:var(--dsw-alias-interactive-bg-hover-accent)}
.dshspec-dockMenuItem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-dockMenuName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dshspec-dockMenuCount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshspec-dockName{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-dockActions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}
.dshspec-seg{display:flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-seg .dshspec-btn-sm{height:24px;padding:0 8px;font-size:12px;border-radius:8px}
.dshspec-seg .dshspec-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary)}
.dshspec-seg .dshspec-btn-primary{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-button-ghost-active-border)}
.dshspec-seg .dshspec-btn-primary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent)}
.dshspec-dot{width:7px;height:7px;border-radius:50%;flex:none}

/* Modal ---------------------------------------------------------------- */
.dshspec-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.24);animation:dshspec-fade .12s ease-out}
.dshspec-modal{width:100%;max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-panel,28px);box-shadow:var(--dsw-elevation-prominent);padding:22px 24px 20px;display:flex;flex-direction:column;gap:16px;animation:dshspec-pop .14s cubic-bezier(.2,.8,.2,1)}
.dshspec-modal:focus,.dshspec-modal:focus-visible{outline:none}
.dshspec-modalHead{display:flex;align-items:flex-start;gap:12px}
.dshspec-modalHeadText{flex:1;min-width:0}
.dshspec-modalHeadActions{flex:none;display:flex;align-items:center;gap:8px}
.dshspec-modalTitle{margin:0;font-size:16px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshspec-modalDesc{margin:6px 0 0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshspec-modalBody{display:flex;flex-direction:column;gap:12px;min-width:0}
.dshspec-modalFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshspec-field{display:flex;flex-direction:column;gap:6px}
.dshspec-fieldLabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dshspec-input{height:40px;width:100%;box-sizing:border-box;border-radius:12px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;padding:0 13px;transition:border-color .12s ease,box-shadow .12s ease}
.dshspec-input::placeholder{color:var(--dsw-alias-label-caption)}
.dshspec-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.dshspec-hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dshspec-errorText{font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary)}

/* Document viewer ------------------------------------------------------ */
.dshspec-docViewport{max-height:min(62vh,620px);overflow:auto;padding:2px 2px 8px;border-top:.5px solid var(--dsw-alias-border-l1);margin-top:2px}
.dshspec-docPath{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshspec-markdown{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshspec-markdown>*:first-child{margin-top:0}
.dshspec-markdown>*:last-child{margin-bottom:0}
.dshspec-mdH{margin:18px 0 8px;font-weight:600;line-height:1.4}
.dshspec-mdH1{font-size:20px}
.dshspec-mdH2{font-size:17px}
.dshspec-mdH3{font-size:15px}
.dshspec-mdH4{font-size:14px}
.dshspec-mdP{margin:0 0 10px}
.dshspec-mdList{margin:0 0 10px;padding-left:20px}
.dshspec-mdLi{margin:2px 0}
.dshspec-mdCheck{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-right:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;font-size:10px;line-height:1;vertical-align:-2px;color:transparent}
.dshspec-mdCheckOn{background:var(--dsw-alias-state-success-secondary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dshspec-mdPre{background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-interactive-bg-hover));border-radius:10px;padding:10px 12px;margin:0 0 12px;overflow:auto;font-size:12.5px;line-height:1.6;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dshspec-mdCode{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12.5px;background:var(--dsw-alias-markdown-inline-code,var(--dsw-alias-interactive-bg-hover));border-radius:4px;padding:1px 5px}
.dshspec-mdQuote{margin:0 0 12px;padding:4px 0 4px 12px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.dshspec-mdHr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:16px 0}
.dshspec-markdown a{color:var(--dsw-alias-link);text-decoration:none}
.dshspec-markdown a:hover{text-decoration:underline}

/* State panels --------------------------------------------------------- */
.dshspec-card{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,16px);padding:18px 20px 16px;display:flex;flex-direction:column;gap:14px}
.dshspec-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:30px 16px 26px}
.dshspec-emptyIcon{flex:none;width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-emptyTitle{font-size:14px;line-height:20px;font-weight:500}
.dshspec-emptyDesc{font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);max-width:440px}
.dshspec-empty .dshspec-btn{margin-top:6px}
.dshspec-missing{display:flex;align-items:flex-start;gap:14px;padding:6px 0 4px}
.dshspec-missingText{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshspec-missingTitle{font-size:14px;line-height:20px;font-weight:500}
.dshspec-missingDesc{font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);max-width:620px}
.dshspec-missing .dshspec-btn{align-self:flex-start;margin-top:8px}
.dshspec-nosession{display:flex;align-items:flex-start;gap:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:2px 0}

.dshspec-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:12px;font-size:12.5px;line-height:18px}
.dshspec-bannerInfo{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-bannerWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.dshspec-bannerError{background:var(--dsw-alias-state-error-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary)}
.dshspec-bannerText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-bannerTextWrap{min-width:0;overflow-wrap:anywhere}

.dshspec-foot{display:flex;align-items:center;gap:7px;padding-top:2px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshspec-loading{display:flex;flex-direction:column;gap:9px;padding:4px 0 6px}
.dshspec-skelLine{height:10px;border-radius:5px;background:var(--dsw-alias-bg-skeleton);animation:dshspec-pulse 1.4s ease-in-out infinite}
.dshspec-spin{animation:dshspec-rotate .8s linear infinite}
.dshspec-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:1001;display:flex;align-items:center;gap:8px;max-width:min(520px,calc(100vw - 48px));padding:9px 14px;border-radius:12px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:12.5px;line-height:18px;box-shadow:var(--dsw-elevation-prominent);animation:dshspec-fade .12s ease-out}

/* Native model: artifact chips, metadata, issues, lists ----------------- */
.dshspec-chipRow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.dshspec-artChip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px 0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:1;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease}
.dshspec-artChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-artChip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-artChip[data-status='ready']{border-color:var(--dsw-alias-state-business-primary)}
.dshspec-artChip[data-status='blocked']{border-color:var(--dsw-alias-state-warn-primary)}
.dshspec-artChip[data-status='done']{border-color:var(--dsw-alias-state-success-secondary)}
.dshspec-artChipDot{width:6px;height:6px;border-radius:50%;flex:none}
.dshspec-artChipState{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.dshspec-artChip[data-status='ready'] .dshspec-artChipState,.dshspec-artChip[data-status='blocked'] .dshspec-artChipState{color:var(--dsw-alias-label-secondary)}
.dshspec-depsRow{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.dshspec-depsRow b{font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-kv{display:flex;align-items:baseline;gap:10px;min-width:0;font-size:12.5px;line-height:18px}
.dshspec-kvLabel{flex:none;min-width:72px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.dshspec-kvValue{min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshspec-kvValue code,.dshspec-mono{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px}
.dshspec-pre{margin:0;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}
.dshspec-prePlain{max-height:none;overflow:visible}
.dshspec-issueList{display:flex;flex-direction:column;gap:5px}
.dshspec-issue{display:flex;align-items:flex-start;gap:8px;padding:6px 9px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);min-width:0}
.dshspec-issueLevel{flex:none;font-size:10px;line-height:15px;font-weight:600;letter-spacing:.02em;padding:0 5px;border-radius:5px;color:var(--dsw-alias-label-primary)}
.dshspec-issuePath{flex:none;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-issueMsg{min-width:0;overflow-wrap:anywhere}
.dshspec-issue[data-tone='error'] .dshspec-issueLevel{background:var(--dsw-alias-state-error-secondary,var(--dsw-alias-state-error-primary));color:var(--dsw-alias-label-primary-foreground)}
.dshspec-issue[data-tone='warn'] .dshspec-issueLevel{background:var(--dsw-alias-state-warn-secondary,var(--dsw-alias-state-warn-primary));color:var(--dsw-alias-label-primary-foreground)}
.dshspec-issue[data-tone='info'] .dshspec-issueLevel{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dshspec-contextBox{max-height:180px;overflow:auto;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);padding:9px 11px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dshspec-nested{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:8px 14px;border:none;background:transparent;font:inherit;text-align:left;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .12s ease}
.dshspec-nested:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-nested:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-nested+.dshspec-nested{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-nestedGroup{display:flex;align-items:center;gap:8px;padding:8px 14px 5px;font-size:11.5px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary);min-width:0}
.dshspec-nestedGroup+ .dshspec-nested{border-top:none}
.dshspec-nestedName{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-nestedMeta{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-nestedEnd{flex:none;display:flex;align-items:center;gap:6px;margin-left:auto}
.dshspec-treeText{min-width:0;display:flex;flex-direction:column;gap:1px}
.dshspec-pageFoot{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshspec-skillChips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dshspec-inlineTag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1;white-space:nowrap}
.dshspec-summaryLine{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshspec-strongMeta{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.dshspec-strongMeta b{font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-codeBlock{max-height:min(54vh,520px);overflow:auto}
.dshspec-archGroup{display:flex;flex-direction:column}
.dshspec-archGroup+.dshspec-archGroup{border-top:1px solid var(--dsw-alias-border-l2)}
.dshspec-archHead{display:flex;align-items:center;gap:8px;padding:8px 14px 6px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

@keyframes dshspec-fade{from{opacity:0}to{opacity:1}}
@keyframes dshspec-pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
@keyframes dshspec-rotate{to{transform:rotate(360deg)}}
@keyframes dshspec-pulse{0%,100%{opacity:.65}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dshspec-overlay,.dshspec-modal,.dshspec-toast,.dshspec-spin,.dshspec-skelLine,.dshspec-chev,.dshspec-progressFill{animation:none;transition:none}}
`

  /** Inject the stylesheet once, tagged like shipped plugin CSS. */
  function injectStyle() {
    if (typeof document === 'undefined') return
    const tagId = 'dsh-spec/styles.css'
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-spec'
    tag.dataset.pluginCss = tagId
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  /* ------------------------------------------------------------------ *
   * Icons — 16px outline set matching the host's 1.2px stroke icons.
   * ------------------------------------------------------------------ */

  const ICONS = {
    refresh: [
      ['path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.61-3.89' }],
      ['path', { d: 'M13.5 2.5V6H10' }],
    ],
    compass: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M10.6 5.4 9.1 9.1 5.4 10.6l1.5-3.7z' }],
    ],
    filePlus: [
      ['path', { d: 'M9 2H4.6A1.6 1.6 0 0 0 3 3.6v8.8A1.6 1.6 0 0 0 4.6 14h6.8a1.6 1.6 0 0 0 1.6-1.6V6z' }],
      ['path', { d: 'M9 2v4h4' }],
      ['path', { d: 'M8 8.4v3.2M6.4 10h3.2' }],
    ],
    play: [['path', { d: 'M5.6 3.5v9L12.4 8z' }]],
    archive: [
      ['rect', { x: 2, y: 2.5, width: 12, height: 3.2, rx: 1 }],
      ['path', { d: 'M3 5.7v7.1a1.2 1.2 0 0 0 1.2 1.2h7.6a1.2 1.2 0 0 0 1.2-1.2V5.7' }],
      ['path', { d: 'M6.4 8.6h3.2' }],
    ],
    activity: [['path', { d: 'M1.8 8h2.7l1.9-4.6 2.9 9.2L11.4 8h2.8' }]],
    layout: [
      ['rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2 }],
      ['path', { d: 'M6 2.8v10.4' }],
    ],
    close: [['path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }]],
    check: [['path', { d: 'M3.4 8.4l3.1 3.1 6.1-7' }]],
    alert: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 4.8v3.9' }],
      ['circle', { cx: 8, cy: 11.2, r: 0.75, fill: 'currentColor', stroke: 'none' }],
    ],
    info: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 7.2v4' }],
      ['circle', { cx: 8, cy: 4.9, r: 0.75, fill: 'currentColor', stroke: 'none' }],
    ],
    folder: [
      ['path', { d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 2h4.8A1.6 1.6 0 0 1 14 6.6v5.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4z' }],
    ],
    folderPlus: [
      ['path', { d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 2h4.8A1.6 1.6 0 0 1 14 6.6v5.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4z' }],
      ['path', { d: 'M8 7.2v4.2M5.9 9.3h4.2' }],
    ],
    chevronRight: [['path', { d: 'M6.2 4l4 4-4 4' }]],
    chevronDown: [['path', { d: 'M4 6.2l4 4 4-4' }]],
    sparkle: [
      ['path', { d: 'M7.2 2.4l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1z' }],
      ['path', { d: 'M12.2 9.4l.55 1.55 1.55.55-1.55.55-.55 1.55-.55-1.55-1.55-.55 1.55-.55z', opacity: 0.7 }],
    ],
    send: [
      ['path', { d: 'M8 13V3.2' }],
      ['path', { d: 'M4 7.1 8 3.1l4 4' }],
    ],
    file: [
      ['path', { d: 'M9 2H4.6A1.6 1.6 0 0 0 3 3.6v8.8A1.6 1.6 0 0 0 4.6 14h6.8a1.6 1.6 0 0 0 1.6-1.6V6z' }],
      ['path', { d: 'M9 2v4h4' }],
      ['path', { d: 'M5.4 8.4h5.2M5.4 10.8h3.6' }],
    ],
    layers: [
      ['path', { d: 'M8 2.2 13.4 5 8 7.8 2.6 5z' }],
      ['path', { d: 'M2.8 8 8 10.7 13.2 8' }],
      ['path', { d: 'M2.8 11 8 13.7 13.2 11' }],
    ],
    checkSquare: [
      ['rect', { x: 2.4, y: 2.4, width: 11.2, height: 11.2, rx: 2.4 }],
      ['path', { d: 'M5.4 8.2 7.3 10l3.6-4' }],
    ],
    square: [['rect', { x: 2.4, y: 2.4, width: 11.2, height: 11.2, rx: 2.4 }]],
    clock: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 4.9V8l2.1 1.3' }],
    ],
    arrowUpRight: [
      ['path', { d: 'M4.4 11.6 11.6 4.4' }],
      ['path', { d: 'M5.6 4.4h6v6' }],
    ],
  }

  function Icon({ name, size = 16, className }) {
    const parts = ICONS[name] ?? ICONS.info
    return h(
      'svg',
      {
        className: 'dshspec-icon' + (className === undefined ? '' : ' ' + className),
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      parts.map(([tag, props], index) => h(tag, { key: index, ...props })),
    )
  }

  /* ------------------------------------------------------------------ *
   * Small presentational primitives (host-matched).
   * ------------------------------------------------------------------ */

  function Button({ variant = 'outline', size = 'md', icon, className, children, ...rest }) {
    const classes = ['dshspec-btn', `dshspec-btn-${variant}`, `dshspec-btn-${size}`]
    if (className !== undefined) classes.push(className)
    return h(
      'button',
      { type: 'button', className: classes.join(' '), ...rest },
      icon === undefined ? null : h(Icon, { name: icon, size: size === 'sm' ? 14 : 16 }),
      children === undefined || children === null || children === false ? null : h('span', null, children),
    )
  }

  function IconButton({ icon, label, size = 28, className, ...rest }) {
    const classes = ['dshspec-iconBtn']
    if (className !== undefined) classes.push(className)
    return h(
      'button',
      {
        type: 'button',
        className: classes.join(' '),
        title: label,
        'aria-label': label,
        style: { width: size, height: size },
        ...rest,
      },
      h(Icon, { name: icon, size: size >= 28 ? 16 : 14 }),
    )
  }

  function Progress({ done, total, color, compact }) {
    if (!(total > 0)) return null
    return h(
      'div',
      {
        className: 'dshspec-progress' + (compact === true ? ' dshspec-progressCompact' : ''),
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': total,
        'aria-valuenow': done,
      },
      h(
        'div',
        { className: 'dshspec-progressTrack' },
        h('div', {
          className: 'dshspec-progressFill',
          style: { width: `${Math.round((done / total) * 100)}%`, background: color },
        }),
      ),
      h('span', { className: 'dshspec-progressCount' }, `${done}/${total}`),
    )
  }

  /** Inline banner: info / warn / error with an icon. */
  function Banner({ tone = 'info', icon, children, wrap }) {
    const toneClass = tone === 'error' ? 'Error' : tone === 'warn' ? 'Warn' : 'Info'
    return h(
      'div',
      { className: `dshspec-banner dshspec-banner${toneClass}`, role: tone === 'error' ? 'alert' : 'status' },
      h(Icon, { name: icon ?? (tone === 'error' ? 'alert' : tone === 'warn' ? 'alert' : 'info'), size: 14 }),
      h('span', { className: wrap === true ? 'dshspec-bannerTextWrap' : 'dshspec-bannerText' }, children),
    )
  }

  /* ------------------------------------------------------------------ *
   * Modal — mirrors the host dialog: fixed mask, 28px panel radius, close
   * button, Esc / backdrop close, autofocus and focus restore.
   * ------------------------------------------------------------------ */

  function Modal({ t, title, description, children, footer, onClose, width = 512, focusCard, headActions }) {
    const cardRef = useRef(null)
    const restoreRef = useRef(null)
    const closeRef = useRef(onClose)
    closeRef.current = onClose

    useEffect(() => {
      restoreRef.current = typeof document === 'undefined' ? null : document.activeElement
      const card = cardRef.current
      const target =
        focusCard === true ? card : card?.querySelector('[data-autofocus]') ?? card?.querySelector('input, textarea, button')
      if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus()
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeRef.current()
        }
      }
      document.addEventListener('keydown', onKey, true)
      return () => {
        document.removeEventListener('keydown', onKey, true)
        const restore = restoreRef.current
        if (restore !== null && restore !== undefined && typeof restore.focus === 'function') {
          try {
            restore.focus()
          } catch {
            /* the trigger may be gone after a dispatch */
          }
        }
      }
    }, [])

    return h(
      'div',
      {
        className: 'dshspec-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) closeRef.current()
        },
      },
      h(
        'div',
        {
          ref: cardRef,
          className: 'dshspec-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          tabIndex: -1,
          style: { maxWidth: width },
        },
        h(
          'div',
          { className: 'dshspec-modalHead' },
          h('div', { className: 'dshspec-modalHeadText' },
            h('h2', { className: 'dshspec-modalTitle' }, title),
            description === undefined ? null : h('p', { className: 'dshspec-modalDesc' }, description),
          ),
          headActions === undefined || headActions === null
            ? null
            : h('div', { className: 'dshspec-modalHeadActions' }, headActions),
          h(IconButton, { icon: 'close', label: t('close'), onClick: onClose }),
        ),
        h('div', { className: 'dshspec-modalBody' }, children),
        footer === undefined || footer === null ? null : h('div', { className: 'dshspec-modalFoot' }, footer),
      ),
    )
  }

  /* ------------------------------------------------------------------ *
   * Command dialogs — one hook owns explore / propose / pick flows for a
   * surface, so the panel and the dock share exactly the same markup.
   * `insert` present = fill the composer draft; absent = run the command.
   * ------------------------------------------------------------------ */

  function useCommands({ t, run, insert, onResult }) {
    const [mode, setMode] = useState('none')
    const [draft, setDraft] = useState('')
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState(false)
    const hasInsert = typeof insert === 'function'

    const close = useCallback(() => {
      setMode('none')
      setDraft('')
      setError(null)
      setBusy(false)
    }, [])

    const open = useCallback((next) => {
      setDraft('')
      setError(null)
      setBusy(false)
      setMode(next)
    }, [])

    const execute = useCallback(
      (line) => {
        if (typeof insert === 'function') {
          let result
          try {
            result = insert(line)
          } catch (failure) {
            onResult?.({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }, line)
            return
          }
          if (result === false) {
            onResult?.({ ok: false, text: t('insertFailed') }, line)
            return
          }
          if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
            void result.then(
              (outcome) => {
                if (outcome !== undefined && outcome !== null && outcome.ok === false) onResult?.(outcome, line)
              },
              (failure) => onResult?.({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }, line),
            )
          }
          return
        }
        let promise
        try {
          promise = run(line)
        } catch (failure) {
          onResult?.({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }, line)
          return
        }
        if (promise !== null && typeof promise === 'object' && typeof promise.then === 'function') {
          void promise.then(
            (outcome) => onResult?.(outcome, line),
            (failure) => onResult?.({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }, line),
          )
        }
      },
      [insert, onResult, run, t],
    )

    const submit = useCallback(
      async (line) => {
        if (busy || line === undefined || line === null || line === '') return
        if (typeof insert === 'function') {
          setBusy(true)
          setError(null)
          let outcome
          try {
            outcome = await insert(line)
          } catch (failure) {
            outcome = { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
          }
          setBusy(false)
          if (outcome !== undefined && outcome !== null && outcome.ok === false) {
            setError(outcome.text ?? t('commandFailed'))
            return
          }
          close()
          if (typeof onResult === 'function') onResult(outcome, line)
          return
        }
        setBusy(true)
        setError(null)
        let outcome
        try {
          outcome = await run(line)
        } catch (failure) {
          outcome = { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
        }
        setBusy(false)
        if (outcome !== undefined && outcome.ok === true) {
          close()
          if (typeof onResult === 'function') onResult(outcome, line)
          return
        }
        setError(outcome?.text ?? t('commandFailed'))
      },
      [busy, close, insert, onResult, run, t],
    )

    const primaryLabel = hasInsert ? t('fillComposer') : mode === 'explore' ? t('exploreGo') : t('proposeGo')
    const footer = (line, disabled) => [
      h(Button, { key: 'cancel', variant: 'outline', size: 'lg', onClick: close, disabled: busy }, t('cancel')),
      h(
        Button,
        { key: 'go', variant: 'primary', size: 'lg', icon: 'send', disabled: disabled === true || busy, onClick: () => void submit(line) },
        primaryLabel,
      ),
    ]

    let modal = null
    if (mode === 'explore') {
      const lineOf = () => (draft.trim() === '' ? '/opsx-explore' : `/opsx-explore ${draft.trim()}`)
      modal = h(
        Modal,
        { t, title: t('exploreTitle'), description: t('exploreDesc'), onClose: close, footer: footer(lineOf(), false) },
        h(
          'div',
          { className: 'dshspec-field' },
          h('label', { className: 'dshspec-fieldLabel' }, t('exploreField')),
          h('input', {
            className: 'dshspec-input',
            value: draft,
            placeholder: t('explorePlaceholder'),
            autoFocus: true,
            'data-autofocus': 'true',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit(lineOf())
              }
            },
          }),
        ),
        h('div', { className: 'dshspec-hint' }, t('exploreHint')),
        error === null ? null : h('div', { className: 'dshspec-errorText' }, error),
      )
    } else if (mode === 'propose') {
      const lineOf = () => (draft.trim() === '' ? '' : `/opsx-propose ${draft.trim()}`)
      modal = h(
        Modal,
        { t, title: t('proposeTitle'), description: t('proposeDesc'), onClose: close, footer: footer(lineOf(), draft.trim() === '') },
        h(
          'div',
          { className: 'dshspec-field' },
          h('label', { className: 'dshspec-fieldLabel' }, t('proposeField')),
          h('input', {
            className: 'dshspec-input',
            value: draft,
            placeholder: t('proposePlaceholder'),
            autoFocus: true,
            'data-autofocus': 'true',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && draft.trim() !== '') {
                event.preventDefault()
                void submit(lineOf())
              }
            },
          }),
        ),
        h('div', { className: 'dshspec-hint' }, t('proposeHint')),
        error === null ? null : h('div', { className: 'dshspec-errorText' }, error),
      )
    }
    return { open, close, execute, modal, mode }
  }

  /* ------------------------------------------------------------------ *
   * Data layer — Host-derived native state.
   *
   * The browser never parses openspec/ files: every shape below comes from
   * `ctx.connection.rpc.call('/dsh-spec', method, payload)` (see
   * docs/native-module-contract.md §4/§5). A session file watch (or a 4s poll
   * for session-less workspaces) only decides when to re-read; nothing is
   * stored outside the React external store.
   * ------------------------------------------------------------------ */

  /** Join an absolute workspace root and a workspace-relative POSIX path. */
  function joinPath(root, rel) {
    return `${String(root).replace(/[\\/]+$/, '')}/${rel}`
  }

  /** Workspace-relative POSIX form of a Host-provided path (relative paths pass through). */
  function relPathOf(cwd, path) {
    const raw = String(path ?? '').replace(/\\/g, '/')
    const root = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (root !== '' && (raw === root || raw.startsWith(`${root}/`))) {
      return raw.slice(root.length).replace(/^\/+/, '')
    }
    return raw.replace(/^\.\//, '')
  }

  /** One Host route call → value; throws on the `{ok:false}` envelope. */
  async function callRoute(ctx, method, payload, label) {
    const result = await withTimeout(
      Promise.resolve(ctx.connection.rpc.call(ROUTE, method, payload)),
      RPC_TIMEOUT_MS,
      label ?? method,
    )
    if (result === null || typeof result !== 'object') throw new Error(`${method} 无响应`)
    if (result.ok !== true) {
      const error = result.error
      throw new Error(typeof error?.message === 'string' ? error.message : String(error?.code ?? method))
    }
    return result.value
  }

  /** Normalize the Host WorkspaceState into the panel snapshot (defensive). */
  function normalizeState(value, cwd) {
    if (value === null || typeof value !== 'object') return { status: 'error', cwd, error: '状态为空' }
    const status = value.status === 'missing' || value.status === 'error' ? value.status : 'ready'
    const warnings = Array.isArray(value.warnings) ? value.warnings : []
    if (status === 'error') {
      const error =
        typeof value.error === 'string'
          ? value.error
          : warnings.length > 0
            ? warnings.join('；')
            : '状态读取失败'
      return { ...value, status, cwd: typeof value.cwd === 'string' ? value.cwd : cwd, error, warnings }
    }
    return {
      ...value,
      status,
      cwd: typeof value.cwd === 'string' ? value.cwd : cwd,
      changes: Array.isArray(value.changes) ? value.changes : [],
      specs: Array.isArray(value.specs) ? value.specs : [],
      schemas: Array.isArray(value.schemas) ? value.schemas : [],
      archived: Array.isArray(value.archived) ? value.archived : [],
      skills: value.skills ?? { native: [], fallbackActive: false },
      warnings: Array.isArray(value.warnings) ? value.warnings : [],
      archivedCount: typeof value.archivedCount === 'number' ? value.archivedCount : Array.isArray(value.archived) ? value.archived.length : 0,
    }
  }

  /** Normalize one ChangeState (live or archived) so render code never crashes on a partial host. */
  function normalizeChangeState(change, fallbackName) {
    const value = change !== null && typeof change === 'object' ? change : {}
    return {
      ...value,
      name: typeof value.name === 'string' && value.name !== '' ? value.name : String(fallbackName ?? ''),
      schemaName: typeof value.schemaName === 'string' ? value.schemaName : '',
      schemaSource: value.schemaSource === 'project' || value.schemaSource === 'builtin' ? value.schemaSource : undefined,
      metadata: value.metadata !== null && typeof value.metadata === 'object' ? value.metadata : { found: false },
      artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
      docs: Array.isArray(value.docs) ? value.docs : [],
      delta:
        value.delta !== null && typeof value.delta === 'object'
          ? { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [], ...value.delta }
          : { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] },
      validation:
        value.validation !== null && typeof value.validation === 'object'
          ? { errors: 0, warnings: 0, infos: 0, issues: [], ...value.validation }
          : { errors: 0, warnings: 0, infos: 0, issues: [] },
      tasks: value.tasks !== null && typeof value.tasks === 'object' ? value.tasks : null,
      nextSteps: Array.isArray(value.nextSteps) ? value.nextSteps.filter((step) => typeof step === 'string') : [],
      applyRequires: Array.isArray(value.applyRequires) ? value.applyRequires : [],
      tracks: typeof value.tracks === 'string' ? value.tracks : null,
      isPlanningComplete: value.isPlanningComplete === true,
      listStatus: value.listStatus === 'complete' || value.listStatus === 'in-progress' ? value.listStatus : 'no-tasks',
    }
  }

  /**
   * Workspace source: one Host `state` snapshot plus the on-demand read-only
   * calls (`document`, `validate`, `sync-preview`, `archive-detail`) for one
   * absolute workspace path. Subscriptions drive the watch/poll lifecycle.
   */
  function createWorkspaceSource(ctx, row) {
    const cwd = row.cwd
    let snapshot = { status: 'loading', cwd }
    const listeners = new Set()
    const disposers = []
    let epoch = 0
    let watchAlive = false
    let watchFailed = false
    let pollTimer = null
    let debounceTimer = null
    let dirty = false

    const publish = (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    }

    const clearPoll = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    /** Slow re-read while the panel is open (session-less workspace or watch down). */
    const poll = (ms) => {
      clearPoll()
      pollTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden === true) return
        if (listeners.size > 0) void refresh()
      }, ms)
    }

    /** Follow `<cwd>/openspec` through the session file watch. */
    const startWatch = (sessionId) => {
      if (watchAlive || watchFailed) return
      if (typeof ctx.remote?.$stream !== 'function' || typeof ctx.remote?.workspaceFiles?.changes !== 'function') {
        watchFailed = true
        poll(FALLBACK_POLL_MS)
        return
      }
      const root = joinPath(cwd, 'openspec')
      let stream
      watchAlive = true
      try {
        stream = ctx.remote.$stream({
          name: `openspec ${root}`,
          open: (lifetime) => ctx.remote.workspaceFiles.changes(sessionId, root, lifetime),
          ended: () => new Error(`openspec watch ended: ${root}`),
        })
      } catch {
        watchAlive = false
        watchFailed = true
        poll(FALLBACK_POLL_MS)
        return
      }
      disposers.push(() => {
        watchAlive = false
        void stream.dispose()
      })
      void (async () => {
        try {
          for await (const item of stream) {
            if (typeof item?.accept === 'function') item.accept()
            if (item?.value?.kind === 'change') scheduleRefresh()
          }
        } catch {
          watchAlive = false
          watchFailed = true
          if (listeners.size === 0) return
          if (snapshot.status === 'ready') publish({ ...snapshot, watchDown: true })
          poll(FALLBACK_POLL_MS)
        }
      })()
    }

    /** Pick the freshness strategy: session watch, else 4s polling. */
    const ensureFreshness = () => {
      if (listeners.size === 0) return
      const sessionId = row.sessionId
      if (typeof sessionId === 'string' && sessionId !== '') {
        if (watchFailed) {
          if (pollTimer === null) poll(FALLBACK_POLL_MS)
          return
        }
        clearPoll()
        startWatch(sessionId)
        return
      }
      // No session: a workspace with no live session polls the Host route.
      if (pollTimer === null) poll(POLL_MS)
    }

    const refresh = async () => {
      const request = ++epoch
      try {
        const value = await callRoute(ctx, 'state', { cwd }, '读取 openspec 状态')
        if (request !== epoch) return
        publish(normalizeState(value, cwd))
        ensureFreshness()
      } catch (error) {
        if (request !== epoch) return
        const message = error instanceof Error ? error.message : String(error)
        if (snapshot.status === 'ready') publish({ ...snapshot, backgroundError: message })
        else publish({ status: 'error', cwd, error: message })
      }
    }

    const scheduleRefresh = () => {
      dirty = true
      if (debounceTimer !== null) return
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (dirty) {
          dirty = false
          void refresh()
        }
      }, REFRESH_DEBOUNCE_MS)
    }

    /**
     * Read one workspace document through the Host route.
     * @returns {{ok: boolean, path: string, text: string, offset: number, limit: number, truncated: boolean, totalLines: number|null, error?: string}}
     */
    const readDocument = async (path, options) => {
      const offset = typeof options?.offset === 'number' && options.offset > 0 ? Math.floor(options.offset) : 1
      const limit = typeof options?.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : DOC_PAGE_LINES
      try {
        const value = await callRoute(ctx, 'document', { cwd, path: relPathOf(cwd, path), offset, limit }, '读取文档')
        return {
          ok: true,
          path,
          text: typeof value?.text === 'string' ? value.text : '',
          offset,
          limit,
          truncated: value?.truncated === true,
          totalLines: typeof value?.totalLines === 'number' && Number.isFinite(value.totalLines) ? value.totalLines : null,
        }
      } catch (error) {
        return { ok: false, path, text: '', offset, limit, truncated: false, totalLines: null, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** Fallback archive detail for hosts without `archive-detail`: probe known artifacts. */
    const probeArchivedChange = async (path, entry) => {
      const candidates = ['.openspec.yaml', 'tasks.md', 'proposal.md', 'design.md']
      const docs = []
      let tasksText = ''
      let metadataText = ''
      for (const rel of candidates) {
        const page = await readDocument(`${path}/${rel}`, { offset: 1, limit: 400 })
        if (!page.ok) continue
        if (rel === 'tasks.md') tasksText = page.text
        else if (rel === '.openspec.yaml') metadataText = page.text
        else docs.push({ path: `${path}/${rel}`, label: rel, artifactId: rel.replace(/\.md$/, ''), kind: 'artifact' })
      }
      if (docs.length === 0 && tasksText === '' && metadataText === '') return null
      const tasks = tasksText === '' ? null : countTaskCheckboxes(tasksText)
      return normalizeChangeState(
        {
          name: entry?.changeName,
          metadata: { found: metadataText !== '', schema: null, created: null, goal: null, skip_specs: null },
          artifacts: [],
          docs,
          tasks,
          delta: { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] },
          validation: { errors: 0, warnings: 0, infos: 0, issues: [] },
          nextSteps: [],
          isPlanningComplete: false,
          listStatus: 'no-tasks',
          fallback: true,
          metadataText,
        },
        entry?.changeName ?? archiveEntryLabel(entry ?? {}),
      )
    }

    /** Load one archived change on demand (primary: `archive-detail`, fallback: known-file probe). */
    const loadArchive = async (entry) => {
      const path = relPathOf(cwd, entry?.path ?? '')
      if (path === '') return { ok: false, error: '归档路径为空' }
      try {
        const value = await callRoute(ctx, 'archive-detail', { cwd, path }, '读取归档')
        const change = normalizeChangeState(value?.change, entry?.changeName ?? archiveEntryLabel(entry ?? {}))
        return { ok: true, change, fallback: false }
      } catch (error) {
        const probed = await probeArchivedChange(path, entry)
        if (probed !== null) return { ok: true, change: probed, fallback: true }
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** On-demand validation for one change (`validate` route method). */
    const validateChange = async (changeName) => {
      try {
        const value = await callRoute(ctx, 'validate', { cwd, change: changeName }, '校验')
        const validation = value?.validation ?? value ?? null
        return { ok: true, validation, name: value?.name ?? changeName }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** Read-only merge preview for one change (`sync-preview` route method). */
    const syncPreview = async (changeName) => {
      try {
        const value = await callRoute(ctx, 'sync-preview', { cwd, change: changeName }, '同步预览')
        return { ok: true, text: typeof value?.text === 'string' ? value.text : '', preview: value?.preview ?? null }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    const start = () => {
      watchFailed = false
      disposers.push(
        ctx.on('connection/reset', () => {
          watchAlive = false
          watchFailed = false
          clearPoll()
          void refresh()
        }),
      )
      void refresh()
    }

    const stop = () => {
      epoch += 1
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      clearPoll()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* best-effort teardown */
        }
      }
    }

    return {
      cwd,
      sessionId: row.sessionId,
      hooks: {
        state: {
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener)
            if (listeners.size === 1) start()
            return () => {
              listeners.delete(listener)
              if (listeners.size === 0) stop()
            }
          },
        },
      },
      refresh,
      readDocument,
      loadArchive,
      validateChange,
      syncPreview,
    }
  }

  /** Session-less init through the Host route; reports the native scaffold's created items. */
  async function initWorkspace(ctx, cwd) {
    try {
      const value = await callRoute(ctx, 'init', { cwd: typeof cwd === 'string' ? cwd : '' }, '初始化')
      const created = Array.isArray(value?.created) ? value.created.filter((item) => typeof item === 'string') : []
      return {
        ok: true,
        text: typeof value?.text === 'string' ? value.text : '',
        created,
      }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error), created: [] }
    }
  }

  /** The session row's cwd from the sessions store snapshot (shape-defensive). */
  function cwdOf(ctx, sessionId) {
    try {
      const snap = ctx.sessions.list.getSnapshot()
      if (!snap) return undefined
      const rows = Array.isArray(snap)
        ? snap
        : snap.byId !== undefined && snap.byId !== null
          ? Object.values(snap.byId)
          : Array.isArray(snap.sessions)
            ? snap.sessions
            : []
      for (const row of rows) {
        if (row !== null && typeof row === 'object' && (row.id === sessionId || row.sessionId === sessionId)) {
          return row.cwd
        }
      }
    } catch {
      /* store unavailable: no cwd */
    }
    return undefined
  }

  /**
   * Workspace rows for the panel: the workspaces store is authoritative
   * (workspaceId + canonical path + its accounted sessions), with the sessions
   * store as a fallback when the workspaces face is unavailable. `sessionId`
   * is the dispatch/read target — `undefined` means "no session yet".
   */
  function workspaceRows(ctx) {
    const joined = []
    try {
      const snap = ctx.workspaces.list.getSnapshot()
      if (snap) {
        const views = Array.isArray(snap)
          ? snap
          : snap.byId !== undefined && snap.byId !== null
            ? Object.values(snap.byId)
            : Array.isArray(snap.items)
              ? snap.items
              : Array.isArray(snap.workspaces)
                ? snap.workspaces
                : []
        for (const view of views) {
          if (view === null || typeof view !== 'object') continue
          const workspaceId = view.workspaceId ?? view.id
          const cwd = view.path ?? view.cwd
          if (typeof workspaceId !== 'string' || typeof cwd !== 'string' || cwd === '') continue
          const sessionIds = Array.isArray(view.sessionIds)
            ? view.sessionIds.filter((id) => typeof id === 'string')
            : []
          joined.push({
            workspaceId,
            cwd,
            sessionId: sessionIds.length > 0 ? sessionIds[sessionIds.length - 1] : undefined,
            sessionIds,
            title: typeof view.title === 'string' ? view.title : undefined,
          })
        }
      }
    } catch {
      /* workspaces store unavailable: fall back below */
    }
    if (joined.length > 0) return joined
    try {
      const snap = ctx.sessions.list.getSnapshot()
      if (!snap) return []
      const rows = Array.isArray(snap)
        ? snap
        : snap.byId !== undefined && snap.byId !== null
          ? Object.values(snap.byId)
          : Array.isArray(snap.sessions)
            ? snap.sessions
            : []
      const seen = new Map()
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const id = row.id ?? row.sessionId
        const cwd = row.cwd
        if (typeof id !== 'string' || typeof cwd !== 'string' || cwd === '') continue
        if (!seen.has(cwd)) seen.set(cwd, { workspaceId: undefined, sessionId: id, cwd })
      }
      return [...seen.values()]
    } catch {
      return []
    }
  }

  /** Reject after `ms` so a lost RPC cannot hang the UI silently. */
  function withTimeout(promise, ms, label) {
    let timer
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)
      }),
    ]).finally(() => clearTimeout(timer))
  }

  /**
   * Tone → `--dsw-*` color token. Tones come from the pure helpers
   * (`artifactStatusTone`, `issueLevelTone`); the mapping to theme tokens is
   * presentation and lives here.
   */
  const TONE_COLOR = {
    success: 'var(--dsw-alias-state-success-primary)',
    muted: 'var(--dsw-alias-label-tertiary)',
    business: 'var(--dsw-alias-state-business-primary)',
    warn: 'var(--dsw-alias-state-warn-primary)',
    error: 'var(--dsw-alias-state-error-primary)',
    info: 'var(--dsw-alias-label-secondary)',
  }

  /** Resolve one helper tone to a theme color token. */
  function toneColor(tone) {
    return TONE_COLOR[tone] ?? TONE_COLOR.muted
  }

  /** The change the quick bar targets: the first change still being planned, else the first active one. */
  function primaryChange(state) {
    if (state === null || state === undefined || state.status !== 'ready' || !Array.isArray(state.changes) || state.changes.length === 0) return undefined
    return (
      state.changes.find((change) => change.isPlanningComplete !== true) ??
      state.changes.find((change) => change.listStatus !== 'complete') ??
      state.changes[0]
    )
  }

  /** Find the workspace row that a mounted session belongs to (quick bar). */
  function rowForSession(ctx, sessionId) {
    const rows = workspaceRows(ctx)
    const match = rows.find(
      (row) => row.sessionId === sessionId || (Array.isArray(row.sessionIds) && row.sessionIds.includes(sessionId)),
    )
    if (match !== undefined) return match
    const cwd = cwdOf(ctx, sessionId)
    if (typeof cwd !== 'string' || cwd === '') return undefined
    return { workspaceId: undefined, cwd, sessionId, sessionIds: [sessionId] }
  }

  /** Format one templated locale string (`{name}` placeholders). */
  function tx(t, key, vars) {
    let text = t(key)
    if (typeof text !== 'string') text = String(key)
    if (vars !== undefined && vars !== null) {
      for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
    }
    return text
  }

  function basenameOf(path) {
    const trimmed = String(path ?? '').replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return index === -1 ? trimmed : trimmed.slice(index + 1)
  }

  /**
   * Put one command line into the conversation draft WITHOUT sending it:
   * focus the composer editor, move the caret to the end, insert the text.
   * The user then completes the arguments and presses Enter themselves.
   */
  function insertIntoComposer(text) {
    const editor = document.querySelector('[contenteditable="true"]')
    if (editor === null) return false
    editor.focus()
    const selection = window.getSelection()
    if (selection !== null) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    const hadText = (editor.textContent ?? '').trim() !== ''
    if (hadText) document.execCommand('insertLineBreak', false, '')
    if (document.execCommand('insertText', false, text)) return true
    editor.textContent += (hadText ? '\n' : '') + text
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  /* ------------------------------------------------------------------ *
   * Panel surfaces.
   * ------------------------------------------------------------------ */

  /** Small tone badge: dot + text, used for schema sources, skip_specs, skills. */
  function ToneBadge({ tone, title, children }) {
    return h(
      'span',
      { className: 'dshspec-badge', title: title ?? undefined },
      h('span', { className: 'dshspec-badgeDot', style: { background: toneColor(tone) } }),
      children,
    )
  }

  /** Collapsible section with an optional count, header meta and action. */
  function Section({ title, count, headMeta, action, defaultOpen = false, children }) {
    const [open, setOpen] = useState(defaultOpen)
    return h(
      'section',
      { className: 'dshspec-section' },
      h(
        'div',
        { className: 'dshspec-sectionHead' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshspec-sectionToggle',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (open ? ' dshspec-chevOpen' : '') }),
          h('span', { className: 'dshspec-sectionTitle' }, title),
          count === undefined || count === null ? null : h('span', { className: 'dshspec-sectionCount' }, String(count)),
        ),
        headMeta ?? null,
        h('span', { className: 'dshspec-space' }),
        action ?? null,
      ),
      open ? h('div', { className: 'dshspec-sectionBody' }, children) : null,
    )
  }

  /** "There is more" footer — lists are never silently truncated. */
  function ListMore({ t, hidden, reveal, onMore }) {
    if (!(hidden > 0)) return null
    return h(
      'div',
      { className: 'dshspec-pageFoot' },
      h('span', null, moreItemsText(t, hidden)),
      h(
        'button',
        { type: 'button', className: 'dshspec-taskMore', onClick: onMore },
        h(Icon, { name: 'chevronDown', size: 12 }),
        tx(t, 'showMoreItems', { count: reveal }),
      ),
    )
  }

  /** Visible-count state for paged lists; grows by one page per click. */
  function useVisibleLimit(step) {
    const [limit, setLimit] = useState(step)
    const reveal = useCallback(() => setLimit((value) => value + step), [step])
    return [limit, reveal]
  }

  /** One-click init control: posts the workspace to the Host route, then refreshes. */
  function InitControl({ t, cwd, init, refresh }) {
    const [busy, setBusy] = useState(false)
    const [result, setResult] = useState(null)
    const initialize = async () => {
      setBusy(true)
      try {
        setResult(typeof init === 'function' ? await init(cwd) : { ok: false, text: t('commandFailed'), created: [] })
      } catch (error) {
        setResult({ ok: false, text: error instanceof Error ? error.message : String(error), created: [] })
      }
      if (typeof refresh === 'function') await refresh()
      setBusy(false)
    }
    const created = Array.isArray(result?.created) ? result.created : []
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' } },
      h(
        Button,
        { variant: 'primary', size: 'md', icon: 'folderPlus', disabled: busy, onClick: () => void initialize() },
        busy ? t('initBusy') : t('init'),
      ),
      result === null
        ? null
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' } },
            created.length > 0
              ? h(
                  'div',
                  { className: 'dshspec-chipRow' },
                  h('span', { className: 'dshspec-inlineTag' }, tx(t, 'initCreated', { items: '' })),
                  created.map((item) => h('span', { key: item, className: 'dshspec-fileChip' }, item)),
                )
              : null,
            result.ok === true
              ? h(Banner, { tone: 'info', wrap: true }, result.text === '' ? t('initAlready') : result.text)
              : h(Banner, { tone: 'error', wrap: true }, result.text ?? t('commandFailed')),
          ),
    )
  }

  function MissingBody({ t, init, refresh, cwd }) {
    return h(
      'div',
      { className: 'dshspec-missing' },
      h('span', { className: 'dshspec-emptyIcon' }, h(Icon, { name: 'folderPlus', size: 20 })),
      h(
        'div',
        { className: 'dshspec-missingText' },
        h('div', { className: 'dshspec-missingTitle' }, t('missing')),
        h('div', { className: 'dshspec-missingDesc' }, t('missingHint')),
        h(InitControl, { t, init, refresh, cwd }),
      ),
    )
  }

  function LoadingBody() {
    return h(
      'div',
      { className: 'dshspec-loading', 'aria-hidden': 'true' },
      h('div', { className: 'dshspec-skelLine', style: { width: '42%' } }),
      h('div', { className: 'dshspec-skelLine', style: { width: '68%' } }),
      h('div', { className: 'dshspec-skelLine', style: { width: '55%' } }),
    )
  }

  function SectionEmpty({ icon, title, hint, action }) {
    return h(
      'div',
      { className: 'dshspec-sectionEmpty' },
      h('span', { className: 'dshspec-sectionEmptyIcon' }, h(Icon, { name: icon, size: 18 })),
      h('div', { className: 'dshspec-sectionEmptyTitle' }, title),
      hint === undefined ? null : h('div', { className: 'dshspec-sectionEmptyHint' }, hint),
      action ?? null,
    )
  }

  /* ------------------------------------------------------------------ *
   * Small document renderer — a safe Markdown subset, no HTML injection.
   * ------------------------------------------------------------------ */

  function renderInline(text, keyBase) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
    const out = []
    let last = 0
    let index = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index))
      const token = match[0]
      if (token.startsWith('`')) {
        out.push(h('code', { key: `${keyBase}-c${index++}`, className: 'dshspec-mdCode' }, token.slice(1, -1)))
      } else if (token.startsWith('**')) {
        out.push(h('strong', { key: `${keyBase}-b${index++}` }, token.slice(2, -2)))
      } else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
        if (link === null) out.push(token)
        else out.push(h('a', { key: `${keyBase}-a${index++}`, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]))
      }
      last = match.index + token.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }

  function Markdown({ text }) {
    const lines = String(text ?? '').split(/\r?\n/)
    const blocks = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') {
        i += 1
        continue
      }
      if (/^\s*```/.test(line)) {
        i += 1
        const code = []
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          code.push(lines[i])
          i += 1
        }
        if (i < lines.length) i += 1
        blocks.push(h('pre', { key: `b${blocks.length}`, className: 'dshspec-mdPre' }, h('code', null, code.join('\n'))))
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading !== null) {
        const level = heading[1].length
        const keyBase = `b${blocks.length}`
        blocks.push(
          h(
            `h${Math.min(level + 1, 4)}`,
            { key: keyBase, className: `dshspec-mdH dshspec-mdH${level}` },
            renderInline(heading[2], keyBase),
          ),
        )
        i += 1
        continue
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        blocks.push(h('hr', { key: `b${blocks.length}`, className: 'dshspec-mdHr' }))
        i += 1
        continue
      }
      if (/^\s*>/.test(line)) {
        const quote = []
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''))
          i += 1
        }
        const keyBase = `b${blocks.length}`
        blocks.push(
          h(
            'blockquote',
            { key: keyBase, className: 'dshspec-mdQuote' },
            quote.map((piece, qi) => h('p', { key: qi, className: 'dshspec-mdP' }, renderInline(piece, `${keyBase}-${qi}`))),
          ),
        )
        continue
      }
      if (/^\s*\|/.test(line)) {
        const table = []
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          table.push(lines[i])
          i += 1
        }
        blocks.push(h('pre', { key: `b${blocks.length}`, className: 'dshspec-mdPre' }, h('code', null, table.join('\n'))))
        continue
      }
      const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
      if (listItem !== null) {
        const ordered = /\d/.test(listItem[2])
        const baseIndent = listItem[1].length
        const items = []
        while (i < lines.length) {
          const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
          if (item === null) break
          const indent = item[1].length
          if (indent < baseIndent) break
          const checkbox = /^\[([ xX])\]\s*(.*)$/.exec(item[3])
          const content = checkbox === null ? item[3] : checkbox[2]
          const keyBase = `b${blocks.length}-${items.length}`
          items.push(
            h(
              'li',
              { key: keyBase, className: 'dshspec-mdLi', style: indent > baseIndent ? { marginLeft: 16 } : undefined },
              checkbox === null
                ? null
                : h('span', { className: 'dshspec-mdCheck' + (checkbox[1] !== ' ' ? ' dshspec-mdCheckOn' : '') }, checkbox[1] !== ' ' ? '✓' : ''),
              renderInline(content, keyBase),
            ),
          )
          i += 1
        }
        blocks.push(h(ordered ? 'ol' : 'ul', { key: `b${blocks.length}`, className: 'dshspec-mdList' }, items))
        continue
      }
      const paragraph = []
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^\s*(```|#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s)/.test(lines[i])
      ) {
        paragraph.push(lines[i])
        i += 1
      }
      const keyBase = `b${blocks.length}`
      blocks.push(h('p', { key: keyBase, className: 'dshspec-mdP' }, renderInline(paragraph.join(' '), keyBase)))
    }
    return h('div', { className: 'dshspec-markdown' }, blocks)
  }

  /** Read-only Markdown preview modal for one openspec/ document (truncation offers a follow-up read). */
  function DocModal({ t, doc, onClose, onAlign, onReadMore }) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [moreBusy, setMoreBusy] = useState(false)
    const [moreError, setMoreError] = useState(null)
    const align = async () => {
      if (typeof onAlign !== 'function' || busy) return
      setBusy(true)
      setError(null)
      try {
        const outcome = await onAlign()
        if (outcome !== undefined && outcome !== null && outcome.ok === false) {
          setError(outcome.text ?? t('commandFailed'))
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
      setBusy(false)
    }
    const readMore = async () => {
      if (typeof onReadMore !== 'function' || moreBusy) return
      setMoreBusy(true)
      setMoreError(null)
      try {
        const outcome = await onReadMore()
        if (outcome !== undefined && outcome !== null && outcome.ok === false) setMoreError(outcome.error ?? t('docReadMoreFailed'))
      } catch (failure) {
        setMoreError(failure instanceof Error ? failure.message : String(failure))
      }
      setMoreBusy(false)
    }
    const shownLines = documentShownLines(doc.text ?? '')
    return h(
      Modal,
      {
        t,
        title: doc.title,
        description: doc.relPath ?? doc.path,
        onClose,
        width: 800,
        focusCard: true,
        headActions:
          typeof onAlign === 'function'
            ? h(
                Button,
                { variant: 'outline', size: 'sm', icon: 'arrowUpRight', disabled: busy, onClick: () => void align() },
                busy ? t('alignBusy') : t('alignDoc'),
              )
            : undefined,
      },
      error === null ? null : h(Banner, { tone: 'error', wrap: true }, error),
      h(
        'div',
        { className: 'dshspec-docViewport' },
        doc.status === 'loading'
          ? h(LoadingBody)
          : doc.status === 'error'
            ? h(Banner, { tone: 'error', wrap: true }, `${t('readDocFailed')}：${doc.error ?? ''}`)
            : doc.text.trim() === ''
              ? h('div', { className: 'dshspec-sectionEmpty' }, t('docEmpty'))
              : h(Markdown, { text: doc.text }),
        doc.status === 'ready' && doc.truncated === true
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 2px 2px' } },
              h(Banner, { tone: 'warn', wrap: true }, documentTruncationText(t, { shown: shownLines, totalLines: doc.totalLines })),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h(
                  Button,
                  { variant: 'outline', size: 'sm', icon: 'refresh', disabled: moreBusy, onClick: () => void readMore() },
                  moreBusy ? t('loading') : tx(t, 'docShowMore', { count: DOC_PAGE_LINES }),
                ),
                moreError === null ? null : h('span', { className: 'dshspec-errorText' }, moreError),
              ),
            )
          : null,
      ),
      doc.focusLine === undefined || doc.focusLine === null
        ? null
        : h('div', { className: 'dshspec-foot' }, h(Icon, { name: 'arrowUpRight', size: 12 }), h('span', null, tx(t, 'docAtLine', { line: doc.focusLine }))),
    )
  }

  /* ------------------------------------------------------------------ *
   * Native overview, artifact chips, metadata and issue lists.
   * ------------------------------------------------------------------ */

  /** Native artifact statuses in display order. */
  const ARTIFACT_STATUS_ORDER = ['done', 'skipped', 'ready', 'blocked']

  function Stat({ label, value }) {
    return h('div', { className: 'dshspec-stat' }, h('span', { className: 'dshspec-statValue' }, String(value)), h('span', { className: 'dshspec-statLabel' }, label))
  }

  /** Generic percent ring (artifact progress, never the legacy phase split). */
  function ProgressRing({ percent, label, title }) {
    const size = 72
    const stroke = 7
    const radius = (size - stroke) / 2
    const circumference = 2 * Math.PI * radius
    const ratio = Math.max(0, Math.min(1, (typeof percent === 'number' && Number.isFinite(percent) ? percent : 0) / 100))
    const color = ratio >= 1 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-business-primary)'
    return h(
      'div',
      { className: 'dshspec-ringWrap', title: title ?? label },
      h(
        'svg',
        { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
        h('circle', {
          cx: size / 2,
          cy: size / 2,
          r: radius,
          fill: 'none',
          stroke: 'var(--dsw-alias-interactive-bg-hover)',
          strokeWidth: stroke,
        }),
        ratio > 0
          ? h('circle', {
              cx: size / 2,
              cy: size / 2,
              r: radius,
              fill: 'none',
              stroke: color,
              strokeWidth: stroke,
              strokeLinecap: 'round',
              strokeDasharray: `${circumference * ratio} ${circumference}`,
              transform: `rotate(-90 ${size / 2} ${size / 2})`,
              style: { transition: 'stroke-dasharray .3s ease' },
            })
          : null,
      ),
      h(
        'div',
        { className: 'dshspec-ringText' },
        h('span', { className: 'dshspec-ringValue' }, `${Math.round(ratio * 100)}%`),
        h('span', { className: 'dshspec-ringLabel' }, label),
      ),
    )
  }

  /** Workspace overview: native artifact progress, validation counts and skills. */
  function SummaryBar({ t, state }) {
    const changes = Array.isArray(state.changes) ? state.changes : []
    const totals = { done: 0, skipped: 0, ready: 0, blocked: 0 }
    let artifactTotal = 0
    let errors = 0
    let warnings = 0
    let taskDone = 0
    let taskTotal = 0
    for (const change of changes) {
      const artifacts = Array.isArray(change.artifacts) ? change.artifacts : []
      const counts = artifactStatusCounts(artifacts)
      artifactTotal += artifacts.length
      for (const status of ARTIFACT_STATUS_ORDER) totals[status] += counts[status]
      const validation = change.validation ?? {}
      errors += Number.isFinite(validation.errors) ? validation.errors : 0
      warnings += Number.isFinite(validation.warnings) ? validation.warnings : 0
      const progress = taskProgressInfo(change.tasks)
      taskDone += progress.done
      taskTotal += progress.total
    }
    const archiveCount = typeof state.archivedCount === 'number' ? state.archivedCount : state.archived.length
    const nativeSkills = state.skills !== null && state.skills !== undefined && Array.isArray(state.skills.native) ? state.skills.native : []
    const artifactPercent = artifactTotal === 0 ? 0 : Math.round(((totals.done + totals.skipped) / artifactTotal) * 100)
    return h(
      'div',
      { className: 'dshspec-summary' },
      h(ProgressRing, {
        percent: artifactPercent,
        label: t('artifactProgress'),
        title: tx(t, 'tasksDone', { done: totals.done + totals.skipped, total: artifactTotal }),
      }),
      h(
        'div',
        { className: 'dshspec-summaryPhase' },
        h('div', { className: 'dshspec-summaryLabel' }, t('artifactProgress')),
        changes.length === 0
          ? h('div', { className: 'dshspec-note' }, t('noChanges'))
          : h(
              'div',
              { className: 'dshspec-phaseBar' },
              ARTIFACT_STATUS_ORDER.map((status) =>
                totals[status] > 0
                  ? h('span', {
                      key: status,
                      className: 'dshspec-phaseSeg',
                      style: { flexGrow: totals[status], background: toneColor(artifactStatusTone(status)) },
                      title: `${artifactStatusText(t, status)} ${totals[status]}`,
                    })
                  : null,
              ),
            ),
        h(
          'div',
          { className: 'dshspec-phaseLegend' },
          ARTIFACT_STATUS_ORDER.map((status) =>
            h(
              'span',
              { key: status, className: 'dshspec-legendItem' },
              h('span', { className: 'dshspec-badgeDot', style: { background: toneColor(artifactStatusTone(status)) } }),
              artifactStatusText(t, status),
              h('b', null, String(totals[status])),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'dshspec-summaryStats' },
        h(Stat, { label: t('statActive'), value: changes.length }),
        h(Stat, { label: t('taskList'), value: taskTotal === 0 ? '—' : `${taskDone}/${taskTotal}` }),
        h(Stat, { label: t('statSpecs'), value: state.specs.length }),
        h(Stat, { label: t('statArchived'), value: archiveCount }),
        h(Stat, { label: t('validationLabel'), value: errors + warnings }),
      ),
      h(
        'div',
        { className: 'dshspec-chipRow dshspec-summaryWide' },
        nativeSkills.length > 0
          ? h(
              ToneBadge,
              { tone: 'business', title: tx(t, 'nativeSkillsTitle', { names: nativeSkills.map((skill) => skill.name ?? skill.workflow ?? '').join(', ') }) },
              `${t('nativeSkills')} ${nativeSkills.length}`,
            )
          : null,
        state.skills !== null && state.skills !== undefined && state.skills.fallbackActive === true
          ? h(ToneBadge, { tone: 'muted', title: t('fallbackSkillsTitle') }, t('fallbackSkills'))
          : null,
      ),
    )
  }

  /** Document buttons for a change / capability / archive detail. */
  function DocGrid({ t, docs, openDoc, emptyText }) {
    const list = Array.isArray(docs) ? docs : []
    if (list.length === 0) return h('div', { className: 'dshspec-note' }, emptyText ?? t('noDocs'))
    return h(
      'div',
      { className: 'dshspec-docGrid' },
      list.map((doc) => {
        const path = typeof doc.path === 'string' ? doc.path : ''
        const basename = basenameOf(path) || String(doc.label ?? '')
        const label = doc.kind === 'delta' && typeof doc.label === 'string' && doc.label !== '' ? doc.label : basename
        return h(
          'button',
          {
            key: path === '' ? label : path,
            type: 'button',
            className: 'dshspec-docBtn',
            title: path,
            onClick: () => openDoc(doc),
          },
          h(Icon, { name: 'file', size: 14 }),
          h('span', null, label),
          doc.artifactId !== undefined && doc.artifactId !== null
            ? h('span', { className: 'dshspec-inlineTag' }, tx(t, 'artifactSource', { id: artifactLabel(doc.artifactId) }))
            : null,
          doc.kind === 'delta' ? h('span', { className: 'dshspec-docKind' }, 'delta') : null,
        )
      }),
    )
  }

  /** One label/value row (`.openspec.yaml` metadata, config facts). */
  function KvRow({ label, value }) {
    return h(
      'div',
      { className: 'dshspec-kv' },
      h('span', { className: 'dshspec-kvLabel' }, label),
      h('span', { className: 'dshspec-kvValue' }, value === undefined || value === null ? '—' : String(value)),
    )
  }

  /** `.openspec.yaml` metadata rows from the Host `ChangeState.metadata`. */
  function MetadataRows({ t, metadata }) {
    const value = metadata !== null && metadata !== undefined ? metadata : {}
    if (value.found !== true) return h('div', { className: 'dshspec-note' }, t('metaMissing'))
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h(KvRow, { label: t('metaSchema'), value: value.schema ?? t('metaNone') }),
      h(KvRow, { label: t('metaCreated'), value: value.created ?? t('metaNone') }),
      value.goal !== undefined && value.goal !== null && value.goal !== '' ? h(KvRow, { label: t('metaGoal'), value: value.goal }) : null,
      value.skip_specs === true ? h(KvRow, { label: t('metaSkip'), value: t('artifactSkipped') }) : null,
      value.retire_capabilities === true ? h(KvRow, { label: t('metaRetire'), value: t('artifactDone') }) : null,
    )
  }

  /** Validation issues with level, path and line; clicking opens the document. */
  function IssueList({ t, issues, onIssue }) {
    const list = Array.isArray(issues) ? issues : []
    const [limit, reveal] = useVisibleLimit(ISSUE_PAGE_SIZE)
    if (list.length === 0) return h('div', { className: 'dshspec-note' }, t('noIssues'))
    const page = paginate(list, { pageSize: limit })
    return h(
      'div',
      { className: 'dshspec-issueList' },
      page.items.map((issue, index) => {
        const level = typeof issue?.level === 'string' ? issue.level : 'INFO'
        const location = validationIssueLocation(issue)
        return h(
          'div',
          {
            key: `${location}#${index}`,
            className: 'dshspec-issue',
            'data-tone': issueLevelTone(level),
            role: 'button',
            tabIndex: 0,
            title: location === '' ? t('viewDoc') : `${t('viewDoc')} · ${location}`,
            onClick: () => onIssue(issue),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onIssue(issue)
              }
            },
          },
          h('span', { className: 'dshspec-issueLevel' }, level),
          location === '' ? null : h('span', { className: 'dshspec-issuePath' }, location),
          h('span', { className: 'dshspec-issueMsg' }, issue?.message ?? ''),
        )
      }),
      h(ListMore, { t, hidden: page.hidden, reveal: Math.min(page.pageSize, page.hidden), onMore: reveal }),
    )
  }

  /** Tone of a change's overall native state (progress colors / status dot). */
  function changeTone(change) {
    if (change === null || change === undefined) return 'muted'
    const validation = change.validation ?? {}
    if (Number.isFinite(validation.errors) && validation.errors > 0) return 'error'
    if (blockedArtifacts(change.artifacts).length > 0) return 'warn'
    if (change.isPlanningComplete !== true) return 'business'
    if (change.listStatus === 'complete') return 'success'
    return 'warn'
  }

  /** Icon for the derived native next action. */
  function nextActionIcon(kind) {
    if (kind === 'propose') return 'filePlus'
    if (kind === 'update') return 'activity'
    if (kind === 'archive') return 'archive'
    return 'play'
  }

  /** One-line Purpose summary for the capability list; the full text stays in the title attribute. */
  function purposeSummary(spec) {
    const raw = String(spec?.purpose ?? '').replace(/\s+/g, ' ').trim()
    if (raw === '') return ''
    return raw.length > 140 ? `${raw.slice(0, 139)}…` : raw
  }

  /** Per-artifact native status chips; a blocked chip expands its `missingDeps`. */
  function ArtifactChips({ t, change }) {
    const artifacts = sortArtifacts(change.artifacts)
    const [depsFor, setDepsFor] = useState(null)
    if (artifacts.length === 0) return h('div', { className: 'dshspec-note' }, t('docsFromSchema'))
    const selected = artifacts.find((artifact) => String(artifact.id) === depsFor)
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
      h(
        'div',
        { className: 'dshspec-chipRow' },
        artifacts.map((artifact) => {
          const status = typeof artifact.status === 'string' ? artifact.status : 'blocked'
          const blocked = status === 'blocked'
          const deps = Array.isArray(artifact.missingDeps) ? artifact.missingDeps : []
          const depsText = deps.length === 0 ? '—' : deps.map((dep) => artifactLabel(dep)).join('、')
          const common = {
            key: artifact.id,
            className: 'dshspec-artChip',
            'data-status': status,
            title: blocked
              ? tx(t, 'missingDeps', { deps: depsText })
              : `${artifactLabel(artifact.id)} · ${artifactStatusText(t, status)}`,
          }
          const content = [
            h('span', { key: 'dot', className: 'dshspec-artChipDot', style: { background: toneColor(artifactStatusTone(status)) } }),
            h('span', { key: 'label' }, artifactLabel(artifact.id)),
            h('span', { key: 'state', className: 'dshspec-artChipState' }, artifactStatusText(t, status)),
          ]
          return blocked
            ? h(
                'button',
                {
                  ...common,
                  type: 'button',
                  'aria-expanded': depsFor === artifact.id,
                  onClick: () => setDepsFor((current) => (current === artifact.id ? null : artifact.id)),
                },
                content,
              )
            : h('span', common, content)
        }),
      ),
      selected === undefined
        ? null
        : h(
            'div',
            { className: 'dshspec-depsRow' },
            h('b', null, `${artifactLabel(selected.id)} · ${t('artifactBlocked')}`),
            h(
              'span',
              null,
              tx(t, 'missingDeps', {
                deps: (Array.isArray(selected.missingDeps) ? selected.missingDeps : []).map((dep) => artifactLabel(dep)).join('、') || '—',
              }),
            ),
          ),
    )
  }

  /**
   * One collapsible change card: native artifact chips are always visible, the
   * body adds schema-derived docs, `.openspec.yaml` metadata, delta counts,
   * validation issues and the native next step.
   */
  function ChangeCard({ t, change, open, onToggle, commands, openDoc, onIssue, onValidate, onSyncPreview }) {
    const action = deriveNextAction(change)
    const progress = taskProgressInfo(change.tasks)
    const blocked = blockedArtifacts(change.artifacts)
    const validation = change.validation ?? {}
    const deltaText = deltaSummaryText(t, change.delta)
    const toggle = () => onToggle()
    return h(
      'div',
      { className: 'dshspec-item', 'data-dshspec-change': change.name },
      h(
        'div',
        {
          className: 'dshspec-itemHead',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          onClick: toggle,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggle()
            }
          },
        },
        h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (open ? ' dshspec-chevOpen' : '') }),
        h('span', { className: 'dshspec-changeName', title: change.name }, change.name),
        change.schemaName === ''
          ? null
          : h(ToneBadge, { tone: 'muted', title: tx(t, 'changeSchema', { name: change.schemaName }) }, change.schemaName),
        h(ToneBadge, { tone: change.isPlanningComplete ? 'success' : 'business' }, t(change.isPlanningComplete ? 'plannerComplete' : 'planning')),
        change.metadata.skip_specs === true ? h(ToneBadge, { tone: 'muted', title: t('skipSpecs') }, t('skipSpecs')) : null,
        blocked.length > 0
          ? h(ToneBadge, { tone: 'warn', title: t('changesBlockedHint') }, tx(t, 'blockedCount', { count: blocked.length }))
          : null,
        progress.total > 0
          ? h(
              'div',
              { className: 'dshspec-changeProgress' },
              h(Progress, { done: progress.done, total: progress.total, color: toneColor(changeTone(change)) }),
            )
          : null,
        h('span', { className: 'dshspec-space' }),
        h(
          'div',
          { className: 'dshspec-changeButtons' },
          h(
            Button,
            {
              variant: 'primary',
              size: 'md',
              icon: nextActionIcon(action.kind),
              title: change.nextSteps.length > 0 ? `${t('quickNext')} · ${change.nextSteps.join(' · ')}` : nextActionText(t, action),
              onClick: (event) => {
                event.stopPropagation()
                if (action.kind === 'propose') commands.open('propose')
                else commands.execute(action.line)
              },
            },
            nextActionText(t, action),
          ),
        ),
      ),
      h('div', { className: 'dshspec-itemChips' }, h(ArtifactChips, { t, change })),
      open
        ? h(
            'div',
            { className: 'dshspec-itemBody' },
            h('div', { className: 'dshspec-subHead' }, h('b', null, t('metadataLabel')), h('span', null, t('effectiveSchema') + ' · ' + (change.schemaName || '—'))),
            h(MetadataRows, { t, metadata: change.metadata }),
            h('div', { className: 'dshspec-subHead' }, h('b', null, t('docs')), h('span', null, t('docsFromSchema'))),
            h(DocGrid, { t, docs: change.docs, openDoc }),
            h(
              'div',
              { className: 'dshspec-subHead' },
              h('b', null, t('deltaSection')),
              h('span', null, deltaText === '' ? t('deltaEmpty') : deltaText),
            ),
            deltaText === '' ? null : h(DocGrid, { t, docs: change.docs.filter((doc) => doc.kind === 'delta'), openDoc }),
            h(
              'div',
              { className: 'dshspec-subHead' },
              h('b', null, t('issuesList')),
              h('span', null, validationSummaryText(t, validation)),
            ),
            h(IssueList, { t, issues: validation.issues, onIssue }),
            h('div', { className: 'dshspec-subHead' }, h('b', null, t('nextSteps'))),
            change.nextSteps.length === 0
              ? h('div', { className: 'dshspec-note' }, t('noNextSteps'))
              : h(
                  'ul',
                  { className: 'dshspec-taskList' },
                  change.nextSteps.map((step, index) =>
                    h(
                      'li',
                      { key: index, className: 'dshspec-task' },
                      h(Icon, { name: 'chevronRight', size: 12 }),
                      h('span', null, step),
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'dshspec-chipRow' },
              h(Button, { variant: 'outline', size: 'sm', icon: 'check', onClick: () => onValidate(change) }, t('validateAction')),
              h(Button, { variant: 'outline', size: 'sm', icon: 'refresh', onClick: () => onSyncPreview(change) }, t('syncPreviewAction')),
            ),
          )
        : null,
    )
  }

  /** Capability specs with native counts, validation and nested-path grouping. */
  function CapabilitySection({ t, specs, openDoc, onIssues }) {
    const list = Array.isArray(specs) ? specs : []
    const [limit, reveal] = useVisibleLimit(SPEC_PAGE_SIZE)
    if (list.length === 0) {
      return h(SectionEmpty, { icon: 'layers', title: t('noCapabilities'), hint: t('noCapabilitiesHint') })
    }
    const rows = groupSpecsByPath(list)
    const page = paginate(rows, { pageSize: limit })
    const openSpec = (spec) => {
      if (spec === null || spec === undefined || typeof spec.path !== 'string' || spec.path === '') return
      openDoc({ path: spec.path, label: basenameOf(spec.path) || `${spec.name}/spec.md`, artifactId: 'specs' })
    }
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column' } },
      page.items.map((row, index) =>
        row.kind === 'group'
          ? h(
              'div',
              { key: `group-${row.fullName}`, className: 'dshspec-nestedGroup', style: { paddingLeft: 14 + row.depth * 18 } },
              h(Icon, { name: 'layers', size: 13 }),
              h('span', null, row.label),
            )
          : h(
              'div',
              {
                key: `spec-${row.fullName}-${index}`,
                className: 'dshspec-nested',
                style: { paddingLeft: 14 + row.depth * 18 },
                title: row.fullName,
                role: 'button',
                tabIndex: 0,
                onClick: () => openSpec(row.spec),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openSpec(row.spec)
                  }
                },
              },
              h(Icon, { name: 'file', size: 14 }),
              h(
                'span',
                { className: 'dshspec-treeText' },
                h('span', { className: 'dshspec-nestedName' }, row.label),
                h('span', { className: 'dshspec-nestedMeta', title: String(row.spec.purpose ?? '') }, purposeSummary(row.spec) || t('capabilityPurpose')),
              ),
              h(
                'span',
                { className: 'dshspec-nestedEnd' },
                h('span', { className: 'dshspec-legendItem' }, tx(t, 'requirementCount', { count: row.spec.requirementCount ?? 0 })),
                h('span', { className: 'dshspec-legendItem' }, tx(t, 'scenarioCount', { count: row.spec.scenarioCount ?? 0 })),
                totalIssues(row.spec.validation) > 0 && typeof onIssues === 'function'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshspec-taskMore',
                        title: validationSummaryText(t, row.spec.validation),
                        onClick: (event) => {
                          event.stopPropagation()
                          onIssues(row.spec)
                        },
                      },
                      h(Icon, { name: 'alert', size: 12 }),
                      tx(t, 'specIssues', { count: totalIssues(row.spec.validation) }),
                    )
                  : null,
                h(Icon, { name: 'chevronRight', size: 14 }),
              ),
            ),
      ),
      h(ListMore, { t, hidden: page.hidden, reveal: Math.min(page.pageSize, page.hidden), onMore: reveal }),
    )
  }

  /** Total error/warning count of one validation summary. */
  function totalIssues(validation) {
    const errors = Number.isFinite(validation?.errors) ? validation.errors : 0
    const warnings = Number.isFinite(validation?.warnings) ? validation.warnings : 0
    return errors + warnings
  }

  /** Archive rows grouped by local date; each change's artifacts/tasks/metadata load on demand. */
  function ArchiveSection({ t, source, archived, openDoc }) {
    const [open, setOpen] = useState(false)
    const [expanded, setExpanded] = useState({})
    const [details, setDetails] = useState({})
    const [limit, reveal] = useVisibleLimit(ARCHIVE_PAGE_SIZE)
    const groups = groupArchivedByLocalDate(archived)

    const visibleGroups = []
    let remaining = limit
    let hidden = 0
    for (const group of groups) {
      if (remaining <= 0) {
        hidden += group.entries.length
        continue
      }
      const entries = group.entries.slice(0, remaining)
      hidden += group.entries.length - entries.length
      remaining -= entries.length
      if (entries.length > 0) visibleGroups.push({ date: group.date, entries })
    }

    const keyOf = (entry) => String(entry?.path ?? entry?.name ?? '')
    const load = useCallback(
      (entry) => {
        const key = keyOf(entry)
        if (source === undefined) {
          setDetails((prev) => ({ ...prev, [key]: { status: 'error', error: t('archiveLoadFailed') } }))
          return
        }
        setDetails((prev) => (prev[key] === undefined ? { ...prev, [key]: { status: 'loading' } } : prev))
        void source
          .loadArchive(entry)
          .then((result) => {
            setDetails((prev) => ({
              ...prev,
              [key]:
                result !== null && result !== undefined && result.ok === true
                  ? { status: 'ready', change: result.change, fallback: result.fallback === true }
                  : { status: 'error', error: result?.error ?? t('archiveLoadFailed') },
            }))
          })
          .catch((error) => {
            setDetails((prev) => ({ ...prev, [key]: { status: 'error', error: error instanceof Error ? error.message : String(error) } }))
          })
      },
      [source, t],
    )

    const toggle = (entry) => {
      const key = keyOf(entry)
      const willOpen = expanded[key] !== true
      setExpanded((prev) => ({ ...prev, [key]: willOpen }))
      if (willOpen && details[key] === undefined) load(entry)
    }

    const renderDetail = (detail, entry) => {
      if (detail === undefined || detail.status === 'loading') {
        return h('div', { className: 'dshspec-inlineLoad' }, h(Icon, { name: 'refresh', size: 14, className: 'dshspec-spin' }), h('span', null, t('archiveDetailLoading')))
      }
      if (detail.status === 'error') return h(Banner, { tone: 'error', wrap: true }, detail.error ?? t('archiveLoadFailed'))
      const change = detail.change
      if (change === null || change === undefined) return h(Banner, { tone: 'error', wrap: true }, t('archiveLoadFailed'))
      const deltaText = deltaSummaryText(t, change.delta)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('archiveMetadata')), h('span', null, change.schemaName ?? '')),
        h(MetadataRows, { t, metadata: change.metadata }),
        typeof change.metadataText === 'string' && change.metadataText !== ''
          ? h('pre', { className: 'dshspec-pre dshspec-prePlain' }, change.metadataText)
          : null,
        detail.fallback === true ? h('div', { className: 'dshspec-note' }, t('archiveProbeNote')) : null,
        change.tasks !== null && change.tasks !== undefined
          ? h(
              'div',
              { className: 'dshspec-summaryLine' },
              h('span', { className: 'dshspec-inlineTag' }, t('archiveTasks')),
              h('span', { className: 'dshspec-strongMeta' }, tx(t, 'tasksDone', { done: taskProgressInfo(change.tasks).done, total: taskProgressInfo(change.tasks).total })),
              taskProgressInfo(change.tasks).total > 0
                ? h(
                    'div',
                    { className: 'dshspec-changeProgress' },
                    h(Progress, {
                      done: taskProgressInfo(change.tasks).done,
                      total: taskProgressInfo(change.tasks).total,
                      color: toneColor('success'),
                    }),
                  )
                : null,
            )
          : null,
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('archiveArtifacts'))),
        h(DocGrid, { t, docs: change.docs, openDoc }),
        deltaText === '' ? null : h('div', { className: 'dshspec-subHead' }, h('b', null, t('deltaSection')), h('span', null, deltaText)),
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('issuesList')), h('span', null, validationSummaryText(t, change.validation))),
        totalIssues(change.validation) > 0
          ? h(IssueList, {
              t,
              issues: change.validation.issues,
              onIssue: (issue) => {
                if (typeof issue?.path !== 'string' || issue.path === '') return
                const base = typeof entry?.path === 'string' ? entry.path : ''
                const relative = issue.path.startsWith('openspec/') || issue.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(issue.path)
                const path = relative || base === '' ? issue.path : `${base}/${issue.path}`
                openDoc({ path, label: basenameOf(path) }, issue.line)
              },
            })
          : null,
      )
    }

    return h(
      Section,
      {
        title: t('archiveSectionTitle'),
        count: archived.length,
        headMeta: h('span', { className: 'dshspec-note' }, t('archivedHint')),
        defaultOpen: false,
      },
      archived.length === 0
        ? h(SectionEmpty, { icon: 'archive', title: t('noArchived') })
        : visibleGroups.map((group) =>
            h(
              'div',
              { key: group.date ?? 'unknown', className: 'dshspec-archGroup' },
              h(
                'div',
                { className: 'dshspec-archHead' },
                h(Icon, { name: 'archive', size: 13 }),
                h('span', null, group.date === null ? t('archiveUnknownDate') : group.date),
                h('span', { className: 'dshspec-sectionCount' }, String(group.entries.length)),
              ),
              group.entries.map((entry) => {
                const key = keyOf(entry)
                const isOpen = expanded[key] === true
                const detail = details[key]
                const label = archiveEntryLabel(entry)
                return h(
                  'div',
                  { key, className: 'dshspec-item' },
                  h(
                    'div',
                    {
                      className: 'dshspec-itemHead',
                      role: 'button',
                      tabIndex: 0,
                      'aria-expanded': isOpen,
                      onClick: () => toggle(entry),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          toggle(entry)
                        }
                      },
                    },
                    h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (isOpen ? ' dshspec-chevOpen' : '') }),
                    h('span', { className: 'dshspec-changeName', title: entry.path ?? entry.name }, label),
                    detail !== undefined && detail.status === 'ready' && detail.change?.tasks !== null
                      ? h(
                          'div',
                          { className: 'dshspec-changeProgress' },
                          h(Progress, {
                            done: taskProgressInfo(detail.change.tasks).done,
                            total: taskProgressInfo(detail.change.tasks).total,
                            color: toneColor('success'),
                          }),
                        )
                      : null,
                    h('span', { className: 'dshspec-space' }),
                    h(Icon, { name: 'archive', size: 14, className: 'dshspec-decoIcon' }),
                  ),
                  isOpen ? h('div', { className: 'dshspec-itemBody' }, renderDetail(detail, entry)) : null,
                )
              }),
            ),
          ),
      h(ListMore, { t, hidden, reveal: Math.min(limit, hidden), onMore: reveal }),
    )
  }

  /** Project configuration (`openspec/config.yaml`) and available schemas. */
  function ProjectSection({ t, state }) {
    const config = state.config !== null && state.config !== undefined ? state.config : {}
    const schemas = Array.isArray(state.schemas) ? state.schemas : []
    const rules = config.rules !== null && typeof config.rules === 'object' ? config.rules : {}
    const ruleArtifacts = Object.keys(rules)
    const rulesCount = ruleArtifacts.reduce((sum, id) => sum + (Array.isArray(rules[id]) ? rules[id].length : 0), 0)
    const contextText = typeof config.context === 'string' ? config.context.trim() : ''
    const contextSummary = contextText.length > 240 ? `${contextText.slice(0, 239)}…` : contextText
    const operations = config.operations !== null && typeof config.operations === 'object' ? config.operations : {}
    const applyGuidance = typeof operations.apply?.guidance === 'string' ? operations.apply.guidance : ''
    const archiveGuidance = typeof operations.archive?.guidance === 'string' ? operations.archive.guidance : ''
    const [contextOpen, setContextOpen] = useState(false)
    const [rulesOpen, setRulesOpen] = useState({})
    return h(
      Section,
      {
        title: t('configSection'),
        count: rulesCount,
        headMeta: h('span', { className: 'dshspec-note' }, `${t('effectiveSchema')} · ${config.schema ?? '—'}`),
        defaultOpen: false,
      },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px' } },
        config.found !== true ? h('div', { className: 'dshspec-note' }, tx(t, 'configMissing', { schema: config.schema ?? 'spec-driven' })) : null,
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(KvRow, { label: t('effectiveSchema'), value: config.schema ?? '—' }),
          config.found === true ? h(KvRow, { label: 'config', value: config.file ?? 'openspec/config.yaml' }) : null,
        ),
        h(
          'div',
          { className: 'dshspec-subHead' },
          h('b', null, t('contextLabel')),
          contextText === '' ? h('span', null, t('contextEmpty')) : h('span', null, `${contextText.length} chars`),
        ),
        contextText === ''
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: 'dshspec-contextBox' }, contextOpen ? contextText : contextSummary),
              contextText.length > 240
                ? h(
                    'button',
                    { type: 'button', className: 'dshspec-taskMore', onClick: () => setContextOpen((value) => !value) },
                    h(Icon, { name: contextOpen ? 'chevronRight' : 'chevronDown', size: 12 }),
                    contextOpen ? t('contextHide') : t('contextShow'),
                  )
                : null,
            ),
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('rulesLabel')), h('span', null, tx(t, 'rulesCount', { count: rulesCount }))),
        ruleArtifacts.length === 0
          ? h('div', { className: 'dshspec-note' }, t('rulesEmpty'))
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              ruleArtifacts.map((id) => {
                const items = Array.isArray(rules[id]) ? rules[id] : []
                const opened = rulesOpen[id] === true
                return h(
                  'div',
                  { key: id, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  h(
                    'button',
                    { type: 'button', className: 'dshspec-taskMore', onClick: () => setRulesOpen((prev) => ({ ...prev, [id]: !prev[id] })) },
                    h(Icon, { name: opened ? 'chevronDown' : 'chevronRight', size: 12 }),
                    `${artifactLabel(id)} · ${tx(t, 'rulesCount', { count: items.length })}`,
                  ),
                  opened
                    ? h(
                        'ul',
                        { className: 'dshspec-taskList' },
                        items.map((rule, index) =>
                          h('li', { key: index, className: 'dshspec-task' }, h(Icon, { name: 'chevronRight', size: 10 }), h('span', null, rule)),
                        ),
                      )
                    : null,
                )
              }),
            ),
        applyGuidance === '' && archiveGuidance === ''
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { className: 'dshspec-subHead' }, h('b', null, t('operationsLabel'))),
              applyGuidance === '' ? null : h(KvRow, { label: t('operationApply'), value: applyGuidance }),
              archiveGuidance === '' ? null : h(KvRow, { label: t('operationArchive'), value: archiveGuidance }),
            ),
        Array.isArray(config.warnings) && config.warnings.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              config.warnings.map((warning, index) => h(Banner, { key: index, tone: 'warn', wrap: true }, warning)),
            )
          : null,
        h('div', { className: 'dshspec-subHead' }, h('b', null, t('schemasSection')), h('span', null, String(schemas.length))),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          schemas.map((schema) =>
            h(
              'div',
              { key: `${schema.source}-${schema.name}`, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h(
                'div',
                { className: 'dshspec-summaryLine' },
                h('span', { className: 'dshspec-strongMeta' }, h('b', null, schema.name)),
                h(ToneBadge, { tone: schema.source === 'project' ? 'business' : 'muted' }, schemaSourceText(t, schema.source)),
                typeof schema.description === 'string' && schema.description !== ''
                  ? h('span', { className: 'dshspec-note', title: schema.description }, schema.description.length > 120 ? `${schema.description.slice(0, 119)}…` : schema.description)
                  : null,
              ),
              h(
                'div',
                { className: 'dshspec-note' },
                tx(t, 'schemaArtifacts', {
                  items: (Array.isArray(schema.artifacts) ? schema.artifacts : []).map((id) => artifactLabel(id)).join('、') || '—',
                }),
              ),
            ),
          ),
        ),
      ),
    )
  }

  /** The selected workspace: native overview, changes, project config, capabilities and archive. */
  function WorkspaceDetail({ t, row, source, compose, align, init, onRefresh }) {
    const stateSource = source !== undefined ? source.hooks.state : undefined
    const state = useSyncExternalStore(
      stateSource !== undefined ? stateSource.subscribe : () => () => {},
      stateSource !== undefined ? stateSource.getSnapshot : () => ({ status: 'loading', cwd: row.cwd }),
    )
    const [expanded, setExpanded] = useState({})
    const [doc, setDoc] = useState(null)
    const [notice, setNotice] = useState(null)
    const [modal, setModal] = useState(null)
    const [changeLimit, revealChanges] = useVisibleLimit(CHANGE_PAGE_SIZE)
    const noticeTimer = useRef(null)

    useEffect(
      () => () => {
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
      },
      [],
    )

    const report = useCallback(
      (outcome, line) => {
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        const failed = outcome !== undefined && outcome !== null && outcome.ok === false
        setNotice({
          tone: failed ? 'error' : 'info',
          icon: failed ? 'alert' : 'check',
          text: failed ? outcome?.text ?? t('commandFailed') : `${t('fillComposer')} · ${line ?? ''}`,
        })
        noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
      },
      [t],
    )

    const commands = useCommands({
      t,
      insert: typeof compose === 'function' ? (line) => compose(row)(line) : undefined,
      onResult: report,
    })

    const openDoc = useCallback(
      (item, focusLine) => {
        const rawPath = typeof item?.path === 'string' ? item.path : ''
        if (rawPath === '') return
        const base = {
          title: item.label ?? basenameOf(rawPath),
          path: rawPath,
          relPath: relPathOf(row.cwd, rawPath),
          status: 'loading',
          text: '',
          truncated: false,
          totalLines: null,
          offset: 1,
          focusLine: typeof focusLine === 'number' && Number.isFinite(focusLine) ? focusLine : null,
        }
        setDoc(base)
        if (source === undefined) {
          setDoc({ ...base, status: 'error', error: t('commandFailed') })
          return
        }
        void source.readDocument(rawPath, { offset: 1, limit: DOC_PAGE_LINES }).then((page) => {
          setDoc((prev) => {
            if (prev === null || prev.path !== rawPath) return prev
            return page.ok
              ? { ...prev, status: 'ready', text: page.text, truncated: page.truncated === true, totalLines: page.totalLines, offset: page.offset }
              : { ...prev, status: 'error', error: page.error ?? '' }
          })
        })
      },
      [row.cwd, source, t],
    )

    const openIssue = useCallback(
      (issue, change) => {
        if (typeof issue?.path !== 'string' || issue.path === '') return
        let path = issue.path
        const workspaceRelative = path.startsWith('openspec/') || path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
        if (!workspaceRelative && change !== undefined && typeof change.name === 'string' && change.name !== '') {
          path = `openspec/changes/${change.name}/${path}`
        }
        openDoc({ path, label: basenameOf(path) }, issue.line)
      },
      [openDoc],
    )

    const readMoreDoc = useCallback(async () => {
      if (doc === null || source === undefined) return { ok: false, error: t('docReadMoreFailed') }
      const shown = documentShownLines(doc.text)
      const page = await source.readDocument(doc.path, { offset: (doc.offset ?? 1) + shown, limit: DOC_PAGE_LINES })
      if (!page.ok) return { ok: false, error: page.error ?? t('docReadMoreFailed') }
      setDoc((prev) =>
        prev !== null && prev.path === doc.path
          ? {
              ...prev,
              text: `${prev.text}\n${page.text}`,
              truncated: page.truncated === true,
              totalLines: page.totalLines ?? prev.totalLines,
            }
          : prev,
      )
      return { ok: true }
    }, [doc, source, t])

    const openValidation = useCallback(
      (change) => {
        setModal({ kind: 'validate', status: 'loading', name: change.name })
        if (source === undefined) {
          setModal({ kind: 'validate', status: 'error', name: change.name, error: t('validateFailed') })
          return
        }
        void source.validateChange(change.name).then((result) => {
          setModal((prev) =>
            prev !== null && prev.kind === 'validate' && prev.name === change.name
              ? result.ok === true
                ? { kind: 'validate', status: 'ready', name: change.name, validation: result.validation }
                : { kind: 'validate', status: 'error', name: change.name, error: result.error ?? t('validateFailed') }
              : prev,
          )
        })
      },
      [source, t],
    )

    const openSpecIssues = useCallback((spec) => {
      if (spec === null || spec === undefined) return
      setModal({ kind: 'spec-issues', status: 'ready', name: spec.name, validation: spec.validation })
    }, [])

    const openSyncPreview = useCallback(
      (change) => {
        setModal({ kind: 'sync', status: 'loading', name: change.name })
        if (source === undefined) {
          setModal({ kind: 'sync', status: 'error', name: change.name, error: t('syncPreviewFailed') })
          return
        }
        void source.syncPreview(change.name).then((result) => {
          setModal((prev) =>
            prev !== null && prev.kind === 'sync' && prev.name === change.name
              ? result.ok === true
                ? { kind: 'sync', status: 'ready', name: change.name, text: result.text }
                : { kind: 'sync', status: 'error', name: change.name, error: result.error ?? t('syncPreviewFailed') }
              : prev,
          )
        })
      },
      [source, t],
    )

    const reload = useCallback(async () => {
      if (source === undefined) {
        if (typeof onRefresh === 'function') await onRefresh()
        return
      }
      await source.refresh()
    }, [source, onRefresh])

    const toggleChange = (name) => setExpanded((prev) => ({ ...prev, [name]: !prev[name] }))

    const changes = state.status === 'ready' ? state.changes : []
    const specs = state.status === 'ready' ? state.specs : []
    const archived = state.status === 'ready' ? state.archived : []
    const changePage = paginate(changes, { pageSize: changeLimit })
    const warnings = Array.isArray(state.warnings) ? state.warnings : []

    const validationModal =
      modal !== null && modal.kind === 'validate'
        ? h(
            Modal,
            {
              t,
              title: t('validateTitle'),
              description: `${modal.name ?? ''} · ${t('validateDesc')}`,
              onClose: () => setModal(null),
              width: 680,
              focusCard: true,
            },
            modal.status === 'loading'
              ? h(LoadingBody)
              : modal.status === 'error'
                ? h(Banner, { tone: 'error', wrap: true }, modal.error ?? t('validateFailed'))
                : h(
                    'div',
                    { className: 'dshspec-modalBody' },
                    h(Banner, { tone: totalIssues(modal.validation) > 0 ? 'warn' : 'info', wrap: true }, validationSummaryText(t, modal.validation)),
                    h(IssueList, {
                      t,
                      issues: modal.validation?.issues,
                      onIssue: (issue) => {
                        openIssue(issue, { name: modal.name })
                        setModal(null)
                      },
                    }),
                  ),
          )
        : null

    const syncModal =
      modal !== null && modal.kind === 'sync'
        ? h(
            Modal,
            {
              t,
              title: t('syncPreviewTitle'),
              description: `${modal.name ?? ''} · ${t('syncPreviewDesc')}`,
              onClose: () => setModal(null),
              width: 760,
              focusCard: true,
            },
            modal.status === 'loading'
              ? h(LoadingBody)
              : modal.status === 'error'
                ? h(Banner, { tone: 'error', wrap: true }, modal.error ?? t('syncPreviewFailed'))
                : modal.text === ''
                  ? h('div', { className: 'dshspec-note' }, t('syncPreviewDesc'))
                  : h(Markdown, { text: modal.text }),
          )
        : null

    const specIssuesModal =
      modal !== null && modal.kind === 'spec-issues'
        ? h(
            Modal,
            {
              t,
              title: t('validateTitle'),
              description: `${modal.name ?? ''} · ${validationSummaryText(t, modal.validation)}`,
              onClose: () => setModal(null),
              width: 680,
              focusCard: true,
            },
            h(IssueList, {
              t,
              issues: modal.validation?.issues,
              onIssue: (issue) => {
                openIssue(issue)
                setModal(null)
              },
            }),
          )
        : null

    return h(
      'section',
      { className: 'dshspec-detail', 'data-dshspec-workspace': row.cwd },
      h(
        'div',
        { className: 'dshspec-detailBar' },
        h(Icon, { name: 'folder', size: 15, className: 'dshspec-detailBarIcon' }),
        h('span', { className: 'dshspec-detailBarPath', title: row.cwd }, row.cwd),
        h(
          'div',
          { className: 'dshspec-detailActions' },
          h(Button, { variant: 'ghost', size: 'md', icon: 'compass', title: '/opsx-explore [主题]', onClick: () => commands.open('explore') }, t('explore')),
          h(Button, { variant: 'outline', size: 'md', icon: 'filePlus', title: '/opsx-propose <change-name> [说明]', onClick: () => commands.open('propose') }, t('propose')),
          h(Button, { variant: 'ghost', size: 'md', icon: 'activity', title: '/opsx-status', onClick: () => commands.execute('/opsx-status') }, t('status')),
        ),
      ),
      notice === null ? null : h(Banner, { tone: notice.tone, icon: notice.icon, wrap: notice.tone === 'error' }, notice.text),
      state.status === 'loading' ? h(LoadingBody) : null,
      state.status === 'error'
        ? h(
            'div',
            { className: 'dshspec-card' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h(Banner, { tone: 'error', wrap: true }, `${t('error')}：${state.error ?? ''}`),
              h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void reload() }, t('retry')),
            ),
          )
        : null,
      state.status === 'missing' ? h('div', { className: 'dshspec-card' }, h(MissingBody, { t, init, refresh: () => void reload(), cwd: row.cwd })) : null,
      state.status === 'ready'
        ? [
            h(SummaryBar, { key: 'summary', t, state }),
            state.backgroundError === undefined || state.backgroundError === null
              ? null
              : h(Banner, { key: 'background', tone: 'warn', wrap: true }, `${t('error')}：${state.backgroundError}`),
            h(ProjectSection, { key: 'config', t, state }),
            h(
              'section',
              { key: 'changes', className: 'dshspec-section' },
              h(
                'div',
                { className: 'dshspec-sectionHead' },
                h('span', { className: 'dshspec-sectionTitle' }, t('activeChanges')),
                h('span', { className: 'dshspec-sectionCount' }, String(changes.length)),
                h('span', { className: 'dshspec-space' }),
                h(Button, { variant: 'primary', size: 'sm', icon: 'filePlus', onClick: () => commands.open('propose') }, t('newProposal')),
              ),
              h(
                'div',
                { className: 'dshspec-sectionBody' },
                changes.length === 0
                  ? h(SectionEmpty, {
                      icon: 'sparkle',
                      title: t('noChanges'),
                      hint: t('noChangesHint'),
                      action: h(Button, { variant: 'primary', size: 'md', icon: 'filePlus', onClick: () => commands.open('propose') }, t('newProposal')),
                    })
                  : changePage.items.map((change) =>
                      h(ChangeCard, {
                        key: change.name,
                        t,
                        change: normalizeChangeState(change, change.name),
                        open: expanded[change.name] === true,
                        onToggle: () => toggleChange(change.name),
                        commands,
                        openDoc,
                        onIssue: (issue) => openIssue(issue, change),
                        onValidate: openValidation,
                        onSyncPreview: openSyncPreview,
                      }),
                    ),
                h(ListMore, { t, hidden: changePage.hidden, reveal: Math.min(changePage.pageSize, changePage.hidden), onMore: revealChanges }),
              ),
            ),
            h(
              Section,
              { key: 'specs', title: t('capabilitySpecs'), count: specs.length, defaultOpen: true },
              h(CapabilitySection, { t, specs, openDoc, onIssues: openSpecIssues }),
            ),
            h(ArchiveSection, { key: 'archive', t, source, archived, openDoc }),
            warnings.length === 0
              ? null
              : h(
                  Section,
                  { key: 'warnings', title: t('workspaceWarnings'), count: warnings.length, defaultOpen: false },
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px' } },
                    warnings.map((warning, index) => h(Banner, { key: index, tone: 'warn', wrap: true }, warning)),
                  ),
                ),
            state.watchDown === true || (source !== undefined && source.sessionId === undefined)
              ? h(
                  'div',
                  { key: 'watch', className: 'dshspec-foot' },
                  h(Icon, { name: 'refresh', size: 14 }),
                  h('span', null, source !== undefined && source.sessionId === undefined ? t('pollingHint') : t('watchDown')),
                )
              : null,
          ]
        : null,
      commands.modal,
      validationModal,
      syncModal,
      specIssuesModal,
      doc === null
        ? null
        : h(DocModal, {
            t,
            doc,
            onClose: () => setDoc(null),
            onAlign: typeof align === 'function' ? () => align(row, doc)() : undefined,
            onReadMore: readMoreDoc,
          }),
    )
  }

  /** Cached workspace selection so navigating away and back keeps the pick. */
  let lastSelectedWorkspace = null

  /** The monitoring page: workspace switcher on top, selected workspace below. */
  function OpenspecPanel({ t, rowsSource, sourceFor, composeFor, alignFor, initFor, onRefreshSessions }) {
    const rows = useSyncExternalStore(rowsSource.subscribe, rowsSource.getSnapshot)
    const [selected, setSelected] = useState(() => lastSelectedWorkspace)
    const [nonce, setNonce] = useState(0)
    const [spinning, setSpinning] = useState(false)
    const selectedRow = rows.find((row) => row.cwd === selected) ?? rows[0]

    const select = (cwd) => {
      lastSelectedWorkspace = cwd
      setSelected(cwd)
    }

    const refreshAll = async () => {
      setSpinning(true)
      try {
        await onRefreshSessions()
      } finally {
        setSpinning(false)
        setNonce((value) => value + 1)
      }
    }

    return h(
      'div',
      { className: 'dshspec-root', 'data-dshspec-panel': true, 'data-dshspec-build': BUILD },
      h(
        'div',
        { className: 'dshspec-page' },
        h(
          'div',
          { className: 'dshspec-pageHead' },
          h(
            'div',
            { className: 'dshspec-pageHeadText' },
            h('h1', { className: 'dshspec-title' }, t('title')),
            h('p', { className: 'dshspec-sub', style: { margin: '2px 0 0' } }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'dshspec-pageActions' },
            h(IconButton, {
              icon: 'refresh',
              label: t('refreshAll'),
              size: 32,
              onClick: () => void refreshAll(),
              className: spinning ? 'dshspec-spin' : undefined,
            }),
          ),
        ),
        rows.length === 0
          ? h(
              'section',
              { className: 'dshspec-card' },
              h(
                'div',
                { className: 'dshspec-empty' },
                h('span', { className: 'dshspec-emptyIcon' }, h(Icon, { name: 'info', size: 20 })),
                h('div', { className: 'dshspec-emptyTitle' }, t('nosession')),
              ),
            )
          : [
              h(
                'div',
                { key: 'wsbar', className: 'dshspec-wsbar' },
                h('span', { className: 'dshspec-wsbarLabel' }, t('workspaceLabel')),
                h(
                  'div',
                  { className: 'dshspec-wstabs' },
                  rows.map((row) =>
                    h(
                      'button',
                      {
                        key: row.cwd,
                        type: 'button',
                        className: 'dshspec-wstab',
                        title: row.cwd,
                        'data-active': selectedRow !== undefined && row.cwd === selectedRow.cwd ? 'true' : undefined,
                        onClick: () => select(row.cwd),
                      },
                      h(Icon, { name: 'folder', size: 15 }),
                      h('span', { className: 'dshspec-wstabName' }, basenameOf(row.cwd)),
                    ),
                  ),
                ),
              ),
              selectedRow === undefined
                ? null
                : h(WorkspaceDetail, {
                    key: `${selectedRow.cwd}#${nonce}`,
                    t,
                    row: selectedRow,
                    source: sourceFor(selectedRow),
                    compose: composeFor,
                    align: alignFor,
                    init: initFor,
                    onRefresh: onRefreshSessions,
                  }),
            ],
      ),
    )
  }



  /** Inline composer quick bar: native status, next-step action, skip_specs/blocked/skills signals. */
  function DockBody({ t, state, source, openPanel, init, sessionId }) {
    const [toast, setToast] = useState(null)
    const [selectedName, setSelectedName] = useState(null)
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef(null)
    const toastTimer = useRef(null)

    useEffect(
      () => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      },
      [],
    )

    useEffect(() => {
      if (!menuOpen) return
      const onPointerDown = (event) => {
        if (menuRef.current !== null && !menuRef.current.contains(event.target)) setMenuOpen(false)
      }
      const onKey = (event) => {
        if (event.key === 'Escape') setMenuOpen(false)
      }
      document.addEventListener('mousedown', onPointerDown, true)
      document.addEventListener('keydown', onKey, true)
      return () => {
        document.removeEventListener('mousedown', onPointerDown, true)
        document.removeEventListener('keydown', onKey, true)
      }
    }, [menuOpen])

    const showToast = useCallback((text) => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      setToast(text)
      toastTimer.current = setTimeout(() => setToast(null), 3200)
    }, [])

    const changes = state.status === 'ready' ? state.changes.map((change) => normalizeChangeState(change, change.name)) : []
    const rawTarget = changes.find((change) => change.name === selectedName) ?? primaryChange(state)
    const target = rawTarget === undefined ? undefined : normalizeChangeState(rawTarget, rawTarget.name)
    const commands = useCommands({
      t,
      insert: (text) => insertIntoComposer(text),
      onResult: (outcome) => {
        if (outcome !== undefined && outcome !== null && outcome.ok === false) showToast(outcome.text ?? t('commandFailed'))
      },
    })

    const action = deriveNextAction(target)
    const progress = taskProgressInfo(target?.tasks)
    const blocked = target !== undefined ? blockedArtifacts(target.artifacts) : []
    const nativeSkills = state.skills !== null && state.skills !== undefined && Array.isArray(state.skills.native) ? state.skills.native : []
    const fallbackActive = state.skills !== null && state.skills !== undefined && state.skills.fallbackActive === true
    const runNext = () => {
      if (target === undefined || action.kind === 'propose') {
        commands.open('propose')
        return
      }
      commands.execute(action.line)
    }

    const dot = h('span', { className: 'dshspec-dot', style: { background: toneColor(target === undefined ? 'muted' : changeTone(target)) } })
    const nameNode =
      target === undefined
        ? h('span', { className: 'dshspec-dockName', title: t('quickNoChange') }, `OpenSpec · ${t('quickNoChange')}`)
        : h('span', { className: 'dshspec-dockName', title: target.name }, target.name)
    const statusMeta =
      target === undefined
        ? []
        : [
            target.schemaName === '' ? null : h(ToneBadge, { key: 'schema', tone: 'muted', title: tx(t, 'changeSchema', { name: target.schemaName }) }, target.schemaName),
            target.metadata.skip_specs === true ? h(ToneBadge, { key: 'skip', tone: 'muted', title: t('skipSpecs') }, t('skipSpecs')) : null,
            blocked.length > 0
              ? h(
                  ToneBadge,
                  {
                    key: 'blocked',
                    tone: 'warn',
                    title: blocked.map((artifact) => `${artifactLabel(artifact.id)}: ${artifact.missingDeps.map((dep) => artifactLabel(dep)).join('、')}`).join('\n'),
                  },
                  tx(t, 'blockedCount', { count: blocked.length }),
                )
              : null,
            progress.total > 0
              ? h('span', { key: 'progress', className: 'dshspec-progressCount', title: t('progressLabel') }, tx(t, 'taskProgress', { done: progress.done, total: progress.total }))
              : null,
          ]
    const skillsBadge =
      nativeSkills.length > 0
        ? h(
            ToneBadge,
            { tone: 'business', title: tx(t, 'nativeSkillsTitle', { names: nativeSkills.map((skill) => skill.name ?? skill.workflow ?? '').join(', ') }) },
            `${t('nativeSkills')} ${nativeSkills.length}`,
          )
        : fallbackActive
          ? h(ToneBadge, { tone: 'muted', title: t('fallbackSkillsTitle') }, t('fallbackSkills'))
          : null

    const statusArea =
      target === undefined || changes.length <= 1
        ? h('div', { className: 'dshspec-dockStatus' }, dot, nameNode, statusMeta)
        : h(
            'div',
            { className: 'dshspec-dockStatus' },
            h(
              'div',
              { className: 'dshspec-dockTargetWrap', ref: menuRef },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshspec-dockTarget',
                  title: t('switchChange'),
                  'aria-haspopup': 'menu',
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  onClick: () => setMenuOpen((value) => !value),
                },
                dot,
                nameNode,
                statusMeta,
                h(Icon, { name: 'chevronDown', size: 12, className: 'dshspec-dockCaret' }),
              ),
              menuOpen
                ? h(
                    'div',
                    { className: 'dshspec-dockMenu', role: 'menu' },
                    h('div', { className: 'dshspec-dockMenuHead' }, h('span', null, t('switchChange')), h('span', null, String(changes.length))),
                    changes.map((change) => {
                      const itemProgress = taskProgressInfo(change.tasks)
                      return h(
                        'button',
                        {
                          key: change.name,
                          type: 'button',
                          role: 'menuitemradio',
                          className: 'dshspec-dockMenuItem',
                          title: change.name,
                          'aria-checked': target !== undefined && change.name === target.name ? 'true' : 'false',
                          'data-active': target !== undefined && change.name === target.name ? 'true' : undefined,
                          onClick: () => {
                            setSelectedName(change.name)
                            setMenuOpen(false)
                          },
                        },
                        h('span', { className: 'dshspec-dockMenuName' }, change.name),
                        h(ToneBadge, { tone: change.isPlanningComplete ? 'success' : 'business' }, t(change.isPlanningComplete ? 'plannerComplete' : 'planning')),
                        change.metadata.skip_specs === true ? h('span', { className: 'dshspec-dockMenuCount' }, 'skip_specs') : null,
                        itemProgress.total > 0 ? h('span', { className: 'dshspec-dockMenuCount' }, `${itemProgress.done}/${itemProgress.total}`) : null,
                        target !== undefined && change.name === target.name ? h(Icon, { name: 'check', size: 14 }) : null,
                      )
                    }),
                  )
                : null,
            ),
          )

    return h(
      'div',
      { className: 'dshspec-dock', 'data-dshspec-quickbar': 'ready', 'data-dshspec-session': sessionId },
      statusArea,
      h(
        'div',
        { className: 'dshspec-dockActions' },
        h(
          'div',
          { className: 'dshspec-seg' },
          h(Button, { variant: 'ghost', size: 'sm', title: '/opsx-explore [主题]', onClick: () => commands.open('explore') }, t('explore')),
          h(Button, { variant: 'ghost', size: 'sm', title: '/opsx-propose <change-name> [说明]', onClick: () => commands.open('propose') }, t('propose')),
          h(
            Button,
            {
              variant: 'primary',
              size: 'sm',
              icon: nextActionIcon(action.kind),
              title: action.kind === 'propose' ? '/opsx-propose ' : action.line,
              onClick: runNext,
            },
            nextActionText(t, action),
          ),
        ),
        skillsBadge,
        h(Button, { variant: 'ghost', size: 'sm', title: '/opsx-status', onClick: () => commands.execute('/opsx-status') }, t('status')),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      ),
      commands.modal,
      toast === null ? null : h('div', { className: 'dshspec-toast', role: 'status' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, toast)),
    )
  }

  /** The quick bar under the composer: native state + one-click next-step command. */
  function QuickBar({ state: stateSource, source, openPanel, t, init, sessionId }) {
    if (stateSource === undefined || source === undefined) return null
    const state = useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot)
    if (state.status === 'loading') return null
    if (state.status === 'error') {
      return h(
        'div',
        { className: 'dshspec-dock', 'data-dshspec-quickbar': 'error', 'data-dshspec-session': sessionId },
        h(
          'div',
          { className: 'dshspec-banner dshspec-bannerError', style: { flex: 1, minWidth: 0 } },
          h(Icon, { name: 'alert', size: 14 }),
          h('span', { className: 'dshspec-bannerText', title: state.error ?? '' }, `${t('error')}：${state.error ?? ''}`),
        ),
        h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void source.refresh() }, t('retry')),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      )
    }
    if (state.status === 'missing') {
      return h(
        'div',
        { className: 'dshspec-dock', 'data-dshspec-quickbar': 'missing', 'data-dshspec-session': sessionId },
        h('span', { className: 'dshspec-dot', style: { background: 'var(--dsw-alias-state-warn-primary)' } }),
        h('span', { className: 'dshspec-dockName' }, `OpenSpec · ${t('quickMissing')}`),
        h('span', { className: 'dshspec-space' }),
        h(InitControl, { t, init, refresh: () => source.refresh(), cwd: state.cwd }),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      )
    }
    return h(DockBody, { t, state, source, openPanel, init, sessionId })
  }

  /* ------------------------------------------------------------------ *
   * Registration.
   * ------------------------------------------------------------------ */

  /** Sidebar glyph: a small phase-loop mark. */
  function PanelIcon() {
    return h(
      'svg',
      { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' } },
      h('path', {
        d: 'M 8 7 a 6.5 6.5 0 1 1 -1 7.5',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
      }),
      h('circle', { cx: 8, cy: 7, r: 1.9, fill: 'currentColor' }),
      h('rect', { x: 10, y: 12.5, width: 8, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.9 }),
      h('rect', { x: 10, y: 16, width: 5.5, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.55 }),
    )
  }

  /** Build marker for served-bundle verification. */
  const BUILD = '20261020-native-panel'

  /**
   * Register the locale dictionaries, the monitoring page, the sidebar glyph,
   * and the composer quick bar.
   * @param ctx - browser services used by these contributions.
   */
  function apply(ctx) {
    injectStyle()
    ctx.effect(() => ctx.locale.register(NS, { zh: T.zh, en: T.en }), 'dsh-spec: dictionaries')
    const t = ctx.locale.bind(NS)

    /** One workspace source per (cwd, session) pair, shared by the dock and the panel. */
    const sources = new Map()
    const sourceFor = (row) => {
      const key = `${row.cwd}|${typeof row.sessionId === 'string' ? row.sessionId : ''}`
      let source = sources.get(key)
      if (source === undefined) {
        source = createWorkspaceSource(ctx, { cwd: row.cwd, sessionId: row.sessionId })
        sources.set(key, source)
      }
      return source
    }

    /** Wait until the target session's composer dock has mounted. */
    const waitForDock = (target, timeoutMs) =>
      new Promise((resolve) => {
        const started = Date.now()
        const probe = () => {
          if (typeof document === 'undefined') {
            resolve(false)
            return
          }
          const escaped = String(target).replace(/["\\]/g, '')
          if (document.querySelector('[data-dshspec-quickbar][data-dshspec-session="' + escaped + '"]') !== null) {
            resolve(true)
            return
          }
          if (Date.now() - started >= timeoutMs) {
            resolve(false)
            return
          }
          setTimeout(probe, 120)
        }
        probe()
      })

    /**
     * Bring one workspace's conversation on screen and put the command line
     * into its composer draft — never auto-send. An existing session is opened
     * first; only a workspace without any session asks the host to create one.
     * The dock marker tells us the target session has been mounted before we
     * type into the editor.
     */
    const composeFor = (row) => async (line) => {
      const fill = () => {
        const inserted = insertIntoComposer(line)
        return inserted === false ? { ok: false, text: t('insertFailed') } : { ok: true, text: line }
      }
      try {
        const existing = [
          ...(Array.isArray(row.sessionIds) ? row.sessionIds : []),
          row.sessionId,
        ].filter((id) => typeof id === 'string')
        for (const candidate of [...new Set(existing)]) {
          if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(candidate)
          if (await waitForDock(candidate, 1800)) return fill()
        }
        let created
        if (row.workspaceId !== undefined && typeof ctx.uiWorkspace?.connectWorkspace === 'function') {
          const connected = await withTimeout(
            Promise.resolve(ctx.uiWorkspace.connectWorkspace(row.workspaceId)),
            15000,
            '连接工作区',
          )
          if (typeof connected === 'string') created = connected
          else if (connected !== null && typeof connected === 'object') {
            if (typeof connected.sessionId === 'string') created = connected.sessionId
            else if (typeof connected.id === 'string') created = connected.id
          }
        }
        if (typeof created !== 'string') return { ok: false, text: t('switchFailed') }
        if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(created)
        await waitForDock(created, 10000)
        return fill()
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Start a NEW session for the document's workspace and carry the document
     * into its draft as plain text (the public input API accepts plain text
     * only; structured @ references are internal to the shell). The panel's
     * doc viewer shows this as「去工作区对齐」.
     */
    const alignFor = (row, doc) => async () => {
      const relative = doc?.relPath ?? doc?.path ?? ''
      const prompt = t('alignDraft').replace('{path}', relative)
      try {
        if (row.workspaceId !== undefined && typeof ctx.uiWorkspace?.startSession === 'function') {
          await withTimeout(
            Promise.resolve(ctx.uiWorkspace.startSession(row.workspaceId, { prompt, clearPreviousDraft: true })),
            15000,
            '新建会话',
          )
          return { ok: true, text: prompt }
        }
        return await composeFor(row)(prompt)
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Session-less init for a panel workspace row: post the workspace path to
     * the Host's /dsh-spec route, which validates it against the registered
     * workspaces, writes the native scaffold and reports the created items.
     */
    const initFor = async (cwd) => initWorkspace(ctx, cwd)

    /** Stable rows snapshot for the panel: recomputed only when a store changes. */
    let lastRaw
    let lastRows = []
    const rowsSource = {
      subscribe: (listener) => ctx.workspaces.list.subscribe(listener),
      getSnapshot: () => {
        const raw = ctx.workspaces.list.getSnapshot()
        if (raw !== lastRaw) {
          lastRaw = raw
          lastRows = workspaceRows(ctx)
        }
        return lastRows
      },
    }

    const refreshAll = async () => {
      const rows = rowsSource.getSnapshot()
      await Promise.all(rows.map((row) => sourceFor(row).refresh()))
    }

    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => ({
        t,
        rowsSource,
        sourceFor,
        composeFor,
        alignFor,
        initFor,
        onRefreshSessions: refreshAll,
      }),
    }, OpenspecPanel))

    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 12,
      locale: NS,
      label: () => t('panel'),
    }, PanelIcon))

    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: DOCK_ID,
      order: 5,
      locale: NS,
      inject: (sessionId) => {
        const row = rowForSession(ctx, sessionId)
        const source = row === undefined ? undefined : sourceFor(row)
        return {
          sessionId,
          state: source === undefined ? undefined : source.hooks.state,
          source,
          init: initFor,
          openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        }
      },
    }, QuickBar))
  }

  return { inject: ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'remote.commands', 'sessions', 'workspaces', 'uiWorkspace', 'connection', 'layout'], apply }
}

window.__ModuleLoader__.load({
  id: 'dsh-spec',
  factory: (require) => {
    const plugin = createOpenSpecPlugin(require)
    return { inject: plugin.inject, apply: plugin.apply }
  },
})
