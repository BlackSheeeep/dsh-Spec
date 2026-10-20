/**
 * Minimal YAML subset parser for OpenSpec files (Host half).
 *
 * The plugin ships no YAML dependency, so this module implements the subset the
 * native files actually use: comments, `key: value` scalars (plain, single- or
 * double-quoted), block scalars (`|` and `>` with chomping/indent indicators),
 * indented sequences and mappings, single-line flow collections (`[a, b]`,
 * `{a: b}`), booleans/null/numbers and empty values.
 *
 * Unsupported YAML features (anchors, aliases, merge keys, tags, multi-line flow
 * collections) are reported as an `error` with a 1-based line number instead of
 * being silently misparsed. Parse failures never throw: callers can degrade.
 *
 * @module dsh-spec/native/yaml
 */

/** Block scalar header, e.g. `|`, `>-`, `|2`. */
const BLOCK_INDICATOR = /^[|>][-+]?[0-9]*$/

/** Internal syntax error carrying a 1-based line number. */
class YamlSyntaxError extends Error {
  /** @param {string} message @param {number} line */
  constructor(message, line) {
    super(message)
    this.name = 'YamlSyntaxError'
    this.line = line
  }
}

/** Count leading space characters. @param {string} text @returns {number} */
function leadingSpaces(text) {
  let index = 0
  while (index < text.length && text[index] === ' ') index += 1
  return index
}

/** Whether a line starts a block sequence entry (`-` or `- item`). @param {string} text @returns {boolean} */
function isSequenceText(text) {
  return /^-(\s|$)/.test(text)
}

/** Remove a trailing `#` comment that is outside quotes. @param {string} text @returns {string} */
function stripInlineComment(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote === '"') {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          index += 1
          continue
        }
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index)
    }
  }
  return text
}

/**
 * Find the `:` that separates a mapping key from its value (outside quotes).
 * A colon counts only when followed by whitespace or end of line.
 *
 * @param {string} text
 * @returns {number} index of the colon, or -1
 */
function findKeyColon(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote === '"') {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          index += 1
          continue
        }
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':') {
      const next = text[index + 1]
      if (next === undefined || next === ' ' || next === '\t') return index
    }
  }
  return -1
}

/**
 * Read a quoted string from the beginning of `text`.
 *
 * @param {string} text text starting with `"` or `'`
 * @param {number} line 1-based line number for errors
 * @returns {{value: string, rest: string}}
 */
function readQuoted(text, line) {
  const quote = text[0]
  let value = ''
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          value += "'"
          index += 1
          continue
        }
        return { value, rest: text.slice(index + 1) }
      }
      value += char
      continue
    }
    if (char === '\\') {
      const escaped = text[index + 1]
      if (escaped === undefined) break
      index += 1
      switch (escaped) {
        case 'n':
          value += '\n'
          break
        case 't':
          value += '\t'
          break
        case 'r':
          value += '\r'
          break
        case '"':
          value += '"'
          break
        case '\\':
          value += '\\'
          break
        case '0':
          value += '\0'
          break
        case 'b':
          value += '\b'
          break
        case 'f':
          value += '\f'
          break
        case 'u': {
          const hex = text.slice(index + 1, index + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new YamlSyntaxError('invalid \\u escape in a double-quoted string', line)
          }
          value += String.fromCharCode(parseInt(hex, 16))
          index += 4
          break
        }
        default:
          throw new YamlSyntaxError(`unsupported escape "\\${escaped}" in a double-quoted string`, line)
      }
      continue
    }
    if (char === '"') return { value, rest: text.slice(index + 1) }
    value += char
  }
  throw new YamlSyntaxError('unterminated quoted string', line)
}

/**
 * Convert a plain scalar token to its YAML value (string/number/boolean/null).
 *
 * @param {string} text
 * @returns {string|number|boolean|null}
 */
function parsePlainScalar(text) {
  const value = text.trim()
  if (value === '' || value === '~' || /^(?:null|Null|NULL)$/.test(value)) return null
  if (/^(?:true|True|TRUE)$/.test(value)) return true
  if (/^(?:false|False|FALSE)$/.test(value)) return false
  if (/^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value)
  return value
}

/** Skip whitespace inside a flow collection. @param {{text: string, pos: number}} state */
function skipFlowWhitespace(state) {
  while (state.pos < state.text.length && /\s/.test(state.text[state.pos])) state.pos += 1
}

