/**
 * Native fixture tests (tasks.md 1.13).
 *
 * Two fixture families, both read-only:
 * 1. the bundled upstream snapshot (`src/native-snapshot/spec-driven`) parsed and
 *    graphed against real files in this repository — stable artifact states;
 * 2. the sibling upstream-like `openspec/` tree that contains this plugin when
 *    present — stable task counts, delta counts and validation findings.
 *
 * Run: node --test --test-isolation=none tests/native-fixtures.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSchema } from '../src/native/schema.js'
import { computeArtifactStates, validateSchemaGraph } from '../src/native/graph.js'
import { parseProjectConfig } from '../src/native/config.js'
import { parseChangeMetadata } from '../src/native/metadata.js'
import { parseDeltaSpec } from '../src/native/spec.js'
import { parseTasks } from '../src/native/tasks.js'
import { validateChange } from '../src/native/validate.js'
import { computeWorkspaceState, validateChangeByName } from '../src/native/state.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(repoRoot, '..')
const snapshotSchemaPath = path.join(repoRoot, 'src', 'native-snapshot', 'spec-driven', 'schema.yaml')
const changeRel = 'openspec/changes/align-native-openspec'
const hasWorkspace = existsSync(path.join(workspaceRoot, 'openspec', 'changes'))

/** @param {string} rel @returns {string} */
function readWorkspace(rel) {
  return readFileSync(path.join(workspaceRoot, rel), 'utf8')
}

test('snapshot schema graph is valid and exposes the native apply contract', { skip: !existsSync(snapshotSchemaPath) }, () => {
  const { schema, issues } = parseSchema(readFileSync(snapshotSchemaPath, 'utf8'), {
    sourceName: 'native-snapshot/spec-driven/schema.yaml',
  })
  assert.deepEqual(issues, [])
  assert.equal(schema.name, 'spec-driven')
  const graph = validateSchemaGraph(schema)
  assert.deepEqual(graph.issues, [])
  assert.deepEqual([...graph.artifacts.keys()], ['proposal', 'specs', 'design', 'tasks'])
  assert.deepEqual(schema.apply.requires, ['tasks'])
  assert.equal(schema.apply.tracks, 'tasks.md')
})

test('snapshot schema against an empty change yields a stable ready/blocked chain', { skip: !existsSync(snapshotSchemaPath) }, async () => {
  const { schema } = parseSchema(readFileSync(snapshotSchemaPath, 'utf8'))
  const empty = await computeArtifactStates(repoRoot, 'tests/fixtures-empty-change', schema)
  assert.deepEqual(empty.artifacts, [
    { id: 'proposal', outputPath: 'proposal.md', status: 'ready' },
    { id: 'specs', outputPath: 'specs/**/*.md', status: 'blocked', missingDeps: ['proposal'] },
    { id: 'design', outputPath: 'design.md', status: 'blocked', missingDeps: ['proposal'] },
    { id: 'tasks', outputPath: 'tasks.md', status: 'blocked', missingDeps: ['specs', 'design'] },
  ])
  assert.deepEqual(empty.nextSteps, ['create proposal (proposal.md)'])
  assert.equal(empty.isPlanningComplete, false)
  const again = await computeArtifactStates(repoRoot, 'tests/fixtures-empty-change', schema)
  assert.deepEqual(again, empty)
})

test('an upstream-like completed change reaches planning completion with stable next steps', { skip: !existsSync(snapshotSchemaPath) }, async () => {
  // The plugin repo root acts as the change directory: its real files are the artifacts.
  const { schema } = parseSchema(
    [
      'name: fixture',
      'artifacts:',
      '  - id: proposal',
      '    generates: package.json',
      '  - id: specs',
      '    generates: src/native/*.js',
      '    requires: [proposal]',
      '  - id: design',
      '    generates: docs/native-module-contract.md',
      '    requires: [proposal]',
      '  - id: tasks',
      '    generates: tests/native-*.test.mjs',
      '    requires: [specs, design]',
      'apply:',
      '  requires: [tasks]',
      '  tracks: tests/native-*.test.mjs',
      '  instruction: Work through the checklist.',
    ].join('\n'),
  )
  assert.equal(validateSchemaGraph(schema).issues.length, 0)
  const state = await computeArtifactStates(repoRoot, '', schema)
  assert.deepEqual(
    state.artifacts.map((artifact) => artifact.status),
    ['done', 'done', 'done', 'done'],
  )
  assert.equal(state.isPlanningComplete, true)
  assert.deepEqual(state.applyRequires, ['tasks'])
  assert.equal(state.tracks, 'tests/native-*.test.mjs')
  assert.deepEqual(state.nextSteps, ['run apply on tests/native-*.test.mjs'])
})

