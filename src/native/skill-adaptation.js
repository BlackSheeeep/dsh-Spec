/**
 * Runtime adaptation layer for the vendored OPSX workflow skills.
 *
 * The plugin ships a byte-faithful, LF-normalized snapshot of the twelve
 * upstream `skills/<name>/SKILL.md` files (OpenSpec 1.14.3, Fission-AI/OpenSpec,
 * MIT) under `src/native-snapshot/skills/`. This module turns a raw snapshot
 * into the definition a DSH skill provider can serve:
 *
 * 1. parse the upstream YAML frontmatter with a small tolerant parser;
 * 2. rewrite the frontmatter - keep `name` / `description`, record the vendored
 *    revision (`vendoredFrom`, `upstreamVersion`, `upstreamCommit`, `license`,
 *    `adaptedFor`) and replace the CLI-only `allowed-tools` / `compatibility`
 *    fields with the DSH file-semantics equivalents;
 * 3. insert a fixed `## DSH adaptation` section that maps each `openspec ...`
 *    command used by the workflow onto "read/edit workspace files" or a
 *    `/opsx-*` DSH command;
 * 4. leave the rest of the upstream body byte-for-byte verbatim.
 *
 * Nothing here spawns a process, touches the network or writes a file: only the
 * bundled snapshot is read, and the adaptation is assembled in memory.
 *
 * @module dsh-spec/skill-adaptation
 */

import { readFile } from 'node:fs/promises';

/** Upstream OpenSpec version whose skills are vendored. */
export const UPSTREAM_VERSION = '1.14.3';

/** Upstream OpenSpec commit the vendored skills were extracted from. */
export const UPSTREAM_COMMIT = 'c794978f4f8845ce59693373c9dd882ee776588c';

/** Upstream repository that publishes the skills under the MIT license. */
const UPSTREAM_REPOSITORY = 'Fission-AI/OpenSpec';

/**
 * Exact heading of the injected DSH adaptation section (marker only, the
 * section body comes from {@link adaptationSection}).
 */
export const ADAPTATION_MARKER = '## DSH adaptation';

/**
 * The twelve vendored workflow skills, in contract order (§10.1): the six
 * original core workflows first, then the six extended OPSX workflows. The
 * order is also the fallback catalog order.
 *
 * @type {readonly string[]}
 */
export const VENDORED_SKILLS = Object.freeze([
  'openspec-explore',
  'openspec-propose',
  'openspec-apply-change',
  'openspec-update-change',
  'openspec-sync-specs',
  'openspec-archive-change',
  'openspec-new-change',
  'openspec-continue-change',
  'openspec-ff-change',
  'openspec-verify-change',
  'openspec-bulk-archive-change',
  'openspec-onboard',
]);

/** Fast membership test for {@link VENDORED_SKILLS}. */
const VENDORED_SKILL_SET = new Set(VENDORED_SKILLS);

/**
 * Attribution metadata recorded for every adapted skill (also written into the
 * adapted frontmatter as the `metadata:` block).
 *
 * @type {Readonly<Record<string, string>>}
 */
const VENDORED_METADATA = Object.freeze({
  vendoredFrom: UPSTREAM_REPOSITORY,
  upstreamVersion: UPSTREAM_VERSION,
  upstreamCommit: UPSTREAM_COMMIT,
  license: 'MIT',
  adaptedFor: 'dsh-spec',
});

/** DSH replaces the upstream `Bash(openspec:*)` tool grant with file tools. */
const DSH_ALLOWED_TOOLS = 'Read, Glob, Grep, Edit, Write';

/** `compatibility` replacement: the skill works with file semantics, no CLI. */
const DSH_COMPATIBILITY =
  'DSH file semantics - works by reading and editing openspec/ workspace files; no openspec CLI, subprocess or network access required.';

