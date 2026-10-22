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
 * - sync and archive default to the vendored OPSX AI workflows: the adapted
 *   upstream `sync-specs` / `archive-change` skill text plus engine-derived
 *   facts and an explicit finish contract. Their deterministic `--yes` path
 *   runs the merge/archive engine and produces no model prompt.
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
 * performed by the instruction composer when it is invoked, the bundled
 * vendored OPSX skill text loaded by `native/skill-adaptation.js` for the sync
 * and archive AI workflows, and the bundled report methodology embedded by
 * `buildReportPrompt` (which falls back to a compact constant when the asset is
 * missing, e.g. in a partially built Host).
 *
 * @module dsh-spec/prompts
 */

import { readFileSync } from 'node:fs'

import { SNAPSHOT_VERSION, composeArtifactPrompt } from './native/instruction.js'
import { loadAdaptedSkill } from './native/skill-adaptation.js'

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

/** Maximum validation-issue rows listed in one propose resume prompt. */
const MAX_RESUME_ISSUE_LINES = 20

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

/** Whether an artifact's output definition is a glob (one matching file does not prove completion). */
function isGlobOutput(artifactDefinition) {
  const generates = typeof artifactDefinition?.generates === 'string' ? artifactDefinition.generates : ''
  return generates.includes('*')
}

/** Render native validation findings for a propose resume prompt (capped). */
function resumeIssueLines(change) {
  const issues = Array.isArray(change?.validation?.issues) ? change.validation.issues : []
  const listed = issues.filter((issue) => issue?.level === 'ERROR' || issue?.level === 'WARNING')
  if (listed.length === 0) return []
  const rows = [
    '### Existing artifact issues',
    'These findings concern planning content that already exists on disk. Missing-artifact findings are covered by the creation plan above; for a content issue, repair or rewrite the affected existing artifact first, then continue with the artifacts that depend on it.',
  ]
  for (const issue of listed.slice(0, MAX_RESUME_ISSUE_LINES)) {
    const where = issue?.path ? ` ${issue.path}${Number.isFinite(issue.line) ? `:${issue.line}` : ''}` : ''
    rows.push(`- [${issue?.level ?? 'INFO'}]${where} — ${issue?.message ?? ''}`)
  }
  if (listed.length > MAX_RESUME_ISSUE_LINES) {
    rows.push(`- …还有 ${listed.length - MAX_RESUME_ISSUE_LINES} 条问题，可用 /opsx-validate <change-name> 查看完整清单。`)
  }
  rows.push('')
  return rows
}

/**
 * Resume blocks for an interrupted plan: the resume contract, the glob-output
 * verification step (upstream `continue-change` parity) and the existing
 * artifact issues. '' (no lines) for a fresh propose.
 */
