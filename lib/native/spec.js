/**
 * Spec document parsing for OpenSpec-native changes (Host half).
 *
 * Main specs (`openspec/specs/<capability>/spec.md`) and delta specs
 * (`openspec/changes/<change>/specs/<capability>/spec.md`) are parsed with the
 * native recognition rules:
 *
 * - requirements only at `^### Requirement: (.+)`
 * - scenarios only at `^#### Scenario: (.+)`
 * - delta sections only at `^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements$` (case-sensitive)
 *
 * Issue codes follow the module contract: wrong-level scenario heading →
 * WARNING, requirement outside a delta section → WARNING, REMOVED without
 * `**Reason**` → WARNING, RENAMED missing FROM/TO → ERROR.
 *
 * @module dsh-spec/native/spec
 */

const REQUIREMENT_HEADING = /^### Requirement: (.+)$/
const SCENARIO_HEADING = /^#### Scenario: (.+)$/
const ANY_SCENARIO_HEADING = /^(#{2,6})\s+Scenario:\s*(.*)$/
const DELTA_SECTION = /^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$/
const H2_OR_ABOVE = /^#{1,2}\s+/
const BLOCK_BOUNDARY = /^#{1,3}\s+/
const RENAME_FROM = /^-\s+FROM:\s*(.*)$/
const RENAME_TO = /^-\s+TO:\s*(.*)$/

/**
 * Split a document into normalized lines.
 *
 * @param {string} text
 * @returns {string[]}
 */
function normalizeLines(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
}

/**
 * Trim trailing blank lines/spaces from a list of raw lines.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function joinBlock(lines) {
  const copy = [...lines]
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop()
  return copy.join('\n').replace(/[ \t]+$/, '')
}

/**
 * Scan requirement blocks within `[from, to)`.
 *
 * @param {string[]} lines normalized document lines
 * @param {number} from inclusive start index
 * @param {number} to exclusive end index
 * @returns {{blocks: Array<{name: string, raw: string, text: string, scenarios: Array<{name: string, raw: string}>, line: number, scenariosCount: number}>, issues: Array<{level: 'ERROR'|'WARNING'|'INFO', line?: number, message: string}>}}
 */
function scanBlocks(lines, from, to) {
  /** @type {Array<any>} */
  const blocks = []
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', line?: number, message: string}>} */
  const issues = []

  // Any "Scenario:" heading that is not exactly four levels is a format problem.
  for (let cursor = from; cursor < to; cursor += 1) {
    const wrongLevel = ANY_SCENARIO_HEADING.exec(lines[cursor])
    if (wrongLevel === null || wrongLevel[1].length === 4) continue
    issues.push({
      level: 'WARNING',
      line: cursor + 1,
      message: `scenario headings must use "#### Scenario:" (found ${wrongLevel[1].length} "#")`,
    })
  }

  for (let index = from; index < to; index += 1) {
    const heading = REQUIREMENT_HEADING.exec(lines[index])
    if (heading === null) continue
    let end = to
    for (let cursor = index + 1; cursor < to; cursor += 1) {
      if (BLOCK_BOUNDARY.test(lines[cursor])) {
        end = cursor
        break
      }
    }

    /** @type {Array<{name: string, raw: string, line: number}>} */
    const scenarios = []
    let firstScenario = -1
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const line = lines[cursor]
      const scenario = SCENARIO_HEADING.exec(line)
      if (scenario === null) continue
      if (firstScenario === -1) firstScenario = cursor
      scenarios.push({ name: scenario[1].trim(), raw: '', line: cursor + 1 })
    }

    for (let cursor = 0; cursor < scenarios.length; cursor += 1) {
      const start = scenarios[cursor].line - 1
      const next = cursor + 1 < scenarios.length ? scenarios[cursor + 1].line - 1 : end
      scenarios[cursor].raw = joinBlock(lines.slice(start, next))
    }

    const bodyEnd = firstScenario === -1 ? end : firstScenario
    blocks.push({
      name: heading[1].trim(),
      raw: joinBlock(lines.slice(index, end)),
      text: lines
        .slice(index + 1, bodyEnd)
        .join('\n')
        .trim(),
      scenarios: scenarios.map((scenario) => ({ name: scenario.name, raw: scenario.raw })),
      line: index + 1,
      scenariosCount: scenarios.length,
    })
  }

  return { blocks, issues }
}

