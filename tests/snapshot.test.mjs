/**
 * Tests for the bundled native snapshot and the dev-time refresh script
 * (src/native-snapshot/**, tools/sync-native-snapshot.mjs).
 *
 * These tests are read-only: they inspect the committed snapshot (the
 * spec-driven schema/templates plus the twelve vendored OPSX workflow skills)
 * and the sync script's pure planning/argument helpers, never the network and
 * never write a file (the script's write path stays covered by the developer
 * running it).
 *
 * Run: node --test --test-isolation=none tests/snapshot.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VENDORED_SKILLS, parseSkillFrontmatter } from '../src/native/skill-adaptation.js'
import {
  ATTRIBUTION_FILE,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_SKILLS_DIR,
  applySnapshotPlan,
  main,
  normalizeEol,
  parseSyncArgs,
  planSnapshot,
  readAttributionMarkers,
  refreshAttribution,
  resolveSourceSchemaDir,
  resolveSourceSkillsDir,
} from '../tools/sync-native-snapshot.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SNAPSHOT_DIR = join(REPO_ROOT, 'src', 'native-snapshot')
const SCHEMA_DIR = join(SNAPSHOT_DIR, SNAPSHOT_SCHEMA)
const SKILLS_DIR = join(SNAPSHOT_DIR, SNAPSHOT_SKILLS_DIR)
const TEMPLATES = ['proposal.md', 'spec.md', 'design.md', 'tasks.md']

/** Expected snapshot-relative paths, in the deterministic plan order. */
const EXPECTED_SNAPSHOT_FILES = [
  'schema.yaml',
  ...TEMPLATES.map((template) => `templates/${template}`).sort(),
  ...VENDORED_SKILLS.map((name) => `skills/${name}/SKILL.md`),
]

/** A distinctive phrase each upstream SKILL.md must keep verbatim. */
const SKILL_BODY_TOKEN = {
  'openspec-explore': 'Explore mode',
  'openspec-propose': 'Propose a new change',
  'openspec-apply-change': 'Implement tasks',
  'openspec-update-change': 'Revise a change',
  'openspec-sync-specs': 'Sync delta specs',
  'openspec-archive-change': 'Archive a completed change',
  'openspec-new-change': 'Start a new change',
  'openspec-continue-change': 'Continue working',
  'openspec-ff-change': 'Fast-forward',
  'openspec-verify-change': 'Verify that an implementation matches',
  'openspec-bulk-archive-change': 'Archive multiple completed changes',
  'openspec-onboard': 'Guide the user through their first complete OpenSpec workflow cycle',
}

/** Read one snapshot file as UTF-8. */
function readSnapshot(...parts) {
  return readFileSync(join(SNAPSHOT_DIR, ...parts), 'utf8')
}

/**
 * Read one vendored skill with CRLF normalized to LF, so the assertions hold
 * for a checkout where git's autocrlf setting converted line endings (the
 * runtime loader normalizes them too).
 */
