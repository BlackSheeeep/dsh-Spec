/**
 * Tests for the native workflow prompt builders (src/prompts.js).
 *
 * These tests are pure besides reading the bundled snapshot templates: they
 * pass in-memory ChangeState/config objects, exactly like the command layer
 * does, and never write a file or touch the network.
 *
 * Run: node --test --test-isolation=none tests/prompts.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import * as promptsModule from '../src/prompts.js'
import {
  buildApplyPrompt,
  buildArchiveWorkflowPrompt,
  buildExplorePrompt,
  buildProposePrompt,
  buildSyncWorkflowPrompt,
  buildUpdatePrompt,
  firstToken,
  restAfterFirstToken,
  slugify,
} from '../src/prompts.js'
import { SNAPSHOT_VERSION } from '../src/native/instruction.js'
import { ADAPTATION_MARKER } from '../src/native/skill-adaptation.js'
import { loadBundledSchemas } from '../src/native/schema.js'

const CWD = fileURLToPath(new URL('..', import.meta.url))

/** The bundled snapshot resolution (`{schema, source:'builtin', dir}`). */
function bundledSpecDriven() {
  const entry = loadBundledSchemas().get('spec-driven')
  assert.ok(entry, 'the bundled spec-driven snapshot should load')
  return entry
}

/** A minimal ChangeState row helper (shape per docs/native-module-contract.md §4). */
function artifactRow(id, status, extra = {}) {
  return { id, status, outputPath: `openspec/changes/add-dark-mode/${id === 'specs' ? 'specs' : id}`, ...extra }
}

/** Full ChangeState fixture; artifacts default to a fresh, unplanned change. */
function changeState(artifacts, overrides = {}) {
  return {
    name: 'add-dark-mode',
    schemaName: 'spec-driven',
    schemaSource: 'builtin',
    metadata: { found: true, schema: 'spec-driven', created: '2026-10-20', goal: 'add dark mode', skip_specs: false, retire_capabilities: false },
    artifacts:
      artifacts ??
      [
        artifactRow('proposal', 'ready'),
        artifactRow('specs', 'blocked', { missingDeps: ['proposal'] }),
        artifactRow('design', 'blocked', { missingDeps: ['proposal'] }),
        artifactRow('tasks', 'blocked', { missingDeps: ['specs', 'design'] }),
      ],
    applyRequires: ['tasks'],
    tracks: 'tasks.md',
    isPlanningComplete: false,
    nextSteps: [],
    listStatus: 'no-tasks',
    tasks: null,
    docs: [],
    delta: { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] },
    validation: { errors: 0, warnings: 0, infos: 0, issues: [] },
    files: [],
    ...overrides,
  }
}

/** A fully planned change whose only missing artifact is `tasks.md`. */
function applyReadyChange(overrides = {}) {
  return changeState(
    [artifactRow('proposal', 'done'), artifactRow('specs', 'done'), artifactRow('design', 'done'), artifactRow('tasks', 'ready')],
    { tasks: { total: 5, done: 2 }, listStatus: 'in-progress', ...overrides },
  )
}

/** A minimal project config. */
function config(overrides = {}) {
  return {
    found: true,
    file: 'config.yaml',
    schema: 'spec-driven',
    context: '',
    rules: {},
    operations: {},
    warnings: [],
    ...overrides,
  }
}

test('prompt builders expose exactly the contract surface', () => {
  assert.deepEqual(Object.keys(promptsModule).sort(), [
    'buildApplyPrompt',
    'buildArchiveWorkflowPrompt',
    'buildExplorePrompt',
    'buildProposePrompt',
    'buildSyncWorkflowPrompt',
    'buildUpdatePrompt',
    'firstToken',
    'restAfterFirstToken',
    'slugify',
  ])
})

test('legacy phase APIs are gone: the engine owns tasks and state', () => {
  assert.ok(!('derivePhase' in promptsModule))
  assert.ok(!('parseTasks' in promptsModule))
  assert.ok(!('archivePrompt' in promptsModule))
  assert.ok(!('buildArchivePrompt' in promptsModule))
  // sync / archive now default to the vendored OPSX AI workflows.
  assert.equal(typeof buildSyncWorkflowPrompt, 'function')
  assert.equal(typeof buildArchiveWorkflowPrompt, 'function')
})