/**
 * Parse every `### Requirement:` block of a text.
 *
 * Returns a plain array of requirement blocks (so `Array.isArray` and iteration
 * work) with the raised issues attached as a non-enumerable `issues` property.
 *
 * @param {string} text markdown text
 * @returns {Array<{name: string, raw: string, text: string, scenarios: Array<{name: string, raw: string}>}> & {issues: Array<{level: 'ERROR'|'WARNING'|'INFO', line?: number, message: string}>}}
 */
export function parseRequirementBlocks(text) {
  const lines = normalizeLines(text)
  const { blocks, issues } = scanBlocks(lines, 0, lines.length)
  const result = blocks.map(({ name, raw, text: body, scenarios }) => ({ name, raw, text: body, scenarios }))
  Object.defineProperty(result, 'issues', { value: issues, enumerable: false })
  return /** @type {any} */ (result)
}

/**
 * Parse a main capability spec.
 *
 * @param {string} text markdown text of `openspec/specs/<capability>/spec.md`
 * @returns {{title: string|null, purpose: string|null, requirements: Array<{name: string, raw: string, text: string, scenarios: Array<{name: string, raw: string}>}>, issues: Array<{level: 'ERROR'|'WARNING'|'INFO', line?: number, message: string}>}}
 */
export function parseMainSpec(text) {
  const lines = normalizeLines(text)
  let title = null
  let purpose = null
  let purposeLine
  for (let index = 0; index < lines.length; index += 1) {
    const titleMatch = /^#\s+(.+)$/.exec(lines[index])
    if (titleMatch !== null && title === null) title = titleMatch[1].trim()
    if (/^##\s+Purpose\s*$/.test(lines[index])) {
      purposeLine = index + 1
      const body = []
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (H2_OR_ABOVE.test(lines[cursor])) break
        body.push(lines[cursor])
      }
      purpose = body.join('\n').trim()
      break
    }
  }

  const { blocks, issues } = scanBlocks(lines, 0, lines.length)
  if (purposeLine === undefined) {
    // Missing-section errors are raised by validate.js; nothing to add here.
  }
  return {
    title,
    purpose,
    requirements: blocks.map(({ name, raw, text: body, scenarios }) => ({ name, raw, text: body, scenarios })),
    issues,
  }
}

/**
 * Clean a RENAMED `FROM:` / `TO:` target into a requirement name.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function cleanRenameTarget(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return null
  if (text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1).trim()
  const heading = /^###\s+Requirement:\s*(.+)$/.exec(text)
  if (heading !== null) text = heading[1].trim()
  text = text.replace(/`/g, '').trim()
  return text === '' ? null : text
}

/**
 * Parse a delta spec into its four native operations.
 *
 * @param {string} text markdown text of a change delta spec
 * @returns {{operations: {ADDED: Array<object>, MODIFIED: Array<object>, REMOVED: Array<object>, RENAMED: Array<{from: string|null, to: string|null, raw: string}>}, issues: Array<{level: 'ERROR'|'WARNING'|'INFO', line?: number, message: string}>}}
 */
