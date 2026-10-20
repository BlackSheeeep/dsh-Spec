/**
 * Unit tests for the deterministic sync merge engine (`src/native/merge.js`).
 *
 * These tests never touch the real filesystem: `planSync`/`previewSyncPlan` are
 * pure, and `applySyncPlan` is driven through an in-memory `io` fake. Run with
 * `node --test --test-isolation=none tests/merge.test.mjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  planSync,
  serializeMainSpec,
  previewSyncPlan,
  applySyncPlan,
} from '../src/native/merge.js'

const CWD = path.resolve('dsh-spec-merge-test-workspace')
const MAIN_PATH = 'openspec/specs/auth/spec.md'
const CHANGE_NAME = 'add-refresh'

const MAIN = `# auth Specification

## Purpose
Auth controls access to the platform and keeps sessions safe.

Intro prose kept.

## Requirements

### Requirement: Login
Users SHALL log in.

#### Scenario: Success
- **WHEN** good
- **THEN** yes

### Requirement: Logout
Users SHALL log out.

#### Scenario: Goodbye
- **WHEN** click
- **THEN** bye

## Notes

Hand-written note kept.
`

const LOGIN_BLOCK = `### Requirement: Login
Users SHALL log in.

#### Scenario: Success
- **WHEN** good
- **THEN** yes`

const LOGOUT_BLOCK = `### Requirement: Logout
Users SHALL log out.

#### Scenario: Goodbye
- **WHEN** click
- **THEN** bye`

const ADDED_DELTA = `## ADDED Requirements

### Requirement: Refresh
Users SHALL refresh tokens.

#### Scenario: Refresh works
- **WHEN** expired
- **THEN** refreshed
`

const ADDED_BLOCK = `### Requirement: Refresh
Users SHALL refresh tokens.

#### Scenario: Refresh works
- **WHEN** expired
- **THEN** refreshed`

function deltaPath(capability = 'auth') {
  return `specs/${capability}/spec.md`
}

function planOne(deltaText, overrides = {}) {
  return planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: MAIN_PATH, text: MAIN }],
    deltas: [{ path: deltaPath(), text: deltaText }],
    ...overrides,
  })
}

function toAbs(relPath) {
  return path.resolve(CWD, relPath)
}

function normalizeKey(value) {
  return String(value).replace(/\\/g, '/')
}

function missingPathError(target) {
  const error = new Error(`ENOENT: no such file or directory, ${target}`)
  error.code = 'ENOENT'
  return error
}

/**
 * In-memory `io` fake covering the node:fs/promises surface used by
 * `applySyncPlan` and `executeArchive`.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.files] absolute or workspace-relative content
 * @param {Array<{method: string, pathIncludes?: string, code?: string, message?: string}>} [options.failures]
 * @returns {object}
 */
