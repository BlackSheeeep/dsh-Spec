/**
 * Workspace/change state derivation for OpenSpec-native workspaces (Host half).
 *
 * This module is the single source of truth the panel, commands and prompts use:
 * it reads project configuration, change metadata, the effective schema and its
 * artifact graph, tasks, specs and delta specs, then derives native artifact
 * states, task progress, next steps and validation findings.
 *
 * Nothing here spawns a process or touches the network; every read goes through
 * `fsio.js` (`node:fs/promises`). A change that fails to load never throws out of
 * `computeWorkspaceState` — it is surfaced with validation errors and
 * `schemaError` instead.
 *
 * @module dsh-spec/native/state
 */

import { detectNativeSkills } from './skills.js'
import { joinRel, isFile, listDir, listTree, pathExists, readTextOrNull } from './fsio.js'
import { readProjectConfig } from './config.js'
import { readChangeMetadata, resolveSchemaName } from './metadata.js'
import { loadBundledSchemas, loadProjectSchemas, matchGlob, resolveSchema } from './schema.js'
import { computeArtifactStates, validateSchemaGraph } from './graph.js'
import { parseDeltaSpec, parseMainSpec } from './spec.js'
import { summarizeProposal } from './summary.js'
import { parseTasks } from './tasks.js'
import { validateChange, validateMainSpec } from './validate.js'

const CHANGES_REL = 'openspec/changes'
const SPECS_REL = 'openspec/specs'
const ARCHIVE_REL = 'openspec/changes/archive'
const DEFAULT_TRACKS = 'tasks.md'
/** Max tracked task rows carried in one ChangeState (panel payload bound). */
const TASK_ITEM_LIMIT = 200

/**
 * Bound the task item rows carried in a `ChangeState` (panel payload cap).
 *
 * `parseTasks` still counts every checkbox (`total` / `done` stay complete);
 * only the detail rows handed to the panel are capped. Callers compare
 * `total` with `items.length` to surface the remaining count explicitly.
 *
 * @param {Array<{id?: unknown, text?: unknown, done?: unknown, depth?: unknown, line?: unknown, manual?: unknown}>|null} items
 * @returns {Array<{id: string|null, text: string, done: boolean, depth: number, line: number|null, manual: boolean}>} plain rows
 */
export function limitTaskItems(items) {
  const list = Array.isArray(items) ? items : []
  return list.slice(0, TASK_ITEM_LIMIT).map((item) => ({
    id: typeof item?.id === 'string' && item.id !== '' ? item.id : null,
    text: String(item?.text ?? ''),
    done: item?.done === true,
    depth: Number.isInteger(item?.depth) && item.depth >= 0 ? Math.min(item.depth, 3) : 0,
    line: Number.isInteger(item?.line) && item.line > 0 ? item.line : null,
    manual: item?.manual === true,
  }))
}

/** Result of `readProjectConfig` when the project has no configuration file. */
function emptyConfig() {
  return {
    found: false,
    file: null,
    schema: 'spec-driven',
    context: '',
    rules: {},
    operations: {},
    warnings: [],
  }
}

/** Empty normalized change metadata. */
function emptyMetadata() {
  return {
    found: false,
    schema: null,
    created: null,
    goal: null,
    skip_specs: false,
    retire_capabilities: false,
  }
}

/**
 * Create a placeholder ChangeState (used for unreadable changes).
 *
 * @param {string} name change name
 * @returns {object}
 */
function emptyChangeState(name) {
  return {
    name,
    schemaName: 'spec-driven',
    schemaSource: 'builtin',
    metadata: emptyMetadata(),
    summary: {
      // PR #2 fields: one-line headline + Why paragraph + What Changes bullets.
      headline: '',
      description: '',
      highlights: [],
      source: 'none',
      // Detail-view digest fields: bounded Why / What Changes rows for the panel.
      goal: null,
      why: null,
      whyTruncated: false,
      changes: [],
      changesHidden: 0,
      changesTruncated: false,
    },
    artifacts: [],
    applyRequires: [],
    tracks: null,
    isPlanningComplete: false,
    nextSteps: [],
    listStatus: 'no-tasks',
    tasks: null,
    docs: [],
    delta: { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] },
    validation: { errors: 0, warnings: 0, infos: 0, issues: [] },
    files: [],
    schemaError: null,
  }
}

