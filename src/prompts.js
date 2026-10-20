/**
 * OpenSpec workflow prompt builders (Host half).
 *
 * Each `/opsx-*` phase command submits one model-facing English prompt through
 * `agent.followup()`. This module turns native engine data (effective schema,
 * per-artifact state, project config, task progress) into that prompt while
 * keeping the native phase boundaries:
 *
 * - explore is read-only thinking work;
 * - propose produces planning artifacts only and stops at the plan;
 * - apply implements the tracked tasks and ticks them off as it works;
 * - update revises existing planning artifacts only and points at apply for
 *   code changes;
 * - archive produces no prompt at all — the deterministic merge/archive engine
 *   runs it and returns the result directly.
 *
 * Prompt composition itself lives in `native/instruction.js`; it follows the
 * native order: artifact `instruction` → resolved placeholders (output path,
 * dependencies, change name, intent) → project `<context>` → this artifact's
 * `<rules>` → template body → dependency status → unlocks → phase boundary,
 * with one snapshot-version note appended when the bundled fallback schema is
 * in effect. The builders below add the workflow envelope (phase boundaries,
 * task progress, operation guidance, plans in schema order).
 *
 * No filesystem writes happen here. The only reads are artifact templates
 * performed by the instruction composer when it is invoked.
 *
 * @module dsh-spec/prompts
 */

import { SNAPSHOT_VERSION, composeArtifactPrompt } from './native/instruction.js'

/** Kebab-case change name: what OpenSpec itself uses for folder names. */
const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/

/** Workspace-relative root of active changes. */
const CHANGE_ROOT = 'openspec/changes'

/**
 * Environment note: the plugin never invokes the `openspec` CLI, so commands
 * quoted by the native schema instructions have to be translated into file
 * reads by the model.
 */
const FILE_BASED_NOTE =
  'This DSH workflow is file-based: the `openspec` CLI is not installed. Wherever an instruction mentions an `openspec ...` command, use the matching files under `openspec/` in this workspace directly (read them; write only where this phase allows it).'

/** Normalize a resolved schema wrapper or a bare schema definition. */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { definition: null, source: null, dir: null, sourceVersion: null }
  }
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
  return { definition: null, source: null, dir: null, sourceVersion: null }
}

/** Require a usable schema definition; builders depend on its artifact graph. */
function requireSchema(schema, builderName) {
  const parts = normalizeSchema(schema)
  if (!parts.definition) {
    throw new Error(`${builderName} requires the effective schema (a resolved schema wrapper or a bare schema definition)`)
  }
  return parts
}

/** Map change artifact state rows by artifact id. */
function artifactStateMap(change) {
  const states = new Map()
  const rows = change && Array.isArray(change.artifacts) ? change.artifacts : []
  for (const row of rows) {
    if (row && typeof row.id === 'string') states.set(row.id, row)
  }
  return states
}

/** Whether one artifact dependency is satisfied by a done or skipped artifact. */
function dependencySatisfied(states, artifactId) {
  const state = states.get(artifactId)
  return state !== undefined && (state.status === 'done' || state.status === 'skipped')
}

/**
 * Effective status of one artifact: the engine row when present, otherwise a
 * conservative derivation from the dependency edges (root artifacts ready,
 * dependants blocked). Builders never invent `done`.
 */
function effectiveArtifactState(definition, states, artifactDefinition) {
  const recorded = states.get(artifactDefinition.id)
  if (recorded && typeof recorded.status === 'string') {
    return {
      status: recorded.status,
      missingDeps:
        recorded.status === 'blocked' && Array.isArray(recorded.missingDeps) && recorded.missingDeps.length > 0
          ? recorded.missingDeps.filter((id) => typeof id === 'string')
          : Array.isArray(artifactDefinition.requires)
            ? artifactDefinition.requires.filter((id) => typeof id === 'string' && !dependencySatisfied(states, id))
            : [],
    }
  }
  const requires = Array.isArray(artifactDefinition.requires) ? artifactDefinition.requires.filter((id) => typeof id === 'string') : []
  const missingDeps = requires.filter((id) => !dependencySatisfied(states, id))
  return { status: missingDeps.length === 0 ? 'ready' : 'blocked', missingDeps }
}

