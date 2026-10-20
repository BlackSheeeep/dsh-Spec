/**
 * Deterministic delta application for OpenSpec native main specs.
 *
 * `planSync` turns a set of delta specs into a set of byte-stable main-spec
 * writes. The engine follows the native merge semantics (design D6):
 *
 * - `ADDED` appends the requirement block at the end of `## Requirements`;
 * - `MODIFIED` replaces the whole named block (body and scenarios);
 * - `REMOVED` deletes the named block;
 * - `RENAMED` retitles the named block in place.
 *
 * Every byte the delta does not mention is preserved exactly: the title, the
 * `## Purpose` section, hand-written prose, unrelated sections, the other
 * requirement blocks, line endings and the trailing-newline convention. Only
 * the blocks an operation touches and the seam directly around them may change.
 *
 * Unsafe input is reported as `ERROR` issues and `ok:false`; a plan that is not
 * `ok` carries no writes, so nothing can be applied by accident.
 *
 * Previewing is pure: `planSync`/`previewSyncPlan` never touch the filesystem.
 * `applySyncPlan` performs the writes through an injectable `io` object (default
 * `node:fs/promises`) so tests can drive it with an in-memory fake. All content
 * is built in memory first; each file is written through a temp file + rename,
 * and any failure restores the previously written originals from in-memory
 * backups and removes the temp files.
 *
 * @module dsh-spec/native/merge
 */

import path from 'node:path'
import * as nodeFsPromises from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { parseDeltaSpec } from './spec.js'

/** Main specs always live under this workspace-relative prefix. */
const MAIN_SPEC_PREFIX = 'openspec/specs/'

/** Requirement identity is the folded `### Requirement:` name. */
const REQUIREMENT_HEADING = /^### Requirement: (.+)$/

/** The `## Requirements` section heading of a main spec. */
const REQUIREMENTS_SECTION = /^##\s+Requirements\s*$/i

/** The `## Purpose` section heading of a main spec / delta spec. */
const PURPOSE_SECTION = /^##\s+Purpose\s*$/i

/** Any other top-level section heading (`## ` but not `### `). */
const TOP_LEVEL_SECTION = /^##(?!#)\s/

/** Native placeholder written into a capability created by archiving. */
const PURPOSE_PLACEHOLDER_PREFIX = 'TBD - created by archiving change '
const PURPOSE_PLACEHOLDER_SUFFIX = '. Update Purpose after archive.'

/** Operation names in their documented order. */
const OPERATION_NAMES = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} line
 * @returns {string} the line without a trailing CR (CRLF files split on "\n")
 */
function stripTrailingCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Fold a requirement name for identity matching: trim and collapse interior
 * whitespace. Matching stays case-sensitive, mirroring the native semantics.
 *
 * @param {unknown} name
 * @returns {string}
 */
function foldRequirementName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Dominant line ending of a text; defaults to LF when there is none to learn
 * from. A CRLF file that picked up a stray LF stays CRLF.
 *
 * @param {string} text
 * @returns {'\n'|'\r\n'}
 */
function detectLineEnding(text) {
  const source = typeof text === 'string' ? text : ''
  const crlf = (source.match(/\r\n/g) ?? []).length
  const lf = (source.match(/(?<!\r)\n/g) ?? []).length
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n'
}

/**
 * @param {unknown} value
 * @returns {boolean} whether the value ends with a line break
 */
function endsWithNewline(value) {
  return typeof value === 'string' && /\r?\n$/.test(value)
}

/**
 * @param {unknown} value
 * @returns {boolean} whether the value ends with a blank line
 */
function endsWithBlankLine(value) {
  return typeof value === 'string' && /(?:\r\n|\n)[ \t]*(?:\r\n|\n)$/.test(value)
}

/**
 * Convert a delta block body to LF, trim trailing whitespace and re-apply the
 * target spec's line ending. Deterministic: same input, same output.
 *
 * @param {string} raw
 * @param {'\n'|'\r\n'} lineEnding
 * @returns {string}
 */
function convertBlockRaw(raw, lineEnding) {
  const normalized = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .trimEnd()
  return lineEnding === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
}

/**
 * Ensure a delta requirement body starts with its canonical heading.
 *
 * @param {string} raw
 * @param {string} name folded requirement name
 * @returns {string}
 */
function ensureRequirementHeading(raw, name) {
  const normalized = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  const firstLine = normalized.split('\n', 1)[0] ?? ''
  if (REQUIREMENT_HEADING.test(firstLine)) return normalized
  if (!normalized) return `### Requirement: ${name}`
  return `### Requirement: ${name}\n\n${normalized}`
}

/**
 * Replace a requirement block's heading line in place, keeping the rest of the
 * block and its line ending exactly.
 *
 * @param {string} raw exact block text
 * @param {string} to new folded requirement name
 * @returns {string}
 */
function retitleBlock(raw, to) {
  const source = String(raw ?? '')
  const newlineIndex = source.indexOf('\n')
  if (newlineIndex === -1) return `### Requirement: ${to}`
  const firstLine = source.slice(0, newlineIndex)
  const rest = source.slice(newlineIndex)
  const carriageReturn = firstLine.endsWith('\r') ? '\r' : ''
  return `### Requirement: ${to}${carriageReturn}${rest}`
}

/**
 * Replace a requirement block's content while keeping the block's exact
 * trailing separator (blank lines before the next block / section end).
 *
 * @param {string} oldRaw
 * @param {string} newContent
 * @returns {string}
 */
function replaceBlockContent(oldRaw, newContent) {
  const source = String(oldRaw ?? '')
  const separator = source.match(/((?:\r?\n[ \t]*)+)$/)
  const trailing = separator ? separator[1] : ''
  return String(newContent).trimEnd() + trailing
}

/**
 * Append one requirement block to a section body, adding exactly the separator
 * needed for a blank line. Existing bytes of `body` are kept.
 *
 * @param {string} body
 * @param {string} blockText
 * @param {'\n'|'\r\n'} lineEnding
 * @returns {string}
 */