test('real workspace: native config, metadata, deltas and tasks parse together', { skip: !hasWorkspace }, () => {
  const config = parseProjectConfig(readWorkspace('openspec/config.yaml'), 'config.yaml')
  assert.equal(config.found, true)
  assert.equal(config.schema, 'spec-driven')
  assert.equal(config.context.length > 0, true)

  const metadata = parseChangeMetadata(readWorkspace(`${changeRel}/.openspec.yaml`))
  assert.equal(metadata.error, null)
  assert.equal(metadata.value.schema, 'spec-driven')
  assert.match(metadata.value.created, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(typeof metadata.value.goal, 'string')

  const deltaFiles = [
    'native-opsx-model',
    'native-workflow-prompts',
    'openspec-panel',
    'openspec-skills-integration',
    'opsx-command-surface',
    'specs-sync-archive',
  ]
  let requirementTotal = 0
  for (const capability of deltaFiles) {
    const parsed = parseDeltaSpec(readWorkspace(`${changeRel}/specs/${capability}/spec.md`))
    assert.deepEqual(parsed.issues, [])
    assert.equal(parsed.operations.ADDED.length > 0, true)
    requirementTotal += parsed.operations.ADDED.length
  }
  assert.equal(requirementTotal, 34)

  const tasks = parseTasks(readWorkspace(`${changeRel}/tasks.md`))
  assert.equal(tasks.total, 57)
  assert.equal(tasks.items[0].id, '1.1')
  assert.equal(tasks.items[tasks.items.length - 1].id, '7.6')
})

test('real workspace: validation findings are empty and deterministic', { skip: !hasWorkspace }, () => {
  const proposalText = readWorkspace(`${changeRel}/proposal.md`)
  const deltaRelPaths = [
    'native-opsx-model',
    'native-workflow-prompts',
    'openspec-panel',
    'openspec-skills-integration',
    'opsx-command-surface',
    'specs-sync-archive',
  ]
  const deltas = deltaRelPaths.map((capability) => {
    const path = `specs/${capability}/spec.md`
    return { path, text: readWorkspace(`${changeRel}/${path}`) }
  })
  const input = {
    changeName: 'align-native-openspec',
    proposalText,
    deltas,
    tasksText: readWorkspace(`${changeRel}/tasks.md`),
    metadata: { found: true, ...parseChangeMetadata(readWorkspace(`${changeRel}/.openspec.yaml`)).value },
  }
  const first = validateChange(input)
  const second = validateChange(input)
  assert.deepEqual(first, second)
  assert.deepEqual(first.issues, [])
  assert.deepEqual(first.summary, { errors: 0, warnings: 0, infos: 0 })
})

test('real workspace: state and validate-by-name stay stable across runs', { skip: !hasWorkspace }, async () => {
  const state = await computeWorkspaceState(workspaceRoot)
  assert.equal(state.status, 'ready')
  const change = state.changes.find((candidate) => candidate.name === 'align-native-openspec')
  assert.ok(change)
  assert.equal(change.tasks.total, 57)
  assert.ok(change.tasks.done >= 0 && change.tasks.done <= change.tasks.total)
  assert.equal(change.delta.ADDED, 34)
  assert.equal(change.delta.MODIFIED, 0)
  assert.equal(change.delta.REMOVED, 0)
  assert.equal(change.delta.RENAMED, 0)
  assert.equal(change.validation.errors, 0)
  assert.equal(change.validation.warnings, 0)
  assert.equal(change.delta.files.length, 6)
  assert.equal(change.isPlanningComplete, true)

  const byName = await validateChangeByName(workspaceRoot, 'align-native-openspec')
  assert.equal(byName.validation.errors, 0)
  assert.equal(byName.tasks.total, 57)
  assert.equal(byName.deltas.length, 6)

  const secondState = await computeWorkspaceState(workspaceRoot)
  const secondByName = await validateChangeByName(workspaceRoot, 'align-native-openspec')
  assert.deepEqual(secondState, state)
  assert.deepEqual(secondByName, byName)
})
