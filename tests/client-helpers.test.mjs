/**
 * Unit tests for the pure browser-side helpers (`src/client-helpers.js`).
 *
 * These run without a DOM and without touching the filesystem:
 *   node --test --test-isolation=none tests/client-helpers.test.mjs
 *
 * Locale text is injected through a fake `t()` built from the same `{name}`
 * placeholder convention the plugin's dictionaries use, so the tests assert
 * formatting behavior rather than translated copy.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  archiveEntryDate,
  archiveEntryLabel,
  artifactLabel,
  artifactProgress,
  artifactRank,
  artifactStatusCounts,
  artifactStatusText,
  artifactStatusTone,
  blockedArtifacts,
  countTaskCheckboxes,
  deltaOperationCounts,
  deltaSummaryText,
  deriveNextAction,
  documentShownLines,
  documentTruncationText,
  groupArchivedByLocalDate,
  groupSpecsByPath,
  issueLevelTone,
  moreItemsText,
  nextActionText,
  paginate,
  schemaSourceText,
  sortArtifacts,
  taskProgressInfo,
  taskProgressText,
  validationIssueLocation,
  validationSummaryText,
} from '../src/client-helpers.js'

/** Fake translator built from the same placeholder convention as the panel dictionaries. */
const T = {
  artifactDone: '完成',
  artifactSkipped: '跳过',
  artifactReady: '可创建',
  artifactBlocked: '阻塞',
  artifactUnknown: '未知',
  deltaAdded: '+{count} 新增',
  deltaModified: '{count} 修改',
  deltaRemoved: '{count} 删除',
  deltaRenamed: '{count} 重命名',
  moreItems: '还有 {count} 个',
  validationClean: '无校验问题',
  validationSummary: '{errors} 错误 · {warnings} 警告',
  docTruncated: '{total} 行文档，仅显示前 {shown} 行',
  docTruncatedSimple: '仅显示前 {shown} 行',
  taskProgress: '{done}/{total}',
  schemaProject: '项目',
  schemaBuiltin: '内置',
  schemaUnknown: '未知',
  nextActionPropose: '提案',
  nextActionUpdate: '继续规划',
  nextActionApply: '实施',
  nextActionArchive: '归档',
}
/** @param {string} key */
const t = (key) => T[key] ?? key

test('artifactLabel: canonical and custom ids', () => {
  assert.equal(artifactLabel('proposal'), 'Proposal')
  assert.equal(artifactLabel('specs'), 'Specs')
  assert.equal(artifactLabel('research'), 'Research')
  assert.equal(artifactLabel('user_auth-flow'), 'User Auth Flow')
  assert.equal(artifactLabel(''), '')
  assert.equal(artifactLabel(null), '')
})

test('artifactRank: canonical ids rank before custom ones', () => {
  assert.equal(artifactRank('proposal'), 0)
  assert.equal(artifactRank('specs'), 1)
  assert.equal(artifactRank('design'), 2)
  assert.equal(artifactRank('tasks'), 3)
  assert.equal(artifactRank('research'), 100)
})

test('sortArtifacts: stable canonical order then schema order for custom ids', () => {
  const input = [
    { id: 'tasks' },
    { id: 'research' },
    { id: 'proposal' },
    { id: 'audit' },
    { id: 'specs' },
  ]
  const sorted = sortArtifacts(input).map((artifact) => artifact.id)
  assert.deepEqual(sorted, ['proposal', 'specs', 'tasks', 'research', 'audit'])
  // Input is not mutated.
  assert.deepEqual(input.map((artifact) => artifact.id), ['tasks', 'research', 'proposal', 'audit', 'specs'])
  assert.deepEqual(sortArtifacts(undefined), [])
})

test('artifactStatusTone: native statuses map to tone families', () => {
  assert.equal(artifactStatusTone('done'), 'success')
  assert.equal(artifactStatusTone('skipped'), 'muted')
  assert.equal(artifactStatusTone('ready'), 'business')
  assert.equal(artifactStatusTone('blocked'), 'warn')
  assert.equal(artifactStatusTone('nonsense'), 'warn')
})

test('artifactStatusText: localized chip text with fallback', () => {
  assert.equal(artifactStatusText(t, 'done'), '完成')
  assert.equal(artifactStatusText(t, 'skipped'), '跳过')
  assert.equal(artifactStatusText(t, 'ready'), '可创建')
  assert.equal(artifactStatusText(t, 'blocked'), '阻塞')
  assert.equal(artifactStatusText(t, 'weird'), '未知')
  assert.equal(artifactStatusText(undefined, 'done'), 'artifactDone')
})

