/**
 * Native OpenSpec skill detection and the workspace-aware DSH fallback skill
 * provider.
 *
 * The plugin never registers runtime skills that could shadow a user's native
 * OpenSpec skills. Instead it:
 *
 * 1. Detects `openspec-*` skills under the project roots (`<cwd>/.dsh/skills`,
 *    `<cwd>/.agents/skills`) and the user roots (`<dshHome>/skills`,
 *    `<agentsHome>/skills`), parsing each entry's YAML frontmatter. Malformed
 *    entries are reported as warnings and skipped, never repaired.
 * 2. Registers a single runtime `SkillProvider` (see `createFallbackProvider`)
 *    that returns the twelve adapted OPSX workflow skills vendored from
 *    upstream OpenSpec 1.14.3 (see `./skill-adaptation.js`) only while no
 *    native `openspec-*` skill exists for the workspace it is asked about.
 *
 * Everything here is read-only: detection uses `readdir`/`readFile`/`stat`
 * only, and the vendored snapshot is loaded through `./skill-adaptation.js`.
 * Skill files are never created, rewritten, moved or deleted; adapted bodies
 * are assembled in memory and handed out through `get()`. A missing or
 * unreadable bundled snapshot degrades to "no fallback candidates" with a
 * warning instead of throwing.
 *
 * This module is intentionally self-contained (its own tolerant frontmatter
 * parser, no dependency on the YAML engine) so the skills workstream does not
 * couple to the data-engine modules.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { VENDORED_SKILLS, loadAdaptedSkill } from './skill-adaptation.js';

export { VENDORED_SKILLS };

/**
 * Workflow suffixes of the twelve vendored OPSX skills, in catalog order
 * (contract §10.3): the six core workflows first, then the extended ones.
 *
 * @type {readonly string[]}
 */
export const FALLBACK_WORKFLOWS = Object.freeze([
  'explore',
  'propose',
  'apply',
  'update',
  'sync',
  'archive',
  'new',
  'continue',
  'ff',
  'verify',
  'bulk-archive',
  'onboard',
]);

/** Provider name reported by fallback candidates. */
export const FALLBACK_PROVIDER_NAME = 'openspec-native-fallback';

/** Candidate rank for runtime fallbacks: project/user skills win automatically. */
const FALLBACK_RANK = 100;

/** File name of a directory skill bundle. */
const SKILL_BUNDLE_FILE = 'SKILL.md';

/** Project-relative skills roots, in precedence order. */
const PROJECT_SKILL_ROOTS = Object.freeze([
  Object.freeze({ rootParts: ['.dsh', 'skills'], label: '.dsh/skills' }),
  Object.freeze({ rootParts: ['.agents', 'skills'], label: '.agents/skills' }),
]);

/**
 * @typedef {object} SkillsIo
 * @property {(root: string, options?: object) => Promise<Array<{ name: string, isDirectory(): boolean, isFile(): boolean, isSymbolicLink(): boolean }>>} readdir
 * @property {(file: string, encoding: string) => Promise<string>} readFile
 * @property {(target: string) => Promise<{ isDirectory(): boolean, isFile(): boolean }>} stat
 */

/** Real filesystem implementation of {@link SkillsIo}. */
const DEFAULT_IO = Object.freeze({
  readdir: (root, options) => readdir(root, options),
  readFile: (file, encoding) => readFile(file, encoding),
  stat: (target) => stat(target),
});

/**
 * @typedef {object} NativeSkill
 * @property {string} name        Effective skill name (frontmatter `name`, else entry name).
 * @property {string} root        Absolute skills root the entry was found under.
 * @property {string} path        Absolute path to the `SKILL.md` or flat `<name>.md` file.
 * @property {string} description Frontmatter description (`''` when absent).
 * @property {string|null} workflow Core workflow, or the name remainder for other native skills.
 */

