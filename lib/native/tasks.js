/**
 * Native tasks.md parsing (Host half).
 *
 * Native parity rules:
 * - bullets may be `-`, `*` or `+`
 * - only `x` / `X` (optionally spaced: `[ x]`, `[x ]`) counts as done
 * - any other bracket marker (`[~]`, `[-]`, `[]`) is an unfinished task
 * - an empty task text still counts as a task
 * - a link bullet (`- [text](url)`) is not a task
 * - the leading `N.M` token is preserved as the task id
 * - nesting depth comes from leading two-space indentation (max 3)
 *
 * @module dsh-spec/native/tasks
 */

/** Checkbox task line: bullet, marker and optional trailing text. */
const TASK_LINE = /^([ \t]*)([-*+])\s+\[([^\]]*)\](?:\s+(.*?))?\s*$/

/** Link bullet: `- [text](url)` is a markdown link, never a task. */
const LINK_BULLET = /^[ \t]*[-*+]\s+\[[^\]]*\]\([^)]*\)/

/** Leading task id, e.g. `1.2` or `12.`. */
const TASK_ID = /^(\d+(?:\.\d+)*)/

/**
 * Parse a `tasks.md` document.
 *
 * @param {string} text markdown text
 * @returns {{total: number, done: number, items: Array<{id: string|null, text: string, done: boolean, depth: number}>, issues: Array<{level: 'WARNING', line: number, message: string}>}}
 */
export function parseTasks(text) {
  /** @type {Array<{id: string|null, text: string, done: boolean, depth: number}>} */
  const items = []
  /** @type {Array<{level: 'WARNING', line: number, message: string}>} */
  const issues = []
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (LINK_BULLET.test(line)) continue
    const match = TASK_LINE.exec(line)
    if (match === null) continue

    const indentText = match[1]
    const marker = match[3]
    const body = (match[4] ?? '').trim()

    const normalized = marker.replace(/\s+/g, '')
    const done = normalized === 'x' || normalized === 'X'
    if (!done) {
      if (marker !== ' ') {
        issues.push({
          level: 'WARNING',
          line: index + 1,
          message: `unusual task marker "[${marker}]"; only "[ ]" and "[x]" are native (counting it as unfinished)`,
        })
      }
    }

    const expandedIndent = indentText.replace(/\t/g, '  ').length
    const depth = Math.min(3, Math.floor(expandedIndent / 2))
    const idMatch = TASK_ID.exec(body)
    items.push({
      id: idMatch === null ? null : idMatch[1],
      text: body,
      done,
      depth,
    })
  }

  return {
    total: items.length,
    done: items.filter((item) => item.done).length,
    items,
    issues,
  }
}
