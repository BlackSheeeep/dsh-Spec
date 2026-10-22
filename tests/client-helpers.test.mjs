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
  CHANGE_PICKER_COMMANDS,
  changeDigestTotals,
  changeOverviewFacts,
  changePickerAvailable,
  changePickerLine,
  changePickerOptions,
  changeSummaryInfo,
  countTaskCheckboxes,
  deltaFileOperationCounts,
  deltaFileOpsText,
  deltaOperationCounts,
  deltaSummaryText,
  deriveNextAction,
  documentShownLines,
  documentTruncationText,
  groupArchivedByLocalDate,
  groupChangeDocuments,
  groupSpecsByPath,
  issueLevelTone,
  moreItemsText,
  nextActionText,
  normalizeChangeSummary,
  normalizeDeltaFiles,
  paginate,
  pendingAcceptanceTasks,
  schemaSourceText,
  sortArtifacts,
  taskChecklistView,
  taskProgressInfo,
  taskProgressText,
  validationIssueLocation,
  validationSummaryText,
  workspaceProgress,
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
  nextActionResume: '继续规划',
  nextActionUpdate: '继续规划',
  nextActionApply: '实施',
  nextActionArchive: '归档',
  pickerPlanning: '规划中',
  pickerApply: '可实施',
  pickerComplete: '已完成',
  pickerTasks: '任务 {done}/{total}',
  pickerErrors: '{count} ERROR',
  pickerWarnings: '{count} WARNING',
  skipSpecs: 'skip_specs',
  artifactsLabel: '工件',
  taskList: '任务清单',
  overviewCapabilities: '{count} 个 capability',
  quickNext: '下一步',
}
/** @param {string} key */
const t = (key) => T[key] ?? key

/** English counterpart used to prove the picker summary is translated, not hardcoded. */
const T_EN = {
  pickerPlanning: 'Planning',
  pickerApply: 'Ready to apply',
  pickerComplete: 'Complete',
  pickerTasks: 'Tasks {done}/{total}',
  pickerErrors: '{count} ERROR',
  pickerWarnings: '{count} WARNING',
  skipSpecs: 'skip_specs',
}
/** @param {string} key */
const tEn = (key) => T_EN[key] ?? key

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

test('workspaceProgress: artifacts and tasks are two independent meters', () => {
  assert.deepEqual(workspaceProgress([]), {
    changes: 0,
    artifacts: { done: 0, total: 0, percent: 0, empty: true },
    tasks: { done: 0, total: 0, percent: 0, empty: true },
    hasContent: false,
  })

  // The reported regression shape: every artifact is done/skipped while tasks are open.
  const planningDone = workspaceProgress([
    {
      artifacts: [{ status: 'done' }, { status: 'skipped' }, { status: 'done' }],
      tasks: { total: 69, done: 21, items: [] },
    },
  ])
  assert.deepEqual(planningDone.artifacts, { done: 3, total: 3, percent: 100, empty: false })
  assert.deepEqual(planningDone.tasks, { done: 21, total: 69, percent: 30, empty: false })
  assert.equal(planningDone.hasContent, true)

  // No task list anywhere: the task meter is empty (rendered as —), not 0%.
  const noTasks = workspaceProgress([{ artifacts: [{ status: 'ready' }], tasks: null }])
  assert.equal(noTasks.artifacts.percent, 0)
  assert.equal(noTasks.tasks.empty, true)

  // Multiple changes aggregate numerators and denominators per meter, never merged.
  const multi = workspaceProgress([
    { artifacts: [{ status: 'done' }, { status: 'ready' }], tasks: { total: 4, done: 1 } },
    { artifacts: [{ status: 'done' }], tasks: { total: 2, done: 2 } },
  ])
  assert.deepEqual(multi.artifacts, { done: 2, total: 3, percent: 67, empty: false })
  assert.deepEqual(multi.tasks, { done: 3, total: 6, percent: 50, empty: false })
  assert.equal(multi.changes, 2)
})

