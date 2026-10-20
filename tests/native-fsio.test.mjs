/**
 * Tests for src/native/fsio.js.
 *
 * The sandbox denies child-process file writes, so this file never creates real
 * fixtures: pure path helpers are asserted directly, read helpers run against
 * this repository's own files, and write helpers are exercised only through
 * their containment checks (which throw before touching the disk).
 *
 * Run: node --test --test-isolation=none tests/native-fsio.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  isInside,
  isFile,
  joinRel,
  listDir,
  listTree,
  movePath,
  normalizeRel,
  pathExists,
  readText,
  readTextOrNull,
  removePath,
  toAbs,
  writeText,
} from '../src/native/fsio.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('normalizeRel collapses . and .. segments', () => {
  assert.equal(normalizeRel(''), '')
  assert.equal(normalizeRel('openspec/changes'), 'openspec/changes')
  assert.equal(normalizeRel('./openspec//./changes/'), 'openspec/changes')
  assert.equal(normalizeRel('openspec/changes/x/../archive'), 'openspec/changes/archive')
  assert.equal(normalizeRel('a/b/../../c'), 'c')
})

test('normalizeRel rejects absolute paths and root escapes', () => {
  assert.throws(() => normalizeRel('/etc/passwd'), /workspace-relative/)
  assert.throws(() => normalizeRel('C:/Windows'), /workspace-relative/)
  assert.throws(() => normalizeRel('../outside'), /escapes the workspace root/)
  assert.throws(() => normalizeRel('a/../../outside'), /escapes the workspace root/)
})

test('joinRel produces workspace-relative POSIX paths', () => {
  assert.equal(joinRel('openspec', 'changes', 'x'), 'openspec/changes/x')
  assert.equal(joinRel('', 'a', '/b'), 'a/b')
  assert.equal(joinRel('a', undefined, null, 'b'), 'a/b')
  assert.equal(joinRel(), '')
})

test('toAbs resolves against an absolute workspace root', () => {
  assert.equal(toAbs(repoRoot, 'src/native/yaml.js'), path.join(repoRoot, 'src', 'native', 'yaml.js'))
  assert.equal(toAbs(repoRoot, ''), path.resolve(repoRoot))
})

test('isInside is a win32-safe containment check', () => {
  const root = path.join(repoRoot, 'src')
  assert.equal(isInside(root, path.join(root, 'native', 'yaml.js')), true)
  assert.equal(isInside(root, root), true)
  assert.equal(isInside(root, path.join(repoRoot, 'tests')), false)
  if (process.platform === 'win32') {
    assert.equal(isInside(root.toUpperCase(), path.join(root, 'native')), true)
  }
})

test('readText reads a real repository file', async () => {
  const text = await readText(repoRoot, 'tests/prompts.test.mjs')
  assert.match(text, /node:test/)
})

test('readTextOrNull returns null for missing or escaping paths', async () => {
  assert.equal(await readTextOrNull(repoRoot, 'does/not/exist.yaml'), null)
  assert.equal(await readTextOrNull(repoRoot, 'src/native'), null)
  assert.equal(await readTextOrNull(repoRoot, '../outside.txt'), null)
})

test('listDir returns sorted typed entries and tolerates missing dirs', async () => {
  const entries = await listDir(repoRoot, 'src/native')
  assert.ok(entries.length > 0)
  assert.deepEqual(
    entries.map((entry) => entry.name),
    [...entries.map((entry) => entry.name)].sort(),
  )
  const yaml = entries.find((entry) => entry.name === 'yaml.js')
  assert.deepEqual(yaml, { name: 'yaml.js', type: 'file' })
  assert.deepEqual(await listDir(repoRoot, 'missing-dir'), [])
})

test('listTree flattens descendants and honors maxDepth', async () => {
  const tree = await listTree(repoRoot, 'src/native', { maxDepth: 12 })
  assert.ok(tree.some((entry) => entry.rel === 'src/native/yaml.js' && entry.type === 'file'))
  assert.ok(tree.every((entry) => entry.rel.startsWith('src/native/')))
  assert.deepEqual(await listTree(repoRoot, 'missing-dir'), [])
  const shallow = await listTree(repoRoot, 'src', { maxDepth: 1 })
  assert.ok(shallow.some((entry) => entry.rel === 'src/native' && entry.type === 'directory'))
  assert.ok(shallow.every((entry) => entry.rel.split('/').length === 2))
})

test('pathExists and isFile distinguish files, directories and missing paths', async () => {
  assert.equal(await pathExists(repoRoot, 'src/native/yaml.js'), true)
  assert.equal(await pathExists(repoRoot, 'src/native'), true)
  assert.equal(await pathExists(repoRoot, 'nope'), false)
  assert.equal(await isFile(repoRoot, 'src/native/yaml.js'), true)
  assert.equal(await isFile(repoRoot, 'src/native'), false)
  assert.equal(await isFile(repoRoot, 'nope'), false)
})

test('write/remove/move reject paths outside the workspace before writing', async () => {
  await assert.rejects(() => writeText(repoRoot, '../escape.txt', 'x'), /escapes the workspace root/)
  await assert.rejects(() => writeText(repoRoot, 'C:/tmp/escape.txt', 'x'), /workspace-relative/)
  await assert.rejects(() => writeText(repoRoot, '', 'x'), /refusing to operate on the workspace root/)
  await assert.rejects(() => removePath(repoRoot, '../escape'), /escapes the workspace root/)
  await assert.rejects(() => removePath(repoRoot, '.'), /refusing to operate on the workspace root/)
  await assert.rejects(() => movePath(repoRoot, 'src/native/yaml.js', '../escape.md'), /escapes the workspace root/)
  await assert.rejects(() => movePath(repoRoot, '../escape.md', 'src/escape.md'), /escapes the workspace root/)
})