/** Workspace-relative output path for one artifact, preferring engine data. */
function outputPathOf(changeName, definition, states, artifactDefinition) {
  const recorded = states.get(artifactDefinition.id)
  if (recorded && typeof recorded.outputPath === 'string' && recorded.outputPath.length > 0) return recorded.outputPath
  const name = typeof changeName === 'string' && changeName.length > 0 ? changeName : '<change-name>'
  const generates = typeof artifactDefinition.generates === 'string' ? artifactDefinition.generates : ''
  return generates.length > 0 ? `${CHANGE_ROOT}/${name}/${generates}` : `${CHANGE_ROOT}/${name}/`
}

/** Trimmed project context, or ''. */
function projectContext(config) {
  if (!config || typeof config !== 'object') return ''
  return typeof config.context === 'string' ? config.context.trim() : ''
}

/** Artifact rules from the project config as a trimmed string array. */
function artifactRules(config, artifactId) {
  const rules = config && typeof config === 'object' ? config.rules : null
  if (!rules || typeof rules !== 'object') return []
  const value = Object.hasOwn(rules, artifactId) ? rules[artifactId] : null
  if (Array.isArray(value)) {
    return value.filter((rule) => typeof rule === 'string' && rule.trim().length > 0).map((rule) => rule.trim())
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()]
  return []
}

/** `<context>` block; '' when the project defines no context. */
function contextBlock(config, purpose) {
  const context = projectContext(config)
  if (context.length === 0) return ''
  return [
    '<context>',
    `<!-- Project context from openspec/config.yaml (${purpose}). Use it as a constraint; do NOT copy it into files. -->`,
    context,
    '</context>',
  ].join('\n')
}

/** `<rules>` block for one artifact; '' when none are configured. */
function rulesBlock(config, artifactId) {
  const rules = artifactRules(config, artifactId)
  if (rules.length === 0) return ''
  return [`<rules artifact="${artifactId}">`, `<!-- Project rules for the ${artifactId} artifact. Apply them; do NOT copy them into files. -->`, ...rules.map((rule) => `- ${rule}`), '</rules>'].join('\n')
}

/** Project config clone without `context`, so a prompt includes context exactly once. */
function configWithoutContext(config) {
  return { ...(config && typeof config === 'object' ? config : {}), context: '' }
}

/** Snapshot-fallback note used where no per-artifact composer ran. */
function snapshotNote(parts) {
  const builtin = parts.source === 'builtin' || typeof parts.sourceVersion === 'string'
  return builtin
    ? `Note: schema '${parts.definition.name ?? 'spec-driven'}' was resolved from the bundled OpenSpec snapshot v${SNAPSHOT_VERSION} because the project does not define it.`
    : ''
}

/** Compose one artifact section with the shared config (context included once by the caller). */
async function composeSection(options) {
  const { text } = await composeArtifactPrompt({ ...options, suppressSnapshotNote: true })
  return text
}

/** Render a markdown list line for one artifact. */
function listArtifactLine(changeName, definition, states, artifactDefinition, suffix = '') {
  const path = outputPathOf(changeName, definition, states, artifactDefinition)
  return `- ${artifactDefinition.id}: ${path}${suffix}`
}

/**
 * Turn free text into a safe OpenSpec change folder name, or '' when impossible.
 *
 * @param {string} raw free-text argument
 * @returns {string} kebab-case name (max 64 chars) or ''
 */
export function slugify(raw) {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return CHANGE_NAME.test(slug) ? slug : ''
}

/** First whitespace token of a raw command input. */
export function firstToken(raw) {
  const text = String(raw ?? '').trim()
  const index = text.search(/\s/)
  return index === -1 ? text : text.slice(0, index)
}

/** Everything after the first whitespace token, trimmed. */
export function restAfterFirstToken(raw) {
  const text = String(raw ?? '').trim()
  const index = text.search(/\s/)
  return index === -1 ? '' : text.slice(index + 1).trim()
}

/**
 * Explore prompt: read-only thinking and investigation.
 *
 * @param {object} options
 * @param {string} [options.cwd] workspace root (unused today; kept for symmetry/host callers)
 * @param {object} [options.config] project config (context is injected when present)
 * @param {string} [options.topic] exploration topic from the command input
 * @returns {Promise<string>} model-facing prompt
 */