/**
 * Build the fixed DSH adaptation section inserted between the adapted
 * frontmatter and the verbatim upstream body.
 *
 * The section is English markdown and maps every `openspec` CLI command used by
 * the vendored workflows onto the DSH equivalent (reading/editing workspace
 * files or running a `/opsx-*` command), including the `/openspec-<workflow>` →
 * `/opsx-*` slash-command family. It also states that the CLI is not installed
 * and that store / workspace / initiative features are unavailable. The
 * heading itself is {@link ADAPTATION_MARKER} and is not repeated here.
 *
 * @returns {string} Deterministic adaptation markdown (no heading, no trailing newline).
 */
export function adaptationSection() {
  return [
    'This skill is vendored from the upstream OpenSpec 1.14.3 workflow and adapted for DSH.',
    'In this environment the `openspec` CLI is **not installed** and no subprocess may be',
    'started: treat every `openspec ...` command in the workflow below as an instruction to',
    'read or edit workspace files directly, or to run the equivalent DSH `/opsx-*` command.',
    'Never call the network and never ask the user to install the CLI.',
    '',
    '| Upstream command | DSH file-semantics action |',
    '|---|---|',
    '| `openspec status/list --json` | Read `.openspec.yaml` plus the files under `openspec/changes/**` (or run `/opsx-status`), then derive artifact, task and validation state from those files. |',
    '| `openspec validate` | Run `/opsx-validate` (or apply the same validation contract to the files directly). |',
    '| `openspec instructions <artifact>` | Read `openspec/changes/<name>/<artifact>` and the project `openspec/config.yaml` directly; the bundled schema instructions describe the expected structure. |',
    '| `openspec show` | Read the spec or change file directly. |',
    '| `openspec archive <name> [--yes]` | Run `/opsx-archive <name> --yes` for the deterministic merge and move, or `/opsx-archive <name> --yes --skip-specs` after an AI merge. |',
    '| `openspec new change <name>` | Run `/opsx-propose <name>` or create `openspec/changes/<name>/.openspec.yaml` by hand. |',
    '| `openspec sync specs` | No CLI: edit `openspec/specs/**/spec.md` directly per the sync contract, or run `/opsx-sync --yes`. |',
    '| `openspec update` | Run `/opsx-update`. |',
    '| `openspec instructions archive` | Read the project `openspec/config.yaml` `context` plus `operations.archive.guidance`. |',
    '',
    'DSH exposes the `/opsx-explore`, `/opsx-propose`, `/opsx-apply`, `/opsx-update`, `/opsx-sync`',
    'and `/opsx-archive` slash commands: map an upstream `/openspec-<workflow>` slash command in the',
    'steps below onto the matching `/opsx-*` command. The expanded workflows (new, continue, ff,',
    'verify, bulk-archive, onboard) have no dedicated DSH slash command - perform those steps on the',
    'workspace files as described by this skill.',
    '',
    'Store, workspace and initiative features are unavailable in DSH: treat every workspace',
    'as standalone, ignore `--store <id>`, and scope all work to the current workspace. Where',
    'the workflow below expects JSON fields from a command, derive the same fields by reading',
    'the workspace files instead (`.openspec.yaml`, `openspec/config.yaml`, the change',
    'artifacts, the delta specs and the main specs). The workflow steps, confirmation points',
    'and verification contract below still apply verbatim.',
  ].join('\n');
}

/**
 * Tolerantly unquote one YAML scalar (single or double quoted, plain otherwise).
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
 * Split one `key: value` frontmatter line. Returns `null` for lines that are not
 * simple `key: value` pairs; `value: null` means the key had no scalar (it may
 * introduce a nested mapping).
 *
 * @param {string} line
 * @returns {{ key: string, value: string | null } | null}
 */