function makeFakeIo({ files = {}, failures = [] } = {}) {
  const fileMap = new Map()
  for (const [filePath, content] of Object.entries(files)) {
    fileMap.set(normalizeKey(filePath), String(content))
  }
  const dirs = new Set()
  const calls = []
  const pendingFailures = failures.map((failure) => ({ ...failure }))

  function maybeFail(method, target) {
    const index = pendingFailures.findIndex((failure) => (
      failure.method === method
      && (failure.pathIncludes === undefined
        || normalizeKey(target).includes(failure.pathIncludes))
    ))
    if (index === -1) return
    const failure = pendingFailures.splice(index, 1)[0]
    const error = new Error(failure.message ?? `injected ${method} failure for ${target}`)
    error.code = failure.code ?? 'EIO'
    throw error
  }

  function addDir(target) {
    let current = normalizeKey(target)
    dirs.add(current)
    while (true) {
      const parent = path.posix.dirname(current)
      if (parent === current || parent === '.' || parent === '/') break
      dirs.add(parent)
      current = parent
    }
  }

  const io = {
    files: fileMap,
    dirs,
    calls,
    pendingFailures,
    /**
     * @param {string} relPath
     * @returns {string}
     */
    abs(relPath) {
      return normalizeKey(toAbs(relPath))
    },
    /**
     * @param {string} relPath workspace-relative path
     * @returns {string|null}
     */
    read(relPath) {
      const key = normalizeKey(toAbs(relPath))
      return fileMap.has(key) ? fileMap.get(key) : null
    },
    /**
     * @param {string} relPath
     * @returns {boolean}
     */
    exists(relPath) {
      return fileMap.has(normalizeKey(toAbs(relPath)))
    },
    /** @returns {string[]} */
    tempKeys() {
      return [...fileMap.keys()].filter((key) => key.includes('.openspec-sync-'))
    },
    async readFile(target, _encoding) {
      calls.push({ method: 'readFile', target: normalizeKey(target) })
      maybeFail('readFile', target)
      const key = normalizeKey(target)
      if (!fileMap.has(key)) throw missingPathError(key)
      return fileMap.get(key)
    },
    async writeFile(target, data, _encoding) {
      calls.push({ method: 'writeFile', target: normalizeKey(target) })
      maybeFail('writeFile', target)
      fileMap.set(normalizeKey(target), String(data))
    },
    async rename(from, to) {
      calls.push({ method: 'rename', from: normalizeKey(from), to: normalizeKey(to) })
      maybeFail('rename', from)
      maybeFail('rename', to)
      const fromKey = normalizeKey(from)
      const toKey = normalizeKey(to)
      if (!fileMap.has(fromKey)) throw missingPathError(fromKey)
      fileMap.set(toKey, fileMap.get(fromKey))
      fileMap.delete(fromKey)
    },
    async mkdir(target, _options) {
      calls.push({ method: 'mkdir', target: normalizeKey(target) })
      maybeFail('mkdir', target)
      addDir(target)
    },
    async rm(target, _options) {
      calls.push({ method: 'rm', target: normalizeKey(target) })
      maybeFail('rm', target)
      const key = normalizeKey(target)
      fileMap.delete(key)
      dirs.delete(key)
      for (const candidate of [...fileMap.keys()]) {
        if (candidate.startsWith(`${key}/`)) fileMap.delete(candidate)
      }
      for (const candidate of [...dirs]) {
        if (candidate === key || candidate.startsWith(`${key}/`)) dirs.delete(candidate)
      }
    },
    async unlink(target) {
      calls.push({ method: 'unlink', target: normalizeKey(target) })
      maybeFail('unlink', target)
      const key = normalizeKey(target)
      if (!fileMap.has(key)) throw missingPathError(key)
      fileMap.delete(key)
    },
    async stat(target) {
      calls.push({ method: 'stat', target: normalizeKey(target) })
      maybeFail('stat', target)
      const key = normalizeKey(target)
      if (dirs.has(key)) {
        return { isDirectory: () => true, isFile: () => false }
      }
      if (fileMap.has(key)) {
        return { isDirectory: () => false, isFile: () => true }
      }
      for (const candidate of fileMap.keys()) {
        if (candidate.startsWith(`${key}/`)) {
          return { isDirectory: () => true, isFile: () => false }
        }
      }
      throw missingPathError(key)
    },
    async readdir(target) {
      calls.push({ method: 'readdir', target: normalizeKey(target) })
      maybeFail('readdir', target)
      const key = normalizeKey(target)
      const names = new Set()
      for (const candidate of fileMap.keys()) {
        if (candidate.startsWith(`${key}/`)) {
          names.add(candidate.slice(key.length + 1).split('/')[0])
        }
      }
      for (const candidate of dirs) {
        if (candidate.startsWith(`${key}/`)) {
          names.add(candidate.slice(key.length + 1).split('/')[0])
        }
      }
      if (names.size === 0 && !dirs.has(key)) throw missingPathError(key)
      return [...names].sort()
    },
    async copyFile(from, to) {
      calls.push({ method: 'copyFile', from: normalizeKey(from), to: normalizeKey(to) })
      maybeFail('copyFile', from)
      const fromKey = normalizeKey(from)
      if (!fileMap.has(fromKey)) throw missingPathError(fromKey)
      fileMap.set(normalizeKey(to), fileMap.get(fromKey))
    },
  }
  return io
}

function requirement(name, body) {
  return { name, raw: `### Requirement: ${name}\n\n${body}`, text: body, scenarios: [] }
}

// ---------------------------------------------------------------------------
// Main-spec merge semantics
// ---------------------------------------------------------------------------

