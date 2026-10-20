/**
 * Filesystem helpers for the OpenSpec native engine (Host half).
 *
 * The engine never receives an ambient filesystem: every workspace path it
 * touches is derived from an **absolute** workspace root (`cwd`) plus a
 * workspace-relative POSIX path (`openspec/changes/my-change/tasks.md`).
 * These helpers are the single place that converts between the two, and the
 * write helpers refuse anything that resolves outside `cwd`.
 *
 * All I/O uses `node:fs/promises`; nothing here spawns a process or uses the
 * network.
 *
 * @module dsh-spec/native/fsio
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** Workspace-relative paths always use POSIX separators. */
const POSIX_SEP = '/'
const WIN32 = process.platform === 'win32'

/** Turn a Windows-style path into a POSIX-style one. @param {unknown} value @returns {string} */
function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** Throw a path error using a stable, user-facing message. @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message)
}

/**
 * Collapse `.` / `..` segments in a workspace-relative path and reject paths
 * that would escape the workspace root or that are absolute.
 *
 * @param {string} rel workspace-relative POSIX path (`''` is the workspace root)
 * @returns {string} normalized workspace-relative POSIX path (no leading slash)
 */
export function normalizeRel(rel) {
  const input = toPosix(rel).trim()
  if (input === '') return ''
  if (input.startsWith('/')) fail(`path must be workspace-relative: ${rel}`)
  if (/^[A-Za-z]:/.test(input)) fail(`path must be workspace-relative: ${rel}`)
  const segments = []
  for (const segment of input.split(POSIX_SEP)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) fail(`path escapes the workspace root: ${rel}`)
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join(POSIX_SEP)
}

/**
 * Join POSIX path parts into a normalized workspace-relative path.
 * Leading slashes on individual parts are ignored; `..` may not escape the root.
 *
 * @param {...(string|undefined|null)} parts
 * @returns {string}
 */
export function joinRel(...parts) {
  const segments = []
  for (const part of parts) {
    if (part === undefined || part === null) continue
    const text = toPosix(part).replace(/^\/+/, '')
    if (text === '') continue
    segments.push(text)
  }
  return normalizeRel(segments.join(POSIX_SEP))
}

/**
 * Absolute host path for a workspace-relative path.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative POSIX path
 * @returns {string} absolute host path
 */
export function toAbs(cwd, rel) {
  const normalized = normalizeRel(rel)
  const base = path.resolve(cwd)
  if (normalized === '') return base
  return path.join(base, ...normalized.split(POSIX_SEP))
}

/**
 * Win32-safe absolute-path containment check. Both arguments are resolved
 * against the current directory first. Symlinks are not resolved (the engine
 * never follows workspace symlinks for writes).
 *
 * @param {string} root absolute root directory
 * @param {string} target absolute target path
 * @returns {boolean} true when `target` is `root` or lives below it
 */