test('artifactStatusCounts and artifactProgress count skipped as satisfied', () => {
  const artifacts = [
    { id: 'proposal', status: 'done' },
    { id: 'specs', status: 'skipped' },
    { id: 'design', status: 'ready' },
    { id: 'tasks', status: 'blocked', missingDeps: ['design'] },
  ]
  assert.deepEqual(artifactStatusCounts(artifacts), { done: 1, skipped: 1, ready: 1, blocked: 1 })
  assert.deepEqual(artifactProgress(artifacts), { done: 2, total: 4, percent: 50 })
  assert.deepEqual(artifactProgress([]), { done: 0, total: 0, percent: 0 })
})

test('blockedArtifacts: only blocked rows with their missing deps', () => {
  const artifacts = [
    { id: 'design', status: 'blocked', missingDeps: ['proposal'] },
    { id: 'proposal', status: 'done' },
    { id: 'tasks', status: 'blocked', missingDeps: ['design', 'specs'] },
  ]
  assert.deepEqual(blockedArtifacts(artifacts), [
    { id: 'design', missingDeps: ['proposal'] },
    { id: 'tasks', missingDeps: ['design', 'specs'] },
  ])
  assert.deepEqual(blockedArtifacts(undefined), [])
})

test('deltaOperationCounts: totals from the host delta summary', () => {
  assert.deepEqual(deltaOperationCounts({ ADDED: 2, MODIFIED: 1, REMOVED: 0, RENAMED: 3 }), {
    ADDED: 2,
    MODIFIED: 1,
    REMOVED: 0,
    RENAMED: 3,
    total: 6,
  })
  assert.deepEqual(deltaOperationCounts(undefined), { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, total: 0 })
})

test('deltaSummaryText: localized per-operation summary', () => {
  assert.equal(
    deltaSummaryText(t, { ADDED: 2, MODIFIED: 1, REMOVED: 0, RENAMED: 3, files: ['specs/a/spec.md'] }),
    '+2 新增 · 1 修改 · 0 删除 · 3 重命名',
  )
  // Files exist but all counts are zero: still render the four zero counts rather than hiding the section.
  assert.equal(
    deltaSummaryText(t, { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: ['specs/a/spec.md'] }),
    '+0 新增 · 0 修改 · 0 删除 · 0 重命名',
  )
  // No delta at all: empty string so the caller can hide the row.
  assert.equal(deltaSummaryText(t, undefined), '')
  assert.equal(deltaSummaryText(t, { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0, files: [] }), '')
})

test('archiveEntryLabel / archiveEntryDate derive from native archive rows', () => {
  assert.equal(archiveEntryLabel({ name: '2026-10-20-add-dark-mode', changeName: 'add-dark-mode' }), 'add-dark-mode')
  assert.equal(archiveEntryLabel({ name: '2026-10-20-add-dark-mode' }), 'add-dark-mode')
  assert.equal(archiveEntryLabel({ name: 'legacy-change' }), 'legacy-change')
  assert.equal(archiveEntryLabel(undefined), '')
  assert.equal(archiveEntryDate({ name: '2026-10-20-add-dark-mode', date: '2026-10-20' }), '2026-10-20')
  assert.equal(archiveEntryDate({ name: '2026-10-20-add-dark-mode' }), '2026-10-20')
  assert.equal(archiveEntryDate({ name: 'legacy-change' }), null)
  assert.equal(archiveEntryDate({ name: 'x', date: 'not-a-date' }), null)
})

test('groupArchivedByLocalDate: newest first, unknown last, entries sorted', () => {
  const groups = groupArchivedByLocalDate([
    { name: '2026-10-10-b-change', changeName: 'b-change', date: '2026-10-10' },
    { name: '2026-10-20-a-change', changeName: 'a-change', date: '2026-10-20' },
    { name: '2026-10-10-a-change', changeName: 'a-change', date: '2026-10-10' },
    { name: 'legacy', changeName: 'legacy' },
  ])
  assert.equal(groups.length, 3)
  assert.equal(groups[0].date, '2026-10-20')
  assert.deepEqual(groups[0].entries.map((entry) => entry.changeName), ['a-change'])
  assert.equal(groups[1].date, '2026-10-10')
  assert.deepEqual(groups[1].entries.map((entry) => entry.changeName), ['a-change', 'b-change'])
  assert.equal(groups[2].date, null)
  assert.deepEqual(groups[2].entries.map((entry) => entry.changeName), ['legacy'])
  assert.deepEqual(groupArchivedByLocalDate(undefined), [])
})

