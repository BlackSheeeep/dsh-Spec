/**
 * Tests for src/native/tasks.js — native tasks.md parity.
 *
 * Run: node --test --test-isolation=none tests/native-tasks.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTasks } from '../src/native/tasks.js'

test('counts mixed bullet and marker forms with native rules', () => {
  const text = [
    '# Tasks',
    '- [x] 1.1 done',
    '* [ ] 1.2 open',
    '+ [~] 1.3 unusual marker',
    '- [ ] 1.4 open',
  ].join('\n')
  const parsed = parseTasks(text)
  assert.equal(parsed.total, 4)
  assert.equal(parsed.done, 1)
  assert.deepEqual(
    parsed.items.map((item) => ({ id: item.id, done: item.done })),
    [
      { id: '1.1', done: true },
      { id: '1.2', done: false },
      { id: '1.3', done: false },
      { id: '1.4', done: false },
    ],
  )
  assert.equal(parsed.issues.length, 1)
  assert.equal(parsed.issues[0].level, 'WARNING')
  assert.equal(parsed.issues[0].line, 4)
  assert.match(parsed.issues[0].message, /unusual task marker "\[~\]"/)
})

test('accepts uppercase and spaced markers', () => {
  const parsed = parseTasks('- [X] a\n- [ x] b\n- [x ] c\n- [ X ] d\n')
  assert.equal(parsed.total, 4)
  assert.equal(parsed.done, 4)
  assert.deepEqual(parsed.issues, [])
})

test('empty checkboxes count as unfinished tasks', () => {
  const parsed = parseTasks('- [ ]\n- []\n')
  assert.equal(parsed.total, 2)
  assert.equal(parsed.done, 0)
  // `[]` is an unusual marker (outside `[ ]`), `[ ]` is the native empty box.
  assert.equal(parsed.issues.length, 1)
  assert.match(parsed.issues[0].message, /unusual task marker "\[\]"/)
})

test('link bullets are not tasks', () => {
  const text = ['- [docs](https://example.com)', '- [ ] 1.1 real task', '* [specs](./specs/a/spec.md)'].join('\n')
  const parsed = parseTasks(text)
  assert.equal(parsed.total, 1)
  assert.equal(parsed.done, 0)
  assert.equal(parsed.items[0].id, '1.1')
})

test('preserves task ids and text', () => {
  const parsed = parseTasks('- [ ] 2.3 implement the engine\n- [x] 12.4 unnumbered details\n- [ ] plain task\n')
  assert.deepEqual(
    parsed.items.map((item) => ({ id: item.id, text: item.text })),
    [
      { id: '2.3', text: '2.3 implement the engine' },
      { id: '12.4', text: '12.4 unnumbered details' },
      { id: null, text: 'plain task' },
    ],
  )
})

test('nesting depth comes from two-space indentation, capped at three', () => {
  const parsed = parseTasks(
    ['- [ ] root', '  - [ ] one', '    - [ ] two', '      - [ ] three', '        - [ ] four'].join('\n'),
  )
  assert.deepEqual(
    parsed.items.map((item) => item.depth),
    [0, 1, 2, 3, 3],
  )
})

test('tolerates CRLF, BOM and empty text', () => {
  assert.deepEqual(parseTasks('').total, 0)
  assert.deepEqual(parseTasks(null).total, 0)
  const parsed = parseTasks('\uFEFF- [ ] a\r\n- [x] b\r\n')
  assert.equal(parsed.total, 2)
  assert.equal(parsed.done, 1)
})

test('ignores prose and headings that look like checkboxes', () => {
  const parsed = parseTasks(['# [ ] heading', 'text [ ] inline', '1. [ ] ordered list', '> - [ ] quote'].join('\n'))
  assert.equal(parsed.total, 0)
})
