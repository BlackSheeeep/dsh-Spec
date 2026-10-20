/**
 * Built-in fallback skills for the six OpenSpec core workflows.
 *
 * These bodies are adapted from the upstream OpenSpec 1.14.3 native skills
 * (Fission-AI/OpenSpec, MIT) and rewritten for a file-based plugin that never
 * spawns a process and never invokes an external `openspec` executable. Every
 * step reads or writes files under the project's `openspec/` root, or uses the
 * DSH `/opsx-*` commands, which perform the same deterministic work in-process.
 *
 * `FALLBACK_SKILLS[].content` is the full SKILL.md text (YAML frontmatter
 * included). `createFallbackProvider()` in `./skills.js` returns the body as
 * the DSH `SkillDefinition.content` for a runtime provider, so the frontmatter
 * also documents the attribution required by the OpenSpec skills integration
 * spec (`adaptedFrom`, `upstreamVersion`, `license`).
 *
 * Do not edit these bodies to include command-line invocations: the
 * coexistence requirement is that fallback skills work without the OpenSpec
 * CLI. Paths, file names and the `/opsx-*` DSH command names are fine.
 */

/** Attribution recorded in every fallback skill frontmatter. @type {Readonly<{ adaptedFrom: string, upstreamVersion: string, license: string }>} */
const ATTRIBUTION = Object.freeze({
  adaptedFrom: 'Fission-AI/OpenSpec',
  upstreamVersion: '1.14.3',
  license: 'MIT',
});

/**
 * @typedef {object} FallbackSkill
 * @property {string} name            Skill name as used by the DSH skill catalog.
 * @property {string} description     One-line catalog description.
 * @property {string} whenToUse       Trigger guidance for the model.
 * @property {string} workflow        One of `explore`, `propose`, `apply`, `update`, `sync`, `archive`.
 * @property {string} content         Full SKILL.md text, YAML frontmatter included, trailing newline.
 * @property {Readonly<Record<string, string>>} metadata Attribution metadata (mirrors the frontmatter `metadata:` block).
 */

/** Canonical fallback skill names, one per core workflow. */
const FALLBACK_NAME_BY_WORKFLOW = Object.freeze({
  explore: 'openspec-explore',
  propose: 'openspec-propose',
  apply: 'openspec-apply-change',
  update: 'openspec-update-change',
  sync: 'openspec-sync-specs',
  archive: 'openspec-archive-change',
});

/**
 * Build a fallback skill object from its parts, rendering a tolerant YAML
 * frontmatter block (plain scalars only - see `parseSkillFrontmatter` in
 * `./skills.js` for the accepted subset).
 *
 * @param {object} input
 * @param {'explore'|'propose'|'apply'|'update'|'sync'|'archive'} input.workflow
 * @param {string} input.upstreamPath
 * @param {string} input.description
 * @param {string} input.whenToUse
 * @param {string} input.body
 * @returns {FallbackSkill}
 */
function createFallbackSkill({ workflow, upstreamPath, description, whenToUse, body }) {
  const name = FALLBACK_NAME_BY_WORKFLOW[workflow];
  const metadata = Object.freeze({
    adaptedFrom: ATTRIBUTION.adaptedFrom,
    upstreamVersion: ATTRIBUTION.upstreamVersion,
    license: ATTRIBUTION.license,
    workflow,
    upstreamPath,
  });
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `when-to-use: ${whenToUse}`,
    'license: MIT',
    'metadata:',
    `  adaptedFrom: ${ATTRIBUTION.adaptedFrom}`,
    `  upstreamVersion: "${ATTRIBUTION.upstreamVersion}"`,
    `  license: ${ATTRIBUTION.license}`,
    `  workflow: ${workflow}`,
    `  upstreamPath: ${upstreamPath}`,
    '---',
    '',
  ].join('\n');
  return Object.freeze({
    name,
    description,
    whenToUse,
    workflow,
    content: `${frontmatter}${body.trim()}\n`,
    metadata,
  });
}

