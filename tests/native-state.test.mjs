/**
 * Tests for src/native/state.js.
 *
 * The sandbox forbids writing fixtures, so the "uninitialized workspace" cases
 * run against this plugin repository (which has no openspec/ directory), while
 * the integration cases run against the sibling OpenSpec workspace when it is
 * present (this repository lives inside one).
 *
 * Run: node --test --test-isolation=none tests/native-state.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeChangeState,
  computeWorkspaceState,
  listMainSpecs,
  validateChangeByName,
} from '../src/native/state.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.join(repoRoot, 'tests', 'fixtures', 'workspace')
const hasWorkspace = existsSync(path.join(workspaceRoot, 'openspec', 'changes'))

test('an uninitialized workspace is reported as missing, not as an error', async () => {
  const state = await computeWorkspaceState(repoRoot)
  assert.equal(state.status, 'missing')
  assert.equal(state.cwd, repoRoot)
  assert.equal(state.root, 'openspec')
  assert.equal(state.archivedCount, 0)
  assert.deepEqual(state.changes, [])
  assert.deepEqual(state.specs, [])
  assert.deepEqual(state.archived, [])
  assert.equal(state.config.found, false)
  assert.equal(state.config.schema, 'spec-driven')
  assert.deepEqual(state.warnings, [])
  assert.equal(Array.isArray(state.skills.native), true)
  assert.equal(state.skills.fallbackActive, state.skills.native.length === 0)
})

test('an aborted signal rejects with an AbortError', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => computeWorkspaceState(repoRoot, { signal: controller.signal }), /aborted/)
})

test('computeChangeState throws only for a missing change directory', async () => {
  await assert.rejects(
    () => computeChangeState(repoRoot, 'does-not-exist'),
    /change "does-not-exist" was not found at openspec\/changes\/does-not-exist/,
  )
})

test('listMainSpecs returns [] when there are no capability specs', async () => {
  assert.deepEqual(await listMainSpecs(repoRoot), [])
})

test('real workspace: workspace state derives native change state', { skip: !hasWorkspace }, async () => {
  const state = await computeWorkspaceState(workspaceRoot)
  assert.equal(state.status, 'ready')
  assert.ok(Array.isArray(state.warnings))
  assert.ok(state.schemas.some((schema) => schema.name === 'spec-driven'))

  const change = state.changes.find((candidate) => candidate.name === 'align-native-openspec')
  assert.ok(change, 'the align-native-openspec change should be listed')
  assert.equal(change.schemaName, 'spec-driven')
  assert.equal(change.schemaSource, 'builtin')
  assert.equal(change.schemaVersion, '1.14.3')
  assert.equal(change.schemaError, null)
  assert.deepEqual(
    change.artifacts.map((artifact) => ({ id: artifact.id, status: artifact.status })),
    [
      { id: 'proposal', status: 'done' },
      { id: 'specs', status: 'done' },
      { id: 'design', status: 'done' },
      { id: 'tasks', status: 'done' },
    ],
  )
  assert.equal(change.isPlanningComplete, true)
  assert.equal(change.tracks, 'tasks.md')
  assert.deepEqual(change.applyRequires, ['tasks'])
  assert.ok(change.tasks.total >= 50)
  assert.equal(change.listStatus, change.tasks.done === change.tasks.total ? 'complete' : 'in-progress')
  assert.deepEqual(change.nextSteps, change.listStatus === 'complete' ? ['archive'] : ['run apply on tasks.md'])
  assert.ok(change.delta.ADDED >= 30)
  assert.equal(change.delta.files.length, 6)
  assert.equal(change.metadata.found, true)
  assert.match(change.metadata.created, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(change.metadata.schema, 'spec-driven')
  assert.equal(change.validation.errors, 0)
  assert.deepEqual(change.validation.issues, [])

  const proposalDoc = change.docs.find((doc) => doc.path.endsWith('proposal.md'))
  assert.deepEqual(proposalDoc, {
    path: 'openspec/changes/align-native-openspec/proposal.md',
    label: 'proposal',
    artifactId: 'proposal',
    kind: 'artifact',
  })
  const deltaDoc = change.docs.find((doc) => doc.kind === 'delta')
  assert.ok(deltaDoc.path.startsWith('openspec/changes/align-native-openspec/specs/'))
  assert.ok(change.files.includes('.openspec.yaml'))
  assert.ok(change.files.includes('tasks.md'))

  // Read-only and deterministic: identical input, identical output.
  const second = await computeWorkspaceState(workspaceRoot)
  assert.deepEqual(second, state)
})

test('real workspace: validateChangeByName returns merge and archive inputs', { skip: !hasWorkspace }, async () => {
  const result = await validateChangeByName(workspaceRoot, 'align-native-openspec')
  assert.equal(result.name, 'align-native-openspec')
  assert.equal(result.schemaName, 'spec-driven')
  assert.equal(result.metadata.skip_specs, false)
  assert.equal(result.validation.errors, 0)
  assert.equal(result.validation.warnings, 0)
  assert.equal(result.validation.infos, 0)
  assert.deepEqual(result.validation.issues, [])
  assert.equal(result.deltas.length, 6)
  for (const delta of result.deltas) {
    assert.match(delta.path, /^specs\/[a-z0-9-]+\/spec\.md$/)
    assert.ok(delta.parsed.operations.ADDED.length > 0)
  }
  assert.equal(result.tasks.items.length, result.tasks.total)
  // The live workspace's tasks.md changes as this change is implemented, so only
  // structure is asserted here — not any particular checkbox state.
  const firstTask = result.tasks.items[0]
  assert.equal(firstTask.id, '1.1')
  assert.equal(firstTask.depth, 0)
  assert.equal(typeof firstTask.done, 'boolean')
  assert.match(firstTask.text, /^1\.1 Implement `src\/native\/yaml\.js`/)

  const missing = computeChangeState(workspaceRoot, 'align-native-openspec')
  const changeState = await missing
  assert.equal(changeState.tasks.total, result.tasks.total)
  assert.equal(changeState.validation.errors, 0)
})

test('real workspace: main specs listing tolerates an empty specs/ tree', { skip: !hasWorkspace }, async () => {
  const specs = await listMainSpecs(workspaceRoot)
  assert.ok(Array.isArray(specs))
  for (const spec of specs) {
    assert.match(spec.path, /^openspec\/specs\/.+\/spec\.md$/)
    assert.equal(typeof spec.requirementCount, 'number')
    assert.equal(typeof spec.scenarioCount, 'number')
  }
})
