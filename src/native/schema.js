/**
 * OpenSpec schema resolution (Host half).
 *
 * Native schemas live at `openspec/schemas/<name>/schema.yaml` and always win;
 * when the project has no such directory the pinned built-in snapshot at
 * `src/native-snapshot/<name>/schema.yaml` is used as a fallback (the snapshot
 * version is recorded on the resolved schema as `sourceVersion`).
 *
 * `loadBundledSchemas()` is synchronous per the module contract and therefore
 * reads only the plugin's own read-only snapshot with `node:fs`; all workspace
 * I/O goes through `node:fs/promises` helpers in `fsio.js`.
 *
 * @module dsh-spec/native/schema
 */

import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseYaml } from './yaml.js'
import { joinRel, listDir, normalizeRel, readTextOrNull } from './fsio.js'

/** Version marker of the bundled native snapshot (upstream OpenSpec version). */
const SNAPSHOT_VERSION = '1.14.3'

/** Base URL of the bundled native snapshot. */
const SNAPSHOT_URL = new URL('../native-snapshot/', import.meta.url)

/** Owning-directory URL helper for one bundled schema. @param {string} name @returns {string} */
function bundledSchemaDir(name) {
  return fileURLToPath(new URL(`./${name}/`, SNAPSHOT_URL))
}

/** Find the matching `}` for a `{` in a glob pattern. @param {string} source @param {number} start @returns {number} */
function matchingBrace(source, start) {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Split `{a,b}` alternatives on top-level commas. @param {string} body @returns {string[]} */
function splitAlternatives(body) {
  const out = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      out.push(body.slice(start, index))
      start = index + 1
    }
  }
  out.push(body.slice(start))
  return out
}

/** Translate one glob pattern into a regular-expression source. @param {string} source @returns {string} */
function translateGlob(source) {
  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        let end = index
        while (source[end + 1] === '*') end += 1
        if (source[end + 1] === '/') {
          out += '(?:[^/]+/)*'
          index = end + 1
        } else {
          out += '.*'
          index = end
        }
        continue
      }
      out += '[^/]*'
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '{') {
      const end = matchingBrace(source, index)
      if (end === -1) {
        out += '\\{'
        continue
      }
      const alternatives = splitAlternatives(source.slice(index + 1, end))
      out += `(?:${alternatives.map(translateGlob).join('|')})`
      index = end
      continue
    }
    if (/[.*+?^${}()|[\]\\]/.test(char)) {
      out += `\\${char}`
      continue
    }
    out += char
  }
  return out
}

/**
 * Compile a native output glob into a RegExp. Supported syntax: `**`, `*`, `?`
 * and `{a,b}` alternatives; paths use POSIX separators.
 *
 * @param {string} pattern glob pattern (e.g. `specs/**\/*.md`)
 * @returns {RegExp} anchored regular expression
 */
