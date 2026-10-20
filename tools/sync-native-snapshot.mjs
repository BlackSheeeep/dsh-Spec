#!/usr/bin/env node
/**
 * Refresh the bundled OpenSpec `spec-driven` snapshot (developer tool, never
 * loaded by the plugin host).
 *
 * The plugin ships a pinned copy of the upstream OpenSpec 1.14.3 schema and
 * templates under `src/native-snapshot/` and uses it only when a project does
 * not define the same schema itself. This script copies the upstream files
 * verbatim (normalizing line endings to LF so the snapshot is deterministic)
 * and refreshes the `Upstream version:` / `Upstream commit:` markers in
 * `src/native-snapshot/ATTRIBUTION.md`.
 *
 * Usage:
 *   node tools/sync-native-snapshot.mjs --source <path-to-openspec-repo>
 *   OPENSPEC_SOURCE=<path-to-openspec-repo> node tools/sync-native-snapshot.mjs
 *
 * Optional flags:
 *   --version <x.y.z>   Override the upstream version marker
 *   --commit <sha>      Override the upstream commit marker
 *   --dry-run           Print the plan without writing anything
 *   --help              Show usage
 *
 * `--source` may point at an OpenSpec repository checkout (containing
 * `schemas/spec-driven/`) or directly at the `schemas/spec-driven/` directory.
 * The command exits non-zero with a clear message when the source is missing.
 *
 * @module dsh-spec/sync-native-snapshot
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Bundled schema name copied from upstream. */
export const SNAPSHOT_SCHEMA = 'spec-driven'

/** Attribution file that records the pinned upstream revision. */
export const ATTRIBUTION_FILE = 'ATTRIBUTION.md'

/** Plugin repository root (this file lives in `<root>/tools/`). */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Default snapshot target directory: `<root>/src/native-snapshot/`. */
export const SNAPSHOT_ROOT = fileURLToPath(new URL('../src/native-snapshot/', import.meta.url))

/** Upstream package name used to identify an OpenSpec checkout. */
const UPSTREAM_PACKAGE_NAME = '@fission-ai/openspec'

/** Usage text printed for --help and argument errors. */
const USAGE = [
  'Usage: node tools/sync-native-snapshot.mjs --source <path-to-openspec-repo> [--version x.y.z] [--commit <sha>] [--dry-run]',
  '',
  'Copies <repo>/schemas/spec-driven/{schema.yaml,templates/*} into src/native-snapshot/spec-driven/',
  'and refreshes the pinned version/commit markers in src/native-snapshot/ATTRIBUTION.md.',
  'The source can also be OPENSPEC_SOURCE in the environment.',
].join('\n')

/** Normalize file content to LF so the snapshot does not depend on the checkout platform. */
export function normalizeEol(text) {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

/**
 * Parse the command line and environment for the refresh options.
 *
 * @param {string[]} [argv] arguments after the script name
 * @param {Record<string, string|undefined>} [env] environment fallback
 * @returns {{ source: string|null, version: string|null, commit: string|null,
 *            dryRun: boolean, help: boolean, error: string|null }}
 */
export function parseSyncArgs(argv = process.argv.slice(2), env = process.env) {
  const options = { source: null, version: null, commit: null, dryRun: false, help: false, error: null }
  const args = Array.isArray(argv) ? argv.map(String) : []
  const takeValue = (flag, index) => {
    const inline = args[index].startsWith(`${flag}=`) ? args[index].slice(flag.length + 1) : null
    if (inline !== null) return { value: inline, consumed: 0 }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-')) return { value: null, consumed: 0 }
    return { value, consumed: 1 }
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--source' || arg.startsWith('--source=')) {
      const { value, consumed } = takeValue('--source', index)
      if (value === null || value.trim().length === 0) {
        options.error = 'missing value for --source'
        return options
      }
      options.source = value.trim()
      index += consumed
      continue
    }
    if (arg === '--version' || arg.startsWith('--version=')) {
      const { value, consumed } = takeValue('--version', index)
      if (value === null || value.trim().length === 0) {
        options.error = 'missing value for --version'
        return options
      }
      options.version = value.trim()
      index += consumed
      continue
    }
    if (arg === '--commit' || arg.startsWith('--commit=')) {
      const { value, consumed } = takeValue('--commit', index)
      if (value === null || value.trim().length === 0) {
        options.error = 'missing value for --commit'
        return options
      }
      options.commit = value.trim()
      index += consumed
      continue
    }
    options.error = `unknown argument: ${arg}`
    return options
  }
  if (options.source === null && typeof env?.OPENSPEC_SOURCE === 'string' && env.OPENSPEC_SOURCE.trim().length > 0) {
    options.source = env.OPENSPEC_SOURCE.trim()
  }
  if (options.version === null && typeof env?.OPENSPEC_VERSION === 'string' && env.OPENSPEC_VERSION.trim().length > 0) {
    options.version = env.OPENSPEC_VERSION.trim()
  }
  if (options.commit === null && typeof env?.OPENSPEC_COMMIT === 'string' && env.OPENSPEC_COMMIT.trim().length > 0) {
    options.commit = env.OPENSPEC_COMMIT.trim()
  }
  return options
}

