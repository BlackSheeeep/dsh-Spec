/**
 * Deterministic native validation for changes and main specs (Host half).
 *
 * The validator is read-only: it never writes files and never submits model
 * work. Given the same inputs it returns the same issue list, sorted by path,
 * line and message, with `ERROR` / `WARNING` / `INFO` levels and paths relative
 * to the change directory (or workspace-relative for main specs).
 *
 * @module dsh-spec/native/validate
 */

import { countScenarios, parseDeltaSpec, parseMainSpec } from './spec.js'
import { parseTasks } from './tasks.js'

/** Native `created` format. */
const CREATED_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Find the 1-based line number of an exact (trimmed) markdown line.
 *
 * @param {string} text
 * @param {string} exactLine
 * @returns {number|undefined}
 */
function findLineNumber(text, exactLine) {
  const lines = String(text ?? '').split(/\r?\n/)
  const needle = exactLine.trim()
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === needle) return index + 1
  }
  return undefined
}

/**
 * Extract a level-2 markdown section.
 *
 * @param {string} text
 * @param {string} heading section title without hashes (e.g. `Why`)
 * @returns {{present: boolean, line?: number, body: string}}
 */
function readSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) continue
    const body = []
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+/.test(lines[cursor])) break
      body.push(lines[cursor])
    }
    return { present: true, line: index + 1, body: body.join('\n').trim() }
  }
  return { present: false, body: '' }
}

/**
 * Validate the proposal document.
 *
 * @param {string|null|undefined} proposalText
 * @param {string} [path]
 * @returns {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>}
 */
function validateProposal(proposalText, path = 'proposal.md') {
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>} */
  const issues = []
  if (typeof proposalText !== 'string' || proposalText.trim() === '') {
    issues.push({ level: 'ERROR', path, message: 'proposal.md is missing or empty' })
    return issues
  }

  const why = readSection(proposalText, 'Why')
  if (!why.present) {
    issues.push({ level: 'ERROR', path, message: 'proposal is missing a "## Why" section' })
  } else {
    const length = why.body.length
    if (length < 50) {
      issues.push({
        level: 'ERROR',
        path,
        line: why.line,
        message: `"## Why" must be between 50 and 1000 characters (currently ${length})`,
      })
    } else if (length > 1000) {
      issues.push({
        level: 'WARNING',
        path,
        line: why.line,
        message: `"## Why" should stay at or below 1000 characters (currently ${length})`,
      })
    }
  }

  const whatChanges = readSection(proposalText, 'What Changes')
  if (!whatChanges.present || whatChanges.body === '') {
    issues.push({ level: 'ERROR', path, message: 'proposal is missing a non-empty "## What Changes" section' })
  }

  const capabilities = readSection(proposalText, 'Capabilities')
  if (!capabilities.present) {
    issues.push({ level: 'WARNING', path, message: 'proposal is missing an optional "## Capabilities" section' })
  }

  return issues
}

/**
 * Normalize a requirement name for duplicate detection.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeRequirementName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Validate a delta spec file (one `specs/<capability>/spec.md`).
 *
 * @param {{path?: string, text?: string, parsed?: object}} delta
 * @returns {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>}
 */
function validateDeltaFile(delta) {
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>} */
  const issues = []
  const path = typeof delta.path === 'string' && delta.path !== '' ? delta.path : 'specs/spec.md'
  const text = typeof delta.text === 'string' ? delta.text : ''
  const parsed = delta.parsed ?? parseDeltaSpec(text)
  const operations = parsed.operations ?? { ADDED: [], MODIFIED: [], REMOVED: [], RENAMED: [] }

  const segments = path.split('/')
  if (segments.length === 2 && segments[0] === 'specs' && segments[1] === 'spec.md') {
    issues.push({
      level: 'ERROR',
      path,
      message: 'delta specs must live at specs/<capability-path>/spec.md, not directly at specs/spec.md',
    })
  }

  for (const issue of parsed.issues ?? []) {
    /** @type {{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}} */
    const entry = { level: issue.level, path, message: issue.message }
    if (typeof issue.line === 'number') entry.line = issue.line
    issues.push(entry)
  }

  for (const operation of ['ADDED', 'MODIFIED']) {
    for (const requirement of operations[operation] ?? []) {
      const name = normalizeRequirementName(requirement.name)
      const line = findLineNumber(text, `### Requirement: ${requirement.name}`)
      if (!/\b(?:SHALL|MUST)\b/.test(requirement.raw ?? '')) {
        issues.push({
          level: 'ERROR',
          path,
          line,
          message: `${operation} requirement "${name}" must contain SHALL or MUST`,
        })
      }
      if (countScenarios(requirement.raw ?? '') === 0) {
        issues.push({
          level: 'ERROR',
          path,
          line,
          message: `${operation} requirement "${name}" must include at least one "#### Scenario:" block`,
        })
      }
      if (typeof requirement.text === 'string' && requirement.text.length > 500) {
        issues.push({
          level: 'WARNING',
          path,
          line,
          message: `${operation} requirement "${name}" body is longer than 500 characters; consider splitting it`,
        })
      }
    }
  }

  const addedNames = new Set()
  for (const requirement of operations.ADDED ?? []) {
    const key = normalizeRequirementName(requirement.name)
    if (addedNames.has(key)) {
      issues.push({
        level: 'ERROR',
        path,
        line: findLineNumber(text, `### Requirement: ${requirement.name}`),
        message: `duplicate ADDED requirement "${key}"`,
      })
    }
    addedNames.add(key)
  }

  for (const rename of operations.RENAMED ?? []) {
    if (!rename.from) {
      issues.push({ level: 'ERROR', path, message: 'RENAMED entry is missing a FROM requirement name' })
    }
    if (!rename.to) {
      issues.push({ level: 'ERROR', path, message: 'RENAMED entry is missing a TO requirement name' })
    }
  }

  return issues
}

