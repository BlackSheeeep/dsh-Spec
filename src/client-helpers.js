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
 * Operation counts of one delta file row (`ChangeState.delta.files[]`).
 *
 * @param {{ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number}} [file] - per-file delta row.
 * @returns {{ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number, total: number}} counts.
 */
export function deltaFileOperationCounts(file) {
  const counts = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, total: 0 }
  for (const operation of HELPER_DELTA_OPERATIONS) {
    counts[operation] = helperNumber(file?.[operation])
    counts.total += counts[operation]
  }
  return counts
}

/**
 * Localized per-file delta mix, e.g. `+2 新增 · 1 修改`. Zero-count operations
 * are omitted so a file row stays compact.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {{ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number}} [file] - per-file delta row.
 * @returns {string} summary text or `''` when the file has no operation counts.
 */
export function deltaFileOpsText(t, file) {
  const counts = deltaFileOperationCounts(file)
  if (counts.total === 0) return ''
  return HELPER_DELTA_OPERATIONS.filter((operation) => counts[operation] > 0)
    .map((operation) => fillText(t, HELPER_DELTA_KEYS[operation], { count: counts[operation] }))
    .join(' · ')
}

/**
 * Pick the one-line summary rendered on a collapsed change card.
 *
 * Priority: `.openspec.yaml` `goal` → proposal `## Why` digest → the legacy
 * 0.9.x `description`/`headline` fields (still sent by an old Host) → none (the
 * panel shows a "no proposal yet" placeholder). The host already bounds the
 * digest, so this only trims and reports whether a full-text entry is needed.
 *
 * @param {{goal?: string|null, why?: string|null, description?: string|null, headline?: string|null, whyTruncated?: boolean, changesHidden?: number, changesTruncated?: boolean}|null} [summary] - `ChangeState.summary`.
 * @returns {{text: string, source: 'goal'|'why'|'description'|'headline'|'none', truncated: boolean}} summary candidate.
 */
export function changeSummaryInfo(summary) {
  const goal = typeof summary?.goal === 'string' ? summary.goal.trim() : ''
  if (goal !== '') return { text: goal, source: 'goal', truncated: false }
  const why = typeof summary?.why === 'string' ? summary.why.trim() : ''
  if (why !== '') {
    const truncated =
      summary?.whyTruncated === true || summary?.changesTruncated === true || helperNumber(summary?.changesHidden) > 0
    return { text: why, source: 'why', truncated }
  }
  const description = typeof summary?.description === 'string' ? summary.description.trim() : ''
  if (description !== '') return { text: description, source: 'description', truncated: false }
  const headline = typeof summary?.headline === 'string' ? summary.headline.trim() : ''
  if (headline !== '') return { text: headline, source: 'headline', truncated: false }
  return { text: '', source: 'none', truncated: false }
}

/**
 * Localized text helper: first non-empty trimmed string.
 *
 * @param {...unknown} values - candidates in priority order.
 * @returns {string} first non-empty trimmed text, else `''`.
 */
function helperFirstText(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text !== '') return value
  }
  return ''
}

/**
 * Non-empty string list copy; anything else degrades to `[]`.
 *
 * @param {unknown} value - candidate list.
 * @returns {string[]} only non-blank string entries.
 */
function helperStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : []
}

/**
 * Normalize the bounded proposal digest from the Host.
 *
 * A 0.10.0 Host sends `summary.why` / `summary.changes`; a 0.9.x Host only sends
 * `summary.description` / `summary.highlights`, so those legacy fields fill the
 * same slots here. A pre-0.9 Host has no `summary` at all, in which case every
 * field degrades to an empty value instead of crashing the card (the panel then
 * re-reads `proposal.md` through `proposalSummaryDigest`).
 *
 * @param {object|null|undefined} value - raw `ChangeState.summary`.
 * @returns {{goal: string|null, why: string|null, whyTruncated: boolean, changes: string[], changesHidden: number, changesTruncated: boolean}} normalized digest.
 */
