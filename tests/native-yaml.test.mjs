/**
 * Tests for src/native/yaml.js — the dependency-free YAML subset parser.
 *
 * Run: node --test --test-isolation=none tests/native-yaml.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseYaml } from '../src/native/yaml.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('parses a flat mapping with scalars, comments and empty values', () => {
  const text = [
    '# top comment',
    'schema: spec-driven',
    'empty:',
    'flag: true',
    'other: FALSE',
    'nothing: null',
    'tilde: ~',
    'count: 3',
    'ratio: 1.5',
    'negative: -2',
    'quoted: "hello \\"world\\""',
    'single: \'it\'\'s\'',
    'inline: value # trailing comment',
    'url: https://example.com/a#b',
  ].join('\n')
  const result = parseYaml(text)
  assert.equal(result.error, null)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.value, {
    schema: 'spec-driven',
    empty: null,
    flag: true,
    other: false,
    nothing: null,
    tilde: null,
    count: 3,
    ratio: 1.5,
    negative: -2,
    quoted: 'hello "world"',
    single: "it's",
    inline: 'value',
    url: 'https://example.com/a#b',
  })
})

test('parses nested mappings and sequences', () => {
  const text = [
    'openspec:',
    '  schema: spec-driven',
    '  rules:',
    '    proposal:',
    '      - keep it short',
    '      - mention risks',
    '    tasks: one rule',
    'list:',
    '  - a',
    '  - b',
    '  -',
    'same_indent:',
    '- x',
    '- y',
  ].join('\n')
  const result = parseYaml(text)
  assert.equal(result.error, null)
  assert.deepEqual(result.value, {
    openspec: {
      schema: 'spec-driven',
      rules: { proposal: ['keep it short', 'mention risks'], tasks: 'one rule' },
    },
    list: ['a', 'b', null],
    same_indent: ['x', 'y'],
  })
})

test('parses a sequence of mappings (native schema.yaml shape)', () => {
  const text = [
    'name: spec-driven',
    'version: 1',
    'artifacts:',
    '  - id: proposal',
    '    generates: proposal.md',
    '    requires: []',
    '    instruction: |',
    '      Write the proposal.',
    '      Keep it short.',
    '  - id: design',
    '    generates: design.md',
    '    requires: [proposal]',
  ].join('\n')
  const result = parseYaml(text)
  assert.equal(result.error, null)
  assert.equal(result.value.name, 'spec-driven')
  assert.equal(result.value.artifacts.length, 2)
  assert.deepEqual(result.value.artifacts[0], {
    id: 'proposal',
    generates: 'proposal.md',
    requires: [],
    instruction: 'Write the proposal.\nKeep it short.\n',
  })
  assert.deepEqual(result.value.artifacts[1].requires, ['proposal'])
})

test('parses literal and folded block scalars with chomping', () => {
  const text = [
    'literal: |',
    '  line one',
    '  line two',
    '',
    '  after blank',
    'folded: >',
    '  one',
    '  two',
    '',
    '  three',
    'strip: |-',
    '  keep',
    'keep: |+',
    '  keep trailing',
    '',
    '',
    'next: value',
  ].join('\n')
  const result = parseYaml(text)
  assert.equal(result.error, null)
  assert.equal(result.value.literal, 'line one\nline two\n\nafter blank\n')
  assert.equal(result.value.folded, 'one two\nthree\n')
  assert.equal(result.value.strip, 'keep')
  assert.equal(result.value.keep, 'keep trailing\n\n\n')
  assert.equal(result.value.next, 'value')
})

test('parses flow collections including nested and quoted entries', () => {
  const text = [
    'array: [a, "b c", 3, true, null]',
    'nested: [1, [2, 3], {a: b}]',
    'object: {id: proposal, requires: [specs, design], empty: {}}',
    'braces: specs/**/*.md',
  ].join('\n')
  const result = parseYaml(text)
  assert.equal(result.error, null)
  assert.deepEqual(result.value.array, ['a', 'b c', 3, true, null])
  assert.deepEqual(result.value.nested, [1, [2, 3], { a: 'b' }])
  assert.deepEqual(result.value.object, { id: 'proposal', requires: ['specs', 'design'], empty: {} })
  assert.equal(result.value.braces, 'specs/**/*.md')
})