/** Read a plain scalar token inside a flow collection. @param {{text: string, pos: number}} state @param {string} stops @returns {string} */
function readFlowPlain(state, stops) {
  const start = state.pos
  while (state.pos < state.text.length && !stops.includes(state.text[state.pos])) {
    state.pos += 1
  }
  return state.text.slice(start, state.pos)
}

/** Read one node inside a flow collection. @param {{text: string, pos: number, line: number}} state @returns {unknown} */
function readFlowNode(state) {
  skipFlowWhitespace(state)
  const char = state.text[state.pos]
  if (char === undefined) {
    throw new YamlSyntaxError('multi-line flow collections are not supported', state.line)
  }
  if (char === '[') {
    state.pos += 1
    return readFlowSequence(state)
  }
  if (char === '{') {
    state.pos += 1
    return readFlowMapping(state)
  }
  if (char === '"' || char === "'") {
    const slice = state.text.slice(state.pos)
    const quoted = readQuoted(slice, state.line)
    state.pos += slice.length - quoted.rest.length
    return quoted.value
  }
  const token = readFlowPlain(state, ',]}')
  return parsePlainScalar(token)
}

/** Read a flow sequence body (leading `[` already consumed). @param {{text: string, pos: number, line: number}} state @returns {unknown[]} */
function readFlowSequence(state) {
  const out = []
  skipFlowWhitespace(state)
  if (state.text[state.pos] === ']') {
    state.pos += 1
    return out
  }
  for (;;) {
    out.push(readFlowNode(state))
    skipFlowWhitespace(state)
    const char = state.text[state.pos]
    if (char === ',') {
      state.pos += 1
      continue
    }
    if (char === ']') {
      state.pos += 1
      return out
    }
    throw new YamlSyntaxError('unterminated flow sequence', state.line)
  }
}

/** Read a flow mapping body (leading `{` already consumed). @param {{text: string, pos: number, line: number}} state @returns {Record<string, unknown>} */
function readFlowMapping(state) {
  const out = {}
  skipFlowWhitespace(state)
  if (state.text[state.pos] === '}') {
    state.pos += 1
    return out
  }
  for (;;) {
    skipFlowWhitespace(state)
    let key
    const char = state.text[state.pos]
    if (char === '"' || char === "'") {
      const slice = state.text.slice(state.pos)
      const quoted = readQuoted(slice, state.line)
      state.pos += slice.length - quoted.rest.length
      key = quoted.value
    } else {
      key = readFlowPlain(state, ':},').trim()
    }
    skipFlowWhitespace(state)
    if (state.text[state.pos] !== ':') {
      throw new YamlSyntaxError('expected ":" in a flow mapping', state.line)
    }
    state.pos += 1
    out[String(key)] = readFlowNode(state)
    skipFlowWhitespace(state)
    const next = state.text[state.pos]
    if (next === ',') {
      state.pos += 1
      continue
    }
    if (next === '}') {
      state.pos += 1
      return out
    }
    throw new YamlSyntaxError('unterminated flow mapping', state.line)
  }
}

/**
 * Line-oriented parser state for one YAML document.
 */
class Parser {
  /** @param {string} text */
  constructor(text) {
    this.lines = String(text ?? '')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
    this.pos = 0
    /** @type {string[]} */
    this.warnings = []
  }

  /** 1-based line number for an index (defaults to the current line). @param {number} [index] @returns {number} */
  lineNumber(index = this.pos) {
    return index + 1
  }

