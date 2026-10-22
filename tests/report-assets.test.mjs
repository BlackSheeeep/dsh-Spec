/**
 * Asset guards for the human-readable report feature.
 *
 * The report prompt embeds `src/report/report-methodology.md` verbatim and tells
 * the model to write standalone HTML following `src/report/report-template.html`,
 * so both assets are contractual: the template must stay self-contained (it is
 * also rendered in a script-disabled sandbox iframe), cover both the single-change
 * and period scopes, and the build must mirror `src/report/` into `lib/report/`.
 *
 * Run: node --test --test-isolation=none tests/report-assets.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const TEMPLATE_REL = 'src/report/report-template.html'
const METHODOLOGY_REL = 'src/report/report-methodology.md'
const BUILD_REL = 'tools/build.mjs'
const DIST_TEMPLATE_REL = 'lib/report/report-template.html'

const templatePath = path.join(root, TEMPLATE_REL)
const methodologyPath = path.join(root, METHODOLOGY_REL)

/** Read a repo asset, failing with a readable message when it is missing. */
function readAsset(relative) {
  const file = path.join(root, relative)
  assert.ok(existsSync(file), `${relative} should exist`)
  return readFileSync(file, 'utf8')
}

test('the report template exists and stays lightweight', () => {
  assert.ok(existsSync(templatePath), `${TEMPLATE_REL} should exist`)
  const size = statSync(templatePath).size
  assert.ok(size > 0, 'the report template should not be empty')
  assert.ok(size < 200_000, `${TEMPLATE_REL} should stay under 200 KB (was ${size} bytes)`)
})

test('the template covers both the single-change and period scopes', () => {
  const template = readAsset(TEMPLATE_REL)
  const required = [
    '<details',
    '一页速览',
    '主线定位',
    '回归主线',
    '前后差异',
    '归档信息',
    'SINGLE ONLY',
    'RANGE ONLY',
  ]
  for (const marker of required) {
    assert.ok(template.includes(marker), `the report template should contain ${JSON.stringify(marker)}`)
  }
  // The period shape is a change list plus per-change folded blocks, not a pile
  // of concatenated single-change reports.
  assert.match(template, /本期变更清单/, 'the period layout should name the change list section')
  assert.match(template, /逐 change/, 'the period layout should fold each change separately')
})

test('the template is self-contained: no scripts, external styles, images or network references', () => {
  const template = readAsset(TEMPLATE_REL)
  for (const forbidden of ['<script', '<link', '<img', '@import', 'http://', 'https://']) {
    assert.equal(
      template.includes(forbidden),
      false,
      `the report template must not contain ${JSON.stringify(forbidden)} — reports are opened from disk and previewed in a script-disabled sandbox`,
    )
  }
})

test('the template folds details by default, is responsive and printable', () => {
  const template = readAsset(TEMPLATE_REL)
  // Fill-in instructions inside HTML comments may mention the tag by name; count
  // only the markup that actually renders.
  const markup = template.replace(/<!--[\s\S]*?-->/g, '')
  const opens = [...markup.matchAll(/<details[\s>]/g)].length
  const closes = [...markup.matchAll(/<\/details>/g)].length
  assert.ok(opens >= 4, 'the template should provide several folded detail blocks')
  assert.equal(opens, closes, 'every <details> block should be closed')
  assert.equal(/<details\s[^>]*\bopen\b/.test(markup), false, 'detail blocks should be collapsed by default')
  assert.match(template, /@media\s*\(max-width:\s*900px\)/, 'the template should collapse to one column on narrow screens')
  assert.match(template, /@media\s+print/, 'the template should define print styles')
  assert.match(template, /\.no-print/, 'the template should hide non-print elements when printing')
})

test('the methodology states the mainline, disclosure and evidence rules', () => {
  const methodology = readAsset(METHODOLOGY_REL)
  assert.match(methodology, /^#\s+报告方法论/m, 'the methodology should start with its own title heading')
  const headings = [
    '## 主线锚定三步',
    '## 渐进披露',
    '## 时间段汇总报告',
    '## 子 agent 编排',
    '## 反模式',
    '## 证据分级',
    '## 命名与归档口径',
  ]
  for (const heading of headings) {
    assert.ok(methodology.includes(heading), `the methodology should contain the section ${JSON.stringify(heading)}`)
  }
  const required = [
    '核心主线',
    '支线',
    '回归主线',
    '渐进披露',
    '子 agent',
    '原文',
    '推断',
    '未验证',
    '反模式',
  ]
  for (const marker of required) {
    assert.ok(methodology.includes(marker), `the methodology should contain ${JSON.stringify(marker)}`)
  }
  // The period report must be synthesized from fact cards, not concatenated.
  assert.match(methodology, /禁止把多份单变更报告拼接|不要把 N 份报告拼接/, 'the methodology should forbid concatenating reports')
  // Old text is unavailable after archiving, so before/after must stay honest.
  assert.match(methodology, /旧文本未留存/, 'the methodology should document the missing before-text caveat')
})

test('the build mirrors the report assets into lib/report', () => {
  const build = readAsset(BUILD_REL)
  assert.ok(
    build.includes("copyTree('src/report', 'lib/report')"),
    'tools/build.mjs should copy src/report/ to lib/report/',
  )
  assert.ok(build.includes('lib/report/'), 'the build log should mention lib/report/')
})

test(
  'the built report assets are byte-identical to the source when lib/report exists',
  { skip: existsSync(path.join(root, DIST_TEMPLATE_REL)) ? false : 'lib/report/ has not been built yet' },
  () => {
    const source = readFileSync(templatePath)
    const distPath = path.join(root, DIST_TEMPLATE_REL)
    const dist = readFileSync(distPath)
    assert.ok(source.equals(dist), `${DIST_TEMPLATE_REL} should be a byte-identical copy of ${TEMPLATE_REL}`)
  },
)
