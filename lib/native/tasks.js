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
 * - a task body carrying `[人工验收]` / `【人工验收】` is flagged as manual
 *   acceptance work; the panel renders it as a checkbox the user can tick
 *   after verifying the result by hand
 *
 * @module dsh-spec/native/tasks
 */

/** Checkbox task line: bullet, marker and optional trailing text. */
const TASK_LINE = /^([ \t]*)([-*+])\s+\[([^\]]*)\](?:\s+(.*?))?\s*$/

/** Link bullet: `- [text](url)` is a markdown link, never a task. */
const LINK_BULLET = /^[ \t]*[-*+]\s+\[[^\]]*\]\([^)]*\)/

/** Leading task id, e.g. `1.2` or `12.`. */
const TASK_ID = /^(\d+(?:\.\d+)*)/

/** Manual-acceptance marker (half-width or full-width brackets). */
const MANUAL_MARKER = /(?:\[|【)\s*人工验收\s*(?:\]|】)/

/**
 * Whether a task body is marked for manual acceptance.
 * @param {string} text task body
 * @returns {boolean}
 */
export function isManualTask(text) {
  return MANUAL_MARKER.test(String(text ?? ''))
}

/**
 * Parse a `tasks.md` document.
 *
 * @param {string} text markdown text
 * @returns {{total: number, done: number, items: Array<{id: string|null, text: string, done: boolean, depth: number, line: number, manual: boolean}>, issues: Array<{level: 'WARNING', line: number, message: string}>}}
 */
export function parseTasks(text) {
  /** @type {Array<{id: string|null, text: string, done: boolean, depth: number, line: number, manual: boolean}>} */
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
      line: index + 1,
      manual: isManualTask(body),
    })
  }

  return {
    total: items.length,
    done: items.filter((item) => item.done).length,
    items,
    issues,
  }
}

/**
 * Toggle exactly one native task checkbox on a 1-based source line.
 *
 * The write path is intentionally strict: the requested line must still be a
 * native task line (not a link bullet), so a stale panel snapshot can never
 * rewrite unrelated prose. Everything outside the checkbox marker is preserved
 * byte-for-byte, including the bullet, indentation, task id and trailing text.
 *
 * @param {string} text current `tasks.md` content
 * @param {number} lineNumber 1-based line number from `ChangeState.tasks.items[].line`
 * @param {boolean} done `true` writes `[x]`, `false` writes `[ ]`
 * @returns {{text: string, line: number, done: boolean, manual: boolean, task: object}}
 * @throws {Error} when the line is out of range or is no longer a task
 */
export function toggleTaskLine(text, lineNumber, done) {
  const line = Number(lineNumber)
  if (!Number.isInteger(line) || line < 1) throw new Error('任务行号无效')
  const original = String(text ?? '')
  const hadBom = original.startsWith('\uFEFF')
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const normalized = original.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (line > lines.length) throw new Error(`任务行号 ${line} 超出 tasks.md 范围（共 ${lines.length} 行）`)
  const raw = lines[line - 1]
  if (LINK_BULLET.test(raw)) throw new Error(`第 ${line} 行是链接，不是任务复选框`)
  const match = TASK_LINE.exec(raw)
  if (match === null) throw new Error(`第 ${line} 行不是任务复选框，任务清单可能已被修改，请刷新后重试`)
  const nextMarker = done === true ? '[x]' : '[ ]'
  // Replace the first bracket group only: the checkbox marker. Indentation,
  // bullet style, id, link-free text and trailing spaces stay untouched.
  const updated = raw.replace(/\[[^\]]*\]/, nextMarker)
  if (updated === raw) {
    return {
      text: String(text ?? ''),
      line,
      done: match[3].replace(/\s+/g, '').toLowerCase() === 'x',
      manual: isManualTask(match[4] ?? ''),
      task: { id: TASK_ID.exec((match[4] ?? '').trim())?.[1] ?? null, text: (match[4] ?? '').trim(), line },
    }
  }
  lines[line - 1] = updated
  return {
    text: `${hadBom ? '\uFEFF' : ''}${lines.join(newline)}`,
    line,
    done: done === true,
    manual: isManualTask(match[4] ?? ''),
    task: { id: TASK_ID.exec((match[4] ?? '').trim())?.[1] ?? null, text: (match[4] ?? '').trim(), line },
  }
}