test('paginate: slices without dropping the tail', () => {
  const items = Array.from({ length: 10 }, (_, index) => index)
  const first = paginate(items, { pageSize: 4 })
  assert.deepEqual(first.items, [0, 1, 2, 3])
  assert.equal(first.total, 10)
  assert.equal(first.shown, 4)
  assert.equal(first.hidden, 6)
  assert.equal(first.hasNext, true)
  assert.equal(first.hasPrev, false)
  assert.equal(first.nextOffset, 4)

  const second = paginate(items, { offset: 4, pageSize: 4 })
  assert.deepEqual(second.items, [4, 5, 6, 7])
  assert.equal(second.hidden, 2)
  assert.equal(second.hasPrev, true)
  assert.equal(second.hasNext, true)

  const last = paginate(items, { offset: 8, pageSize: 4 })
  assert.deepEqual(last.items, [8, 9])
  assert.equal(last.hidden, 0)
  assert.equal(last.hasNext, false)

  // Oversized offset clamps to the end instead of returning garbage.
  const clamped = paginate(items, { offset: 99, pageSize: 4 })
  assert.deepEqual(clamped.items, [])
  assert.equal(clamped.offset, 10)
  assert.equal(clamped.hidden, 0)
  assert.equal(clamped.hasNext, false)

  // Empty list and invalid sizes fall back to a sane page.
  assert.deepEqual(paginate([], { pageSize: 0 }), {
    items: [],
    offset: 0,
    pageSize: 8,
    total: 0,
    shown: 0,
    hidden: 0,
    nextOffset: 0,
    hasPrev: false,
    hasNext: false,
  })
  assert.deepEqual(paginate(undefined).items, [])
})

test('moreItemsText: localized hidden-count hint', () => {
  assert.equal(moreItemsText(t, 3), '还有 3 个')
  assert.equal(moreItemsText(t, 0), '还有 0 个')
})

test('validationSummaryText: clean state vs error/warning counts', () => {
  assert.equal(validationSummaryText(t, { errors: 0, warnings: 0 }), '无校验问题')
  assert.equal(validationSummaryText(t, { errors: 2, warnings: 1 }), '2 错误 · 1 警告')
  assert.equal(validationSummaryText(t, undefined), '无校验问题')
  assert.equal(validationSummaryText(t, { errors: 1 }), '1 错误 · 0 警告')
})

test('validationIssueLocation: path and optional line', () => {
  assert.equal(validationIssueLocation({ path: 'proposal.md', line: 4 }), 'proposal.md:4')
  assert.equal(validationIssueLocation({ path: 'proposal.md' }), 'proposal.md')
  assert.equal(validationIssueLocation({ line: 7 }), '7')
  assert.equal(validationIssueLocation({}), '')
})

test('issueLevelTone: validation levels map to tones', () => {
  assert.equal(issueLevelTone('ERROR'), 'error')
  assert.equal(issueLevelTone('WARNING'), 'warn')
  assert.equal(issueLevelTone('INFO'), 'info')
  assert.equal(issueLevelTone('OTHER'), 'info')
})

test('documentTruncationText: includes shown and total lines', () => {
  assert.equal(documentTruncationText(t, { shown: 2000, totalLines: 3210 }), '3210 行文档，仅显示前 2000 行')
  assert.equal(documentTruncationText(t, { shown: 2000 }), '仅显示前 2000 行')
})

test('documentShownLines: counts displayed lines', () => {
  assert.equal(documentShownLines('a\nb\nc'), 3)
  assert.equal(documentShownLines('a\r\nb'), 2)
  assert.equal(documentShownLines(''), 0)
})

test('taskProgressInfo / taskProgressText: independent task progress', () => {
  assert.deepEqual(taskProgressInfo({ total: 8, done: 3 }), {
    total: 8,
    done: 3,
    remaining: 5,
    percent: 38,
    complete: false,
  })
  assert.deepEqual(taskProgressInfo({ total: 2, done: 2 }), {
    total: 2,
    done: 2,
    remaining: 0,
    percent: 100,
    complete: true,
  })
  assert.deepEqual(taskProgressInfo(null), { total: 0, done: 0, remaining: 0, percent: 0, complete: false })
  assert.equal(taskProgressText(t, { total: 8, done: 3 }), '3/8')
  assert.equal(taskProgressText(t, null), '')
})