function splitFrontmatterKeyValue(line) {
  const colonIndex = line.indexOf(':');
  if (colonIndex <= 0) return null;
  const key = line.slice(0, colonIndex).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) return null;
  let remainder = line.slice(colonIndex + 1).trim();
  if (remainder === '') return { key, value: null };
  if (!remainder.startsWith('"') && !remainder.startsWith("'")) {
    // A ` #` starts a YAML comment in a plain scalar; `#` inside a word does not.
    const commentMatch = remainder.match(/(^|\s)#/);
    if (commentMatch && commentMatch.index > 0) {
      remainder = remainder.slice(0, commentMatch.index).trim();
    }
  }
  if (remainder === '') return { key, value: null };
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
 * Deliberately small and tolerant: it supports comments, quoted scalars,
 * one-level nested mappings (the upstream `metadata:` block) and reports
 * unsupported YAML (block scalars, malformed lines, duplicates) as warnings
 * instead of throwing. The `body` is everything after the closing fence with
 * leading blank lines removed; it is otherwise byte-for-byte unchanged.
 *
 * On a missing or unterminated frontmatter block the result has `data: null`
 * and a descriptive `error` (also mirrored in `warnings`); nothing throws.
 *
 * @param {unknown} text Raw skill file content.
 * @returns {{ data: Record<string, unknown> | null, body: string, warnings: string[], error: string | null }}
 */
export function parseSkillFrontmatter(text) {
  /** @type {{ data: Record<string, unknown> | null, body: string, warnings: string[], error: string | null }} */
  const result = { data: null, body: '', warnings: [], error: null };
  if (typeof text !== 'string') {
    result.error = 'skill content is not a string';
    result.warnings.push(result.error);
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
    result.warnings.push(result.error);
    result.body = content;
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
    result.warnings.push(result.error);
    return result;
  }

  result.body = lines
    .slice(closeIndex + 1)
    .join('\n')
    .replace(/^\n+/, '');

  /** @type {Record<string, unknown>} */
  const data = {};
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
    const pair = splitFrontmatterKeyValue(trimmedLine);
    if (!pair) {
      result.warnings.push(`frontmatter line ${index + 1} is not a key: value pair`);
      continue;
    }
    if (indent > 0) {
      if (!currentKey || !currentIsMapping) {
        result.warnings.push(`frontmatter line ${index + 1} has unexpected indentation`);
        continue;
      }
      if (typeof data[currentKey] === 'string') data[currentKey] = {};
      const nested = data[currentKey];
      if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
        result.warnings.push(`frontmatter line ${index + 1} nests under the scalar "${currentKey}"`);
        continue;
      }
      const mapping = /** @type {Record<string, string>} */ (nested);
      if (Object.prototype.hasOwnProperty.call(mapping, pair.key)) {
        result.warnings.push(`duplicate frontmatter key "${pair.key}" on line ${index + 1}`);
      }
      mapping[pair.key] = pair.value === null ? '' : pair.value;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(data, pair.key)) {
      result.warnings.push(`duplicate frontmatter key "${pair.key}" on line ${index + 1}`);
    }
    currentKey = pair.key;
    if (pair.value === null) {
      data[pair.key] = '';
      currentIsMapping = true;
      continue;
    }
    currentIsMapping = false;
    if (isBlockScalarIndicator(pair.value)) {
      result.warnings.push(
        `frontmatter field "${pair.key}" on line ${index + 1} uses an unsupported block scalar; value ignored`,
      );
      data[pair.key] = '';
      skipBlockScalar = true;
      continue;
    }
    data[pair.key] = pair.value;
  }

  result.data = data;
  return result;
}

/**
 * Serialize a YAML scalar as a plain scalar when safe, else as a JSON-style
 * double-quoted scalar (valid YAML and parseable by the tolerant parser here).
 *
 * @param {string} value
 * @returns {string}
 */