/**
 * Sort and summarize issues (deterministic: path, line, message).
 *
 * @param {Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>} issues
 * @returns {{errors: number, warnings: number, infos: number, issues: Array<{level: string, path?: string, line?: number, message: string}>}}
 */
function finalizeValidation(issues) {
  const sorted = [...issues].sort((a, b) => {
    const pathA = a.path ?? ''
    const pathB = b.path ?? ''
    if (pathA !== pathB) return pathA < pathB ? -1 : 1
    const lineA = typeof a.line === 'number' ? a.line : 0
    const lineB = typeof b.line === 'number' ? b.line : 0
    if (lineA !== lineB) return lineA - lineB
    if (a.message !== b.message) return a.message < b.message ? -1 : 1
    return a.level < b.level ? -1 : a.level > b.level ? 1 : 0
  })
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

/** Build an AbortError-shaped error. @returns {Error} */
function abortError() {
  const error = new Error('native state computation aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Whether a `generates` entry is a glob pattern.
 * @param {string} value
 * @returns {boolean}
 */
function hasGlob(value) {
  return /[*?{]/.test(value)
}

/**
 * Normalize an artifact's `generates` value to a list of output patterns.
 * @param {{generates?: unknown}} artifact
 * @returns {string[]}
 */
function artifactPatterns(artifact) {
  if (!artifact) return []
  if (typeof artifact.generates === 'string') {
    return artifact.generates.trim() === '' ? [] : [artifact.generates.trim()]
  }
  if (Array.isArray(artifact.generates)) {
    return artifact.generates
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim())
  }
  return []
}

/** Delta operation names covered by the native parser. */
const DELTA_OPERATIONS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']
/** Upper bound (characters) of the `## Why` digest carried on a ChangeState. */
const SUMMARY_WHY_LIMIT = 280
/** Upper bound (characters) of each `## What Changes` bullet digest. */
const SUMMARY_CHANGE_LIMIT = 140
/** Upper bound (rows) of `## What Changes` bullets carried on a ChangeState. */
const SUMMARY_CHANGE_ROWS = 4

/**
 * Collapse inline whitespace so a markdown snippet fits on one summary line.
 * @param {unknown} text
 * @returns {string}
 */
function collapseInlineText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Strip the inline markdown that would otherwise leak as syntax into the
 * one-line digest (bold/italic/code/links). Block structure is untouched.
 * @param {string} text
 * @returns {string}
 */
function stripInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,，。;；:：]|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim()
}

/**
 * Extract a level-2 markdown section (`## Heading` up to the next level-2 heading).
 *
 * @param {string} text markdown source
 * @param {string} heading heading text without hashes
 * @returns {string} trimmed section body (`''` when absent)
 */
function readLevelTwoSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) continue
    const body = []
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+/.test(lines[cursor])) break
      body.push(lines[cursor])
    }
    return body.join('\n').trim()
  }
  return ''
}

/**
 * Deterministic proposal digest for the panel (no extra file IO: the caller
 * already reads `proposal.md` to validate the change).
 *
 * `## Why` contributes its first non-empty paragraph; `## What Changes`
 * contributes the top-level bullets (bounded rows/length). Truncation is
 * flagged so the panel never silently cuts text.
 *
 * @param {string|null|undefined} proposalText
 * @returns {{why: string|null, whyTruncated: boolean, changes: string[], changesHidden: number, changesTruncated: boolean}}
 */
