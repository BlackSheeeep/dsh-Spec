/**
 * Tests for src/native/summary.js — panel change descriptions from proposal.md.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeProposal } from '../src/native/summary.js'

test('extracts Why as the description and What Changes bullets as highlights', () => {
  const text = [
    '# Proposal',
    '',
    '## Why',
    '',
    '当前面板只显示变更名，用户需要打开 proposal.md 才知道这个变更要做什么。',
    '',
    '## What Changes',
    '',
    '- 在变更卡片上显示中文变更说明。',
    '- 展示 `## What Changes` 的要点列表。',
    '- 缺失 proposal.md 时给出明确空状态。',
    '',
    '## Capabilities',
    '',
    '- ignored',
  ].join('\n')
  const summary = summarizeProposal(text)
  assert.equal(summary.source, 'proposal')
  assert.equal(summary.headline, '在变更卡片上显示中文变更说明')
  assert.equal(summary.description, '当前面板只显示变更名，用户需要打开 proposal.md 才知道这个变更要做什么。')
  assert.deepEqual(summary.highlights, [
    '在变更卡片上显示中文变更说明。',
    '展示 ## What Changes 的要点列表。',
    '缺失 proposal.md 时给出明确空状态。',
  ])
})

test('strips inline markdown and truncates long prose', () => {
  const text = [
    '## Why',
    '',
    '**Bold** [link](https://example.com) and `code` should read as plain text.',
    '',
    '## What Changes',
    '',
    '1. First numbered item',
    '2. Second numbered item',
    '3. Third',
    '4. Fourth',
    '5. Fifth is dropped by the cap',
  ].join('\n')
  const summary = summarizeProposal(text, { maxHighlights: 4, maxHighlightChars: 12 })
  assert.equal(summary.headline, 'First numbered item')
  assert.equal(summary.description, 'Bold link and code should read as plain text.')
  assert.equal(summary.highlights.length, 4)
  assert.equal(summary.highlights[0], 'First numbe…')
})

test('falls back to metadata goal, then to an empty summary', () => {
  const goal = summarizeProposal('# Proposal\n\n## Why\n\n', { goal: '让面板更清楚' })
  assert.deepEqual(goal, { headline: '让面板更清楚', description: '让面板更清楚', highlights: [], source: 'metadata' })
  const empty = summarizeProposal('', {})
  assert.deepEqual(empty, { headline: '', description: '', highlights: [], source: 'none' })
})

test('does not confuse a heading with the first prose paragraph', () => {
  const summary = summarizeProposal(['# Proposal', '', '## Impact', '', 'Only impact is documented.'].join('\n'))
  assert.equal(summary.headline, 'Only impact is documented')
  assert.equal(summary.description, 'Only impact is documented.')
  assert.deepEqual(summary.highlights, [])
})

test('headline is a short phrase, not the Why paragraph', () => {
  const text = [
    '# Proposal',
    '',
    '## Why',
    '',
    '当前实现把大量细节堆在会话里，用户很难快速看出这个变更到底在做什么。',
    '',
    '## What Changes',
    '',
    '- 添加一张幼狮卡牌：包含属性、费用和出场动画。',
    '- 更新卡牌列表和抽卡池。',
  ].join('\n')
  const summary = summarizeProposal(text)
  assert.equal(summary.headline, '新增幼狮卡牌')
  assert.match(summary.description, /当前实现把大量细节/)
})
