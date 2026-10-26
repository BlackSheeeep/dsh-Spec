/**
 * Mechanical auto-commit for the OpenSpec panel.
 *
 * It never asks a model: it reads `git status`, filters junk/temporary files,
 * stages only the safe paths, and writes a short deterministic commit message.
 * Pre-existing `.gitignore` rules are respected by git itself; this module adds
 * a conservative denylist on top.
 *
 * @module dsh-spec/native/autocommit
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MAX_FILE_BYTES = 5 * 1024 * 1024

const DENY_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)\.dsh\//,
  /(^|\/)\.tmp\//,
  /(^|\/)tmp\//,
  /(^|\/)temp\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /(^|\/)\.cache\//,
  /(^|\/)__pycache__\//,
  /(^|\/)\.pytest_cache\//,
  /(^|\/)\.venv\//,
  /(^|\/)venv\//,
  /(^|\/)\.godot\//,
  /(^|\/)\.import\//,
  /(^|\/)\.trash\//,
  /\.log$/i,
  /\.tmp$/i,
  /\.temp$/i,
  /\.bak$/i,
  /\.swp$/i,
  /~$/,
  /\.pyc$/i,
  /\.tsbuildinfo$/i,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.[^/]+$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa$/,
]

function isSensitive(path) {
  if (/(^|\/)\.env\.example$/i.test(path) || /(^|\/)\.env\.sample$/i.test(path)) return false
  return /(^|\/)\.env(\.|$)/i.test(path) || /\.(pem|key)$/i.test(path) || /(^|\/)id_rsa$/i.test(path)
}

/** Whether a repo-relative path is junk that must not be committed. */
export function shouldIgnorePath(path) {
  const value = String(path ?? '').replaceAll('\\', '/')
  if (value === '' || value === '.' || value.startsWith('../')) return true
  if (isSensitive(value)) return true
  return DENY_PATTERNS.some((pattern) => pattern.test(value))
}

/** Parse NUL-delimited `git status --porcelain=v1 -z` output. */
export function parseStatus(output) {
  const entries = []
  const parts = String(output ?? '').split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i]
    if (line === undefined || line.length < 4) continue
    const code = line.slice(0, 2)
    const path = line.slice(3)
    if (path === '') continue
    let from
    if (code.includes('R') || code.includes('C')) {
      from = path
      i += 1
      const to = parts[i]
      if (to !== undefined && to !== '') entries.push({ status: code, path: to, from })
      continue
    }
    entries.push({ status: code, path })
  }
  return entries
}

/** Build a deterministic, human-readable commit message. */
export function buildCommitMessage(files, statuses) {
  const added = statuses.added.length
  const modified = statuses.modified.length
  const deleted = statuses.deleted.length
  const renamed = statuses.renamed.length
  const onlyDocs = files.every((file) => /(^|\/)(docs?|README|CHANGELOG)|\.md$/i.test(file))
  const onlySpec = files.every((file) => file.startsWith('openspec/'))
  const prefix = onlySpec ? 'docs(openspec)' : onlyDocs ? 'docs' : 'chore'
  const header = `${prefix}: update ${files.length} file${files.length === 1 ? '' : 's'}`
  const counts = [
    added > 0 ? `added ${added}` : '',
    modified > 0 ? `modified ${modified}` : '',
    deleted > 0 ? `deleted ${deleted}` : '',
    renamed > 0 ? `renamed ${renamed}` : '',
  ].filter(Boolean)
  const body = [
    counts.length > 0 ? `Summary: ${counts.join(', ')}.` : 'Summary: repository update.',
    '',
    ...files.slice(0, 20).map((file) => `- ${file}`),
    files.length > 20 ? `- ... and ${files.length - 20} more` : '',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return { header, body }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

/**
 * Preview or create one commit from the safe subset of the working tree.
 * @param {string} cwd
 * @param {{ dryRun?: boolean }} [options]
 */
export async function autoCommit(cwd, options = {}) {
  let root
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    throw new Error('当前工作区不是 Git 仓库')
  }
  const output = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const diffStat = await git(root, ['diff', '--stat', '--no-ext-diff']).catch(() => '')
  const cachedStat = await git(root, ['diff', '--cached', '--stat', '--no-ext-diff']).catch(() => '')
  const fingerprint = createHash('sha256')
    .update(`${output}\0${diffStat}\0${cachedStat}`)
    .digest('hex')
  const entries = parseStatus(output)
  const safe = []
  const skipped = []
  for (const entry of entries) {
    if (shouldIgnorePath(entry.path)) {
      skipped.push({ path: entry.path, reason: 'ignored' })
      continue
    }
    try {
      const stat = await fs.stat(path.join(root, entry.path))
      if (stat.isFile() && stat.size > MAX_FILE_BYTES) {
        skipped.push({ path: entry.path, reason: 'too-large' })
        continue
      }
    } catch {
      /* deleted paths have no stat */
    }
    safe.push(entry)
  }
  const statuses = {
    added: safe.filter((entry) => entry.status.includes('A') || entry.status === '??').map((entry) => entry.path),
    modified: safe.filter((entry) => entry.status.includes('M')).map((entry) => entry.path),
    deleted: safe.filter((entry) => entry.status.includes('D')).map((entry) => entry.path),
    renamed: safe.filter((entry) => entry.status.includes('R') || entry.status.includes('C')).map((entry) => entry.path),
  }
  const message = buildCommitMessage(
    safe.map((entry) => entry.path),
    statuses,
  )
  if (options.dryRun === true) {
    return {
      ok: true,
      root,
      files: safe,
      skipped,
      message,
      fingerprint,
    }
  }
  if (safe.length === 0) {
    return { ok: false, reason: 'no-safe-changes', root, files: [], skipped, message }
  }
  // Stage only the approved paths; do not use `git add -A`.
  await git(root, ['add', '-A', '--', ...safe.map((entry) => entry.path)])
  const commitOutput = await git(root, ['commit', '-m', message.header, '-m', message.body])
  const hash = (await git(root, ['rev-parse', 'HEAD'])).trim()
  return {
    ok: true,
    root,
    hash,
    files: safe,
    skipped,
    message,
    fingerprint,
    output: commitOutput,
  }
}