export function extractProposalDigest(proposalText) {
  const text = typeof proposalText === 'string' ? proposalText : ''
  const whyBody = readLevelTwoSection(text, 'Why')
  const paragraphs = whyBody
    .split(/\n\s*\n/)
    .map((paragraph) => stripInlineMarkdown(collapseInlineText(paragraph)))
    .filter((paragraph) => paragraph !== '')
  const whyText = paragraphs[0] ?? ''
  const why = whyText === '' ? null : whyText.slice(0, SUMMARY_WHY_LIMIT)

  const whatBody = readLevelTwoSection(text, 'What Changes')
  /** @type {string[]} */
  const bullets = []
  for (const line of whatBody.split(/\r?\n/)) {
    const match = /^(?:[-*+])\s+(\S.*)$/.exec(line)
    if (match === null) continue
    const bullet = stripInlineMarkdown(collapseInlineText(match[1]))
    if (bullet !== '') bullets.push(bullet)
  }
  const kept = bullets.slice(0, SUMMARY_CHANGE_ROWS)
  return {
    why,
    whyTruncated: whyText.length > SUMMARY_WHY_LIMIT,
    changes: kept.map((bullet) => bullet.slice(0, SUMMARY_CHANGE_LIMIT)),
    changesHidden: Math.max(0, bullets.length - kept.length),
    changesTruncated: kept.some((bullet) => bullet.length > SUMMARY_CHANGE_LIMIT),
  }
}

/**
 * Attach display metadata (`description` / `generates`) from the effective
 * schema to the derived artifact rows. Additive only; status fields stay intact.
 *
 * @param {Array<{id: string}>} artifacts derived artifact rows
 * @param {{artifacts?: Array<{id?: unknown, description?: unknown, generates?: unknown}>}|null} schema effective schema
 * @returns {Array<object>} enriched rows
 */
export function withArtifactMetadata(artifacts, schema) {
  const list = Array.isArray(artifacts) ? artifacts : []
  /** @type {Map<string, object>} */
  const byId = new Map()
  for (const artifact of Array.isArray(schema?.artifacts) ? schema.artifacts : []) {
    if (artifact === null || typeof artifact !== 'object') continue
    const id = typeof artifact.id === 'string' ? artifact.id.trim() : ''
    if (id !== '' && !byId.has(id)) byId.set(id, artifact)
  }
  return list.map((row) => {
    const source = byId.get(row.id)
    return {
      ...row,
      description: typeof source?.description === 'string' ? source.description : '',
      generates: artifactPatterns(source),
    }
  })
}

/**
 * Capability path for a change-relative delta spec path (`specs/a/b/spec.md` → `a/b`).
 * @param {string} relPath
 * @returns {string}
 */
function capabilityLabel(relPath) {
  const normalized = String(relPath ?? '').replace(/\\/g, '/')
  const match = /(?:^|\/)specs\/(.+)\/spec\.md$/.exec(normalized)
  return match === null ? 'spec' : match[1]
}

/**
 * Resolve the tracking file name for a change (schema `apply.tracks`, else the
 * `tasks` artifact output, else `tasks.md`).
 *
 * @param {{apply?: {tracks?: string|null}, artifacts?: object[]}|null} schema
 * @returns {string}
 */
function trackingFile(schema) {
  if (schema && typeof schema.apply?.tracks === 'string' && schema.apply.tracks.trim() !== '') {
    return schema.apply.tracks.trim()
  }
  for (const artifact of schema?.artifacts ?? []) {
    if (artifact?.id !== 'tasks') continue
    for (const pattern of artifactPatterns(artifact)) {
      if (!hasGlob(pattern)) return pattern
    }
  }
  return DEFAULT_TRACKS
}

/**
 * Read everything needed to describe/validate one change.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} changeName change directory name
 * @param {{projectConfig?: object|null, projectSchemas?: object[]|null}} [options]
 * @returns {Promise<object>}
 */
