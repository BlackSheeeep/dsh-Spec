/**
 * Change metadata (`.openspec.yaml`) parsing for OpenSpec-native changes.
 *
 * Effective schema precedence is **change metadata > project config > built-in
 * default** (`spec-driven`). Known keys are validated; unknown keys warn so a
 * newer upstream metadata key is visible but never fatal, and `x-` prefixed
 * extension keys are accepted silently.
 *
 * @module dsh-spec/native/metadata
 */

import { parseYaml } from './yaml.js'
import { joinRel, readTextOrNull } from './fsio.js'

/** Metadata file name inside a change directory. */
const METADATA_FILE = '.openspec.yaml'

/** Native date format for `created`. */
const CREATED_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Metadata keys the snapshot knows about. */
const KNOWN_KEYS = new Set([
  'schema',
  'created',
  'goal',
  'skip_specs',
  'retire_capabilities',
  'affected_areas',
  'initiative',
])

/**
 * 1-based line number of `key:` in a YAML text, when present.
 *
 * @param {string} text
 * @param {string} key
 * @returns {number|undefined}
 */
function findKeyLine(text, key) {
  const lines = String(text ?? '').split(/\r?\n/)
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1
  }
  return undefined
}

/**
 * Validate/normalize one metadata mapping, collecting warnings and at most one
 * blocking error (invalid YAML is handled before this function).
 *
 * @param {Record<string, unknown>} raw
 * @param {string} text raw file text (line lookup)
 * @param {string[]} warnings
 * @returns {{message: string, line?: number}|null}
 */
function inspectMetadata(raw, text, warnings) {
  for (const key of Object.keys(raw)) {
    if (KNOWN_KEYS.has(key) || key.startsWith('x-')) continue
    const line = findKeyLine(text, key)
    warnings.push(`unknown change metadata key "${key}"${line === undefined ? '' : ` (line ${line})`}`)
  }

  if (raw.created !== undefined && raw.created !== null) {
    if (typeof raw.created !== 'string' || !CREATED_PATTERN.test(raw.created)) {
      return {
        message: `"created" must be a YYYY-MM-DD date (got ${JSON.stringify(raw.created)})`,
        line: findKeyLine(text, 'created'),
      }
    }
  }
  if (raw.schema !== undefined && raw.schema !== null) {
    if (typeof raw.schema !== 'string' || raw.schema.trim() === '') {
      return {
        message: '"schema" must be a non-empty string',
        line: findKeyLine(text, 'schema'),
      }
    }
  }
  for (const key of ['skip_specs', 'retire_capabilities']) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'boolean') {
      return {
        message: `"${key}" must be a boolean`,
        line: findKeyLine(text, key),
      }
    }
  }

  if (raw.goal !== undefined && raw.goal !== null && typeof raw.goal !== 'string') {
    warnings.push('"goal" must be a string; ignoring it')
  }
  if (raw.affected_areas !== undefined && raw.affected_areas !== null) {
    const ok =
      Array.isArray(raw.affected_areas) && raw.affected_areas.every((entry) => typeof entry === 'string')
    if (!ok) warnings.push('"affected_areas" must be an array of strings; ignoring it')
  }
  if (raw.initiative !== undefined && raw.initiative !== null && typeof raw.initiative !== 'string') {
    warnings.push('"initiative" must be a string; ignoring it')
  }
  return null
}

/**
 * Normalize a parsed metadata mapping to the shape the native engine exposes.
 *
 * @param {Record<string, unknown>} raw
 * @returns {{schema: string|null, created: string|null, goal: string|null, skip_specs: boolean, retire_capabilities: boolean, affected_areas?: string[], initiative?: string, [key: string]: unknown}}
 */
function normalizeMetadata(raw) {
  /** @type {Record<string, unknown>} */
  const metadata = {
    schema: typeof raw.schema === 'string' && raw.schema.trim() !== '' ? raw.schema.trim() : null,
    created: typeof raw.created === 'string' ? raw.created : null,
    goal: typeof raw.goal === 'string' ? raw.goal : null,
    skip_specs: raw.skip_specs === true,
    retire_capabilities: raw.retire_capabilities === true,
  }
  if (Array.isArray(raw.affected_areas) && raw.affected_areas.every((entry) => typeof entry === 'string')) {
    metadata.affected_areas = [...raw.affected_areas]
  }
  if (typeof raw.initiative === 'string') metadata.initiative = raw.initiative
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('x-')) metadata[key] = value
  }
  return metadata
}