test('ADDED appends the requirement and preserves every untouched byte', () => {
  const plan = planOne(ADDED_DELTA)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.issues, [])
  assert.deepEqual(plan.summary, { ADDED: 1, MODIFIED: 0, REMOVED: 0, RENAMED: 0 })
  assert.equal(plan.writes.length, 1)
  const write = plan.writes[0]
  assert.equal(write.action, 'update')
  assert.equal(write.path, MAIN_PATH)

  const expected = MAIN.replace('## Notes', `${ADDED_BLOCK}\n\n## Notes`)
  assert.equal(write.content, expected)
  // The purpose, the other requirement and the tail are byte-identical.
  assert.ok(write.content.startsWith(MAIN.slice(0, MAIN.indexOf('### Requirement: Login'))))
  assert.ok(write.content.includes(LOGOUT_BLOCK))
  assert.ok(write.content.endsWith('## Notes\n\nHand-written note kept.\n'))
})

test('MODIFIED replaces the whole block (body and scenarios) in place', () => {
  const delta = `## MODIFIED Requirements

### Requirement: Login
Users SHALL log in with MFA.

#### Scenario: MFA success
- **WHEN** good
- **THEN** mfa
`
  const plan = planOne(delta)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.summary, { ADDED: 0, MODIFIED: 1, REMOVED: 0, RENAMED: 0 })
  assert.equal(plan.writes.length, 1)
  const replacement = `### Requirement: Login
Users SHALL log in with MFA.

#### Scenario: MFA success
- **WHEN** good
- **THEN** mfa`
  const expected = MAIN.replace(LOGIN_BLOCK, replacement)
  assert.equal(plan.writes[0].content, expected)
  // The second requirement and the notes were not touched.
  assert.ok(plan.writes[0].content.includes(LOGOUT_BLOCK))
  assert.ok(plan.writes[0].content.endsWith('## Notes\n\nHand-written note kept.\n'))
})

test('REMOVED deletes the block and its separator only', () => {
  const delta = `## REMOVED Requirements

### Requirement: Logout

**Reason**: replaced by the new session model.
`
  const plan = planOne(delta)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.summary, { ADDED: 0, MODIFIED: 0, REMOVED: 1, RENAMED: 0 })
  const expected = MAIN.replace(`${LOGOUT_BLOCK}\n\n`, '')
  assert.equal(plan.writes[0].content, expected)
  assert.ok (!plan.writes[0].content.includes('Requirement: Logout'))
})

test('RENAMED retitles the requirement in place and keeps its body bytes', () => {
  const delta = `## RENAMED Requirements

- FROM: \`### Requirement: Login\`
- TO: \`### Requirement: Sign In\`
`
  const plan = planOne(delta)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.summary, { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 1 })
  const expected = MAIN.replace('### Requirement: Login', '### Requirement: Sign In')
  assert.equal(plan.writes[0].content, expected)
  assert.ok(plan.writes[0].content.includes('Users SHALL log in.'))
})

test('combined operations apply deterministically in native order', () => {
  const delta = `## ADDED Requirements

### Requirement: Refresh
Users SHALL refresh tokens.

#### Scenario: Refresh works
- **WHEN** expired
- **THEN** refreshed

## MODIFIED Requirements

### Requirement: Login
Users SHALL log in with MFA.

#### Scenario: MFA success
- **WHEN** good
- **THEN** mfa

## RENAMED Requirements

- FROM: \`### Requirement: Logout\`
- TO: \`### Requirement: Sign Out\`
`
  const plan = planOne(delta)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.summary, { ADDED: 1, MODIFIED: 1, REMOVED: 0, RENAMED: 1 })
  const content = plan.writes[0].content
  assert.ok(content.includes('### Requirement: Sign In') || content.includes('### Requirement: Login'))
  assert.ok(content.includes('### Requirement: Sign Out'))
  assert.ok(content.includes(ADDED_BLOCK))
  assert.ok(content.includes('Users SHALL log in with MFA.'))
  assert.ok(content.endsWith('## Notes\n\nHand-written note kept.\n'))
})

