/**
 * Tests for src/native/tasks.js — native tasks.md parity.
 *
 * Run: node --test --test-isolation=none tests/native-tasks.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { isManualTask, parseTasks, toggleTaskLine } from '../src/native/tasks.js'

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

test('records 1-based source lines and flags [人工验收] tasks', () => {
  const text = ['# Tasks', '', '- [ ] 1.1 [人工验收] verify in the browser', '  - [x] 1.2 【人工验收】check logs', '- [ ] 1.3 automated step'].join('\n')
  const parsed = parseTasks(text)
  assert.deepEqual(
    parsed.items.map((item) => ({ id: item.id, line: item.line, manual: item.manual, done: item.done })),
    [
      { id: '1.1', line: 3, manual: true, done: false },
      { id: '1.2', line: 4, manual: true, done: true },
      { id: '1.3', line: 5, manual: false, done: false },
    ],
  )
  assert.equal(isManualTask('manual [人工验收] step'), true)
  assert.equal(isManualTask('ordinary step'), false)
})

test('toggleTaskLine writes only the requested checkbox and preserves everything else', () => {
  const text = ['# Tasks', '', '- [ ] 1.1 [人工验收] verify', '  * [x] 1.2 done', '- [docs](https://example.com)'].join('\n')
  const checked = toggleTaskLine(text, 3, true)
  assert.equal(checked.text, ['# Tasks', '', '- [x] 1.1 [人工验收] verify', '  * [x] 1.2 done', '- [docs](https://example.com)'].join('\n'))
  assert.equal(checked.line, 3)
  assert.equal(checked.done, true)
  assert.equal(checked.manual, true)

  const unchecked = toggleTaskLine(checked.text, 4, false)
  assert.equal(unchecked.text, ['# Tasks', '', '- [x] 1.1 [人工验收] verify', '  * [ ] 1.2 done', '- [docs](https://example.com)'].join('\n'))

  // Stale line numbers and link bullets are refused instead of guessed.
  assert.throws(() => toggleTaskLine(text, 5, true), /链接/)
  assert.throws(() => toggleTaskLine(text, 2, true), /不是任务复选框/)
  assert.throws(() => toggleTaskLine(text, 99, true), /超出/)
  assert.throws(() => toggleTaskLine(text, 0, true), /行号无效/)
})