/**
 * Validate the change tasks file (numbering gaps and unusual markers only).
 *
 * @param {string|null|undefined} tasksText
 * @param {string} [path]
 * @returns {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>}
 */
function validateTasks(tasksText, path = 'tasks.md') {
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>} */
  const issues = []
  if (typeof tasksText !== 'string') return issues
  const parsed = parseTasks(tasksText)
  for (const issue of parsed.issues) {
    issues.push({ level: issue.level, path, line: issue.line, message: issue.message })
  }

  /** @type {Map<number, number[]>} */
  const phases = new Map()
  for (const item of parsed.items) {
    if (item.id === null) continue
    const parts = item.id.split('.')
    if (parts.length !== 2) continue
    const major = Number(parts[0])
    const minor = Number(parts[1])
    if (!Number.isInteger(major) || !Number.isInteger(minor)) continue
    if (!phases.has(major)) phases.set(major, [])
    phases.get(major).push(minor)
  }
  const majors = [...phases.keys()].sort((a, b) => a - b)
  for (const major of majors) {
    const minors = [...new Set(phases.get(major))].sort((a, b) => a - b)
    for (let index = 1; index < minors.length; index += 1) {
      if (minors[index] !== minors[index - 1] + 1) {
        issues.push({
          level: 'WARNING',
          path,
          message: `task numbering gap: expected ${major}.${minors[index - 1] + 1} but found ${major}.${minors[index]}`,
        })
      }
    }
  }
  return issues
}

/**
 * Validate change metadata and relay metadata parser findings.
 *
 * @param {{metadata?: object|null, metadataResult?: {warnings?: string[], error?: {message: string, line?: number}|null}|null}} input
 * @returns {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>}
 */
function validateMetadata({ metadata = null, metadataResult = null }) {
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>} */
  const issues = []
  const path = '.openspec.yaml'
  for (const warning of metadataResult?.warnings ?? []) {
    issues.push({ level: 'WARNING', path, message: warning })
  }
  if (metadataResult?.error) {
    /** @type {{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}} */
    const entry = { level: 'ERROR', path, message: metadataResult.error.message }
    if (typeof metadataResult.error.line === 'number') entry.line = metadataResult.error.line
    issues.push(entry)
    // The metadata parser already validated the whole document; do not re-report fields.
    return issues
  }

  const values = metadata ?? {}
  const created = values.created
  if (created !== null && created !== undefined) {
    if (typeof created !== 'string' || !CREATED_PATTERN.test(created)) {
      issues.push({ level: 'ERROR', path, message: `"created" must be a YYYY-MM-DD date (got ${JSON.stringify(created)})` })
    }
  }
  const schema = values.schema
  if (schema !== null && schema !== undefined) {
    if (typeof schema !== 'string' || schema.trim() === '') {
      issues.push({ level: 'ERROR', path, message: '"schema" must be a non-empty string' })
    }
  }
  for (const key of ['skip_specs', 'retire_capabilities']) {
    const value = values[key]
    if (value !== null && value !== undefined && typeof value !== 'boolean') {
      issues.push({ level: 'ERROR', path, message: `"${key}" must be a boolean` })
    }
  }
  return issues
}