export function normalizeChangeSummary(value) {
  const summary = value !== null && typeof value === 'object' ? value : {}
  const why = helperFirstText(summary.why, summary.description)
  const nativeChanges = helperStringList(summary.changes)
  const changes = nativeChanges.length > 0 ? nativeChanges : helperStringList(summary.highlights)
  return {
    goal: typeof summary.goal === 'string' && summary.goal.trim() !== '' ? summary.goal : null,
    why: why === '' ? null : why,
    whyTruncated: summary.whyTruncated === true,
    changes,
    changesHidden: helperNumber(summary.changesHidden),
    changesTruncated: summary.changesTruncated === true,
  }
}

/** Character budget of the `## Why` digest (mirrors the 0.10.0 Host payload). */
const HELPER_SUMMARY_WHY_CHARS = 280
/** Character budget of one `## What Changes` bullet. */
const HELPER_SUMMARY_CHANGE_CHARS = 140
/** Row budget of the `## What Changes` digest. */
const HELPER_SUMMARY_CHANGE_ROWS = 4

/** Level-2 markdown heading (`## Why`). */
const HELPER_H2_HEADING = /^##\s+(.+?)\s*$/
/** Any markdown heading (a level-2 section ends at the next heading of any level). */
const HELPER_ANY_HEADING = /^#{1,6}\s+/
/** A bullet or ordered-list item (any indent, used when skipping prose). */
const HELPER_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/
/** A top-level bullet only; indented nested bullets are not digest rows (same rule as the Host). */
const HELPER_TOP_LEVEL_LIST_ITEM = /^(?:[-*+])\s+(\S.*)$/
/** A fenced code block delimiter. */
const HELPER_FENCE = /^\s*(?:```|~~~)/

/** Preferred headings that introduce the proposal motivation paragraph. */
const HELPER_WHY_HEADINGS = ['why', 'motivation', 'background', 'rationale', '背景', '动机', '为什么']
/** Preferred headings that introduce the proposal change list. */
const HELPER_CHANGE_HEADINGS = [
  'what changes',
  'what changed',
  'changes',
  'change summary',
  'summary of changes',
  '变更内容',
  '改动内容',
  '变更摘要',
]

/** Collapse whitespace runs into single spaces and trim. */
function helperCollapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Cap text at a character budget without splitting surrogate pairs (`…` marks truncation). */
function helperCap(value, maxChars) {
  const text = helperCollapse(value)
  if (text.length <= maxChars) return text
  let output = ''
  let used = 0
  for (const character of text) {
    if (used >= Math.max(1, maxChars - 1)) break
    output += character
    used += character.length
  }
  return `${output.trimEnd()}…`
}

/** Strip the most common inline markdown so the panel shows prose, not syntax. */
function helperStripInlineMarkdown(value) {
  return helperCollapse(
    String(value ?? '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/<[^>]+>/g, ''),
  )
}

/**
 * Split a document into level-2 sections: lower-cased heading text → body lines.
 * Fenced code blocks are inert; any higher/lower heading closes the section.
 *
 * @param {string[]} lines - normalized document lines.
 * @returns {Map<string, string[]>} sections in source order.
 */
function helperSectionMap(lines) {
  /** @type {Map<string, string[]>} */
  const sections = new Map()
  let current
  let inFence = false
  for (const line of lines) {
    if (HELPER_FENCE.test(line)) {
      inFence = !inFence
      if (current !== undefined) current.push(line)
      continue
    }
    if (!inFence) {
      const heading = HELPER_H2_HEADING.exec(line)
      if (heading !== null) {
        current = []
        sections.set(heading[1].trim().toLowerCase(), current)
        continue
      }
      if (HELPER_ANY_HEADING.test(line)) {
        current = undefined
        continue
      }
    }
    if (current !== undefined) current.push(line)
  }
  return sections
}

/**
 * First matching section body from a preferred heading list.
 *
 * @param {Map<string, string[]>} sections - section map.
 * @param {string[]} names - preferred lower-case headings.
 * @returns {string[]|undefined} body lines when the section exists.
 */
function helperPreferredSection(sections, names) {
  for (const name of names) {
    const body = sections.get(name)
    if (body !== undefined) return body
  }
  return undefined
}

/**
 * First non-empty prose paragraph in a body (bullets/headings/fences/quotes skipped).
 *
 * @param {string[]|undefined} body - section lines.
 * @returns {string} plain paragraph text.
 */
function helperFirstParagraph(body) {
  const lines = Array.isArray(body) ? body : []
  const paragraph = []
  let inFence = false
  for (const line of lines) {
    if (HELPER_FENCE.test(line)) {
      inFence = !inFence
      if (paragraph.length > 0) break
      continue
    }
    if (inFence) continue
    const trimmed = line.trim()
    if (trimmed === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (HELPER_ANY_HEADING.test(trimmed) || HELPER_LIST_ITEM.test(trimmed) || /^>\s?/.test(trimmed)) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(trimmed)
  }
  return helperStripInlineMarkdown(paragraph.join(' '))
}

/**
 * Top-level bullet entries of a section body, in source order.
 *
 * Mirrors the Host digest: indented nested bullets and ordered lists are not
 * separate rows, so the panel's `共 N 条` matches the new Host exactly.
 *
 * @param {string[]|undefined} body - section lines.
 * @returns {string[]} plain entries.
 */
function helperListItems(body) {
  const lines = Array.isArray(body) ? body : []
  const items = []
  let inFence = false
  for (const line of lines) {
    if (HELPER_FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = HELPER_TOP_LEVEL_LIST_ITEM.exec(line)
    if (match === null) continue
    const text = helperStripInlineMarkdown(match[1])
    if (text !== '') items.push(text)
  }
  return items
}

/**
 * Derive a bounded change digest from `proposal.md` text.
 *
 * This mirrors the Host's 0.10.0 `summary` digest. The browser half only needs
 * it when the running Host predates that payload (a long-lived DSH process
 * keeps the Host loaded while a page refresh picks up the new client), so the
 * L1 "why / what changes" overview still has content in a mixed-version setup.
 *
 * @param {string|null|undefined} markdown - proposal document text.
 * @returns {{why: string|null, whyTruncated: boolean, changes: string[], changesHidden: number, changesTruncated: boolean}|null} digest, or `null` when the document has neither section.
 */
export function proposalSummaryDigest(markdown) {
  const lines = String(markdown ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  if (lines.join('').trim() === '') return null
  const sections = helperSectionMap(lines)
  let whyText = helperFirstParagraph(helperPreferredSection(sections, HELPER_WHY_HEADINGS))
  if (whyText === '') {
    // No `## Why`: use the first prose paragraph anywhere after the title.
    whyText = helperFirstParagraph(lines.slice(1))
  }
  const changeItems = helperListItems(helperPreferredSection(sections, HELPER_CHANGE_HEADINGS))
  const why = whyText === '' ? null : helperCap(whyText, HELPER_SUMMARY_WHY_CHARS)
  const whyTruncated = whyText.length > HELPER_SUMMARY_WHY_CHARS
  const kept = changeItems.slice(0, HELPER_SUMMARY_CHANGE_ROWS)
  const changes = kept.map((item) => helperCap(item, HELPER_SUMMARY_CHANGE_CHARS))
  if (why === null && changes.length === 0) return null
  return {
    why,
    whyTruncated,
    changes,
    changesHidden: Math.max(0, changeItems.length - kept.length),
    changesTruncated: kept.some((item) => item.length > HELPER_SUMMARY_CHANGE_CHARS),
  }
}