export function globToRegExp(pattern) {
  const normalized = String(pattern ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  return new RegExp(`^${translateGlob(normalized)}$`)
}

/**
 * Match a workspace/change-relative POSIX path against a glob pattern.
 *
 * @param {string} pattern glob pattern or plain path
 * @param {string} relPath POSIX path
 * @returns {boolean}
 */
export function matchGlob(pattern, relPath) {
  const normalized = String(relPath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  return globToRegExp(pattern).test(normalized)
}

/**
 * An empty schema value used when the document cannot be parsed.
 *
 * @returns {{name: string, version: number|string|null, description: string, artifacts: object[], apply: {requires: string[], tracks: string|null, instruction: string}}}
 */
function emptySchema() {
  return {
    name: '',
    version: null,
    description: '',
    artifacts: [],
    apply: { requires: [], tracks: null, instruction: '' },
  }
}

/**
 * Parse a native `schema.yaml` document into the engine's schema shape.
 *
 * Malformed YAML yields an ERROR issue (path = `sourceName`) and an empty schema
 * so callers can surface a schema error without hiding the change.
 *
 * @param {string} text YAML document text
 * @param {{sourceName?: string}} [options] `sourceName` is the issue path (file or snapshot name)
 * @returns {{schema: {name: string, version: number|string|null, description: string, artifacts: Array<{id: string, generates: string|string[]|null, description: string, template: string|null, instruction: string, requires: string[]}>, apply: {requires: string[], tracks: string|null, instruction: string}}, issues: Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>}}
 */
export function parseSchema(text, { sourceName = 'project' } = {}) {
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>} */
  const issues = []
  /** @param {'ERROR'|'WARNING'|'INFO'} level @param {string} message @param {number} [line] */
  const addIssue = (level, message, line) => {
    issues.push(line === undefined ? { level, path: sourceName, message } : { level, path: sourceName, line, message })
  }

  const parsed = parseYaml(text)
  if (parsed.error !== null) {
    addIssue('ERROR', `schema YAML is invalid: ${parsed.error.message}`, parsed.error.line)
    return { schema: emptySchema(), issues }
  }
  for (const warning of parsed.warnings) addIssue('WARNING', warning)
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    addIssue('ERROR', 'schema must be a YAML mapping')
    return { schema: emptySchema(), issues }
  }

  /** @type {Record<string, unknown>} */
  const raw = parsed.value
  const schema = emptySchema()

  if (typeof raw.name === 'string' && raw.name.trim() !== '') schema.name = raw.name.trim()
  else addIssue('WARNING', 'schema is missing a non-empty "name"')

  if (typeof raw.version === 'number' || typeof raw.version === 'string') schema.version = raw.version
  else if (raw.version !== undefined && raw.version !== null) addIssue('WARNING', '"version" must be a number or string; ignoring it')

  if (typeof raw.description === 'string') schema.description = raw.description
  else if (raw.description !== undefined && raw.description !== null) {
    addIssue('WARNING', '"description" must be a string; ignoring it')
  }

  if (raw.artifacts === undefined || raw.artifacts === null) {
    addIssue('ERROR', 'schema must declare an "artifacts" sequence')
  } else if (!Array.isArray(raw.artifacts)) {
    addIssue('ERROR', '"artifacts" must be a sequence')
  } else {
    raw.artifacts.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        addIssue('ERROR', `artifact #${index + 1} must be a mapping`)
        return
      }
      /** @type {Record<string, unknown>} */
      const item = entry
      if (typeof item.id !== 'string' || item.id.trim() === '') {
        addIssue('ERROR', `artifact #${index + 1} is missing a non-empty "id"`)
        return
      }
      const id = item.id.trim()

      let generates = null
      if (typeof item.generates === 'string' && item.generates.trim() !== '') generates = item.generates.trim()
      else if (Array.isArray(item.generates)) {
        const paths = item.generates.filter((value) => typeof value === 'string' && value.trim() !== '')
        if (paths.length > 0) generates = paths.map((value) => value.trim())
      }
      if (generates === null) addIssue('WARNING', `artifact "${id}" has no usable "generates" path`)

      const requires = []
      if (item.requires !== undefined && item.requires !== null) {
        if (Array.isArray(item.requires)) {
          for (const dependency of item.requires) {
            if (typeof dependency === 'string' && dependency.trim() !== '') requires.push(dependency.trim())
            else addIssue('WARNING', `artifact "${id}" has a non-string entry in "requires"; dropping it`)
          }
        } else {
          addIssue('WARNING', `artifact "${id}" "requires" must be a sequence of artifact ids; ignoring it`)
        }
      }

      let template = null
      if (typeof item.template === 'string' && item.template.trim() !== '') template = item.template.trim()
      else if (item.template !== undefined && item.template !== null) {
        addIssue('WARNING', `artifact "${id}" "template" must be a string; ignoring it`)
      }

      let instruction = ''
      if (typeof item.instruction === 'string') instruction = item.instruction
      else if (item.instruction !== undefined && item.instruction !== null) {
        addIssue('WARNING', `artifact "${id}" "instruction" must be a string; ignoring it`)
      }

      schema.artifacts.push({
        id,
        generates,
        description: typeof item.description === 'string' ? item.description : '',
        template,
        instruction,
        requires,
      })
    })
  }

  if (raw.apply !== undefined && raw.apply !== null) {
    if (typeof raw.apply !== 'object' || Array.isArray(raw.apply)) {
      addIssue('WARNING', '"apply" must be a mapping; ignoring it')
    } else {
      /** @type {Record<string, unknown>} */
      const apply = raw.apply
      if (apply.requires !== undefined && apply.requires !== null) {
        if (Array.isArray(apply.requires)) {
          for (const dependency of apply.requires) {
            if (typeof dependency === 'string' && dependency.trim() !== '') schema.apply.requires.push(dependency.trim())
            else addIssue('WARNING', 'apply.requires has a non-string entry; dropping it')
          }
        } else {
          addIssue('WARNING', '"apply.requires" must be a sequence of artifact ids; ignoring it')
        }
      }
      if (typeof apply.tracks === 'string' && apply.tracks.trim() !== '') schema.apply.tracks = apply.tracks.trim()
      else if (apply.tracks !== undefined && apply.tracks !== null) {
        addIssue('WARNING', '"apply.tracks" must be a non-empty string; ignoring it')
      }
      if (typeof apply.instruction === 'string') schema.apply.instruction = apply.instruction
      else if (apply.instruction !== undefined && apply.instruction !== null) {
        addIssue('WARNING', '"apply.instruction" must be a string; ignoring it')
      }
    }
  }

  return { schema, issues }
}

/**
 * Load the bundled native schema snapshot (synchronous, read-only).
 *
 * Returns an empty Map while the snapshot directory does not exist (e.g. during
 * a partial checkout), so callers degrade instead of failing.
 *
 * @returns {Map<string, {schema: object, source: 'builtin', dir: string}>}
 */