const EXPLORE_BODY = `
Enter explore mode for an OpenSpec project. Exploration is thinking, not implementation. In DSH,
\`/opsx-explore <topic>\` enters the same mode with the project context already loaded.

## Goal

Reach clarity with the user: understand the problem, map the relevant code, compare options,
and decide whether the work should become a change. Producing a change is optional; capturing
decisions only happens when the user asks for it.

## Read first

1. \`openspec/config.yaml\` (use \`openspec/config.yml\` only when \`config.yaml\` is absent). Read
   \`schema\`, \`context\`, \`rules\` and \`operations\`. Treat \`context\` as project constraints and
   never copy it into an answer or artifact.
2. \`openspec/changes/\` - list the active change directories (ignore \`archive/\`). For each relevant
   change read \`.openspec.yaml\` and the existing \`proposal.md\`, \`design.md\`, \`tasks.md\` and
   \`specs/**/spec.md\`.
3. \`openspec/specs/\` - the durable capability specs. Read the relevant \`spec.md\` files in full,
   including scenarios, before claiming that a behavior already exists.
4. The code, tests, docs and configuration the discussion touches. Ground every claim in a file
   you actually read.

## Steps

1. Establish what the user wants to understand or decide. Ask one focused question at a time when
   only the user can answer it; do not ask for facts you can verify yourself.
2. Investigate read-only: map the architecture, integration points, existing patterns and hidden
   complexity. Use plain ASCII diagrams when they clarify a flow or a set of options.
3. Separate observed behavior from assumptions and proposed changes. Cite file paths.
4. Offer concrete options with tradeoffs. Recommend one only when the evidence supports it.
5. When a decision crystallises, name where it belongs: scope in \`proposal.md\`, behavior in a
   \`specs/<capability>/spec.md\` delta, approach in \`design.md\`, work in \`tasks.md\`.
6. If the user explicitly asks to capture the result as a change, hand off to the propose workflow
   (in DSH run \`/opsx-propose <intent>\`) instead of creating change files ad hoc.

## Boundaries

- Never edit project code, tests or configuration while exploring.
- Do not create a change directory by hand. \`/opsx-propose\` scaffolds
  \`openspec/changes/<name>/\` with \`.openspec.yaml\`.
- Do not capture insights in files unless the user explicitly asks.
- Do not call an external command-line tool; every input is a file under the project root.

## Done criteria

- The user has the clarity they came for, or the discussion has been captured in the artifacts
  they requested.
- The next step is explicit: run \`/opsx-propose\` to turn the discussion into a change, or keep
  exploring.
`;