export async function buildExplorePrompt({ cwd, config = {}, topic = '' } = {}) {
  const focus = typeof topic === 'string' && topic.trim().length > 0 ? topic.trim() : 'help me choose what to work on next'
  const lines = [
    '## Explore — think before changing anything',
    '',
    `Topic: ${focus}`,
    '',
    FILE_BASED_NOTE,
    '',
    'You are in OpenSpec exploration mode. This is thinking work, not building work.',
    '',
    '- Investigate the relevant code, tests, docs and existing `openspec/` files before forming opinions.',
    '- Ask the questions that matter, sketch options, and challenge assumptions.',
    '- Compare realistic options with concrete trade-offs and end with a recommendation when asked.',
    '- READ-ONLY: Do NOT write, modify or create any file. No code, no planning artifacts, no config changes.',
    '- When a decision settles, offer to capture it as a change with `/opsx-propose <kebab-change-name>`.',
    '',
  ]
  if (contextBlock(config, 'exploration background').length > 0) {
    lines.push(contextBlock(config, 'exploration background'), '')
  }
  lines.push('Next step: run `/opsx-propose <change-name>` when the idea is sharp enough for a plan.')
  return lines.join('\n')
}

/**
 * Propose prompt: create the change's planning artifacts and stop at the plan.
 *
 * Planning artifacts that are `ready` now get their full native instruction and
 * template in schema order. Artifacts that are `blocked` only by artifacts this
 * run also creates are named as "write after <deps>" with the same guidance, so
 * the plan can be completed in one pass. `skipped` artifacts (for example
 * `specs` under `skip_specs: true`) and artifacts blocked by anything not being
 * created here are never offered for creation; their state is explained.
 *
 * @param {object} options
 * @param {string} [options.cwd] absolute workspace root
 * @param {string} options.changeName change name (folder under openspec/changes/)
 * @param {string} [options.intent] free-text intent from the command input
 * @param {object} options.schema resolved schema wrapper or bare schema definition
 * @param {object} [options.config] project config
 * @param {object} [options.change] ChangeState from the native engine
 * @returns {Promise<string>} model-facing prompt
 */