/**
 * @typedef {object} ParsedSkillFrontmatter
 * @property {boolean} ok
 * @property {string|null} name
 * @property {string|null} description
 * @property {string|null} whenToUse
 * @property {Record<string, string>} metadata Nested `metadata:` scalars.
 * @property {Record<string, unknown>} fields   All top-level parsed fields.
 * @property {string} body                     Text after the closing frontmatter fence.
 * @property {string[]} warnings
 * @property {string|null} error
 */

/**
 * @typedef {object} ScannedSkillsRoot
 * @property {string} root
 * @property {string} label
 * @property {string} scope
 * @property {boolean} exists
 * @property {NativeSkill[]} skills
 * @property {string[]} warnings
 */

/**
 * @typedef {object} NativeSkillsDetection
 * @property {NativeSkill[]} skills
 * @property {Array<{ root: string, label: string, scope: string, exists: boolean, skillCount: number }>} rootsScanned
 * @property {string[]} warnings
 */

/** Map the exact upstream skill names onto their workflow suffix. */
const WORKFLOW_BY_NAME = Object.freeze({
  'openspec-explore': 'explore',
  'openspec-propose': 'propose',
  'openspec-apply-change': 'apply',
  'openspec-update-change': 'update',
  'openspec-sync-specs': 'sync',
  'openspec-archive-change': 'archive',
  'openspec-new-change': 'new',
  'openspec-continue-change': 'continue',
  'openspec-ff-change': 'ff',
  'openspec-verify-change': 'verify',
  'openspec-bulk-archive-change': 'bulk-archive',
  'openspec-onboard': 'onboard',
});

/**
 * Map a native skill name to the workflow it covers.
 *
 * The twelve vendored upstream names map to the {@link FALLBACK_WORKFLOWS}
 * suffixes (`openspec-apply-change` → `apply`, `openspec-sync-specs` → `sync`,
 * `openspec-onboard` → `onboard`, …); any other `openspec-<suffix>` name maps to
 * `<suffix>` so the panel can describe additional native skills. Non-`openspec-`
 * names map to `null`.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function workflowForSkillName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '') return null;
  if (Object.prototype.hasOwnProperty.call(WORKFLOW_BY_NAME, trimmed)) {
    return WORKFLOW_BY_NAME[trimmed];
  }
  if (!trimmed.startsWith('openspec-')) return null;
  const suffix = trimmed.slice('openspec-'.length).trim();
  return suffix === '' ? null : suffix;
}

/**
 * Remove YAML comments and quotes from a single frontmatter scalar. This is a
 * deliberately small, tolerant subset: quoted scalars are unquoted, unquoted
 * scalars are returned verbatim.
 *
 * @param {string} raw
 * @returns {string}
 */
function unquoteScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // fall through to the tolerant unescape below
    }
    return value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Split a `key: value` frontmatter line. Returns `null` for lines that are not
 * simple top-level/nested scalar pairs (the parser tolerates and warns).
 *
 * @param {string} line
 * @returns {{ key: string, value: string } | null}
 */
function splitFrontmatterKeyValue(line) {
  const colonIndex = line.indexOf(':');
  if (colonIndex <= 0) return null;
  const key = line.slice(0, colonIndex).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) return null;
  let remainder = line.slice(colonIndex + 1).trim();
  if (remainder.startsWith('#')) remainder = '';
  if (remainder !== '' && !remainder.startsWith('"') && !remainder.startsWith("'")) {
    // Trailing ` # comment` is a comment only when the `#` is preceded by space
    // (YAML plain scalars keep `C#` intact). Quoted scalars keep `#` verbatim.
    const commentMatch = remainder.match(/(^|\s)#/);
    if (commentMatch && commentMatch.index > 0) {
      remainder = remainder.slice(0, commentMatch.index).trim();
    }
  }
  return { key, value: unquoteScalar(remainder) };
}

/**
 * True for the YAML block-scalar indicators this parser does not expand.
 * @param {string} value
 * @returns {boolean}
 */
