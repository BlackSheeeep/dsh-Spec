/**
 * Tests for src/native/graph.js — schema graph validation and native artifact
 * state derivation.
 *
 * Artifact states are exercised against real files in this repository (the
 * sandbox forbids creating fixtures from tests): `cwd` is the plugin repo root
 * and `changeRel` is `src/native`, whose files stand in for change outputs.
 *
 * Run: node --test --test-isolation=none tests/native-graph.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeArtifactStates, validateSchemaGraph } from '../src/native/graph.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fakeChange = 'src/native'

/** @param {object[]} artifacts @param {object} [apply] */
function schemaOf(artifacts, apply = { requires: [], tracks: null, instruction: '' }) {
  return { name: 'test', artifacts, apply }
}

test('validateSchemaGraph accepts a valid graph', () => {
  const schema = schemaOf(
    [
      { id: 'proposal', generates: 'proposal.md', requires: [] },
      { id: 'specs', generates: 'specs/**/*.md', requires: ['proposal'] },
      { id: 'tasks', generates: 'tasks.md', requires: ['specs'] },
    ],
    { requires: ['tasks'], tracks: 'tasks.md', instruction: '' },
  )
  const { issues, artifacts } = validateSchemaGraph(schema)
  assert.deepEqual(issues, [])
  assert.deepEqual([...artifacts.keys()], ['proposal', 'specs', 'tasks'])
})

test('validateSchemaGraph reports duplicate ids', () => {
  const { issues } = validateSchemaGraph(
    schemaOf([
      { id: 'a', generates: 'a.md', requires: [] },
      { id: 'a', generates: 'b.md', requires: [] },
    ]),
  )
  assert.equal(issues.length, 1)
  assert.equal(issues[0].level, 'ERROR')
  assert.match(issues[0].message, /duplicate artifact id "a"/)
})

test('validateSchemaGraph reports dangling requires and apply references', () => {
  const { issues } = validateSchemaGraph(
    schemaOf([{ id: 'a', generates: 'a.md', requires: ['ghost'] }], {
      requires: ['missing'],
      tracks: null,
      instruction: '',
    }),
  )
  assert.equal(issues.filter((issue) => issue.level === 'ERROR').length, 2)
  assert.ok(issues.some((issue) => /requires unknown artifact "ghost"/.test(issue.message)))
  assert.ok(issues.some((issue) => /apply\.requires references unknown artifact "missing"/.test(issue.message)))
})

test('validateSchemaGraph detects dependency cycles once', () => {
  const { issues } = validateSchemaGraph(
    schemaOf([
      { id: 'a', generates: 'a.md', requires: ['b'] },
      { id: 'b', generates: 'b.md', requires: ['a'] },
      { id: 'c', generates: 'c.md', requires: [] },
    ]),
  )
  const cycleIssues = issues.filter((issue) => issue.message.includes('dependency cycle'))
  assert.equal(cycleIssues.length, 1)
  assert.equal(cycleIssues[0].level, 'ERROR')
  assert.match(cycleIssues[0].message, /a -> b -> a|b -> a -> b/)
})

test('validateSchemaGraph checks missing generates and apply.tracks targets', () => {
  const { issues } = validateSchemaGraph(
    schemaOf([{ id: 'a', generates: null, requires: [] }], {
      requires: [],
      tracks: 'tasks.md',
      instruction: '',
    }),
  )
  assert.ok(issues.some((issue) => /has no "generates" path/.test(issue.message)))
  assert.ok(issues.some((issue) => /apply\.tracks "tasks\.md" is not generated/.test(issue.message)))
})

test('computeArtifactStates derives done, ready and blocked from real files', async () => {
  const schema = schemaOf([
    { id: 'present', generates: 'yaml.js', requires: [] },
    { id: 'globbed', generates: '*.js', requires: [] },
    { id: 'design', generates: 'missing-design.md', requires: ['present', 'globbed'] },
    { id: 'tasks', generates: 'missing-tasks.md', requires: ['design'] },
  ])
  const result = await computeArtifactStates(repoRoot, fakeChange, schema)
  assert.deepEqual(result.artifacts, [
    { id: 'present', outputPath: 'yaml.js', status: 'done' },
    { id: 'globbed', outputPath: '*.js', status: 'done' },
    { id: 'design', outputPath: 'missing-design.md', status: 'ready' },
    { id: 'tasks', outputPath: 'missing-tasks.md', status: 'blocked', missingDeps: ['design'] },
  ])
  assert.equal(result.isPlanningComplete, false)
  assert.deepEqual(result.nextSteps, ['create design (missing-design.md)'])
})

test('glob outputs complete only when at least one file matches', async () => {
  const matching = schemaOf([{ id: 'specs', generates: '**/*.js', requires: [] }])
  assert.equal((await computeArtifactStates(repoRoot, fakeChange, matching)).artifacts[0].status, 'done')

  const notMatching = schemaOf([{ id: 'specs', generates: '**/*.nope', requires: [] }])
  assert.equal((await computeArtifactStates(repoRoot, fakeChange, notMatching)).artifacts[0].status, 'ready')
})

test('skipSpecs marks the specs artifact skipped and satisfies dependents', async () => {
  const schema = schemaOf([
    { id: 'proposal', generates: 'yaml.js', requires: [] },
    { id: 'specs', generates: 'specs/**/*.md', requires: ['proposal'] },
    { id: 'tasks', generates: 'missing-tasks.md', requires: ['specs'] },
  ])
  const result = await computeArtifactStates(repoRoot, fakeChange, schema, { skipSpecs: true })
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.status),
    ['done', 'skipped', 'ready'],
  )
  const withoutSkip = await computeArtifactStates(repoRoot, fakeChange, schema, { skipSpecs: false })
  assert.deepEqual(
    withoutSkip.artifacts.map((artifact) => artifact.status),
    ['done', 'ready', 'blocked'],
  )
})

test('missing change directory yields an all-ready graph', async () => {
  const schema = schemaOf([
    { id: 'proposal', generates: 'proposal.md', requires: [] },
    { id: 'design', generates: 'design.md', requires: ['proposal'] },
  ])
  const result = await computeArtifactStates(repoRoot, 'does/not/exist', schema)
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.status),
    ['ready', 'blocked'],
  )
})

test('planning complete exposes the apply tracking file and never marks tasks done by itself', async () => {
  const schema = schemaOf(
    [
      { id: 'proposal', generates: 'yaml.js', requires: [] },
      { id: 'tasks', generates: 'fsio.js', requires: ['proposal'] },
    ],
    { requires: ['tasks'], tracks: 'fsio.js', instruction: '' },
  )
  const result = await computeArtifactStates(repoRoot, fakeChange, schema)
  assert.equal(result.isPlanningComplete, true)
  assert.deepEqual(result.applyRequires, ['tasks'])
  assert.equal(result.tracks, 'fsio.js')
  assert.deepEqual(result.nextSteps, ['run apply on fsio.js'])
})

test('empty schemas are inert', async () => {
  const result = await computeArtifactStates(repoRoot, fakeChange, schemaOf([]))
  assert.deepEqual(result.artifacts, [])
  assert.equal(result.isPlanningComplete, false)
  assert.deepEqual(result.nextSteps, [])
})