function appendBlockToBody(body, blockText, lineEnding) {
  const base = String(body ?? '')
  if (base === '') return blockText
  const stripped = base.replace(/[ \t]+$/, '')
  if (endsWithBlankLine(stripped)) return stripped + blockText
  if (endsWithNewline(stripped)) return stripped + lineEnding + blockText
  return stripped + lineEnding + lineEnding + blockText
}

/**
 * Complete a section body that ended at EOF after a removal: strip the removed
 * block's leftover separator and restore the file's trailing-newline
 * convention.
 *
 * @param {string} text
 * @param {'\n'|'\r\n'} lineEnding
 * @param {boolean} hadTrailingNewline
 * @returns {string}
 */
function finishAtEof(text, lineEnding, hadTrailingNewline) {
  const trimmed = String(text ?? '').replace(/[ \t\r\n]+$/, '')
  return trimmed + (hadTrailingNewline ? lineEnding : '')
}

/**
 * Ensure `body` ends with a blank line before a following top-level section.
 *
 * @param {string} body
 * @param {'\n'|'\r\n'} lineEnding
 * @returns {string}
 */
function ensureBlankLineBeforeSection(body, lineEnding) {
  if (endsWithBlankLine(body)) return body
  if (endsWithNewline(body)) return body + lineEnding
  return body + lineEnding + lineEnding
}

/**
 * Extract the body of the first `## Purpose` section from a delta spec.
 * A delta Purpose only seeds a brand-new capability main spec.
 *
 * @param {string} text
 * @returns {string} trimmed purpose body, or '' when absent/empty
 */
function extractPurposeFromDelta(text) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (PURPOSE_SECTION.test(lines[index])) {
      start = index
      break
    }
  }
  if (start === -1) return ''
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (TOP_LEVEL_SECTION.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} relPath
 * @returns {string} POSIX-style path
 */
function toPosixPath(relPath) {
  return String(relPath ?? '').replace(/\\/g, '/')
}

/**
 * @param {string} p
 * @returns {boolean} whether the path is absolute or drive-qualified
 */
function isAbsoluteLike(p) {
  return p.startsWith('/') || /^[A-Za-z]:/.test(p)
}

/**
 * @param {string} p
 * @returns {boolean} whether any segment escapes its parent
 */
function hasTraversalSegment(p) {
  return p.split('/').some((segment) => segment === '..')
}

/**
 * Validate a capability id (the path between `specs/` and `/spec.md`).
 *
 * @param {string} capability
 * @param {string} relPath original path, for messages
 * @returns {{ capability: string }|{ error: string }}
 */
function validateCapabilityId(capability, relPath) {
  if (capability === '') {
    return { error: `path must name a capability below specs/: "${relPath}"` }
  }
  for (const segment of capability.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { error: `path has an unsafe segment: "${relPath}"` }
    }
    if (/[\\:*?"<>|]/.test(segment) || /[\u0000-\u001f]/.test(segment)) {
      return { error: `path has an unsafe segment: "${relPath}"` }
    }
  }
  return { capability }
}

/**
 * Derive the capability id from a spec path (`<...>/specs/<capability>/spec.md`).
 *
 * @param {unknown} relPath workspace-relative path
 * @param {{ allowBareMainSpec?: boolean }} [options]
 * @returns {{ capability: string }|{ error: string }}
 */
function deriveCapability(relPath, options = {}) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    return { error: 'path is empty' }
  }
  let normalized = toPosixPath(relPath)
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.includes('\0')) return { error: 'path contains a NUL byte' }
  if (isAbsoluteLike(normalized)) {
    return { error: `path must be workspace-relative, got "${relPath}"` }
  }
  if (hasTraversalSegment(normalized)) {
    return { error: `path contains a ".." segment: "${relPath}"` }
  }
  const suffix = '/spec.md'
  const marker = '/specs/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex !== -1) {
    const rest = normalized.slice(markerIndex + marker.length)
    if (!rest.endsWith(suffix)) {
      return { error: `path must point at specs/<capability>/spec.md: "${relPath}"` }
    }
    return validateCapabilityId(rest.slice(0, -suffix.length), relPath)
  }
  if (normalized.startsWith('specs/')) {
    const rest = normalized.slice('specs/'.length)
    if (!rest.endsWith(suffix)) {
      return { error: `path must point at specs/<capability>/spec.md: "${relPath}"` }
    }
    return validateCapabilityId(rest.slice(0, -suffix.length), relPath)
  }
  if (options.allowBareMainSpec && normalized.endsWith(suffix)) {
    return validateCapabilityId(normalized.slice(0, -suffix.length), relPath)
  }
  return { error: `path must live under a specs/ directory: "${relPath}"` }
}

/**
 * Validate one plan write path: workspace-relative, traversal-free, and a main
 * spec file under `openspec/specs/**`. Throws; used before any write.
 *
 * @param {unknown} relPath
 * @returns {string} normalized path
 */
function validateMainSpecWritePath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('write path must be a non-empty string')
  }
  const normalized = toPosixPath(relPath)
  if (isAbsoluteLike(normalized)) {
    throw new Error(`write path must be workspace-relative: ${relPath}`)
  }
  if (hasTraversalSegment(normalized)) {
    throw new Error(`write path contains a ".." segment: ${relPath}`)
  }
  if (normalized.split('/').some((segment) => segment === '' || segment === '.')) {
    throw new Error(`write path is not normalized: ${relPath}`)
  }
  if (!normalized.startsWith(MAIN_SPEC_PREFIX)) {
    throw new Error(`write path must live under ${MAIN_SPEC_PREFIX}: ${relPath}`)
  }
  const derived = deriveCapability(normalized, { allowBareMainSpec: false })
  if ('error' in derived) {
    throw new Error(`write path is not a main spec: ${derived.error}`)
  }
  return normalized
}

/**
 * Resolve a workspace-relative path and prove it stays inside the workspace.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} relPath workspace-relative POSIX path
 * @returns {string} absolute path
 */
function toWorkspaceAbsolute(cwd, relPath) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('cwd must be a non-empty absolute workspace path')
  }
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, relPath)
  const relative = path.relative(root, absolute)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`path escapes the workspace: ${relPath}`)
  }
  return absolute
}