export function isInside(root, target) {
  const rootAbs = path.resolve(root)
  const targetAbs = path.resolve(target)
  if (WIN32) {
    const rootLower = rootAbs.toLowerCase()
    const targetLower = targetAbs.toLowerCase()
    if (rootLower === targetLower) return true
    const prefix = rootLower.endsWith(path.sep) ? rootLower : `${rootLower}${path.sep}`
    return targetLower.startsWith(prefix)
  }
  if (rootAbs === targetAbs) return true
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`
  return targetAbs.startsWith(prefix)
}

/** Resolve a path for a mutating operation, rejecting escapes/root itself. @param {string} cwd @param {string} rel @param {string} action @returns {string} */
function resolveWriteTarget(cwd, rel, action) {
  const normalized = normalizeRel(rel)
  if (normalized === '') fail(`${action}: refusing to operate on the workspace root`)
  const abs = toAbs(cwd, normalized)
  if (!isInside(cwd, abs)) fail(`${action}: path escapes the workspace root: ${rel}`)
  return abs
}

/**
 * Read a UTF-8 text file, returning `null` when it is missing or unreadable.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative POSIX path
 * @returns {Promise<string|null>}
 */
export async function readTextOrNull(cwd, rel) {
  try {
    return await readFile(toAbs(cwd, rel), 'utf8')
  } catch {
    return null
  }
}

/**
 * Read a UTF-8 text file, throwing when it is missing or unreadable.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative POSIX path
 * @returns {Promise<string>}
 */
export async function readText(cwd, rel) {
  return readFile(toAbs(cwd, rel), 'utf8')
}

/**
 * List a directory. Returns `[]` when the directory is missing or unreadable.
 * Entries are sorted by name for deterministic output.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative POSIX path
 * @returns {Promise<Array<{name: string, type: 'file'|'directory'|'other'}>>}
 */
export async function listDir(cwd, rel) {
  let entries
  try {
    entries = await readdir(toAbs(cwd, rel), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .map((entry) => ({
      name: entry.name,
      type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Recursively flatten a directory tree into workspace-relative entries.
 * The root itself is not included. Missing roots and unreadable subtrees are
 * tolerated (`[]` / partial results, never a throw). Sorted depth-first by name.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative root to walk
 * @param {{maxDepth?: number}} [options] `maxDepth` counts directory levels below `rel` (default 12)
 * @returns {Promise<Array<{rel: string, name: string, type: 'file'|'directory'|'other'}>>}
 */
export async function listTree(cwd, rel, { maxDepth = 12 } = {}) {
  const rootRel = normalizeRel(rel)
  /** @type {Array<{rel: string, name: string, type: 'file'|'directory'|'other'}>} */
  const out = []
  /** @param {string} dirRel @param {number} depth */
  const walk = async (dirRel, depth) => {
    if (depth >= maxDepth) return
    const entries = await listDir(cwd, dirRel)
    for (const entry of entries) {
      const entryRel = joinRel(dirRel, entry.name)
      out.push({ rel: entryRel, name: entry.name, type: entry.type })
      if (entry.type === 'directory') await walk(entryRel, depth + 1)
    }
  }
  await walk(rootRel, 0)
  return out
}

/**
 * Whether a path exists as a file or directory.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative POSIX path
 * @returns {Promise<boolean>}
 */
export async function pathExists(cwd, rel) {
  try {
    await stat(toAbs(cwd, rel))
    return true
  } catch {
    return false
  }
}

/**
 * Whether a path exists and is a regular file.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative POSIX path
 * @returns {Promise<boolean>}
 */
export async function isFile(cwd, rel) {
  try {
    return (await stat(toAbs(cwd, rel))).isFile()
  } catch {
    return false
  }
}

/**
 * Write a UTF-8 text file atomically: `mkdir -p` the parent, write a temp file
 * next to the target, then rename. Refuses paths outside `cwd`.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative POSIX path
 * @param {string} content file content
 * @returns {Promise<void>}
 */
export async function writeText(cwd, rel, content) {
  const abs = resolveWriteTarget(cwd, rel, 'writeText')
  const dir = path.dirname(abs)
  await mkdir(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(abs)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, String(content ?? ''), 'utf8')
    await rename(temp, abs)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Idempotently remove a file or directory tree. Refuses paths outside `cwd`
 * and the workspace root itself.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} rel workspace-relative POSIX path
 * @returns {Promise<void>}
 */
export async function removePath(cwd, rel) {
  const abs = resolveWriteTarget(cwd, rel, 'removePath')
  await rm(abs, { recursive: true, force: true })
}

/**
 * Move a file or directory inside the workspace, falling back to copy + remove
 * when `rename` cannot cross devices. Refuses paths outside `cwd`.
 *
 * @param {string} cwd absolute workspace root
 * @param {string} fromRel workspace-relative source path
 * @param {string} toRel workspace-relative destination path
 * @returns {Promise<void>}
 */
export async function movePath(cwd, fromRel, toRel) {
  const fromAbs = resolveWriteTarget(cwd, fromRel, 'movePath')
  const toAbsPath = resolveWriteTarget(cwd, toRel, 'movePath')
  await mkdir(path.dirname(toAbsPath), { recursive: true })
  try {
    await rename(fromAbs, toAbsPath)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(fromAbs, toAbsPath, { recursive: true })
    await rm(fromAbs, { recursive: true, force: true })
  }
}
