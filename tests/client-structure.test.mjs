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

/** Slice the `const composeFor = …` closure out of `apply()`. */
function composeForSource() {
  const start = clientSource.indexOf('const composeFor = (row) =>')
  assert.notEqual(start, -1, 'src/client.js must define composeFor()')
  const end = clientSource.indexOf('const sessionExists =', start)
  assert.notEqual(end, -1, 'composeFor() must stay in apply() before the session helpers')
  return clientSource.slice(start, end)
}

/** Locale dictionary keys (flat `zh` / `en` strings), in source order. */
function dictionaryKeys() {
  const start = clientSource.indexOf('const T = {')
  const end = clientSource.indexOf('/** Plugin-scoped styles', start)
  assert.notEqual(start, -1, 'src/client.js must define the T dictionaries')
  assert.notEqual(end, -1, 'the T dictionaries must end before the stylesheet')
  const block = clientSource.slice(start, end)
  const zhStart = block.indexOf('zh: {')
  const enStart = block.indexOf('en: {')
  assert.notEqual(zhStart, -1, 'T.zh must exist')
  assert.notEqual(enStart, -1, 'T.en must exist')
  const keysOf = (text) => [...text.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
  return { zh: keysOf(block.slice(zhStart, enStart)), en: keysOf(block.slice(enStart)) }
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

/* -------------------------------------------------------------------- *
 * Human reports (archived-human-report, tasks 3.1–3.4).
 * -------------------------------------------------------------------- */

test('the workspace source exposes both report Host actions', () => {
  // `createWorkspaceSource` ends at the next declaration (`async function`).
  const source = clientSource.slice(
    clientSource.indexOf('function createWorkspaceSource('),
    clientSource.indexOf('async function initWorkspace', clientSource.indexOf('function createWorkspaceSource(')),
  )
  assert.match(source, /callRoute\(ctx, 'report-prompt'/, 'report-prompt must go through callRoute')
  assert.match(source, /callRoute\(ctx, 'report-status'/, 'report-status must go through callRoute')
  assert.match(source, /const reportPrompt = async \(payload\)/)
  assert.match(source, /const reportStatus = async \(payload\)/)
  // Both are part of the source surface the dialog calls.
  const returned = source.slice(source.lastIndexOf('    return {'))
  assert.match(returned, /reportPrompt/)
  assert.match(returned, /reportStatus/)
})

test('ArchiveSection offers both report entries and renders both dialogs', () => {
  const archiveSection = topLevelFunctionSource('ArchiveSection')
  // Period entry in the section header.
  assert.match(archiveSection, /t\('reportPeriodEntry'\)/, 'the archive section header must offer the period report entry')
  assert.match(archiveSection, /const openPeriodReport = \(\) => setReportDialog\(\{ scope: 'range' \}\)/)
  // Per-row entry stops propagation so the row does not expand/collapse.
  assert.match(archiveSection, /const openReport = \(entry\) => \(event\) => \{/, 'each archive row needs a report handler')
  assert.match(archiveSection, /setReportDialog\(\{ scope: 'change', entry \}\)/, 'the row entry opens a single-change report')
  assert.match(archiveSection, /event\.stopPropagation\(\)/, 'the row report entry must not toggle the row')
  assert.match(archiveSection, /t\('reportEntry'\)/, 'the row report entry needs its accessible label')
  // Both dialogs are rendered at the end of the section.
  assert.match(archiveSection, /h\(ReportDialog, \{/)
  assert.match(archiveSection, /h\(ReportPreviewDialog, \{/)
  // The period entry sits in the Section header; the dialogs are SIBLINGS of
  // the collapsible section so a collapsed archive view cannot swallow them.
  assert.match(archiveSection, /action:\s*\n?\s*archived\.length === 0/, 'the period entry must be a Section header action')
  assert.match(archiveSection, /const sectionNode = h\(\s*Section,/, 'the section and its dialogs are separate nodes')
  assert.match(archiveSection, /React\.Fragment/, 'the section and the dialogs share one fragment return')
})

test('WorkspaceDetail hands the archive section its report dependencies', () => {
  const workspaceDetail = topLevelFunctionSource('WorkspaceDetail')
  const callSite = /h\(ArchiveSection, \{[\s\S]*?\}\)/.exec(workspaceDetail)
  assert.notEqual(callSite, null, 'WorkspaceDetail must render ArchiveSection')
  const body = callSite[0]
  assert.match(body, /cwd: row\.cwd/, 'the archive section needs the workspace cwd')
  assert.match(body, /compose: \(line\) =>/, 'the archive section needs the composer filler')
  assert.match(body, /onNotice: report/, 'the archive section needs the panel notice reporter')
})

test('ReportDialog composes prompts for both scopes and never sends', () => {
  const dialog = topLevelFunctionSource('ReportDialog')
  assert.match(dialog, /source\.reportPrompt\(/, 'ReportDialog must call the report-prompt source method')
  assert.match(dialog, /report-prompt/, 'ReportDialog must document the read-only Host action')
  assert.match(dialog, /\.reportStatus\(/, 'ReportDialog must discover existing reports through report-status')
  assert.match(dialog, /reportDefaultRange\(\)/, 'the period range defaults to the recent days')
  assert.match(dialog, /reportArchivedInRange\(/, 'the period hit list is computed locally')
  assert.match(dialog, /type: 'date'/, 'the period mode needs date inputs')
  assert.equal((dialog.match(/type: 'date'/g) ?? []).length, 2, 'period mode needs a from and a to date input')
  assert.match(dialog, /reportScopeChange/, 'the scope tabs must be wired')
  assert.match(dialog, /reportScopeRange/)
  assert.match(dialog, /reportArchiveMode/, 'single-change mode offers the archive-folder toggle')
  assert.match(dialog, /reportWarningRangeOrder/, 'an inverted range must be blocked with a notice')
  assert.match(dialog, /reportWarningRangeEmpty/, 'an empty range must be blocked with a notice')
  assert.match(dialog, /reportWarningRangeMissing/, 'a cleared date input must be blocked with a notice')
  assert.match(dialog, /reportOutputRelPath\(/, 'the dialog previews the output path')
  assert.match(dialog, /saveReportSettings\(cwd/)
  assert.doesNotMatch(dialog, /\.send\(/, 'the report dialog must never send the prompt')
})

test('ReportPreviewDialog reads the HTML and renders it in a script-disabled sandbox', () => {
  const preview = topLevelFunctionSource('ReportPreviewDialog')
  assert.match(preview, /readDocument\(target, \{ offset: 1, limit: 4000 \}\)/, 'the preview reads through the document route')
  assert.match(preview, /sandbox: ''/, 'the iframe sandbox must be empty (scripts and same-origin disabled)')
  assert.match(preview, /srcDoc: state\.text/, 'the report HTML is injected as srcdoc')
  assert.match(preview, /dshspec-reportFrame/)
  assert.match(preview, /copyTextToClipboard\(/, 'the path stays copyable when rendering is unavailable')
})

test('composeFor prefers the public conversation draft API over the DOM editor', () => {
  const source = composeForSource()
  assert.match(source, /ctx\.get\('conversation'\)/, 'composeFor must feature-detect the conversation service')
  assert.match(source, /conversationInput\.shell\(sessionId\)/, 'composeFor must resolve the input shell for the session')
  assert.match(source, /shell\.setDraft\(line\)/, 'the multi-line prompt must use the public setDraft API')
  assert.match(source, /insertIntoComposer\(line\)/, 'the DOM editor must stay as the fallback')
  const draftIndex = source.indexOf('shell.setDraft(line)')
  const domIndex = source.indexOf('insertIntoComposer(line)')
  assert.ok(draftIndex !== -1 && domIndex !== -1 && draftIndex < domIndex, 'setDraft must be tried before the DOM fallback')
  // Both the existing-session and the created-session paths fill the resolved id.
  assert.match(source, /fill\(candidate\)/, 'existing sessions fill the resolved session draft')
  assert.match(source, /fill\(created\)/, 'created sessions fill the resolved session draft')
})

test('report settings use a dedicated localStorage key and tolerant helpers', () => {
  assert.match(clientSource, /const REPORT_SETTINGS_KEY = 'dsh-spec\.report\.v1'/)
  const load = topLevelFunctionSource('loadReportSettings')
  assert.match(load, /normalizeReportSettings\(/, 'stored settings are normalized defensively')
  assert.match(load, /reportSettingsCwdKey\(cwd\)/, 'settings are keyed per workspace')
  const save = topLevelFunctionSource('saveReportSettings')
  assert.match(save, /normalizeReportSettings\(/)
  assert.match(save, /reportSettingsCwdKey\(cwd\)/)
  assert.match(save, /localStorage\.setItem\(REPORT_SETTINGS_KEY/)
})

test('zh / en dictionaries define the same report keys', () => {
  const { zh, en } = dictionaryKeys()
  assert.equal(new Set(zh).size, zh.length, 'zh dictionary keys must be unique')
  assert.equal(new Set(en).size, en.length, 'en dictionary keys must be unique')
  assert.deepEqual(en.slice().sort(), zh.slice().sort(), 'zh/en dictionaries must expose the same keys')
  const required = [
    'reportEntry',
    'reportPeriodEntry',
    'reportDialogTitle',
    'reportDialogDesc',
    'reportScopeChange',
    'reportScopeRange',
    'reportRangeFrom',
    'reportRangeTo',
    'reportIncludedCount',
    'reportIncludedList',
    'reportRootLabel',
    'reportRootHint',
    'reportArchiveMode',
    'reportStatusMissing',
    'reportStatusGenerated',
    'reportGeneratedAt',
    'reportStatusLoading',
    'reportStatusFailed',
    'reportGenerate',
    'reportRegenerate',
    'reportPreview',
    'reportCopyPath',
    'reportPromptFilled',
    'reportPathCopied',
    'reportPreviewUnavailable',
    'reportWarningAbsolute',
    'reportWarningRangeOrder',
    'reportWarningRangeMissing',
    'reportWarningRangeEmpty',
  ]
  for (const key of required) {
    assert.ok(zh.includes(key), `zh dictionary must define ${key}`)
    assert.ok(en.includes(key), `en dictionary must define ${key}`)
  }
})