test('CRLF main specs keep their line endings and untouched bytes', () => {
  const mainCrlf = MAIN.replace(/\n/g, '\r\n')
  const plan = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: MAIN_PATH, text: mainCrlf }],
    deltas: [{ path: deltaPath(), text: ADDED_DELTA }],
  })
  assert.equal(plan.ok, true)
  const content = plan.writes[0].content
  assert.equal(/[^\r]\n/.test(content), false, 'no lone LF may be introduced into a CRLF spec')
  assert.equal(content.replace(/\r\n/g, '\n'), MAIN.replace('## Notes', `${ADDED_BLOCK}\n\n## Notes`))
})

test('ADDED on a spec without a trailing newline keeps it that way', () => {
  const noFinalNewline = MAIN.replace(/\n$/, '')
  const plan = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: MAIN_PATH, text: noFinalNewline }],
    deltas: [{ path: deltaPath(), text: ADDED_DELTA }],
  })
  assert.equal(plan.ok, true)
  const content = plan.writes[0].content
  assert.ok(content.endsWith('## Notes\n\nHand-written note kept.'))
  assert.equal(content.endsWith('\n'), false)

  // Same rule when the spec ends on its last requirement (no trailing section).
  const noTail = noFinalNewline.replace(/\n\n## Notes\n\nHand-written note kept\.$/, '')
  const noTailPlan = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: MAIN_PATH, text: noTail }],
    deltas: [{ path: deltaPath(), text: ADDED_DELTA }],
  })
  assert.equal(noTailPlan.ok, true)
  const noTailContent = noTailPlan.writes[0].content
  assert.ok(noTailContent.endsWith('#### Scenario: Refresh works\n- **WHEN** expired\n- **THEN** refreshed'))
  assert.equal(noTailContent.endsWith('\n'), false)
})

test('a main spec without ## Requirements gets the section appended', () => {
  const purposeOnly = `# billing Specification

## Purpose
Billing tracks invoices.

## Notes

Some note.
`
  const delta = `## ADDED Requirements

### Requirement: Invoices
The system SHALL track invoices.

#### Scenario: Invoice created
- **WHEN** new invoice
- **THEN** tracked
`
  const plan = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: 'openspec/specs/billing/spec.md', text: purposeOnly }],
    deltas: [{ path: 'specs/billing/spec.md', text: delta }],
  })
  assert.equal(plan.ok, true)
  const content = plan.writes[0].content
  assert.ok(content.includes('## Requirements\n\n### Requirement: Invoices'))
  assert.ok(content.includes('Billing tracks invoices.'))
  assert.ok(content.startsWith('# billing Specification\n\n## Purpose'))
})

// ---------------------------------------------------------------------------
// Unsafe merges
// ---------------------------------------------------------------------------

test('unsafe merges are ERROR issues and produce no writes', async (t) => {
  const cases = [
    {
      name: 'ADDED collides with an existing requirement',
      delta: ADDED_DELTA.replace('Refresh', 'Login'),
      pattern: /ADDED failed: requirement "Login" already exists/,
    },
    {
      name: 'MODIFIED targets a missing requirement',
      delta: `## MODIFIED Requirements\n\n### Requirement: Missing\nUsers SHALL do things.\n`,
      pattern: /MODIFIED failed: requirement "Missing" does not exist/,
    },
    {
      name: 'REMOVED targets a missing requirement',
      delta: `## REMOVED Requirements\n\n### Requirement: Missing\n\n**Reason**: gone.\n`,
      pattern: /REMOVED failed: requirement "Missing" does not exist/,
    },
    {
      name: 'RENAMED targets a missing requirement',
      delta: `## RENAMED Requirements\n\n- FROM: \`### Requirement: Missing\`\n- TO: \`### Requirement: Other\`\n`,
      pattern: /RENAMED failed: requirement "Missing" does not exist/,
    },
    {
      name: 'RENAMED collides with an existing requirement',
      delta: `## RENAMED Requirements\n\n- FROM: \`### Requirement: Login\`\n- TO: \`### Requirement: Logout\`\n`,
      pattern: /RENAMED failed: requirement "Logout" already exists/,
    },
    {
      name: 'duplicate entries inside ADDED',
      delta: ADDED_DELTA + '\n' + ADDED_DELTA,
      pattern: /ADDED failed: requirement "Refresh" already exists/,
    },
  ]
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const plan = planOne(testCase.delta)
      assert.equal(plan.ok, false)
      assert.deepEqual(plan.writes, [], 'an unsafe plan must carry no writes')
      const errors = plan.issues.filter((issue) => issue.level === 'ERROR')
      assert.ok(errors.length > 0, 'expected at least one ERROR issue')
      assert.ok(
        errors.some((issue) => testCase.pattern.test(issue.message)),
        `expected an issue matching ${testCase.pattern}, got ${JSON.stringify(errors)}`,
      )
    })
  }
})

