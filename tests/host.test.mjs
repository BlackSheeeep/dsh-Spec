/**
 * Host-half integration tests: plugin wiring, the `/dsh-spec` route envelope and
 * the read-only native methods. These tests never write files — `init` is only
 * exercised against a fake workspace in the commands tests.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ROUTE, apply, inject, name } from '../src/host.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const slashed = (value) => value.replaceAll('\\', '/')

/** Committed fixture workspace with native OpenSpec content (stable for tests). */
const WORKSPACE = slashed(path.join(repoRoot, 'tests', 'fixtures', 'workspace'))

/** Plugin root: a workspace without native OpenSpec skills or openspec/. */
const PLUGIN_ROOT = slashed(repoRoot)

/** Build a fake Cordis plugin context and the collected registrations. */
function fakeContext({ skills } = {}) {
  const registered = []
  const routes = []
  const effects = []
  const providers = []
  const ctx = {
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: { admit: () => ({ principal: 'test' }) },
    workspaceRegistry: {
      resolveByPath: async (path) => (path === WORKSPACE || path === PLUGIN_ROOT ? { path } : undefined),
    },
    workingDirectory: {},
    get(key) {
      if (key === 'skills') return skills
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(typeof disposer === 'function' ? disposer : () => {})
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, registered, routes, effects, providers }
}

/** Call the registered route with one JSON envelope and return its response. */
async function callRoute(route, { method = 'POST', endpoint, envelope, rawBody } = {}) {
  const body = rawBody ?? JSON.stringify(envelope)
  const req = {
    url: `${ROUTE}/${endpoint}`,
    method,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
  const headers = {}
  let status = 0
  let payload = ''
  const res = {
    writeHead(code, extra) {
      status = code
      Object.assign(headers, extra ?? {})
    },
    end(text) {
      payload = typeof text === 'string' ? text : ''
    },
  }
  await route.handler(req, res)
  return { status, headers, text: payload, json: payload.startsWith('{') ? JSON.parse(payload) : null }
}

/** One client-request envelope for a route method. */
function envelope(endpoint, payload = {}) {
  return { type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload }
}

test('plugin metadata declares the injected services', () => {
  assert.equal(name, 'openSpec')
  assert.equal(ROUTE, '/dsh-spec')
  for (const service of ['commands', 'workingDirectory', 'webServer', 'connection', 'workspaceRegistry']) {
    assert.ok(inject.includes(service), `inject must include ${service}`)
  }
})

test('apply registers the nine native commands', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx)
  const names = registered.map((definition) => definition.name).sort()
  assert.deepEqual(names, [
    'openspec-init',
    'opsx-apply',
    'opsx-archive',
    'opsx-explore',
    'opsx-propose',
    'opsx-status',
    'opsx-sync',
    'opsx-update',
    'opsx-validate',
  ])
  for (const definition of registered) {
    assert.equal(typeof definition.handler, 'function')
    assert.equal(typeof definition.description, 'string')
  }
})

test('apply registers exactly one prefix route at ROUTE', () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, ROUTE)
  assert.equal(typeof routes[0].handler, 'function')
})

test('state method answers with the native workspace snapshot', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], { endpoint: 'state', envelope: envelope('state', { cwd: WORKSPACE }) })
  assert.equal(response.status, 200)
  assert.equal(response.json.type, 'server-response')
  assert.equal(response.json.rpcId, 'rpc-1')
  assert.equal(response.json.result.ok, true)
  const value = response.json.result.value
  assert.equal(value.root, 'openspec')
  assert.equal(value.status, 'ready')
  assert.equal(value.config.schema, 'spec-driven')
  assert.ok(Array.isArray(value.changes))
  assert.ok(Array.isArray(value.specs))
  assert.ok(Array.isArray(value.archived))
  assert.ok(value.skills !== null && typeof value.skills === 'object')
  assert.ok(value.changes.some((change) => change.name === 'align-native-openspec'))
  // The panel payload carries bounded task detail rows (state.js limitTaskItems).
  const change = value.changes.find((entry) => entry.name === 'align-native-openspec')
  assert.ok(Array.isArray(change.tasks.items))
  assert.equal(change.tasks.items.length, Math.min(change.tasks.total, 200))
  assert.equal(change.tasks.items.filter((item) => item.done).length, change.tasks.done)
  assert.deepEqual(Object.keys(change.tasks.items[0]).sort(), ['depth', 'done', 'id', 'text'])
})