/**
 * The `proposal.md` row of a change's document list (null when absent).
 *
 * @param {{docs?: Array<object>}|null|undefined} change - normalized `ChangeState`.
 * @returns {{path: string}|null} document row.
 */
export function proposalDocOf(change) {
  const docs = Array.isArray(change?.docs) ? change.docs : []
  const usable = docs.filter(
    (doc) => doc !== null && typeof doc === 'object' && typeof doc.path === 'string' && doc.path !== '' && doc.kind !== 'delta',
  )
  for (const doc of usable) {
    if (String(doc.artifactId ?? '') === 'proposal') return doc
  }
  const fallback = usable.find((doc) => String(doc.path).replace(/\\/g, '/').endsWith('proposal.md'))
  return fallback ?? null
}

/**
 * Whether a normalized summary still lacks the `## Why` paragraph (the panel's
 * L1 overview would show the "no proposal yet" placeholder).
 *
 * @param {{why?: string|null}|null|undefined} summary - normalized `ChangeState.summary`.
 * @returns {boolean} true when a proposal re-read can fill it.
 */
export function summaryNeedsProposalFallback(summary) {
  const why = typeof summary?.why === 'string' ? summary.why.trim() : ''
  return why === ''
}

/**
 * Merge a locally derived proposal digest into a summary without overwriting
 * values the Host already supplied. Truncation flags follow whichever source
 * filled the slot, so "查看全文" entries stay honest.
 *
 * @param {object|null|undefined} summary - raw `ChangeState.summary`.
 * @param {{why: string|null, whyTruncated: boolean, changes: string[], changesHidden: number, changesTruncated: boolean}|null} digest - output of {@link proposalSummaryDigest}.
 * @returns {object} merged summary (a new object when `summary` is not one).
 */
