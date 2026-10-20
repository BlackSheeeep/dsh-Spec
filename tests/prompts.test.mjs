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
  buildExplorePrompt,
  buildProposePrompt,
  buildUpdatePrompt,
  firstToken,
  restAfterFirstToken,
  slugify,
} from '../src/prompts.js'
import { SNAPSHOT_VERSION } from '../src/native/instruction.js'
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
    'buildExplorePrompt',
    'buildProposePrompt',
    'buildUpdatePrompt',
    'firstToken',
    'restAfterFirstToken',
    'slugify',
  ])
})

test('legacy phase APIs are gone: the engine owns tasks and state', () => {
  assert.ok(!('derivePhase' in promptsModule))
  assert.ok(!('parseTasks' in promptsModule))
  assert.ok(!('archivePrompt' in promptsModule), 'archive is deterministic and produces no model prompt')
  assert.ok(!('buildArchivePrompt' in promptsModule))
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
