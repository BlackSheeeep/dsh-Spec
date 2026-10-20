/**
 * Unit tests for the deterministic archive planner/executor
 * (`src/native/archive.js`).
 *
 * `planArchive`/`previewArchive` are pure; `executeArchive` is driven through an
 * in-memory `io` fake, so no test writes a real file. Run with
 * `node --test --test-isolation=none tests/archive.test.mjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { planArchive, previewArchive, executeArchive } from '../src/native/archive.js'
import { planSync } from '../src/native/merge.js'
import { formatLocalDate } from '../src/native/metadata.js'

const CWD = path.resolve('dsh-spec-archive-test-workspace')
const CHANGE_NAME = 'add-x'
const LOCAL_DATE = '2026-10-20'
const ARCHIVE_REL = `openspec/changes/archive/${LOCAL_DATE}-${CHANGE_NAME}`
const CHANGE_REL = `openspec/changes/${CHANGE_NAME}`
const MAIN_PATH = 'openspec/specs/auth/spec.md'

const MAIN = `# auth Specification

## Purpose
Auth controls access to the platform and keeps sessions safe.

## Requirements

### Requirement: Login
Users SHALL log in.

#### Scenario: Success
- **WHEN** good
- **THEN** yes
`

const DELTA = `## ADDED Requirements

### Requirement: Refresh
Users SHALL refresh tokens.

#### Scenario: Refresh works
- **WHEN** expired
- **THEN** refreshed
`

const METADATA_YAML = `schema: spec-driven
created: 2026-10-19
`

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
 * `executeArchive` (including directory renames and recursive trees).
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

  function keysUnder(prefix) {
    return [...fileMap.keys()].filter((key) => key.startsWith(`${prefix}/`))
  }

  const io = {
    files: fileMap,
    dirs,
    calls,
    pendingFailures,
    abs(relPath) {
      return normalizeKey(toAbs(relPath))
    },
    exists(relPath) {
      const key = normalizeKey(toAbs(relPath))
      return fileMap.has(key) || dirs.has(key) || keysUnder(key).length > 0
    },
    read(relPath) {
      const key = normalizeKey(toAbs(relPath))
      return fileMap.has(key) ? fileMap.get(key) : null
    },
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
      if (fileMap.has(fromKey)) {
        fileMap.set(toKey, fileMap.get(fromKey))
        fileMap.delete(fromKey)
        return
      }
      const isTree = dirs.has(fromKey) || keysUnder(fromKey).length > 0
      if (!isTree) throw missingPathError(fromKey)
      for (const [key, value] of [...fileMap.entries()]) {
        if (key !== fromKey && !key.startsWith(`${fromKey}/`)) continue
        fileMap.set(`${toKey}${key.slice(fromKey.length)}`, value)
        fileMap.delete(key)
      }
      for (const dir of [...dirs]) {
        if (dir !== fromKey && !dir.startsWith(`${fromKey}/`)) continue
        dirs.delete(dir)
        dirs.add(`${toKey}${dir.slice(fromKey.length)}`)
      }
      addDir(toKey)
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
      if (dirs.has(key) || keysUnder(key).length > 0) {
        return { isDirectory: () => true, isFile: () => false }
      }
      if (fileMap.has(key)) {
        return { isDirectory: () => false, isFile: () => true }
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

function changeTreeFiles() {
  return {
    [`${CHANGE_REL}/proposal.md`]: '# Why\n\nA change.\n',
    [`${CHANGE_REL}/.openspec.yaml`]: METADATA_YAML,
    [`${CHANGE_REL}/specs/auth/spec.md`]: DELTA,
    [MAIN_PATH]: MAIN,
  }
}

function absFiles(relativeFiles) {
  const absolute = {}
  for (const [relPath, content] of Object.entries(relativeFiles)) {
    absolute[toAbs(relPath)] = content
  }
  return absolute
}

function buildSyncPlan(overrides = {}) {
  return planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: MAIN_PATH, text: MAIN }],
    deltas: [{ path: 'specs/auth/spec.md', text: DELTA }],
    ...overrides,
  })
}

function metadata(overrides = {}) {
  return {
    found: true,
    schema: 'spec-driven',
    created: '2026-10-19',
    goal: '',
    skip_specs: false,
    retire_capabilities: false,
    ...overrides,
  }
}

function validation(overrides = {}) {
  return {
    issues: [],
    summary: { errors: 0, warnings: 0, infos: 0 },
    ...overrides,
  }
}

function archiveInput(overrides = {}) {
  return {
    changeName: CHANGE_NAME,
    localDate: LOCAL_DATE,
    metadata: metadata(),
    validation: validation(),
    syncPlan: buildSyncPlan(),
    targetExists: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

test('planArchive builds the native archive target and move descriptors', () => {
  const syncPlan = buildSyncPlan()
  const plan = planArchive(archiveInput({ syncPlan }))
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.issues, [])
  assert.equal(plan.archiveRel, ARCHIVE_REL)
  assert.deepEqual(plan.move, { from: CHANGE_REL, to: ARCHIVE_REL })
  assert.equal(plan.write, syncPlan)
  assert.equal(plan.skipSpecs, false)
  assert.equal(plan.retireCapabilities, false)
  assert.equal(plan.changeName, CHANGE_NAME)
  assert.equal(plan.localDate, LOCAL_DATE)
})

test('planArchive defaults the date to the local date', () => {
  const plan = planArchive(archiveInput({ localDate: undefined }))
  assert.equal(plan.ok, true)
  assert.equal(plan.archiveRel, `openspec/changes/archive/${formatLocalDate()}-${CHANGE_NAME}`)
})

test('an existing archive target is refused', () => {
  const plan = planArchive(archiveInput({ targetExists: true }))
  assert.equal(plan.ok, false)
  assert.equal(plan.write, null)
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'ERROR' && /already exists/.test(issue.message)
  )))
})

test('a validation ERROR blocks the archive and is surfaced', () => {
  const plan = planArchive(archiveInput({
    validation: {
      issues: [{
        level: 'ERROR',
        path: 'proposal.md',
        line: 3,
        message: 'Why section is too short',
      }],
      summary: { errors: 1, warnings: 0, infos: 0 },
    },
  }))
  assert.equal(plan.ok, false)
  assert.equal(plan.write, null)
  const error = plan.issues.find((issue) => issue.level === 'ERROR')
  assert.ok(error)
  assert.equal(error.path, 'proposal.md')
  assert.equal(error.line, 3)
  assert.equal(error.message, 'Why section is too short')
})

test('a validation summary-only result with errors blocks the archive', () => {
  const plan = planArchive(archiveInput({
    validation: { issues: [], summary: { errors: 2, warnings: 0, infos: 0 } },
  }))
  assert.equal(plan.ok, false)
  assert.ok(plan.issues.some((issue) => issue.level === 'ERROR' && /2 error/.test(issue.message)))
})

test('WARNINGs do not block but are listed in the result', () => {
  const plan = planArchive(archiveInput({
    validation: {
      issues: [{ level: 'WARNING', path: 'proposal.md', message: 'Capabilities section missing' }],
      summary: { errors: 0, warnings: 1, infos: 0 },
    },
  }))
  assert.equal(plan.ok, true)
  assert.ok(plan.write)
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'WARNING' && issue.message === 'Capabilities section missing'
  )))
})

test('a flat ChangeState validation shape is accepted', () => {
  const blocking = planArchive(archiveInput({
    validation: {
      errors: 1,
      warnings: 2,
      infos: 0,
      issues: [{ level: 'ERROR', path: 'tasks.md', message: 'Numbering gap' }],
    },
  }))
  assert.equal(blocking.ok, false)
  assert.ok(blocking.issues.some((issue) => issue.message === 'Numbering gap'))

  const passing = planArchive(archiveInput({
    validation: {
      errors: 0,
      warnings: 1,
      infos: 0,
      issues: [{ level: 'WARNING', path: 'proposal.md', message: 'Capabilities missing' }],
    },
  }))
  assert.equal(passing.ok, true)
  assert.ok(passing.issues.some((issue) => issue.level === 'WARNING'))
})

test('a missing validation result is reported but not fatal', () => {
  const plan = planArchive(archiveInput({ validation: undefined }))
  assert.equal(plan.ok, true)
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'WARNING' && /validation gate was not applied/.test(issue.message)
  )))
})

test('a missing sync plan is refused unless skip_specs is set', () => {
  const refused = planArchive(archiveInput({ syncPlan: null }))
  assert.equal(refused.ok, false)
  assert.ok(refused.issues.some((issue) => (
    issue.level === 'ERROR' && /no valid sync plan/.test(issue.message)
  )))

  const skipped = planArchive(archiveInput({
    syncPlan: null,
    metadata: metadata({ skip_specs: true }),
  }))
  assert.equal(skipped.ok, true)
  assert.equal(skipped.write, null)
  assert.equal(skipped.skipSpecs, true)
})

test('an unsafe sync plan blocks the archive and its errors are copied', () => {
  const unsafeSync = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: MAIN_PATH, text: MAIN }],
    deltas: [{ path: 'specs/auth/spec.md', text: DELTA.replace('Refresh', 'Login') }],
  })
  assert.equal(unsafeSync.ok, false)
  const plan = planArchive(archiveInput({ syncPlan: unsafeSync }))
  assert.equal(plan.ok, false)
  assert.equal(plan.write, null)
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'ERROR' && /sync plan contains errors/.test(issue.message)
  )))
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'ERROR' && /sync: ADDED failed/.test(issue.message)
  )))
})

test('skip_specs drops planned spec writes with a warning', () => {
  const plan = planArchive(archiveInput({
    metadata: metadata({ skip_specs: true }),
    syncPlan: buildSyncPlan(),
  }))
  assert.equal(plan.ok, true)
  assert.equal(plan.write, null)
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'WARNING' && /skip_specs is set/.test(issue.message)
  )))
})

test('an empty sync plan is reported', () => {
  const plan = planArchive(archiveInput({
    syncPlan: { ok: true, issues: [], writes: [], summary: { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 } },
  }))
  assert.equal(plan.ok, true)
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'INFO' && /no main-spec changes/.test(issue.message)
  )))
})

test('unsafe change names and dates are refused', async (t) => {
  const badNames = ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a b ', 'a\u0000b', 'add-x.']
  for (const changeName of badNames) {
    await t.test(`change name ${JSON.stringify(changeName)}`, () => {
      const plan = planArchive(archiveInput({ changeName }))
      assert.equal(plan.ok, false)
      assert.ok(plan.issues.some((issue) => issue.level === 'ERROR'))
    })
  }
  const badDates = ['2026-13-01', '2026-02-30', '20261020', '2026-1-01', '']
  for (const localDate of badDates) {
    await t.test(`local date ${JSON.stringify(localDate)}`, () => {
      const plan = planArchive(archiveInput({ localDate }))
      assert.equal(plan.ok, false)
      assert.ok(plan.issues.some((issue) => issue.level === 'ERROR'))
    })
  }
})

test('invalid change metadata blocks the archive', () => {
  const plan = planArchive(archiveInput({
    metadata: { found: true, error: { message: 'created must match YYYY-MM-DD' } },
  }))
  assert.equal(plan.ok, false)
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'ERROR' && /change metadata is invalid/.test(issue.message)
  )))
})

test('missing .openspec.yaml is reported as INFO', () => {
  const plan = planArchive(archiveInput({ metadata: { found: false } }))
  assert.equal(plan.ok, true)
  assert.ok(plan.issues.some((issue) => (
    issue.level === 'INFO' && /no \.openspec\.yaml/.test(issue.message)
  )))
})

test('planArchive is deterministic', () => {
  const first = planArchive(archiveInput())
  const second = planArchive(archiveInput())
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('previewArchive renders the target, writes and move without side effects', () => {
  const plan = planArchive(archiveInput())
  const preview = previewArchive(plan)
  assert.equal(preview.target, ARCHIVE_REL)
  assert.ok(preview.text.includes(`目标目录：${ARCHIVE_REL}`))
  assert.ok(preview.text.includes(MAIN_PATH))
  assert.ok(preview.text.includes(`移动：${CHANGE_REL} -> ${ARCHIVE_REL}`))
  assert.ok(preview.text.includes('--yes'))

  const refused = planArchive(archiveInput({ targetExists: true }))
  const refusedPreview = previewArchive(refused)
  assert.ok(refusedPreview.text.includes('已拒绝归档'))
  assert.ok(refusedPreview.text.includes('错误'))
})

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

test('executeArchive applies the sync write then moves the change tree', async () => {
  const io = makeFakeIo({ files: absFiles(changeTreeFiles()) })
  const plan = planArchive(archiveInput())
  const result = await executeArchive({ cwd: CWD, plan, io })
  assert.deepEqual(result, { moved: true, target: ARCHIVE_REL })

  // The spec write was applied first.
  assert.equal(io.read(MAIN_PATH), plan.write.writes[0].content)
  // The change tree moved, including `.openspec.yaml`.
  assert.equal(io.exists(`${CHANGE_REL}/proposal.md`), false)
  assert.equal(io.exists(`${CHANGE_REL}/.openspec.yaml`), false)
  assert.equal(io.exists(`${ARCHIVE_REL}/proposal.md`), true)
  assert.equal(io.read(`${ARCHIVE_REL}/.openspec.yaml`), METADATA_YAML)
  assert.equal(io.read(`${ARCHIVE_REL}/specs/auth/spec.md`), DELTA)
  assert.deepEqual(io.tempKeys(), [])
})

test('executeArchive refuses plans that are not ok before touching the filesystem', async () => {
  const io = makeFakeIo({ files: absFiles(changeTreeFiles()) })
  const plan = planArchive(archiveInput({ targetExists: true }))
  assert.equal(plan.ok, false)
  await assert.rejects(() => executeArchive({ cwd: CWD, plan, io }), /unsafe archive plan/)
  assert.deepEqual(io.calls, [])
})

test('executeArchive re-checks the archive target against the filesystem', async () => {
  const io = makeFakeIo({
    files: absFiles({
      ...changeTreeFiles(),
      [`${ARCHIVE_REL}/stale.md`]: 'already here',
    }),
  })
  const plan = planArchive(archiveInput())
  assert.equal(plan.ok, true)
  await assert.rejects(
    () => executeArchive({ cwd: CWD, plan, io }),
    /archive target already exists/,
  )
  // Nothing was written or moved.
  assert.equal(io.read(MAIN_PATH), MAIN)
  assert.equal(io.exists(`${CHANGE_REL}/proposal.md`), true)
})

test('executeArchive refuses a missing change directory', async () => {
  const io = makeFakeIo({ files: absFiles({ [MAIN_PATH]: MAIN }) })
  const plan = planArchive(archiveInput())
  await assert.rejects(
    () => executeArchive({ cwd: CWD, plan, io }),
    /change directory does not exist/,
  )
})

test('executeArchive rejects a tampered archive target', async () => {
  const io = makeFakeIo({ files: absFiles(changeTreeFiles()) })
  const plan = planArchive(archiveInput())
  const tampered = {
    ...plan,
    archiveRel: 'openspec/changes/archive/../../evil',
  }
  await assert.rejects(
    () => executeArchive({ cwd: CWD, plan: tampered, io }),
    /does not match its change\/date/,
  )
  assert.equal(io.read(MAIN_PATH), MAIN)
})

test('executeArchive falls back to copy+remove when rename crosses devices', async () => {
  const io = makeFakeIo({
    files: absFiles(changeTreeFiles()),
    failures: [{ method: 'rename', pathIncludes: CHANGE_REL, code: 'EXDEV' }],
  })
  const plan = planArchive(archiveInput())
  const result = await executeArchive({ cwd: CWD, plan, io })
  assert.deepEqual(result, { moved: true, target: ARCHIVE_REL })
  assert.equal(io.exists(`${CHANGE_REL}/proposal.md`), false)
  assert.equal(io.read(`${ARCHIVE_REL}/.openspec.yaml`), METADATA_YAML)
  assert.equal(io.read(`${ARCHIVE_REL}/proposal.md`), '# Why\n\nA change.\n')
  assert.equal(io.read(MAIN_PATH), plan.write.writes[0].content)
})

test('executeArchive restores the main specs when the move fails', async () => {
  const io = makeFakeIo({
    files: absFiles(changeTreeFiles()),
    failures: [{ method: 'rename', pathIncludes: CHANGE_REL, code: 'EIO' }],
  })
  const plan = planArchive(archiveInput())
  await assert.rejects(
    () => executeArchive({ cwd: CWD, plan, io }),
    (error) => /archive failed/.test(error.message) && /main specs were restored/.test(error.message),
  )
  // The sync write was rolled back and the change tree is untouched.
  assert.equal(io.read(MAIN_PATH), MAIN)
  assert.equal(io.exists(`${CHANGE_REL}/proposal.md`), true)
  assert.equal(io.exists(`${CHANGE_REL}/.openspec.yaml`), true)
  assert.equal(io.exists(`${ARCHIVE_REL}/proposal.md`), false)
  assert.deepEqual(io.tempKeys(), [])
})

test('executeArchive rolls back when the sync write itself fails', async () => {
  const io = makeFakeIo({
    files: absFiles(changeTreeFiles()),
    failures: [{ method: 'writeFile', pathIncludes: MAIN_PATH }],
  })
  const plan = planArchive(archiveInput())
  await assert.rejects(() => executeArchive({ cwd: CWD, plan, io }), /sync apply failed/)
  assert.equal(io.read(MAIN_PATH), MAIN)
  assert.equal(io.exists(`${CHANGE_REL}/proposal.md`), true)
  assert.equal(io.exists(`${ARCHIVE_REL}/proposal.md`), false)
})

test('skip_specs archives without touching the main specs', async () => {
  const io = makeFakeIo({ files: absFiles(changeTreeFiles()) })
  const plan = planArchive(archiveInput({
    metadata: metadata({ skip_specs: true }),
    syncPlan: null,
  }))
  assert.equal(plan.ok, true)
  const result = await executeArchive({ cwd: CWD, plan, io })
  assert.deepEqual(result, { moved: true, target: ARCHIVE_REL })
  assert.equal(io.read(MAIN_PATH), MAIN)
  assert.equal(io.exists(`${CHANGE_REL}/proposal.md`), false)
  assert.equal(io.exists(`${ARCHIVE_REL}/proposal.md`), true)
  // No spec write calls happened at all.
  assert.equal(io.calls.some((call) => call.method === 'writeFile'), false)
})

test('retire_capabilities removes the last main spec during archive', async () => {
  const soloMain = `# solo Specification

## Purpose
Solo exists to test retirement.

## Requirements

### Requirement: Only
The system SHALL have exactly one requirement.

#### Scenario: One
- **WHEN** one
- **THEN** one
`
  const removeDelta = `## REMOVED Requirements

### Requirement: Only

**Reason**: capability retired.
`
  const syncPlan = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: 'openspec/specs/solo/spec.md', text: soloMain }],
    deltas: [{ path: 'specs/solo/spec.md', text: removeDelta }],
    retireCapabilities: true,
  })
  assert.equal(syncPlan.ok, true)
  assert.equal(syncPlan.writes[0].action, 'remove')

  const io = makeFakeIo({
    files: absFiles({
      [`${CHANGE_REL}/proposal.md`]: '# Why\n',
      [`${CHANGE_REL}/.openspec.yaml`]: METADATA_YAML,
      [`${CHANGE_REL}/specs/solo/spec.md`]: removeDelta,
      'openspec/specs/solo/spec.md': soloMain,
    }),
  })
  const plan = planArchive(archiveInput({
    syncPlan,
    metadata: metadata({ retire_capabilities: true }),
  }))
  assert.equal(plan.ok, true)
  assert.equal(plan.retireCapabilities, true)
  const result = await executeArchive({ cwd: CWD, plan, io })
  assert.deepEqual(result, { moved: true, target: ARCHIVE_REL })
  assert.equal(io.exists('openspec/specs/solo/spec.md'), false)
  assert.equal(io.exists(`${ARCHIVE_REL}/specs/solo/spec.md`), true)
})

test('a failed move after retirement restores the deleted main spec', async () => {
  const soloMain = `# solo Specification

## Purpose
Solo exists to test retirement.

## Requirements

### Requirement: Only
The system SHALL have exactly one requirement.

#### Scenario: One
- **WHEN** one
- **THEN** one
`
  const removeDelta = `## REMOVED Requirements

### Requirement: Only

**Reason**: capability retired.
`
  const syncPlan = planSync({
    changeName: CHANGE_NAME,
    mainSpecs: [{ path: 'openspec/specs/solo/spec.md', text: soloMain }],
    deltas: [{ path: 'specs/solo/spec.md', text: removeDelta }],
    retireCapabilities: true,
  })
  const io = makeFakeIo({
    files: absFiles({
      [`${CHANGE_REL}/proposal.md`]: '# Why\n',
      [`${CHANGE_REL}/.openspec.yaml`]: METADATA_YAML,
      [`${CHANGE_REL}/specs/solo/spec.md`]: removeDelta,
      'openspec/specs/solo/spec.md': soloMain,
    }),
    failures: [{ method: 'rename', pathIncludes: CHANGE_REL, code: 'EIO' }],
  })
  const plan = planArchive(archiveInput({
    syncPlan,
    metadata: metadata({ retire_capabilities: true }),
  }))
  await assert.rejects(() => executeArchive({ cwd: CWD, plan, io }), /main specs were restored/)
  // The retirement was rolled back: the main spec is back and the change is intact.
  assert.equal(io.read('openspec/specs/solo/spec.md'), soloMain)
  assert.equal(io.exists(`${CHANGE_REL}/proposal.md`), true)
  assert.equal(io.exists(`${ARCHIVE_REL}/proposal.md`), false)
})