test('slugify produces kebab change names and rejects junk', () => {
  assert.equal(slugify('Add Dark Mode!'), 'add-dark-mode')
  assert.equal(slugify('  已有 中文  '), '')
  assert.equal(slugify('add-rate-limiting'), 'add-rate-limiting')
})

test('firstToken and restAfterFirstToken split raw command input', () => {
  assert.equal(firstToken('add-dark-mode 支持深色主题'), 'add-dark-mode')
  assert.equal(restAfterFirstToken('add-dark-mode 支持深色主题'), '支持深色主题')
  assert.equal(firstToken('  solo  '), 'solo')
  assert.equal(restAfterFirstToken('solo'), '')
})

test('explore is read-only and carries project context', async () => {
  const prompt = await buildExplorePrompt({ cwd: CWD, topic: 'dark mode options', config: config({ context: 'Node 22 project.' }) })
  assert.match(prompt, /Topic: dark mode options/)
  assert.match(prompt, /READ-ONLY/)
  assert.match(prompt, /do NOT write, modify or create any file/i)
  assert.match(prompt, /Node 22 project\./)
  assert.match(prompt, /\/opsx-propose/)
  assert.ok(!prompt.includes('Create the proposal document'), 'explore must not compose artifact instructions')
  assert.match(prompt, /<context>/)
})

test('explore omits the context block when the project defines no context', async () => {
  const prompt = await buildExplorePrompt({ cwd: CWD, topic: '', config: config() })
  assert.ok(!prompt.includes('<context>'))
  assert.match(prompt, /help me choose what to work on next/)
})

test('propose composes every planning artifact in schema order and stops at the plan', async () => {
  const prompt = await buildProposePrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    intent: 'Add a dark mode toggle',
    schema: bundledSpecDriven(),
    config: config({ context: 'Node 22 project.' }),
    change: changeState(),
  })
  const markers = [
    'Create the proposal document',
    '### 2. specs — write after: proposal',
    'Create specification files',
    '### 3. design — write after: proposal',
    'Create the design document',
    '### 4. tasks — write after: specs, design',
    'Create the task list',
  ]
  let previous = -1
  for (const marker of markers) {
    const index = prompt.indexOf(marker)
    assert.ok(index > previous, `expected "${marker}" in schema order`)
    previous = index
  }
  assert.match(prompt, /### 1\. proposal — ready now/)
  assert.match(prompt, /Intent: Add a dark mode toggle/)
  assert.match(prompt, /Planning boundary/)
  assert.match(prompt, /### Stop boundary/)
  assert.match(prompt, /Do not start implementation/)
  assert.match(prompt, /\/opsx-apply add-dark-mode/)
  assert.match(prompt, /Node 22 project\./)
  assert.equal(prompt.match(/<context>/g).length, 1, 'project context is injected once, not once per artifact')
  assert.ok(prompt.includes(SNAPSHOT_VERSION), 'the bundled-snapshot fallback note names the pinned version')
  assert.match(prompt, /bundled OpenSpec snapshot/)
})

test('propose excludes skipped artifacts and offers the rest', async () => {
  const prompt = await buildProposePrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState([
      artifactRow('proposal', 'done'),
      artifactRow('specs', 'skipped'),
      artifactRow('design', 'done'),
      artifactRow('tasks', 'ready'),
    ], { metadata: { found: true, schema: 'spec-driven', skip_specs: true } }),
  })
  assert.match(prompt, /Create the task list/)
  assert.ok(!prompt.includes('Create specification files'), 'a skipped artifact is not offered for creation')
  assert.match(prompt, /skip_specs/)
  assert.match(prompt, /Already satisfied/)
  assert.match(prompt, /do NOT create files for it/)
})