function yamlScalar(value) {
  if (/^[A-Za-z0-9][A-Za-z0-9 .,()/_-]*$/.test(value) && !/[#:]/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * Render the adapted frontmatter block (without the enclosing fences).
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.description
 * @returns {string}
 */
function adaptedFrontmatterBody({ name, description }) {
  return [
    `name: ${name}`,
    `description: ${yamlScalar(description)}`,
    'license: MIT',
    `allowed-tools: ${DSH_ALLOWED_TOOLS}`,
    `compatibility: ${yamlScalar(DSH_COMPATIBILITY)}`,
    'metadata:',
    `  vendoredFrom: ${VENDORED_METADATA.vendoredFrom}`,
    `  upstreamVersion: "${VENDORED_METADATA.upstreamVersion}"`,
    `  upstreamCommit: ${VENDORED_METADATA.upstreamCommit}`,
    `  license: ${VENDORED_METADATA.license}`,
    `  adaptedFor: ${VENDORED_METADATA.adaptedFor}`,
  ].join('\n');
}

/**
 * Adapt one raw vendored `SKILL.md` into a DSH skill definition.
 *
 * The upstream body is kept verbatim; only the frontmatter is rewritten (see the
 * module doc) and the fixed {@link adaptationSection} is inserted between the
 * frontmatter and the body. Throws a descriptive error when the raw text has no
 * usable frontmatter, so a corrupted snapshot fails loudly instead of shipping a
 * skill without a name or description.
 *
 * @param {string} name Expected vendored skill name (one of {@link VENDORED_SKILLS}).
 * @param {string} rawText Raw `SKILL.md` content.
 * @returns {{ name: string, description: string, content: string, metadata: Readonly<Record<string, string>>, warnings: string[] }}
 */
export function adaptSkillContent(name, rawText) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('adaptSkillContent(name, rawText) requires a non-empty skill name');
  }
  if (typeof rawText !== 'string') {
    throw new TypeError('adaptSkillContent(name, rawText) requires the raw skill text');
  }
  const skillName = name.trim();
  const parsed = parseSkillFrontmatter(rawText);
  if (parsed.error !== null || parsed.data === null) {
    throw new Error(`cannot adapt vendored skill "${skillName}": ${parsed.error ?? 'invalid frontmatter'}`);
  }
  const { data } = parsed;
  const declaredName = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (declaredName === '') {
    throw new Error(`cannot adapt vendored skill "${skillName}": frontmatter has no name`);
  }
  if (description === '') {
    throw new Error(`cannot adapt vendored skill "${skillName}": frontmatter has no description`);
  }
  const warnings = [...parsed.warnings];
  if (declaredName !== skillName) {
    warnings.push(
      `vendored skill "${skillName}" declares frontmatter name "${declaredName}"; using the requested name`,
    );
  }
  const content = [
    '---',
    adaptedFrontmatterBody({ name: skillName, description }),
    '---',
    '',
    ADAPTATION_MARKER,
    '',
    adaptationSection(),
    '',
    parsed.body,
  ].join('\n');
  return {
    name: skillName,
    description,
    content,
    metadata: VENDORED_METADATA,
    warnings,
  };
}

/**
 * Read one raw vendored `SKILL.md` from the bundled snapshot (never writes).
 *
 * The snapshot is addressed relative to this module
 * (`../native-snapshot/skills/<name>/SKILL.md`) so both `src/` and the built
 * `lib/` tree resolve the copied bundle. Line endings are normalized to LF so
 * the adapted content is deterministic on every platform.
 *
 * @param {string} name Vendored skill name (one of {@link VENDORED_SKILLS}).
 * @returns {Promise<string>} Raw `SKILL.md` text.
 */
export async function loadVendoredSkill(name) {
  const skillName = typeof name === 'string' ? name.trim() : '';
  if (!VENDORED_SKILL_SET.has(skillName)) {
    throw new Error(`unknown vendored OPSX skill "${String(name)}"`);
  }
  const url = new URL(`../native-snapshot/skills/${skillName}/SKILL.md`, import.meta.url);
  const text = await readFile(url, 'utf8');
  return text.replace(/\r\n/g, '\n');
}

/**
 * Load and adapt one vendored OPSX skill.
 *
 * @param {string} name Vendored skill name (one of {@link VENDORED_SKILLS}).
 * @returns {Promise<{ name: string, description: string, content: string, metadata: Readonly<Record<string, string>>, warnings: string[] }>}
 */
export async function loadAdaptedSkill(name) {
  return adaptSkillContent(name, await loadVendoredSkill(name));
}