test('strips a UTF-8 BOM and tolerates CRLF and document markers', () => {
  const text = '\uFEFF---\r\nschema: spec-driven\r\nvalue: 1\r\n...\r\n'
  const result = parseYaml(text)
  assert.equal(result.error, null)
  assert.deepEqual(result.value, { schema: 'spec-driven', value: 1 })
})

test('empty document and comment-only document produce null without error', () => {
  assert.deepEqual(parseYaml(''), { value: null, warnings: [], error: null })
  assert.deepEqual(parseYaml('# only a comment\n'), { value: null, warnings: [], error: null })
  assert.deepEqual(parseYaml('\n\n'), { value: null, warnings: [], error: null })
})

test('duplicate keys warn and the last value wins', () => {
  const result = parseYaml('key: one\nkey: two\n')
  assert.equal(result.error, null)
  assert.equal(result.value.key, 'two')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /line 2: duplicate key "key"/)
})

test('unsupported structures report errors with 1-based line numbers', () => {
  const anchor = parseYaml('key: &anchor value\n')
  assert.equal(anchor.value, null)
  assert.equal(anchor.error.line, 1)
  assert.match(anchor.error.message, /anchors and aliases are not supported/)

  const alias = parseYaml('first: 1\nsecond: *first\n')
  assert.equal(alias.error.line, 2)
  assert.match(alias.error.message, /anchors and aliases are not supported/)

  const merge = parseYaml('<<: {a: b}\n')
  assert.equal(merge.error.line, 1)
  assert.match(merge.error.message, /merge keys/)

  const multiLineFlow = parseYaml('list: [a,\n  b]\n')
  assert.match(multiLineFlow.error.message, /multi-line flow collections are not supported/)
  assert.equal(multiLineFlow.error.line, 1)

  const tag = parseYaml('key: !!str value\n')
  assert.equal(tag.error.line, 1)
  assert.match(tag.error.message, /tags are not supported/)
})

test('indentation mistakes report the offending line', () => {
  const tab = parseYaml('key:\n\tvalue: 1\n')
  assert.equal(tab.error.line, 2)
  assert.match(tab.error.message, /tab characters/)

  const inconsistent = parseYaml('a: 1\n  b: 2\n')
  assert.equal(inconsistent.error.line, 2)
  assert.match(inconsistent.error.message, /indentation/)

  const strayTopLevel = parseYaml('a: 1\n   b: 2\n')
  assert.notEqual(strayTopLevel.error, null)

  const notAMapping = parseYaml('a: 1\nunexpected content here\n')
  assert.notEqual(notAMapping.error, null)

  const unclosedQuote = parseYaml('a: "unclosed\n')
  assert.equal(unclosedQuote.error.line, 1)
  assert.match(unclosedQuote.error.message, /unterminated quoted string/)
})

test('parses the real bundled native schema snapshot', (t) => {
  const schemaPath = path.join(repoRoot, 'src', 'native-snapshot', 'spec-driven', 'schema.yaml')
  if (!existsSync(schemaPath)) {
    t.skip('bundled snapshot is not present yet')
    return
  }
  const result = parseYaml(readFileSync(schemaPath, 'utf8'))
  assert.equal(result.error, null)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.value.name, 'spec-driven')
  assert.deepEqual(
    result.value.artifacts.map((artifact) => artifact.id),
    ['proposal', 'specs', 'design', 'tasks'],
  )
  for (const artifact of result.value.artifacts) {
    assert.equal(typeof artifact.instruction, 'string')
    assert.ok(artifact.instruction.length > 0)
  }
  assert.deepEqual(result.value.apply.requires, ['tasks'])
  assert.equal(result.value.apply.tracks, 'tasks.md')
})
