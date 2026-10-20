/**
 * Native artifact prompt composition (Host half).
 *
 * Mirrors the order OpenSpec itself uses when it hands an artifact to an
 * agent (`openspec instructions` text output): the schema `instruction`,
 * resolved placeholders (change name, output path, dependencies, intent),
 * project `<context>`, this artifact's `<rules>`, the schema `<template>`,
 * dependency status, the artifacts it unlocks, and the phase boundary.
 *
 * The composer is pure composition over data supplied by the engine modules:
 * it reads only the artifact template from disk (`schema.readArtifactTemplate`)
 * and never writes anything. When the effective schema came from the bundled
 * snapshot instead of the project, one short note naming `SNAPSHOT_VERSION` is
 * appended so the model (and the panel) can tell which contract it received.
 *
 * @module dsh-spec/native/instruction
 */

import { loadBundledSchemas, loadProjectSchemas, readArtifactTemplate, resolveSchema } from './schema.js'

/** Version of the bundled upstream OpenSpec snapshot this plugin targets. */
export const SNAPSHOT_VERSION = '1.14.3'

/** Workspace-relative root of active changes. */
const CHANGE_ROOT = 'openspec/changes'

/** Schema name used by the bundled fallback snapshot. */
const FALLBACK_SCHEMA = 'spec-driven'

/** Cache of the bundled snapshot schemas (read once per process). */
let bundledCache = null

/** Read the bundled snapshot schemas once; never throws. */
function bundledSchemas() {
  if (bundledCache === null) {
    try {
      bundledCache = loadBundledSchemas()
    } catch {
      bundledCache = new Map()
    }
  }
  return bundledCache
}

/**
 * Normalize a resolved schema wrapper or a bare schema definition into one
 * shape: `{ definition, source, dir, sourceVersion }`.
 *
 * `resolveSchema()` may hand callers either the wrapper it returns
 * (`{ schema, source, dir, sourceVersion }`) or, in tests and custom code, a
 * bare definition with `.artifacts`. Both are accepted.
 */
function normalizeSchema(schema) {
  const empty = { definition: null, source: null, dir: null, sourceVersion: null }
  if (!schema || typeof schema !== 'object') return empty
  if (Array.isArray(schema.artifacts)) {
    return {
      definition: schema,
      source: typeof schema.source === 'string' ? schema.source : null,
      dir: typeof schema.dir === 'string' ? schema.dir : null,
      sourceVersion: typeof schema.sourceVersion === 'string' ? schema.sourceVersion : null,
    }
  }
  if (schema.schema && Array.isArray(schema.schema.artifacts)) {
    return {
      definition: schema.schema,
      source: typeof schema.source === 'string' ? schema.source : null,
      dir: typeof schema.dir === 'string' ? schema.dir : null,
      sourceVersion:
        typeof schema.sourceVersion === 'string'
          ? schema.sourceVersion
          : typeof schema.schema.sourceVersion === 'string'
            ? schema.schema.sourceVersion
            : null,
    }
  }
  return empty
}

/** Whether the effective schema is the bundled snapshot rather than a project schema. */
function isSnapshotFallback(parts) {
  if (parts.source === 'builtin') return true
  if (typeof parts.sourceVersion === 'string' && parts.sourceVersion.length > 0) return true
  return false
}

/** Build a resolved-schema-shaped object for `readArtifactTemplate`. */
function asResolvedSchema(parts) {
  return {
    schema: parts.definition,
    source: parts.source ?? (isSnapshotFallback(parts) ? 'builtin' : null),
    dir: parts.dir ?? undefined,
    ...(parts.sourceVersion ? { sourceVersion: parts.sourceVersion } : {}),
  }
}

/** Fall back to the bundled `spec-driven` snapshot when no schema was supplied. */
function fallbackParts() {
  const bundled = bundledSchemas()
  const entry = bundled.get(FALLBACK_SCHEMA)
  if (!entry) return normalizeSchema(null)
  return normalizeSchema(entry)
}

/** Resolve the effective schema parts, falling back to the bundled snapshot. */
async function effectiveParts(schema) {
  const parts = normalizeSchema(schema)
  if (parts.definition) return parts
  return fallbackParts()
}

/**
 * Recover where a bare schema definition came from when the caller dropped the
 * resolution wrapper (host callers sometimes pass `resolved.schema` directly).
 * Without this, project-schema templates cannot be located and the bundled
 * snapshot fallback could be mislabelled.
 *
 * @param {{definition: object|null, source: string|null, dir: string|null, sourceVersion: string|null}} parts
 * @param {string} cwd absolute workspace root
 * @returns {Promise<typeof parts>} parts with `source`/`dir` filled in when recoverable
 */