/**
 * Sort and summarize a native issue list.
 *
 * @param {Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>} issues
 * @returns {{issues: Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>, summary: {errors: number, warnings: number, infos: number}}}
 */
function finalize(issues) {
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
  return { issues: sorted, summary: { errors, warnings, infos } }
}

/**
 * Deterministically validate one change.
 *
 * `deltas` paths are relative to the change directory (e.g.
 * `specs/<capability>/spec.md`); `proposal.md` / `tasks.md` / `.openspec.yaml`
 * paths are implied. Identical input produces identical output.
 *
 * @param {{changeName?: string, schema?: object|null, config?: object|null, metadata?: object|null, metadataResult?: object|null, proposalText?: string|null, deltas?: Array<{path: string, text: string, parsed?: object}>, tasksText?: string|null}} input
 * @returns {{issues: Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>, summary: {errors: number, warnings: number, infos: number}}}
 */
export function validateChange({
  changeName = '',
  schema = null,
  config = null,
  metadata = null,
  metadataResult = null,
  proposalText = null,
  deltas = [],
  tasksText = null,
} = {}) {
  void changeName
  void schema
  void config

  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>} */
  const issues = []
  issues.push(...validateProposal(proposalText))

  const deltaList = Array.isArray(deltas) ? deltas : []
  const skipSpecs = metadata?.skip_specs === true
  if (skipSpecs) {
    if (deltaList.length > 0) {
      issues.push({
        level: 'ERROR',
        path: '.openspec.yaml',
        message: `"skip_specs: true" conflicts with ${deltaList.length} delta spec file(s); remove skip_specs or the delta specs`,
      })
    }
  } else if (deltaList.length === 0) {
    issues.push({
      level: 'ERROR',
      path: 'specs',
      message:
        'change must include at least one delta spec at specs/<capability-path>/spec.md (set "skip_specs: true" in .openspec.yaml to opt out)',
    })
  }
  for (const delta of deltaList) issues.push(...validateDeltaFile(delta ?? {}))

  issues.push(...validateTasks(tasksText))
  issues.push(...validateMetadata({ metadata, metadataResult }))

  return finalize(issues)
}

/**
 * Validate one main capability spec.
 *
 * @param {{path?: string, text?: string, parsed?: object|null}} input
 * @returns {{issues: Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>, summary: {errors: number, warnings: number, infos: number}}}
 */
export function validateMainSpec({ path = 'spec.md', text = '', parsed = null } = {}) {
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}>} */
  const issues = []
  const document = typeof text === 'string' ? text : ''
  const result = parsed ?? parseMainSpec(document)

  for (const issue of result.issues ?? []) {
    /** @type {{level: 'ERROR'|'WARNING'|'INFO', path: string, line?: number, message: string}} */
    const entry = { level: issue.level, path, message: issue.message }
    if (typeof issue.line === 'number') entry.line = issue.line
    issues.push(entry)
  }

  if (result.purpose === null || result.purpose === undefined || result.purpose === '') {
    issues.push({ level: 'ERROR', path, message: 'main spec is missing a "## Purpose" section' })
  } else if (result.purpose.length < 50) {
    issues.push({
      level: 'WARNING',
      path,
      line: findLineNumber(document, '## Purpose'),
      message: `"## Purpose" should be at least 50 characters (currently ${result.purpose.length})`,
    })
  }

  const requirementsLine = findLineNumber(document, '## Requirements')
  if (requirementsLine === undefined) {
    issues.push({ level: 'ERROR', path, message: 'main spec is missing a "## Requirements" section' })
  }

  const requirements = Array.isArray(result.requirements) ? result.requirements : []
  if (requirements.length === 0) {
    issues.push({ level: 'ERROR', path, message: 'main spec must contain at least one "### Requirement:" block' })
  }
  for (const requirement of requirements) {
    const name = normalizeRequirementName(requirement.name)
    const line = findLineNumber(document, `### Requirement: ${requirement.name}`)
    if (!/\b(?:SHALL|MUST)\b/.test(requirement.raw ?? '')) {
      issues.push({ level: 'ERROR', path, line, message: `requirement "${name}" must contain SHALL or MUST` })
    }
    if (countScenarios(requirement.raw ?? '') === 0) {
      issues.push({
        level: 'ERROR',
        path,
        line,
        message: `requirement "${name}" must include at least one "#### Scenario:" block`,
      })
    }
    if (typeof requirement.text === 'string' && requirement.text.length > 500) {
      issues.push({
        level: 'WARNING',
        path,
        line,
        message: `requirement "${name}" body is longer than 500 characters; consider splitting it`,
      })
    }
  }

  return finalize(issues)
}