async function loadChangeContext(cwd, changeName, { projectConfig = null, projectSchemas = null } = {}) {
  const config = projectConfig ?? (await readProjectConfig(cwd))
  const changeRel = joinRel(CHANGES_REL, changeName)
  if (!(await pathExists(cwd, changeRel))) {
    throw new Error(`change "${changeName}" was not found at ${changeRel}`)
  }
  const metadataResult = await readChangeMetadata(cwd, changeRel)
  const metadata = { found: metadataResult.found, ...metadataResult.metadata }
  const schemaName = resolveSchemaName({ changeMetadata: metadata, projectConfig: config })
  const schemaList = projectSchemas ?? (await loadProjectSchemas(cwd)).schemas
  const resolved = resolveSchema({ name: schemaName, projectSchemas: schemaList })

  const proposalText = await readTextOrNull(cwd, joinRel(changeRel, 'proposal.md'))
  const tracks = trackingFile(resolved.schema)
  const tasksText = await readTextOrNull(cwd, joinRel(changeRel, tracks))
  const tasks = tasksText === null ? null : parseTasks(tasksText)

  const deltaFiles = await collectDeltaFiles(cwd, changeRel)
  /** @type {Array<{path: string, text: string, parsed: object}>} */
  const deltas = []
  for (const file of deltaFiles) {
    const text = await readTextOrNull(cwd, joinRel(changeRel, file))
    if (text === null) continue
    deltas.push({ path: file, text, parsed: parseDeltaSpec(text) })
  }

  const tree = await listTree(cwd, changeRel)
  /** @type {string[]} */
  const changeFiles = []
  for (const entry of tree) {
    if (entry.type !== 'file') continue
    const rel =
      entry.rel.startsWith(`${changeRel}/`) ? entry.rel.slice(changeRel.length + 1) : entry.rel
    changeFiles.push(rel)
  }
  changeFiles.sort()
  const topLevel = (await listDir(cwd, changeRel)).filter((entry) => entry.type === 'file').map((entry) => entry.name)

  return {
    config,
    changeRel,
    metadataResult,
    metadata,
    schemaName,
    resolved,
    proposalText,
    tasksText,
    tasks,
    tracks,
    deltas,
    changeFiles,
    files: topLevel,
  }
}

/**
 * Collect change-relative `specs/<capability>/spec.md` paths for a change.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} changeRel workspace-relative change directory
 * @returns {Promise<string[]>} change-relative paths, sorted
 */
async function collectDeltaFiles(cwd, changeRel) {
  const tree = await listTree(cwd, joinRel(changeRel, 'specs'))
  /** @type {string[]} */
  const out = []
  for (const entry of tree) {
    if (entry.type !== 'file' || entry.name !== 'spec.md') continue
    const rel = entry.rel.startsWith(`${changeRel}/`) ? entry.rel.slice(changeRel.length + 1) : entry.rel
    out.push(rel)
  }
  return out.sort()
}

/**
 * Derive the full ChangeState for one change.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} changeName change directory name
 * @param {{projectConfig?: object|null, projectSchemas?: object[]|null}} [options]
 * @returns {Promise<object>}
 */