function isBlockScalarIndicator(value) {
  return /^[|>][+-]?\d*$/.test(value);
}

/**
 * Parse the YAML frontmatter block of a skill document.
 *
 * This is a pure, tolerant subset parser for the fields the plugin needs
 * (`name`, `description`, `when-to-use`, `license`, and the nested `metadata:`
 * scalars). It supports comments, quoted scalars, nested one-level mappings
 * and reports unsupported YAML (block scalars, malformed lines) as warnings
 * instead of throwing.
 *
 * The body is the text after the closing fence with leading blank lines
 * removed; everything else is returned unchanged.
 *
 * @param {string} text Raw skill file content.
 * @returns {ParsedSkillFrontmatter}
 */
export function parseSkillFrontmatter(text) {
  /** @type {ParsedSkillFrontmatter} */
  const result = {
    ok: false,
    name: null,
    description: null,
    whenToUse: null,
    metadata: {},
    fields: {},
    body: '',
    warnings: [],
    error: null,
  };
  if (typeof text !== 'string') {
    result.error = 'skill content is not a string';
    return result;
  }
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = content.split(/\r?\n/);

  let openIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    if (lines[index].trim() === '---') openIndex = index;
    break;
  }
  if (openIndex === -1) {
    result.error = 'missing YAML frontmatter block';
    return result;
  }

  let closeIndex = -1;
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closeIndex = index;
      break;
    }
  }
  if (closeIndex === -1) {
    result.error = 'unterminated YAML frontmatter (missing closing ---)';
    return result;
  }
  result.body = lines
    .slice(closeIndex + 1)
    .join('\n')
    .replace(/^\n+/, '');

  const { fields } = result;
  let currentKey = null;
  let currentIsMapping = false;
  let skipBlockScalar = false;

  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const rawLine = lines[index];
    const trimmedLine = rawLine.trim();
    if (trimmedLine === '' || trimmedLine.startsWith('#')) continue;
    const expanded = rawLine.replace(/\t/g, '  ');
    const indent = expanded.length - expanded.trimStart().length;
    if (skipBlockScalar) {
      if (indent > 0) continue;
      skipBlockScalar = false;
    }
    const pair = splitFrontmatterKeyValue(expanded.trim());
    if (!pair) {
      result.warnings.push(`frontmatter line ${index + 1} is not a key: value pair`);
      continue;
    }
    if (indent > 0) {
      if (!currentKey || !currentIsMapping) {
        result.warnings.push(`frontmatter line ${index + 1} has unexpected indentation`);
        continue;
      }
      if (fields[currentKey] === '') fields[currentKey] = {};
      if (typeof fields[currentKey] !== 'object' || fields[currentKey] === null) {
        result.warnings.push(`frontmatter line ${index + 1} nests under the scalar "${currentKey}"`);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(fields[currentKey], pair.key)) {
        result.warnings.push(`duplicate frontmatter key "${pair.key}" on line ${index + 1}`);
      }
      fields[currentKey][pair.key] = pair.value;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(fields, pair.key)) {
      result.warnings.push(`duplicate frontmatter key "${pair.key}" on line ${index + 1}`);
    }
    currentKey = pair.key;
    if (pair.value === '') {
      fields[pair.key] = '';
      currentIsMapping = true;
      continue;
    }
    currentIsMapping = false;
    if (isBlockScalarIndicator(pair.value)) {
      result.warnings.push(
        `frontmatter field "${pair.key}" on line ${index + 1} uses an unsupported block scalar; value ignored`,
      );
      fields[pair.key] = '';
      skipBlockScalar = true;
      currentIsMapping = false;
      continue;
    }
    fields[pair.key] = pair.value;
  }

  const rawName = fields.name;
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    result.error = 'missing required frontmatter field "name"';
    return result;
  }
  result.name = rawName.trim();
  if (/\s/.test(result.name)) {
    result.warnings.push(`frontmatter name "${result.name}" contains whitespace`);
  }
  if (typeof fields.description === 'string' && fields.description.trim() !== '') {
    result.description = fields.description.trim();
  } else if (fields.description !== undefined) {
    result.warnings.push('frontmatter field "description" is empty or malformed');
  }
  for (const key of ['when-to-use', 'whenToUse', 'when_to_use']) {
    if (typeof fields[key] === 'string' && fields[key].trim() !== '') {
      if (result.whenToUse !== null) {
        result.warnings.push('frontmatter declares more than one when-to-use field; using the first');
        break;
      }
      result.whenToUse = fields[key].trim();
    }
  }
  if (fields.metadata !== undefined) {
    if (fields.metadata !== null && typeof fields.metadata === 'object' && !Array.isArray(fields.metadata)) {
      /** @type {Record<string, string>} */
      const metadata = {};
      for (const [key, value] of Object.entries(fields.metadata)) {
        if (typeof value === 'string') metadata[key] = value;
      }
      result.metadata = metadata;
    } else {
      result.warnings.push('frontmatter field "metadata" is not a mapping');
    }
  }
  result.ok = true;
  return result;
}