/**
 * @param {unknown} error
 * @returns {boolean} whether the error is a missing-path error
 */
function isMissingPathError(error) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// ---------------------------------------------------------------------------
// Main spec scanning (byte-exact block boundaries)
// ---------------------------------------------------------------------------

/**
 * Scan a main spec into exact byte slices. Everything is kept as the original
 * text: `prefix` (through the `## Requirements` line), `preamble` (after that
 * line up to the first block), each requirement block's exact raw slice
 * (including its trailing separator) and `tail` (from the next top-level
 * section heading to EOF).
 *
 * @param {string} text
 * @returns {{
 *   hasRequirementsSection: boolean,
 *   lineEnding: '\n'|'\r\n',
 *   hadTrailingNewline: boolean,
 *   prefix: string,
 *   preamble: string,
 *   blocks: Array<{name: string, raw: string}>,
 *   tail: string
 * }}
 */
function scanMainSpec(text) {
  const source = typeof text === 'string' ? text : ''
  const lineEnding = detectLineEnding(source)
  const hadTrailingNewline = source.endsWith('\n')
  const lines = source.split('\n')
  const lineStarts = new Array(lines.length)
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    lineStarts[index] = offset
    offset += lines[index].length + 1
  }

  let headerIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (REQUIREMENTS_SECTION.test(stripTrailingCr(lines[index]))) {
      headerIndex = index
      break
    }
  }
  if (headerIndex === -1) {
    return {
      hasRequirementsSection: false,
      lineEnding,
      hadTrailingNewline,
      prefix: source,
      preamble: '',
      blocks: [],
      tail: '',
    }
  }

  const headerLineStart = lineStarts[headerIndex]
  const headerLineEnd = Math.min(headerLineStart + lines[headerIndex].length + 1, source.length)
  let sectionEndIndex = lines.length
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (TOP_LEVEL_SECTION.test(stripTrailingCr(lines[index]))) {
      sectionEndIndex = index
      break
    }
  }
  const sectionEndOffset = sectionEndIndex < lines.length ? lineStarts[sectionEndIndex] : source.length

  const blockLineIndexes = []
  for (let index = headerIndex + 1; index < sectionEndIndex; index += 1) {
    if (REQUIREMENT_HEADING.test(stripTrailingCr(lines[index]))) blockLineIndexes.push(index)
  }
  const blocks = []
  for (let index = 0; index < blockLineIndexes.length; index += 1) {
    const start = lineStarts[blockLineIndexes[index]]
    const end = index + 1 < blockLineIndexes.length
      ? lineStarts[blockLineIndexes[index + 1]]
      : sectionEndOffset
    const headingLine = stripTrailingCr(lines[blockLineIndexes[index]])
    const match = REQUIREMENT_HEADING.exec(headingLine)
    blocks.push({
      name: foldRequirementName(match ? match[1] : ''),
      raw: source.slice(start, end),
    })
  }

  const firstBlockStart = blockLineIndexes.length
    ? lineStarts[blockLineIndexes[0]]
    : sectionEndOffset
  return {
    hasRequirementsSection: true,
    lineEnding,
    hadTrailingNewline,
    prefix: source.slice(0, headerLineEnd),
    preamble: source.slice(headerLineEnd, firstBlockStart),
    blocks,
    tail: source.slice(sectionEndOffset),
  }
}

// ---------------------------------------------------------------------------
// Delta normalisation
// ---------------------------------------------------------------------------

/**
 * Create an issue collector that de-duplicates identical issues, keeping the
 * native issue shape `{ level, path?, line?, message }`.
 *
 * @returns {{ issues: Array<{level: string, path?: string, line?: number, message: string}>, push: Function }}
 */
function createIssueCollector() {
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
  return { issues, push }
}

/**
 * @param {Array<{level: string}>} issues
 * @returns {number} number of ERROR issues
 */
function countErrors(issues) {
  let count = 0
  for (const issue of issues) {
    if (issue && issue.level === 'ERROR') count += 1
  }
  return count
}

/**
 * @param {string} raw
 * @returns {string} requirement name read from the block's heading line
 */
function requirementNameFromRaw(raw) {
  const firstLine = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n', 1)[0] ?? ''
  const match = REQUIREMENT_HEADING.exec(firstLine)
  return match ? foldRequirementName(match[1]) : ''
}

/**
 * Normalise one delta requirement entry (`{ name, raw, text, scenarios }` or a
 * bare name string) into `{ name, raw }`.
 *
 * @param {unknown} entry
 * @param {string} operation
 * @param {{ path: string }} delta
 * @param {ReturnType<typeof createIssueCollector>} collector
 * @returns {{name: string, raw: string}|null}
 */
function normalizeRequirementEntry(entry, operation, delta, collector) {
  if (typeof entry === 'string') {
    const name = foldRequirementName(entry)
    if (!name) return null
    return { name, raw: `### Requirement: ${name}` }
  }
  if (!entry || typeof entry !== 'object') {
    collector.push('ERROR', `${operation} requirement entry is not an object`, { path: delta.path })
    return null
  }
  const record = /** @type {Record<string, unknown>} */ (entry)
  let raw = typeof record.raw === 'string' ? record.raw : ''
  const name = foldRequirementName(record.name ?? requirementNameFromRaw(raw))
  if (!name) {
    collector.push(
      'ERROR',
      `${operation} requirement entry has no requirement name`,
      { path: delta.path },
    )
    return null
  }
  if (!raw.trim()) {
    const body = typeof record.text === 'string' ? record.text.trim() : ''
    const scenarios = Array.isArray(record.scenarios) ? record.scenarios : []
    const scenarioRaws = scenarios
      .map((scenario) => (scenario && typeof scenario === 'object'
        ? String(/** @type {any} */ (scenario).raw ?? '')
        : ''))
      .filter((text) => text.trim() !== '')
    raw = `### Requirement: ${name}`
    if (body) raw += `\n\n${body}`
    if (scenarioRaws.length) raw += `\n\n${scenarioRaws.join('\n\n')}`
  }
  return { name, raw }
}