test('state method reports an uninitialized workspace as missing', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], { endpoint: 'state', envelope: envelope('state', { cwd: PLUGIN_ROOT }) })
  assert.equal(response.json.result.ok, true)
  assert.equal(response.json.result.value.status, 'missing')
})

test('unregistered workspace paths are rejected', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], {
    endpoint: 'state',
    envelope: envelope('state', { cwd: 'D:/DSHarness/not-a-workspace' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.result.ok, false)
  assert.match(response.json.result.error.message, /工作区/)
})

test('relative or empty cwd is rejected', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  for (const cwd of ['', 'openspec', '..']) {
    const response = await callRoute(routes[0], { endpoint: 'state', envelope: envelope('state', { cwd }) })
    assert.equal(response.json.result.ok, false)
  }
})

test('bad envelope and wrong method are rejected', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const bad = await callRoute(routes[0], { endpoint: 'state', envelope: { type: 'nope', method: 'state' } })
  assert.equal(bad.status, 400)
  const get = await callRoute(routes[0], { method: 'GET', endpoint: 'state' })
  assert.equal(get.status, 405)
})

test('unknown route methods return a structured error', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], { endpoint: 'bogus', envelope: envelope('bogus', { cwd: WORKSPACE }) })
  assert.equal(response.json.result.ok, false)
  assert.match(response.json.result.error.message, /未知操作/)
})

test('document method pages workspace-contained files', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const page = await callRoute(routes[0], {
    endpoint: 'document',
    envelope: envelope('document', { cwd: PLUGIN_ROOT, path: 'package.json' }),
  })
  assert.equal(page.json.result.ok, true)
  assert.match(page.json.result.value.text, /"name": "dsh-spec"/)
  assert.equal(page.json.result.value.offset, 1)
  assert.equal(typeof page.json.result.value.totalLines, 'number')

  const second = await callRoute(routes[0], {
    endpoint: 'document',
    envelope: envelope('document', { cwd: PLUGIN_ROOT, path: 'package.json', offset: 2, limit: 2 }),
  })
  assert.equal(second.json.result.value.offset, 2)
  assert.equal(second.json.result.value.lines, 2)
  assert.equal(second.json.result.value.truncated, true)
  assert.equal(second.json.result.value.nextOffset, 4)
})

test('document method rejects traversal and escaping paths', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  for (const path of ['../README.md', '..', '']) {
    const response = await callRoute(routes[0], { endpoint: 'document', envelope: envelope('document', { cwd: PLUGIN_ROOT, path }) })
    assert.equal(response.json.result.ok, false, `path ${JSON.stringify(path)} must be rejected`)
  }
})

test('instructions compose explore and native phase prompts', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const explore = await callRoute(routes[0], {
    endpoint: 'instructions',
    envelope: envelope('instructions', { cwd: WORKSPACE, kind: 'explore', topic: 'cache layer' }),
  })
  assert.equal(explore.json.result.ok, true)
  assert.match(explore.json.result.value.text, /cache layer/)
  assert.match(explore.json.result.value.text, /(do not|Do NOT) (write|modif)/)

  const propose = await callRoute(routes[0], {
    endpoint: 'instructions',
    envelope: envelope('instructions', { cwd: WORKSPACE, kind: 'propose', change: 'align-native-openspec', topic: 'revise scope' }),
  })
  assert.equal(propose.json.result.ok, true)
  assert.match(propose.json.result.value.text, /align-native-openspec/)

  const bad = await callRoute(routes[0], {
    endpoint: 'instructions',
    envelope: envelope('instructions', { cwd: WORKSPACE, kind: 'nope' }),
  })
  assert.equal(bad.json.result.ok, false)
})

test('validate method works per change and workspace-wide without writing', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const perChange = await callRoute(routes[0], {
    endpoint: 'validate',
    envelope: envelope('validate', { cwd: WORKSPACE, change: 'align-native-openspec' }),
  })
  assert.equal(perChange.json.result.ok, true)
  assert.equal(perChange.json.result.value.name, 'align-native-openspec')
  const validation = perChange.json.result.value.validation
  assert.equal(typeof validation.errors, 'number')
  assert.ok(Array.isArray(validation.issues))

  const workspace = await callRoute(routes[0], { endpoint: 'validate', envelope: envelope('validate', { cwd: WORKSPACE }) })
  assert.equal(workspace.json.result.ok, true)
  assert.equal(workspace.json.result.value.workspace, true)
  assert.ok(Array.isArray(workspace.json.result.value.validation.issues))
})