async function computeChangeStateInternal(cwd, changeName, { projectConfig = null, projectSchemas = null } = {}) {
  const context = await loadChangeContext(cwd, changeName, { projectConfig, projectSchemas })
  const state = emptyChangeState(changeName)
  state.schemaName = context.schemaName
  state.schemaSource = context.resolved.source ?? 'builtin'
  state.metadata = context.metadata
  const goal = typeof context.metadata?.goal === 'string' && context.metadata.goal.trim() !== '' ? context.metadata.goal.trim() : null
  state.summary = { ...summarizeProposal(context.proposalText, { goal: context.metadata.goal }), goal, ...extractProposalDigest(context.proposalText) }
  state.tracks = context.resolved.schema?.apply?.tracks ?? null
  state.applyRequires = Array.isArray(context.resolved.schema?.apply?.requires)
    ? [...context.resolved.schema.apply.requires]
    : []

  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>} */
  const schemaIssues = []
  if (context.resolved.schema === null) {
    schemaIssues.push(...context.resolved.issues)
  } else {
    const graphValidation = validateSchemaGraph(context.resolved.schema)
    const schemaPath =
      context.resolved.source === 'project'
        ? `openspec/schemas/${context.schemaName}/schema.yaml`
        : `src/native-snapshot/${context.schemaName}/schema.yaml`
    for (const issue of graphValidation.issues) schemaIssues.push({ ...issue, path: schemaPath })
    const artifactState = await computeArtifactStates(
      cwd,
      context.changeRel,
      context.resolved.schema,
      { skipSpecs: context.metadata.skip_specs === true },
    )
    state.artifacts = withArtifactMetadata(artifactState.artifacts, context.resolved.schema)
    state.applyRequires = artifactState.applyRequires
    state.tracks = artifactState.tracks
    state.isPlanningComplete = artifactState.isPlanningComplete
    state.nextSteps = artifactState.nextSteps
    if (context.resolved.schema.sourceVersion !== undefined) {
      state.schemaVersion = context.resolved.schema.sourceVersion
    }
  }
  const schemaErrors = schemaIssues.filter((issue) => issue.level === 'ERROR').map((issue) => issue.message)
  state.schemaError = schemaErrors.length > 0 ? schemaErrors.join('; ') : null

  state.tasks =
    context.tasks === null
      ? null
      : {
          total: context.tasks.total,
          done: context.tasks.done,
          items: limitTaskItems(context.tasks.items),
        }
  state.listStatus =
    context.tasks === null || context.tasks.total === 0
      ? 'no-tasks'
      : context.tasks.done === context.tasks.total
        ? 'complete'
        : 'in-progress'

  if (state.isPlanningComplete && state.listStatus === 'complete') state.nextSteps = ['archive']

  // Documents: one row per existing artifact output (globs expand) plus delta specs.
  /** @type {Array<{path: string, label: string, artifactId: string, kind: 'artifact'|'delta'}>} */
  const docs = []
  const seen = new Set()
  if (context.resolved.schema !== null) {
    for (const artifact of context.resolved.schema.artifacts ?? []) {
      const row = state.artifacts.find((candidate) => candidate.id === artifact.id)
      if (row === undefined || row.status !== 'done') continue
      for (const pattern of artifactPatterns(artifact)) {
        const matches = hasGlob(pattern)
          ? context.changeFiles.filter((file) => matchGlob(pattern, file))
          : context.changeFiles.includes(pattern)
            ? [pattern]
            : []
        for (const file of matches.sort()) {
          const docPath = joinRel(context.changeRel, file)
          if (seen.has(docPath)) continue
          seen.add(docPath)
          const kind = file === 'specs' || file.startsWith('specs/') ? 'delta' : 'artifact'
          docs.push({
            path: docPath,
            label: kind === 'delta' ? capabilityLabel(file) : artifact.id,
            artifactId: artifact.id,
            kind,
          })
        }
      }
    }
  }
  for (const delta of context.deltas) {
    const docPath = joinRel(context.changeRel, delta.path)
    if (seen.has(docPath)) continue
    seen.add(docPath)
    docs.push({ path: docPath, label: capabilityLabel(delta.path), artifactId: 'specs', kind: 'delta' })
  }
  state.docs = docs

  /**
   * Per-file delta counts plus the cross-file totals. The panel groups delta
   * documents by capability and shows each file's operation mix, so the digest
   * carries one bounded row per delta file (parsed during context loading).
   *
   * @type {{ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number, files: Array<{path: string, label: string, ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number}>}}
   */
  const deltaSummary = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] }
  for (const delta of context.deltas) {
    const operations = delta.parsed?.operations ?? {}
    /** @type {{ADDED: number, MODIFIED: number, REMOVED: number, RENAMED: number}} */
    const counts = { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }
    for (const operation of DELTA_OPERATIONS) {
      const list = Array.isArray(operations[operation]) ? operations[operation] : []
      counts[operation] = list.length
      deltaSummary[operation] += list.length
    }
    deltaSummary.files.push({ path: delta.path, label: capabilityLabel(delta.path), ...counts })
  }
  state.delta = deltaSummary
  state.files = context.files

  const baseValidation = validateChange({
    changeName,
    schema: context.resolved.schema,
    config: context.config,
    metadata: context.metadata,
    metadataResult: context.metadataResult,
    proposalText: context.proposalText,
    deltas: context.deltas,
    tasksText: context.tasksText,
  })
  state.validation = finalizeValidation([...baseValidation.issues, ...schemaIssues])
  return state
}