const PROPOSE_BODY = `
Plan a new OpenSpec change: scaffold the change directory and write every planning artifact the
active schema requires. Planning only - never implement the change here.

## Goal

Produce a reviewable plan: \`proposal.md\`, one delta spec per affected capability, optional
\`design.md\`, and the tasks tracking file (default \`tasks.md\`). Artifact ids, output paths and
dependencies come from the active schema, not from this list.

## Read first

1. \`openspec/config.yaml\` (or \`config.yml\`) for \`schema\`, \`context\` and \`rules\`. Apply
   \`context\` and rules as constraints; never copy them into artifacts.
2. \`openspec/specs/\` for the capabilities the request touches. Read each relevant \`spec.md\` in
   full so the deltas extend real behavior instead of duplicating it.
3. The project code, tests and docs the change touches. Scope and tasks must be grounded in what
   the repository actually contains.
4. An existing project schema at \`openspec/schemas/<schema>/schema.yaml\` when present. Its
   \`artifacts[].requires\` and \`apply\` define build order and the tracking file; otherwise use the
   built-in \`spec-driven\` order proposal -> specs -> design -> tasks.

## Steps

1. Derive a kebab-case change name from the request (for example "add user authentication" ->
   \`add-user-auth\`). Ask when the intent is materially ambiguous; otherwise record reasonable
   assumptions in the artifacts.
2. Confirm the project is initialized: \`openspec/changes/\` and \`openspec/config.yaml\` (or
   \`config.yml\`) exist. If not, run the DSH \`openspec-init\` command instead of hand-creating the
   skeleton.
3. Scaffold the change with \`/opsx-propose <change-name> <intent>\` in DSH. That command creates
   \`openspec/changes/<name>/.openspec.yaml\` with the effective \`schema\` and a local
   \`created: YYYY-MM-DD\` date, submits the native propose prompt, and stops before implementation.
   If you must scaffold manually, create only \`openspec/changes/<name>/.openspec.yaml\` with
   \`schema\`, \`created\` and an optional \`goal\`.
4. Read \`.openspec.yaml\` and the active schema, then list artifacts in dependency order with their
   current status: done when the output file exists, skipped when the schema or \`skip_specs: true\`
   excludes it, ready when every dependency is done or skipped, otherwise blocked.
5. Create each \`ready\` artifact that is missing. Follow the schema instruction and template for
   that artifact; when no template file is readable, use these structures:
   - \`proposal.md\`: \`## Why\` (50-1000 characters), \`## What Changes\`, \`## Capabilities\`.
   - \`specs/<capability>/spec.md\`: a delta with \`## ADDED Requirements\`,
     \`## MODIFIED Requirements\`, \`## REMOVED Requirements\` or \`## RENAMED Requirements\`; each
     requirement uses \`### Requirement: <name>\` and a SHALL/MUST statement, and each scenario uses
     \`#### Scenario: <name>\` with WHEN/THEN bullets.
   - \`design.md\`: context, goals and non-goals, decisions with alternatives, risks, migration.
   - \`tasks.md\`: numbered checkbox groups (\`- [ ] 1.1 ...\`) small enough to implement and verify
     one at a time.
6. Re-read the files you wrote and recompute artifact status. Continue until every artifact the
   apply phase transitively requires is done or deliberately skipped because the schema marks it
   conditional; do not guess readiness from a single file.
7. Validate the plan with \`/opsx-validate <change-name>\` and fix ERROR findings before stopping.

## Boundaries

- Planning artifacts only. Do not edit project code, run builds, or start implementation here.
- Never overwrite an existing change; ask whether to update it (\`/opsx-update\`) or start a new one.
- Never create an artifact the schema marks skipped; when \`skip_specs: true\`, do not create delta
  spec files.
- Do not call an external command-line tool; all reads and writes are files under the project root.

## Done criteria

- \`openspec/changes/<name>/.openspec.yaml\` records the effective schema and local \`created\` date.
- Every required planning artifact exists and validation reports no ERROR findings.
- The user is told the plan is ready and that implementation starts with
  \`/opsx-apply <change-name>\`; stop and wait for a new request.
`;

const APPLY_BODY = `
Implement the tracked tasks of an OpenSpec change. Read the plan, work task by task, and tick
checkboxes as behavior is completed. Do not rewrite the plan.

## Goal

Turn a planned change into working code with minimal, scoped edits, keeping the tasks tracking
file an accurate progress record.

## Read first

1. \`openspec/changes/<name>/.openspec.yaml\` for the effective \`schema\`, then
   \`openspec/config.yaml\` (or \`config.yml\`) for \`context\` and \`operations.apply.guidance\`. Treat
   both as constraints; do not copy them into code or artifacts.
2. \`openspec/schemas/<schema>/schema.yaml\` when the project defines one, to find the artifact that
   tracks tasks (default \`tasks.md\`) and the \`apply\` contract.
3. The existing planning artifacts: \`proposal.md\`, \`design.md\`, every delta under \`specs/\`, and
   the tracking file. Re-read them from disk now - the user may have edited them.
4. The implementation files named by the tasks, plus nearby tests and configuration.

## Steps

1. Select the change. Use the name the user gave; otherwise auto-select when exactly one active
   directory exists under \`openspec/changes/\` (ignore \`archive/\`), and ask when several are
   active. Announce the selection.
2. In DSH, run \`/opsx-apply <change-name>\` to have the plugin compose the native apply prompt from
   project context and guidance. Follow the composed prompt when it is available; the steps below
   are the equivalent file-based procedure.
3. Show current progress: N/M tasks checked, the schema in use, and the remaining tasks.
4. For each pending task: understand exactly what it requires, make the minimal code change, run
   the relevant tests, then tick that task's checkbox immediately (\`- [ ]\` -> \`- [x]\`). Re-read
   the tracking file to confirm the checkbox changed and that numbering is untouched.
5. Stop and ask when a task is ambiguous, when implementation reveals a design conflict, or when a
   task needs work beyond the specification. Do not narrow, defer or silently omit specified
   behavior; point to \`/opsx-update\` for planning changes.
6. Report after each task or group: what changed, what was verified, and the updated progress.

## Boundaries

- Edit only the implementation and test files required by the tasks; do not rewrite planning
  artifacts here.
- Never mark a task complete until its specified behavior is implemented and verified.
- Do not invoke an external command-line tool; task state is the checkbox markers in the tracking
  file and code state is the repository.
- Do not create or move change directories; archiving is a separate workflow.

## Done criteria

- Every tracked task is checked, or the workflow is paused on a reported blocker.
- Relevant tests pass and the change reports M/M tasks complete.
- When all tasks are complete, report it and point to \`/opsx-archive <change-name>\`.
`;