test('countTaskCheckboxes: native task parity for the archive fallback', () => {
  const text = [
    '- [x] 1.1 done with dash',
    '* [ ] 1.2 open with star',
    '+ [~] 1.3 unusual marker is unfinished',
    '- [ ] 1.4 open',
    '- [ ]',
    '- [docs](https://example.com) link bullet is not a task',
    '## Heading [x] not a task',
  ].join('\n')
  assert.deepEqual(countTaskCheckboxes(text), { total: 5, done: 1 })
  assert.deepEqual(countTaskCheckboxes('- [ x] spaced done\n- [X ] spaced done'), { total: 2, done: 2 })
  assert.deepEqual(countTaskCheckboxes(''), { total: 0, done: 0 })
})

test('schemaSourceText: project vs builtin snapshot', () => {
  assert.equal(schemaSourceText(t, 'project'), '项目')
  assert.equal(schemaSourceText(t, 'builtin'), '内置')
  assert.equal(schemaSourceText(t, 'anything'), '未知')
})

test('deriveNextAction: native artifact state, not the legacy phase order', () => {
  assert.deepEqual(deriveNextAction(undefined), { kind: 'propose', labelKey: 'nextActionPropose', line: '/opsx-propose ' })
  assert.deepEqual(deriveNextAction({ name: 'add-dark-mode', artifacts: [{ id: 'proposal', status: 'done' }], isPlanningComplete: false, listStatus: 'no-tasks' }), {
    kind: 'update',
    labelKey: 'nextActionUpdate',
    line: '/opsx-update add-dark-mode',
  })
  // Planning complete but tasks open: apply, even before every artifact is done? isPlanningComplete implies all done/skipped.
  assert.deepEqual(deriveNextAction({ name: 'add-dark-mode', isPlanningComplete: true, listStatus: 'in-progress' }), {
    kind: 'apply',
    labelKey: 'nextActionApply',
    line: '/opsx-apply add-dark-mode',
  })
  // No tasks artifact => listStatus no-tasks still means apply can continue.
  assert.deepEqual(deriveNextAction({ name: 'add-dark-mode', isPlanningComplete: true, listStatus: 'no-tasks' }), {
    kind: 'apply',
    labelKey: 'nextActionApply',
    line: '/opsx-apply add-dark-mode',
  })
  assert.deepEqual(deriveNextAction({ name: 'add-dark-mode', isPlanningComplete: true, listStatus: 'complete' }), {
    kind: 'archive',
    labelKey: 'nextActionArchive',
    line: '/opsx-archive add-dark-mode --yes',
  })
})

test('nextActionText: localized action label', () => {
  assert.equal(nextActionText(t, { labelKey: 'nextActionApply' }), '实施')
  assert.equal(nextActionText(t, undefined), '实施')
})

test('groupSpecsByPath: nested capability grouping instead of slash names', () => {
  const rows = groupSpecsByPath([
    { name: 'billing' },
    { name: 'identity/user-auth' },
    { name: 'identity/session' },
  ])
  assert.deepEqual(
    rows.map((row) => [row.kind, row.label, row.fullName, row.depth]),
    [
      ['spec', 'billing', 'billing', 0],
      ['group', 'identity', 'identity', 0],
      ['spec', 'session', 'identity/session', 1],
      ['spec', 'user-auth', 'identity/user-auth', 1],
    ],
  )
  // A capability that also has children keeps its own leaf row under the group header.
  const mixed = groupSpecsByPath([{ name: 'identity' }, { name: 'identity/user-auth' }])
  assert.deepEqual(
    mixed.map((row) => [row.kind, row.label, row.depth]),
    [
      ['group', 'identity', 0],
      ['spec', 'identity', 1],
      ['spec', 'user-auth', 1],
    ],
  )
  // Deeper nesting nests rows recursively.
  const deep = groupSpecsByPath([{ name: 'identity/user/auth' }])
  assert.deepEqual(
    deep.map((row) => [row.kind, row.fullName, row.depth]),
    [
      ['group', 'identity', 0],
      ['group', 'identity/user', 1],
      ['spec', 'identity/user/auth', 2],
    ],
  )
  assert.deepEqual(groupSpecsByPath(undefined), [])
})

test('helpers: missing translate function falls back to the locale key', () => {
  assert.equal(artifactStatusText(undefined, 'done'), 'artifactDone')
  assert.equal(deltaSummaryText(undefined, { ADDED: 1, files: ['x'] }), 'deltaAdded · deltaModified · deltaRemoved · deltaRenamed')
})