export function applyProposalDigest(summary, digest) {
  const base = summary !== null && typeof summary === 'object' ? summary : {}
  if (digest === null || typeof digest !== 'object') return base
  const hasWhy = typeof base.why === 'string' && base.why.trim() !== ''
  const baseChanges = helperStringList(base.changes)
  const hasChanges = baseChanges.length > 0
  const digestWhy = typeof digest.why === 'string' && digest.why !== '' ? digest.why : null
  const digestChanges = helperStringList(digest.changes)
  return {
    ...base,
    why: hasWhy ? base.why : digestWhy,
    whyTruncated: base.whyTruncated === true || (!hasWhy && digest.whyTruncated === true),
    changes: hasChanges ? baseChanges : digestChanges,
    changesHidden: hasChanges ? helperNumber(base.changesHidden) : helperNumber(digest.changesHidden),
    changesTruncated: hasChanges ? base.changesTruncated === true : digest.changesTruncated === true,
    source: typeof base.source === 'string' && base.source !== 'none' ? base.source : 'proposal',
  }
}

/**
 * Normalize per-file delta rows. Accepts the native `{path,label,...counts}`
 * rows and the legacy string path list so a mixed Host/client version still
 * renders both.
 *
 * @param {Array<object|string>|null|undefined} files - raw `ChangeState.delta.files`.
 * @returns {Array<{path: string, label: string, ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number}>} normalized rows.
 */
export function normalizeDeltaFiles(files) {
  const list = Array.isArray(files) ? files : []
  /** @type {Array<{path: string, label: string, ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number}>} */
  const rows = []
  for (const file of list) {
    if (typeof file === 'string') {
      if (file === '') continue
      rows.push({ path: file, label: '', ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 })
      continue
    }
    if (file === null || typeof file !== 'object') continue
    const path = typeof file.path === 'string' ? file.path : ''
    if (path === '') continue
    rows.push({
      path,
      label: typeof file.label === 'string' ? file.label : '',
      ADDED: helperNumber(file.ADDED),
      MODIFIED: helperNumber(file.MODIFIED),
      REMOVED: helperNumber(file.REMOVED),
      RENAMED: helperNumber(file.RENAMED),
    })
  }
  return rows
}

/**
 * Totals of the bounded `## What Changes` digest: how many items are shown and
 * how many the host left out (so the panel can render `共 N 条` explicitly).
 *
 * @param {{changes?: string[], changesHidden?: number, changesTruncated?: boolean}|null} [summary] - `ChangeState.summary`.
 * @returns {{shown: number, total: number, truncated: boolean}} digest totals.
 */
export function changeDigestTotals(summary) {
  const shown = Array.isArray(summary?.changes) ? summary.changes.filter((item) => typeof item === 'string' && item.trim() !== '').length : 0
  const hidden = helperNumber(summary?.changesHidden)
  return { shown, total: shown + hidden, truncated: summary?.changesTruncated === true || hidden > 0 }
}

/**
 * Group a change's documents by schema artifact for the progressive detail view.
 *
 * Only groups with something to show are returned (plus the `tasks` group, which
 * also hosts the missing-task-list note, and a final `metadata` group). Delta
 * documents are matched against `delta.files` so each row carries its own
 * operation counts, and every document appears in exactly one group.
 *
 * @param {object} change - normalized `ChangeState`.
 * @returns {Array<{id: string, kind: 'artifact'|'delta'|'metadata', title: string, status: string, description: string, docs: Array<object>, deltas: Array<object>}>} groups in schema artifact order, metadata last.
 */