/**
 * Normalise the four operation lists of one delta into `{ name, raw }` entries.
 *
 * @param {unknown} operations
 * @param {{ path: string }} delta
 * @param {ReturnType<typeof createIssueCollector>} collector
 * @returns {{
 *   ADDED: Array<{name: string, raw: string}>,
 *   MODIFIED: Array<{name: string, raw: string}>,
 *   REMOVED: string[],
 *   RENAMED: Array<{from: string, to: string}>
 * }}
 */
function normalizeOperations(operations, delta, collector) {
  const source = operations && typeof operations === 'object'
    ? /** @type {Record<string, unknown>} */ (operations)
    : {}
  const normalized = { ADDED: [], MODIFIED: [], REMOVED: [], RENAMED: [] }
  for (const operation of ['ADDED', 'MODIFIED']) {
    const list = Array.isArray(source[operation]) ? source[operation] : []
    for (const entry of list) {
      const requirement = normalizeRequirementEntry(entry, operation, delta, collector)
      if (requirement) normalized[operation].push(requirement)
    }
  }
  const removed = Array.isArray(source.REMOVED) ? source.REMOVED : []
  for (const entry of removed) {
    const name = foldRequirementName(
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? /** @type {any} */ (entry).name
          : '',
    )
    if (!name) {
      collector.push('ERROR', 'REMOVED requirement entry has no requirement name', { path: delta.path })
      continue
    }
    normalized.REMOVED.push(name)
  }
  const renamed = Array.isArray(source.RENAMED) ? source.RENAMED : []
  for (const entry of renamed) {
    const record = entry && typeof entry === 'object' ? /** @type {any} */ (entry) : {}
    const from = foldRequirementName(record.from)
    const to = foldRequirementName(record.to)
    if (!from || !to) {
      collector.push(
        'ERROR',
        'RENAMED entry must declare both FROM and TO requirement names',
        { path: delta.path },
      )
      continue
    }
    normalized.RENAMED.push({ from, to })
  }
  return normalized
}

/**
 * Normalise one delta input into `{ path, text, purpose, ops }`, parsing the
 * text with `parseDeltaSpec` when the caller did not supply parsed operations.
 *
 * @param {unknown} input
 * @param {ReturnType<typeof createIssueCollector>} collector
 * @returns {{path: string, text: string, purpose: string, ops: ReturnType<typeof normalizeOperations>}|null}
 */
