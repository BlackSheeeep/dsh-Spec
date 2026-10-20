/**
 * Tests for the native instruction composer (src/native/instruction.js).
 *
 * The composer is exercised against the real bundled snapshot (no fixture
 * writes, no network): templates are read from `src/native-snapshot/` exactly
 * as the plugin does at runtime. Project schemas point at workspace paths that
 * do not exist, which is the intended "missing template" degradation.
 *
 * Run: node --test --test-isolation=none tests/instruction.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { SNAPSHOT_VERSION, composeArtifactPrompt, readNativeInstruction } from '../src/native/instruction.js'
import { loadBundledSchemas } from '../src/native/schema.js'

const CWD = fileURLToPath(new URL('..', import.meta.url))

/** Load the bundled `spec-driven` snapshot entry (`{schema, source:'builtin', dir}`). */
function bundledSpecDriven() {
  const entry = loadBundledSchemas().get('spec-driven')
  assert.ok(entry, 'the bundled spec-driven snapshot should load')
  return entry
}

/** A project-local resolution of the same schema definition. */
function projectSpecDriven() {
  const bundled = bundledSpecDriven()
  return {
    schema: { ...bundled.schema, name: 'spec-driven' },
    source: 'project',
    dir: 'openspec/schemas/spec-driven',
  }
}

/** A minimal in-memory project config. */
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

test('SNAPSHOT_VERSION pins the bundled upstream version', () => {
  assert.equal(SNAPSHOT_VERSION, '1.14.3')
})

test('bundled snapshot parses into the native spec-driven schema', () => {
  const entry = bundledSpecDriven()
  assert.equal(entry.source, 'builtin')
  assert.equal(entry.schema.name, 'spec-driven')
  assert.deepEqual(entry.schema.artifacts.map((artifact) => artifact.id), ['proposal', 'specs', 'design', 'tasks'])
  assert.equal(entry.schema.apply.tracks, 'tasks.md')
  assert.deepEqual(entry.schema.apply.requires, ['tasks'])
  assert.match(entry.schema.artifacts[0].instruction, /Create the proposal document/)
})

test('composeArtifactPrompt includes instruction, template, context, rules and output path', async () => {
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: 'proposal',
    config: config({
      context: 'This project uses Node 22 and plain ESM.',
      rules: { proposal: ['Keep the Why under 80 words.'], tasks: ['Never add dependencies.'] },
    }),
    changeName: 'add-dark-mode',
    dependsDone: [],
    intent: 'Add a dark mode toggle.',
  })
  assert.deepEqual(prompt.warnings, [])
  assert.match(prompt.text, /Create the proposal document that establishes WHY/)
  assert.match(prompt.text, /# Proposal/)
  assert.match(prompt.text, /This project uses Node 22 and plain ESM\./)
  assert.match(prompt.text, /Keep the Why under 80 words\./)
  assert.ok(!prompt.text.includes('Never add dependencies.'), 'rules for other artifacts must not leak in')
  assert.match(prompt.text, /openspec\/changes\/add-dark-mode\/proposal\.md/)
  assert.match(prompt.text, /Intent: Add a dark mode toggle\./)
  assert.match(prompt.text, /<phase_boundary>/)
})

test('composition follows the native order', async () => {
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: 'proposal',
    config: config({ context: 'Project context.', rules: { proposal: ['A proposal rule.'] } }),
    changeName: 'ordered-change',
  })
  const markers = [
    'Create the proposal document',
    'Output path:',
    '<context>',
    '<rules artifact="proposal">',
    '<template>',
    '<dependencies>',
    '<unlocks>',
    '<phase_boundary>',
    '<snapshot_note>',
  ]
  let previous = -1
  for (const marker of markers) {
    const index = prompt.text.indexOf(marker)
    assert.ok(index > previous, `expected "${marker}" after the previous section (order: ${markers.join(' → ')})`)
    previous = index
  }
})

test('context and rules are omitted when the project config does not define them', async () => {
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: 'design',
    config: config(),
    changeName: 'quiet-change',
  })
  assert.ok(!prompt.text.includes('<context>'))
  assert.ok(!prompt.text.includes('<rules'))
  assert.ok(!prompt.text.includes('Intent:'))
  assert.match(prompt.text, /# Design/)
})

test('dependency status reflects dependsDone', async () => {
  const missing = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: 'specs',
    config: config(),
    changeName: 'dep-change',
    dependsDone: [],
  })
  assert.match(missing.text, /<dependency id="proposal" status="missing">/)

  const done = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: 'specs',
    config: config(),
    changeName: 'dep-change',
    dependsDone: ['proposal'],
  })
  assert.match(done.text, /<dependency id="proposal" status="done">/)
  assert.match(done.text, /openspec\/changes\/dep-change\/proposal\.md/)
})

test('glob artifacts ask for a concrete path and dependencies are listed', async () => {
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: 'specs',
    config: config(),
    changeName: 'glob-change',
  })
  assert.match(prompt.text, /specs\/\*\*\/\*\.md/)
  assert.match(prompt.text, /choose one concrete file path inside the change folder/)
  assert.match(prompt.text, /Depends on: proposal/)
})