function resumeBlocks({ resume, definition, states, name, done, change }) {
  if (resume !== true) return []
  const lines = [
    '### Resume contract',
    `This is a resume of the existing change "${name}": a previous planning run was interrupted.`,
    'The artifacts listed as already satisfied below are authoritative: read them from disk before writing, and do NOT rewrite or delete them unless an existing-artifact issue requires a repair.',
    'Create only the missing artifacts planned in this run, in schema order. Do not re-create satisfied artifacts and do not restart the plan from scratch.',
    '',
  ]
  const globDone = done.filter(isGlobOutput)
  if (globDone.length > 0) {
    lines.push('### Partly written artifacts to verify')
    for (const artifactDefinition of globDone) {
      const path = outputPathOf(name, definition, states, artifactDefinition)
      lines.push(
        `- ${artifactDefinition.id}: output pattern \`${path}\` — a glob artifact counts as done as soon as one file matches, so an interrupted run can leave expected files missing. Read the proposal (or the artifact that enumerates deliverables) and verify that every expected file exists under \`${CHANGE_ROOT}/${name}/\`; create only the missing files, then continue with the dependent artifacts. Do not treat the first existing file as completion.`,
      )
    }
    lines.push('')
  }
  lines.push(...resumeIssueLines(change))
  return lines
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
 * @param {boolean} [options.resume] true when resuming an interrupted plan: only
 *   missing artifacts are offered, satisfied artifacts are read-only, glob
 *   outputs are verified and existing findings are surfaced first
 * @returns {Promise<string>} model-facing prompt
 */
export async function buildProposePrompt({ cwd, changeName, intent = '', schema, config = {}, change = null, resume = false } = {}) {
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
  if (resume === true) header.push(`Mode: resume — continue the interrupted plan for the existing change "${name}".`)
  header.push('', FILE_BASED_NOTE, '')

  const context = contextBlock(config, 'planning constraints')
  if (context.length > 0) header.push(context, '')

  const lines = [...header]
  const planningBoundary = [
    'Planning boundary: this workflow creates planning artifacts only.',
    'Do NOT write, modify or run product code; implementation starts later with `/opsx-apply <change-name>`.',
  ].join(' ')
  lines.push(planningBoundary, '')
  lines.push(
    `If \`openspec/changes/${name}/.openspec.yaml\` exists and its \`goal\` is empty, add \`goal: <one-line Chinese summary, at most 20 characters>\` (for example \`新增幼狮卡牌\`) without changing \`schema\` or \`created\`. This is the panel headline; do not make it a paragraph.`,
    '',
  )
  lines.push(...resumeBlocks({ resume, definition, states, name, done, change }))

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
    'When the tasks artifact is in this plan: after the optional task id, prefix every task that needs human acceptance with `[人工验收]` (for example `- [ ] 3.2 [人工验收] 在浏览器里确认…`). Only the human ticks those tasks.',
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
 * Auto-named propose prompt: let the model summarize the user's description,
 * choose the kebab-case change name, scaffold `.openspec.yaml`, and then run the
 * normal native propose plan with `<change-name>` substituted.
 *
 * The Host deliberately does not write the change directory here: the whole
 * point is that the name is a model decision, not a heuristic slug. The prompt
 * is strict about the directory shape so the native engine can see the change
 * immediately after the model finishes.
 *
 * @param {object} options
 * @param {string} [options.cwd] absolute workspace root
 * @param {string} [options.description] the user's free-text proposal description
 * @param {object} options.schema resolved schema wrapper or bare schema definition
 * @param {object} [options.config] project config
 * @param {string} [options.created] local YYYY-MM-DD date for `.openspec.yaml`
 * @param {string[]} [options.existingNames] active change names to avoid
 * @returns {Promise<string>} model-facing prompt
 */
export async function buildAutoProposePrompt({ cwd, description = '', schema, config = {}, created = '', existingNames = [] } = {}) {
  const parts = requireSchema(schema, 'buildAutoProposePrompt')
  const definition = parts.definition
  const schemaName = typeof definition.name === 'string' && definition.name.length > 0 ? definition.name : 'custom'
  const name = '<change-name>'
  const text = typeof description === 'string' ? description.trim() : ''
  const base = await buildProposePrompt({
    cwd,
    changeName: name,
    intent: text,
    schema,
    config,
    change: null,
  })
  const names = (Array.isArray(existingNames) ? existingNames : [])
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .slice(0, 30)
  const lines = [
    '## Propose — summarize the description, choose the change name, then plan',
    '',
    'The user described a change but did not choose a folder name. Your first job is to summarize the description and choose a short, meaningful kebab-case name. Do not ask the user to pick a name; choose one now and continue.',
    '',
    '### Description',
    text === '' ? '(no extra description was provided)' : text,
    '',
    '### Naming rules',
    '- Kebab-case only: lowercase ASCII letters, digits and single hyphens; start with a letter or digit.',
    '- Use 1–5 meaningful English words, at most 64 characters. No Chinese, spaces, underscores, dots or slashes.',
    '- Name the intent, not the implementation detail. Examples: `add-dark-mode`, `realtime-status-polling`, `manual-task-checkboxes`.',
    names.length > 0
      ? `- These active change names already exist — do NOT reuse any of them: ${names.join(', ')}.`
      : '- There are no active changes yet.',
    '',
    '### Step 0 — choose the name and create the native change scaffold',
    '1. Choose the name and write it down as `<change-name>`; use exactly that name in every path below. Before writing, check that `openspec/changes/<change-name>/` does not already exist; if it does, choose another name and re-check.',
    `2. Create \`openspec/changes/<change-name>/.openspec.yaml\` with exactly this content (and nothing else):`,
    '',
    '```yaml',
    `schema: ${schemaName}`,
    `created: ${created}`,
    'goal: <一句话中文总结，例如：新增幼狮卡牌>',
    '```',
    '',
    '3. Replace the `goal` placeholder with a 4–20 character Chinese phrase that summarizes the change (for example `新增幼狮卡牌`); do not leave angle brackets. This is the panel headline, so keep it short.',
    '4. Create the proposal and the other planned artifacts under `openspec/changes/<change-name>/` using the native paths below. Do not create a literal `<change-name>` directory. Do not call the `openspec` CLI; write the files directly.',
    '5. Start your reply with one line: `变更名：<change-name> — <一句话总结>`, so the user can see the name and summary you chose.',
    '',
    base,
    '',
    '### Final report',
    `- State the chosen change name and the path \`openspec/changes/<change-name>/\`.`,
    '- Confirm every planned artifact exists, then stop. Do not implement code.',
  ]
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
  lines.push('- Tasks whose body carries `[人工验收]` need human acceptance: do NOT check them yourself. Implement them, then leave the box unchecked and report exactly what the user must verify.')
  lines.push('- Work in task order; keep each change minimal and aligned with the planning artifacts.')
  lines.push('- If a task is unclear, blocked, or reveals a plan problem, pause and report it instead of improvising.')
  lines.push('- When every non-manual task is checked, run a final verification pass against the specs and report what shipped, which manual checks remain, and how to verify them.')
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

/**
 * Vendored OPSX workflow skill backing each AI workflow (`sync` / `archive`).
 * The adapted text is embedded verbatim; only the surrounding facts, project
 * constraints and finish contract are composed here.
 */
const WORKFLOW_SKILL = {
  sync: 'openspec-sync-specs',
  archive: 'openspec-archive-change',
}

/** Human labels for the effective schema source in a workflow header. */
const SCHEMA_SOURCE_LABELS = {
  project: 'project schema',
  builtin: 'bundled snapshot schema',
}

/** Maximum validation issue rows rendered in the facts block. */
const MAX_FACT_ISSUE_LINES = 40

/** Coerce a fact count to a finite number (tolerating a missing caller field). */
function factNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** Trimmed `operations.<name>.guidance`, or ''. */
function operationGuidance(config, operation) {
  if (!config || typeof config !== 'object') return ''
  const guidance = config.operations && typeof config.operations === 'object' ? config.operations[operation]?.guidance : null
  return typeof guidance === 'string' ? guidance.trim() : ''
}

/**
 * Normalize the caller-prepared workflow facts (docs/native-module-contract §10.4).
 * Every field is optional: the builders must still compose a usable prompt when
 * a fact set is partial (for example before the change has any tasks file).
 */
function normalizeWorkflowFacts(facts) {
  const value = facts && typeof facts === 'object' ? facts : {}
  const validation = value.validation && typeof value.validation === 'object' ? value.validation : {}
  const tasks = value.tasks && typeof value.tasks === 'object'
    ? {
        total: factNumber(value.tasks.total),
        done: factNumber(value.tasks.done),
        pending: (Array.isArray(value.tasks.pending) ? value.tasks.pending : []).filter(
          (text) => typeof text === 'string' && text.length > 0,
        ),
      }
    : null
  return {
    errors: factNumber(validation.errors),
    warnings: factNumber(validation.warnings),
    infos: factNumber(validation.infos),
    issues: (Array.isArray(validation.issues) ? validation.issues : []).filter(Boolean),
    artifacts: (Array.isArray(value.artifacts) ? value.artifacts : [])
      .filter((row) => row && typeof row.id === 'string')
      .map((row) => ({ id: row.id, status: typeof row.status === 'string' ? row.status : 'unknown' })),
    tasks,
    deltas: (Array.isArray(value.deltas) ? value.deltas : [])
      .filter((row) => row && typeof row.path === 'string')
      .map((row) => ({
        path: row.path,
        capability: typeof row.capability === 'string' && row.capability.length > 0 ? row.capability : null,
        added: factNumber(row.added),
        modified: factNumber(row.modified),
        removed: factNumber(row.removed),
        renamed: factNumber(row.renamed),
      })),
    mainSpecs: (Array.isArray(value.mainSpecs) ? value.mainSpecs : [])
      .filter((row) => row && typeof row.path === 'string')
      .map((row) => ({
        path: row.path,
        exists: row.exists === true,
        requirementCount: factNumber(row.requirementCount),
      })),
    isPlanningComplete: value.isPlanningComplete === true,
    archiveTarget: typeof value.archiveTarget === 'string' && value.archiveTarget.length > 0 ? value.archiveTarget : null,
    archiveTargetExists: typeof value.archiveTargetExists === 'boolean' ? value.archiveTargetExists : null,
  }
}

/** Render one validation issue row (`[LEVEL] path:line — message`). */
function factIssueLine(issue) {
  const level = typeof issue?.level === 'string' ? issue.level : 'INFO'
  const path = typeof issue?.path === 'string' ? issue.path : ''
  const where = path.length > 0 ? ` ${path}${Number.isFinite(issue?.line) ? `:${issue.line}` : ''}` : ''
  return `- [${level}]${where} — ${typeof issue?.message === 'string' ? issue.message : ''}`
}

/**
 * Render the `Current facts` markdown block: validation counts and issues,
 * artifact status, task progress with the pending task texts, per-delta
 * operation counts, main spec existence/requirement counts, planning
 * completeness and (for archive) the deterministic archive target.
 */
function workflowFactsBlock(kind, facts) {
  const lines = ['## Current facts', '']
  lines.push(`Validation: ${facts.errors} ERROR / ${facts.warnings} WARNING / ${facts.infos} INFO`)
  if (facts.issues.length === 0) {
    lines.push('- no validation issues')
  } else {
    for (const issue of facts.issues.slice(0, MAX_FACT_ISSUE_LINES)) lines.push(factIssueLine(issue))
    if (facts.issues.length > MAX_FACT_ISSUE_LINES) {
      lines.push(`- …and ${facts.issues.length - MAX_FACT_ISSUE_LINES} more issues (run /opsx-validate for the full list).`)
    }
  }
  lines.push('')

  lines.push('Artifacts:')
  if (facts.artifacts.length === 0) {
    lines.push('- none recorded')
  } else {
    for (const artifact of facts.artifacts) lines.push(`- ${artifact.id}: ${artifact.status}`)
  }
  lines.push('')

  lines.push('Tasks:')
  if (facts.tasks === null) {
    lines.push('- none (the change has no tasks file yet)')
  } else {
    lines.push(`- ${facts.tasks.done}/${facts.tasks.total} checked, ${facts.tasks.pending.length} pending`)
    if (facts.tasks.pending.length > 0) {
      lines.push('Pending tasks:')
      for (const text of facts.tasks.pending) lines.push(`- ${text}`)
    }
  }
  lines.push('')

  lines.push('Delta specs:')
  if (facts.deltas.length === 0) {
    lines.push('- none (there are no delta specs to merge)')
  } else {
    for (const delta of facts.deltas) {
      const capability = delta.capability === null ? 'unknown capability' : `capability ${delta.capability}`
      lines.push(
        `- ${delta.path} — ${capability}: ADDED ${delta.added}, MODIFIED ${delta.modified}, REMOVED ${delta.removed}, RENAMED ${delta.renamed}`,
      )
    }
  }
  lines.push('')

  lines.push('Main specs:')
  if (facts.mainSpecs.length === 0) {
    lines.push('- none (no delta capability maps to a durable main spec yet)')
  } else {
    for (const spec of facts.mainSpecs) {
      lines.push(
        `- ${spec.path} — ${spec.exists ? `exists, ${spec.requirementCount} requirements` : 'does not exist yet, 0 requirements'}`,
      )
    }
  }
  lines.push('')

  lines.push(`Planning complete: ${facts.isPlanningComplete ? 'yes' : 'no'}`)
  if (kind === 'archive') {
    lines.push('')
    if (facts.archiveTarget !== null) {
      lines.push(`Archive target: ${facts.archiveTarget}`)
      if (facts.archiveTargetExists !== null) {
        lines.push(`Archive target exists: ${facts.archiveTargetExists ? 'yes' : 'no'}`)
      }
    } else {
      lines.push('Archive target: openspec/changes/archive/<local-date>-<change-name>')
    }
  }
  return lines.join('\n')
}

/** Finish contract for the sync AI workflow: stop on ERROR, confirm, merge, verify, validate. */
function syncFinishContract(name) {
  return [
    '## Finish contract (sync)',
    '',
    '1. STOP gate: when `validation.errors > 0`, stop before any edit. Do not create, edit, move or delete any file; report every ERROR issue listed above with a suggested fix, then wait for the user.',
    '2. Confirm first: summarize the intended merge per capability (which requirements are added, modified, removed or renamed and in which `openspec/specs/<capability>/spec.md`) and ask the user to confirm before editing any file. Proceed only after the user confirms.',
    '3. Intelligent merge: follow the OPSX `sync-specs` workflow above and perform the intelligent merge by directly editing the durable main specs at `openspec/specs/<capability>/spec.md` (one file per capability). Do not edit anything under `openspec/changes/`, and do not archive or move the change in this workflow.',
    '4. Structure check after each edit: the main spec keeps its title (`# <Capability> Specification`) and its `## Purpose` section, contains no delta operation headings (`## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`, `## RENAMED Requirements`), and every requirement is a `### Requirement: <name>` block with at least one `#### Scenario: <name>` sub-block.',
    '5. Result check: the ADDED / MODIFIED / REMOVED / RENAMED results in the delta facts above are exactly represented in the main specs (ADDED appended, MODIFIED whole-block replaced, REMOVED deleted, RENAMED retitled) with no duplicate requirement names.',
    '6. Then run `/opsx-validate` (add the change name for the change-level issues too) and fix any ERROR it reports before finishing.',
    `7. Report: the main spec files you changed, the delta results applied, the final validation counts, and any remaining WARNINGs. Do not archive the change; archiving is a separate \`/opsx-archive ${name}\` workflow.`,
  ].join('\n')
}

/** Finish contract for the archive AI workflow: confirm, merge or skip, validate, finalize. */
function archiveFinishContract(name) {
  return [
    '## Finish contract (archive)',
    '',
    '1. Completion check first: inspect the artifact and task state above. If `Planning complete` is `no`, tasks are pending, or validation reports WARNINGs, summarize that state and ask the user to confirm they want to continue. Do not write, move or archive anything until the user confirms.',
    '2. STOP gates: stop before any edit when either gate below is set. Report the blocking condition with a suggested fix, then wait for the user.',
    '   - `Validation: N ERROR` (when `validation.errors > 0`): report every ERROR issue listed above; do not merge specs, do not move or archive the change.',
    '   - `Archive target exists: yes`: report the conflict with the existing archive target; do not merge specs, do not move or archive the change, do not overwrite already-archived content, and do not run `/opsx-archive <name> --yes` (or any other deterministic finalize command) to bypass the conflict.',
    '3. Choose the sync route with the user:',
    '   - Intelligent merge (default): perform the OPSX merge described by the workflow above by directly editing `openspec/specs/<capability>/spec.md`; verify the title, `## Purpose`, absence of delta operation headings, the `### Requirement:` + `#### Scenario:` structure and the ADDED / MODIFIED / REMOVED / RENAMED results; then run `/opsx-validate` and fix any ERROR.',
    '   - Skip sync: only when the main specs are already merged (or the change declares `skip_specs`); leave `openspec/specs/**` untouched.',
    '4. Validate before finalizing: run `/opsx-validate` and make sure it reports no ERROR.',
    `5. Finalize deterministically: run \`/opsx-archive ${name} --yes --skip-specs\`.`,
    '   - `--yes` executes the deterministic archive; `--skip-specs` tells the deterministic engine the specs are already handled, so it only moves the change directory into `openspec/changes/archive/` and writes no main spec.',
    '   - Do not move or delete files yourself, and do not run a merge a second time: the deterministic command must not merge the same deltas again.',
    '6. Report the archive target, the main spec files changed by the merge (or that the sync was skipped), and any remaining WARNINGs.',
  ].join('\n')
}

/**
 * Compose one AI workflow prompt: vendored adapted OPSX skill text + engine
 * facts + project context/rules/guidance + the explicit finish contract.
 */
async function buildOpsxWorkflowPrompt({ kind, changeName, schema = null, config = {}, change = null, facts = null }) {
  const workflow = kind === 'archive' ? 'archive' : 'sync'
  const name = typeof changeName === 'string' && changeName.length > 0
    ? changeName
    : typeof change?.name === 'string' && change.name.length > 0
      ? change.name
      : '<change-name>'
  const skillName = WORKFLOW_SKILL[workflow]
  const skill = await loadAdaptedSkill(skillName)
  if (!skill || typeof skill.content !== 'string' || skill.content.trim().length === 0) {
    throw new Error(`could not load the vendored OPSX workflow skill "${skillName}"`)
  }
  const parts = normalizeSchema(schema)
  const definition = parts.definition
  const schemaName = definition && typeof definition.name === 'string' && definition.name.length > 0
    ? definition.name
    : 'custom'
  const source = parts.source !== null ? SCHEMA_SOURCE_LABELS[parts.source] ?? parts.source : 'unknown source'

  const lines = [
    workflow === 'sync'
      ? `## OPSX sync workflow — merge the deltas of "${name}" into the main specs`
      : `## OPSX archive workflow — confirm, sync and archive the change "${name}"`,
    '',
    `Change: ${name}`,
    definition !== null
      ? `Schema: ${schemaName} (${source}${parts.sourceVersion !== null ? ` v${parts.sourceVersion}` : ''})`
      : 'Schema: unknown (the caller did not resolve one)',
    `Workspace: ${CHANGE_ROOT}/${name}`,
  ]
  if (change?.metadata?.skip_specs === true) {
    lines.push('Skip specs: yes (`skip_specs: true` — this change declares that its specs are skipped)')
  }
  const metadata = change?.metadata && typeof change.metadata === 'object' ? change.metadata : {}
  if (typeof metadata.created === 'string' && metadata.created.length > 0) lines.push(`Created: ${metadata.created}`)
  if (typeof metadata.goal === 'string' && metadata.goal.trim().length > 0) lines.push(`Goal: ${metadata.goal.trim()}`)
  if (metadata.retire_capabilities === true) lines.push('Retire capabilities: yes (`retire_capabilities: true`)')
  lines.push('')
  lines.push(
    `Follow the vendored upstream OPSX \`${skillName}\` workflow below as written. Its DSH adaptation section maps every upstream \`openspec ...\` command onto reading or editing workspace files, or onto a \`/opsx-*\` DSH command; use those file-semantics actions and never a CLI. Then apply the workflow to the current facts and satisfy the finish contract at the end.`,
  )
  lines.push('')
  lines.push(`### Vendored workflow: ${skillName} (upstream OpenSpec 1.14.3, MIT)`)
  lines.push('')
  lines.push(skill.content.trim())
  lines.push('')
  lines.push('### End of vendored workflow')
  lines.push('')
  lines.push(workflowFactsBlock(workflow, normalizeWorkflowFacts(facts)))
  lines.push('')

  const context = contextBlock(config, workflow === 'sync' ? 'sync workflow constraints' : 'archive workflow constraints')
  if (context.length > 0) lines.push(context, '')
  const rules = rulesBlock(config, workflow)
  if (rules.length > 0) lines.push(rules, '')
  const guidance = operationGuidance(config, workflow)
  if (guidance.length > 0) {
    lines.push(`### Operation guidance (${workflow}.guidance, advisory)`)
    lines.push(guidance)
    lines.push('')
  }

  lines.push(workflow === 'sync' ? syncFinishContract(name) : archiveFinishContract(name))
  return lines.join('\n')
}

/**
 * Sync AI workflow prompt: the adapted vendored OPSX `sync-specs` skill body,
 * the change's current engine facts, the project context/rules/guidance and the
 * sync finish contract (stop on validation ERROR, intelligent-merge the main
 * specs, verify the canonical structure, then run `/opsx-validate`).
 *
 * This builder never writes; it only reads the bundled vendored skill text.
 *
 * @param {object} options
 * @param {string} [options.cwd] absolute workspace root (kept for symmetry with the other builders)
 * @param {string} [options.changeName] change name (folder under openspec/changes/)
 * @param {object} [options.schema] resolved schema wrapper or bare schema definition
 * @param {object} [options.config] project config (`context`, `rules.sync`, `operations.sync.guidance`)
 * @param {object} [options.change] ChangeState from the native engine
 * @param {object} [options.facts] engine-derived facts (§10.4 shape)
 * @returns {Promise<string>} model-facing prompt
 */
export async function buildSyncWorkflowPrompt({ cwd, changeName, schema = null, config = {}, change = null, facts = null } = {}) {
  return buildOpsxWorkflowPrompt({ kind: 'sync', changeName, schema, config, change, facts })
}

/**
 * Archive AI workflow prompt: the adapted vendored OPSX `archive-change` skill
 * body, completion facts (artifacts, tasks, deltas, main specs, archive target)
 * and the archive finish contract (confirm completion, stop on validation
 * ERROR or an existing archive target, intelligent-merge or skip sync,
 * validate, then finalize with `/opsx-archive <name> --yes --skip-specs`).
 *
 * This builder never writes; it only reads the bundled vendored skill text.
 *
 * @param {object} options
 * @param {string} [options.cwd] absolute workspace root (kept for symmetry with the other builders)
 * @param {string} [options.changeName] change name (folder under openspec/changes/)
 * @param {object} [options.schema] resolved schema wrapper or bare schema definition
 * @param {object} [options.config] project config (`context`, `rules.archive`, `operations.archive.guidance`)
 * @param {object} [options.change] ChangeState from the native engine
 * @param {object} [options.facts] engine-derived facts (§10.4 shape, including `archiveTarget`)
 * @returns {Promise<string>} model-facing prompt
 */
export async function buildArchiveWorkflowPrompt({ cwd, changeName, schema = null, config = {}, change = null, facts = null } = {}) {
  return buildOpsxWorkflowPrompt({ kind: 'archive', changeName, schema, config, change, facts })
}

/** Maximum characters of the report methodology embedded in one prompt. */
const REPORT_METHODOLOGY_LIMIT = 12_000

/** Bundled report methodology: the single source of truth for the narrative rules. */
const REPORT_METHODOLOGY_URL = new URL('./report/report-methodology.md', import.meta.url)

/** Compact methodology used when the bundled asset is missing or unreadable. */
const REPORT_METHODOLOGY_FALLBACK = [
  '## 报告方法论（主线锚定 · 渐进披露 · 证据分级）',
  '',
  '1. 主线锚定三步：① 定位——这项工作属于哪个大系统、哪条核心主线、哪个支线能力，服务什么最终目标；② 展开——具体实现或修复了什么、改前 / 改后行为如何；③ 回归主线——用主线语言说明成果对核心能力或目标的影响。不要把 change 名、缺陷编号或「修复了 N 个 bug」当作标题 / 结论。',
  '2. 渐进披露：首屏只给一句话主线定位 + 一句话成果；任务清单、文件落点、验证读数、术语等细节默认折叠（<details>），按需展开；概念 / 方法论单独成节或单独折叠。',
  '3. 时间段汇总：先给出该时间段在核心主线上的统一定位与整体成果，再按支线 / 能力归组展开各 change，禁止把多份单变更报告拼接。',
  '4. 证据分级：delta 是 after 权威；MODIFIED / REMOVED 的旧文本只有 proposal / design 原文或可定位的 git 历史支撑时才标「原文」，否则标「推断」或「旧文本未留存」；不得编造旧行为、测试结果或指标，材料中没有就写「归档材料中未见」或「未验证」。',
  '5. 反模式：用 change 名 / 缺陷编号当标题；只罗列任务与文件；把推断写成事实；把多个 change 机械拼接；首屏堆细节；宣称无来源的测试通过或指标。',
].join('\n')

/** Report scopes accepted by `buildReportPrompt`. */
const REPORT_SCOPES = new Set(['change', 'range'])

/** Maximum delta-spec rows and pending-task rows rendered into one report prompt. */
const REPORT_MAX_DELTA_ROWS = 40
const REPORT_MAX_PENDING_TASKS = 15

/**
 * Read the bundled report methodology, bounded to keep the fill-the-composer
 * prompt usable. Missing or empty assets fall back to the compact constant.
 *
 * @returns {string}
 */
function readReportMethodology() {
  let text = ''
  try {
    text = readFileSync(REPORT_METHODOLOGY_URL, 'utf8').trim()
  } catch {
    return REPORT_METHODOLOGY_FALLBACK
  }
  if (text.length === 0) return REPORT_METHODOLOGY_FALLBACK
  return text.length > REPORT_METHODOLOGY_LIMIT
    ? `${text.slice(0, REPORT_METHODOLOGY_LIMIT)}\n\n[methodology truncated at ${REPORT_METHODOLOGY_LIMIT} characters]`
    : text
}

/** Render `- label: value` only when the value is non-empty. */
function reportFactLine(lines, label, value) {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value)
  if (text.length > 0) lines.push(`- ${label}: ${text}`)
}

/**
 * Mainline section: the optional project card when present, else explicit
 * inference instructions that force the 「主线来源：推断」 label and name the
 * missing gaps instead of inventing a system goal.
 */
function reportMainlineBlock(mainline) {
  const text = typeof mainline?.text === 'string' ? mainline.text.trim() : ''
  const lines = ['## Mainline anchor (read this first)']
  if (text.length > 0 && mainline?.source === 'card') {
    lines.push('', '主线来源：项目主线卡', '', text)
    return lines.join('\n')
  }
  lines.push(
    '',
    'No project mainline card is available. Label the report exactly `主线来源：推断` and infer the mainline from, in this order: the `context` in `openspec/config.yaml`, the `## Purpose` of the main specs, the proposal `## Capabilities` / `## Impact`, and the design `## Context`.',
    '',
    'List these missing mainline gaps in the report instead of inventing them: larger system; core mainline and final goal; branch / capability map; current stage goal and reporting conventions.',
  )
  return lines.join('\n')
}

/** Parse one delta counter, tolerating the upper-case `delta` shape. */
function deltaCounter(row, lower, upper) {
  const value = row?.[lower] ?? row?.[upper]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Normalize delta rows to `{ path, capability, added, modified, removed, renamed }`. */
function normalizeDeltaFiles(facts, change) {
  const rows = Array.isArray(facts?.deltaFiles)
    ? facts.deltaFiles
    : Array.isArray(change?.delta?.files)
      ? change.delta.files
      : []
  return rows.slice(0, REPORT_MAX_DELTA_ROWS).map((row) => ({
    path: String(row?.path ?? ''),
    capability: String(row?.capability ?? row?.label ?? ''),
    added: deltaCounter(row, 'added', 'ADDED'),
    modified: deltaCounter(row, 'modified', 'MODIFIED'),
    removed: deltaCounter(row, 'removed', 'REMOVED'),
    renamed: deltaCounter(row, 'renamed', 'RENAMED'),
  }))
}

/** Main spec paths derived from delta capabilities when the caller did not pass them. */
function mainSpecPathsOf(facts, deltaFiles) {
  if (Array.isArray(facts?.mainSpecPaths)) return facts.mainSpecPaths.filter((value) => typeof value === 'string')
  const seen = new Set()
  for (const row of deltaFiles) {
    if (row.capability === '') continue
    seen.add(`openspec/specs/${row.capability}/spec.md`)
  }
  return [...seen]
}

/** `scope='change'` facts block: archive path, metadata, artifacts, tasks, deltas, specs, validation. */
function reportChangeFactsBlock({ changeName, changePath, change, facts }) {
  const metadata = facts?.metadata ?? change?.metadata ?? {}
  const lines = [
    '## Change facts (authoritative; do not invent)',
    `- Change: ${changeName || change?.name || '(unknown)'}`,
    `- Archive path: ${changePath || '(unknown)'}`,
  ]
  reportFactLine(lines, 'Schema', facts?.schemaName ?? metadata.schema ?? change?.schemaName)
  reportFactLine(lines, 'Created', metadata.created)
  reportFactLine(lines, 'Goal', metadata.goal ?? change?.summary?.goal)
  reportFactLine(lines, 'Why / problem', change?.summary?.why)

  const artifacts = Array.isArray(facts?.artifacts)
    ? facts.artifacts
    : Array.isArray(change?.artifacts)
      ? change.artifacts.map((artifact) => ({ id: artifact.id, status: artifact.status }))
      : []
  if (artifacts.length > 0) {
    lines.push(`- Artifacts: ${artifacts.map((artifact) => `${artifact.id}=${artifact.status}`).join(', ')}`)
  }

  const tasks = facts !== null && typeof facts === 'object' && 'tasks' in facts ? facts.tasks : change?.tasks ?? null
  const total = typeof tasks?.total === 'number' ? tasks.total : null
  const done = typeof tasks?.done === 'number' ? tasks.done : null
  if (total !== null) {
    lines.push(`- Tasks: ${done ?? 0}/${total} checked`)
    const pending = Array.isArray(tasks.pending) ? tasks.pending : []
    if (pending.length > 0) {
      lines.push(`- Pending tasks (first ${Math.min(pending.length, REPORT_MAX_PENDING_TASKS)} of ${pending.length}):`)
      for (const item of pending.slice(0, REPORT_MAX_PENDING_TASKS)) lines.push(`  - ${String(item)}`)
    }
  } else {
    lines.push('- Tasks: no tasks file in this archived change')
  }

  const deltaFiles = normalizeDeltaFiles(facts, change)
  let added = 0
  let modified = 0
  let removed = 0
  let renamed = 0
  for (const row of deltaFiles) {
    added += row.added
    modified += row.modified
    removed += row.removed
    renamed += row.renamed
  }
  if (deltaFiles.length > 0) {
    lines.push('- Delta specs (the `after` authority):')
    for (const row of deltaFiles) {
      lines.push(
        `  - ${row.path} — capability ${row.capability || '(unknown)'}: ADDED ${row.added}, MODIFIED ${row.modified}, REMOVED ${row.removed}, RENAMED ${row.renamed}`,
      )
    }
    lines.push(`- Delta totals: ADDED ${added} / MODIFIED ${modified} / REMOVED ${removed} / RENAMED ${renamed}`)
  } else {
    lines.push('- Delta specs: none in this archived change')
  }

  const mainSpecPaths = mainSpecPathsOf(facts, deltaFiles)
  if (mainSpecPaths.length > 0) {
    lines.push(`- Main spec paths: ${mainSpecPaths.join(', ')}`)
  }

  const validation = facts?.validation ?? change?.validation
  if (validation && typeof validation === 'object') {
    lines.push(`- Validation: ${validation.errors ?? 0} ERROR / ${validation.warnings ?? 0} WARNING / ${validation.infos ?? 0} INFO`)
  }
  return lines.join('\n')
}

/** `scope='range'` facts block: inclusive period, included changes and period naming. */
function reportRangeFactsBlock({ range }) {
  const from = typeof range?.from === 'string' && range.from.length > 0 ? range.from : '<from>'
  const to = typeof range?.to === 'string' && range.to.length > 0 ? range.to : '<to>'
  const included = Array.isArray(range?.included) ? range.included : []
  const lines = [
    '## Period facts (authoritative; do not invent)',
    `- From (inclusive): ${from}`,
    `- To (inclusive): ${to}`,
    `- Period name / output directory: ${from}_${to}`,
    `- Included archived changes: ${included.length}`,
  ]
  if (included.length === 0) {
    lines.push('- (no included changes were supplied)')
  } else {
    lines.push('- Included changes (name — archive path — archived date):')
    for (const entry of included) {
      lines.push(`  - ${entry?.name ?? '(unknown)'} — ${entry?.changePath ?? '(unknown path)'} — ${entry?.date ?? '(no date)'}`)
    }
  }
  lines.push(
    '',
    `The report title and the archive-information section MUST show the period ${from} → ${to} (${included.length} changes), not the name of one change.`,
    'The filtering semantics are the archived-directory dates (the `YYYY-MM-DD-` prefix), inclusive of both ends. State that counting basis in the report.',
  )
  return lines.join('\n')
}

/** Template section: absolute path + compact structural fallback when unreadable. */
function reportTemplateBlock(template) {
  const templatePath = typeof template?.path === 'string' ? template.path : ''
  const version = typeof template?.version === 'string' ? template.version : ''
  const lines = ['## Visual template']
  if (templatePath !== '') lines.push(`- Template file (absolute path): ${templatePath}`)
  if (version !== '') lines.push(`- Template version: ${version}`)
  lines.push(
    '- The report is ONE self-contained HTML file: all CSS inline in the template\'s `<style>` block, keep the template\'s class names and section order, no `<script>`, no external `<link>` / `<img>` / fonts / CDN / network assets, printable.',
  )
  let readable = false
  if (templatePath !== '') {
    try {
      readFileSync(templatePath)
      readable = true
    } catch {
      readable = false
    }
  }
  if (readable) {
    lines.push('- Read the template file before writing and reuse its inline CSS, classes and layout for this scope.')
  } else {
    lines.push(
      '',
      'The template file cannot be read. Use this compact structural fallback (same narrative order, inline CSS, `<details>` for details):',
      '1. Hero: one-sentence mainline anchor + one-sentence result, in mainline language.',
      '2. Mainline position: larger system, core mainline, branch / capability, final goal, and the mainline-source label.',
      '3. What was done / period overview: outcome first; for one change the before → after behavior, for a period the unified position grouped by branch / capability.',
      '4. Evidence and verification: evidence grade per claim (原文 / 推断 / 未验证), no invented tests or numbers.',
      '5. Details folded in `<details>`: archived artifacts, task progress, file locations, delta operation counts, references.',
      '6. Archive information and footer: change name or period, archive path(s), main spec paths, generatedAt, template version, and the statement that the report does not replace the spec source of truth.',
    )
  }
  return lines.join('\n')
}

/** Output section: exactly which file(s) to write, pointer / reference retention included. */
function reportOutputBlock({ cwd, scope, changeName, changePath, report, template, range }) {
  const reportAbsolute =
    typeof report?.absolutePath === 'string' && report.absolutePath.length > 0
      ? report.absolutePath
      : typeof report?.path === 'string'
        ? report.path
        : '(unknown)'
  const templateVersion = typeof template?.version === 'string' ? template.version : 'report-template/v1'
  const lines = ['## Output contract', `- Workspace: ${cwd ?? '(unknown)'}`]
  if (scope === 'range') {
    const directory =
      typeof report?.directory === 'string' && report.directory.length > 0
        ? report.directory
        : typeof report?.path === 'string' && report.path.endsWith('/index.html')
          ? report.path.slice(0, -'/index.html'.length)
          : '(unknown)'
    lines.push(
      `- Write exactly ONE self-contained HTML report to: ${reportAbsolute}`,
      `- Also write the reference file \`${directory}/report.json\` with JSON \`{ "scope": "range", "from": "${range?.from ?? ''}", "to": "${range?.to ?? ''}", "generatedAt": "<ISO-8601>", "template": "${templateVersion}", "included": [{ "name", "changePath", "date" }, ...] }\` recording every included change.`,
      '- Do NOT write one report per change and do NOT create any other HTML file.',
    )
  } else {
    lines.push(`- Write exactly ONE self-contained HTML report to: ${reportAbsolute}`)
    if (report?.inArchive === true) {
      lines.push('- The report lives directly inside the archived change directory, so no `report.json` pointer is needed.')
    } else {
      lines.push(
        `- The report is outside the archive directory: also write the pointer \`${changePath}/report.json\` next to the archived change with JSON \`{ "report": "<the report path as written>", "generatedAt": "<ISO-8601>", "template": "${templateVersion}", "change": "${changeName}" }\`.`,
        '- Write no other file.',
      )
    }
  }
  return lines.join('\n')
}

/** Evidence rules: delta is after authority; honest 原文 / 推断 / 旧文本未留存 grading. */
function reportEvidenceBlock() {
  return [
    '## Evidence rules (non-negotiable)',
    '- The archived delta specs are the authority for the `after` state; for MODIFIED / REMOVED requirements archiving does not preserve the old text.',
    '- Label old text 原文 ONLY when the proposal / design original text or a locatable git history proves it; otherwise 推断, or 旧文本未留存 when even a reconstruction is impossible.',
    '- Never invent tests, metrics, issue numbers, validation results or dates: write 归档材料中未见 or 未验证 instead.',
    '- Keep every claim tied to its evidence grade and, for a period report, to the change it came from; never upgrade inference into fact.',
  ].join('\n')
}

/** Period-only orchestration: one read-only fact card per included change, one merged report. */
function reportOrchestrationBlock() {
  return [
    '## Sub-agent orchestration (period scope only)',
    '- If this session supports sub-agents, dispatch one read-only sub-agent per included change listed above. Each returns one fixed fact card: change / archive path / date / capabilities / problem / intent / what changed / before-after (with evidence level) / evidence paths / limits / mainline candidate.',
    '- Run at most 4-6 sub-agents concurrently; with more included changes, process them in batches.',
    '- If sub-agents are unavailable or impractical, collect the same facts sequentially and label that fallback in the report.',
    '- Sub-agents MUST NOT write or modify any file: no report, no proposal / design / tasks / delta, no main spec. They only read and return fact cards.',
    '- The main session synthesizes ONE report: group by branch / capability, resolve conflicting fact cards explicitly (merge by timeline when several changes touched one capability; mark unresolved conflicts), and never concatenate the cards or produce one report per change.',
  ].join('\n')
}

/** Finish contract: bounded writes, no planning-artifact edits, honest failure reporting. */
function reportFinishContract({ scope }) {
  return [
    '## Finish contract',
    '1. Write the file(s) named in the output contract and nothing else.',
    '2. Do NOT modify proposal.md, design.md, tasks.md, any delta spec or any main spec.',
    '3. If an output path cannot be written (for example the DSH file policy rejects it), stop and report the failure; never claim success or write somewhere else silently.',
    '4. Keep the archive-information section and footer references, and state that the report does not replace the spec source of truth.',
    scope === 'range'
      ? '5. Final reply: the absolute report path(s) plus the number of included changes; nothing else.'
      : '5. Final reply: the absolute report path(s); nothing else.',
  ].join('\n')
}

/**
 * Report prompt builder: one fill-the-composer prompt for either a single
 * archived change or a period report. The instructions are English; the report
 * itself must be written in Simplified Chinese (zh-CN).
 *
 * The narrative methodology comes from `src/report/report-methodology.md` (the
 * single source of truth) and is embedded so it always reaches the model; when
 * the asset is missing a compact fallback covering 主线锚定 / 渐进披露 / 证据分级
 * is embedded instead. The HTML template is referenced by path (plus a compact
 * outline fallback) so the prompt stays editable in the composer.
 *
 * This builder never writes; reading the methodology is its only I/O.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] absolute workspace root (kept for symmetry)
 * @param {'change'|'range'} [options.scope] report scope
 * @param {string} [options.changeName] archived change name (single-change scope)
 * @param {string} [options.changePath] workspace-relative archived change directory (single-change scope)
 * @param {object} [options.change] ChangeState of the archived change
 * @param {object} [options.facts] single-change facts: schemaName, metadata, artifacts, tasks, deltaFiles, mainSpecPaths, validation
 * @param {object} [options.range] period facts: `{ from, to, included: [{ name, changePath, date }] }`
 * @param {object} [options.report] resolved output: single change `{ path, absolutePath, inArchive }`, period `{ path, absolutePath, directory }`
 * @param {object} [options.template] `{ path: absoluteTemplatePath, version }`
 * @param {object} [options.mainline] `{ text, source: 'card'|'inferred' }` (text may be '')
 * @returns {Promise<string>} model-facing report prompt
 */
export async function buildReportPrompt({
  cwd,
  scope = 'change',
  changeName = '',
  changePath = '',
  change = null,
  facts = null,
  range = null,
  report = null,
  template = null,
  mainline = null,
} = {}) {
  const resolvedScope = REPORT_SCOPES.has(scope) ? scope : ''
  if (resolvedScope === '') throw new Error(`unsupported report scope: ${String(scope)}`)
  const title =
    resolvedScope === 'range'
      ? '# Human report prompt — period report'
      : '# Human report prompt — single archived change'
  const parts = [
    title,
    '',
    'You are writing a human-facing report, not a specification. The report body MUST be written in Simplified Chinese (zh-CN); these English instructions only define the work.',
  ]
  if (resolvedScope === 'change') {
    parts.push('', reportChangeFactsBlock({ changeName, changePath, change, facts }))
  } else {
    parts.push('', reportRangeFactsBlock({ range }))
  }
  parts.push('', reportMainlineBlock(mainline))
  parts.push(
    '',
    '## Methodology (single source of truth — follow it exactly)',
    '',
    'This methodology enforces 主线锚定（mainline anchoring）, 渐进披露（progressive disclosure）and 证据分级（evidence grading）.',
    '',
    readReportMethodology(),
  )
  parts.push('', reportTemplateBlock(template))
  parts.push('', reportOutputBlock({ cwd, scope: resolvedScope, changeName, changePath, report, template, range }))
  parts.push('', reportEvidenceBlock())
  if (resolvedScope === 'range') parts.push('', reportOrchestrationBlock())
  parts.push('', reportFinishContract({ scope: resolvedScope }))
  return parts.join('\n')
}
