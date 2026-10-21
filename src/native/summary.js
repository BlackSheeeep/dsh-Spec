/**
 * Proposal summary derivation for OpenSpec-native changes (Host half).
 *
 * The panel needs a human-readable answer to "what is this change about?"
 * without spending model tokens. This module reads the native `proposal.md`
 * sections (`## Why` and `## What Changes`) and derives:
 *
 * - `description`: one compact paragraph from `## Why` (the motivation);
 * - `highlights`: the bullet list from `## What Changes` (what will change).
 *
 * It is deliberately deterministic and markdown-only: no model call, no
 * translation, no network. Text is capped so the `/dsh-spec` state payload stays
 * bounded even for very long proposals. Missing sections degrade to an empty
 * summary (the panel can then fall back to the metadata goal or the change
 * name), never an error.
 *
 * @module dsh-spec/native/summary
 */

/** Default maximum characters kept from the `## Why` paragraph. */
const DEFAULT_DESCRIPTION_CHARS = 280

/** Default maximum number of `## What Changes` bullets. */
const DEFAULT_HIGHLIGHTS = 4

/** Default maximum characters kept from one `## What Changes` bullet. */
const DEFAULT_HIGHLIGHT_CHARS = 180

/** Default maximum characters for the one-line headline. */
const DEFAULT_HEADLINE_CHARS = 32

/** Headings that introduce the motivation paragraph. */
const WHY_HEADINGS = new Set(['why', 'motivation', 'background', 'rationale', '背景', '动机', '为什么'])

/** Headings that introduce the change list. */
const CHANGE_HEADINGS = new Set([
  'what changes',
  'what changed',
  'changes',
  'change summary',
  'summary of changes',
  '变更内容',
  '改动内容',
  '变更摘要',
])

/** A level-2 section heading (`## Why`). */
const H2_HEADING = /^##\s+(.+?)\s*$/

/** Any heading (sections stop at the next heading of any level). */
const ANY_HEADING = /^#{1,6}\s+/

