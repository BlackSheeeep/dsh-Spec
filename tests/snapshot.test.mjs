/**
 * Tests for the bundled native snapshot and the dev-time refresh script
 * (src/native-snapshot/**, tools/sync-native-snapshot.mjs).
 *
 * These tests are read-only: they inspect the committed snapshot and the sync
 * script's pure planning/argument helpers, never the network and never write a
 * file (the script's write path stays covered by the developer running it).
 *
 * Run: node --test --test-isolation=none tests/snapshot.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ATTRIBUTION_FILE,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_ROOT,
  main,
  normalizeEol,
  parseSyncArgs,
  planSnapshot,
  readAttributionMarkers,
  refreshAttribution,
  resolveSourceSchemaDir,
} from '../tools/sync-native-snapshot.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SNAPSHOT_DIR = join(REPO_ROOT, 'src', 'native-snapshot')
const SCHEMA_DIR = join(SNAPSHOT_DIR, SNAPSHOT_SCHEMA)
const TEMPLATES = ['proposal.md', 'spec.md', 'design.md', 'tasks.md']

/** Read one snapshot file as UTF-8. */
function readSnapshot(...parts) {
  return readFileSync(join(SNAPSHOT_DIR, ...parts), 'utf8')
}

/** Run a CLI entry point while capturing (and hiding) its stdout/stderr. */
function runCli(argv, env = {}) {
  const originalLog = console.log
  const originalError = console.error
  const lines = []
  console.log = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  try {
    return { code: main(argv, env), output: lines.join('\n') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

test('snapshot contains the pinned spec-driven schema and four templates', () => {
  const schema = readSnapshot(SNAPSHOT_SCHEMA, 'schema.yaml')
  assert.match(schema, /^name: spec-driven$/m)
  assert.match(schema, /^version: 1$/m)
  for (const template of TEMPLATES) {
    const body = readSnapshot(SNAPSHOT_SCHEMA, 'templates', template)
    assert.ok(body.trim().length > 0, `${template} should not be empty`)
    assert.match(schema, new RegExp(`template: ${template.replace('.', '\\.')}`), `schema should reference ${template}`)
  }
  // Four artifacts, in native order, matching the four templates.
  const ids = [...schema.matchAll(/^\s{2}- id: (\S+)$/gm)].map((match) => match[1])
  assert.deepEqual(ids, ['proposal', 'specs', 'design', 'tasks'])
  assert.match(schema, /^apply:\s*$/m)
  assert.match(schema, /tracks: tasks\.md/)
})

test('snapshot templates keep the native document structure', () => {
  const proposals = readSnapshot(SNAPSHOT_SCHEMA, 'templates', 'proposal.md')
  assert.match(proposals, /^# Proposal$/m)
  assert.match(proposals, /^## Why$/m)
  assert.match(proposals, /^## What Changes$/m)
  assert.match(proposals, /^## Capabilities$/m)

  const spec = readSnapshot(SNAPSHOT_SCHEMA, 'templates', 'spec.md')
  assert.match(spec, /^# Spec Delta$/m)
  assert.match(spec, /^## ADDED Requirements$/m)
  assert.match(spec, /^### Requirement:/m)
  assert.match(spec, /^#### Scenario:/m)

  const design = readSnapshot(SNAPSHOT_SCHEMA, 'templates', 'design.md')
  assert.match(design, /^# Design$/m)
  assert.match(design, /^## Context$/m)
  assert.match(design, /^## Decisions$/m)

  const tasks = readSnapshot(SNAPSHOT_SCHEMA, 'templates', 'tasks.md')
  assert.match(tasks, /^# Tasks$/m)
  assert.match(tasks, /^- \[ \] 1\.1 /m)
})

test('ATTRIBUTION records upstream URL, version, commit, MIT and refresh instructions', () => {
  const attribution = readSnapshot(ATTRIBUTION_FILE)
  assert.match(attribution, /https:\/\/github\.com\/Fission-AI\/OpenSpec/)
  assert.match(attribution, /Upstream version:\s*1\.14\.3/)
  assert.match(attribution, /Upstream commit:\s*c794978/i)
  assert.match(attribution, /MIT License/)
  assert.match(attribution, /Copyright \(c\) 2024 OpenSpec Contributors/)
  assert.match(attribution, /sync-native-snapshot\.mjs/)
  assert.match(attribution, /--source/)
  assert.match(attribution, /OPENSPEC_SOURCE/)
  assert.match(attribution, /Refresh instructions/i)
})

test('readAttributionMarkers reads the machine-readable version markers', () => {
  const text = readSnapshot(ATTRIBUTION_FILE)
  const markers = readAttributionMarkers(text)
  assert.equal(markers.version, '1.14.3')
  assert.ok(markers.commit.startsWith('c794978'), `commit marker should start with c794978, got ${markers.commit}`)
  assert.deepEqual(readAttributionMarkers('# no markers here'), { version: null, commit: null })
  assert.deepEqual(readAttributionMarkers(''), { version: null, commit: null })
})

test('refreshAttribution rewrites version and commit markers in place', () => {
  const text = readSnapshot(ATTRIBUTION_FILE)
  const refreshed = refreshAttribution(text, { version: '9.9.9', commit: 'deadbeef' })
  assert.deepEqual(refreshed.warnings, [])
  assert.match(refreshed.text, /Upstream version:\s*9\.9\.9/)
  assert.match(refreshed.text, /Upstream commit:\s*deadbeef/)
  assert.ok(!refreshed.text.includes('Upstream version: 1.14.3'))

  const missing = refreshAttribution('# attribution without markers', { version: '2.0.0', commit: 'abc1234' })
  assert.equal(missing.warnings.length, 2)
  assert.match(missing.warnings.join('\n'), /Upstream version:/)
  assert.match(missing.warnings.join('\n'), /Upstream commit:/)
})

test('resolveSourceSchemaDir accepts a repo root or a schema directory', () => {
  assert.equal(resolveSourceSchemaDir(SCHEMA_DIR), SCHEMA_DIR)
  assert.equal(resolveSourceSchemaDir(SNAPSHOT_DIR), null, 'a snapshot root has no schemas/spec-driven child')
  assert.equal(resolveSourceSchemaDir(join(REPO_ROOT, 'no-such-dir')), null)
  assert.equal(resolveSourceSchemaDir(''), null)
})

test('planSnapshot is pure: it plans the five files and detects no drift', () => {
  const plan = planSnapshot(SCHEMA_DIR)
  assert.equal(plan.ok, true)
  assert.equal(plan.error, null)
  assert.equal(plan.sourceSchemaDir, SCHEMA_DIR)
  assert.equal(plan.targetSchemaDir, SCHEMA_DIR)
  assert.deepEqual(
    plan.files.map((file) => file.rel),
    ['schema.yaml', ...TEMPLATES.map((template) => `templates/${template}`).sort()],
  )
  for (const file of plan.files) {
    assert.equal(file.changed, false, `${file.rel} should match the committed snapshot (run the refresh script otherwise)`)
    const committed = readFileSync(join(SNAPSHOT_DIR, SNAPSHOT_SCHEMA, ...file.rel.split('/')), 'utf8')
    assert.equal(file.content, normalizeEol(committed))
  }
  assert.equal(plan.attribution.version, '1.14.3')
  assert.ok(plan.attribution.commit.startsWith('c794978'))
  assert.equal(plan.attribution.changed, false)
})

test('planSnapshot fails clearly when the source is missing', () => {
  const plan = planSnapshot(join(REPO_ROOT, 'definitely-missing-openspec-source'))
  assert.equal(plan.ok, false)
  assert.match(plan.error, /not found/i)
  assert.match(plan.error, /schemas\/spec-driven/)
  assert.deepEqual(plan.files, [])
  assert.equal(plan.attribution, null)
})

test('planSnapshot normalizes CRLF checkouts to LF', () => {
  assert.equal(normalizeEol('a\r\nb\r\n'), 'a\nb\n')
  assert.equal(normalizeEol('a\nb\n'), 'a\nb\n')
})

test('parseSyncArgs handles --source, OPENSPEC_SOURCE and overrides', () => {
  assert.deepEqual(parseSyncArgs(['--source', 'C:/openspec'], {}), {
    source: 'C:/openspec',
    version: null,
    commit: null,
    dryRun: false,
    help: false,
    error: null,
  })
  assert.equal(parseSyncArgs(['--source=C:/openspec'], {}).source, 'C:/openspec')
  assert.equal(parseSyncArgs([], { OPENSPEC_SOURCE: 'D:/repo' }).source, 'D:/repo')
  assert.equal(parseSyncArgs([], {}).source, null)
  assert.equal(parseSyncArgs(['--source', 'x', '--version', '2.0.0', '--commit', 'abc1234', '--dry-run'], {}).dryRun, true)
  assert.equal(parseSyncArgs(['--source', 'x', '--version=2.0.0'], {}).version, '2.0.0')
  assert.equal(parseSyncArgs([], { OPENSPEC_VERSION: '3.0.0', OPENSPEC_COMMIT: 'cafebabe' }).version, '3.0.0')
  assert.equal(parseSyncArgs([], { OPENSPEC_VERSION: '3.0.0', OPENSPEC_COMMIT: 'cafebabe' }).commit, 'cafebabe')
  assert.equal(parseSyncArgs(['--help'], {}).help, true)

  assert.match(parseSyncArgs(['--source'], {}).error, /missing value/)
  assert.match(parseSyncArgs(['--version'], {}).error, /missing value/)
  assert.match(parseSyncArgs(['--wat'], {}).error, /unknown argument/)
})

test('CLI exits non-zero for a missing source or bad usage, and never writes', () => {
  assert.equal(runCli(['--help'], {}).code, 0)
  assert.equal(runCli([], {}).code, 2)
  const missing = runCli(['--source', join(REPO_ROOT, 'missing-source-dir')], {})
  assert.equal(missing.code, 1)
  assert.match(missing.output, /not found/i)
  const badUsage = runCli(['--nope'], {})
  assert.equal(badUsage.code, 2)
  assert.match(badUsage.output, /unknown argument/)
  // Dry run over the committed snapshot plans no changes and writes nothing.
  const dryRun = runCli(['--source', SCHEMA_DIR, '--dry-run'], {})
  assert.equal(dryRun.code, 0)
  assert.match(dryRun.output, /Already up to date/i)
})