export function groupChangeDocuments(change) {
  const docs = Array.isArray(change?.docs)
    ? change.docs.filter((doc) => doc !== null && typeof doc === 'object' && typeof doc.path === 'string' && doc.path !== '')
    : []
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  const deltaFiles = Array.isArray(change?.delta?.files)
    ? change.delta.files
        .map((file) => {
          if (typeof file === 'string') return { path: file, label: '', ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }
          if (file !== null && typeof file === 'object' && typeof file.path === 'string') return file
          return null
        })
        .filter((file) => file !== null && file.path !== '')
    : []
  const usedDocs = new Set()
  const deltaFileFor = (doc) => {
    const path = String(doc.path).replace(/\\/g, '/')
    const match = deltaFiles.find((file) => path === file.path || path.endsWith(`/${file.path}`))
    const label = match !== undefined && typeof match.label === 'string' && match.label !== '' ? match.label : typeof doc.label === 'string' ? doc.label : ''
    if (match !== undefined) return { ...match, label }
    return { path, label, ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }
  }
  /** @type {Array<object>} */
  const groups = []
  const pushGroup = (id, artifact) => {
    const ownDocs = docs.filter((doc) => String(doc.artifactId ?? '') === id && !usedDocs.has(doc))
    for (const doc of ownDocs) usedDocs.add(doc)
    const plainDocs = ownDocs.filter((doc) => doc.kind !== 'delta')
    const deltas = ownDocs.filter((doc) => doc.kind === 'delta').map(deltaFileFor)
    if (plainDocs.length === 0 && deltas.length === 0 && id !== 'tasks') return
    groups.push({
      id,
      kind: deltas.length > 0 ? 'delta' : 'artifact',
      title: id,
      status: typeof artifact?.status === 'string' ? artifact.status : '',
      description: typeof artifact?.description === 'string' ? artifact.description : '',
      docs: plainDocs,
      deltas,
    })
  }
  const seenIds = new Set()
  for (const artifact of artifacts) {
    const id = artifact !== null && typeof artifact === 'object' && typeof artifact.id === 'string' ? artifact.id : ''
    if (id === '' || seenIds.has(id)) continue
    seenIds.add(id)
    pushGroup(id, artifact)
  }
  // Defensive: documents whose artifact is not part of the derived artifact list.
  /** @type {string[]} */
  const leftoverIds = []
  for (const doc of docs) {
    if (usedDocs.has(doc)) continue
    const id = typeof doc.artifactId === 'string' && doc.artifactId !== '' ? doc.artifactId : 'docs'
    if (!leftoverIds.includes(id)) leftoverIds.push(id)
  }
  for (const id of leftoverIds) pushGroup(id, undefined)
  groups.push({ id: 'metadata', kind: 'metadata', title: 'metadata', status: '', description: '', docs: [], deltas: [] })
  return groups
}

/**
 * One-line overview status: artifact / task progress, capability count, open
 * validation issues (only when non-zero) and the native next step.
 *
 * @param {((key: string) => string) | undefined} t - translate function.
 * @param {object} change - normalized `ChangeState`.
 * @returns {string} ` · `-joined status text.
 */