/** A bullet or ordered-list item. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/

/** Fenced code block delimiter. */
const FENCE = /^\s*(?:```|~~~)/

/** Normalize a document into lines without BOM/CRLF noise. */
function normalizeLines(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
}

/** Collapse whitespace runs into single spaces and trim. */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Strip the most common inline markdown so the panel shows prose, not syntax.
 * Keeps the visible link text, drops images and formatting markers.
 *
 * @param {string} value raw markdown text
 * @returns {string} plain text
 */
function stripMarkdown(value) {
  return collapse(
    String(value ?? '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/<[^>]+>/g, ''),
  )
}

/**
 * Cap text at a character budget without splitting surrogate pairs.
 *
 * @param {string} value text
 * @param {number} maxChars positive budget
 * @returns {string} capped text (with `…` when truncated)
 */
function cap(value, maxChars) {
  const text = collapse(value)
  if (text.length <= maxChars) return text
  let output = ''
  let used = 0
  for (const character of text) {
    if (used >= Math.max(1, maxChars - 1)) break
    output += character
    used += character.length
  }
  return `${output.trimEnd()}…`
}

/**
 * Extract level-2 sections: heading text (lower-cased) → body lines.
 *
 * @param {string[]} lines normalized document lines
 * @returns {Map<string, string[]>}
 */
function sectionMap(lines) {
  /** @type {Map<string, string[]>} */
  const sections = new Map()
  let current
  let inFence = false
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence
      if (current !== undefined) current.push(line)
      continue
    }
    if (!inFence) {
      const heading = H2_HEADING.exec(line)
      if (heading !== null) {
        current = []
        sections.set(heading[1].trim().toLowerCase(), current)
        continue
      }
      if (ANY_HEADING.test(line)) {
        current = undefined
        continue
      }
    }
    if (current !== undefined) current.push(line)
  }
  return sections
}

/**
 * First non-empty prose paragraph in a body (bullets/headings/fences skipped).
 *
 * @param {string[]|undefined} body section lines
 * @returns {string} plain paragraph text
 */
function firstParagraph(body) {
  const lines = Array.isArray(body) ? body : []
  /** @type {string[]} */
  const paragraph = []
  let inFence = false
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence
      if (paragraph.length > 0) break
      continue
    }
    if (inFence) continue
    const trimmed = line.trim()
    if (trimmed === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (ANY_HEADING.test(trimmed) || LIST_ITEM.test(trimmed) || /^>\s?/.test(trimmed)) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(trimmed)
  }
  return stripMarkdown(paragraph.join(' '))
}

/**
 * Bullet/ordered-list entries in a section body, in source order.
 *
 * @param {string[]|undefined} body section lines
 * @returns {string[]} plain entries
 */
function listItems(body) {
  const lines = Array.isArray(body) ? body : []
  /** @type {string[]} */
  const items = []
  let inFence = false
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = LIST_ITEM.exec(line)
    if (match === null) continue
    const text = stripMarkdown(match[1])
    if (text !== '') items.push(text)
  }
  return items
}

/**
 * Pick the first matching section body from a preferred heading set.
 *
 * @param {Map<string, string[]>} sections section map
 * @param {Set<string>} names preferred lower-case headings
 * @returns {string[]|undefined}
 */
function sectionBody(sections, names) {
  for (const name of names) {
    const body = sections.get(name)
    if (body !== undefined) return body
  }
  return undefined
}

/**
 * Build the panel's one-line headline: the first clause of the best available
 * description, normalized just enough to read as a change title.
 *
 * This is deliberately not the `## Why` paragraph. A panel headline should be a
 * phrase such as `新增幼狮卡牌`, not an excerpt of the motivation text.
 *
 * @param {string} value candidate text
 * @param {number} maxChars character cap
 * @returns {string}
 */
function headlineOf(value, maxChars) {
  let text = stripMarkdown(value)
  if (text === '') return ''
  // "添加一张 X" / "增加一个 X" read better as a concise "新增 X" headline.
  text = text
    .replace(/^(?:添加|增加|加入|新增)\s*(?:一[张个套份组批])?\s*/u, '新增')
    .replace(/^新增(?=[A-Za-z0-9])/u, '新增 ')
  const cut = text.search(/[。！？!?；;：:，,]|\.(?=\s)/u)
  if (cut > 0) text = text.slice(0, cut)
  text = text.replace(/[。！？!?；;：:，,.、\s]+$/u, '').trim()
  return cap(text, maxChars)
}

/**
 * First sentence of a prose paragraph (for headline fallback only).
 * @param {string} text prose
 * @returns {string}
 */
function firstSentence(text) {
  const value = collapse(text)
  if (value === '') return ''
  const match = /^.+?[。！？!?](?:\s|$)/u.exec(value)
  return match === null ? value : match[0].replace(/[。！？!?]+$/u, '').trim()
}

/**
 * Derive the panel's change summary from `proposal.md`.
 *
 * @param {string|null|undefined} text proposal markdown
 * @param {{goal?: string|null, maxDescriptionChars?: number, maxHighlights?: number, maxHighlightChars?: number, maxHeadlineChars?: number}} [options]
 * @returns {{headline: string, description: string, highlights: string[], source: 'proposal'|'metadata'|'none'}}
 */
export function summarizeProposal(text, options = {}) {
  const maxDescriptionChars =
    Number.isFinite(options.maxDescriptionChars) && options.maxDescriptionChars > 0
      ? Math.floor(options.maxDescriptionChars)
      : DEFAULT_DESCRIPTION_CHARS
  const maxHighlights =
    Number.isFinite(options.maxHighlights) && options.maxHighlights > 0
      ? Math.floor(options.maxHighlights)
      : DEFAULT_HIGHLIGHTS
  const maxHighlightChars =
    Number.isFinite(options.maxHighlightChars) && options.maxHighlightChars > 0
      ? Math.floor(options.maxHighlightChars)
      : DEFAULT_HIGHLIGHT_CHARS
  const maxHeadlineChars =
    Number.isFinite(options.maxHeadlineChars) && options.maxHeadlineChars > 0
      ? Math.floor(options.maxHeadlineChars)
      : DEFAULT_HEADLINE_CHARS

  const lines = normalizeLines(text)
  const sections = sectionMap(lines)
  let description = firstParagraph(sectionBody(sections, WHY_HEADINGS))
  if (description === '') {
    // No `## Why`: use the first prose paragraph anywhere after the title.
    description = firstParagraph(lines.slice(1))
  }
  const changeItems = listItems(sectionBody(sections, CHANGE_HEADINGS))
  const highlights = changeItems.slice(0, maxHighlights).map((item) => cap(item, maxHighlightChars))
  const goal = collapse(options.goal ?? '')

  // Headline precedence: explicit metadata goal (the AI/user-authored one-line
  // summary), then the first `## What Changes` bullet, then the first Why
  // sentence. Never the whole Why paragraph.
  const headline =
    headlineOf(goal, maxHeadlineChars) ||
    headlineOf(changeItems[0] ?? '', maxHeadlineChars) ||
    headlineOf(firstSentence(description), maxHeadlineChars)

  if (description === '') {
    if (goal !== '') {
      return { headline, description: cap(goal, maxDescriptionChars), highlights, source: 'metadata' }
    }
    return { headline, description: '', highlights, source: 'none' }
  }
  return { headline, description: cap(description, maxDescriptionChars), highlights, source: 'proposal' }
}