test('propose does not offer blocked artifacts whose dependencies cannot be planned', async () => {
  const prompt = await buildProposePrompt({
    cwd: CWD,
    changeName: 'blocked-change',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState(
      [
        artifactRow('proposal', 'blocked', { missingDeps: ['ghost-artifact'] }),
        artifactRow('specs', 'blocked', { missingDeps: ['proposal'] }),
        artifactRow('design', 'blocked', { missingDeps: ['proposal'] }),
        artifactRow('tasks', 'blocked', { missingDeps: ['specs', 'design'] }),
      ],
      { name: 'blocked-change' },
    ),
  })
  assert.ok(!prompt.includes('Create the proposal document'))
  assert.ok(!prompt.includes('Create specification files'))
  assert.match(prompt, /No planning artifact/)
  assert.match(prompt, /blocked by ghost-artifact/)
})

test('propose reports when the plan is already complete', async () => {
  const prompt = await buildProposePrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState([
      artifactRow('proposal', 'done'),
      artifactRow('specs', 'done'),
      artifactRow('design', 'done'),
      artifactRow('tasks', 'done'),
    ], { isPlanningComplete: true }),
  })
  assert.match(prompt, /already exist or are skipped/)
  assert.match(prompt, /\/opsx-apply add-dark-mode/)
  assert.ok(!prompt.includes('Create the proposal document'))
})

test('propose filters rules to the artifacts being written', async () => {
  const prompt = await buildProposePrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config({
      rules: {
        proposal: ['PROPOSAL-RULE'],
        specs: ['SPECS-RULE'],
        tasks: ['TASKS-RULE'],
        apply: ['APPLY-RULE'],
        archive: ['ARCHIVE-RULE'],
      },
    }),
    change: changeState(),
  })
  assert.match(prompt, /PROPOSAL-RULE/)
  assert.match(prompt, /SPECS-RULE/)
  assert.match(prompt, /TASKS-RULE/)
  assert.ok(!prompt.includes('APPLY-RULE'), 'apply rules only belong in apply')
  assert.ok(!prompt.includes('ARCHIVE-RULE'))
})

test('project schema wins over the bundled snapshot in propose', async () => {
  const bundled = bundledSpecDriven()
  const projectDefinition = {
    ...bundled.schema,
    artifacts: bundled.schema.artifacts.map((artifact) =>
      artifact.id === 'proposal' ? { ...artifact, instruction: 'PROJECT PROPOSAL INSTRUCTION' } : artifact,
    ),
  }
  const prompt = await buildProposePrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: { schema: projectDefinition, source: 'project', dir: 'openspec/schemas/spec-driven' },
    config: config(),
    change: changeState(),
  })
  assert.match(prompt, /PROJECT PROPOSAL INSTRUCTION/)
  assert.ok(!prompt.includes('Create the proposal document that establishes WHY'))
  assert.ok(!prompt.includes('bundled OpenSpec snapshot'), 'a project schema must not produce the fallback note')
})

test('propose degrades to schema-derived states when no ChangeState is passed', async () => {
  const prompt = await buildProposePrompt({
    cwd: CWD,
    changeName: 'fresh-change',
    schema: bundledSpecDriven(),
    config: config(),
    change: null,
  })
  assert.match(prompt, /Create the proposal document/)
  assert.match(prompt, /Create the task list/)
})

test('apply carries the apply instruction, tracking file, context, rules and guidance', async () => {
  const prompt = await buildApplyPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config({
      context: 'Node 22 project.',
      rules: { apply: ['Run npm test before ticking.'] },
      operations: { apply: { guidance: 'Prefer small commits.' } },
    }),
    change: applyReadyChange(),
  })
  assert.match(prompt, /Read context files, work through pending tasks/)
  assert.match(prompt, /openspec\/changes\/add-dark-mode\/tasks\.md/)
  assert.match(prompt, /2\/5 checked/)
  assert.match(prompt, /Node 22 project\./)
  assert.match(prompt, /Run npm test before ticking\./)
  assert.match(prompt, /Prefer small commits\./)
  assert.match(prompt, /Operation guidance \(advisory\)/)
  assert.match(prompt, /### Apply contract/)
  assert.match(prompt, /first unchecked task/)
  assert.match(prompt, /change its checkbox to `- \[x\]` immediately/)
  assert.equal(prompt.match(/<context>/g).length, 1)
})