/**
 * Pure helper: turn a skill file's parsed content into a {@link NativeSkill}.
 *
 * @param {object} input
 * @param {string} input.entryName Directory or file base name the entry was found as.
 * @param {string} input.root      Absolute skills root.
 * @param {string} input.filePath  Absolute path to the skill file.
 * @param {string} input.text      Raw file content.
 * @returns {{ skill: NativeSkill | null, warnings: string[] }}
 */
export function parseNativeSkill({ entryName, root, filePath, text }) {
  const parsed = parseSkillFrontmatter(text);
  const warnings = [...parsed.warnings];
  if (!parsed.ok || parsed.name === null) {
    return {
      skill: null,
      warnings: [
        ...warnings,
        `ignored malformed native skill "${entryName}" at "${filePath}": ${parsed.error ?? 'invalid frontmatter'}`,
      ],
    };
  }
  if (parsed.name !== entryName) {
    warnings.push(
      `native skill entry "${entryName}" at "${filePath}" declares frontmatter name "${parsed.name}"`,
    );
  }
  const workflow = workflowForSkillName(parsed.name) ?? workflowForSkillName(entryName);
  return {
    skill: {
      name: parsed.name,
      root,
      path: filePath,
      description: parsed.description ?? '',
      workflow,
    },
    warnings,
  };
}

/**
 * Describe an fs error without assuming a specific error shape.
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error && typeof error === 'object') {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    const message = /** @type {{ message?: unknown }} */ (error).message;
    const text = typeof message === 'string' ? message : String(error);
    return typeof code === 'string' ? `${code}: ${text}` : text;
  }
  return String(error);
}

/**
 * True when the error means "the path does not exist" (a missing skills root is
 * expected, not a warning).
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingPathError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = /** @type {{ code?: unknown }} */ (error).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Classify a directory entry as a skill bundle directory, a flat markdown file
 * or something unsupported. Symlinks are resolved with `stat` so dotfile
 * managers keep working.
 *
 * @param {string} root
 * @param {{ name: string, isDirectory(): boolean, isFile(): boolean, isSymbolicLink(): boolean }} dirent
 * @param {SkillsIo} io
 * @returns {Promise<'directory' | 'file' | 'other'>}
 */
async function classifySkillEntry(root, dirent, io) {
  if (typeof dirent.isDirectory === 'function' && dirent.isDirectory()) return 'directory';
  if (typeof dirent.isFile === 'function' && dirent.isFile()) return 'file';
  if (typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) {
    const stats = await io.stat(path.join(root, dirent.name));
    if (typeof stats.isDirectory === 'function' && stats.isDirectory()) return 'directory';
    if (typeof stats.isFile === 'function' && stats.isFile()) return 'file';
  }
  return 'other';
}

