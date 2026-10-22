/**
 * Structural guard for the browser bundle.
 *
 * The client half has no DOM test harness, so a lost closure in a refactor
 * only shows up at runtime as a ReferenceError. That happened in 0.10.0: the
 * quick bar kept its `onSubmit: () => void submitPropose(value)` JSX while the
 * two submit closures were dropped from `DockBody`, so「开始提案」in the
 * composer/hero quick bar threw `submitPropose is not defined` and did nothing.
 *
 * These assertions pin the shape that keeps both seats wired to exactly one
 * shared implementation (`createDialogSubmitters`).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')

/** Slice one top-level component/function body out of the client source. */
function topLevelFunctionSource(name) {
  const start = clientSource.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `src/client.js must define ${name}()`)
  const next = clientSource.indexOf('\n  function ', start + 1)
  return next === -1 ? clientSource.slice(start) : clientSource.slice(start, next)
}

test('the dialog submit handlers have exactly one shared implementation', () => {
  const definitions = [...clientSource.matchAll(/function createDialogSubmitters\s*\(/g)].length
  const calls = [...clientSource.matchAll(/=\s*createDialogSubmitters\s*\(\{/g)].length
  assert.equal(definitions, 1, 'createDialogSubmitters() must be defined exactly once')
  assert.equal(calls, 2, 'the panel and the quick bar must both call createDialogSubmitters()')
})

test('the panel (WorkspaceDetail) wires both dialog submitters', () => {
  const workspaceDetail = topLevelFunctionSource('WorkspaceDetail')
  assert.match(workspaceDetail, /createDialogSubmitters\(\{/, 'WorkspaceDetail must build the submit handlers')
  assert.match(workspaceDetail, /void submitPropose\(value\)/, 'the propose dialog must call submitPropose')
  assert.match(workspaceDetail, /void submitExplore\(topic\)/, 'the explore dialog must call submitExplore')
})

test('the quick bar (DockBody) wires both dialog submitters', () => {
  const dockBody = topLevelFunctionSource('DockBody')
  assert.match(dockBody, /createDialogSubmitters\(\{/, 'DockBody must build the submit handlers')
  assert.match(dockBody, /void submitPropose\(value\)/, 'the hero/dock propose dialog must call submitPropose')
  assert.match(dockBody, /void submitExplore\(topic\)/, 'the hero/dock explore dialog must call submitExplore')
})