test('cross-section conflicts are rejected', () => {
  const delta = `## MODIFIED Requirements

### Requirement: Login
Users SHALL log in differently.

## REMOVED Requirements

### Requirement: Login

**Reason**: contradiction.
`
  const plan = planOne(delta)
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.writes, [])
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'ERROR' && /appears in multiple sections/.test(issue.message)
  )))
})

test('path traversal and absolute delta paths are rejected', () => {
  for (const unsafePath of [
    'specs/../../evil/spec.md',
    '/etc/passwd/spec.md',
    'C:/windows/spec.md',
  ]) {
    const plan = planSync({
      changeName: CHANGE_NAME,
      mainSpecs: [{ path: MAIN_PATH, text: MAIN }],
      deltas: [{ path: unsafePath, text: ADDED_DELTA }],
    })
    assert.equal(plan.ok, false, `expected refusal for ${unsafePath}`)
    assert.deepEqual(plan.writes, [])
    assert.ok(plan.issues.some((issue) => issue.level === 'ERROR'))
  }
})

// ---------------------------------------------------------------------------
// New capabilities and retirement
// ---------------------------------------------------------------------------

const BILLING_DELTA = `# Spec Delta

## Purpose

Billing tracks invoices and payments for every account.

## ADDED Requirements

### Requirement: Invoices
The system SHALL track invoices.

#### Scenario: Invoice created
- **WHEN** new invoice
- **THEN** tracked
`