const UPDATE_BODY = `
Revise the existing planning artifacts of an OpenSpec change and keep them coherent with each
other. Never edit code.

## Goal

Fold new decisions into a change plan, or reconcile artifacts after an edit, without advancing the
plan's frontier or creating missing artifacts.

## Read first

1. \`openspec/changes/<name>/\` - read \`.openspec.yaml\` and every existing artifact:
   \`proposal.md\`, \`design.md\`, all delta specs under \`specs/\`, and the tasks tracking file. Do
   not assume artifact names; read the project schema at \`openspec/schemas/<schema>/schema.yaml\`
   when one exists.
2. \`openspec/config.yaml\` (or \`config.yml\`) for \`context\` and the \`rules\` keyed by artifact id.
   Rules apply only to the artifact you are writing.
3. \`openspec/specs/\` for the capabilities the change modifies, so the revised deltas stay
   consistent with durable specs.

## Steps

1. Select the change (explicit name; otherwise the single active change; otherwise ask). Announce
   it.
2. Understand the request. If the user named a revision, start there. If they only asked to
   "update" or "make coherent", perform a coherence review: read the artifacts and find
   contradictions, gaps, stale statements and duplication.
3. Draft the edit in the conversation. Then check every other existing artifact against the draft
   in both directions - an edit to \`tasks.md\` can invalidate \`design.md\`, not only the reverse.
4. Propose the concrete file revisions and why. In DSH, \`/opsx-update <change-name>\` composes the
   native update prompt with project context. Write each revision only after the user confirms; if
   the user rejects one, leave that file unchanged.
5. When an artifact needs more than an edit - it does not exist yet - do not create it here. Point
   to the propose workflow (\`/opsx-propose\`) for new planning artifacts.

## Boundaries

- Planning artifacts only. Never edit project code; if the revised plan implies code changes, point
  to \`/opsx-apply\`.
- Do not advance the build frontier: leave missing artifacts and \`skip_specs\`-skipped artifacts
  untouched.
- Never write through a glob output pattern; edit the concrete files that exist on disk.
- Do not call an external command-line tool; all reads and writes are files under the project root.

## Done criteria

- The requested revision is applied and every artifact that exists agrees with it.
- Nothing was written without confirmation, no code changed, and the recommended next command is
  named (\`/opsx-apply\` for implementation, \`/opsx-archive\` when complete).
`;