export function changeOverviewFacts(t, change) {
  /** @type {string[]} */
  const parts = []
  const artifacts = artifactProgress(change?.artifacts)
  if (artifacts.total > 0) parts.push(`${fillText(t, 'artifactsLabel')} ${artifacts.done}/${artifacts.total}`)
  const progress = taskProgressInfo(change?.tasks)
  if (progress.total > 0) parts.push(`${fillText(t, 'taskList')} ${progress.done}/${progress.total}`)
  const deltaFiles = Array.isArray(change?.delta?.files) ? change.delta.files.length : 0
  if (deltaFiles > 0) parts.push(fillText(t, 'overviewCapabilities', { count: deltaFiles }))
  const issues = helperNumber(change?.validation?.errors) + helperNumber(change?.validation?.warnings)
  if (issues > 0) parts.push(validationSummaryText(t, change.validation))
  parts.push(`${fillText(t, 'quickNext')}：${nextActionText(t, deriveNextAction(change))}`)
  return parts.join(' · ')
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
 * @param {{total?: number, done?: number, items?: Array<{id?: unknown, text?: unknown, done?: unknown, depth?: unknown, line?: unknown, manual?: unknown}>}|null} [tasks] - `ChangeState.tasks`.
 * @returns {{total: number, done: number, remaining: number, percent: number, complete: boolean, items: Array<{id: string|null, text: string, done: boolean, depth: number, line: number|null, manual: boolean}>, shown: number, hidden: number, missing: boolean, limited: boolean}} checklist view.
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
      line: Number.isInteger(item.line) && item.line > 0 ? item.line : null,
      manual: item.manual === true,
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
 * Pending tasks across every active change, split into human-acceptance and
 * other work.
 *
 * The panel's "waiting for acceptance" list is an aggregate view: one row per
 * unchecked task, with the owning change so the row can open its `tasks.md`.
 * Only the capped `tasks.items` payload is available, so changes with more than
 * 200 tasks expose the first 200; the per-change detail already surfaces the
 * remaining count.
 *
 * @param {Array<{name?: unknown, tasks?: {items?: Array<{id?: unknown, text?: unknown, done?: unknown, line?: unknown, manual?: unknown}>}|null}>|undefined} changes
 * @returns {{total: number, manual: Array<{change: string, id: string|null, text: string, line: number|null, manual: boolean}>, automatic: Array<{change: string, id: string|null, text: string, line: number|null, manual: boolean}>}}
 */
export function pendingAcceptanceTasks(changes) {
  const manual = []
  const automatic = []
  for (const change of Array.isArray(changes) ? changes : []) {
    if (change === null || typeof change !== 'object') continue
    const changeName = typeof change.name === 'string' ? change.name : ''
    if (changeName === '') continue
    const items = Array.isArray(change.tasks?.items) ? change.tasks.items : []
    for (const item of items) {
      if (item === null || typeof item !== 'object' || item.done === true) continue
      const rawText = String(item.text ?? '')
      const isManual = item.manual === true || /(?:\[|【)\s*人工验收\s*(?:\]|】)/.test(rawText)
      const text = rawText.replace(/(?:\[|【)\s*人工验收\s*(?:\]|】)/g, '').replace(/\s+/g, ' ').trim()
      const row = {
        change: changeName,
        id: typeof item.id === 'string' && item.id !== '' ? item.id : null,
        text: text === '' ? rawText.trim() : text,
        line: Number.isInteger(item.line) && item.line > 0 ? item.line : null,
        manual: isManual,
      }
      ;(isManual ? manual : automatic).push(row)
    }
  }
  const byChange = (left, right) => {
    if (left.change !== right.change) return left.change < right.change ? -1 : 1
    const leftLine = left.line ?? Number.MAX_SAFE_INTEGER
    const rightLine = right.line ?? Number.MAX_SAFE_INTEGER
    if (leftLine !== rightLine) return leftLine - rightLine
    return String(left.id ?? '').localeCompare(String(right.id ?? ''))
  }
  manual.sort(byChange)
  automatic.sort(byChange)
  return { total: manual.length + automatic.length, manual, automatic }
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
    // A half-generated plan is completed by re-running propose: it resumes the
    // existing change (keeping `.openspec.yaml` and satisfied artifacts) and
    // creates only the missing artifacts. update only revises existing files,
    // so it can never finish an interrupted plan.
    return { kind: 'propose', labelKey: 'nextActionResume', line: `/opsx-propose ${name}` }
  }
  if (change.listStatus === 'complete') {
    // The panel/quick-bar "Archive" button fills the composer with the default
    // /opsx-archive command, i.e. the OPSX AI archive workflow (completion
    // check, merge confirmation, validation, deterministic move). The
    // deterministic fast path stays available only when the user explicitly
    // adds `--yes` (or asks for a `--dry-run` preview).
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

/* -------------------------------------------------------------------- *
 * Human reports — date ranges, output naming and report preferences.
 *
 * The report dialog is pure browser UI: the Host only composes the prompt
 * (`report-prompt`) and reports whether a report already exists
 * (`report-status`). Range defaulting, the output file name and the tolerant
 * per-workspace `localStorage` shape stay pure so they are testable without a
 * DOM. Local dates are computed with the browser's own calendar (no UTC
 * conversion): an archived change belongs to the calendar day the user saw.
 * -------------------------------------------------------------------- */

/** Default report root, workspace-relative (the Host resolves it). */
const HELPER_REPORT_ROOT = '人类文档'

/** Days covered by the default period report range: today plus six days back. */
const HELPER_REPORT_RANGE_DAYS = 6

/** Coerce a timestamp / Date to finite epoch milliseconds (fallback: now). */
function helperReportTime(nowValue) {
  const raw = nowValue instanceof Date ? nowValue.getTime() : typeof nowValue === 'number' ? nowValue : Number.NaN
  return Number.isFinite(raw) ? raw : Date.now()
}

/**
 * Local calendar date of a moment as `YYYY-MM-DD`.
 *
 * @param {number|Date} [nowValue] - epoch milliseconds (or Date); defaults to now.
 * @returns {string} local `YYYY-MM-DD`.
 */
export function reportLocalDate(nowValue = Date.now()) {
  const date = new Date(helperReportTime(nowValue))
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Default period report range: `to` is today, `from` is six days earlier
 * (both inclusive), so the dialog opens on the last seven local days.
 *
 * @param {number|Date} [nowValue] - epoch milliseconds (or Date); defaults to now.
 * @returns {{from: string, to: string}} inclusive local date range.
 */
export function reportDefaultRange(nowValue = Date.now()) {
  const time = helperReportTime(nowValue)
  const start = new Date(time)
  start.setDate(start.getDate() - HELPER_REPORT_RANGE_DAYS)
  return { from: reportLocalDate(start.getTime()), to: reportLocalDate(time) }
}

/**
 * Archived changes whose archive date falls inside an inclusive range.
 *
 * Rows without a usable `YYYY-MM-DD` date are excluded (the period prompt has
 * no way to place them). An empty `from` / `to` bound is tolerated as
 * "unbounded" so a partially typed range never crashes the dialog. The result
 * is sorted by date, then display name, matching the report's change list.
 *
 * @param {Array<{name?: string, changeName?: string, date?: string}>} archived - `WorkspaceState.archived`.
 * @param {string} from - inclusive lower bound `YYYY-MM-DD`.
 * @param {string} to - inclusive upper bound `YYYY-MM-DD`.
 * @returns {Array<object>} matching rows in report order.
 */
export function reportArchivedInRange(archived, from, to) {
  const start = typeof from === 'string' ? from.trim() : ''
  const end = typeof to === 'string' ? to.trim() : ''
  const rows = []
  for (const entry of Array.isArray(archived) ? archived : []) {
    if (entry === null || typeof entry !== 'object') continue
    const date = archiveEntryDate(entry)
    if (date === null) continue
    if (start !== '' && date < start) continue
    if (end !== '' && date > end) continue
    rows.push(entry)
  }
  rows.sort((left, right) => {
    const leftDate = archiveEntryDate(left) ?? ''
    const rightDate = archiveEntryDate(right) ?? ''
    if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1
    return archiveEntryLabel(left).localeCompare(archiveEntryLabel(right))
  })
  return rows
}

/**
 * Normalize the user-entered report root: trimmed, POSIX separators, no
 * trailing slash, defaulting to `人类文档`. Absolute paths are preserved (the
 * dialog warns that DSH's file policy may reject them).
 *
 * @param {unknown} value - raw input value.
 * @returns {string} normalized report root.
 */
export function normalizeReportRoot(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return HELPER_REPORT_ROOT
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized === '' ? HELPER_REPORT_ROOT : normalized
}

/** Trim one path segment (change name / range half) to a POSIX-safe piece. */
function helperReportSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/**
 * Workspace-relative output path of a report:
 * `<root>/<change-name>/index.html` for one change, or
 * `<root>/<from>_<to>/index.html` for a period report.
 *
 * The archive-folder mode is intentionally not handled here: it is a single
 * archive path (`openspec/changes/archive/<dir>/report.html`) owned by the Host.
 *
 * @param {{scope?: 'change'|'range', root?: unknown, changeName?: unknown, from?: unknown, to?: unknown}} [options] - report target.
 * @returns {string} workspace-relative POSIX path.
 */
export function reportOutputRelPath(options) {
  const root = normalizeReportRoot(options?.root)
  if (options?.scope === 'range') {
    const from = helperReportSegment(options?.from)
    const to = helperReportSegment(options?.to)
    return `${root}/${from}_${to}/index.html`
  }
  const change = helperReportSegment(options?.changeName)
  return change === '' ? `${root}/index.html` : `${root}/${change}/index.html`
}

/**
 * Stable, separator-normalized workspace key of the report settings (same
 * shape as the change bindings' key, so per-workspace preferences line up).
 *
 * @param {string} cwd - absolute workspace root.
 * @returns {string} normalized key.
 */
export function reportSettingsCwdKey(cwd) {
  return String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Coerce an arbitrary localStorage value into the report settings shape:
 * `{version: 1, workspaces: {<cwdKey>: {root, mode}}}` where `mode` is
 * `'root'` (report root) or `'archive'` (single-change report inside the
 * archive folder). Unknown keys, malformed workspaces and bad modes degrade to
 * defaults instead of throwing.
 *
 * @param {unknown} value - parsed localStorage value.
 * @returns {{version: 1, workspaces: Record<string, {root: string, mode: 'root'|'archive'}>}} settings.
 */
export function normalizeReportSettings(value) {
  const settings = value !== null && typeof value === 'object' ? value : {}
  const rawWorkspaces = settings.workspaces !== null && typeof settings.workspaces === 'object' ? settings.workspaces : {}
  /** @type {Record<string, {root: string, mode: 'root'|'archive'}>} */
  const workspaces = {}
  for (const [rawCwd, rawWorkspace] of Object.entries(rawWorkspaces)) {
    const key = reportSettingsCwdKey(rawCwd)
    if (key === '') continue
    const workspace = rawWorkspace !== null && typeof rawWorkspace === 'object' ? rawWorkspace : {}
    workspaces[key] = {
      root: normalizeReportRoot(workspace.root),
      mode: workspace.mode === 'archive' ? 'archive' : 'root',
    }
  }
  return { version: 1, workspaces }
}

/**
 * Defensive view of one `report-status` result, always with every field the
 * dialog renders (a pre-0.11 Host answers nothing useful, which must read as
 * "not generated", not crash the dialog).
 *
 * @param {unknown} value - raw `report-status` value.
 * @param {'change'|'range'} [scope] - requested scope (wins over the payload).
 * @returns {{scope: 'change'|'range', exists: boolean, path: string|null, absolutePath: string|null, generatedAt: string|null, source: string, included: Array<{name: string, changePath: string, date: string|null}>, includedCount: number}} status.
 */
export function normalizeReportStatus(value, scope) {
  const status = value !== null && typeof value === 'object' ? value : {}
  const requested = scope === 'range' || scope === 'change' ? scope : status.scope === 'range' ? 'range' : 'change'
  const path = typeof status.path === 'string' && status.path.trim() !== '' ? status.path : null
  const included = Array.isArray(status.included)
    ? status.included
        .filter((item) => item !== null && typeof item === 'object')
        .map((item) => ({
          name: typeof item.name === 'string' ? item.name : '',
          changePath: typeof item.changePath === 'string' ? item.changePath : '',
          date: typeof item.date === 'string' && item.date.trim() !== '' ? item.date : null,
        }))
        .filter((item) => item.name !== '' || item.changePath !== '')
    : []
  // `report-status` reports a period's included count as a number (the prompt
  // action returns the full entry list); expose both without guessing.
  const includedCount =
    typeof status.included === 'number' && Number.isFinite(status.included) && status.included > 0
      ? Math.floor(status.included)
      : included.length
  return {
    scope: requested,
    exists: status.exists === true && path !== null,
    path,
    absolutePath: typeof status.absolutePath === 'string' && status.absolutePath.trim() !== '' ? status.absolutePath : null,
    generatedAt: typeof status.generatedAt === 'string' && status.generatedAt.trim() !== '' ? status.generatedAt : null,
    source: typeof status.source === 'string' ? status.source : '',
    included,
    includedCount,
  }
}