/**
 * An empty normalized metadata object (no `.openspec.yaml`, or unparseable).
 *
 * @returns {{schema: null, created: null, goal: null, skip_specs: boolean, retire_capabilities: boolean}}
 */
function emptyMetadata() {
  return {
    schema: null,
    created: null,
    goal: null,
    skip_specs: false,
    retire_capabilities: false,
  }
}

/**
 * Parse `.openspec.yaml` content.
 *
 * @param {string} text YAML file content
 * @returns {{value: Record<string, unknown>|null, warnings: string[], error: {message: string, line?: number}|null}}
 */
export function parseChangeMetadata(text) {
  const parsed = parseYaml(text)
  /** @type {string[]} */
  const warnings = [...parsed.warnings]
  if (parsed.error !== null) {
    return {
      value: null,
      warnings,
      error: { message: `invalid YAML: ${parsed.error.message}`, line: parsed.error.line },
    }
  }
  if (parsed.value === null) return { value: {}, warnings, error: null }
  if (typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return {
      value: null,
      warnings,
      error: { message: 'change metadata must be a YAML mapping', line: 1 },
    }
  }
  /** @type {Record<string, unknown>} */
  const raw = parsed.value
  const error = inspectMetadata(raw, text, warnings)
  return { value: raw, warnings, error }
}

/**
 * Read and normalize `openspec/changes/<name>/.openspec.yaml`.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} changeRel workspace-relative change directory
 * @returns {Promise<{found: boolean, metadata: {schema: string|null, created: string|null, goal: string|null, skip_specs: boolean, retire_capabilities: boolean, [key: string]: unknown}, warnings: string[], error: {message: string, line?: number}|null}>}
 */
export async function readChangeMetadata(cwd, changeRel) {
  const rel = joinRel(changeRel, METADATA_FILE)
  const text = await readTextOrNull(cwd, rel)
  if (text === null) {
    return { found: false, metadata: emptyMetadata(), warnings: [], error: null }
  }
  const parsed = parseChangeMetadata(text)
  return {
    found: true,
    metadata: parsed.value === null ? emptyMetadata() : normalizeMetadata(parsed.value),
    warnings: parsed.warnings,
    error: parsed.error,
  }
}

/**
 * Resolve the effective schema name: change metadata first, then project
 * configuration, then the built-in fallback.
 *
 * @param {{changeMetadata?: {schema?: unknown}|null, projectConfig?: {schema?: unknown}|null, fallback?: string}} input
 * @returns {string}
 */
export function resolveSchemaName({ changeMetadata = null, projectConfig = null, fallback = 'spec-driven' } = {}) {
  /** @param {unknown} value @returns {string|null} */
  const usable = (value) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  return usable(changeMetadata?.schema) ?? usable(projectConfig?.schema) ?? usable(fallback) ?? 'spec-driven'
}

/**
 * Format a date as `YYYY-MM-DD` in the local time zone (native archive naming).
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function formatLocalDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Serialize one value as a YAML scalar (plain when safe, double-quoted otherwise).
 *
 * @param {string} value
 * @returns {string}
 */
function yamlScalar(value) {
  const text = String(value)
  const needsQuotes =
    text === '' ||
    text.trim() !== text ||
    /^[\s#'"`&*!|>%@\-[\]{}]/.test(text) ||
    text.includes(': ') ||
    text.includes(' #') ||
    /[\r\n\t]/.test(text)
  return needsQuotes ? JSON.stringify(text) : text
}

/**
 * Serialize the native `.openspec.yaml` body (trailing newline, stable key order).
 *
 * @param {{schema?: string|null, created?: string|null, goal?: string|null}} input
 * @returns {string} YAML text, empty string when no field is provided
 */
export function serializeChangeMetadata({ schema = null, created = null, goal = null } = {}) {
  const lines = []
  if (typeof schema === 'string' && schema.trim() !== '') lines.push(`schema: ${yamlScalar(schema.trim())}`)
  if (typeof created === 'string' && created.trim() !== '') lines.push(`created: ${yamlScalar(created.trim())}`)
  if (typeof goal === 'string' && goal.trim() !== '') lines.push(`goal: ${yamlScalar(goal.trim())}`)
  if (lines.length === 0) return ''
  return `${lines.join('\n')}\n`
}
