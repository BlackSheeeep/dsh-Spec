/**
 * Project configuration parsing for OpenSpec-native workspaces (Host half).
 *
 * Reads `openspec/config.yaml` (falling back to `config.yml` only when the
 * `.yaml` file is absent) and degrades field by field: one invalid field, an
 * invalid document or an oversized `context` produces a warning while the rest
 * of the configuration keeps working.
 *
 * @module dsh-spec/native/config
 */

import { parseYaml } from './yaml.js'
import { joinRel, readTextOrNull } from './fsio.js'

/** Default schema when the project does not configure one. */
const DEFAULT_SCHEMA = 'spec-driven'

/** `context` above this many UTF-8 bytes is ignored with a warning. */
const MAX_CONTEXT_BYTES = 51200

/**
 * Normalize the `rules` mapping (`{ [artifactId]: string[] }`).
 *
 * @param {unknown} raw
 * @param {string} file warning prefix
 * @param {string[]} warnings collected warnings
 * @returns {Record<string, string[]>}
 */
function normalizeRules(raw, file, warnings) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${file}: "rules" must be a mapping of artifact id to strings; ignoring it`)
    return {}
  }
  /** @type {Record<string, string[]>} */
  const rules = {}
  for (const [artifactId, value] of Object.entries(raw)) {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null
    if (list === null) {
      warnings.push(`${file}: rules for "${artifactId}" must be a string or an array of strings; ignoring it`)
      continue
    }
    const kept = []
    for (const entry of list) {
      if (typeof entry === 'string' && entry.trim() !== '') kept.push(entry)
      else warnings.push(`${file}: dropping a non-string or empty rule for "${artifactId}"`)
    }
    if (kept.length > 0) rules[artifactId] = kept
  }
  return rules
}

/**
 * Normalize `operations.apply.guidance` / `operations.archive.guidance`.
 *
 * @param {unknown} raw
 * @param {string} file
 * @param {string[]} warnings
 * @returns {{apply?: {guidance?: string}, archive?: {guidance?: string}}}
 */
function normalizeOperations(raw, file, warnings) {
  /** @type {{apply?: {guidance?: string}, archive?: {guidance?: string}}} */
  const operations = {}
  if (raw === undefined || raw === null) return operations
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${file}: "operations" must be a mapping; ignoring it`)
    return operations
  }
  for (const name of ['apply', 'archive']) {
    const value = raw[name]
    if (value === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      warnings.push(`${file}: "operations.${name}" must be a mapping; ignoring it`)
      continue
    }
    const guidance = value.guidance
    if (guidance === undefined) continue
    if (typeof guidance === 'string' && guidance.trim() !== '') operations[name] = { guidance }
    else warnings.push(`${file}: "operations.${name}.guidance" must be a non-empty string; ignoring it`)
  }
  return operations
}

/**
 * Build the default project configuration (invalid or missing file).
 *
 * @param {string|null} file basename that was read, or null
 * @param {string[]} warnings
 * @returns {{found: boolean, file: string|null, schema: string, context: string, rules: Record<string, string[]>, operations: object, warnings: string[]}}
 */
function defaults(file, warnings) {
  return {
    found: true,
    file,
    schema: DEFAULT_SCHEMA,
    context: '',
    rules: {},
    operations: {},
    warnings,
  }
}

/**
 * Parse `openspec/config.yaml` content. Never throws: invalid YAML yields the
 * documented defaults plus a warning carrying the file and line number.
 *
 * @param {string} text YAML file content
 * @param {string} [file] basename used in warning messages
 * @returns {{found: boolean, file: string, schema: string, context: string, rules: Record<string, string[]>, operations: {apply?: {guidance?: string}, archive?: {guidance?: string}}, warnings: string[]}}
 */
export function parseProjectConfig(text, file = 'config.yaml') {
  const parsed = parseYaml(text)
  /** @type {string[]} */
  const warnings = [...parsed.warnings]
  if (parsed.error !== null) {
    warnings.push(`${file}:${parsed.error.line}: invalid YAML: ${parsed.error.message}`)
    return defaults(file, warnings)
  }
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    warnings.push(`${file}: configuration must be a YAML mapping; using defaults`)
    return defaults(file, warnings)
  }

  const raw = parsed.value
  let schema = DEFAULT_SCHEMA
  if (raw.schema !== undefined && raw.schema !== null) {
    if (typeof raw.schema === 'string' && raw.schema.trim() !== '') schema = raw.schema.trim()
    else warnings.push(`${file}: "schema" must be a non-empty string; using "${DEFAULT_SCHEMA}"`)
  }

  let context = ''
  if (raw.context !== undefined && raw.context !== null) {
    if (typeof raw.context !== 'string') {
      warnings.push(`${file}: "context" must be a string; ignoring it`)
    } else if (Buffer.byteLength(raw.context, 'utf8') > MAX_CONTEXT_BYTES) {
      warnings.push(
        `${file}: "context" is larger than ${MAX_CONTEXT_BYTES} bytes and was ignored (${Buffer.byteLength(raw.context, 'utf8')} bytes)`,
      )
    } else {
      context = raw.context
    }
  }

  return {
    found: true,
    file,
    schema,
    context,
    rules: normalizeRules(raw.rules, file, warnings),
    operations: normalizeOperations(raw.operations, file, warnings),
    warnings,
  }
}

/**
 * Read the project configuration from the workspace.
 *
 * Tries `openspec/config.yaml` first and only falls back to `openspec/config.yml`
 * when the `.yaml` file is absent. A missing configuration is not an error.
 *
 * @param {string} cwd absolute workspace root
 * @returns {Promise<{found: boolean, file: 'config.yaml'|'config.yml'|null, schema: string, context: string, rules: Record<string, string[]>, operations: object, warnings: string[]}>}
 */
export async function readProjectConfig(cwd) {
  for (const file of ['config.yaml', 'config.yml']) {
    const text = await readTextOrNull(cwd, joinRel('openspec', file))
    if (text !== null) return parseProjectConfig(text, file)
  }
  return {
    found: false,
    file: null,
    schema: DEFAULT_SCHEMA,
    context: '',
    rules: {},
    operations: {},
    warnings: [],
  }
}