test('new capability creation writes Purpose, Requirements and the delta ADDED blocks', () => {
  const plan = planSync({
    changeName: 'add-billing',
    mainSpecs: [],
    deltas: [{ path: 'specs/billing/spec.md', text: BILLING_DELTA }],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.writes.length, 1)
  const write = plan.writes[0]
  assert.equal(write.action, 'create')
  assert.equal(write.path, 'openspec/specs/billing/spec.md')
  const expected = serializeMainSpec({
    title: 'billing',
    purpose: 'Billing tracks invoices and payments for every account.',
    requirements: [`### Requirement: Invoices
The system SHALL track invoices.

#### Scenario: Invoice created
- **WHEN** new invoice
- **THEN** tracked`],
  })
  assert.equal(write.content, expected)
  assert.ok(write.content.startsWith('# billing Specification\n\n## Purpose\nBilling tracks invoices'))
})

test('new capability without a delta Purpose gets the native TBD placeholder', () => {
  const plan = planSync({
    changeName: 'add-billing',
    mainSpecs: [],
    deltas: [{ path: 'specs/billing/spec.md', text: ADDED_DELTA }],
  })
  assert.equal(plan.ok, true)
  assert.ok(plan.writes[0].content.includes(
    '## Purpose\nTBD - created by archiving change add-billing. Update Purpose after archive.\n\n## Requirements',
  ))
})

test('MODIFIED / RENAMED against a missing main spec are rejected', () => {
  for (const delta of [
    `## MODIFIED Requirements\n\n### Requirement: Missing\nUsers SHALL do things.\n`,
    `## RENAMED Requirements\n\n- FROM: \`### Requirement: A\`\n- TO: \`### Requirement: B\`\n`,
  ]) {
    const plan = planSync({
      changeName: 'add-billing',
      mainSpecs: [],
      deltas: [{ path: 'specs/billing/spec.md', text: delta }],
    })
    assert.equal(plan.ok, false)
    assert.deepEqual(plan.writes, [])
  }
})

const SOLO_MAIN = `# solo Specification

## Purpose
Solo exists to test retirement.

## Requirements

### Requirement: Only
The system SHALL have exactly one requirement.

#### Scenario: One
- **WHEN** one
- **THEN** one
`

const SOLO_REMOVE_DELTA = `## REMOVED Requirements

### Requirement: Only

**Reason**: capability retired.
`

test('retire_capabilities removes the main spec when its last requirement is removed', () => {
  const plan = planSync({
    changeName: 'retire-solo',
    mainSpecs: [{ path: 'openspec/specs/solo/spec.md', text: SOLO_MAIN }],
    deltas: [{ path: 'specs/solo/spec.md', text: SOLO_REMOVE_DELTA }],
    retireCapabilities: true,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.writes.length, 1)
  assert.equal(plan.writes[0].action, 'remove')
  assert.equal(plan.writes[0].path, 'openspec/specs/solo/spec.md')
  assert.equal(plan.writes[0].content, '')
})

test('without retire_capabilities the empty capability is kept', () => {
  const plan = planSync({
    changeName: 'retire-solo',
    mainSpecs: [{ path: 'openspec/specs/solo/spec.md', text: SOLO_MAIN }],
    deltas: [{ path: 'specs/solo/spec.md', text: SOLO_REMOVE_DELTA }],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.writes.length, 1)
  const write = plan.writes[0]
  assert.equal(write.action, 'update')
  assert.ok(write.content.includes('## Requirements'))
  assert.equal(write.content.includes('### Requirement:'), false)
  assert.ok(write.content.includes('Solo exists to test retirement.'))
})

test('a capability that keeps a requirement after removals is updated, not retired', () => {
  const delta = `## REMOVED Requirements

### Requirement: Login

**Reason**: merged into logout.

## ADDED Requirements

### Requirement: Session
Users SHALL keep a session.

#### Scenario: Session works
- **WHEN** login
- **THEN** session
`
  const plan = planSync({
    changeName: 'reshape-auth',
    mainSpecs: [{ path: MAIN_PATH, text: MAIN }],
    deltas: [{ path: deltaPath(), text: delta }],
    retireCapabilities: true,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.writes.length, 1)
  assert.equal(plan.writes[0].action, 'update')
  assert.ok(plan.writes[0].content.includes('### Requirement: Session'))
  assert.ok(plan.writes[0].content.includes('### Requirement: Logout'))
  assert.equal(plan.writes[0].content.includes('### Requirement: Login'), false)
})

test('empty deltas and deltas without operations produce no writes', () => {
  const noDeltas = planSync({ changeName: CHANGE_NAME, mainSpecs: [], deltas: [] })
  assert.equal(noDeltas.ok, true)
  assert.deepEqual(noDeltas.writes, [])
  assert.ok(noDeltas.issues.some((issue) => issue.level === 'WARNING'))

  const emptyDelta = planOne('# Spec Delta\n\n## Purpose\n\nNothing here yet.\n')
  assert.equal(emptyDelta.ok, true)
  assert.deepEqual(emptyDelta.writes, [])
  assert.ok(emptyDelta.issues.some((issue) => (
    issue.level === 'WARNING' && /no ADDED\/MODIFIED\/REMOVED\/RENAMED/.test(issue.message)
  )))
})

test('MODIFIED on a spec that has no ## Requirements section is rejected', () => {
  const purposeOnly = '# billing Specification\n\n## Purpose\nBilling tracks invoices.\n'
  const plan = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: 'openspec/specs/billing/spec.md', text: purposeOnly }],
    deltas: [{
      path: 'specs/billing/spec.md',
      text: `## MODIFIED Requirements\n\n### Requirement: Invoices\nThe system SHALL track invoices.\n`,
    }],
  })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.writes, [])
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'ERROR' && /MODIFIED failed: requirement "Invoices" does not exist/.test(issue.message)
  )))
})

// ---------------------------------------------------------------------------
// Serialization / preview determinism
// ---------------------------------------------------------------------------

test('serializeMainSpec is deterministic and rejects a missing title', () => {
  const first = serializeMainSpec({
    title: 'auth',
    purpose: 'Auth works.',
    requirements: [requirement('One', 'Users SHALL one.')],
  })
  const second = serializeMainSpec({
    title: 'auth',
    purpose: 'Auth works.',
    requirements: [{ name: 'One', text: 'Users SHALL one.', scenarios: [] }],
  })
  assert.equal(first, second)
  assert.equal(first.endsWith('\n'), true)
  assert.equal(first.trimEnd().endsWith('Users SHALL one.'), true)
  assert.throws(() => serializeMainSpec({ title: '  ', purpose: 'x', requirements: [] }), /title/)
})

