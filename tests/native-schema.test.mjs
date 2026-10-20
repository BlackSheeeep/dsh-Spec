/**
 * Tests for src/native/schema.js — glob compilation, schema parsing, project vs
 * bundled resolution and template reading.
 *
 * Run: node --test --test-isolation=none tests/native-schema.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  globToRegExp,
  loadBundledSchemas,
  loadProjectSchemas,
  matchGlob,
  parseSchema,
  readArtifactTemplate,
  resolveSchema,
} from '../src/native/schema.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('globToRegExp supports *, **, ? and {a,b}', () => {
  assert.equal(matchGlob('*.md', 'proposal.md'), true)
  assert.equal(matchGlob('*.md', 'specs/proposal.md'), false)
  assert.equal(matchGlob('specs/*.md', 'specs/a.md'), true)
  assert.equal(matchGlob('specs/*.md', 'specs/x/a.md'), false)
  assert.equal(matchGlob('specs/**/*.md', 'specs/a.md'), true)
  assert.equal(matchGlob('specs/**/*.md', 'specs/a/b/c.md'), true)
  assert.equal(matchGlob('specs/**/*.md', 'specs/a/b/c.txt'), false)
  assert.equal(matchGlob('specs/**', 'specs/a/b/c.md'), true)
  assert.equal(matchGlob('design.{md,txt}', 'design.md'), true)
  assert.equal(matchGlob('design.{md,txt}', 'design.txt'), true)
  assert.equal(matchGlob('design.{md,txt}', 'design.pdf'), false)
  assert.equal(matchGlob('file?.md', 'file1.md'), true)
  assert.equal(matchGlob('file?.md', 'file10.md'), false)
  assert.equal(matchGlob('task.md', 'task.md'), true)
  assert.equal(matchGlob('task.md', 'tasks.md'), false)
  assert.equal(matchGlob('a+b.md', 'a+b.md'), true)
  assert.equal(globToRegExp('specs/**/*.md') instanceof RegExp, true)
})

test('parseSchema builds the native schema shape', () => {
  const text = [
    'name: research-first',
    'version: 2',
    'description: Research before planning',
    'artifacts:',
    '  - id: research',
    '    generates: research.md',
    '    description: Research notes',
    '    template: research.md',
    '    instruction: |',
    '      Gather evidence.',
    '    requires: []',
    '  - id: specs',
    "    generates: 'specs/**/*.md'",
    '    requires: [research]',
    'apply:',
    '  requires: [specs]',
    '  tracks: research.md',
    '  instruction: Work through research.md.',
  ].join('\n')
  const { schema, issues } = parseSchema(text, { sourceName: 'openspec/schemas/research-first/schema.yaml' })
  assert.deepEqual(issues, [])
  assert.equal(schema.name, 'research-first')
  assert.equal(schema.version, 2)
  assert.equal(schema.description, 'Research before planning')
  assert.deepEqual(schema.artifacts[0], {
    id: 'research',
    generates: 'research.md',
    description: 'Research notes',
    template: 'research.md',
    instruction: 'Gather evidence.\n',
    requires: [],
  })
  assert.equal(schema.artifacts[1].generates, 'specs/**/*.md')
  assert.deepEqual(schema.artifacts[1].requires, ['research'])
  assert.deepEqual(schema.apply, {
    requires: ['specs'],
    tracks: 'research.md',
    instruction: 'Work through research.md.',
  })
})

test('parseSchema defaults the apply contract and tolerates missing optional fields', () => {
  const { schema, issues } = parseSchema('name: minimal\nartifacts: []\n')
  assert.deepEqual(issues, [])
  assert.deepEqual(schema.apply, { requires: [], tracks: null, instruction: '' })
  assert.equal(schema.version, null)
})

test('parseSchema reports invalid YAML with a path and line', () => {
  const { schema, issues } = parseSchema('name: [unclosed\n', { sourceName: 'bad.yaml' })
  assert.deepEqual(schema.artifacts, [])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].level, 'ERROR')
  assert.equal(issues[0].path, 'bad.yaml')
  assert.equal(issues[0].line, 1)
  assert.match(issues[0].message, /schema YAML is invalid/)
})