/**
 * Compute the native state of one change.
 *
 * Throws only when `openspec/changes/<changeName>` does not exist; everything
 * else (missing artifacts, invalid metadata, schema errors) is reported in the
 * returned ChangeState.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} changeName change directory name
 * @param {{projectConfig?: object|null}} [options]
 * @returns {Promise<object>} ChangeState
 */
export async function computeChangeState(cwd, changeName, { projectConfig = null } = {}) {
  return computeChangeStateInternal(cwd, changeName, { projectConfig })
}

/**
 * List main capability specs under `openspec/specs/**`.
 *
 * @param {string} cwd absolute workspace root
 * @returns {Promise<Array<{name: string, path: string, purpose: string, requirementCount: number, scenarioCount: number, validation: {errors: number, warnings: number, infos: number}}>>}
 */
export async function listMainSpecs(cwd) {
  const tree = await listTree(cwd, SPECS_REL)
  /** @type {Array<{name: string, path: string, purpose: string, requirementCount: number, scenarioCount: number, validation: {errors: number, warnings: number, infos: number}}>} */
  const specs = []
  for (const entry of tree) {
    if (entry.type !== 'file' || entry.name !== 'spec.md') continue
    const rel = entry.rel.startsWith(`${SPECS_REL}/`) ? entry.rel.slice(SPECS_REL.length + 1) : entry.rel
    const name = rel.slice(0, -'/spec.md'.length)
    if (name === '' || name === 'spec.md') continue
    const text = await readTextOrNull(cwd, entry.rel)
    if (text === null) continue
    const parsed = parseMainSpec(text)
    const validation = validateMainSpec({ path: entry.rel, text, parsed })
    let scenarioCount = 0
    for (const requirement of parsed.requirements) scenarioCount += requirement.scenarios.length
    specs.push({
      name,
      path: entry.rel,
      purpose: parsed.purpose ?? '',
      requirementCount: parsed.requirements.length,
      scenarioCount,
      validation: {
        errors: validation.summary.errors,
        warnings: validation.summary.warnings,
        infos: validation.summary.infos,
      },
    })
  }
  return specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Describe one archive directory name (`YYYY-MM-DD-<change>`).
 *
 * @param {string} name directory name
 * @returns {{name: string, changeName: string, date: string|null, path: string}}
 */
function describeArchive(name) {
  const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name)
  return {
    name,
    changeName: match === null ? name : match[2],
    date: match === null ? null : match[1],
    path: joinRel(ARCHIVE_REL, name),
  }
}

/**
 * Compute the native state of a whole workspace.
 *
 * @param {string} cwd absolute workspace root
 * @param {{signal?: AbortSignal, dshHome?: string}} [options]
 * @returns {Promise<object>} WorkspaceState
 */
