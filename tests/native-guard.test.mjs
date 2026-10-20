/**
 * Guard tests: the native engine must compute everything in process, without
 * spawning subprocesses and without using the network (tasks.md 1.12).
 *
 * Two complementary guards:
 * 1. static: engine module sources may only import relative or `node:` modules
 *    and must never reference process-spawning / networking modules;
 * 2. runtime: `child_process`, `http`, `https`, `net` and `fetch` entry points
 *    are replaced with throwing stubs and the engine entry points are executed —
 *    any use would throw and be recorded.
 *
 * Run: node --test --test-isolation=none tests/native-guard.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import childProcess from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

import { parseYaml } from '../src/native/yaml.js'
import { parseProjectConfig } from '../src/native/config.js'
import { parseChangeMetadata } from '../src/native/metadata.js'
import { loadBundledSchemas, parseSchema, resolveSchema } from '../src/native/schema.js'
import { computeArtifactStates, validateSchemaGraph } from '../src/native/graph.js'
import { parseDeltaSpec, parseMainSpec } from '../src/native/spec.js'
import { parseTasks } from '../src/native/tasks.js'
import { validateChange, validateMainSpec } from '../src/native/validate.js'
import { computeWorkspaceState, validateChangeByName } from '../src/native/state.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(repoRoot, '..')
const hasWorkspace = existsSync(path.join(workspaceRoot, 'openspec', 'changes'))

const ENGINE_MODULES = [
  'fsio.js',
  'yaml.js',
  'config.js',
  'metadata.js',
  'schema.js',
  'graph.js',
  'spec.js',
  'tasks.js',
  'validate.js',
  'state.js',
]

const FORBIDDEN_MODULES = [
  'child_process',
  'node:child_process',
  'node:cluster',
  'node:dgram',
  'node:dns',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:worker_threads',
]

test('static guard: engine modules import only node: builtins and relative files', async () => {
  for (const moduleName of ENGINE_MODULES) {
    const source = await readFile(path.join(repoRoot, 'src', 'native', moduleName), 'utf8')
    const specifiers = []
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1])
    for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1])
    // yaml.js is intentionally dependency-free; other modules must only import engine files / node: builtins.
    for (const specifier of specifiers) {
      const allowed = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:')
      assert.equal(allowed, true, `${moduleName} imports non-engine module "${specifier}"`)
      assert.equal(
        FORBIDDEN_MODULES.includes(specifier),
        false,
        `${moduleName} imports forbidden module "${specifier}"`,
      )
    }
    assert.equal(
      /\bfetch\s*\(/.test(source),
      false,
      `${moduleName} must not call fetch()`,
    )
    assert.equal(
      /\bimport\s*\(\s*['"](?:node:)?(?:http|https|net|child_process)/.test(source),
      false,
      `${moduleName} must not dynamically import networking/spawning modules`,
    )
  }
})

/** Install throwing stubs for process/network entry points. */
function installForbiddenStubs() {
  /** @type {string[]} */
  const calls = []
  /** @type {Array<() => void>} */
  const restorers = []
  /** @param {object} target @param {string} key */
  const stub = (target, key) => {
    const original = target[key]
    if (typeof original !== 'function') return
    target[key] = (...args) => {
      void args
      calls.push(`${key}()`)
      throw new Error(`engine attempted forbidden call ${key}()`)
    }
    restorers.push(() => {
      target[key] = original
    })
  }

  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    stub(childProcess, key)
  }
  for (const key of ['request', 'get']) {
    stub(http, key)
    stub(https, key)
  }
  for (const key of ['connect', 'createConnection']) stub(net, key)

  const originalFetch = globalThis.fetch
  globalThis.fetch = () => {
    calls.push('fetch()')
    throw new Error('engine attempted forbidden call fetch()')
  }
  restorers.push(() => {
    globalThis.fetch = originalFetch
  })

  return {
    calls,
    restore: () => {
      for (const restore of restorers.reverse()) restore()
    },
  }
}

test('runtime guard: parsing, state derivation and validation never spawn or fetch', async () => {
  const guard = installForbiddenStubs()
  try {
    const yaml = parseYaml('schema: spec-driven\ncontext: |\n  Keep it small.\nartifacts:\n  - id: proposal\n    generates: proposal.md\n')
    assert.equal(yaml.error, null)

    const config = parseProjectConfig('schema: spec-driven\nrules:\n  proposal: [be brief]\n')
    assert.equal(config.schema, 'spec-driven')

    const metadata = parseChangeMetadata('schema: spec-driven\ncreated: 2026-10-20\n')
    assert.equal(metadata.error, null)

    assert.ok(loadBundledSchemas().size >= 1)
    const builtin = resolveSchema({ name: 'spec-driven', projectSchemas: [] })
    assert.equal(builtin.source, 'builtin')
    const graphValidation = validateSchemaGraph(builtin.schema)
    assert.equal(graphValidation.issues.filter((issue) => issue.level === 'ERROR').length, 0)
    const artifacts = await computeArtifactStates(repoRoot, 'src/native', builtin.schema)
    assert.equal(artifacts.artifacts.length, builtin.schema.artifacts.length)

    assert.ok(parseMainSpec('# Spec\n\n## Purpose\n\nBody.\n').requirements.length === 0)
    assert.ok(parseDeltaSpec('## ADDED Requirements\n\n### Requirement: A\n\nThe system SHALL exist.\n').operations.ADDED.length === 1)
    assert.equal(parseTasks('- [ ] 1.1 first').total, 1)

    const validation = validateChange({
      changeName: 'guard',
      proposalText: '# Proposal\n\n## Why\n\n' + 'x'.repeat(60) + '\n\n## What Changes\n\n- one\n',
      deltas: [
        {
          path: 'specs/a/spec.md',
          text: '## ADDED Requirements\n\n### Requirement: A\n\nThe system SHALL exist.\n\n#### Scenario: S\n\n- **WHEN** a\n- **THEN** b\n',
        },
      ],
      tasksText: '- [ ] 1.1 first',
    })
    assert.equal(validation.summary.errors, 0)
    assert.ok(validateMainSpec({ path: 'openspec/specs/a/spec.md', text: '# Spec\n' }).summary.errors >= 1)

    const workspace = await computeWorkspaceState(repoRoot)
    assert.equal(workspace.status, 'missing')
    if (hasWorkspace) {
      const real = await computeWorkspaceState(workspaceRoot)
      assert.equal(real.status, 'ready')
      await validateChangeByName(workspaceRoot, 'align-native-openspec')
    }
  } finally {
    guard.restore()
  }
  assert.deepEqual(guard.calls, [], 'the engine must not spawn subprocesses or use the network')
})

test('parseSchema works on an in-memory upstream-like document without external I/O', () => {
  const { schema, issues } = parseSchema(
    [
      'name: spec-driven',
      'version: 1',
      'artifacts:',
      '  - id: proposal',
      '    generates: proposal.md',
      '    instruction: |',
      '      Write the proposal.',
    ].join('\n'),
  )
  assert.equal(issues.length, 0)
  assert.equal(schema.name, 'spec-driven')
  assert.equal(schema.artifacts[0].instruction, 'Write the proposal.\n')
})