function readSnapshotSkill(name) {
  return readSnapshot('skills', name, 'SKILL.md').replace(/\r\n/g, '\n')
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

test('snapshot contains the twelve vendored OPSX workflow SKILL.md files', () => {
  assert.equal(VENDORED_SKILLS.length, 12)
  for (const name of VENDORED_SKILLS) {
    const raw = readSnapshotSkill(name)
    assert.ok(raw.startsWith('---\n'), `${name} must start with a YAML frontmatter fence`)
    assert.ok(raw.endsWith('\n'), `${name} must end with a newline`)
    // The snapshot is verbatim upstream: the CLI-era fields are still present
    // here and only the runtime adaptation layer rewrites them.
    assert.match(raw, /^allowed-tools: Bash\(openspec:\*\)$/m, name)
    assert.match(raw, /^compatibility: Requires openspec CLI\.$/m, name)
    assert.match(raw, /^license: MIT$/m, name)
    assert.match(raw, /^metadata:\n {2}author: openspec\n {2}version: "1\.0"$/m, name)
    assert.ok(raw.includes(SKILL_BODY_TOKEN[name]), `${name} body looks wrong/truncated`)

    const parsed = parseSkillFrontmatter(raw)
    assert.equal(parsed.error, null, `${name} frontmatter must parse`)
    assert.deepEqual(parsed.warnings, [], name)
    assert.equal(parsed.data.name, name)
    assert.ok(typeof parsed.data.description === 'string' && parsed.data.description.length > 0)
  }
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

test('ATTRIBUTION has a vendored workflow skills section with machine-readable markers', () => {
  const attribution = readSnapshot(ATTRIBUTION_FILE)
  assert.match(attribution, /^## Vendored workflow skills$/m)
  const sectionStart = attribution.indexOf('## Vendored workflow skills')
  const section = attribution.slice(sectionStart)
  assert.match(section, /skills\/<name>\/SKILL\.md/)
  assert.match(section, /https:\/\/github\.com\/Fission-AI\/OpenSpec/)
  assert.match(section, /Upstream version:\s*1\.14\.3/)
  assert.match(section, /Upstream commit:\s*c794978f4f8845ce59693373c9dd882ee776588c/)
  assert.match(section, /License:\s*MIT/)
  assert.match(section, /normalized to LF/i)
  assert.match(section, /src\/native\/skill-adaptation\.js/)
  assert.match(section, /DSH adaptation/i)
  for (const name of VENDORED_SKILLS) {
    assert.ok(section.includes(`\`${name}\``), `ATTRIBUTION must list ${name}`)
  }

  // The version/commit markers are recorded twice (schema snapshot + skills)
  // and both copies must agree so the refresh script can rewrite them all.
  const versionMarkers = [...attribution.matchAll(/^[-*]\s*Upstream version:\s*(\S+)\s*$/gm)].map((match) => match[1])
  const commitMarkers = [...attribution.matchAll(/^[-*]\s*Upstream commit:\s*([0-9a-f]{7,40})\s*$/gim)].map((match) => match[1])
  assert.equal(versionMarkers.length, 2)
  assert.equal(commitMarkers.length, 2)
  assert.deepEqual(versionMarkers, ['1.14.3', '1.14.3'])
  assert.equal(commitMarkers[0], commitMarkers[1])
})

test('readAttributionMarkers reads the machine-readable version markers', () => {
  const text = readSnapshot(ATTRIBUTION_FILE)
  const markers = readAttributionMarkers(text)
  assert.equal(markers.version, '1.14.3')
  assert.ok(markers.commit.startsWith('c794978'), `commit marker should start with c794978, got ${markers.commit}`)
  assert.deepEqual(readAttributionMarkers('# no markers here'), { version: null, commit: null })
  assert.deepEqual(readAttributionMarkers(''), { version: null, commit: null })
})

test('refreshAttribution rewrites every version and commit marker in place', () => {
  const text = readSnapshot(ATTRIBUTION_FILE)
  const refreshed = refreshAttribution(text, { version: '9.9.9', commit: 'deadbeef' })
  assert.deepEqual(refreshed.warnings, [])
  assert.equal(
    [...refreshed.text.matchAll(/^[-*]\s*Upstream version:\s*9\.9\.9\s*$/gm)].length,
    2,
    'both Upstream version markers must be refreshed',
  )
  assert.equal(
    [...refreshed.text.matchAll(/^[-*]\s*Upstream commit:\s*deadbeef\s*$/gm)].length,
    2,
    'both Upstream commit markers must be refreshed',
  )
  assert.equal(/^[-*]\s*Upstream version:\s*1\.14\.3\s*$/m.test(refreshed.text), false)

  const missing = refreshAttribution('# attribution without markers', { version: '2.0.0', commit: 'abc1234' })
  assert.equal(missing.warnings.length, 2)
  assert.match(missing.warnings.join('\n'), /Upstream version:/)
  assert.match(missing.warnings.join('\n'), /Upstream commit:/)
})

test('resolveSourceSchemaDir accepts a repo root, a snapshot mirror root or a schema directory', () => {
  assert.equal(resolveSourceSchemaDir(SCHEMA_DIR), SCHEMA_DIR)
  assert.equal(resolveSourceSchemaDir(SNAPSHOT_DIR), SCHEMA_DIR, 'a snapshot mirror root resolves <root>/spec-driven')
  assert.equal(resolveSourceSchemaDir(join(REPO_ROOT, 'no-such-dir')), null)
  assert.equal(resolveSourceSchemaDir(''), null)
})

test('resolveSourceSkillsDir finds skills/ above the schema directory', () => {
  assert.equal(resolveSourceSkillsDir(SCHEMA_DIR), SKILLS_DIR)
  assert.equal(resolveSourceSkillsDir(SNAPSHOT_DIR), SKILLS_DIR)
  assert.equal(resolveSourceSkillsDir(join(REPO_ROOT, 'no-such-dir')), null)
  assert.equal(resolveSourceSkillsDir(join(REPO_ROOT, 'tools', 'no-such-dir')), null)
  assert.equal(resolveSourceSkillsDir(''), null)
})

test('planSnapshot is pure: it plans the schema, templates and twelve skills with no drift', () => {
  const plan = planSnapshot(SNAPSHOT_DIR)
  assert.equal(plan.ok, true)
  assert.equal(plan.error, null)
  assert.equal(plan.sourceSchemaDir, SCHEMA_DIR)
  assert.equal(plan.sourceSkillsDir, SKILLS_DIR)
  assert.equal(plan.targetSchemaDir, SCHEMA_DIR)
  assert.equal(plan.targetSkillsDir, SKILLS_DIR)
  assert.deepEqual(
    plan.files.map((file) => file.rel),
    EXPECTED_SNAPSHOT_FILES,
  )
  for (const file of plan.files) {
    assert.equal(file.changed, false, `${file.rel} should match the committed snapshot (run the refresh script otherwise)`)
    const committed = readFileSync(file.target, 'utf8')
    assert.equal(file.content, normalizeEol(committed))
  }
  assert.equal(plan.files.filter((file) => file.rel.startsWith('skills/')).length, 12)
  assert.equal(plan.attribution.version, '1.14.3')
  assert.ok(plan.attribution.commit.startsWith('c794978'))
  assert.equal(plan.attribution.changed, false)
  assert.deepEqual(plan.warnings, [])
})

test('planSnapshot accepts a spec-driven source directory and resolves skills from its parent', () => {
  const plan = planSnapshot(SCHEMA_DIR)
  assert.equal(plan.ok, true)
  assert.equal(plan.sourceSchemaDir, SCHEMA_DIR)
  assert.equal(plan.sourceSkillsDir, SKILLS_DIR)
  assert.deepEqual(
    plan.files.map((file) => file.rel),
    EXPECTED_SNAPSHOT_FILES,
  )
  assert.equal(plan.files.every((file) => file.changed === false), true)
})

test('planSnapshot fails clearly when the source is missing', () => {
  const plan = planSnapshot(join(REPO_ROOT, 'definitely-missing-openspec-source'))
  assert.equal(plan.ok, false)
  assert.match(plan.error, /not found/i)
  assert.match(plan.error, /schemas\/spec-driven/)
  assert.deepEqual(plan.files, [])
  assert.equal(plan.attribution, null)
})

test('planSnapshot fails clearly when the workflow skills are missing from the source', () => {
  const noSkills = planSnapshot(SCHEMA_DIR, { sourceSkillsDir: join(REPO_ROOT, 'definitely-missing-openspec-skills') })
  assert.equal(noSkills.ok, false)
  assert.match(noSkills.error, /workflow skills/i)
  assert.match(noSkills.error, /definitely-missing-openspec-skills/)
  for (const name of VENDORED_SKILLS) assert.ok(noSkills.error.includes(name), `error should name ${name}`)
  assert.deepEqual(noSkills.files, [])

  const forcedMissing = planSnapshot(SCHEMA_DIR, { sourceSkillsDir: null })
  assert.equal(forcedMissing.ok, false)
  assert.match(forcedMissing.error, /missing workflow skills/i)
})

test('planSnapshot detects drift when the target snapshot is missing or outdated', () => {
  // A nonexistent target root behaves exactly like a fresh checkout: every file
  // is new and the attribution file is missing. Nothing is written.
  const missingTarget = join(REPO_ROOT, 'tests', '__missing_snapshot_target__')
  const plan = planSnapshot(SNAPSHOT_DIR, { targetRoot: missingTarget })
  assert.equal(plan.ok, true)
  assert.equal(plan.files.length, 17)
  assert.equal(plan.files.every((file) => file.changed === true), true)
  assert.equal(plan.targetSchemaDir, join(missingTarget, SNAPSHOT_SCHEMA))
  assert.equal(plan.targetSkillsDir, join(missingTarget, SNAPSHOT_SKILLS_DIR))
  assert.equal(plan.attribution, null)
  assert.match(plan.warnings.join('\n'), /attribution file missing/)

  // Explicit revision overrides surface as an attribution change (still pure).
  const overridden = planSnapshot(SNAPSHOT_DIR, { version: '2.0.0', commit: 'deadbeefcafe' })
  assert.equal(overridden.ok, true)
  assert.equal(overridden.attribution.changed, true)
  assert.match(overridden.attribution.content, /^[-*]\s*Upstream version:\s*2\.0\.0\s*$/m)
  assert.equal(
    [...overridden.attribution.content.matchAll(/^[-*]\s*Upstream commit:\s*deadbeefcafe\s*$/gm)].length,
    2,
  )
})

test('planSnapshot normalizes CRLF checkouts to LF', () => {
  assert.equal(normalizeEol('a\r\nb\r\n'), 'a\nb\n')
  assert.equal(normalizeEol('a\nb\n'), 'a\nb\n')
})

test('applySnapshotPlan refuses an invalid plan', () => {
  assert.throws(() => applySnapshotPlan(null), /invalid snapshot plan/)
  assert.throws(() => applySnapshotPlan({ ok: false, error: 'snapshot source not found' }), /snapshot source not found/)
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
  const missingSkills = runCli(['--source', SCHEMA_DIR, '--dry-run'], { OPENSPEC_SOURCE: undefined })
  assert.equal(missingSkills.code, 0, 'the repo snapshot itself still has all 12 skills')
  const badUsage = runCli(['--nope'], {})
  assert.equal(badUsage.code, 2)
  assert.match(badUsage.output, /unknown argument/)
  // Dry run over the committed snapshot plans no changes and writes nothing.
  const dryRun = runCli(['--source', SNAPSHOT_DIR, '--dry-run'], {})
  assert.equal(dryRun.code, 0)
  assert.match(dryRun.output, /Already up to date/i)
  assert.match(dryRun.output, /Skills source:/)
  assert.match(dryRun.output, /Skills target:/)
})