function normalizeDelta(input, collector) {
  if (!input || typeof input !== 'object') {
    collector.push('ERROR', 'delta entry is not an object')
    return null
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const deltaPath = typeof record.path === 'string' ? record.path : ''
  if (!deltaPath) {
    collector.push('ERROR', 'delta entry is missing its workspace-relative path')
    return null
  }
  const text = typeof record.text === 'string' ? record.text : ''
  let parsed = record.parsed
  if (!parsed || typeof parsed !== 'object' || !('operations' in /** @type {object} */ (parsed))) {
    if (!text) {
      collector.push('ERROR', 'delta entry has neither parsed operations nor text', { path: deltaPath })
      return null
    }
    try {
      parsed = parseDeltaSpec(text)
    } catch (error) {
      collector.push(
        'ERROR',
        `failed to parse delta spec: ${error instanceof Error ? error.message : String(error)}`,
        { path: deltaPath },
      )
      return null
    }
  }
  const parsedRecord = /** @type {Record<string, unknown>} */ (parsed)
  const parserIssues = Array.isArray(parsedRecord.issues) ? parsedRecord.issues : []
  for (const issue of parserIssues) {
    if (!issue || typeof issue !== 'object') continue
    const level = issue.level === 'ERROR' || issue.level === 'INFO' ? issue.level : 'WARNING'
    collector.push(level, String(issue.message ?? 'delta parser issue'), {
      path: typeof issue.path === 'string' && issue.path ? issue.path : deltaPath,
      line: typeof issue.line === 'number' ? issue.line : undefined,
    })
  }
  const ops = normalizeOperations(parsedRecord.operations, { path: deltaPath }, collector)
  const operationCount = OPERATION_NAMES.reduce((total, name) => total + ops[name].length, 0)
  if (operationCount === 0) {
    collector.push(
      'WARNING',
      'delta contains no ADDED/MODIFIED/REMOVED/RENAMED requirements; nothing to apply',
      { path: deltaPath },
    )
  }
  return {
    path: deltaPath,
    text,
    purpose: extractPurposeFromDelta(text),
    ops,
  }
}

// ---------------------------------------------------------------------------
// Applying operations to the in-memory block model
// ---------------------------------------------------------------------------

/**
 * Append the operations of one delta to one capability's in-memory block list.
 * Each operation is guarded; an unsafe operation records an ERROR and leaves the
 * model untouched so later operations can still be reported deterministically.
 *
 * @param {object} state
 * @param {{path: string, ops: ReturnType<typeof normalizeOperations>}} delta
 * @param {Array<{name: string, fold: string, raw: string}>} state.blocks
 * @param {Map<string, {name: string, fold: string, raw: string}>} state.blockMap
 * @param {Array<{name: string, raw: string}>} state.appended
 * @param {Set<string>} state.appendedNames
 * @param {{ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number}} state.stats
 * @param {Array<{action: string, name?: string, from?: string, to?: string}>} state.details
 * @param {{eofSeamChanged: boolean}} state.flags
 * @param {string} mainPath
 * @param {ReturnType<typeof createIssueCollector>} collector
 * @returns {void}
 */
function applyDeltaOperations(state, delta, mainPath, collector) {
  const { blocks, blockMap, appended, appendedNames, stats, details, flags } = state
  const operations = delta.ops

  // RENAMED: retitle in place, then later operations see the new name.
  for (const rename of operations.RENAMED) {
    const from = foldRequirementName(rename.from)
    const to = foldRequirementName(rename.to)
    const block = blockMap.get(from)
    if (!block) {
      collector.push(
        'ERROR',
        `RENAMED failed: requirement "${from}" does not exist in the main spec`,
        { path: mainPath },
      )
      continue
    }
    if (from !== to && blockMap.has(to)) {
      collector.push(
        'ERROR',
        `RENAMED failed: requirement "${to}" already exists in the main spec`,
        { path: mainPath },
      )
      continue
    }
    blockMap.delete(from)
    block.raw = retitleBlock(block.raw, to)
    block.name = to
    block.fold = to
    blockMap.set(to, block)
    stats.RENAMED += 1
    details.push({ action: 'RENAMED', from, to })
  }

  // REMOVED: delete the whole block and its separator.
  for (const name of operations.REMOVED) {
    const fold = foldRequirementName(name)
    const block = blockMap.get(fold)
    if (!block) {
      collector.push(
        'ERROR',
        `REMOVED failed: requirement "${fold}" does not exist in the main spec`,
        { path: mainPath },
      )
      continue
    }
    const index = blocks.indexOf(block)
    blocks.splice(index, 1)
    blockMap.delete(fold)
    if (index === blocks.length) flags.eofSeamChanged = true
    stats.REMOVED += 1
    details.push({ action: 'REMOVED', name: fold })
  }

  // MODIFIED: replace the whole block, keeping its position and separator.
  for (const requirement of operations.MODIFIED) {
    const fold = requirement.name
    const block = blockMap.get(fold)
    if (!block) {
      collector.push(
        'ERROR',
        `MODIFIED failed: requirement "${fold}" does not exist in the main spec`,
        { path: mainPath },
      )
      continue
    }
    block.raw = replaceBlockContent(
      block.raw,
      ensureRequirementHeading(requirement.raw, fold),
    )
    stats.MODIFIED += 1
    details.push({ action: 'MODIFIED', name: fold })
  }

  // ADDED: append in delta order, rejecting collisions with the merged model.
  for (const requirement of operations.ADDED) {
    const fold = requirement.name
    if (blockMap.has(fold) || appendedNames.has(fold)) {
      collector.push(
        'ERROR',
        `ADDED failed: requirement "${fold}" already exists in the main spec`,
        { path: mainPath },
      )
      continue
    }
    appended.push({ name: fold, raw: ensureRequirementHeading(requirement.raw, fold) })
    appendedNames.add(fold)
    stats.ADDED += 1
    details.push({ action: 'ADDED', name: fold })
  }
}

/**
 * Cross-section conflict checks for one delta. Duplicate names inside a section
 * and a name claimed by two different sections are unsafe and rejected.
 *
 * @param {{path: string, ops: ReturnType<typeof normalizeOperations>}} delta
 * @param {ReturnType<typeof createIssueCollector>} collector
 * @returns {void}
 */
function validateDeltaOperations(delta, collector) {
  const issues = []
  const pushIssue = (message) => {
    issues.push(message)
    collector.push('ERROR', message, { path: delta.path })
  }
  const sections = new Map()
  const claim = (name, section) => {
    const existing = sections.get(name)
    if (existing === undefined) {
      sections.set(name, section)
      return
    }
    if (existing === section) {
      pushIssue(`duplicate requirement "${name}" in ## ${section} Requirements`)
    } else {
      pushIssue(`requirement "${name}" appears in multiple sections (${existing} and ${section})`)
    }
  }
  for (const requirement of delta.ops.ADDED) claim(requirement.name, 'ADDED')
  for (const requirement of delta.ops.MODIFIED) claim(requirement.name, 'MODIFIED')
  for (const name of delta.ops.REMOVED) claim(name, 'REMOVED')
  const renamedFrom = new Set()
  const renamedTo = new Set()
  for (const rename of delta.ops.RENAMED) {
    if (renamedFrom.has(rename.from)) {
      pushIssue(`duplicate FROM "${rename.from}" in ## RENAMED Requirements`)
    }
    if (renamedTo.has(rename.to)) {
      pushIssue(`duplicate TO "${rename.to}" in ## RENAMED Requirements`)
    }
    renamedFrom.add(rename.from)
    renamedTo.add(rename.to)
  }
  for (const from of renamedFrom) {
    if (sections.has(from)) {
      pushIssue(
        `requirement "${from}" appears in multiple sections (RENAMED and ${sections.get(from)})`,
      )
    }
  }
  for (const to of renamedTo) {
    if (sections.has(to)) {
      pushIssue(
        `requirement "${to}" appears in multiple sections (RENAMED and ${sections.get(to)})`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Rebuild an existing main spec from the scanned slices plus appended blocks.
 *
 * @param {ReturnType<typeof scanMainSpec>} scan
 * @param {Array<{raw: string}>} blocks
 * @param {string[]} appendedTexts already converted to the spec's line ending
 * @param {boolean} eofSeamChanged a trailing block was removed at EOF
 * @returns {string}
 */
function buildExistingMainSpec(scan, blocks, appendedTexts, eofSeamChanged) {
  const lineEnding = scan.lineEnding
  let body = scan.prefix + scan.preamble + blocks.map((block) => block.raw).join('')
  for (const text of appendedTexts) {
    body = appendBlockToBody(body, text, lineEnding)
  }
  if (scan.tail !== '') {
    if (appendedTexts.length > 0) return body + lineEnding + lineEnding + scan.tail
    if (blocks.length === 0) return ensureBlankLineBeforeSection(body, lineEnding) + scan.tail
    return body + scan.tail
  }
  if (appendedTexts.length > 0) {
    return body + (scan.hadTrailingNewline ? lineEnding : '')
  }
  if (blocks.length === 0 || eofSeamChanged) {
    return finishAtEof(body, lineEnding, scan.hadTrailingNewline)
  }
  return body
}

/**
 * Add a `## Requirements` section to a main spec that does not have one.
 *
 * @param {ReturnType<typeof scanMainSpec>} scan
 * @param {string[]} appendedTexts already converted to the spec's line ending
 * @returns {string}
 */
function buildMissingRequirementsSection(scan, appendedTexts) {
  const lineEnding = scan.lineEnding
  const base = scan.prefix
  let text = base
  if (base !== '') {
    if (endsWithBlankLine(base)) {
      // keep the existing blank line
    } else if (endsWithNewline(base)) {
      text = base + lineEnding
    } else {
      text = base + lineEnding + lineEnding
    }
  }
  text += '## Requirements' + lineEnding + lineEnding + appendedTexts.join(lineEnding + lineEnding)
  return text + (scan.hadTrailingNewline ? lineEnding : '')
}

/**
 * Deterministically serialize a complete main spec: heading, Purpose and
 * requirement blocks separated by one blank line, LF newlines, one trailing
 * newline.
 *
 * @param {{
 *   title: string,
 *   purpose: string,
 *   requirements?: Array<string|{name?: string, raw?: string, text?: string, scenarios?: Array<{raw?: string}>}>
 * }} input
 * @returns {string}
 */
export function serializeMainSpec(input) {
  const record = input && typeof input === 'object' ? input : {}
  const title = String(record.title ?? '').trim()
  if (!title) throw new Error('serializeMainSpec requires a non-empty title')
  const purpose = String(record.purpose ?? '').trim()
  const entries = Array.isArray(record.requirements) ? record.requirements : []

  const blocks = []
  for (const entry of entries) {
    let raw = ''
    if (typeof entry === 'string') {
      raw = entry
    } else if (entry && typeof entry === 'object') {
      const item = /** @type {Record<string, unknown>} */ (entry)
      raw = typeof item.raw === 'string' ? item.raw : ''
      if (!raw.trim()) {
        const name = foldRequirementName(item.name)
        const body = typeof item.text === 'string' ? item.text.trim() : ''
        const scenarios = Array.isArray(item.scenarios) ? item.scenarios : []
        const scenarioRaws = scenarios
          .map((scenario) => (scenario && typeof scenario === 'object'
            ? String(/** @type {any} */ (scenario).raw ?? '')
            : ''))
          .filter((scenario) => scenario.trim() !== '')
        if (name) {
          raw = `### Requirement: ${name}`
          if (body) raw += `\n\n${body}`
          if (scenarioRaws.length) raw += `\n\n${scenarioRaws.join('\n\n')}`
        }
      }
    }
    const normalized = String(raw).replace(/\r\n?/g, '\n').trim()
    if (normalized) blocks.push(normalized)
  }

  const parts = [`# ${title} Specification`, '', '## Purpose', purpose, '', '## Requirements']
  for (const block of blocks) parts.push('', block)
  return parts.join('\n').trimEnd() + '\n'
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

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

/**
 * Render the human-readable (Chinese) dry-run preview for a sync plan.
 *
 * @param {{
 *   changeName?: string,
 *   ok: boolean,
 *   writes: Array<{path: string, action: string, summary?: string}>,
 *   summary?: {ADDED?: number, MODIFIED?: number, REMOVED?: number, RENAMED?: number},
 *   issues?: Array<{level: string, path?: string, line?: number, message: string}>
 * }} plan
 * @returns {{text: string, files: string[]}}
 */
export function previewSyncPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('previewSyncPlan requires a plan object')
  }
  const writes = Array.isArray(plan.writes) ? plan.writes : []
  const issues = Array.isArray(plan.issues) ? plan.issues : []
  const summary = plan.summary && typeof plan.summary === 'object' ? plan.summary : {}
  const lines = []
  lines.push(plan.changeName ? `变更 ${plan.changeName} 同步预览` : '同步预览')
  lines.push('')
  if (writes.length > 0) {
    lines.push(`主 specs 变更（${writes.length} 个文件）：`)
    for (const write of writes) {
      const label = write.action === 'create' ? '创建' : write.action === 'remove' ? '移除' : '更新'
      lines.push(`  - ${label} ${write.path}`)
      if (write.summary) lines.push(`      ${write.summary}`)
    }
  } else {
    lines.push('主 specs 无变更。')
  }
  lines.push('')
  lines.push(
    `操作统计：ADDED ${summary.ADDED ?? 0}，MODIFIED ${summary.MODIFIED ?? 0}，` +
    `REMOVED ${summary.REMOVED ?? 0}，RENAMED ${summary.RENAMED ?? 0}`,
  )
  const errors = issues.filter((issue) => issue.level === 'ERROR')
  const warnings = issues.filter((issue) => issue.level !== 'ERROR')
  if (warnings.length > 0) {
    lines.push('')
    lines.push(`警告（${warnings.length}）：`)
    for (const issue of warnings) lines.push(`  - ${formatIssue(issue)}`)
  }
  if (errors.length > 0) {
    lines.push('')
    lines.push(`错误（${errors.length}），本次不会写入任何文件：`)
    for (const issue of errors) lines.push(`  - ${formatIssue(issue)}`)
  }
  lines.push('')
  lines.push(plan.ok ? '确认后执行写入（--yes）。' : '存在错误，已拒绝同步。')
  return { text: lines.join('\n'), files: writes.map((write) => write.path) }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Plan the deterministic application of a change's delta specs to the main
 * specs. Pure: no filesystem access, no side effects.
 *
 * @param {{
 *   changeName: string,
 *   mainSpecs?: Array<{path: string, text: string}>,
 *   deltas?: Array<{path: string, text?: string, parsed?: object}>,
 *   retireCapabilities?: boolean
 * }} input
 * @returns {{
 *   ok: boolean,
 *   changeName: string,
 *   issues: Array<{level: string, path?: string, line?: number, message: string}>,
 *   writes: Array<{path: string, action: 'create'|'update'|'remove', content: string, summary: string}>,
 *   summary: {ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number}
 * }}
 */
export function planSync(input) {
  const options = input && typeof input === 'object' ? input : {}
  const collector = createIssueCollector()
  const summary = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }
  const writes = []
  const changeName = typeof options.changeName === 'string' ? options.changeName.trim() : ''
  if (!changeName) {
    collector.push('ERROR', 'changeName is required to plan a sync')
  }

  // Index the existing main specs by capability.
  const mainByCapability = new Map()
  const mainByCapabilityLower = new Map()
  const rawMainSpecs = Array.isArray(options.mainSpecs) ? options.mainSpecs : []
  for (const mainSpec of rawMainSpecs) {
    if (!mainSpec || typeof mainSpec !== 'object') {
      collector.push('WARNING', 'ignoring main spec entry that is not an object')
      continue
    }
    const record = /** @type {Record<string, unknown>} */ (mainSpec)
    if (typeof record.path !== 'string' || !record.path) {
      collector.push('WARNING', 'ignoring main spec entry without a path')
      continue
    }
    const derived = deriveCapability(record.path, { allowBareMainSpec: true })
    if ('error' in derived) {
      collector.push('WARNING', `ignoring main spec at an unsupported path: ${derived.error}`, {
        path: record.path,
      })
      continue
    }
    const text = typeof record.text === 'string' ? record.text : ''
    const entry = { path: record.path, text, capability: derived.capability }
    if (mainByCapability.has(derived.capability)) {
      collector.push(
        'WARNING',
        `duplicate main spec entries for capability "${derived.capability}"; keeping the first`,
        { path: record.path },
      )
      continue
    }
    mainByCapability.set(derived.capability, entry)
    const lower = derived.capability.toLowerCase()
    if (!mainByCapabilityLower.has(lower)) mainByCapabilityLower.set(lower, entry)
  }

  // Normalise the deltas and group them by capability.
  const rawDeltas = Array.isArray(options.deltas) ? options.deltas : []
  if (rawDeltas.length === 0) {
    collector.push('WARNING', 'no delta specs were supplied; nothing to sync')
  }
  const normalizedDeltas = []
  for (const rawDelta of rawDeltas) {
    const delta = normalizeDelta(rawDelta, collector)
    if (!delta) continue
    validateDeltaOperations(delta, collector)
    normalizedDeltas.push(delta)
  }

  const groups = new Map()
  for (const delta of normalizedDeltas) {
    const derived = deriveCapability(delta.path)
    if ('error' in derived) {
      collector.push('ERROR', `delta path is unsafe or not a capability spec: ${derived.error}`, {
        path: delta.path,
      })
      continue
    }
    if (!groups.has(derived.capability)) {
      groups.set(derived.capability, { capability: derived.capability, deltas: [] })
    }
    groups.get(derived.capability).deltas.push(delta)
  }

  const retireCapabilities = options.retireCapabilities === true
  for (const group of groups.values()) {
    planCapability({
      capability: group.capability,
      deltas: group.deltas,
      changeName,
      retireCapabilities,
      mainByCapability,
      mainByCapabilityLower,
      collector,
      summary,
      writes,
    })
  }

  // Two capabilities that resolve to the same main spec would produce two
  // writes for one file (or, on Windows, a case-insensitive collision between
  // two new capabilities). Reject that deterministically.
  const writePaths = new Map()
  for (const write of writes) {
    const key = toPosixPath(write.path).toLowerCase()
    const previous = writePaths.get(key)
    if (previous !== undefined) {
      collector.push(
        'ERROR',
        `multiple planned writes target the same main spec: "${write.path}"`,
        { path: write.path },
      )
    } else {
      writePaths.set(key, write.path)
    }
  }

  const ok = countErrors(collector.issues) === 0
  if (!ok) writes.length = 0
  return { ok, changeName, issues: collector.issues, writes, summary }
}

/**
 * Describe one plan write's operations as a deterministic English sentence.
 *
 * @param {Array<{action: string, name?: string, from?: string, to?: string}>} details
 * @returns {string}
 */
function describeOperations(details) {
  const pieces = []
  for (const operation of OPERATION_NAMES) {
    const items = details.filter((detail) => detail.action === operation)
    if (items.length === 0) continue
    const names = items.map((detail) => (operation === 'RENAMED'
      ? `"${detail.from}" -> "${detail.to}"`
      : `"${detail.name}"`))
    pieces.push(`${operation} ${items.length}: ${names.join(', ')}`)
  }
  return pieces.length > 0 ? pieces.join('; ') : 'no requirement changes'
}

/**
 * Plan the writes for one capability. Mutates `summary` and `writes`.
 *
 * @param {object} context
 * @returns {void}
 */
function planCapability(context) {
  const {
    capability,
    deltas,
    changeName,
    retireCapabilities,
    mainByCapability,
    mainByCapabilityLower,
    collector,
    summary,
    writes,
  } = context
  const errorsBefore = countErrors(collector.issues)
  const stats = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }
  const details = []
  const flags = { eofSeamChanged: false }

  let mainEntry = mainByCapability.get(capability) ?? null
  if (!mainEntry) {
    const lowerMatch = mainByCapabilityLower.get(capability.toLowerCase())
    if (lowerMatch) {
      collector.push(
        'WARNING',
        `capability "${capability}" differs in case from the existing main spec; using "${lowerMatch.capability}"`,
        { path: lowerMatch.path },
      )
      mainEntry = lowerMatch
    }
  }

  let scan = null
  if (mainEntry) {
    try {
      scan = scanMainSpec(mainEntry.text)
    } catch (error) {
      collector.push(
        'ERROR',
        `failed to parse the main spec: ${error instanceof Error ? error.message : String(error)}`,
        { path: mainEntry.path },
      )
      return
    }
  }

  const blocks = scan
    ? scan.blocks.map((block) => ({ name: block.name, fold: block.name, raw: block.raw }))
    : []
  const blockMap = new Map()
  for (const block of blocks) {
    if (blockMap.has(block.fold)) {
      collector.push('ERROR', `main spec contains duplicate requirement "${block.name}"`, {
        path: mainEntry ? mainEntry.path : undefined,
      })
      continue
    }
    blockMap.set(block.fold, block)
  }
  const model = {
    blocks,
    blockMap,
    appended: [],
    appendedNames: new Set(),
    stats,
    details,
    flags,
  }

  for (const delta of deltas) {
    applyDeltaOperations(model, delta, mainEntry ? mainEntry.path : `${MAIN_SPEC_PREFIX}${capability}/spec.md`, collector)
  }

  for (const operation of OPERATION_NAMES) summary[operation] += stats[operation]

  if (countErrors(collector.issues) > errorsBefore) return

  // An empty delta (or one whose every operation failed safely) must not
  // rewrite anything.
  if (
    model.appended.length === 0
    && stats.MODIFIED === 0
    && stats.REMOVED === 0
    && stats.RENAMED === 0
  ) {
    return
  }

  if (mainEntry) {
    const mainPath = mainEntry.path
    if (stats.REMOVED > 0 && model.appended.length === 0 && blocks.length === 0 && retireCapabilities) {
      writes.push({
        path: mainPath,
        action: 'remove',
        content: '',
        summary: `remove capability "${capability}": all requirements removed (retire_capabilities)`,
      })
      return
    }
    const lineEnding = scan.lineEnding
    const appendedTexts = model.appended.map((requirement) => (
      convertBlockRaw(ensureRequirementHeading(requirement.raw, requirement.name), lineEnding)
    ))
    let content
    if (scan.hasRequirementsSection) {
      content = buildExistingMainSpec(scan, blocks, appendedTexts, flags.eofSeamChanged)
    } else {
      content = buildMissingRequirementsSection(scan, appendedTexts)
    }
    if (content === mainEntry.text) {
      collector.push('INFO', `capability "${capability}" is already in sync; no file changes`, {
        path: mainPath,
      })
      return
    }
    writes.push({
      path: mainPath,
      action: 'update',
      content,
      summary: `update capability "${capability}": ${describeOperations(details)}`,
    })
    return
  }

  if (model.appended.length === 0) return
  const purposeFromDelta = deltas
    .map((delta) => delta.purpose)
    .find((purpose) => typeof purpose === 'string' && purpose !== '') ?? ''
  const purpose = purposeFromDelta
    || `${PURPOSE_PLACEHOLDER_PREFIX}${changeName}${PURPOSE_PLACEHOLDER_SUFFIX}`
  const requirements = model.appended.map((requirement) => (
    convertBlockRaw(ensureRequirementHeading(requirement.raw, requirement.name), '\n')
  ))
  const content = serializeMainSpec({ title: capability, purpose, requirements })
  const purposeNote = purposeFromDelta ? 'Purpose from delta' : 'placeholder Purpose'
  writes.push({
    path: `${MAIN_SPEC_PREFIX}${capability}/spec.md`,
    action: 'create',
    content,
    summary: `create capability "${capability}": ${describeOperations(details)}; ${purposeNote}`,
  })
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a sync plan to the workspace. Every filesystem operation goes through
 * the injected `io` object (default `node:fs/promises`).
 *
 * Safety: the plan must be `ok`; every write path must be a workspace-relative
 * main spec; content is fully built before writing; each file is written via a
 * temp file + rename; a failure restores previously written originals from
 * in-memory backups and removes leftover temp files before rethrowing.
 *
 * @param {{
 *   cwd: string,
 *   plan: {ok: boolean, writes: Array<{path: string, action: string, content: string}>},
 *   io?: object
 * }} input
 * @returns {Promise<{written: string[]}>}
 */
export async function applySyncPlan(input) {
  const options = input && typeof input === 'object' ? input : {}
  const cwd = options.cwd
  const plan = options.plan
  const io = options.io ?? nodeFsPromises
  if (!plan || typeof plan !== 'object') throw new Error('applySyncPlan requires a plan object')
  if (plan.ok !== true) {
    throw new Error('refusing to apply a sync plan that is not marked ok')
  }
  const writes = Array.isArray(plan.writes) ? plan.writes : []
  if (writes.length === 0) return { written: [] }

  // Preflight every write before touching the filesystem.
  const prepared = []
  const seenPaths = new Set()
  for (const write of writes) {
    if (!write || typeof write !== 'object') throw new Error('plan write entry is not an object')
    const action = write.action
    if (action !== 'create' && action !== 'update' && action !== 'remove') {
      throw new Error(`unknown plan write action: ${String(action)}`)
    }
    const relPath = validateMainSpecWritePath(write.path)
    if (seenPaths.has(relPath)) throw new Error(`duplicate plan write for ${relPath}`)
    seenPaths.add(relPath)
    const content = action === 'remove' ? '' : write.content
    if (typeof content !== 'string') throw new Error(`plan write for ${relPath} has no content`)
    prepared.push({ relPath, action, content, absolute: toWorkspaceAbsolute(cwd, relPath) })
  }

  /** @type {Map<string, string|null>} */
  const backups = new Map()
  /** @type {string[]} */
  const tempFiles = []
  /** @type {Array<{relPath: string, action: string, absolute: string}>} */
  const applied = []
  try {
    for (const item of prepared) {
      let backup = null
      try {
        backup = String(await io.readFile(item.absolute, 'utf8'))
      } catch (error) {
        if (!isMissingPathError(error)) throw error
        backup = null
      }
      backups.set(item.absolute, backup)

      if (item.action === 'remove') {
        await io.rm(item.absolute, { force: true })
      } else {
        await io.mkdir(path.dirname(item.absolute), { recursive: true })
        const tempPath = `${item.absolute}.openspec-sync-${randomUUID()}.tmp`
        tempFiles.push(tempPath)
        await io.writeFile(tempPath, item.content, 'utf8')
        await io.rename(tempPath, item.absolute)
      }
      applied.push(item)
    }
    return { written: prepared.map((item) => item.relPath) }
  } catch (error) {
    let rollbackError = null
    for (const item of [...applied].reverse()) {
      try {
        const backup = backups.get(item.absolute)
        if (backup === null || backup === undefined) {
          await io.rm(item.absolute, { force: true })
        } else {
          await io.mkdir(path.dirname(item.absolute), { recursive: true })
          await io.writeFile(item.absolute, backup, 'utf8')
        }
      } catch (rollbackFailure) {
        if (!rollbackError) rollbackError = rollbackFailure
      }
    }
    for (const tempPath of tempFiles) {
      try {
        await io.rm(tempPath, { force: true })
      } catch {
        // best effort cleanup; the failure below is what matters
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    const rollbackMessage = rollbackError instanceof Error
      ? `; rollback also failed: ${rollbackError.message}`
      : ''
    throw new Error(`sync apply failed: ${message}${rollbackMessage}`)
  }
}