export function loadBundledSchemas() {
  /** @type {Map<string, {schema: object, source: 'builtin', dir: string}>} */
  const schemas = new Map()
  let entries
  try {
    entries = readdirSync(fileURLToPath(SNAPSHOT_URL), { withFileTypes: true })
  } catch {
    return schemas
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = bundledSchemaDir(entry.name)
    let text
    try {
      text = readFileSync(path.join(dir, 'schema.yaml'), 'utf8')
    } catch {
      continue
    }
    const parsed = parseSchema(text, { sourceName: `native-snapshot/${entry.name}/schema.yaml` })
    if (parsed.issues.some((issue) => issue.level === 'ERROR')) continue
    parsed.schema.name = entry.name
    schemas.set(entry.name, { schema: parsed.schema, source: 'builtin', dir })
  }
  return schemas
}

/**
 * Load project-local schemas from `openspec/schemas/<name>/schema.yaml`.
 *
 * @param {string} cwd absolute workspace root
 * @returns {Promise<{schemas: Array<{schema: object, source: 'project', dir: string}>, issues: Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>}>}
 */
export async function loadProjectSchemas(cwd) {
  /** @type {Array<{schema: object, source: 'project', dir: string}>} */
  const schemas = []
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>} */
  const issues = []
  const baseRel = 'openspec/schemas'
  const entries = await listDir(cwd, baseRel)
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const dirRel = joinRel(baseRel, entry.name)
    let schemaRel = null
    let text = null
    for (const file of ['schema.yaml', 'schema.yml']) {
      const candidate = joinRel(dirRel, file)
      const content = await readTextOrNull(cwd, candidate)
      if (content !== null) {
        schemaRel = candidate
        text = content
        break
      }
    }
    if (text === null || schemaRel === null) {
      issues.push({
        level: 'WARNING',
        path: dirRel,
        message: `schema directory "${entry.name}" has no schema.yaml`,
      })
      continue
    }
    const parsed = parseSchema(text, { sourceName: schemaRel })
    issues.push(...parsed.issues)
    if (parsed.issues.some((issue) => issue.level === 'ERROR' && issue.message.startsWith('schema YAML'))) continue
    if (parsed.schema.name !== '' && parsed.schema.name !== entry.name) {
      issues.push({
        level: 'WARNING',
        path: schemaRel,
        message: `schema declares name "${parsed.schema.name}" but its directory is "${entry.name}"; using the directory name`,
      })
    }
    parsed.schema.name = entry.name
    schemas.push({ schema: parsed.schema, source: 'project', dir: dirRel })
  }
  return { schemas, issues }
}

/**
 * Resolve a schema by name: project-local definitions win over the bundled
 * snapshot; the snapshot version is recorded as `schema.sourceVersion`.
 *
 * @param {{name?: string, projectSchemas?: Array<{schema: object, source: 'project'|'builtin', dir: string}>}} input
 * @returns {{schema: object|null, source: 'project'|'builtin'|null, issues: Array<{level: 'ERROR'|'WARNING'|'INFO', path?: string, line?: number, message: string}>}}
 */
export function resolveSchema({ name, projectSchemas = [] } = {}) {
  const requested = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'spec-driven'
  const project = projectSchemas.find(
    (entry) =>
      entry?.schema?.name === requested ||
      (typeof entry?.dir === 'string' && entry.dir.split('/').pop() === requested),
  )
  if (project !== undefined) return { schema: project.schema, source: 'project', issues: [] }

  const builtin = loadBundledSchemas().get(requested)
  if (builtin !== undefined) {
    return {
      schema: { ...builtin.schema, sourceVersion: SNAPSHOT_VERSION },
      source: 'builtin',
      issues: [],
    }
  }
  return {
    schema: null,
    source: null,
    issues: [
      {
        level: 'ERROR',
        path: 'openspec/schemas',
        message: `schema "${requested}" was not found in openspec/schemas/ and is not bundled with this plugin (snapshot ${SNAPSHOT_VERSION})`,
      },
    ],
  }
}

/**
 * Read the template body for one artifact of a resolved schema.
 *
 * Project schemas resolve `<dir>/templates/<template>`; bundled schemas are read
 * relative to this module from `../native-snapshot/<name>/templates/<template>`.
 *
 * @param {string} cwd absolute workspace root
 * @param {{schema?: object|null, source?: 'project'|'builtin'|null, dir?: string}|null} resolvedSchema
 * @param {{template?: string|null}|null} artifact
 * @returns {Promise<string|null>} template text, or `null` when it cannot be resolved
 */
export async function readArtifactTemplate(cwd, resolvedSchema, artifact) {
  if (!resolvedSchema || resolvedSchema.schema === null || resolvedSchema.schema === undefined) return null
  if (!artifact || typeof artifact.template !== 'string' || artifact.template.trim() === '') return null
  let rel
  try {
    rel = normalizeRel(joinRel('templates', artifact.template))
  } catch {
    return null
  }
  if (resolvedSchema.source === 'builtin') {
    const name = resolvedSchema.schema.name
    if (typeof name !== 'string' || name === '') return null
    try {
      return await readFile(new URL(`./${name}/${rel}`, SNAPSHOT_URL), 'utf8')
    } catch {
      return null
    }
  }
  if (typeof resolvedSchema.dir === 'string' && resolvedSchema.dir !== '') {
    return readTextOrNull(cwd, joinRel(resolvedSchema.dir, rel))
  }
  return null
}