test('unlocks name the artifacts that depend on this one', async () => {
  const proposal = await composeArtifactPrompt({ cwd: CWD, schema: bundledSpecDriven(), artifact: 'proposal', changeName: 'unlocks-change' })
  assert.match(proposal.text, /Completing this artifact enables: specs/)
  assert.match(proposal.text, /<unlocks>/)

  const tasks = await composeArtifactPrompt({ cwd: CWD, schema: bundledSpecDriven(), artifact: 'tasks', changeName: 'unlocks-change' })
  assert.ok(!tasks.text.includes('<unlocks>'), 'nothing depends on tasks, so there is no unlocks section')
})

test('bundled snapshot composition appends one versioned fallback note', async () => {
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: 'proposal',
    changeName: 'fallback-change',
  })
  assert.match(prompt.text, /<snapshot_note>/)
  assert.match(prompt.text, /Snapshot fallback|bundled OpenSpec/i)
  assert.ok(prompt.text.includes(SNAPSHOT_VERSION))
  assert.equal(prompt.text.match(/<snapshot_note>/g).length, 1)
})

test('project schemas win over the snapshot and carry no fallback note', async () => {
  const projectSchema = projectSpecDriven()
  projectSchema.schema = {
    ...projectSchema.schema,
    artifacts: projectSchema.schema.artifacts.map((artifact) =>
      artifact.id === 'proposal' ? { ...artifact, instruction: 'PROJECT-SPECIFIC PROPOSAL INSTRUCTION' } : artifact,
    ),
  }
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: projectSchema,
    artifact: 'proposal',
    config: config(),
    changeName: 'project-change',
  })
  assert.match(prompt.text, /PROJECT-SPECIFIC PROPOSAL INSTRUCTION/)
  assert.ok(!prompt.text.includes('Create the proposal document that establishes WHY'))
  assert.ok(!prompt.text.includes('<snapshot_note>'))
  // The project schema directory does not exist in this workspace, so the
  // missing template degrades to a warning instead of a failure.
  assert.ok(prompt.warnings.length >= 1)
  assert.match(prompt.warnings.join('\n'), /template 'proposal\.md' was not found/)
})

test('unknown schema falls back to the bundled snapshot with a note', async () => {
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: {},
    artifact: 'proposal',
    changeName: 'unknown-schema-change',
  })
  assert.match(prompt.text, /Create the proposal document/)
  assert.match(prompt.text, /<snapshot_note>/)
  assert.ok(prompt.text.includes(SNAPSHOT_VERSION))
})

test('apply artifact composition uses the schema apply contract', async () => {
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: 'apply',
    config: config(),
    changeName: 'apply-change',
    dependsDone: ['tasks'],
  })
  assert.match(prompt.text, /Read context files, work through pending tasks/)
  assert.match(prompt.text, /openspec\/changes\/apply-change\/tasks\.md/)
  assert.match(prompt.text, /Implementation phase/)
  assert.match(prompt.text, /<dependency id="tasks" status="done">/)
})

test('a supplied artifact definition is composed even when not in the schema', async () => {
  const prompt = await composeArtifactPrompt({
    cwd: CWD,
    schema: bundledSpecDriven(),
    artifact: { id: 'custom', generates: 'custom.md', template: '', instruction: 'CUSTOM ARTIFACT INSTRUCTION', requires: [], description: '' },
    changeName: 'custom-change',
  })
  assert.match(prompt.text, /CUSTOM ARTIFACT INSTRUCTION/)
  assert.match(prompt.text, /openspec\/changes\/custom-change\/custom\.md/)
})

test('unknown artifacts are rejected with a clear error', async () => {
  await assert.rejects(
    composeArtifactPrompt({ cwd: CWD, schema: bundledSpecDriven(), artifact: 'not-an-artifact', changeName: 'x' }),
    /not found in schema/,
  )
})

test('bare schema definitions still resolve their templates and fallback note', async () => {
  // The host route passes `resolveSchema(...).schema` (the bare definition);
  // the composer recovers the snapshot origin/template location from it.
  const bareWithVersion = { ...bundledSpecDriven().schema, sourceVersion: SNAPSHOT_VERSION }
  const withVersion = await composeArtifactPrompt({
    cwd: CWD,
    schema: bareWithVersion,
    artifact: 'proposal',
    changeName: 'bare-change',
  })
  assert.deepEqual(withVersion.warnings, [])
  assert.match(withVersion.text, /# Proposal/)
  assert.match(withVersion.text, /<snapshot_note>/)

  const bareWithoutVersion = bundledSpecDriven().schema
  const withoutVersion = await composeArtifactPrompt({
    cwd: CWD,
    schema: bareWithoutVersion,
    artifact: 'design',
    changeName: 'bare-change',
  })
  assert.match(withoutVersion.text, /# Design/)
  assert.match(withoutVersion.text, /<snapshot_note>/)
})

test('readNativeInstruction reads instructions from resolved, bare and named schemas', async () => {
  const resolved = await readNativeInstruction(CWD, bundledSpecDriven(), 'proposal')
  assert.match(resolved, /Create the proposal document/)

  const bare = await readNativeInstruction(CWD, bundledSpecDriven().schema, 'tasks')
  assert.match(bare, /Create the task list/)

  const byName = await readNativeInstruction(CWD, 'spec-driven', 'design')
  assert.match(byName, /Create the design document/)

  const apply = await readNativeInstruction(CWD, bundledSpecDriven(), 'apply')
  assert.match(apply, /Read context files/)

  assert.equal(await readNativeInstruction(CWD, bundledSpecDriven(), 'nope'), '')
  assert.equal(await readNativeInstruction(CWD, 'no-such-schema', 'proposal'), '')
})