export async function buildProposePrompt({ cwd, changeName, intent = '', schema, config = {}, change = null } = {}) {
  const parts = requireSchema(schema, 'buildProposePrompt')
  const definition = parts.definition
  const states = artifactStateMap(change)
  const name = typeof changeName === 'string' && changeName.length > 0 ? changeName : change?.name ?? '<change-name>'
  const schemaName = typeof definition.name === 'string' && definition.name.length > 0 ? definition.name : 'custom'
  const schemaLabel = parts.source === 'project' ? 'project schema' : parts.source === 'builtin' ? 'bundled snapshot schema' : 'schema'
  const artifacts = Array.isArray(definition.artifacts) ? definition.artifacts.filter((entry) => entry && typeof entry.id === 'string') : []

  const statesById = new Map()
  for (const artifactDefinition of artifacts) {
    statesById.set(artifactDefinition.id, effectiveArtifactState(definition, states, artifactDefinition))
  }
  const satisfiedIds = new Set(
    artifacts
      .filter((artifactDefinition) => {
        const status = statesById.get(artifactDefinition.id).status
        return status === 'done' || status === 'skipped'
      })
      .map((artifactDefinition) => artifactDefinition.id),
  )
  // Plan this run in dependency order: next are the artifacts already ready;
  // added to the plan are the blocked artifacts whose missing dependencies are
  // all satisfied or planned by this same run (fixpoint over the graph).
  const plannableIds = new Set(
    artifacts
      .filter((artifactDefinition) => statesById.get(artifactDefinition.id).status === 'ready')
      .map((artifactDefinition) => artifactDefinition.id),
  )
  let grew = true
  while (grew) {
    grew = false
    for (const artifactDefinition of artifacts) {
      if (plannableIds.has(artifactDefinition.id)) continue
      const state = statesById.get(artifactDefinition.id)
      if (state.status !== 'blocked') continue
      const dependencyIds = state.missingDeps.length > 0
        ? state.missingDeps
        : Array.isArray(artifactDefinition.requires)
          ? artifactDefinition.requires.filter((id) => typeof id === 'string')
          : []
      const resolvable = dependencyIds.every(
        (dependencyId) => plannableIds.has(dependencyId) || satisfiedIds.has(dependencyId) || dependencySatisfied(states, dependencyId),
      )
      if (resolvable) {
        plannableIds.add(artifactDefinition.id)
        grew = true
      }
    }
  }
  const skipped = artifacts.filter((artifactDefinition) => statesById.get(artifactDefinition.id).status === 'skipped')
  const done = artifacts.filter((artifactDefinition) => statesById.get(artifactDefinition.id).status === 'done')
  const readyNow = artifacts.filter((artifactDefinition) => statesById.get(artifactDefinition.id).status === 'ready')
  const later = artifacts.filter(
    (artifactDefinition) => statesById.get(artifactDefinition.id).status === 'blocked' && plannableIds.has(artifactDefinition.id),
  )
  const notPlannable = artifacts.filter(
    (artifactDefinition) => statesById.get(artifactDefinition.id).status === 'blocked' && !plannableIds.has(artifactDefinition.id),
  )

  const header = [
    `## Propose — plan the OpenSpec change "${name}" (${schemaLabel}: ${schemaName})`,
    '',
    `Change: ${name}`,
    `Schema: ${schemaName} (${parts.source ?? 'unknown'}${parts.sourceVersion ? ` v${parts.sourceVersion}` : ''})`,
  ]
  if (typeof intent === 'string' && intent.trim().length > 0) header.push(`Intent: ${intent.trim()}`)
  header.push('', FILE_BASED_NOTE, '')

  const context = contextBlock(config, 'planning constraints')
  if (context.length > 0) header.push(context, '')

  const lines = [...header]
  const planningBoundary = [
    'Planning boundary: this workflow creates planning artifacts only.',
    'Do NOT write, modify or run product code; implementation starts later with `/opsx-apply <change-name>`.',
  ].join(' ')
  lines.push(planningBoundary, '')

  if (readyNow.length === 0 && later.length === 0) {
    const planningComplete = done.length > 0 || skipped.length > 0
    lines.push(
      planningComplete
        ? `All planning artifacts for "${name}" already exist or are skipped; there is nothing left to create.`
        : `No planning artifact for "${name}" can be created yet: every artifact is blocked by a dependency outside this planning run.`,
    )
    if (done.length > 0 || skipped.length > 0) {
      lines.push('', '### Already satisfied')
      for (const artifactDefinition of done) {
        lines.push(listArtifactLine(name, definition, states, artifactDefinition, ' — done'))
      }
      for (const artifactDefinition of skipped) {
        lines.push(`- ${artifactDefinition.id}: skipped — do not create files for it.`)
      }
    }
    if (notPlannable.length > 0) {
      lines.push('')
      lines.push('Still blocked (not creatable in this pass):')
      for (const artifactDefinition of notPlannable) {
        lines.push(`- ${artifactDefinition.id}: blocked by ${statesById.get(artifactDefinition.id).missingDeps.join(', ') || 'missing dependencies'}`)
      }
    }
    const snapshot = snapshotNote(parts)
    if (snapshot.length > 0) lines.push('', snapshot)
    lines.push('', `Stop here and summarize the change. Do not implement product code; continue with \`/opsx-apply ${name}\` only after review.`)
    return lines.join('\n')
  }

  lines.push(
    'Write the planning artifacts below in schema order, one artifact at a time.',
    'Before starting an artifact, confirm its dependency artifacts already exist on disk; a blocked artifact becomes ready only after they do.',
    'Do not create a skipped artifact, and do not jump ahead of an unresolved dependency.',
    '',
  )

  let sectionNumber = 0
  for (const artifactDefinition of artifacts) {
    const state = statesById.get(artifactDefinition.id)
    if (state.status !== 'ready' && state.status !== 'blocked') continue
    if (state.status === 'blocked' && !later.includes(artifactDefinition)) continue
    sectionNumber += 1
    const dependencyIds = Array.isArray(artifactDefinition.requires) ? artifactDefinition.requires.filter((id) => typeof id === 'string') : []
    const dependsDone = dependencyIds.filter((dependencyId) => dependencySatisfied(states, dependencyId))
    const heading =
      state.status === 'ready'
        ? `### ${sectionNumber}. ${artifactDefinition.id} — ready now`
        : `### ${sectionNumber}. ${artifactDefinition.id} — write after: ${state.missingDeps.join(', ') || 'its dependencies'}`
    lines.push(heading)
    if (state.status === 'blocked') {
      lines.push('')
      lines.push(
        `Status: blocked until ${state.missingDeps.join(', ') || 'its dependencies'} exist. Do not create it yet; once those artifacts are written, follow the guidance below.`,
      )
    }
    lines.push('')
    lines.push(
      await composeSection({
        cwd,
        schema,
        artifact: artifactDefinition,
        config: configWithoutContext(config),
        changeName: name,
        dependsDone,
        intent,
      }),
    )
    lines.push('')
  }

  if (done.length > 0 || skipped.length > 0) {
    lines.push('### Already satisfied')
    for (const artifactDefinition of done) {
      lines.push(listArtifactLine(name, definition, states, artifactDefinition, ' — done, read it before continuing'))
    }
    for (const artifactDefinition of skipped) {
      lines.push(
        `- ${artifactDefinition.id}: skipped${artifactDefinition.id === 'specs' ? ' (the change declares `skip_specs: true`)' : ''} — do NOT create files for it; dependent artifacts treat it as satisfied.`,
      )
    }
    lines.push('')
  }

  if (notPlannable.length > 0) {
    lines.push('### Cannot be planned yet')
    for (const artifactDefinition of notPlannable) {
      lines.push(
        `- ${artifactDefinition.id}: blocked by ${statesById.get(artifactDefinition.id).missingDeps.join(', ') || 'missing dependencies'} — create or resolve those artifacts first, then re-run \`/opsx-propose ${name}\`.`,
      )
    }
    lines.push('')
  }

  const snapshot = snapshotNote(parts)
  if (snapshot.length > 0) lines.push(snapshot, '')

  lines.push('### Stop boundary')
  lines.push(
    `After the last artifact above is written (or skipped), STOP. Do not start implementation, do not edit product code, and do not archive. Summarize in chat what you created and wait for the user's review; implementation starts with \`/opsx-apply ${name}\` after review.`,
  )
  return lines.join('\n')
}