const SYNC_BODY = `
Sync the delta specs of an OpenSpec change into the durable main specs. This is a deterministic
file merge, not a rewrite of the change.

## Goal

Apply ADDED, MODIFIED, REMOVED and RENAMED requirement operations to
\`openspec/specs/<capability>/spec.md\` while preserving every byte the delta does not mention.

## Read first

1. \`openspec/changes/<name>/.openspec.yaml\` - the effective \`schema\` and \`skip_specs\`. When
   \`skip_specs: true\` there are no delta specs to sync and the command must not write main specs.
2. The delta specs at \`openspec/changes/<name>/specs/<capability-path>/spec.md\`. They are the only
   source of sync operations; do not infer deltas from other artifacts.
3. The matching main specs at \`openspec/specs/<capability-path>/spec.md\` (some may not exist yet).
4. \`openspec/config.yaml\` (or \`config.yml\`) for the \`rules\` of the \`specs\` artifact and
   \`operations\` guidance. Rules constrain the written specs; never copy them into a spec.

## Steps

1. In DSH, run \`/opsx-sync <change-name>\` first. Without \`--yes\` it returns a preview listing the
   affected main specs and per-requirement operations and writes nothing; rerun with \`--yes\` to
   apply the deterministic merge. Prefer the command when it is available.
2. File-based equivalent: validate the change first (in DSH \`/opsx-validate <change-name>\`); stop
   on any ERROR. Then for each capability delta:
   - ADDED: append the requirement block. A duplicate requirement name is an error, not an update.
   - MODIFIED: replace the whole named requirement block. The delta carries the full requirement
     body and every surviving scenario.
   - REMOVED: delete the named requirement block. If \`retire_capabilities: true\` in
     \`.openspec.yaml\` and no requirement remains, delete the main spec file instead of leaving an
     empty \`## Requirements\` section.
   - RENAMED: retitle the \`### Requirement:\` heading from FROM to TO.
3. For a new capability, create \`openspec/specs/<capability-path>/spec.md\` with
   \`# <Title> Specification\`, a \`## Purpose\` section copied from the delta when present
   (otherwise \`TBD - created by archiving change <name>. Update Purpose after archive.\`) and a
   single \`## Requirements\` section holding only ADDED requirements. Never create an empty
   \`## Requirements\` section.
4. Preserve untouched content exactly: existing titles, Purpose sections, requirements and
   scenarios the delta does not mention keep their current bytes and order.
5. Write only after the preview is confirmed; build content in memory and replace the file
   atomically. A failed write must leave the original file unchanged.
6. Re-read the written specs, check that no delta headers (\`## ADDED Requirements\` and siblings)
   leaked into a main spec, and run \`/opsx-validate\` over the workspace.

## Boundaries

- Do not archive the change here; sync leaves the change active.
- Never delete a main spec unless \`retire_capabilities: true\` and the last requirement was removed
  by this sync.
- Do not invoke an external command-line tool; all state is files under the project root.
- Do not touch source code, tests or change artifacts; only main specs are written.

## Done criteria

- Every selected delta capability is reflected in its main spec, with no delta-style section
  headers.
- Validation reports no ERROR findings for the updated specs.
- The change directory is untouched and still active; tell the user to run
  \`/opsx-archive\` when implementation is complete.
`;

const ARCHIVE_BODY = `
Archive a completed OpenSpec change: verify completeness, sync its deltas, and move the change
tree into \`openspec/changes/archive/\`. Archiving is deterministic and must be previewed before it
writes.

## Goal

Finalize a change - validation gate, spec sync, then a local-date archive move that keeps
\`.openspec.yaml\` with the archived change.

## Read first

1. \`openspec/changes/<name>/\` - \`.openspec.yaml\` for \`schema\`, \`skip_specs\` and
   \`retire_capabilities\`, plus every planning artifact that exists.
2. The tasks tracking file (default \`tasks.md\`). Only \`x\`/\`X\` checkbox markers count as complete;
   any other marker, including unfamiliar ones, is incomplete.
3. The delta specs under \`specs/\` and the matching main specs under \`openspec/specs/\` to see
   whether a sync is still needed.
4. \`openspec/config.yaml\` (or \`config.yml\`) for \`operations.archive.guidance\`; treat it as
   advisory and never copy it into output.

## Steps

1. Select the change (explicit name; otherwise the single active change; otherwise ask). Announce
   it.
2. Check completeness. Planning artifacts are satisfied when their output exists or when the
   schema/\`skip_specs\` skips them. Tasks are complete only when every tracked checkbox is
   \`- [x]\`. Report incomplete artifacts and tasks, and refuse to archive until the user resolves
   them.
3. Run \`/opsx-validate <change-name>\` and stop on ERROR findings. WARNING findings are shown to
   the user and may proceed.
4. Sync deltas deterministically. In DSH run \`/opsx-sync <change-name> --yes\` when the change has
   delta specs and \`skip_specs\` is not true; it previews, applies and validates the merge. When
   there are no delta specs, skip syncing. Never move the change while a sync is still running or
   has failed.
5. Archive with \`/opsx-archive <change-name>\` (preview) and \`/opsx-archive <change-name> --yes\`
   once confirmed. The target is \`openspec/changes/archive/<local-date>-<change-name>\` using the
   local \`YYYY-MM-DD\` date; do not stack a second date when the name already starts with one.
   Refuse an existing target.
6. File-based equivalent: after the sync and validation above, move the whole
   \`openspec/changes/<name>/\` directory into
   \`openspec/changes/archive/YYYY-MM-DD-<name>/\`, keeping \`.openspec.yaml\` inside it. Never
   delete or rewrite another change.
7. Report what was archived, the schema, whether specs were synced, and any warnings that were
   accepted.

## Boundaries

- Do not archive with incomplete tasks or ERROR validation findings; do not silently skip the sync.
- Never overwrite an existing archive target and never delete user content.
- Do not edit project code or planning content during archiving; planning changes belong to
  \`/opsx-update\`.
- Do not call an external command-line tool; all state is files under the project root.

## Done criteria

- The change tree lives at \`openspec/changes/archive/YYYY-MM-DD-<name>/\` with \`.openspec.yaml\`
  retained.
- Main specs reflect the deltas (unless \`skip_specs: true\`) and validation is clean.
- The user receives a short archive summary with any warnings.
`;