test('apply omits operation guidance when the project config defines none', async () => {
  const prompt = await buildApplyPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: applyReadyChange(),
  })
  assert.ok(!prompt.includes('Operation guidance'))
})

test('apply accepts a pre-composed instruction and still adds context and rules', async () => {
  const prompt = await buildApplyPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config({ context: 'Node 22 project.', rules: { apply: ['APPLY-RULE'] } }),
    change: applyReadyChange(),
    artifactPrompt: 'CUSTOM APPLY INSTRUCTION',
  })
  assert.match(prompt, /CUSTOM APPLY INSTRUCTION/)
  assert.match(prompt, /Node 22 project\./)
  assert.match(prompt, /APPLY-RULE/)
  assert.match(prompt, /### Apply contract/)
})

test('apply reports blocked prerequisites and missing task data without throwing', async () => {
  const blocked = await buildApplyPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState([
      artifactRow('proposal', 'done'),
      artifactRow('specs', 'done'),
      artifactRow('design', 'done'),
      artifactRow('tasks', 'ready'),
    ]),
  })
  assert.match(blocked, /### Blocked: missing planning artifacts/)
  assert.match(blocked, /tasks: not created yet/)
  assert.match(blocked, /Read the tracking file in the change folder/)

  const noTasks = await buildApplyPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: applyReadyChange({ tasks: { total: 0, done: 0 } }),
  })
  assert.match(noTasks, /no tasks recorded yet/)
})

test('update is planning-only, lists existing artifacts and points to apply', async () => {
  const prompt = await buildUpdatePrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config({ context: 'Node 22 project.' }),
    change: changeState([
      artifactRow('proposal', 'done'),
      artifactRow('specs', 'done'),
      artifactRow('design', 'ready', { missingDeps: ['proposal'] }),
      artifactRow('tasks', 'done'),
    ]),
    intent: 'Switch the toggle to a segmented control.',
  })
  assert.match(prompt, /### Existing planning artifacts/)
  assert.match(prompt, /proposal: openspec\/changes\/add-dark-mode\/proposal/)
  assert.match(prompt, /task progress lives here/)
  assert.match(prompt, /NEVER edit product code/)
  assert.match(prompt, /Planning artifacts only/)
  assert.match(prompt, /User revision request:\nSwitch the toggle to a segmented control\./)
  assert.match(prompt, /Node 22 project\./)
  assert.match(prompt, /\/opsx-apply add-dark-mode/)
  assert.match(prompt, /### Not editable here/)
  assert.match(prompt, /design: not created yet \(ready\)/)
  assert.match(prompt, /### Phase boundary/)
})

test('update leaves skipped artifacts untouched', async () => {
  const prompt = await buildUpdatePrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState([
      artifactRow('proposal', 'done'),
      artifactRow('specs', 'skipped'),
      artifactRow('design', 'done'),
      artifactRow('tasks', 'done'),
    ]),
  })
  assert.match(prompt, /skip_specs/)
  assert.match(prompt, /leave it untouched/)
})

test('all four builders inject the project context when present', async () => {
  const CONTEXT = 'SHARED-PROJECT-CONTEXT: use pnpm, plain ESM.'
  const prompts = await Promise.all([
    buildExplorePrompt({ cwd: CWD, config: config({ context: CONTEXT }) }),
    buildProposePrompt({ cwd: CWD, changeName: 'add-dark-mode', schema: bundledSpecDriven(), config: config({ context: CONTEXT }), change: changeState() }),
    buildApplyPrompt({ cwd: CWD, changeName: 'add-dark-mode', schema: bundledSpecDriven(), config: config({ context: CONTEXT }), change: applyReadyChange() }),
    buildUpdatePrompt({
      cwd: CWD,
      changeName: 'add-dark-mode',
      schema: bundledSpecDriven(),
      config: config({ context: CONTEXT }),
      change: changeState([artifactRow('proposal', 'done'), artifactRow('specs', 'done'), artifactRow('design', 'done'), artifactRow('tasks', 'done')]),
    }),
  ])
  for (const prompt of prompts) {
    assert.match(prompt, /<context>/)
    assert.ok(prompt.includes(CONTEXT), 'every workflow prompt must carry the project context')
  }
})

