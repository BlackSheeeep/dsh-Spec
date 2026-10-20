/**
 * Tests for src/native/metadata.js.
 *
 * Run: node --test --test-isolation=none tests/native-metadata.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  formatLocalDate,
  parseChangeMetadata,
  readChangeMetadata,
  resolveSchemaName,
  serializeChangeMetadata,
} from '../src/native/metadata.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('parses known metadata keys', () => {
  const text = ['schema: research-first', 'created: 2026-10-20', 'goal: Ship the native engine.'].join('\n')
  const result = parseChangeMetadata(text)
  assert.equal(result.error, null)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.value, {
    schema: 'research-first',
    created: '2026-10-20',
    goal: 'Ship the native engine.',
  })
})

test('invalid created is an error with a line number', () => {
  const result = parseChangeMetadata('schema: spec-driven\ncreated: 2026/10/20\n')
  assert.notEqual(result.error, null)
  assert.equal(result.error.line, 2)
  assert.match(result.error.message, /"created" must be a YYYY-MM-DD date/)
})

test('invalid schema and non-boolean flags are errors', () => {
  const schema = parseChangeMetadata('schema: 5\n')
  assert.match(schema.error.message, /"schema" must be a non-empty string/)
  assert.equal(schema.error.line, 1)

  const flag = parseChangeMetadata('skip_specs: "yes"\n')
  assert.match(flag.error.message, /"skip_specs" must be a boolean/)
  assert.equal(flag.error.line, 1)
})

test('unknown keys warn, x- extension keys are accepted silently', () => {
  const result = parseChangeMetadata(
    ['schema: spec-driven', 'owner: team-a', 'x-team: platform'].join('\n'),
  )
  assert.equal(result.error, null)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /unknown change metadata key "owner" \(line 2\)/)
  assert.equal(result.value['x-team'], 'platform')
})

test('invalid YAML is reported as an error', () => {
  const result = parseChangeMetadata('schema: [unclosed\n')
  assert.notEqual(result.error, null)
  assert.match(result.error.message, /invalid YAML/)
})

test('readChangeMetadata handles missing and present metadata files', async () => {
  const missing = await readChangeMetadata(repoRoot, 'openspec/changes/does-not-exist')
  assert.equal(missing.found, false)
  assert.deepEqual(missing.metadata, {
    schema: null,
    created: null,
    goal: null,
    skip_specs: false,
    retire_capabilities: false,
  })
  assert.deepEqual(missing.warnings, [])
  assert.equal(missing.error, null)
})

test('resolveSchemaName follows change > project > default precedence', () => {
  assert.equal(
    resolveSchemaName({
      changeMetadata: { schema: 'research-first' },
      projectConfig: { schema: 'project-schema' },
    }),
    'research-first',
  )
  assert.equal(resolveSchemaName({ changeMetadata: {}, projectConfig: { schema: 'project-schema' } }), 'project-schema')
  assert.equal(resolveSchemaName({ changeMetadata: null, projectConfig: null }), 'spec-driven')
  assert.equal(
    resolveSchemaName({ changeMetadata: { schema: 42 }, projectConfig: { schema: '' }, fallback: 'fallback' }),
    'fallback',
  )
})

test('formatLocalDate uses local calendar fields', () => {
  assert.equal(formatLocalDate(new Date(2026, 9, 20)), '2026-10-20')
  assert.equal(formatLocalDate(new Date(2026, 0, 5)), '2026-01-05')
  assert.match(formatLocalDate(), /^\d{4}-\d{2}-\d{2}$/)
})

test('serializeChangeMetadata is stable and round-trips through the parser', () => {
  const text = serializeChangeMetadata({
    schema: 'spec-driven',
    created: '2026-10-20',
    goal: '让插件读取原生语义。',
  })
  assert.equal(
    text,
    ['schema: spec-driven', 'created: 2026-10-20', 'goal: 让插件读取原生语义。', ''].join('\n'),
  )
  const parsed = parseChangeMetadata(text)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.value, {
    schema: 'spec-driven',
    created: '2026-10-20',
    goal: '让插件读取原生语义。',
  })
})

test('serializeChangeMetadata quotes unsafe scalars and skips empty fields', () => {
  const text = serializeChangeMetadata({ schema: 'x', created: '2026-01-01', goal: 'a: b # c' })
  assert.match(text, /goal: "a: b # c"\n$/)
  assert.equal(serializeChangeMetadata({}), '')
  assert.equal(serializeChangeMetadata({ schema: 'spec-driven' }), 'schema: spec-driven\n')
})