test('taskChecklistView: bounded detail rows and explicit remainder', () => {
  const full = taskChecklistView({
    total: 3,
    done: 1,
    items: [
      { id: '1.1', text: 'a', done: true, depth: 0, line: 3, manual: false },
      { id: '1.2', text: 'b', done: false, depth: 1, line: 4, manual: true },
      { id: '1.3', text: 'c', done: false, depth: 2, line: 5, manual: false },
    ],
  })
  assert.equal(full.total, 3)
  assert.equal(full.done, 1)
  assert.equal(full.shown, 3)
  assert.equal(full.hidden, 0)
  assert.equal(full.missing, false)
  assert.equal(full.limited, false)
  assert.deepEqual(full.items[1], { id: '1.2', text: 'b', done: false, depth: 1, line: 4, manual: true })

  const capped = taskChecklistView({
    total: 250,
    done: 10,
    items: Array.from({ length: 200 }, (_, index) => ({ id: `${index + 1}`, text: `t${index + 1}`, done: false, depth: 0 })),
  })
  assert.equal(capped.shown, 200)
  assert.equal(capped.hidden, 50)
  assert.equal(capped.limited, true)
  assert.equal(capped.missing, false)

  // Older Host: counts but no detail rows — the panel offers tasks.md instead of a false 0.
  const oldHost = taskChecklistView({ total: 8, done: 2 })
  assert.equal(oldHost.missing, true)
  assert.equal(oldHost.limited, false)
  assert.equal(oldHost.shown, 0)
  assert.equal(oldHost.hidden, 0)

  assert.equal(taskChecklistView(null).total, 0)
  const malformed = taskChecklistView({ total: 1, done: 0, items: [null, { text: 1, done: 1, depth: '2' }] })
  assert.deepEqual(malformed.items, [{ id: null, text: '1', done: false, depth: 0, line: null, manual: false }])
})