test('previewSyncPlan lists files, operations and warnings without side effects', () => {
  const plan = planOne(ADDED_DELTA)
  const preview = previewSyncPlan(plan)
  assert.equal(preview.files.length, 1)
  assert.equal(preview.files[0], MAIN_PATH)
  assert.ok(preview.text.includes('同步预览'))
  assert.ok(preview.text.includes(MAIN_PATH))
  assert.ok(preview.text.includes('ADDED 1'))
  assert.ok(preview.text.includes('--yes'))

  const refused = planOne(ADDED_DELTA.replace('Refresh', 'Login'))
  const refusedPreview = previewSyncPlan(refused)
  assert.deepEqual(refusedPreview.files, [])
  assert.ok(refusedPreview.text.includes('已拒绝同步'))
  assert.ok(refusedPreview.text.includes('错误'))
})

test('planSync is deterministic for identical input', () => {
  const first = planOne(ADDED_DELTA)
  const second = planOne(ADDED_DELTA)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('planSync accepts pre-parsed delta operations', () => {
  const parsed = {
    operations: {
      ADDED: [requirement('Refresh', 'Users SHALL refresh tokens.')],
      MODIFIED: [],
      REMOVED: [],
      RENAMED: [],
    },
    issues: [],
  }
  const plan = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: MAIN_PATH, text: MAIN }],
    deltas: [{ path: deltaPath(), text: ADDED_DELTA, parsed }],
  })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.summary, { ADDED: 1, MODIFIED: 0, REMOVED: 0, RENAMED: 0 })
})

// ---------------------------------------------------------------------------
// applySyncPlan (in-memory io)
// ---------------------------------------------------------------------------

test('applySyncPlan writes planned content through temp-file + rename', async () => {
  const io = makeFakeIo({ files: { [toAbs(MAIN_PATH)]: MAIN } })
  const plan = planOne(ADDED_DELTA)
  const result = await applySyncPlan({ cwd: CWD, plan, io })
  assert.deepEqual(result.written, [MAIN_PATH])
  assert.equal(io.read(MAIN_PATH), plan.writes[0].content)
  assert.deepEqual(io.tempKeys(), [])
  assert.ok(io.calls.some((call) => call.method === 'rename'))
  assert.ok(io.calls.some((call) => call.method === 'mkdir'))
})

test('applySyncPlan creates new capability files and removes retired ones', async () => {
  const createIo = makeFakeIo()
  const createPlan = planSync({
    changeName: 'add-billing',
    mainSpecs: [],
    deltas: [{ path: 'specs/billing/spec.md', text: BILLING_DELTA }],
  })
  await applySyncPlan({ cwd: CWD, plan: createPlan, io: createIo })
  assert.equal(createIo.read('openspec/specs/billing/spec.md'), createPlan.writes[0].content)

  const removeIo = makeFakeIo({ files: { [toAbs('openspec/specs/solo/spec.md')]: SOLO_MAIN } })
  const removePlan = planSync({
    changeName: 'retire-solo',
    mainSpecs: [{ path: 'openspec/specs/solo/spec.md', text: SOLO_MAIN }],
    deltas: [{ path: 'specs/solo/spec.md', text: SOLO_REMOVE_DELTA }],
    retireCapabilities: true,
  })
  await applySyncPlan({ cwd: CWD, plan: removePlan, io: removeIo })
  assert.equal(removeIo.exists('openspec/specs/solo/spec.md'), false)
})

test('applySyncPlan refuses a plan that is not ok', async () => {
  const io = makeFakeIo({ files: { [toAbs(MAIN_PATH)]: MAIN } })
  const plan = planOne(ADDED_DELTA.replace('Refresh', 'Login'))
  assert.equal(plan.ok, false)
  await assert.rejects(
    () => applySyncPlan({ cwd: CWD, plan, io }),
    /not marked ok/,
  )
  assert.deepEqual(io.calls, [])
})

test('applySyncPlan does nothing for an empty plan', async () => {
  const io = makeFakeIo()
  const result = await applySyncPlan({ cwd: CWD, plan: { ok: true, writes: [] }, io })
  assert.deepEqual(result, { written: [] })
  assert.deepEqual(io.calls, [])
})