/**
 * Scan one skills root for native `openspec-*` skills.
 *
 * Missing roots return `exists: false` with no warnings; unreadable roots and
 * malformed entries produce warnings and are skipped. The function never
 * writes and never throws for filesystem errors (it reports them instead).
 *
 * @param {string} root Absolute (or resolvable) skills root directory.
 * @param {object} [options]
 * @param {string} [options.label] Human label for the root, used in warnings.
 * @param {string} [options.scope] `project` or `user`.
 * @param {AbortSignal} [options.signal]
 * @param {SkillsIo} [options.io] Injectable filesystem, used by tests.
 * @returns {Promise<ScannedSkillsRoot>}
 */
export async function scanSkillsRoot(root, { label = '', scope = 'unknown', signal, io = DEFAULT_IO } = {}) {
  /** @type {ScannedSkillsRoot} */
  const result = { root, label, scope, exists: false, skills: [], warnings: [] };
  if (signal && signal.aborted) return result;
  let dirents;
  try {
    dirents = await io.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return result;
    result.warnings.push(`cannot read native skills root "${root}": ${describeError(error)}`);
    return result;
  }
  result.exists = true;
  const sorted = [...dirents].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  for (const dirent of sorted) {
    if (signal && signal.aborted) break;
    const entryName = typeof dirent.name === 'string' ? dirent.name : '';
    if (!entryName.startsWith('openspec-')) continue;

    let kind;
    try {
      kind = await classifySkillEntry(root, dirent, io);
    } catch (error) {
      result.warnings.push(
        `cannot inspect native skill entry "${entryName}" under "${root}": ${describeError(error)}`,
      );
      continue;
    }

    let entryBaseName = entryName;
    let filePath;
    if (kind === 'directory') {
      filePath = path.join(root, entryName, SKILL_BUNDLE_FILE);
    } else if (kind === 'file') {
      if (!entryName.endsWith('.md')) {
        result.warnings.push(
          `ignored native skill entry "${entryName}" under "${root}": expected a directory with ` +
            `${SKILL_BUNDLE_FILE} or a flat <name>.md file`,
        );
        continue;
      }
      entryBaseName = entryName.slice(0, -'.md'.length);
      filePath = path.join(root, entryName);
    } else {
      result.warnings.push(
        `ignored native skill entry "${entryName}" under "${root}": not a file or directory`,
      );
      continue;
    }

    let text;
    try {
      text = await io.readFile(filePath, 'utf8');
    } catch (error) {
      result.warnings.push(
        `ignored native skill "${entryBaseName}" under "${root}": cannot read "${filePath}": ` +
          describeError(error),
      );
      continue;
    }
    const parsed = parseNativeSkill({ entryName: entryBaseName, root, filePath, text });
    result.warnings.push(...parsed.warnings);
    if (parsed.skill) result.skills.push(parsed.skill);
  }
  return result;
}

/**
 * Resolve a user skills home from an explicit option, an optional environment
 * variable or a default directory.
 *
 * @param {unknown} explicit
 * @param {string | null} envName
 * @param {string[]} fallbackParts
 * @returns {string} Absolute directory path.
 */
function resolveUserHome(explicit, envName, fallbackParts) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim());
  const fromEnv = envName === null ? undefined : process.env[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.resolve(path.join(homedir(), ...fallbackParts));
}

/**
 * Absolute roots scanned for native OpenSpec skills, in precedence order:
 * project `.dsh/skills`, project `.agents/skills`, `<dshHome>/skills`,
 * `<agentsHome>/skills`.
 *
 * @param {string} cwd Absolute workspace root.
 * @param {{ dshHome?: unknown, agentsHome?: unknown }} [options]
 * @returns {Array<{ root: string, label: string, scope: 'project'|'user' }>}
 */