test('pendingAcceptanceTasks: aggregates unchecked tasks and splits manual from automatic', () => {
  const pending = pendingAcceptanceTasks([
    {
      name: 'add-dark-mode',
      tasks: {
        items: [
          { id: '1.1', text: '1.1 [人工验收] check contrast', done: false, line: 3, manual: true },
          { id: '1.2', text: '1.2 implement toggle', done: false, line: 4, manual: false },
          { id: '1.3', text: '1.3 already done', done: true, line: 5, manual: true },
        ],
      },
    },
    {
      name: 'fix-login',
      tasks: {
        items: [
          { id: '2.1', text: '2.1 【人工验收】 verify error copy', done: false, line: 8 },
          { id: '2.2', text: '2.2 add null guard', done: false, line: 9, manual: false },
        ],
      },
    },
    { name: 'no-tasks', tasks: null },
  ])
  assert.equal(pending.total, 4)
  assert.deepEqual(
    pending.manual.map((item) => ({ change: item.change, id: item.id, text: item.text, line: item.line })),
    [
      { change: 'add-dark-mode', id: '1.1', text: '1.1 check contrast', line: 3 },
      { change: 'fix-login', id: '2.1', text: '2.1 verify error copy', line: 8 },
    ],
  )
  assert.deepEqual(
    pending.automatic.map((item) => ({ change: item.change, id: item.id, line: item.line })),
    [
      { change: 'add-dark-mode', id: '1.2', line: 4 },
      { change: 'fix-login', id: '2.2', line: 9 },
    ],
  )
  assert.deepEqual(pendingAcceptanceTasks([]), { total: 0, manual: [], automatic: [] })
  assert.deepEqual(pendingAcceptanceTasks(null), { total: 0, manual: [], automatic: [] })
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
  // Incomplete planning resumes through propose: update can only revise files
  // that already exist, so it can never finish an interrupted plan.
  assert.deepEqual(deriveNextAction({ name: 'add-dark-mode', artifacts: [{ id: 'proposal', status: 'done' }], isPlanningComplete: false, listStatus: 'no-tasks' }), {
    kind: 'propose',
    labelKey: 'nextActionResume',
    line: '/opsx-propose add-dark-mode',
  })
  // A change with nothing generated yet resumes from the first missing artifact.
  assert.deepEqual(deriveNextAction({ name: 'add-dark-mode', artifacts: [{ id: 'proposal', status: 'ready' }], isPlanningComplete: false, listStatus: 'no-tasks' }), {
    kind: 'propose',
    labelKey: 'nextActionResume',
    line: '/opsx-propose add-dark-mode',
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
  // A finished change points at the default AI archive workflow; the
  // deterministic fast path is opt-in only (`--yes` typed by the user).
  assert.deepEqual(deriveNextAction({ name: 'add-dark-mode', isPlanningComplete: true, listStatus: 'complete' }), {
    kind: 'archive',
    labelKey: 'nextActionArchive',
    line: '/opsx-archive add-dark-mode',
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

test('CHANGE_PICKER_COMMANDS: the five change-taking commands', () => {
  assert.deepEqual([...CHANGE_PICKER_COMMANDS], ['opsx-update', 'opsx-apply', 'opsx-sync', 'opsx-archive', 'opsx-validate'])
})

test('changePickerAvailable: only ready with two or more changes in motion', () => {
  assert.equal(changePickerAvailable(undefined), false)
  assert.equal(changePickerAvailable(null), false)
  assert.equal(changePickerAvailable({ status: 'loading', changes: [{ name: 'a' }, { name: 'b' }] }), false)
  assert.equal(changePickerAvailable({ status: 'missing' }), false)
  assert.equal(changePickerAvailable({ status: 'error' }), false)
  assert.equal(changePickerAvailable({ status: 'ready' }), false)
  assert.equal(changePickerAvailable({ status: 'ready', changes: [{ name: 'only' }] }), false)
  assert.equal(changePickerAvailable({ status: 'ready', changes: [{ name: 'a' }, { name: 'b' }] }), true)
  assert.equal(changePickerAvailable({ status: 'ready', changes: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }), true)
})

test('changePickerLine: full command line with a trailing space', () => {
  assert.equal(changePickerLine('opsx-update', 'align-native-openspec'), '/opsx-update align-native-openspec ')
  // A leading slash is tolerated so callers may pass either spelling.
  assert.equal(changePickerLine('/opsx-archive', 'add-dark-mode'), '/opsx-archive add-dark-mode ')
  // Change names are preserved verbatim (no slugify, no re-casing).
  assert.equal(changePickerLine('opsx-apply', 'my-change_v2.1'), '/opsx-apply my-change_v2.1 ')
  for (const command of CHANGE_PICKER_COMMANDS) {
    assert.equal(changePickerLine(command, 'x'), `/${command} x `)
  }
})

test('changePickerOptions: label + native status summary per change', () => {
  const state = {
    status: 'ready',
    changes: [
      {
        name: 'align-native-openspec',
        isPlanningComplete: false,
        listStatus: 'no-tasks',
        tasks: { done: 0, total: 3 },
        validation: { errors: 2, warnings: 0 },
        metadata: { skip_specs: true },
      },
      {
        name: 'add-dark-mode',
        isPlanningComplete: true,
        listStatus: 'in-progress',
        tasks: { done: 1, total: 2 },
        validation: { errors: 0, warnings: 1 },
      },
      {
        name: 'panel-dual-rings-task-list',
        isPlanningComplete: true,
        listStatus: 'complete',
        tasks: { done: 3, total: 3 },
        validation: { errors: 0, warnings: 0 },
      },
    ],
  }
  assert.deepEqual(changePickerOptions(state, t), [
    {
      name: 'align-native-openspec',
      label: 'align-native-openspec',
      detail: '规划中 · 任务 0/3 · 2 ERROR · skip_specs',
    },
    { name: 'add-dark-mode', label: 'add-dark-mode', detail: '可实施 · 任务 1/2 · 1 WARNING' },
    { name: 'panel-dual-rings-task-list', label: 'panel-dual-rings-task-list', detail: '已完成 · 任务 3/3' },
  ])
  // A change with no tasks / issues / skip_specs still gets a state-only detail.
  assert.deepEqual(changePickerOptions({ status: 'ready', changes: [{ name: 'bare' }] }, t), [
    { name: 'bare', label: 'bare', detail: '规划中' },
  ])
  // Non-ready and empty states expose no rows.
  assert.deepEqual(changePickerOptions(undefined, t), [])
  assert.deepEqual(changePickerOptions({ status: 'missing' }, t), [])
  assert.deepEqual(changePickerOptions({ status: 'ready' }, t), [])
  // Malformed rows are filtered instead of rendering empty options.
  assert.deepEqual(
    changePickerOptions({ status: 'ready', changes: [null, { name: '' }, { name: 'ok' }] }, t).map((row) => row.name),
    ['ok'],
  )
})

test('changePickerOptions: zh/en summaries differ and fill every placeholder', () => {
  const state = {
    status: 'ready',
    changes: [
      { name: 'a-change', isPlanningComplete: false, tasks: { done: 1, total: 4 }, validation: { errors: 2, warnings: 1 } },
    ],
  }
  const zh = changePickerOptions(state, t)[0].detail
  const en = changePickerOptions(state, tEn)[0].detail
  assert.equal(zh, '规划中 · 任务 1/4 · 2 ERROR · 1 WARNING')
  assert.equal(en, 'Planning · Tasks 1/4 · 2 ERROR · 1 WARNING')
  assert.notEqual(zh, en)
  for (const detail of [zh, en]) assert.equal(/\{\w+\}/.test(detail), false)
})

test('changeSummaryInfo: goal wins, then proposal Why, then placeholder', () => {
  assert.deepEqual(changeSummaryInfo({ goal: '目标文本', why: '为什么文本' }), {
    text: '目标文本',
    source: 'goal',
    truncated: false,
  })
  assert.deepEqual(changeSummaryInfo({ why: '为什么文本', whyTruncated: true }), {
    text: '为什么文本',
    source: 'why',
    truncated: true,
  })
  // changesHidden alone also means a full-text entry is worthwhile.
  assert.equal(changeSummaryInfo({ why: 'why', changesHidden: 2 }).truncated, true)
  assert.deepEqual(changeSummaryInfo({ goal: '   ', why: '   ' }), { text: '', source: 'none', truncated: false })
  assert.deepEqual(changeSummaryInfo(null), { text: '', source: 'none', truncated: false })
})

test('changeDigestTotals: shown + hidden counts without silent loss', () => {
  assert.deepEqual(changeDigestTotals({ changes: ['a', 'b'], changesHidden: 3 }), { shown: 2, total: 5, truncated: true })
  assert.deepEqual(changeDigestTotals({ changes: ['a'], changesHidden: 0, changesTruncated: true }), {
    shown: 1,
    total: 1,
    truncated: true,
  })
  assert.deepEqual(changeDigestTotals(undefined), { shown: 0, total: 0, truncated: false })
})

test('deltaFileOperationCounts / deltaFileOpsText: per-file mix, zeros omitted', () => {
  const file = { path: 'specs/a/spec.md', label: 'a', ADDED: 2, MODIFIED: 0, REMOVED: 1, RENAMED: 0 }
  assert.deepEqual(deltaFileOperationCounts(file), { ADDED: 2, MODIFIED: 0, REMOVED: 1, RENAMED: 0, total: 3 })
  assert.equal(deltaFileOpsText(t, file), '+2 新增 · 1 删除')
  assert.equal(deltaFileOpsText(t, { ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }), '')
})

test('groupChangeDocuments: schema artifact order, delta once, metadata last', () => {
  const change = {
    artifacts: [
      { id: 'proposal', status: 'done', description: 'Initial proposal document' },
      { id: 'specs', status: 'done', description: 'Detailed specifications' },
      { id: 'design', status: 'done', description: 'Technical design' },
      { id: 'tasks', status: 'done', description: 'Implementation checklist' },
    ],
    docs: [
      { path: 'openspec/changes/c/proposal.md', label: 'proposal', artifactId: 'proposal', kind: 'artifact' },
      { path: 'openspec/changes/c/specs/a/spec.md', label: 'a', artifactId: 'specs', kind: 'delta' },
      { path: 'openspec/changes/c/specs/b/spec.md', label: 'b', artifactId: 'specs', kind: 'delta' },
      { path: 'openspec/changes/c/design.md', label: 'design', artifactId: 'design', kind: 'artifact' },
      { path: 'openspec/changes/c/tasks.md', label: 'tasks', artifactId: 'tasks', kind: 'artifact' },
    ],
    delta: {
      files: [
        { path: 'specs/a/spec.md', label: 'a', ADDED: 2, MODIFIED: 0, REMOVED: 0, RENAMED: 0 },
        { path: 'specs/b/spec.md', label: 'b', ADDED: 0, MODIFIED: 1, REMOVED: 0, RENAMED: 0 },
      ],
    },
  }
  const groups = groupChangeDocuments(change)
  assert.deepEqual(
    groups.map((group) => group.id),
    ['proposal', 'specs', 'design', 'tasks', 'metadata'],
  )
  const specs = groups.find((group) => group.id === 'specs')
  assert.equal(specs.kind, 'delta')
  assert.equal(specs.deltas.length, 2)
  assert.deepEqual(specs.deltas[0], { path: 'specs/a/spec.md', label: 'a', ADDED: 2, MODIFIED: 0, REMOVED: 0, RENAMED: 0 })
  // Every document appears exactly once across groups.
  const docPaths = groups.flatMap((group) => group.docs.map((doc) => doc.path))
  assert.equal(new Set(docPaths).size, docPaths.length)
  assert.equal(docPaths.length, 3)
  const tasks = groups.find((group) => group.id === 'tasks')
  assert.equal(tasks.kind, 'artifact')
  assert.equal(groups.at(-1).kind, 'metadata')
  // A tasks artifact without a tasks.md still gets a group for the missing note.
  const early = groupChangeDocuments({ artifacts: [{ id: 'tasks', status: 'ready' }], docs: [], delta: { files: [] } })
  assert.deepEqual(early.map((group) => group.id), ['tasks', 'metadata'])
  // Legacy string delta files still render a row (no counts, never dropped).
  const legacy = groupChangeDocuments({
    artifacts: [{ id: 'specs', status: 'done' }],
    docs: [{ path: 'openspec/changes/c/specs/x/spec.md', label: 'x', artifactId: 'specs', kind: 'delta' }],
    delta: { files: ['specs/x/spec.md'] },
  })
  assert.deepEqual(legacy[0].deltas, [{ path: 'specs/x/spec.md', label: 'x', ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 }])
})

test('groupChangeDocuments: custom schema order is preserved', () => {
  const groups = groupChangeDocuments({
    artifacts: [
      { id: 'research', status: 'done' },
      { id: 'proposal', status: 'done' },
    ],
    docs: [
      { path: 'openspec/changes/c/research.md', label: 'research', artifactId: 'research', kind: 'artifact' },
      { path: 'openspec/changes/c/proposal.md', label: 'proposal', artifactId: 'proposal', kind: 'artifact' },
    ],
    delta: { files: [] },
  })
  assert.deepEqual(groups.map((group) => group.id), ['research', 'proposal', 'metadata'])
})

test('changeOverviewFacts: progress, capability count, issues only when non-zero, next step', () => {
  const change = {
    artifacts: [
      { id: 'proposal', status: 'done' },
      { id: 'tasks', status: 'ready' },
    ],
    tasks: { done: 1, total: 3 },
    delta: { files: [{ path: 'specs/a/spec.md' }, { path: 'specs/b/spec.md' }] },
    validation: { errors: 0, warnings: 0 },
    isPlanningComplete: false,
    nextSteps: [],
  }
  assert.equal(changeOverviewFacts(t, change), '工件 1/2 · 任务清单 1/3 · 2 个 capability · 下一步：继续规划')
  assert.equal(
    changeOverviewFacts(t, { ...change, validation: { errors: 1, warnings: 1 } }),
    '工件 1/2 · 任务清单 1/3 · 2 个 capability · 1 错误 · 1 警告 · 下一步：继续规划',
  )
  assert.equal(changeOverviewFacts(t, {}), '下一步：继续规划')
})

test('normalizeChangeSummary / normalizeDeltaFiles: legacy payloads degrade safely', () => {
  assert.deepEqual(normalizeChangeSummary(undefined), {
    goal: null,
    why: null,
    whyTruncated: false,
    changes: [],
    changesHidden: 0,
    changesTruncated: false,
  })
  assert.deepEqual(normalizeChangeSummary({ goal: ' 目标 ', why: ' why ', changes: ['a', '', 3], changesHidden: 2.5 }), {
    goal: ' 目标 ',
    why: ' why ',
    whyTruncated: false,
    changes: ['a'],
    changesHidden: 2,
    changesTruncated: false,
  })
  assert.deepEqual(normalizeDeltaFiles(['specs/a/spec.md', null, { path: '' }, { path: 'specs/b/spec.md', ADDED: 2 }]), [
    { path: 'specs/a/spec.md', label: '', ADDED: 0, MODIFIED: 0, REMOVED: 0, RENAMED: 0 },
    { path: 'specs/b/spec.md', label: '', ADDED: 2, MODIFIED: 0, REMOVED: 0, RENAMED: 0 },
  ])
  assert.deepEqual(normalizeDeltaFiles(undefined), [])
})

test('normalizeChangeSummary / normalizeDeltaFiles: native payload passes through', () => {
  const nativeSummary = {
    goal: 'goal',
    why: 'why',
    whyTruncated: true,
    changes: ['a', 'b'],
    changesHidden: 3,
    changesTruncated: true,
  }
  assert.deepEqual(normalizeChangeSummary(nativeSummary), nativeSummary)
  assert.deepEqual(normalizeDeltaFiles([{ path: 'specs/a/spec.md', label: 'a', ADDED: 1, MODIFIED: 2, REMOVED: 3, RENAMED: 4 }]), [
    { path: 'specs/a/spec.md', label: 'a', ADDED: 1, MODIFIED: 2, REMOVED: 3, RENAMED: 4 },
  ])
})