/**
 * The six core fallback skill definitions.
 *
 * @type {readonly FallbackSkill[]}
 */
export const FALLBACK_SKILLS = Object.freeze([
  createFallbackSkill({
    workflow: 'explore',
    upstreamPath: 'skills/openspec-explore/SKILL.md',
    description:
      'Explore an OpenSpec project as a thinking partner before or during a change. ' +
      'Use when the user wants to investigate an idea or clarify requirements without implementing.',
    whenToUse:
      'Use when the user asks to explore, investigate or think through an idea in a project that ' +
      'uses OpenSpec, or asks for opsx explore or opsx-explore.',
    body: EXPLORE_BODY,
  }),
  createFallbackSkill({
    workflow: 'propose',
    upstreamPath: 'skills/openspec-propose/SKILL.md',
    description:
      'Plan a new OpenSpec change and create every required planning artifact in one pass. ' +
      'Use when the user describes something to build or fix and wants a complete proposal.',
    whenToUse:
      'Use when the user asks to propose or plan a change, says propose a change, or asks for ' +
      'opsx propose or opsx-propose.',
    body: PROPOSE_BODY,
  }),
  createFallbackSkill({
    workflow: 'apply',
    upstreamPath: 'skills/openspec-apply-change/SKILL.md',
    description:
      'Implement the tracked tasks of an OpenSpec change, keeping the task list accurate. ' +
      'Use when the user wants to start, continue or finish implementation.',
    whenToUse:
      'Use when the user asks to implement, apply, continue or finish a change, or asks for ' +
      'opsx apply or opsx-apply.',
    body: APPLY_BODY,
  }),
  createFallbackSkill({
    workflow: 'update',
    upstreamPath: 'skills/openspec-update-change/SKILL.md',
    description:
      'Revise the planning artifacts of an existing OpenSpec change and keep them coherent. ' +
      'Use when the user wants to update a plan or reconcile its artifacts.',
    whenToUse:
      'Use when the user asks to update, revise or reconcile a change plan, or asks for ' +
      'opsx update or opsx-update.',
    body: UPDATE_BODY,
  }),
  createFallbackSkill({
    workflow: 'sync',
    upstreamPath: 'skills/openspec-sync-specs/SKILL.md',
    description:
      "Merge an OpenSpec change's delta specs into the durable main specs file by file. " +
      'Use when the user wants the main specs updated without archiving.',
    whenToUse:
      'Use when the user asks to sync delta specs into main specs, or asks for opsx sync or ' +
      'opsx-sync.',
    body: SYNC_BODY,
  }),
  createFallbackSkill({
    workflow: 'archive',
    upstreamPath: 'skills/openspec-archive-change/SKILL.md',
    description:
      'Archive a completed OpenSpec change after validation and spec sync. ' +
      'Use when the user wants to finalize a change and move it into the archive.',
    whenToUse:
      'Use when the user asks to archive or finalize a completed change, or asks for opsx ' +
      'archive or opsx-archive.',
    body: ARCHIVE_BODY,
  }),
]);