/**
 * Resolve the upstream `schemas/spec-driven` directory from a source path.
 *
 * @param {string} source OpenSpec repository root or a `schemas/spec-driven` directory
 * @returns {string|null} absolute schema directory, or null when not found
 */
export function resolveSourceSchemaDir(source) {
  if (typeof source !== 'string' || source.trim().length === 0) return null
  const root = resolve(source.trim())
  const candidates = [join(root, 'schemas', SNAPSHOT_SCHEMA), root]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'schema.yaml'))) return candidate
  }
  return null
}

/** Recursively list files under a directory as POSIX-relative paths, sorted. */
function listFiles(dir, base = '') {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const rel = base.length === 0 ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) files.push(...listFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) files.push(rel)
  }
  return files.sort()
}

/** Read the MIT-licensed upstream package version when the source is a checkout. */
function readUpstreamPackageVersion(repoRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    if (pkg && typeof pkg.version === 'string' && (pkg.name === UPSTREAM_PACKAGE_NAME || pkg.name === 'openspec')) {
      return pkg.version
    }
  } catch {
    /* not an upstream checkout */
  }
  return null
}

/** Find the enclosing OpenSpec checkout root of a schema directory, if any. */
function findUpstreamRepoRoot(schemaDir) {
  let current = dirname(schemaDir)
  for (let depth = 0; depth < 6; depth += 1) {
    if (readUpstreamPackageVersion(current) !== null) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** Read the checked-out commit SHA from `.git` without spawning git. */
export function readGitCommit(repoRoot) {
  try {
    const dotGit = join(repoRoot, '.git')
    if (!existsSync(dotGit)) return null
    let gitDir = dotGit
    let statContent = null
    try {
      statContent = readFileSync(dotGit, 'utf8')
    } catch {
      statContent = null
    }
    if (typeof statContent === 'string' && statContent.startsWith('gitdir:')) {
      gitDir = resolve(repoRoot, statContent.slice('gitdir:'.length).trim())
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) {
      const ref = head.slice('ref:'.length).trim()
      try {
        const sha = readFileSync(join(gitDir, ref), 'utf8').trim()
        return /^[0-9a-f]{40}$/i.test(sha) ? sha : null
      } catch {
        const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
        for (const line of packed.split(/\r?\n/)) {
          const [sha, name] = line.trim().split(/\s+/, 2)
          if (name === ref && /^[0-9a-f]{40}$/i.test(sha ?? '')) return sha
        }
        return null
      }
    }
    return /^[0-9a-f]{40}$/i.test(head) ? head : null
  } catch {
    return null
  }
}

/**
 * Read the recorded `Upstream version:` / `Upstream commit:` markers from the
 * attribution text.
 *
 * @param {string} text attribution markdown
 * @returns {{ version: string|null, commit: string|null }}
 */
export function readAttributionMarkers(text) {
  const source = String(text ?? '')
  const version = /^[-*]\s*Upstream version:\s*(\S+)\s*$/m.exec(source)
  const commit = /^[-*]\s*Upstream commit:\s*([0-9a-f]{7,40})\s*$/im.exec(source)
  return { version: version ? version[1] : null, commit: commit ? commit[1] : null }
}

/**
 * Refresh the machine-readable revision markers in the attribution text.
 *
 * @param {string} text existing attribution markdown
 * @param {{ version?: string|null, commit?: string|null }} revision values to record
 * @returns {{ text: string, warnings: string[] }}
 */
export function refreshAttribution(text, revision = {}) {
  let output = String(text ?? '')
  const warnings = []
  const version = typeof revision.version === 'string' && revision.version.trim().length > 0 ? revision.version.trim() : null
  const commit = typeof revision.commit === 'string' && revision.commit.trim().length > 0 ? revision.commit.trim() : null
  if (version !== null) {
    const versionPattern = /^([-*]\s*Upstream version:\s*)\S+\s*$/m
    if (versionPattern.test(output)) output = output.replace(versionPattern, `$1${version}`)
    else warnings.push('ATTRIBUTION.md has no "Upstream version:" marker to refresh')
  }
  if (commit !== null) {
    const commitPattern = /^([-*]\s*Upstream commit:\s*)[0-9a-f]{7,40}\s*$/im
    if (commitPattern.test(output)) output = output.replace(commitPattern, `$1${commit}`)
    else warnings.push('ATTRIBUTION.md has no "Upstream commit:" marker to refresh')
  }
  return { text: output, warnings }
}

/**
 * Build the snapshot refresh plan without writing anything (testable off-disk).
 *
 * @param {string} source OpenSpec repository root or `schemas/spec-driven` directory
 * @param {{ targetRoot?: string, version?: string|null, commit?: string|null }} [options]
 * @returns {{ ok: boolean, error: string|null, sourceSchemaDir: string|null,
 *            targetSchemaDir: string|null, files: Array<{ rel: string, target: string, content: string, changed: boolean }>,
 *            attribution: { target: string, content: string, changed: boolean, version: string|null, commit: string|null,
 *                           warnings: string[] } | null,
 *            warnings: string[] }}
 */
export function planSnapshot(source, options = {}) {
  const targetRoot = options.targetRoot ?? SNAPSHOT_ROOT
  const schemaDir = resolveSourceSchemaDir(source)
  const empty = {
    ok: false,
    error: null,
    sourceSchemaDir: null,
    targetSchemaDir: join(targetRoot, SNAPSHOT_SCHEMA),
    files: [],
    attribution: null,
    warnings: [],
  }
  if (schemaDir === null) {
    return {
      ...empty,
      error: `snapshot source not found: ${String(source ?? '')} (expected <source>/schemas/${SNAPSHOT_SCHEMA}/schema.yaml or a ${SNAPSHOT_SCHEMA} schema directory)`,
    }
  }
  const templatesDir = join(schemaDir, 'templates')
  if (!existsSync(templatesDir)) {
    return { ...empty, sourceSchemaDir: schemaDir, error: `snapshot source is incomplete: missing ${join(templatesDir, '*.md')}` }
  }

  const targetSchemaDir = join(targetRoot, SNAPSHOT_SCHEMA)
  const sources = [
    { rel: 'schema.yaml', abs: join(schemaDir, 'schema.yaml') },
    ...listFiles(templatesDir).map((rel) => ({ rel: `templates/${rel}`, abs: join(templatesDir, rel) })),
  ]
  const files = sources.map(({ rel, abs }) => {
    const content = normalizeEol(readFileSync(abs, 'utf8'))
    const target = join(targetSchemaDir, ...rel.split('/'))
    let existing = null
    try {
      existing = normalizeEol(readFileSync(target, 'utf8'))
    } catch {
      existing = null
    }
    return { rel, target, content, changed: existing !== content }
  })

  // Resolve the pinned revision: explicit flags win, then the upstream
  // checkout itself, then the markers already recorded in ATTRIBUTION.md.
  const warnings = []
  const attributionPath = join(targetRoot, ATTRIBUTION_FILE)
  let existingAttribution = null
  try {
    existingAttribution = readFileSync(attributionPath, 'utf8')
  } catch {
    existingAttribution = null
  }
  const existingMarkers = readAttributionMarkers(existingAttribution ?? '')
  const upstreamRoot = findUpstreamRepoRoot(schemaDir)
  const version = options.version ?? (upstreamRoot ? readUpstreamPackageVersion(upstreamRoot) : null) ?? existingMarkers.version
  const commit = options.commit ?? (upstreamRoot ? readGitCommit(upstreamRoot) : null) ?? existingMarkers.commit
  let attribution = null
  if (existingAttribution === null) {
    warnings.push(`attribution file missing: ${attributionPath} (was it moved?)`)
  } else {
    const refreshed = refreshAttribution(existingAttribution, { version, commit })
    warnings.push(...refreshed.warnings)
    attribution = {
      target: attributionPath,
      content: refreshed.text,
      changed: refreshed.text !== existingAttribution,
      version,
      commit,
      warnings: refreshed.warnings,
    }
  }

  return {
    ok: true,
    error: null,
    sourceSchemaDir: schemaDir,
    targetSchemaDir,
    files,
    attribution,
    warnings,
  }
}

/** Write one file via a temp file + rename so an interrupted run leaves no partial file. */
function writeAtomic(target, content) {
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.tmp-snapshot`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, target)
}

/**
 * Apply a plan built by {@link planSnapshot}. Developer tool only.
 *
 * @param {ReturnType<typeof planSnapshot>} plan
 * @returns {{ written: string[] }}
 */
export function applySnapshotPlan(plan) {
  if (!plan || plan.ok !== true) {
    throw new Error(plan?.error ?? 'invalid snapshot plan')
  }
  const written = []
  for (const file of plan.files) {
    writeAtomic(file.target, file.content)
    written.push(file.rel)
  }
  if (plan.attribution && (plan.attribution.changed || !existsSync(plan.attribution.target))) {
    writeAtomic(plan.attribution.target, plan.attribution.content)
    written.push(ATTRIBUTION_FILE)
  }
  return { written }
}

/**
 * CLI entry point. Returns the process exit code instead of exiting so tests
 * can exercise the argument handling (they never write).
 *
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} 0 on success, 1 when the source is invalid, 2 on bad usage
 */
export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseSyncArgs(argv, env)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.error !== null) {
    console.error(`sync-native-snapshot: ${options.error}`)
    console.error(USAGE)
    return 2
  }
  if (options.source === null) {
    console.error('sync-native-snapshot: no snapshot source given; pass --source <openspec-repo> or set OPENSPEC_SOURCE')
    console.error(USAGE)
    return 2
  }
  const plan = planSnapshot(options.source, { version: options.version, commit: options.commit })
  if (plan.ok !== true) {
    console.error(`sync-native-snapshot: ${plan.error}`)
    return 1
  }
  const changedFiles = plan.files.filter((file) => file.changed).map((file) => file.rel)
  const attributionChanged = plan.attribution?.changed === true
  if (options.dryRun) {
    console.log(`Snapshot source: ${plan.sourceSchemaDir}`)
    console.log(`Target: ${plan.targetSchemaDir}`)
    console.log(changedFiles.length === 0 && !attributionChanged ? 'Already up to date.' : `Would update: ${[...changedFiles, ...(attributionChanged ? [ATTRIBUTION_FILE] : [])].join(', ')}`)
    return 0
  }
  const { written } = applySnapshotPlan(plan)
  if (written.length === 0) {
    console.log(`Snapshot already up to date: ${plan.targetSchemaDir}`)
  } else {
    console.log(`Snapshot refreshed from ${plan.sourceSchemaDir}`)
    console.log(`Updated: ${written.join(', ')}`)
  }
  for (const warning of plan.warnings) console.warn(`warning: ${warning}`)
  return 0
}

const isEntryPoint = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isEntryPoint) {
  process.exitCode = main()
}
