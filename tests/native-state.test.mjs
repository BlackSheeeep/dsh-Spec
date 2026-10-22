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
  extractProposalDigest,
  limitTaskItems,
  listMainSpecs,
  validateChangeByName,
  withArtifactMetadata,
} from '../src/native/state.js'
import { parseTasks } from '../src/native/tasks.js'

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

test('extractProposalDigest: Why first paragraph + top-level What Changes bullets', () => {
  const proposal = [
    '# Proposal',
    '',
    '## Why',
    '',
    '第一段原因。',
    '',
    '第二段不该进入摘要。',
    '',
    '## What Changes',
    '',
    '- 第一条改动',
    '* 第二条改动',
    '  - 缩进 bullet 不算顶层',
    '+ 第三条改动',
    '- 第四条改动',
    '- 第五条改动',
    '',
    '## Impact',
    '',
    '- 影响项',
  ].join('\n')
  const digest = extractProposalDigest(proposal)
  assert.equal(digest.why, '第一段原因。')
  assert.equal(digest.whyTruncated, false)
  assert.deepEqual(digest.changes, ['第一条改动', '第二条改动', '第三条改动', '第四条改动'])
  assert.equal(digest.changesHidden, 1)
  assert.equal(digest.changesTruncated, false)
})

test('extractProposalDigest: missing sections and long text degrade safely', () => {
  const empty = {
    why: null,
    whyTruncated: false,
    changes: [],
    changesHidden: 0,
    changesTruncated: false,
  }
  assert.deepEqual(extractProposalDigest(null), empty)
  assert.deepEqual(extractProposalDigest(''), empty)
  assert.deepEqual(extractProposalDigest('## Requirements\n\n- 不是 Why\n'), empty)

  const longWhy = '原'.repeat(400)
  const longBullet = '改'.repeat(200)
  const digest = extractProposalDigest(`## Why\n\n${longWhy}\n\n## What Changes\n\n- ${longBullet}\n`)
  assert.equal(digest.why.length, 280)
  assert.equal(digest.whyTruncated, true)
  assert.equal(digest.changes[0].length, 140)
  assert.equal(digest.changesTruncated, true)
})

test('extractProposalDigest: inline markdown is stripped from the digest', () => {
  const proposal = [
    '# Proposal',
    '',
    '## Why',
    '',
    '这是 **重点**，参考 `config.yaml` 与 [文档](https://example.com)。',
    '',
    '## What Changes',
    '',
    '- **第一条**：修改 `src/state.js`',
    '- 第二条 _强调_',
  ].join('\n')
  const digest = extractProposalDigest(proposal)
  assert.equal(digest.why, '这是 重点，参考 config.yaml 与 文档。')
  assert.deepEqual(digest.changes, ['第一条：修改 src/state.js', '第二条 强调'])
})

test('withArtifactMetadata: attaches schema description and generates (custom schema)', () => {
  const rows = [
    { id: 'research', status: 'done' },
    { id: 'tasks', status: 'ready' },
  ]
  const schema = {
    artifacts: [
      { id: 'research', description: 'Research notes for the change', generates: 'research.md' },
      { id: 'tasks', generates: ['tasks.md'] },
    ],
  }
  assert.deepEqual(withArtifactMetadata(rows, schema), [
    { id: 'research', status: 'done', description: 'Research notes for the change', generates: ['research.md'] },
    { id: 'tasks', status: 'ready', description: '', generates: ['tasks.md'] },
  ])
  assert.deepEqual(withArtifactMetadata(null, null), [])
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
  const firstDeltaFile = change.delta.files[0]
  assert.equal(typeof firstDeltaFile, 'object')
  assert.match(firstDeltaFile.path, /^specs\/[a-z0-9-]+\/spec\.md$/)
  assert.equal(firstDeltaFile.label, 'native-opsx-model')
  const perFile = change.delta.files.reduce(
    (acc, file) => {
      for (const operation of ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']) acc[operation] += file[operation]
      return acc
    },
    { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 },
  )
  assert.deepEqual(perFile, {
    ADDED: change.delta.ADDED,
    MODIFIED: change.delta.MODIFIED,
    REMOVED: change.delta.REMOVED,
    RENAMED: change.delta.RENAMED,
  })
  assert.equal(typeof change.summary.goal, 'string')
  assert.ok(change.summary.goal.length > 0)
  assert.ok(change.summary.why.length > 0)
  assert.ok(change.summary.why.length <= 280)
  assert.equal(typeof change.summary.whyTruncated, 'boolean')
  assert.ok(change.summary.changes.length > 0)
  const proposalArtifact = change.artifacts.find((artifact) => artifact.id === 'proposal')
  assert.equal(proposalArtifact.description, 'Initial proposal document outlining the change')
  assert.deepEqual(proposalArtifact.generates, ['proposal.md'])
  const specsArtifact = change.artifacts.find((artifact) => artifact.id === 'specs')
  assert.deepEqual(specsArtifact.generates, ['specs/**/*.md'])
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
  // The panel payload carries the detail rows too (the fixture is below the cap).
  assert.equal(changeState.tasks.items.length, changeState.tasks.total)
  assert.equal(changeState.tasks.items.filter((item) => item.done).length, changeState.tasks.done)
  assert.deepEqual(Object.keys(changeState.tasks.items[0]).sort(), ['depth', 'done', 'id', 'line', 'manual', 'text'])
  assert.equal(changeState.tasks.items[0].line, 5)
  assert.equal(changeState.tasks.items[0].manual, false)
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

test('limitTaskItems: bounds the panel payload at 200 rows without losing counts', async () => {
  // Below / equal to the cap: every row is kept (the real-workspace fixture has 57).
  const under = Array.from({ length: 57 }, (_, index) => ({ id: `${index + 1}`, text: `task ${index + 1}`, done: index < 3, depth: index % 3 }))
  const underRows = limitTaskItems(under)
  assert.equal(underRows.length, 57)
  assert.deepEqual(Object.keys(underRows[0]).sort(), ['depth', 'done', 'id', 'line', 'manual', 'text'])
  assert.equal(underRows[0].done, true)
  assert.equal(underRows[3].done, false)

  const exact = Array.from({ length: 200 }, (_, index) => ({ id: null, text: `task ${index + 1}`, done: false, depth: 0 }))
  assert.equal(limitTaskItems(exact).length, 200)

  // Above the cap: rows are capped but total/done stay complete on the state side.
  const text = Array.from({ length: 205 }, (_, index) => `- [${index < 4 ? 'x' : ' '}] 1.${index + 1} task ${index + 1}`).join('\n')
  const parsed = parseTasks(text)
  assert.equal(parsed.total, 205)
  assert.equal(parsed.done, 4)
  const capped = limitTaskItems(parsed.items)
  assert.equal(capped.length, 200)
  assert.equal(capped[0].text, '1.1 task 1')
  assert.equal(capped[199].text, '1.200 task 200')
  assert.equal(parsed.total - capped.length, 5)

  // Malformed rows normalize instead of leaking unknown shapes into the panel.
  assert.deepEqual(limitTaskItems(null), [])
  assert.deepEqual(limitTaskItems([{ text: 1, done: 1, depth: '2' }]), [
    { id: null, text: '1', done: false, depth: 0, line: null, manual: false },
  ])
})