export async function computeWorkspaceState(cwd, { signal, dshHome } = {}) {
  if (signal?.aborted) throw abortError()
  /** @type {object} */
  const state = {
    status: 'missing',
    cwd,
    root: 'openspec',
    archivedCount: 0,
    config: emptyConfig(),
    schemas: [],
    changes: [],
    specs: [],
    archived: [],
    skills: { native: [], fallbackActive: true },
    warnings: [],
  }

  try {
    const config = await readProjectConfig(cwd)
    state.config = config
    state.warnings.push(...config.warnings)

    const projectResult = await loadProjectSchemas(cwd)
    for (const issue of projectResult.issues) {
      if (issue.level === 'ERROR') state.warnings.push(`${issue.path ?? 'openspec/schemas'}: ${issue.message}`)
    }
    /** @type {Array<{name: string, source: 'project'|'builtin', description: string, artifacts: string[]}>} */
    const schemas = projectResult.schemas.map((entry) => ({
      name: entry.schema.name,
      source: 'project',
      description: entry.schema.description,
      artifacts: entry.schema.artifacts.map((artifact) => artifact.id),
    }))
    for (const [name, entry] of loadBundledSchemas()) {
      if (schemas.some((schema) => schema.name === name)) continue
      schemas.push({
        name,
        source: 'builtin',
        description: entry.schema.description,
        artifacts: entry.schema.artifacts.map((artifact) => artifact.id),
      })
    }
    state.schemas = schemas.sort((a, b) =>
      a.name === b.name ? (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) : a.name < b.name ? -1 : 1,
    )

    const changesRelExists = await pathExists(cwd, CHANGES_REL)
    const changesRelIsFile = changesRelExists && (await isFile(cwd, CHANGES_REL))
    const changeEntries = changesRelExists && !changesRelIsFile ? await listDir(cwd, CHANGES_REL) : []
    if (!changesRelExists) state.status = 'missing'
    else if (changesRelIsFile) {
      state.status = 'error'
      state.warnings.push(`${CHANGES_REL} is a file, not a directory`)
    } else state.status = 'ready'

    for (const entry of changeEntries) {
      if (entry.type !== 'directory' || entry.name === 'archive') continue
      if (signal?.aborted) throw abortError()
      try {
        state.changes.push(
          await computeChangeStateInternal(cwd, entry.name, {
            projectConfig: config,
            projectSchemas: projectResult.schemas,
          }),
        )
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        const failed = emptyChangeState(entry.name)
        const message = `failed to read change: ${error?.message ?? String(error)}`
        failed.validation = finalizeValidation([{ level: 'ERROR', path: '', message }])
        state.changes.push(failed)
        state.warnings.push(`change "${entry.name}": ${message}`)
      }
    }

    state.specs = await listMainSpecs(cwd)

    const archiveEntries = await listDir(cwd, ARCHIVE_REL)
    state.archived = archiveEntries.filter((entry) => entry.type === 'directory').map((entry) => describeArchive(entry.name))
    state.archivedCount = state.archived.length

    const detected = await detectNativeSkills(cwd, { signal, dshHome })
    state.skills = { native: detected.skills, fallbackActive: detected.skills.length === 0 }
    state.warnings.push(...detected.warnings)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    state.status = 'error'
    state.warnings.push(`native state computation failed: ${error?.message ?? String(error)}`)
  }

  return state
}

/**
 * Flatten a `validateChange()` result to the WorkspaceState/ChangeState shape.
 *
 * @param {{issues: Array<object>, summary: {errors: number, warnings: number, infos: number}}} result
 * @returns {{errors: number, warnings: number, infos: number, issues: Array<object>}}
 */
function flattenValidation(result) {
  return {
    errors: result.summary.errors,
    warnings: result.summary.warnings,
    infos: result.summary.infos,
    issues: result.issues,
  }
}

/**
 * Validate one change by name and return its diagnostics plus merge inputs.
 *
 * `validation` uses the flat native shape `{ errors, warnings, infos, issues }`
 * so the panel/host route can consume it directly.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} changeName change directory name
 * @returns {Promise<{name: string, validation: {errors: number, warnings: number, infos: number, issues: Array<object>}, metadata: object, schemaName: string, deltas: Array<{path: string, text: string, parsed: object}>, tasks: object|null}>}
 */
export async function validateChangeByName(cwd, changeName) {
  const context = await loadChangeContext(cwd, changeName)
  const validation = validateChange({
    changeName,
    schema: context.resolved.schema,
    config: context.config,
    metadata: context.metadata,
    metadataResult: context.metadataResult,
    proposalText: context.proposalText,
    deltas: context.deltas,
    tasksText: context.tasksText,
  })
  return {
    name: changeName,
    validation: flattenValidation(validation),
    metadata: context.metadata,
    schemaName: context.schemaName,
    deltas: context.deltas,
    tasks: context.tasks,
  }
}