async function recoverResolution(parts, cwd) {
  if (!parts.definition) return parts
  if (parts.source !== null || parts.dir !== null) return parts
  const name = typeof parts.definition.name === 'string' ? parts.definition.name : ''
  // A `sourceVersion` means the engine already resolved this to the snapshot.
  if (parts.sourceVersion !== null) {
    const bundled = name.length > 0 ? bundledSchemas().get(name) : null
    return { ...parts, source: 'builtin', dir: bundled && typeof bundled.dir === 'string' ? bundled.dir : null }
  }
  if (name.length === 0) return parts
  try {
    const project = await loadProjectSchemas(cwd)
    const schemas = project && Array.isArray(project.schemas) ? project.schemas : []
    const match = schemas.find(
      (entry) =>
        entry?.schema?.name === name || (typeof entry?.dir === 'string' && entry.dir.split('/').pop() === name),
    )
    if (match) return { ...parts, source: 'project', dir: typeof match.dir === 'string' ? match.dir : null }
  } catch {
    /* project schema lookup is best effort */
  }
  const bundled = bundledSchemas().get(name)
  if (bundled) {
    return {
      ...parts,
      source: 'builtin',
      dir: typeof bundled.dir === 'string' ? bundled.dir : null,
      sourceVersion: parts.sourceVersion ?? SNAPSHOT_VERSION,
    }
  }
  return parts
}

/** Find the artifact definition to compose, accepting an id, an id-like object or a definition. */
function resolveArtifactDef(definition, artifact) {
  const id =
    typeof artifact === 'string'
      ? artifact
      : artifact && typeof artifact === 'object' && typeof artifact.id === 'string'
        ? artifact.id
        : ''
  if (id.length === 0) return { id: '', definition: null, supplied: null }
  if (artifact && typeof artifact === 'object') {
    // A full definition was supplied: trust it even when it is not in the
    // schema (buildApplyPrompt uses this for the apply phase contract).
    return { id, definition: artifact, supplied: artifact }
  }
  if (id === 'apply' && definition.apply && typeof definition.apply === 'object') {
    return {
      id,
      supplied: null,
      definition: {
        id: 'apply',
        generates: typeof definition.apply.tracks === 'string' ? definition.apply.tracks : '',
        description: 'Implementation phase',
        template: '',
        instruction: typeof definition.apply.instruction === 'string' ? definition.apply.instruction : '',
        requires: Array.isArray(definition.apply.requires) ? definition.apply.requires.slice() : [],
      },
    }
  }
  const found =
    Array.isArray(definition.artifacts) && definition.artifacts.find((entry) => entry && entry.id === id)
  return { id, definition: found ?? null, supplied: null }
}

/** Look up a dependency artifact definition by id. */
function findArtifact(definition, id) {
  return Array.isArray(definition.artifacts) ? definition.artifacts.find((entry) => entry && entry.id === id) : null
}

/** Normalize an artifact `generates` value (string or list) to display text. */
function generatesOf(artifactDefinition) {
  const generates = artifactDefinition ? artifactDefinition.generates : null
  if (typeof generates === 'string') return generates
  if (Array.isArray(generates)) return generates.filter((value) => typeof value === 'string').join(', ')
  return ''
}

/** Resolve the workspace-relative output path for one artifact. */
function artifactOutputPath(changeName, artifactDefinition) {
  const name = typeof changeName === 'string' && changeName.length > 0 ? changeName : '<change-name>'
  const generates = generatesOf(artifactDefinition)
  return generates.length > 0 ? `${CHANGE_ROOT}/${name}/${generates}` : `${CHANGE_ROOT}/${name}/`
}