test('applySyncPlan rejects write paths outside openspec/specs and the workspace', async () => {
  const io = makeFakeIo()
  for (const unsafePath of [
    '../evil.md',
    '/etc/evil.md',
    'openspec/changes/add-x/spec.md',
    'openspec/specs/../../evil.md',
  ]) {
    const plan = {
      ok: true,
      writes: [{ path: unsafePath, action: 'update', content: 'evil' }],
    }
    await assert.rejects(() => applySyncPlan({ cwd: CWD, plan, io }), /write path|escapes/)
  }
  assert.deepEqual(io.calls, [])
})

test('applySyncPlan rejects duplicate write paths', async () => {
  const plan = {
    ok: true,
    writes: [
      { path: MAIN_PATH, action: 'update', content: 'a' },
      { path: MAIN_PATH, action: 'update', content: 'b' },
    ],
  }
  await assert.rejects(() => applySyncPlan({ cwd: CWD, plan, io: makeFakeIo() }), /duplicate/)
})

test('applySyncPlan rolls back already written files when a later write fails', async () => {
  const io = makeFakeIo({
    files: {
      [toAbs('openspec/specs/a/spec.md')]: 'OLD A',
      [toAbs('openspec/specs/b/spec.md')]: 'OLD B',
    },
    failures: [{ method: 'writeFile', pathIncludes: 'openspec/specs/b/spec.md' }],
  })
  const plan = {
    ok: true,
    writes: [
      { path: 'openspec/specs/a/spec.md', action: 'update', content: 'NEW A' },
      { path: 'openspec/specs/b/spec.md', action: 'update', content: 'NEW B' },
    ],
  }
  await assert.rejects(() => applySyncPlan({ cwd: CWD, plan, io }), /sync apply failed/)
  assert.equal(io.read('openspec/specs/a/spec.md'), 'OLD A')
  assert.equal(io.read('openspec/specs/b/spec.md'), 'OLD B')
  assert.deepEqual(io.tempKeys(), [])
})

test('applySyncPlan rolls back when a rename fails', async () => {
  const io = makeFakeIo({
    files: {
      [toAbs('openspec/specs/a/spec.md')]: 'OLD A',
      [toAbs('openspec/specs/b/spec.md')]: 'OLD B',
    },
    failures: [{ method: 'rename', pathIncludes: 'openspec/specs/b/spec.md' }],
  })
  const plan = {
    ok: true,
    writes: [
      { path: 'openspec/specs/a/spec.md', action: 'update', content: 'NEW A' },
      { path: 'openspec/specs/b/spec.md', action: 'update', content: 'NEW B' },
    ],
  }
  await assert.rejects(() => applySyncPlan({ cwd: CWD, plan, io }), /sync apply failed/)
  assert.equal(io.read('openspec/specs/a/spec.md'), 'OLD A')
  assert.equal(io.read('openspec/specs/b/spec.md'), 'OLD B')
  assert.deepEqual(io.tempKeys(), [])
})

test('applySyncPlan restores a removed file during rollback', async () => {
  const io = makeFakeIo({
    files: {
      [toAbs('openspec/specs/a/spec.md')]: 'OLD A',
      [toAbs('openspec/specs/b/spec.md')]: 'OLD B',
    },
    failures: [{ method: 'writeFile', pathIncludes: 'openspec/specs/b/spec.md' }],
  })
  const plan = {
    ok: true,
    writes: [
      { path: 'openspec/specs/a/spec.md', action: 'remove', content: '' },
      { path: 'openspec/specs/b/spec.md', action: 'update', content: 'NEW B' },
    ],
  }
  await assert.rejects(() => applySyncPlan({ cwd: CWD, plan, io }), /sync apply failed/)
  assert.equal(io.read('openspec/specs/a/spec.md'), 'OLD A')
})

test('applySyncPlan rejects malformed plans', async () => {
  const io = makeFakeIo()
  await assert.rejects(
    () => applySyncPlan({ cwd: CWD, plan: { ok: true, writes: [{ path: MAIN_PATH, action: 'explode', content: '' }] }, io }),
    /unknown plan write action/,
  )
  await assert.rejects(
    () => applySyncPlan({ cwd: CWD, plan: { ok: true, writes: [{ path: MAIN_PATH, action: 'update', content: 42 }] }, io }),
    /no content/,
  )
})