/**
 * Apply prompt: implement the tracked tasks and tick them off as they land.
 *
 * @param {object} options
 * @param {string} [options.cwd] absolute workspace root
 * @param {string} options.changeName change name
 * @param {object} options.schema resolved schema wrapper or bare schema definition
 * @param {object} [options.config] project config (`operations.apply.guidance` is included when set)
 * @param {object} [options.change] ChangeState from the native engine
 * @param {string} [options.artifactPrompt] optional pre-composed apply instruction block
 * @returns {Promise<string>} model-facing prompt
 */
export async function buildApplyPrompt({ cwd, changeName, schema, config = {}, change = null, artifactPrompt = '' } = {}) {
  const parts = requireSchema(schema, 'buildApplyPrompt')
  const definition = parts.definition
  const states = artifactStateMap(change)
  const name = typeof changeName === 'string' && changeName.length > 0 ? changeName : change?.name ?? '<change-name>'
  const schemaName = typeof definition.name === 'string' && definition.name.length > 0 ? definition.name : 'custom'
  const apply = definition.apply && typeof definition.apply === 'object' ? definition.apply : {}
  const applyRequires = Array.isArray(change?.applyRequires) && change.applyRequires.length > 0
    ? change.applyRequires.filter((id) => typeof id === 'string')
    : Array.isArray(apply.requires)
      ? apply.requires.filter((id) => typeof id === 'string')
      : []
  const tracks = typeof change?.tracks === 'string' && change.tracks.length > 0
    ? change.tracks
    : typeof apply.tracks === 'string' && apply.tracks.length > 0
      ? apply.tracks
      : 'tasks.md'
  const tracksPath = `${CHANGE_ROOT}/${name}/${tracks}`
  const progress = change && change.tasks && typeof change.tasks.total === 'number' ? change.tasks : null
  const blockedApply = applyRequires.filter((id) => !dependencySatisfied(states, id))
  const context = contextBlock(config, 'implementation constraints')
  const applyRules = rulesBlock(config, 'apply')
  const guidance = typeof config?.operations?.apply?.guidance === 'string' ? config.operations.apply.guidance.trim() : ''

  const instructionSection =
    typeof artifactPrompt === 'string' && artifactPrompt.trim().length > 0
      ? artifactPrompt.trim()
      : await composeSection({
          cwd,
          schema,
          artifact: 'apply',
          config: configWithoutContext(config),
          changeName: name,
          dependsDone: applyRequires.filter((id) => dependencySatisfied(states, id)),
        })
  const instructionHasContext = instructionSection.includes('<context>')

  const lines = [
    `## Apply — implement the OpenSpec change "${name}" (schema: ${schemaName})`,
    '',
    `Change: ${name}`,
    `Schema: ${schemaName}`,
    `Tracking file: ${tracksPath} (\`apply.tracks\`)`,
  ]
  if (progress) lines.push(`Task progress: ${progress.done}/${progress.total} checked`)
  lines.push('', FILE_BASED_NOTE, '')
  if (context.length > 0 && !instructionHasContext) lines.push(context, '')
  lines.push(instructionSection, '')

  // The prompt must never lose the apply rules, even when the caller supplied
  // its own instruction block.
  if (applyRules.length > 0 && !instructionSection.includes('<rules')) lines.push(applyRules, '')

  if (blockedApply.length > 0) {
    lines.push('### Blocked: missing planning artifacts')
    for (const artifactId of blockedApply) {
      lines.push(`- ${artifactId}: not created yet — apply cannot start until this artifact exists (or the change skips it).`)
    }
    lines.push('')
  }

  lines.push('### Apply contract')
  lines.push(`- Track progress only in \`${tracksPath}\` — the schema's \`apply.tracks\` file.`)
  lines.push('- Start at the first unchecked task (any `- [ ]` or non-`x` marker); do not redo completed work.')
  lines.push('- After each task is genuinely implemented and verified, change its checkbox to `- [x]` immediately, before starting the next task.')
  lines.push('- Work in task order; keep each change minimal and aligned with the planning artifacts.')
  lines.push('- If a task is unclear, blocked, or reveals a plan problem, pause and report it instead of improvising.')
  lines.push('- When every task is checked, run a final verification pass against the specs and report what shipped and how to verify it.')
  if (progress) {
    lines.push('')
    lines.push(
      progress.total === 0
        ? 'There are no tasks recorded yet; if the tracking file is missing or empty, report that instead of inventing tasks.'
        : progress.done >= progress.total
          ? 'Every tracked task is already checked. Report that the implementation is complete and suggest review before archiving.'
          : `Continue from task ${progress.done + 1} of ${progress.total}.`,
    )
  } else {
    lines.push('')
    lines.push('Read the tracking file in the change folder to determine the first unchecked task before writing any code.')
  }
  lines.push('')

  if (guidance.length > 0) {
    lines.push('### Operation guidance (advisory)')
    lines.push(guidance)
    lines.push('')
  }

  const snapshot = snapshotNote(parts)
  if (snapshot.length > 0) lines.push(snapshot, '')

  lines.push('### Phase boundary')
  lines.push(
    `Implement the tasks and tick them off; do not rewrite the planning contract. If the plan itself must change, stop and tell the user which artifacts need \`/opsx-update ${name}\` instead of editing them mid-implementation. Archive happens later through \`/opsx-archive ${name}\`.`,
  )
  return lines.join('\n')
}