export function parseDeltaSpec(text) {
  const lines = normalizeLines(text)
  /** @type {{ADDED: Array<object>, MODIFIED: Array<object>, REMOVED: Array<object>, RENAMED: Array<{from: string|null, to: string|null, raw: string}>}} */
  const operations = { ADDED: [], MODIFIED: [], REMOVED: [], RENAMED: [] }
  /** @type {Array<{level: 'ERROR'|'WARNING'|'INFO', line?: number, message: string}>} */
  const issues = []
  /** @type {Array<{start: number, end: number, name: string}>} */
  const sections = []

  for (let index = 0; index < lines.length; index += 1) {
    const section = DELTA_SECTION.exec(lines[index])
    if (section === null) continue
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (H2_OR_ABOVE.test(lines[cursor])) {
        end = cursor
        break
      }
    }
    sections.push({ start: index, end, name: section[1] })
    if (section[1] !== 'RENAMED') {
      const scanned = scanBlocks(lines, index + 1, end)
      issues.push(...scanned.issues)
      operations[section[1]].push(
        ...scanned.blocks.map(({ name, raw, text: body, scenarios }) => ({ name, raw, text: body, scenarios })),
      )
      if (section[1] === 'REMOVED') {
        for (const requirement of scanned.blocks) {
          if (!/\*\*Reason\*\*/.test(requirement.raw)) {
            issues.push({
              level: 'WARNING',
              line: requirement.line,
              message: `REMOVED requirement "${requirement.name}" must include a "**Reason**" line`,
            })
          }
        }
      }
    } else {
      // RENAMED: `- FROM: ...` / `- TO: ...` pairs, not requirement blocks.
      for (let cursor = index + 1; cursor < end; cursor += 1) {
        if (REQUIREMENT_HEADING.test(lines[cursor])) {
          issues.push({
            level: 'WARNING',
            line: cursor + 1,
            message: 'RENAMED entries must use "- FROM:" / "- TO:" lines, not requirement blocks',
          })
        }
      }
      let pending = null
      for (let cursor = index + 1; cursor < end; cursor += 1) {
        const line = lines[cursor]
        const fromMatch = RENAME_FROM.exec(line)
        const toMatch = RENAME_TO.exec(line)
        if (fromMatch !== null) {
          if (pending !== null) {
            issues.push({
              level: 'ERROR',
              line: pending.line,
              message: 'RENAMED entry is missing its "- TO:" line',
            })
            operations.RENAMED.push({ from: pending.from, to: null, raw: pending.raw })
          }
          pending = { from: cleanRenameTarget(fromMatch[1]), to: null, raw: line, line: cursor + 1, hasTo: false }
          continue
        }
        if (toMatch !== null) {
          if (pending === null) {
            issues.push({
              level: 'ERROR',
              line: cursor + 1,
              message: 'RENAMED entry is missing its "- FROM:" line',
            })
            operations.RENAMED.push({ from: null, to: cleanRenameTarget(toMatch[1]), raw: line })
            continue
          }
          pending.to = cleanRenameTarget(toMatch[1])
          pending.hasTo = true
          operations.RENAMED.push({ from: pending.from, to: pending.to, raw: `${pending.raw}\n${line}` })
          pending = null
        }
      }
      if (pending !== null) {
        issues.push({
          level: 'ERROR',
          line: pending.line,
          message: 'RENAMED entry is missing its "- TO:" line',
        })
        operations.RENAMED.push({ from: pending.from, to: null, raw: pending.raw })
      }
    }
  }

  if (sections.length === 0) {
    const { blocks, issues: blockIssues } = scanBlocks(lines, 0, lines.length)
    issues.push(...blockIssues)
    for (const requirement of blocks) {
      issues.push({
        level: 'WARNING',
        line: requirement.line,
        message: `requirement "${requirement.name}" appears outside a delta section ("## ADDED|MODIFIED|REMOVED|RENAMED Requirements")`,
      })
    }
    return { operations, issues }
  }

  // Requirements between delta sections are stray content.
  let cursor = 0
  for (const section of sections) {
    if (cursor < section.start) {
      const { blocks, issues: blockIssues } = scanBlocks(lines, cursor, section.start)
      issues.push(...blockIssues)
      for (const requirement of blocks) {
        issues.push({
          level: 'WARNING',
          line: requirement.line,
          message: `requirement "${requirement.name}" appears outside a delta section ("## ADDED|MODIFIED|REMOVED|RENAMED Requirements")`,
        })
      }
    }
    cursor = section.end
  }
  if (cursor < lines.length) {
    const { blocks, issues: blockIssues } = scanBlocks(lines, cursor, lines.length)
    issues.push(...blockIssues)
    for (const requirement of blocks) {
      issues.push({
        level: 'WARNING',
        line: requirement.line,
        message: `requirement "${requirement.name}" appears outside a delta section ("## ADDED|MODIFIED|REMOVED|RENAMED Requirements")`,
      })
    }
  }

  return { operations, issues }
}

/**
 * Count `#### Scenario:` blocks in a raw requirement block.
 *
 * @param {string} requirementRaw raw requirement text including the heading line
 * @returns {number}
 */
export function countScenarios(requirementRaw) {
  let count = 0
  for (const line of normalizeLines(requirementRaw)) {
    if (/^#### Scenario: /.test(line)) count += 1
  }
  return count
}