test('parseSchema reports malformed artifacts and apply fields', () => {
  const text = [
    'artifacts:',
    '  - generates: orphan.md',
    '  - id: ok',
    '    generates: ok.md',
    '    requires: nope',
    'apply:',
    '  tracks: 5',
  ].join('\n')
  const { schema, issues } = parseSchema(text)
  assert.equal(schema.artifacts.length, 1)
  assert.equal(schema.artifacts[0].id, 'ok')
  assert.ok(issues.some((issue) => issue.level === 'ERROR' && /missing a non-empty "id"/.test(issue.message)))
  assert.ok(issues.some((issue) => issue.level === 'WARNING' && /"requires" must be a sequence/.test(issue.message)))
  assert.ok(issues.some((issue) => issue.level === 'WARNING' && /apply\.tracks/.test(issue.message)))
  assert.ok(issues.some((issue) => issue.level === 'WARNING' && /"name"/.test(issue.message)))
})

test('parseSchema accepts array generates and filters empty entries', () => {
  const { schema } = parseSchema(
    ['name: multi', 'artifacts:', '  - id: docs', '    generates: [a.md, b.md]'].join('\n'),
  )
  assert.deepEqual(schema.artifacts[0].generates, ['a.md', 'b.md'])
})

test('loadBundledSchemas exposes the pinned spec-driven snapshot', () => {
  const bundled = loadBundledSchemas()
  assert.ok(bundled.has('spec-driven'))
  const entry = bundled.get('spec-driven')
  assert.equal(entry.source, 'builtin')
  assert.equal(entry.schema.name, 'spec-driven')
  assert.deepEqual(
    entry.schema.artifacts.map((artifact) => artifact.id),
    ['proposal', 'specs', 'design', 'tasks'],
  )
})

test('resolveSchema prefers project schemas and records the snapshot version', () => {
  const projectSchema = { name: 'spec-driven', description: 'local', artifacts: [], apply: {} }
  const project = resolveSchema({
    name: 'spec-driven',
    projectSchemas: [{ schema: projectSchema, source: 'project', dir: 'openspec/schemas/spec-driven' }],
  })
  assert.equal(project.source, 'project')
  assert.equal(project.schema, projectSchema)
  assert.deepEqual(project.issues, [])

  const builtin = resolveSchema({ name: 'spec-driven', projectSchemas: [] })
  assert.equal(builtin.source, 'builtin')
  assert.equal(builtin.schema.sourceVersion, '1.14.3')

  const unknown = resolveSchema({ name: 'missing-schema', projectSchemas: [] })
  assert.equal(unknown.schema, null)
  assert.equal(unknown.source, null)
  assert.equal(unknown.issues[0].level, 'ERROR')
  assert.match(unknown.issues[0].message, /schema "missing-schema" was not found/)
})

test('readArtifactTemplate reads bundled templates and reports missing ones', async () => {
  const builtin = resolveSchema({ name: 'spec-driven', projectSchemas: [] })
  const template = await readArtifactTemplate(repoRoot, builtin, builtin.schema.artifacts[0])
  assert.equal(typeof template, 'string')
  assert.match(template, /## Why/)

  assert.equal(await readArtifactTemplate(repoRoot, builtin, { template: null }), null)
  assert.equal(await readArtifactTemplate(repoRoot, builtin, { template: 'does-not-exist.md' }), null)
  assert.equal(await readArtifactTemplate(repoRoot, null, { template: 'proposal.md' }), null)
  assert.equal(await readArtifactTemplate(repoRoot, builtin, { template: '../escape.md' }), null)
})

test('readArtifactTemplate resolves project-local templates through the workspace', async () => {
  const resolved = {
    source: 'project',
    dir: 'openspec/schemas/research-first',
    schema: { name: 'research-first', artifacts: [] },
  }
  // The repository has no project schema, so the file is missing but the read is graceful.
  assert.equal(await readArtifactTemplate(repoRoot, resolved, { template: 'research.md' }), null)
})

test('loadProjectSchemas returns an empty list when the project has no schemas', async () => {
  const result = await loadProjectSchemas(repoRoot)
  assert.deepEqual(result.schemas, [])
  assert.deepEqual(result.issues, [])
})