  /** Skip blank and full-line-comment lines. */
  skipEmpty() {
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos]
      const trimmed = raw.trim()
      if (trimmed === '' || trimmed.startsWith('#')) {
        this.pos += 1
        continue
      }
      return
    }
  }

  /**
   * Current content line after skipping blanks/comments.
   * @returns {{raw: string, indent: number, text: string, line: number}|null}
   */
  current() {
    this.skipEmpty()
    if (this.pos >= this.lines.length) return null
    const raw = this.lines[this.pos]
    if (/^ *\t/.test(raw)) {
      throw new YamlSyntaxError('tab characters are not allowed for indentation', this.lineNumber())
    }
    const indent = leadingSpaces(raw)
    return { raw, indent, text: raw.slice(indent), line: this.lineNumber() }
  }

  /** Parse the document root. @returns {unknown} */
  parseRoot() {
    this.skipEmpty()
    while (this.pos < this.lines.length && this.lines[this.pos].trim() === '---') {
      this.pos += 1
      this.skipEmpty()
    }
    const first = this.current()
    if (first === null) return null
    if (first.text.trim() === '...') return null

    let value
    if (isSequenceText(first.text)) value = this.parseSequence(first.indent)
    else if (findKeyColon(stripInlineComment(first.text)) !== -1) value = this.parseMapping(first.indent)
    else {
      value = this.parseInlineValue(first.text, first.line)
      this.pos += 1
    }

    this.skipEmpty()
    if (this.pos < this.lines.length && this.lines[this.pos].trim() === '...') {
      this.pos += 1
      this.skipEmpty()
    }
    if (this.pos < this.lines.length) {
      if (this.lines[this.pos].trim() === '---') {
        this.warnings.push('multiple YAML documents are not supported; only the first document was parsed')
        this.pos = this.lines.length
      } else {
        throw new YamlSyntaxError('inconsistent top-level indentation', this.lineNumber())
      }
    }
    return value
  }

  /** Parse an indented block at `indent`. @param {number} indent @returns {unknown} */
  parseBlock(indent) {
    const current = this.current()
    if (current === null) return null
    if (current.indent !== indent) {
      throw new YamlSyntaxError('inconsistent indentation', current.line)
    }
    if (isSequenceText(current.text)) return this.parseSequence(indent)
    return this.parseMapping(indent)
  }

  /** Parse a block sequence at `indent`. @param {number} indent @returns {unknown[]} */
  parseSequence(indent) {
    /** @type {unknown[]} */
    const out = []
    for (;;) {
      const current = this.current()
      if (current === null || current.indent < indent) break
      if (current.indent > indent) {
        throw new YamlSyntaxError('inconsistent indentation inside a sequence', current.line)
      }
      if (!isSequenceText(current.text)) break

      const afterDash = current.text.slice(1)
      if (/^[ \t]*$/.test(afterDash) || afterDash.trimStart().startsWith('#')) {
        this.pos += 1
        const next = this.current()
        if (next !== null && next.indent > indent) out.push(this.parseBlock(next.indent))
        else out.push(null)
        continue
      }

      const spaces = leadingSpaces(afterDash)
      const contentColumn = indent + 1 + spaces
      const rest = afterDash.slice(spaces).replace(/\s+$/, '')

      // Re-indent this line so the item content starts at its natural column.
      this.lines[this.pos] = ' '.repeat(contentColumn) + rest

      if (isSequenceText(rest)) {
        out.push(this.parseSequence(contentColumn))
        continue
      }
      const cleaned = stripInlineComment(rest)
      if (findKeyColon(cleaned) !== -1) {
        out.push(this.parseMapping(contentColumn))
        continue
      }
      this.pos += 1
      const scalarText = cleaned.trim()
      if (BLOCK_INDICATOR.test(scalarText)) out.push(this.parseBlockScalar(scalarText, indent))
      else out.push(this.parseInlineValue(rest, current.line))
    }
    return out
  }

  /** Parse a block mapping at `indent`. @param {number} indent @returns {Record<string, unknown>} */
  parseMapping(indent) {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (;;) {
      const current = this.current()
      if (current === null || current.indent < indent) break
      if (current.indent > indent) {
        throw new YamlSyntaxError('inconsistent indentation inside a mapping', current.line)
      }
      const trimmed = current.text.trim()
      if (trimmed === '---' || trimmed === '...') break
      if (isSequenceText(current.text)) {
        throw new YamlSyntaxError('unexpected sequence entry inside a mapping', current.line)
      }

      const colon = findKeyColon(stripInlineComment(current.text))
      if (colon === -1) {
        throw new YamlSyntaxError('expected a "key: value" mapping entry', current.line)
      }
      const keyField = this.parseKey(current.text.slice(0, colon), current.line)
      const rest = current.text.slice(colon + 1).trimStart()
      this.pos += 1

      let value
      if (rest === '' || rest.startsWith('#')) {
        const next = this.current()
        if (next !== null && next.indent > indent) value = this.parseBlock(next.indent)
        else if (next !== null && next.indent === indent && isSequenceText(next.text)) {
          value = this.parseSequence(indent)
        } else value = null
      } else {
        const indicator = stripInlineComment(rest).trim()
        if (BLOCK_INDICATOR.test(indicator)) value = this.parseBlockScalar(indicator, indent)
        else value = this.parseInlineValue(rest, current.line)
      }

      if (Object.prototype.hasOwnProperty.call(out, keyField)) {
        this.warnings.push(`line ${current.line}: duplicate key "${keyField}" (the last value wins)`)
      }
      out[keyField] = value
    }
    return out
  }

  /**
   * Parse a mapping key, rejecting merge keys and anchors.
   * @param {string} rawKey raw text before the colon
   * @param {number} line 1-based line number
   * @returns {string}
   */
  parseKey(rawKey, line) {
    const text = rawKey.trim()
    if (text === '') throw new YamlSyntaxError('empty mapping key', line)
    let key
    if (text[0] === '"' || text[0] === "'") {
      const quoted = readQuoted(text, line)
      if (quoted.rest.trim() !== '') {
        throw new YamlSyntaxError('unexpected characters after a quoted mapping key', line)
      }
      key = quoted.value
    } else {
      if (text.startsWith('&') || text.startsWith('*')) {
        throw new YamlSyntaxError('anchors and aliases are not supported', line)
      }
      if (text.startsWith('!')) throw new YamlSyntaxError('tags are not supported', line)
      key = text
    }
    if (key === '<<') throw new YamlSyntaxError('merge keys ("<<") are not supported', line)
    return key
  }

  /**
   * Parse a scalar or single-line flow value.
   * @param {string} raw raw text after the colon / dash
   * @param {number} line 1-based line number
   * @returns {unknown}
   */
  parseInlineValue(raw, line) {
    const text = stripInlineComment(raw).trim()
    if (text === '') return null
    if (text[0] === '&' || text[0] === '*') {
      throw new YamlSyntaxError('anchors and aliases are not supported', line)
    }
    if (text[0] === '!') throw new YamlSyntaxError('tags are not supported', line)
    if (text[0] === '[' || text[0] === '{') {
      const state = { text, pos: 0, line }
      const value = readFlowNode(state)
      skipFlowWhitespace(state)
      if (state.pos < text.length) {
        throw new YamlSyntaxError('unexpected characters after a flow collection', line)
      }
      return value
    }
    if (text[0] === '"' || text[0] === "'") {
      const quoted = readQuoted(text, line)
      if (quoted.rest.trim() !== '') {
        throw new YamlSyntaxError('unexpected characters after a quoted string', line)
      }
      return quoted.value
    }
    return parsePlainScalar(text)
  }

  /**
   * Parse a `|` / `>` block scalar. The cursor is on the header line's successor.
   * @param {string} indicator block scalar header (`|`, `>-`, `|2`, ...)
   * @param {number} parentIndent indentation of the owning mapping key / sequence entry
   * @returns {string}
   */
  parseBlockScalar(indicator, parentIndent) {
    const style = indicator[0]
    const flags = indicator.slice(1)
    const chomp = flags.includes('-') ? 'strip' : flags.includes('+') ? 'keep' : 'clip'
    const explicitMatch = flags.match(/[1-9]/)
    const explicitIndent = explicitMatch === null ? null : Number(explicitMatch[0])
    let blockIndent = explicitIndent === null ? null : parentIndent + explicitIndent

    /** @type {string[]} */
    const content = []
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos]
      if (raw.trim() === '') {
        content.push('')
        this.pos += 1
        continue
      }
      const indent = leadingSpaces(raw)
      if (blockIndent === null) {
        if (indent <= parentIndent) break
        blockIndent = indent
      }
      if (indent < blockIndent) break
      content.push(raw.slice(blockIndent))
      this.pos += 1
    }

    let trailing = 0
    while (content.length > 0 && content[content.length - 1] === '') {
      content.pop()
      trailing += 1
    }

    let body
    if (style === '|') body = content.join('\n')
    else {
      body = ''
      let previousBlank = true
      for (const line of content) {
        if (line === '') {
          body += '\n'
          previousBlank = true
          continue
        }
        if (!previousBlank) body += ' '
        body += line
        previousBlank = false
      }
    }

    if (body !== '') {
      if (chomp === 'clip') body += '\n'
      else if (chomp === 'keep') body += '\n'.repeat(trailing + 1)
      return body
    }
    if (chomp === 'keep' && trailing > 0) return '\n'.repeat(trailing)
    return ''
  }
}

/**
 * Parse the supported YAML subset into a JavaScript value.
 *
 * Never throws for malformed input: syntax problems are reported through
 * `error` (with a 1-based line number) and `value` is `null`.
 *
 * @param {string} text YAML document text
 * @returns {{value: unknown, warnings: string[], error: {message: string, line: number}|null}}
 */
export function parseYaml(text) {
  const parser = new Parser(text)
  try {
    const value = parser.parseRoot()
    return { value, warnings: parser.warnings, error: null }
  } catch (error) {
    if (error instanceof YamlSyntaxError) {
      return {
        value: null,
        warnings: parser.warnings,
        error: { message: error.message, line: error.line },
      }
    }
    throw error
  }
}