/**
 * Update prompt: revise existing planning artifacts only, then point at apply.
 *
 * @param {object} options
 * @param {string} [options.cwd] absolute workspace root
 * @param {string} options.changeName change name
 * @param {object} options.schema resolved schema wrapper or bare schema definition
 * @param {object} [options.config] project config
 * @param {object} [options.change] ChangeState from the native engine
 * @param {string} [options.intent] optional user revision request (extra optional property)
 * @returns {Promise<string>} model-facing prompt
 */
export async function buildUpdatePrompt({ cwd, changeName, schema, config = {}, change = null, intent = '' } = {}) {
  const parts = requireSchema(schema, 'buildUpdatePrompt')
  const definition = parts.definition
  const states = artifactStateMap(change)
  const name = typeof changeName === 'string' && changeName.length > 0 ? changeName : change?.name ?? '<change-name>'
  const schemaName = typeof definition.name === 'string' && definition.name.length > 0 ? definition.name : 'custom'
  const artifacts = Array.isArray(definition.artifacts) ? definition.artifacts.filter((entry) => entry && typeof entry.id === 'string') : []

  const rows = artifacts.map((artifactDefinition) => ({
    definition: artifactDefinition,
    state: effectiveArtifactState(definition, states, artifactDefinition),
  }))
  const existing = rows.filter((row) => row.state.status === 'done')
  const missing = rows.filter((row) => row.state.status === 'ready' || row.state.status === 'blocked')
  const skipped = rows.filter((row) => row.state.status === 'skipped')

  const lines = [
    `## Update — revise the plan for the OpenSpec change "${name}" (schema: ${schemaName})`,
    '',
    `Change: ${name}`,
    `Schema: ${schemaName} (${parts.source ?? 'unknown'}${parts.sourceVersion ? ` v${parts.sourceVersion}` : ''})`,
    '',
    FILE_BASED_NOTE,
    '',
  ]
  const context = contextBlock(config, 'planning constraints')
  if (context.length > 0) lines.push(context, '')

  if (typeof intent === 'string' && intent.trim().length > 0) {
    lines.push('User revision request:', intent.trim(), '')
  } else {
    lines.push(
      'User revision request: make the existing planning artifacts coherent with the requested change (if the request is only "update", treat it as a coherence review).',
      '',
    )
  }

  lines.push('### Update contract')
  lines.push('- Planning artifacts only: revise files that already exist. NEVER edit product code in this workflow.')
  lines.push('- Read every existing planning artifact before deciding a change, then check all of them against each other for contradictions, gaps and duplication; a revision to a later artifact may force an earlier one.')
  lines.push('- Draft the revision in chat first; write only what the user confirms, one artifact at a time.')
  lines.push('- Do not create artifacts that do not exist yet — creation belongs to `/opsx-propose`.')
  lines.push('- Leave skipped artifacts untouched; do not treat them as missing.')
  lines.push(`- If the revised plan implies code changes, stop and point to \`/opsx-apply ${name}\` instead of implementing them here.`)
  lines.push('')

  lines.push('### Existing planning artifacts')
  if (existing.length === 0) {
    lines.push('- none yet')
  } else {
    for (const row of existing) {
      lines.push(listArtifactLine(name, definition, states, row.definition, row.definition.id === 'tasks' ? ' — task progress lives here' : ''))
    }
  }
  lines.push('')

  if (missing.length > 0 || skipped.length > 0) {
    lines.push('### Not editable here')
    for (const row of missing) {
      lines.push(
        `- ${row.definition.id}: not created yet (${row.state.status}${row.state.missingDeps.length > 0 ? `; blocked by ${row.state.missingDeps.join(', ')}` : ''}) — create it with \`/opsx-propose ${name}\` or the plan-creation flow; update only revises existing artifacts.`,
      )
    }
    for (const row of skipped) {
      lines.push(`- ${row.definition.id}: skipped${row.definition.id === 'specs' ? ' (`skip_specs: true`)' : ''} — leave it untouched.`)
    }
    lines.push('')
  }

  // Artifact-scoped rules for the artifacts this workflow may edit.
  const existingRules = existing.map((row) => rulesBlock(config, row.definition.id)).filter((block) => block.length > 0)
  if (existingRules.length > 0) lines.push('### Artifact rules (for the existing artifacts you edit)', existingRules.join('\n\n'), '')

  const snapshot = snapshotNote(parts)
  if (snapshot.length > 0) lines.push(snapshot, '')

  lines.push('### Phase boundary')
  lines.push(
    `Stop after the confirmed revisions. Do not implement code, do not tick tasks, and do not archive; code changes go through \`/opsx-apply ${name}\`, and archive through \`/opsx-archive ${name}\`.`,
  )
  return lines.join('\n')
}

/** Archive is deterministic (merge + move engine), so it has no model prompt. */