/** Whether an artifact output pattern needs a concrete path chosen by the model. */
function isGlobOutput(generates) {
  return typeof generates === 'string' && /[*?{[]/.test(generates)
}

/** Current artifact scoped rules from the project config (string[]). */
function rulesForArtifact(config, artifactId) {
  const rules = config && typeof config === 'object' ? config.rules : null
  if (!rules || typeof rules !== 'object') return []
  const value = Object.hasOwn(rules, artifactId) ? rules[artifactId] : null
  if (Array.isArray(value)) return value.filter((rule) => typeof rule === 'string' && rule.trim().length > 0).map((rule) => rule.trim())
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()]
  return []
}

/** Non-empty trimmed project context from the config, or ''. */
function projectContext(config) {
  if (!config || typeof config !== 'object') return ''
  return typeof config.context === 'string' ? config.context.trim() : ''
}

/**
 * Compose the model-facing prompt for one native artifact.
 *
 * Composition order is the native one: instruction → resolved placeholders
 * (change name, output path, dependencies, intent) → `<context>` → artifact
 * `<rules>` → template body → dependency status → unlocks → phase boundary.
 * A schema that resolves to the bundled snapshot gets one extra note naming
 * {@link SNAPSHOT_VERSION}.
 *
 * @param {object} options
 * @param {string} options.cwd absolute workspace root (used only to read templates)
 * @param {object} options.schema resolved schema (`{schema, source, dir}`) or a bare schema definition
 * @param {string|object} options.artifact artifact id or artifact definition
 * @param {object} [options.config] project config from `readProjectConfig` (context/rules/operations)
 * @param {string} [options.changeName] change name for the resolved output path
 * @param {string[]} [options.dependsDone] dependency artifact ids that are already completed
 * @param {string} [options.intent] free-text intent to surface in the placeholders block
 * @param {boolean} [options.suppressSnapshotNote] internal option for prompt builders that
 *        compose several artifacts into one prompt and add a single fallback note once
 * @returns {Promise<{text: string, warnings: string[]}>}
 */
export async function composeArtifactPrompt({
  cwd,
  schema,
  artifact,
  config = {},
  changeName = '',
  dependsDone = [],
  intent = '',
  suppressSnapshotNote = false,
} = {}) {
  const warnings = []
  const parts = await recoverResolution(await effectiveParts(schema), cwd)
  const definition = parts.definition
  if (!definition) {
    throw new Error('composeArtifactPrompt requires an effective schema with artifacts (none was supplied and the bundled snapshot is unavailable)')
  }
  const resolved = resolveArtifactDef(definition, artifact)
  if (!resolved.definition) {
    throw new Error(`Artifact '${resolved.id || String(artifact ?? '')}' not found in schema '${definition.name ?? 'unknown'}'`)
  }
  const artifactDefinition = resolved.definition
  const artifactId = artifactDefinition.id

  // Read the template from disk: project schema templates win, bundled paths
  // fall back to this module's snapshot. Missing templates are non-fatal.
  let template = null
  if (typeof artifactDefinition.template === 'string' && artifactDefinition.template.length > 0) {
    try {
      template = await readArtifactTemplate(cwd, asResolvedSchema(parts), artifactDefinition)
    } catch (error) {
      warnings.push(`could not read the ${artifactId} template: ${error instanceof Error ? error.message : String(error)}`)
      template = null
    }
    if (template === null) warnings.push(`template '${artifactDefinition.template}' was not found for schema '${definition.name ?? 'unknown'}'`)
  }

  const done = new Set(Array.isArray(dependsDone) ? dependsDone.filter((id) => typeof id === 'string') : [])
  const requirements = Array.isArray(artifactDefinition.requires) ? artifactDefinition.requires.filter((id) => typeof id === 'string') : []
  const context = projectContext(config)
  const rules = rulesForArtifact(config, artifactId)
  const outputPath = artifactOutputPath(changeName, artifactDefinition)
  const glob = isGlobOutput(generatesOf(artifactDefinition))
  const unlocks =
    Array.isArray(definition.artifacts) && artifactId !== 'apply'
      ? definition.artifacts
          .filter((entry) => entry && entry.id !== artifactId && Array.isArray(entry.requires) && entry.requires.includes(artifactId))
          .map((entry) => entry.id)
      : []
  const isApply = artifactId === 'apply'
  const schemaName = typeof definition.name === 'string' && definition.name.length > 0 ? definition.name : 'custom'
  const name = typeof changeName === 'string' && changeName.length > 0 ? changeName : '<change-name>'

  const lines = []
  lines.push(`<artifact id="${artifactId}" change="${name}" schema="${schemaName}">`)
  lines.push('')

  // 1. Schema instruction (native first).
  lines.push('<instruction>')
  lines.push(
    typeof artifactDefinition.instruction === 'string' && artifactDefinition.instruction.trim().length > 0
      ? artifactDefinition.instruction.trim()
      : `Create the ${artifactId} artifact for change "${name}".`,
  )
  lines.push('</instruction>')
  lines.push('')

  // 2. Resolved placeholders: change name, output path, dependencies, intent.
  lines.push(`Change: ${name}`)
  lines.push(`Output path: ${outputPath}${glob ? ' (glob pattern: choose one concrete file path inside the change folder that matches it)' : ''}`)
  lines.push(`Depends on: ${requirements.length > 0 ? requirements.join(', ') : 'none'}`)
  if (typeof intent === 'string' && intent.trim().length > 0) lines.push(`Intent: ${intent.trim()}`)
  lines.push('')

  // 3. Project context.
  if (context.length > 0) {
    lines.push('<context>')
    lines.push('<!-- Project context from openspec/config.yaml. Use it as a constraint; do NOT copy it into the artifact. -->')
    lines.push(context)
    lines.push('</context>')
    lines.push('')
  }

  // 4. This artifact's rules only.
  if (rules.length > 0) {
    lines.push(`<rules artifact="${artifactId}">`)
    lines.push('<!-- Project rules for this artifact. Apply them as constraints; do NOT copy them into the artifact. -->')
    for (const rule of rules) lines.push(`- ${rule}`)
    lines.push('</rules>')
    lines.push('')
  }

  // 5. Template body.
  if (typeof template === 'string' && template.trim().length > 0) {
    lines.push('<template>')
    lines.push('<!-- Use this as the structure for your output file. Fill in the sections. -->')
    lines.push(template.trim())
    lines.push('</template>')
    lines.push('')
  }

  // 6. Dependency status.
  lines.push('<dependencies>')
  if (requirements.length === 0) {
    lines.push('No dependency artifacts.')
  } else {
    lines.push('Read the current contents of each completed dependency file before writing this artifact; re-read from disk even if you saw it earlier.')
    for (const dependencyId of requirements) {
      const dependencyDefinition = findArtifact(definition, dependencyId)
      const dependencyPath = dependencyDefinition
        ? `${CHANGE_ROOT}/${name}/${generatesOf(dependencyDefinition)}`
        : `${CHANGE_ROOT}/${name}/${dependencyId}`
      if (done.has(dependencyId)) {
        lines.push(`<dependency id="${dependencyId}" status="done">`)
        lines.push(`  <path>${dependencyPath}</path>`)
        lines.push('</dependency>')
      } else {
        lines.push(`<dependency id="${dependencyId}" status="missing">`)
        lines.push(`  <path>${dependencyPath}</path>`)
        lines.push('</dependency>')
      }
    }
  }
  lines.push('</dependencies>')
  lines.push('')

  // 7. Unlocks.
  if (unlocks.length > 0) {
    lines.push('<unlocks>')
    lines.push(`Completing this artifact enables: ${unlocks.join(', ')}`)
    lines.push('</unlocks>')
    lines.push('')
  }

  // 8. Phase boundary.
  lines.push('<phase_boundary>')
  lines.push(
    isApply
      ? [
          'Implementation phase: implement the tracked tasks in order and tick each task checkbox in the tracking file as soon as that task is finished.',
          'Keep changes minimal and aligned with the planning artifacts. If the plan turns out to be wrong, stop and report the artifact updates instead of improvising.',
        ].join(' ')
      : [
          `Planning phase only: create only the ${artifactId} artifact at the output path above. Do not write product code.`,
          'When it is written, re-check the change status and continue with the next ready artifact; once every planning artifact is done or skipped, stop and wait for review.',
        ].join(' '),
  )
  lines.push('</phase_boundary>')

  // Snapshot fallback note: exactly one short note naming the pinned version.
  if (!suppressSnapshotNote && isSnapshotFallback(parts)) {
    lines.push('')
    lines.push(`<snapshot_note>Schema fallback: this prompt used the bundled OpenSpec ${SNAPSHOT_VERSION} snapshot because no project schema supplied this artifact.</snapshot_note>`)
  }

  lines.push('')
  lines.push('</artifact>')
  return { text: lines.join('\n'), warnings }
}

/**
 * Read one artifact's native `instruction` string from a schema.
 *
 * Accepts a resolved schema wrapper, a bare schema definition, or a schema
 * name (resolved through the project's `openspec/schemas/` first, then the
 * bundled snapshot). Returns `''` when no instruction is available instead of
 * throwing, so callers can degrade gracefully.
 *
 * @param {string} cwd absolute workspace root
 * @param {object|string} schema resolved schema wrapper, bare schema definition or schema name
 * @param {string} artifactId artifact id (`apply` reads `schema.apply.instruction`)
 * @returns {Promise<string>} trimmed instruction text, or ''
 */
export async function readNativeInstruction(cwd, schema, artifactId) {
  const id = typeof artifactId === 'string' ? artifactId : ''
  if (id.length === 0) return ''
  let parts
  if (typeof schema === 'string') {
    parts = normalizeSchema(null)
    try {
      const project = await loadProjectSchemas(cwd)
      const resolved = resolveSchema({ name: schema, projectSchemas: project && Array.isArray(project.schemas) ? project.schemas : [] })
      parts = normalizeSchema(resolved)
    } catch {
      parts = normalizeSchema(null)
    }
  } else {
    parts = normalizeSchema(schema)
  }
  if (!parts.definition) return ''
  const resolved = resolveArtifactDef(parts.definition, id)
  const instruction = resolved.definition ? resolved.definition.instruction : ''
  return typeof instruction === 'string' ? instruction.trim() : ''
}
