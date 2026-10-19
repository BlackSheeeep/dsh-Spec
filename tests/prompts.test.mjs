/**
 * Tests for the shared OpenSpec state logic (src/prompts.js).
 * Run: node --test tests/prompts.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTasks, derivePhase, slugify, firstToken, restAfterFirstToken } from '../src/prompts.js'

test('parseTasks counts open and checked checkboxes', () => {
  const text = [
    '# Tasks',
    '- [ ] 1.1 first',
    '- [x] 1.2 second',
    '  - [X] 1.3 nested checked',
    '* [ ] 2.1 star bullet',
    'not a task',
    '- [ ]',
  ].join('\n')
  assert.deepEqual(parseTasks(text), { total: 4, done: 2 })
})

test('parseTasks tolerates empty and CRLF text', () => {
  assert.deepEqual(parseTasks(''), { total: 0, done: 0 })
  assert.deepEqual(parseTasks('- [ ] a\r\n- [x] b\r\n'), { total: 2, done: 1 })
})

test('derivePhase follows the documented workflow', () => {
  assert.equal(derivePhase({ hasProposal: false, hasSpecs: false, tasks: null }), 'draft')
  assert.equal(derivePhase({ hasProposal: true, hasSpecs: false, tasks: null }), 'proposed')
  assert.equal(derivePhase({ hasProposal: false, hasSpecs: true, tasks: null }), 'proposed')
  assert.equal(derivePhase({ hasProposal: true, hasSpecs: true, tasks: { total: 0, done: 0 } }), 'proposed')
  assert.equal(derivePhase({ hasProposal: true, hasSpecs: true, tasks: { total: 5, done: 2 } }), 'apply')
  assert.equal(derivePhase({ hasProposal: true, hasSpecs: true, tasks: { total: 5, done: 5 } }), 'ready')
})

test('slugify produces kebab change names and rejects junk', () => {
  assert.equal(slugify('Add Dark Mode!'), 'add-dark-mode')
  assert.equal(slugify('  已有 中文  '), '')
  assert.equal(slugify('add-rate-limiting'), 'add-rate-limiting')
})

test('firstToken and restAfterFirstToken split raw command input', () => {
  assert.equal(firstToken('add-dark-mode 支持深色主题'), 'add-dark-mode')
  assert.equal(restAfterFirstToken('add-dark-mode 支持深色主题'), '支持深色主题')
  assert.equal(firstToken('  solo  '), 'solo')
  assert.equal(restAfterFirstToken('solo'), '')
})