test('phase boundaries stay native', async () => {
  const [explore, propose, apply, update] = await Promise.all([
    buildExplorePrompt({ cwd: CWD, config: config() }),
    buildProposePrompt({ cwd: CWD, changeName: 'add-dark-mode', schema: bundledSpecDriven(), config: config(), change: changeState() }),
    buildApplyPrompt({ cwd: CWD, changeName: 'add-dark-mode', schema: bundledSpecDriven(), config: config(), change: applyReadyChange() }),
    buildUpdatePrompt({
      cwd: CWD,
      changeName: 'add-dark-mode',
      schema: bundledSpecDriven(),
      config: config(),
      change: changeState([artifactRow('proposal', 'done'), artifactRow('specs', 'done'), artifactRow('design', 'done'), artifactRow('tasks', 'done')]),
    }),
  ])
  assert.match(explore, /READ-ONLY/)
  assert.match(propose, /Planning boundary/)
  assert.match(propose, /Do not start implementation/)
  assert.match(apply, /### Apply contract/)
  assert.match(apply, /tick|checkbox/i)
  assert.match(update, /NEVER edit product code/)
  assert.match(update, /\/opsx-apply/)
})

/* ------------------------------------------------------------------ *
 * OPSX sync / archive AI workflow prompts (§10.4)
 * ------------------------------------------------------------------ */

/** One engine-derived workflow facts fixture (§10.4 shape), overridable per test. */
function workflowFacts(overrides = {}) {
  return {
    validation: {
      errors: 0,
      warnings: 1,
      infos: 0,
      issues: [{ level: 'WARNING', path: 'tasks.md', line: 2, message: 'task numbering gap' }],
    },
    artifacts: [
      { id: 'proposal', status: 'done' },
      { id: 'specs', status: 'done' },
      { id: 'design', status: 'ready' },
      { id: 'tasks', status: 'done' },
    ],
    tasks: { total: 5, done: 2, pending: ['1.2 build parser', '2 write tests'] },
    deltas: [
      {
        path: 'openspec/changes/add-dark-mode/specs/theme/spec.md',
        capability: 'theme',
        added: 1,
        modified: 1,
        removed: 0,
        renamed: 0,
      },
    ],
    mainSpecs: [
      { path: 'openspec/specs/theme/spec.md', capability: 'theme', exists: true, requirementCount: 3 },
      { path: 'openspec/specs/brand/spec.md', capability: 'brand', exists: false, requirementCount: 0 },
    ],
    isPlanningComplete: true,
    archiveTarget: 'openspec/changes/archive/2026-10-20-add-dark-mode',
    archiveTargetExists: false,
    ...overrides,
  }
}

/** Prompt text from a heading marker to the end (for finish-contract assertions). */
function fromMarker(prompt, marker) {
  const index = prompt.indexOf(marker)
  assert.ok(index >= 0, `expected the prompt to contain "${marker}"`)
  return prompt.slice(index)
}

test('sync workflow prompt embeds the real adapted OPSX skill, facts and the sync finish contract', async () => {
  const prompt = await buildSyncWorkflowPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState(
      [artifactRow('proposal', 'done'), artifactRow('specs', 'done'), artifactRow('design', 'done'), artifactRow('tasks', 'ready')],
      { isPlanningComplete: true, tasks: { total: 5, done: 2 }, listStatus: 'in-progress' },
    ),
    facts: workflowFacts(),
  })

  // Adapted vendored body: the real snapshot is read through skill-adaptation.js.
  assert.ok(prompt.includes(ADAPTATION_MARKER), 'the adapted skill body carries the DSH adaptation marker')
  assert.match(prompt, /Fission-AI\/OpenSpec/)
  assert.match(prompt, /### Vendored workflow: openspec-sync-specs/)
  assert.match(prompt, /### End of vendored workflow/)

  // Header + facts.
  assert.match(prompt, /## OPSX sync workflow — merge the deltas of "add-dark-mode" into the main specs/)
  assert.match(prompt, /Change: add-dark-mode/)
  assert.match(prompt, /Schema: spec-driven \(bundled snapshot schema/)
  assert.match(prompt, /Workspace: openspec\/changes\/add-dark-mode/)
  assert.match(prompt, /Created: 2026-10-20/)
  assert.match(prompt, /Goal: add dark mode/)
  assert.match(prompt, /## Current facts/)
  assert.match(prompt, /Validation: 0 ERROR \/ 1 WARNING \/ 0 INFO/)
  assert.match(prompt, /- \[WARNING\] tasks\.md:2 — task numbering gap/)
  assert.match(prompt, /- proposal: done/)
  assert.match(prompt, /- specs: done/)
  assert.match(prompt, /- tasks: done/)
  assert.match(prompt, /2\/5 checked, 2 pending/)
  assert.match(prompt, /- 1\.2 build parser/)
  assert.match(prompt, /- 2 write tests/)
  assert.match(
    prompt,
    /openspec\/changes\/add-dark-mode\/specs\/theme\/spec\.md — capability theme: ADDED 1, MODIFIED 1, REMOVED 0, RENAMED 0/,
  )
  assert.match(prompt, /openspec\/specs\/theme\/spec\.md — exists, 3 requirements/)
  assert.match(prompt, /openspec\/specs\/brand\/spec\.md — does not exist yet, 0 requirements/)
  assert.match(prompt, /Planning complete: yes/)
  assert.ok(!prompt.includes('Archive target:'), 'the sync prompt does not render the archive target facts')

  // Finish contract: error gate → intelligent merge → canonical verification → validate.
  const finish = fromMarker(prompt, '## Finish contract (sync)')
  assert.match(finish, /validation\.errors > 0/)
  assert.match(finish, /STOP/)
  assert.match(finish, /ask the user to confirm/)
  assert.match(finish, /intelligent merge/i)
  assert.match(finish, /`openspec\/specs\/<capability>\/spec\.md`/)
  assert.match(finish, /## ADDED Requirements/)
  assert.match(finish, /## MODIFIED Requirements/)
  assert.match(finish, /## REMOVED Requirements/)
  assert.match(finish, /## RENAMED Requirements/)
  assert.match(finish, /### Requirement: <name>/)
  assert.match(finish, /#### Scenario: <name>/)
  assert.match(finish, /`## Purpose`/)
  assert.match(finish, /run `\/opsx-validate`/)
  assert.match(finish, /Do not archive the change/)
  assert.ok(finish.includes('/opsx-archive add-dark-mode'), 'sync finish contract points at the separate archive workflow')
  assert.ok(!finish.includes('--yes --skip-specs'), 'sync never uses the deterministic archive finalize command')
})

test('archive workflow prompt embeds completion facts and the deterministic finalize contract', async () => {
  const prompt = await buildArchiveWorkflowPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState(
      [artifactRow('proposal', 'done'), artifactRow('specs', 'done'), artifactRow('design', 'ready'), artifactRow('tasks', 'done')],
      { isPlanningComplete: false, tasks: { total: 5, done: 2 }, listStatus: 'in-progress' },
    ),
    facts: workflowFacts({ isPlanningComplete: false }),
  })

  assert.ok(prompt.includes(ADAPTATION_MARKER))
  assert.match(prompt, /### Vendored workflow: openspec-archive-change/)
  assert.match(prompt, /## OPSX archive workflow — confirm, sync and archive the change "add-dark-mode"/)
  assert.match(prompt, /## Current facts/)
  assert.match(prompt, /- proposal: done/)
  assert.match(prompt, /- design: ready/)
  assert.match(prompt, /2\/5 checked, 2 pending/)
  assert.match(prompt, /- 1\.2 build parser/)
  assert.match(prompt, /- openspec\/changes\/add-dark-mode\/specs\/theme\/spec\.md — capability theme/)
  assert.match(prompt, /openspec\/specs\/brand\/spec\.md — does not exist yet, 0 requirements/)
  assert.match(prompt, /Planning complete: no/)
  assert.match(prompt, /Archive target: openspec\/changes\/archive\/2026-10-20-add-dark-mode/)
  assert.match(prompt, /Archive target exists: no/)

  // Finish contract: confirm → stop on ERROR or an existing target → merge or
  // skip → validate → deterministic finalize.
  const finish = fromMarker(prompt, '## Finish contract (archive)')
  assert.match(finish, /ask the user to confirm/)
  assert.match(finish, /validation\.errors > 0/)
  assert.match(finish, /Validation: N ERROR/)
  assert.match(finish, /Archive target exists: yes/)
  assert.match(finish, /STOP/)
  assert.match(finish, /do not merge specs/)
  assert.match(finish, /do not move or archive the change/)
  assert.match(finish, /`\/opsx-archive <name> --yes`/)
  assert.match(finish, /Intelligent merge/i)
  assert.match(finish, /Skip sync/)
  assert.ok(finish.includes('leave `openspec/specs/**` untouched'))
  assert.match(finish, /run `\/opsx-validate`/)
  assert.match(finish, /Finalize deterministically/)
  assert.ok(finish.includes('/opsx-archive add-dark-mode --yes --skip-specs'), 'archive finish contract names the exact finalize command')
  assert.match(finish, /only moves the change directory/)
})

test('archive workflow prompt stops on an existing archive target before any write', async () => {
  const collisionTarget = 'openspec/changes/archive/2026-10-20-add-dark-mode'
  const prompt = await buildArchiveWorkflowPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState([artifactRow('proposal', 'done')]),
    facts: workflowFacts({ archiveTarget: collisionTarget, archiveTargetExists: true }),
  })

  // The collision is a current fact...
  assert.match(prompt, /Archive target: openspec\/changes\/archive\/2026-10-20-add-dark-mode/)
  assert.match(prompt, /Archive target exists: yes/)

  // ...and a write-blocking STOP gate, parallel to the validation-ERROR gate.
  const finish = fromMarker(prompt, '## Finish contract (archive)')
  assert.match(finish, /Validation: N ERROR/)
  assert.match(finish, /validation\.errors > 0/)
  assert.match(finish, /Archive target exists: yes/)
  assert.match(finish, /do not merge specs/)
  assert.match(finish, /do not move or archive the change/)
  assert.match(finish, /do not overwrite already-archived content/)
  assert.match(finish, /`\/opsx-archive <name> --yes`/)
  assert.match(finish, /deterministic finalize command/)
})

test('sync and archive workflow prompts include context, rules and operation guidance only when configured', async () => {
  const configured = config({
    context: 'SHARED-CONTEXT for the workflows.',
    rules: { sync: ['SYNC-RULE'], archive: ['ARCHIVE-RULE'] },
    operations: {
      sync: { guidance: 'SYNC-GUIDANCE: prefer minimal spec diffs.' },
      archive: { guidance: 'ARCHIVE-GUIDANCE: confirm before moving.' },
      apply: { guidance: 'APPLY-GUIDANCE: not part of these workflows.' },
    },
  })
  const change = changeState([artifactRow('proposal', 'done')])
  const [syncPrompt, archivePrompt] = await Promise.all([
    buildSyncWorkflowPrompt({ cwd: CWD, changeName: 'add-dark-mode', schema: bundledSpecDriven(), config: configured, change, facts: workflowFacts() }),
    buildArchiveWorkflowPrompt({ cwd: CWD, changeName: 'add-dark-mode', schema: bundledSpecDriven(), config: configured, change, facts: workflowFacts() }),
  ])

  for (const prompt of [syncPrompt, archivePrompt]) {
    assert.ok(prompt.includes('<context>'))
    assert.ok(prompt.includes('SHARED-CONTEXT for the workflows.'))
  }
  assert.ok(syncPrompt.includes('<rules artifact="sync">'))
  assert.ok(syncPrompt.includes('SYNC-RULE'))
  assert.ok(syncPrompt.includes('SYNC-GUIDANCE: prefer minimal spec diffs.'))
  assert.ok(!syncPrompt.includes('ARCHIVE-RULE'))
  assert.ok(!syncPrompt.includes('ARCHIVE-GUIDANCE'))
  assert.ok(!syncPrompt.includes('APPLY-GUIDANCE'))

  assert.ok(archivePrompt.includes('<rules artifact="archive">'))
  assert.ok(archivePrompt.includes('ARCHIVE-RULE'))
  assert.ok(archivePrompt.includes('ARCHIVE-GUIDANCE: confirm before moving.'))
  assert.ok(!archivePrompt.includes('SYNC-RULE'))
  assert.ok(!archivePrompt.includes('SYNC-GUIDANCE'))
  assert.ok(!archivePrompt.includes('APPLY-GUIDANCE'))
})

test('sync and archive workflow prompts omit context, rules and guidance when unconfigured', async () => {
  const [syncPrompt, archivePrompt] = await Promise.all([
    buildSyncWorkflowPrompt({ cwd: CWD, changeName: 'add-dark-mode', schema: bundledSpecDriven(), config: config(), facts: workflowFacts() }),
    buildArchiveWorkflowPrompt({ cwd: CWD, changeName: 'add-dark-mode', schema: bundledSpecDriven(), config: config(), facts: workflowFacts() }),
  ])
  for (const prompt of [syncPrompt, archivePrompt]) {
    assert.ok(!prompt.includes('<context>'), 'no <context> block without project context')
    assert.ok(!prompt.includes('<rules'), 'no <rules> block without project rules')
    assert.ok(!prompt.includes('### Operation guidance'))
  }
})

test('workflow prompts surface the change metadata flags', async () => {
  const prompt = await buildArchiveWorkflowPrompt({
    changeName: 'retire-me',
    schema: bundledSpecDriven(),
    config: config(),
    change: changeState([], {
      name: 'retire-me',
      metadata: {
        found: true,
        schema: 'spec-driven',
        created: '2026-10-20',
        goal: 'retire the old capability',
        skip_specs: true,
        retire_capabilities: true,
      },
    }),
    facts: workflowFacts(),
  })
  assert.match(prompt, /Created: 2026-10-20/)
  assert.match(prompt, /Goal: retire the old capability/)
  assert.match(prompt, /Skip specs: yes/)
  assert.match(prompt, /Retire capabilities: yes/)
})

test('sync and archive workflow prompts tolerate missing facts, schema and change data', async () => {
  const syncPrompt = await buildSyncWorkflowPrompt({ cwd: CWD, changeName: 'lonely-change' })
  assert.match(syncPrompt, /## Current facts/)
  assert.match(syncPrompt, /Validation: 0 ERROR \/ 0 WARNING \/ 0 INFO/)
  assert.match(syncPrompt, /- no validation issues/)
  assert.match(syncPrompt, /- none \(the change has no tasks file yet\)/)
  assert.match(syncPrompt, /- none \(there are no delta specs to merge\)/)
  assert.match(syncPrompt, /Planning complete: no/)
  assert.match(syncPrompt, /Schema: unknown/)

  const archivePrompt = await buildArchiveWorkflowPrompt({ change: changeState([], { name: 'fallback-change' }) })
  assert.match(archivePrompt, /Change: fallback-change/)
  assert.match(archivePrompt, /Archive target: openspec\/changes\/archive\/<local-date>-<change-name>/)
  assert.match(archivePrompt, /## Finish contract \(archive\)/)
  assert.ok(archivePrompt.includes('/opsx-archive fallback-change --yes --skip-specs'))
})

test('workflow prompts accept a bare schema definition', async () => {
  const bare = bundledSpecDriven().schema
  const prompt = await buildSyncWorkflowPrompt({
    cwd: CWD,
    changeName: 'add-dark-mode',
    schema: bare,
    config: config(),
    facts: workflowFacts(),
  })
  // A bare definition carries no resolution source; the header still names the schema.
  assert.match(prompt, /Schema: spec-driven \(unknown source\)/)
  assert.match(prompt, /### Vendored workflow: openspec-sync-specs/)
})