function resolveSkillRoots(cwd, { dshHome, agentsHome } = {}) {
  const projectRoot = path.resolve(cwd);
  /** @type {Array<{ root: string, label: string, scope: 'project'|'user' }>} */
  const roots = [];
  for (const definition of PROJECT_SKILL_ROOTS) {
    roots.push({
      root: path.join(projectRoot, ...definition.rootParts),
      label: definition.label,
      scope: 'project',
    });
  }
  roots.push({
    root: path.join(resolveUserHome(dshHome, 'DSH_HOME', ['.dsh']), 'skills'),
    label: 'dshHome/skills',
    scope: 'user',
  });
  roots.push({
    root: path.join(resolveUserHome(agentsHome, null, ['.agents']), 'skills'),
    label: 'agentsHome/skills',
    scope: 'user',
  });
  return roots;
}

/**
 * Compare two filesystem roots for deduplication (case-insensitive on Windows).
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameRoot(left, right) {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/**
 * Detect native OpenSpec skills for a workspace.
 *
 * Roots are scanned in precedence order and results are deduplicated by skill
 * name, so the project-local entry wins over a user-level duplicate. Missing
 * roots are expected and silent; unreadable roots and malformed entries become
 * warnings. The function never writes skill files and never throws for
 * filesystem errors.
 *
 * @param {string} cwd Absolute workspace root.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.dshHome] User DSH home (defaults to `DSH_HOME` or `~/.dsh`).
 * @param {string} [options.agentsHome] User agents home (defaults to `~/.agents`).
 * @returns {Promise<NativeSkillsDetection>}
 */
export async function detectNativeSkills(cwd, { signal, dshHome, agentsHome } = {}) {
  /** @type {NativeSkillsDetection} */
  const result = { skills: [], rootsScanned: [], warnings: [] };
  if (signal && signal.aborted) return result;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    result.warnings.push('detectNativeSkills requires a workspace cwd; no native skills detected');
    return result;
  }

  const roots = resolveSkillRoots(cwd, { dshHome, agentsHome });
  /** @type {Array<{ root: string, label: string, scope: 'project'|'user' }>} */
  const scanned = [];
  for (const candidate of roots) {
    if (scanned.some((entry) => sameRoot(entry.root, candidate.root))) continue;
    scanned.push(candidate);
  }

  for (const definition of scanned) {
    if (signal && signal.aborted) break;
    const scan = await scanSkillsRoot(definition.root, {
      label: definition.label,
      scope: definition.scope,
      signal,
    });
    result.rootsScanned.push({
      root: scan.root,
      label: scan.label,
      scope: scan.scope,
      exists: scan.exists,
      skillCount: scan.skills.length,
    });
    result.warnings.push(...scan.warnings);
    for (const skill of scan.skills) {
      if (result.skills.some((existing) => existing.name === skill.name)) continue;
      result.skills.push(skill);
    }
  }
  return result;
}

/**
 * Build a DSH `SkillCandidate` for one adapted vendored skill.
 *
 * The upstream description already states when to use the skill, so it doubles
 * as `whenToUse`. The vendored attribution metadata is forwarded as
 * `candidate.metadata` for the catalog/panel.
 *
 * @param {{ name: string, description: string, metadata: Readonly<Record<string, string>> }} adapted
 * @returns {object}
 */
function toFallbackCandidate(adapted) {
  return {
    name: adapted.name,
    description: adapted.description,
    whenToUse: adapted.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    provider: FALLBACK_PROVIDER_NAME,
    rank: FALLBACK_RANK,
    locator: { name: adapted.name },
    metadata: adapted.metadata,
  };
}