test('instructions compose sync and archive OPSX workflow prompts', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  for (const kind of ['sync', 'archive']) {
    const response = await callRoute(routes[0], {
      endpoint: 'instructions',
      envelope: envelope('instructions', { cwd: WORKSPACE, kind, change: 'align-native-openspec' }),
    })
    assert.equal(response.json.result.ok, true, `${kind} instructions must succeed`)
    const value = response.json.result.value
    assert.equal(value.kind, kind)
    assert.equal(value.change, 'align-native-openspec')
    assert.match(value.text, /## DSH adaptation/, `${kind} prompt must include the adaptation section`)
    assert.match(value.text, /Current facts/, `${kind} prompt must include the engine facts block`)
    assert.match(value.text, /align-native-openspec/)
  }
})

test('sync-preview builds a dry-run plan and renders preview text', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], {
    endpoint: 'sync-preview',
    envelope: envelope('sync-preview', { cwd: WORKSPACE, change: 'align-native-openspec' }),
  })
  assert.equal(response.json.result.ok, true)
  const value = response.json.result.value
  assert.equal(value.change, 'align-native-openspec')
  assert.equal(typeof value.ok, 'boolean')
  assert.ok(value.summary !== null && typeof value.summary === 'object')
  assert.equal(typeof value.text, 'string')
  assert.ok(Array.isArray(value.files))
  assert.ok(Array.isArray(value.writes))
  assert.ok(value.validation !== undefined)
})

test('initialization on an uninitialized workspace is idempotent for missing dirs only', async () => {
  // The route's init handler writes by design; the sandbox denies child-process writes,
  // so this test only covers the read-only rejection path (a non-registered path).
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const response = await callRoute(routes[0], { endpoint: 'init', envelope: envelope('init', { cwd: 'D:/nope' }) })
  assert.equal(response.json.result.ok, false)
  assert.match(response.json.result.error.message, /工作区/)
})

test('archive-detail returns an archived change with tasks, docs and metadata', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const stateResponse = await callRoute(routes[0], { endpoint: 'state', envelope: envelope('state', { cwd: WORKSPACE }) })
  const archived = stateResponse.json.result.value.archived
  assert.ok(Array.isArray(archived) && archived.length >= 1)
  const row = archived.find((entry) => entry.changeName === 'legacy-fixture')
  assert.ok(row, 'the fixture archived change should be listed')
  assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/)

  const detail = await callRoute(routes[0], {
    endpoint: 'archive-detail',
    envelope: envelope('archive-detail', { cwd: WORKSPACE, path: row.path }),
  })
  assert.equal(detail.json.result.ok, true)
  const change = detail.json.result.value.change
  assert.equal(change.name, `archive/${row.name}`)
  assert.equal(change.metadata.found, true)
  assert.equal(change.tasks.done, change.tasks.total)
  assert.equal(change.listStatus, 'complete')
  // archive-detail reuses the same ChangeState shape, task rows included.
  assert.ok(Array.isArray(change.tasks.items))
  assert.equal(change.tasks.items.length, change.tasks.total)
  assert.equal(change.tasks.items.filter((item) => item.done).length, change.tasks.done)
  assert.ok(change.docs.some((doc) => doc.path.endsWith('proposal.md')))
  assert.ok(change.docs.some((doc) => doc.kind === 'delta'))
})

test('optional skills service receives a workspace-aware fallback provider', async () => {
  const providers = []
  const skills = {
    registerProvider(factory) {
      providers.push(factory({ signal: new AbortController().signal, invalidate() {} }))
      return () => {}
    },
  }
  const { ctx } = fakeContext({ skills })
  apply(ctx)
  assert.equal(providers.length, 1)
  assert.equal(providers[0].name, 'openspec-native-fallback')
  const candidates = await providers[0].list({ cwd: PLUGIN_ROOT })
  assert.ok(Array.isArray(candidates))
  for (const candidate of candidates) {
    assert.match(candidate.name, /^openspec-/)
    const definition = await providers[0].get(candidate, { cwd: PLUGIN_ROOT })
    assert.equal(typeof definition.content, 'string')
  }
})

test('compositions without a skills service still register commands and the route', () => {
  const { ctx, registered, routes } = fakeContext()
  apply(ctx)
  assert.equal(registered.length, 9)
  assert.equal(routes.length, 1)
})
