/**
 * Tests for src/native/config.js.
 *
 * Run: node --test --test-isolation=none tests/native-config.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseProjectConfig, readProjectConfig } from '../src/native/config.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('parses schema, context, rules and operations', () => {
  const text = [
    'schema: research-first',
    'context: |',
    '  We build a Node.js plugin.',
    '  Keep changes small.',
    'rules:',
    '  proposal:',
    '    - mention risks',
    '    - mention alternatives',
    '  design: single rule',
    'operations:',
    '  apply:',
    '    guidance: Tick tasks as you go.',
    '  archive:',
    '    guidance: Sync specs first.',
  ].join('\n')
  const config = parseProjectConfig(text)
  assert.equal(config.found, true)
  assert.equal(config.file, 'config.yaml')
  assert.equal(config.schema, 'research-first')
  assert.equal(config.context, 'We build a Node.js plugin.\nKeep changes small.\n')
  assert.deepEqual(config.rules, {
    proposal: ['mention risks', 'mention alternatives'],
    design: ['single rule'],
  })
  assert.deepEqual(config.operations, {
    apply: { guidance: 'Tick tasks as you go.' },
    archive: { guidance: 'Sync specs first.' },
  })
  assert.deepEqual(config.warnings, [])
})

test('missing or invalid schema fields fall back to spec-driven with a warning', () => {
  const missing = parseProjectConfig('context: hi\n')
  assert.equal(missing.schema, 'spec-driven')
  assert.deepEqual(missing.warnings, [])

  const invalid = parseProjectConfig('schema: 42\n')
  assert.equal(invalid.schema, 'spec-driven')
  assert.equal(invalid.warnings.length, 1)
  assert.match(invalid.warnings[0], /"schema" must be a non-empty string/)

  const empty = parseProjectConfig('schema: ""\n')
  assert.equal(empty.schema, 'spec-driven')
  assert.match(empty.warnings[0], /"schema"/)
})

test('drops empty and non-string rule entries with warnings', () => {
  const config = parseProjectConfig(
    ['rules:', '  proposal:', '    - keep', '    - ', '    - 3', '  broken: 4', '  weird: [1, a]'].join('\n'),
  )
  assert.deepEqual(config.rules, { proposal: ['keep'], weird: ['a'] })
  assert.equal(config.warnings.filter((warning) => warning.includes('dropping')).length, 3)
  assert.ok(config.warnings.some((warning) => warning.includes('"broken"')))
})

test('rejects non-mapping rules and operations with warnings', () => {
  const config = parseProjectConfig('rules: nope\noperations: nope\n')
  assert.deepEqual(config.rules, {})
  assert.deepEqual(config.operations, {})
  assert.equal(config.warnings.length, 2)
  assert.match(config.warnings[0], /"rules" must be a mapping/)
  assert.match(config.warnings[1], /"operations" must be a mapping/)
})

test('invalid YAML yields defaults, found:true and a file/line warning', () => {
  const config = parseProjectConfig('schema: spec-driven\nbad:\n\tindented\n', 'config.yaml')
  assert.equal(config.found, true)
  assert.equal(config.schema, 'spec-driven')
  assert.equal(config.context, '')
  assert.deepEqual(config.rules, {})
  assert.equal(config.warnings.length, 1)
  assert.match(config.warnings[0], /^config\.yaml:3: invalid YAML:/)
})

test('context larger than 51200 bytes is ignored with a warning', () => {
  const big = parseProjectConfig(`schema: spec-driven\ncontext: ${'x'.repeat(51201)}\n`)
  assert.equal(big.context, '')
  assert.equal(big.schema, 'spec-driven')
  assert.equal(big.warnings.length, 1)
  assert.match(big.warnings[0], /larger than 51200 bytes/)

  const boundary = parseProjectConfig(`context: ${'x'.repeat(51200)}\n`)
  assert.equal(boundary.context, 'x'.repeat(51200))
  assert.deepEqual(boundary.warnings, [])
})

test('non-string context is ignored with a warning', () => {
  const config = parseProjectConfig('context: [a, b]\n')
  assert.equal(config.context, '')
  assert.match(config.warnings[0], /"context" must be a string/)
})

test('readProjectConfig reports a missing configuration without warnings', async () => {
  const config = await readProjectConfig(repoRoot)
  assert.equal(config.found, false)
  assert.equal(config.file, null)
  assert.equal(config.schema, 'spec-driven')
  assert.equal(config.context, '')
  assert.deepEqual(config.rules, {})
  assert.deepEqual(config.operations, {})
  assert.deepEqual(config.warnings, [])
})