/**
 * Create the workspace-aware fallback skill provider for the DSH skills
 * service (contract §10.3):
 *
 * ```js
 * ctx.get('skills')?.registerProvider(({ invalidate }) => createFallbackProvider(detectNativeSkills))
 * ```
 *
 * `list({ cwd, signal })` returns the twelve adapted vendored OPSX workflow
 * candidates only while no native `openspec-*` skill is detected for `cwd`;
 * `get(candidate)` loads the adapted snapshot definition (`loadAdaptedSkill`).
 * When detection fails the provider returns no candidates (fail closed: a
 * native skill must never be shadowed by a fallback with the same name). A
 * missing or unreadable bundled snapshot also degrades to no candidates, with a
 * message in `provider.warnings`, and never throws or writes.
 *
 * @param {(cwd: string, options?: { signal?: AbortSignal }) => Promise<NativeSkillsDetection>} [detect]
 * @param {{ loadSkill?: (name: string) => Promise<{ name: string, description: string, content: string, metadata: Readonly<Record<string, string>> }> }} [options]
 *   `loadSkill` overrides the adapted-skill loader (test seam; defaults to `loadAdaptedSkill`).
 * @returns {{ name: string, warnings: string[], list(options?: { cwd?: string, signal?: AbortSignal }): Promise<object[]>, get(candidate: { name?: string } | null | undefined, options?: object): Promise<object | undefined> }}
 */
export function createFallbackProvider(detect = detectNativeSkills, { loadSkill = loadAdaptedSkill } = {}) {
  if (typeof detect !== 'function') {
    throw new TypeError('createFallbackProvider(detect) requires a detect function');
  }
  if (typeof loadSkill !== 'function') {
    throw new TypeError('createFallbackProvider(detect, { loadSkill }) requires a loadSkill function');
  }
  const provider = {
    name: FALLBACK_PROVIDER_NAME,

    /** Diagnostics from the most recent `list()` call (empty when healthy). */
    warnings: [],

    /**
     * List the fallback candidates for the workspace being queried.
     * @param {{ cwd?: string, signal?: AbortSignal }} [options]
     * @returns {Promise<object[]>}
     */
    async list(options = {}) {
      provider.warnings.length = 0;
      const cwd = typeof options.cwd === 'string' ? options.cwd : '';
      let detection;
      try {
        detection = await detect(cwd, { signal: options.signal });
      } catch {
        return [];
      }
      const nativeSkills = Array.isArray(detection)
        ? detection
        : detection && Array.isArray(detection.skills)
          ? detection.skills
          : [];
      if (nativeSkills.length > 0) return [];
      if (options.signal && options.signal.aborted) return [];

      const candidates = [];
      /** @type {string[]} */
      const failures = [];
      for (const name of VENDORED_SKILLS) {
        if (options.signal && options.signal.aborted) break;
        try {
          candidates.push(toFallbackCandidate(await loadSkill(name)));
        } catch (error) {
          failures.push(`${name}: ${describeError(error)}`);
        }
      }
      if (candidates.length === 0) {
        const detail = failures.length > 0 ? failures.join('; ') : 'no adapted skill loaded';
        provider.warnings.push(
          `vendored OPSX fallback skills unavailable (bundled snapshot missing or unreadable): ${detail}`,
        );
      } else if (failures.length > 0) {
        provider.warnings.push(`some vendored OPSX fallback skills are unavailable: ${failures.join('; ')}`);
      }
      return candidates;
    },

    /**
     * Return the full adapted definition (body content included) for a listed
     * candidate. Unknown or unavailable names return `undefined`.
     * @param {{ name?: string, whenToUse?: string } | null | undefined} candidate
     * @param {object} [_options]
     * @returns {Promise<object | undefined>}
     */
    async get(candidate, _options = {}) {
      const name = candidate && typeof candidate.name === 'string' ? candidate.name : null;
      if (!name || !VENDORED_SKILLS.includes(name)) return undefined;
      try {
        const adapted = await loadSkill(name);
        return {
          ...candidate,
          description: adapted.description,
          whenToUse:
            typeof candidate.whenToUse === 'string' && candidate.whenToUse !== ''
              ? candidate.whenToUse
              : adapted.description,
          content: adapted.content,
          metadata: adapted.metadata,
        };
      } catch {
        return undefined;
      }
    },
  };
  return provider;
}
