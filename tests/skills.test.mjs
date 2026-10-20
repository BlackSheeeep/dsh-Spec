/**
 * Tests for the phase-2 skills workstream:
 * `src/native/skills.js` (native detection + the 12-workflow fallback provider),
 * `src/native/skill-adaptation.js` (the vendored OPSX adaptation layer) and the
 * bundled `src/native-snapshot/skills/` snapshot.
 *
 * Run: node --test --test-isolation=none tests/skills.test.mjs
 *
 * The sandbox blocks test-process file writes, so these tests never create or
 * change files: the committed snapshot is only read, native-skill filesystem
 * input is injected through the `scanSkillsRoot(root, { io })` seam, and the
 * provider is exercised with injected detection/loader functions where a broken
 * filesystem or snapshot is needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADAPTATION_MARKER,
  UPSTREAM_COMMIT,
  UPSTREAM_VERSION,
  VENDORED_SKILLS,
  adaptSkillContent,
  adaptationSection,
  loadAdaptedSkill,
  loadVendoredSkill,
  parseSkillFrontmatter as parseAdaptedSkillFrontmatter,
} from '../src/native/skill-adaptation.js';
import {
  FALLBACK_PROVIDER_NAME,
  FALLBACK_WORKFLOWS,
  createFallbackProvider,
  detectNativeSkills,
  parseNativeSkill,
  parseSkillFrontmatter,
  scanSkillsRoot,
  workflowForSkillName,
} from '../src/native/skills.js';

/** The twelve vendored upstream skill names, in contract/catalog order. */
const EXPECTED_NAMES = [
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
];

/** Expected workflow suffix for each vendored skill name. */
const EXPECTED_WORKFLOW_BY_NAME = {
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
};

/**
 * One required row of the injected CLI→file-semantics mapping table:
 * the upstream command token and the DSH action token that must appear with it.
 */
const MAPPING_ROWS = [
  { upstream: '`openspec status/list --json`', dsh: '/opsx-status' },
  { upstream: '`openspec validate`', dsh: '/opsx-validate' },
  { upstream: '`openspec instructions <artifact>`', dsh: 'openspec/changes/<name>/<artifact>' },
  { upstream: '`openspec show`', dsh: 'Read the spec or change file directly.' },
  { upstream: '`openspec archive <name> [--yes]`', dsh: '/opsx-archive <name> --yes' },
  { upstream: '`openspec new change <name>`', dsh: '/opsx-propose <name>' },
  { upstream: '`openspec sync specs`', dsh: 'openspec/specs/**/spec.md' },
  { upstream: '`openspec update`', dsh: '/opsx-update' },
  { upstream: '`openspec instructions archive`', dsh: 'operations.archive.guidance' },
];

/** Directory that does not exist and is never created by these tests. */
const MISSING_WORKSPACE = path.join(process.cwd(), 'tests', '__missing_skills_fixture__');

/** Committed snapshot directories used for read-only assertions. */
const SNAPSHOT_DIR = path.join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'native-snapshot');
const SNAPSHOT_SKILLS_DIR = path.join(SNAPSHOT_DIR, 'skills');

const WRITE_METHODS = Object.freeze([
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'rename',
  'copyFile',
  'unlink',
  'rmdir',
  'createWriteStream',
]);

/**
 * Build a valid native skill document.
 * @param {string} name
 * @param {string} description
 * @returns {string}
 */
function skillMarkdown(name, description) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'when-to-use: use it when needed',
    'license: MIT',
    'metadata:',
    '  adaptedFrom: Fission-AI/OpenSpec',
    '  upstreamVersion: "1.14.3"',
    '---',
    '',
    `# ${name} body`,
    '',
    'Read `openspec/config.yaml` first.',
  ].join('\n');
}

/**
 * Minimal `Dirent`-like object for the injected io.
 * @param {string} name
 * @param {'directory'|'file'|'other'|'symlink'} kind
 * @returns {object}
 */
function fakeDirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

/**
 * In-memory filesystem implementing the {@link SkillsIo} shape used by
 * `scanSkillsRoot`. Every write method throws and is recorded, which proves the
 * detection code never mutates skill files.
 *
 * @param {{ dirs?: Record<string, Array<[string, string]>>, files?: Record<string, string>, deniedRoots?: string[] }} [input]
 * @returns {object}
 */
function createFakeIo({ dirs = {}, files = {}, deniedRoots = [] } = {}) {
  const reads = [];
  const writes = [];
  const io = {
    reads,
    writes,
    async readdir(root, options) {
      reads.push({ method: 'readdir', path: root, options });
      if (deniedRoots.includes(root)) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${root}'`), { code: 'EACCES' });
      }
      if (!Object.prototype.hasOwnProperty.call(dirs, root)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${root}'`), { code: 'ENOENT' });
      }
      return dirs[root].map(([name, kind]) => fakeDirent(name, kind));
    },
    async readFile(filePath, encoding) {
      reads.push({ method: 'readFile', path: filePath, encoding });
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: 'ENOENT' });
      }
      return files[filePath];
    },
    async stat(target) {
      reads.push({ method: 'stat', path: target });
      if (Object.prototype.hasOwnProperty.call(dirs, target)) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (Object.prototype.hasOwnProperty.call(files, target)) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), { code: 'ENOENT' });
    },
  };
  for (const method of WRITE_METHODS) {
    io[method] = (...args) => {
      writes.push({ method, args });
      throw new Error(`the skills module must never call io.${method}()`);
    };
  }
  return io;
}

// ---------------------------------------------------------------------------
// Vendored snapshot structure
// ---------------------------------------------------------------------------

test('vendored snapshot contains the twelve upstream OPSX SKILL.md files', async () => {
  assert.equal(VENDORED_SKILLS.length, 12);
  assert.deepEqual([...VENDORED_SKILLS], EXPECTED_NAMES);
  for (const name of EXPECTED_NAMES) {
    const file = path.join(SNAPSHOT_SKILLS_DIR, name, 'SKILL.md');
    assert.equal(existsSync(file), true, `missing vendored skill ${name}`);
    // Normalize CRLF so the assertions hold for a checkout that applies git's
    // autocrlf conversion (the runtime loader normalizes line endings itself).
    const raw = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    assert.ok(raw.startsWith('---\n'), `${name} must start with a YAML frontmatter fence`);
    assert.ok(raw.endsWith('\n'), `${name} must end with a newline`);
    assert.ok(raw.length > 1000, `${name} looks truncated`);
    const parsed = parseAdaptedSkillFrontmatter(raw);
    assert.equal(parsed.error, null);
    assert.equal(parsed.data.name, name);
    assert.ok(typeof parsed.data.description === 'string' && parsed.data.description.length > 0);
  }
});

// ---------------------------------------------------------------------------
// skill-adaptation: parseSkillFrontmatter (upstream format)
// ---------------------------------------------------------------------------

test('adaptation parser reads the upstream frontmatter fields and nested metadata', async () => {
  const raw = await loadVendoredSkill('openspec-apply-change');
  const parsed = parseAdaptedSkillFrontmatter(raw);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.data.name, 'openspec-apply-change');
  assert.match(parsed.data.description, /^Implement tasks from an OpenSpec change\./);
  assert.equal(parsed.data['allowed-tools'], 'Bash(openspec:*)');
  assert.equal(parsed.data.compatibility, 'Requires openspec CLI.');
  assert.equal(parsed.data.license, 'MIT');
  assert.deepEqual(parsed.data.metadata, { author: 'openspec', version: '1.0' });
  assert.ok(parsed.body.startsWith('Implement tasks from an OpenSpec change.'));
  assert.ok(parsed.body.endsWith('\n'));
});

test('adaptation parser tolerates BOM, CRLF, quoted scalars, comments and blank lines', () => {
  const text = [
    '\uFEFF---',
    '# a comment',
    'name: "openspec-explore"',
    "description: 'Use #1 explorer: keep it'",
    'compatibility: "no CLI: file semantics"',
    'metadata:',
    '  author: openspec # trailing comment',
    '  version: "1.0"',
    '---',
    '',
    'body line',
  ].join('\r\n');
  const parsed = parseAdaptedSkillFrontmatter(text);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.data.name, 'openspec-explore');
  assert.equal(parsed.data.description, 'Use #1 explorer: keep it');
  assert.equal(parsed.data.compatibility, 'no CLI: file semantics');
  assert.deepEqual(parsed.data.metadata, { author: 'openspec', version: '1.0' });
  assert.equal(parsed.body, 'body line');
});

test('adaptation parser rejects missing and unterminated frontmatter without throwing', () => {
  const missing = parseAdaptedSkillFrontmatter('# just markdown\nbody');
  assert.equal(missing.data, null);
  assert.match(missing.error, /frontmatter/);
  assert.equal(missing.body, '# just markdown\nbody');

  const unterminated = parseAdaptedSkillFrontmatter('---\nname: openspec-x\ndescription: y\n');
  assert.equal(unterminated.data, null);
  assert.match(unterminated.error, /unterminated/);

  const nonString = parseAdaptedSkillFrontmatter(42);
  assert.equal(nonString.data, null);
  assert.match(nonString.error, /not a string/);
});

test('adaptation parser warns on malformed lines, duplicates and block scalars', () => {
  const malformed = parseAdaptedSkillFrontmatter('---\nname: openspec-x\nthis line is junk\ndescription: ok\n---\nbody');
  assert.equal(malformed.error, null);
  assert.equal(malformed.data.name, 'openspec-x');
  assert.ok(malformed.warnings.some((warning) => /not a key: value pair/.test(warning)));

  const duplicate = parseAdaptedSkillFrontmatter('---\nname: first\nname: second\n---\nbody');
  assert.equal(duplicate.data.name, 'second');
  assert.ok(duplicate.warnings.some((warning) => /duplicate/.test(warning)));

  const blockScalar = parseAdaptedSkillFrontmatter('---\nname: openspec-x\ndescription: |\n  multi\n  line\nwhen-to-use: yes\n---\nbody');
  assert.equal(blockScalar.error, null);
  assert.ok(blockScalar.warnings.some((warning) => /block scalar/.test(warning)));
  assert.equal(blockScalar.data.name, 'openspec-x');
});

// ---------------------------------------------------------------------------
// skill-adaptation: adaptationSection + adaptSkillContent
// ---------------------------------------------------------------------------

test('adaptationSection maps every upstream CLI command onto a DSH action', () => {
  const section = adaptationSection();
  assert.equal(section.includes(ADAPTATION_MARKER), false, 'the marker heading is inserted separately');
  assert.match(section, /\| Upstream command \| DSH file-semantics action \|/);
  for (const { upstream, dsh } of MAPPING_ROWS) {
    assert.ok(section.includes(upstream), `mapping table must mention ${upstream}`);
    assert.ok(section.includes(dsh), `mapping table must point at ${dsh}`);
  }
  assert.match(section, /`openspec` CLI is \*\*not installed\*\*/);
  assert.match(section, /no subprocess/);
  assert.match(section, /[Nn]ever call the network/);
  assert.match(section, /Store, workspace and initiative features are unavailable/);
  // The upstream slash-command family is mapped onto the DSH command family.
  assert.match(section, /\/openspec-<workflow>/);
  for (const command of ['/opsx-explore', '/opsx-propose', '/opsx-apply', '/opsx-update', '/opsx-sync', '/opsx-archive']) {
    assert.ok(section.includes(command), `adaptation section must mention ${command}`);
  }
  assert.match(section, /expanded workflows \(new, continue, ff,\s*verify, bulk-archive, onboard\)/);
});

test('adaptSkillContent rewrites frontmatter, inserts the adaptation section and keeps the body verbatim', async () => {
  for (const name of EXPECTED_NAMES) {
    const raw = await loadVendoredSkill(name);
    const rawParsed = parseAdaptedSkillFrontmatter(raw);
    const adapted = adaptSkillContent(name, raw);

    assert.equal(adapted.name, name);
    assert.equal(adapted.description, rawParsed.data.description);
    assert.deepEqual(adapted.warnings, []);
    assert.deepEqual(adapted.metadata, {
      vendoredFrom: 'Fission-AI/OpenSpec',
      upstreamVersion: '1.14.3',
      upstreamCommit: 'c794978f4f8845ce59693373c9dd882ee776588c',
      license: 'MIT',
      adaptedFor: 'dsh-spec',
    });

    // Adapted frontmatter: vendored attribution + DSH file-semantics wording.
    assert.match(adapted.content, /^---\n/, name);
    assert.match(adapted.content, /^license: MIT$/m, name);
    assert.match(adapted.content, /^allowed-tools: Read, Glob, Grep, Edit, Write$/m, name);
    assert.match(adapted.content, /^compatibility: .*no openspec CLI/m, name);
    assert.match(adapted.content, /^metadata:$/m, name);
    assert.match(adapted.content, /^ {2}vendoredFrom: Fission-AI\/OpenSpec$/m, name);
    assert.match(adapted.content, /^ {2}upstreamVersion: "1\.14\.3"$/m, name);
    assert.ok(adapted.content.includes(`  upstreamCommit: ${UPSTREAM_COMMIT}`), name);
    assert.match(adapted.content, /^ {2}adaptedFor: dsh-spec$/m, name);
    assert.equal(adapted.content.includes('Bash(openspec:*)'), false, name);
    assert.equal(adapted.content.includes('Requires openspec CLI.'), false, name);

    // The adaptation section sits between the frontmatter and the upstream body.
    assert.ok(adapted.content.includes(ADAPTATION_MARKER), name);
    assert.ok(adapted.content.includes(adaptationSection()), name);
    const markerIndex = adapted.content.indexOf(ADAPTATION_MARKER);
    const bodyIndex = adapted.content.indexOf(rawParsed.body);
    assert.ok(markerIndex > 0 && bodyIndex > markerIndex, `${name} section must precede the upstream body`);

    // The upstream body is byte-for-byte verbatim after the inserted section.
    assert.equal(adapted.content.endsWith(`\n${rawParsed.body}`), true, name);

    // The adapted content re-parses with the native-skill parser used by DSH.
    const nativeParsed = parseSkillFrontmatter(adapted.content);
    assert.equal(nativeParsed.ok, true, name);
    assert.equal(nativeParsed.name, name);
    assert.equal(nativeParsed.description, rawParsed.data.description);
    assert.equal(nativeParsed.metadata.vendoredFrom, 'Fission-AI/OpenSpec');
    assert.equal(nativeParsed.metadata.upstreamVersion, '1.14.3');
    assert.equal(nativeParsed.metadata.upstreamCommit, UPSTREAM_COMMIT);
    assert.equal(nativeParsed.metadata.adaptedFor, 'dsh-spec');
  }
});

test('adaptSkillContent escapes YAML-hostile descriptions and keeps them parseable', async () => {
  const raw = [
    '---',
    'name: openspec-explore',
    'description: "Use when: \\"quoted\\" # hash, quoted scalar"',
    'allowed-tools: Bash(openspec:*)',
    'metadata:',
    '  author: openspec',
    '---',
    '',
    'Upstream body stays here.',
    '',
  ].join('\n');
  const adapted = adaptSkillContent('openspec-explore', raw);
  const adaptationParsed = parseAdaptedSkillFrontmatter(adapted.content);
  assert.equal(adaptationParsed.data.description, 'Use when: "quoted" # hash, quoted scalar');
  const nativeParsed = parseSkillFrontmatter(adapted.content);
  assert.equal(nativeParsed.ok, true);
  assert.equal(nativeParsed.description, 'Use when: "quoted" # hash, quoted scalar');
  assert.ok(adapted.content.endsWith('Upstream body stays here.\n'));
});

test('adaptSkillContent fails loudly on malformed snapshot text and warns on a name mismatch', async () => {
  assert.throws(() => adaptSkillContent('openspec-explore', 'no frontmatter here'), /cannot adapt vendored skill/);
  assert.throws(() => adaptSkillContent('', '---\nname: x\n---\nbody'), /non-empty skill name/);
  assert.throws(() => adaptSkillContent('openspec-explore', null), /requires the raw skill text/);
  assert.throws(
    () => adaptSkillContent('openspec-explore', '---\nname: openspec-explore\n---\nbody'),
    /no description/,
  );

  const raw = await loadVendoredSkill('openspec-propose');
  const mismatch = adaptSkillContent('openspec-explore', raw);
  assert.equal(mismatch.name, 'openspec-explore');
  assert.ok(mismatch.warnings.some((warning) => /declares frontmatter name "openspec-propose"/.test(warning)));
});

test('loadVendoredSkill rejects unknown names and normalizes line endings', async () => {
  await assert.rejects(loadVendoredSkill('not-an-openspec-skill'), /unknown vendored OPSX skill/);
  await assert.rejects(loadVendoredSkill('../escape'), /unknown vendored OPSX skill/);
  await assert.rejects(loadVendoredSkill(undefined), /unknown vendored OPSX skill/);
  const raw = await loadVendoredSkill('openspec-onboard');
  assert.equal(raw.includes('\r\n'), false);
  const adapted = await loadAdaptedSkill('openspec-onboard');
  assert.equal(adapted.name, 'openspec-onboard');
  assert.ok(adapted.content.includes(ADAPTATION_MARKER));
});

test('snapshot version and commit constants match the attribution markers', async () => {
  assert.equal(UPSTREAM_VERSION, '1.14.3');
  assert.match(UPSTREAM_COMMIT, /^c794978f4f8845ce59693373c9dd882ee776588c$/);
  const attribution = await readFile(path.join(SNAPSHOT_DIR, 'ATTRIBUTION.md'), 'utf8');
  assert.ok(attribution.includes(`Upstream version: ${UPSTREAM_VERSION}`));
  assert.ok(attribution.includes(`Upstream commit: ${UPSTREAM_COMMIT}`));
  assert.match(attribution, /## Vendored workflow skills/);
});

// ---------------------------------------------------------------------------
// Native skill frontmatter parser (skills.js)
// ---------------------------------------------------------------------------

test('parseSkillFrontmatter parses name, description, when-to-use and nested metadata', () => {
  const text = [
    '---',
    'name: openspec-propose',
    'description: Plan a change end to end',
    'when-to-use: Use when the user wants a plan',
    'license: MIT',
    'metadata:',
    '  adaptedFrom: Fission-AI/OpenSpec',
    '  upstreamVersion: "1.14.3"',
    '  license: MIT',
    '---',
    '',
    '# Body',
    'Read the config.',
    '',
  ].join('\n');
  const parsed = parseSkillFrontmatter(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.error, null);
  assert.equal(parsed.name, 'openspec-propose');
  assert.equal(parsed.description, 'Plan a change end to end');
  assert.equal(parsed.whenToUse, 'Use when the user wants a plan');
  assert.deepEqual(parsed.metadata, {
    adaptedFrom: 'Fission-AI/OpenSpec',
    upstreamVersion: '1.14.3',
    license: 'MIT',
  });
  assert.equal(parsed.fields.license, 'MIT');
  assert.equal(parsed.body.startsWith('# Body'), true);
  assert.deepEqual(parsed.warnings, []);
});

test('parseSkillFrontmatter tolerates BOM, CRLF, quoted scalars and inline comments', () => {
  const text = [
    '\uFEFF---',
    'name: "openspec-explore"',
    "description: 'Use #1 explorer'",
    'when-to-use: explore the code # trailing comment',
    'metadata:',
    '  adaptedFrom: Fission-AI/OpenSpec',
    '---',
    '',
    'body line',
  ].join('\r\n');
  const parsed = parseSkillFrontmatter(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.name, 'openspec-explore');
  assert.equal(parsed.description, 'Use #1 explorer');
  assert.equal(parsed.whenToUse, 'explore the code');
  assert.equal(parsed.metadata.adaptedFrom, 'Fission-AI/OpenSpec');
  assert.equal(parsed.body, 'body line');
});

test('parseSkillFrontmatter rejects missing and unterminated frontmatter', () => {
  const missing = parseSkillFrontmatter('# just markdown\nbody');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /frontmatter/);

  const unterminated = parseSkillFrontmatter('---\nname: openspec-x\ndescription: y\n');
  assert.equal(unterminated.ok, false);
  assert.match(unterminated.error, /unterminated/);

  const nonString = parseSkillFrontmatter(42);
  assert.equal(nonString.ok, false);
  assert.match(nonString.error, /not a string/);
});

test('parseSkillFrontmatter rejects a frontmatter block without a name', () => {
  const parsed = parseSkillFrontmatter('---\ndescription: no name here\n---\nbody');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /name/);
});

test('parseSkillFrontmatter warns on malformed lines, duplicates and block scalars without throwing', () => {
  const malformed = parseSkillFrontmatter(
    '---\nname: openspec-x\nthis line is junk\ndescription: ok\n---\nbody',
  );
  assert.equal(malformed.ok, true);
  assert.equal(malformed.name, 'openspec-x');
  assert.equal(malformed.warnings.length, 1);
  assert.match(malformed.warnings[0], /not a key: value pair/);

  const duplicate = parseSkillFrontmatter('---\nname: first\nname: second\n---\nbody');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.name, 'second');
  assert.ok(duplicate.warnings.some((warning) => /duplicate/.test(warning)));

  const blockScalar = parseSkillFrontmatter(
    '---\nname: openspec-x\ndescription: |\n  multi\n  line\nwhen-to-use: yes\n---\nbody',
  );
  assert.equal(blockScalar.ok, true);
  assert.equal(blockScalar.name, 'openspec-x');
  assert.equal(blockScalar.description, null);
  assert.equal(blockScalar.whenToUse, 'yes');
  assert.ok(blockScalar.warnings.some((warning) => /block scalar/.test(warning)));
});

// ---------------------------------------------------------------------------
// workflow naming
// ---------------------------------------------------------------------------

test('workflowForSkillName maps all twelve vendored names and extended native names', () => {
  assert.deepEqual([...VENDORED_SKILLS], EXPECTED_NAMES);
  assert.deepEqual(
    [...VENDORED_SKILLS].map((name) => workflowForSkillName(name)),
    [...FALLBACK_WORKFLOWS],
  );
  assert.deepEqual(FALLBACK_WORKFLOWS, [
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
  for (const [name, workflow] of Object.entries(EXPECTED_WORKFLOW_BY_NAME)) {
    assert.equal(workflowForSkillName(name), workflow, name);
  }
  assert.equal(workflowForSkillName('openspec-custom-thing'), 'custom-thing');
  assert.equal(workflowForSkillName('openspec-'), null);
  assert.equal(workflowForSkillName('some-other-skill'), null);
  assert.equal(workflowForSkillName(''), null);
  assert.equal(workflowForSkillName(undefined), null);
});

// ---------------------------------------------------------------------------
// parseNativeSkill (pure)
// ---------------------------------------------------------------------------

test('parseNativeSkill builds a native skill record for a valid bundle', () => {
  const result = parseNativeSkill({
    entryName: 'openspec-propose',
    root: path.join('workspace', '.dsh', 'skills'),
    filePath: path.join('workspace', '.dsh', 'skills', 'openspec-propose', 'SKILL.md'),
    text: skillMarkdown('openspec-propose', 'Plan a change'),
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.skill.name, 'openspec-propose');
  assert.equal(result.skill.description, 'Plan a change');
  assert.equal(result.skill.workflow, 'propose');
  assert.equal(result.skill.root, path.join('workspace', '.dsh', 'skills'));
  assert.equal(
    result.skill.path,
    path.join('workspace', '.dsh', 'skills', 'openspec-propose', 'SKILL.md'),
  );
});

test('parseNativeSkill skips malformed entries and warns', () => {
  const result = parseNativeSkill({
    entryName: 'openspec-broken',
    root: 'root',
    filePath: 'root/openspec-broken/SKILL.md',
    text: 'plain text without frontmatter',
  });
  assert.equal(result.skill, null);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /malformed native skill "openspec-broken"/);

  const sharedKeys = parseNativeSkill({
    entryName: 'openspec-propose',
    root: 'root',
    filePath: 'root/openspec-propose/SKILL.md',
    text: '---\nname: openspec-propose\n---\nbody',
  });
  assert.equal(sharedKeys.skill.description, '');
  assert.equal(sharedKeys.skill.workflow, 'propose');
});

test('parseNativeSkill warns when the frontmatter name disagrees with the entry name', () => {
  const result = parseNativeSkill({
    entryName: 'openspec-plan',
    root: 'root',
    filePath: 'root/openspec-plan/SKILL.md',
    text: skillMarkdown('openspec-propose', 'Plan a change'),
  });
  assert.equal(result.skill.name, 'openspec-propose');
  assert.equal(result.skill.workflow, 'propose');
  assert.ok(result.warnings.some((warning) => /declares frontmatter name/.test(warning)));
});

// ---------------------------------------------------------------------------
// scanSkillsRoot with injected io (positive detection without real files)
// ---------------------------------------------------------------------------

test('scanSkillsRoot finds directory bundles and flat files, skips malformed entries and never writes', async () => {
  const root = path.join('virtual-workspace', '.dsh', 'skills');
  const files = {
    [path.join(root, 'openspec-propose', 'SKILL.md')]: skillMarkdown('openspec-propose', 'plan a change'),
    [path.join(root, 'openspec-explore.md')]: skillMarkdown('openspec-explore', 'think first'),
    [path.join(root, 'openspec-link', 'SKILL.md')]: skillMarkdown('openspec-archive-change', 'archive it'),
    [path.join(root, 'openspec-bad', 'SKILL.md')]: 'no frontmatter here',
  };
  const dirs = {
    [root]: [
      ['README.md', 'file'],
      ['some-other-skill', 'directory'],
      ['openspec-propose', 'directory'],
      ['openspec-explore.md', 'file'],
      ['openspec-link', 'symlink'],
      ['openspec-notes.txt', 'file'],
      ['openspec-missing', 'directory'],
      ['openspec-bad', 'directory'],
      ['openspec-junk-link', 'symlink'],
    ],
    [path.join(root, 'openspec-propose')]: [],
    [path.join(root, 'openspec-missing')]: [],
    [path.join(root, 'openspec-bad')]: [],
    [path.join(root, 'openspec-link')]: [],
  };
  const io = createFakeIo({ dirs, files });

  const scan = await scanSkillsRoot(root, { label: '.dsh/skills', scope: 'project', io });

  assert.equal(scan.exists, true);
  assert.equal(scan.root, root);
  assert.equal(scan.label, '.dsh/skills');
  assert.equal(scan.scope, 'project');
  assert.deepEqual(
    scan.skills.map((skill) => skill.name),
    ['openspec-explore', 'openspec-archive-change', 'openspec-propose'],
  );
  assert.equal(scan.skills[0].workflow, 'explore');
  assert.equal(scan.skills[1].workflow, 'archive');
  assert.equal(scan.skills[2].workflow, 'propose');

  assert.equal(scan.warnings.length, 5);
  assert.ok(scan.warnings.some((warning) => /openspec-bad/.test(warning) && /malformed/.test(warning)));
  assert.ok(scan.warnings.some((warning) => /openspec-missing/.test(warning) && /SKILL\.md/.test(warning)));
  assert.ok(scan.warnings.some((warning) => /openspec-notes\.txt/.test(warning)));
  assert.ok(scan.warnings.some((warning) => /openspec-junk-link/.test(warning)));
  // The symlinked bundle declares a different frontmatter name than its entry,
  // which is reported but still detected under the declared name.
  assert.ok(scan.warnings.some((warning) => /openspec-link/.test(warning) && /declares frontmatter name/.test(warning)));

  // The module never mutates the skills it detects.
  assert.deepEqual(io.writes, []);
  assert.ok(scan.skills.every((skill) => skill.path.startsWith(root)));
});

test('scanSkillsRoot tolerates missing and unreadable roots', async () => {
  const missing = await scanSkillsRoot(path.join('virtual', 'absent'), {
    io: createFakeIo({}),
  });
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.skills, []);
  assert.deepEqual(missing.warnings, []);

  const deniedRoot = path.join('virtual', 'denied');
  const denied = await scanSkillsRoot(deniedRoot, { io: createFakeIo({ deniedRoots: [deniedRoot] }) });
  assert.equal(denied.exists, false);
  assert.equal(denied.warnings.length, 1);
  assert.match(denied.warnings[0], /cannot read native skills root/);
});

test('scanSkillsRoot honours an already-aborted signal without touching the filesystem', async () => {
  const io = createFakeIo({});
  const scan = await scanSkillsRoot(path.join('virtual', 'skills'), {
    signal: AbortSignal.abort(),
    io,
  });
  assert.equal(scan.exists, false);
  assert.deepEqual(scan.skills, []);
  assert.equal(io.reads.length, 0);
  assert.equal(io.writes.length, 0);
});

test('scanSkillsRoot reports an empty but existing root without warnings', async () => {
  const root = path.join('virtual', 'empty-skills');
  const io = createFakeIo({ dirs: { [root]: [['README.md', 'file'], ['other', 'directory']] } });
  const scan = await scanSkillsRoot(root, { io });
  assert.equal(scan.exists, true);
  assert.deepEqual(scan.skills, []);
  assert.deepEqual(scan.warnings, []);
});

// ---------------------------------------------------------------------------
// detectNativeSkills against the real filesystem (non-existent roots only)
// ---------------------------------------------------------------------------

test('detectNativeSkills returns the four roots in precedence order for a native-free workspace', async () => {
  const cwd = MISSING_WORKSPACE;
  const dshHome = path.join(cwd, 'fake-dsh-home');
  const agentsHome = path.join(cwd, 'fake-agents-home');
  const detection = await detectNativeSkills(cwd, { dshHome, agentsHome });

  assert.deepEqual(detection.skills, []);
  assert.deepEqual(detection.warnings, []);
  assert.deepEqual(
    detection.rootsScanned.map((entry) => entry.root),
    [
      path.join(cwd, '.dsh', 'skills'),
      path.join(cwd, '.agents', 'skills'),
      path.join(dshHome, 'skills'),
      path.join(agentsHome, 'skills'),
    ],
  );
  assert.deepEqual(
    detection.rootsScanned.map((entry) => entry.scope),
    ['project', 'project', 'user', 'user'],
  );
  assert.deepEqual(
    detection.rootsScanned.map((entry) => entry.exists),
    [false, false, false, false],
  );
  assert.deepEqual(
    detection.rootsScanned.map((entry) => entry.skillCount),
    [0, 0, 0, 0],
  );
});

test('detectNativeSkills defaults the user DSH home from DSH_HOME', async () => {
  const cwd = MISSING_WORKSPACE;
  const envHome = path.join(cwd, 'env-dsh-home');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = envHome;
  try {
    const detection = await detectNativeSkills(cwd, {
      agentsHome: path.join(cwd, 'fake-agents-home'),
    });
    assert.equal(detection.rootsScanned[2].root, path.join(envHome, 'skills'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('detectNativeSkills does not scan the same actual root twice', async () => {
  const cwd = MISSING_WORKSPACE;
  const detection = await detectNativeSkills(cwd, {
    dshHome: path.join(cwd, '.dsh'),
    agentsHome: path.join(cwd, 'fake-agents-home'),
  });
  assert.deepEqual(
    detection.rootsScanned.map((entry) => entry.root),
    [
      path.join(cwd, '.dsh', 'skills'),
      path.join(cwd, '.agents', 'skills'),
      path.join(cwd, 'fake-agents-home', 'skills'),
    ],
  );
});

test('detectNativeSkills short-circuits on an aborted signal and invalid cwd', async () => {
  const aborted = await detectNativeSkills(MISSING_WORKSPACE, {
    signal: AbortSignal.abort(),
    dshHome: path.join(MISSING_WORKSPACE, 'dsh-home'),
    agentsHome: path.join(MISSING_WORKSPACE, 'agents-home'),
  });
  assert.deepEqual(aborted, { skills: [], rootsScanned: [], warnings: [] });

  const invalid = await detectNativeSkills(undefined);
  assert.deepEqual(invalid.skills, []);
  assert.deepEqual(invalid.rootsScanned, []);
  assert.equal(invalid.warnings.length, 1);
  assert.match(invalid.warnings[0], /cwd/);
});

// ---------------------------------------------------------------------------
// createFallbackProvider: twelve adapted vendored candidates
// ---------------------------------------------------------------------------

/** Detection result used for "no native skills". */
const NO_NATIVE = { skills: [], rootsScanned: [], warnings: [] };

test('createFallbackProvider lists the twelve adapted OPSX candidates in contract order', async () => {
  const detectCalls = [];
  const provider = createFallbackProvider(async (cwd, options) => {
    detectCalls.push({ cwd, options });
    return NO_NATIVE;
  });
  const controller = new AbortController();
  const candidates = await provider.list({ cwd: 'C:/work/project', signal: controller.signal });

  assert.equal(provider.name, FALLBACK_PROVIDER_NAME);
  assert.equal(provider.name, 'openspec-native-fallback');
  assert.deepEqual(provider.warnings, []);
  assert.equal(detectCalls.length, 1);
  assert.equal(detectCalls[0].cwd, 'C:/work/project');
  assert.equal(detectCalls[0].options.signal, controller.signal);
  assert.equal(candidates.length, 12);
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    EXPECTED_NAMES,
  );
  for (const candidate of candidates) {
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(candidate.source, 'runtime');
    assert.equal(candidate.provider, 'openspec-native-fallback');
    assert.equal(candidate.rank, 100);
    assert.deepEqual(candidate.locator, { name: candidate.name });
    assert.ok(candidate.description.length > 0);
    assert.equal(candidate.whenToUse, candidate.description);
    assert.equal(candidate.metadata.vendoredFrom, 'Fission-AI/OpenSpec');
    assert.equal(candidate.metadata.upstreamVersion, '1.14.3');
    assert.equal(candidate.metadata.upstreamCommit, 'c794978f4f8845ce59693373c9dd882ee776588c');
    assert.equal(candidate.metadata.license, 'MIT');
    assert.equal(candidate.metadata.adaptedFor, 'dsh-spec');
    assert.equal(workflowForSkillName(candidate.name) !== null, true);
  }
});

test('createFallbackProvider.get returns the full adapted SKILL.md definition for each candidate', async () => {
  const provider = createFallbackProvider(async () => NO_NATIVE);
  const candidates = await provider.list({ cwd: 'C:/work' });
  for (const candidate of candidates) {
    const definition = await provider.get(candidate, { cwd: 'C:/work' });
    const adapted = await loadAdaptedSkill(candidate.name);
    assert.equal(definition.name, candidate.name);
    assert.equal(definition.description, candidate.description);
    assert.equal(definition.whenToUse, candidate.whenToUse);
    assert.equal(definition.content, adapted.content);
    assert.equal(definition.content.includes(ADAPTATION_MARKER), true);
    assert.ok(definition.content.includes(adaptationSection()));
    assert.deepEqual(definition.metadata, adapted.metadata);
    assert.deepEqual(definition.invocation, candidate.invocation);
    assert.deepEqual(definition.locator, candidate.locator);
    assert.equal(definition.provider, 'openspec-native-fallback');

    const parsed = parseSkillFrontmatter(definition.content);
    assert.equal(parsed.ok, true, `${candidate.name} adapted frontmatter must parse`);
    assert.equal(parsed.name, candidate.name);
    assert.equal(parsed.metadata.vendoredFrom, 'Fission-AI/OpenSpec');
    assert.equal(parsed.metadata.upstreamVersion, '1.14.3');
    assert.equal(parsed.metadata.upstreamCommit, 'c794978f4f8845ce59693373c9dd882ee776588c');
    assert.equal(parsed.metadata.license, 'MIT');
    assert.equal(parsed.metadata.adaptedFor, 'dsh-spec');
    assert.doesNotMatch(definition.content, /Bash\(openspec/i);
    assert.doesNotMatch(definition.content, /Requires openspec CLI/);
  }

  assert.equal(await provider.get({ name: 'openspec-unknown' }), undefined);
  assert.equal(await provider.get({}), undefined);
  assert.equal(await provider.get(null), undefined);
  assert.equal(await provider.get(undefined), undefined);
});

test('a detected native openspec skill suppresses all twelve fallback candidates', async () => {
  const nativeSkill = {
    name: 'openspec-propose',
    root: 'C:/work/project/.dsh/skills',
    path: 'C:/work/project/.dsh/skills/openspec-propose/SKILL.md',
    description: 'native propose',
    workflow: 'propose',
  };
  const provider = createFallbackProvider(async () => ({
    skills: [nativeSkill],
    rootsScanned: [],
    warnings: [],
  }));
  assert.deepEqual(await provider.list({ cwd: 'C:/work/project' }), []);

  // Contract: any native openspec-* skill suppresses the whole fallback
  // catalog, not only skills that share a fallback name.
  const extendedProvider = createFallbackProvider(async () => ({
    skills: [{ ...nativeSkill, name: 'openspec-verify-change', workflow: 'verify-change' }],
    rootsScanned: [],
    warnings: [],
  }));
  assert.deepEqual(await extendedProvider.list({ cwd: 'C:/work/project' }), []);
});

test('fallback candidates disappear when a native skill appears on a later refresh', async () => {
  let nativeSkills = [];
  const provider = createFallbackProvider(async () => ({ skills: nativeSkills, rootsScanned: [], warnings: [] }));
  assert.equal((await provider.list({ cwd: 'C:/work' })).length, 12);
  nativeSkills = [
    {
      name: 'openspec-apply-change',
      root: 'C:/work/.agents/skills',
      path: 'C:/work/.agents/skills/openspec-apply-change/SKILL.md',
      description: 'native apply',
      workflow: 'apply',
    },
  ];
  assert.deepEqual(await provider.list({ cwd: 'C:/work' }), []);
  nativeSkills = [];
  assert.equal((await provider.list({ cwd: 'C:/work' })).length, 12);
});

test('createFallbackProvider fails closed when detection throws; tolerant of array/undefined results', async () => {
  const throwing = createFallbackProvider(async () => {
    throw new Error('detection exploded');
  });
  assert.deepEqual(await throwing.list({ cwd: 'C:/work' }), []);

  const arrayDetect = createFallbackProvider(async () => []);
  assert.equal((await arrayDetect.list({ cwd: 'C:/work' })).length, 12);

  const emptyDetect = createFallbackProvider(async () => undefined);
  assert.equal((await emptyDetect.list({ cwd: 'C:/work' })).length, 12);

  assert.throws(() => createFallbackProvider('not a function'), TypeError);
  assert.throws(() => createFallbackProvider(async () => NO_NATIVE, { loadSkill: 'nope' }), TypeError);
});

test('provider honours an aborted signal without loading the snapshot', async () => {
  const loaded = [];
  const provider = createFallbackProvider(async () => NO_NATIVE, {
    loadSkill: async (name) => {
      loaded.push(name);
      return { name, description: 'x', content: '', metadata: {} };
    },
  });
  assert.deepEqual(await provider.list({ cwd: 'C:/work', signal: AbortSignal.abort() }), []);
  assert.deepEqual(loaded, []);
});

test('a missing snapshot directory degrades to no candidates with a warning, never throws', async () => {
  const provider = createFallbackProvider(async () => NO_NATIVE, {
    loadSkill: async (name) => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open 'skills/${name}/SKILL.md'`), {
        code: 'ENOENT',
      });
    },
  });
  const candidates = await provider.list({ cwd: 'C:/work' });
  assert.deepEqual(candidates, []);
  assert.equal(provider.warnings.length, 1);
  assert.match(provider.warnings[0], /vendored OPSX fallback skills unavailable/);
  assert.match(provider.warnings[0], /bundled snapshot missing or unreadable/);
  assert.match(provider.warnings[0], /ENOENT/);

  assert.equal(await provider.get({ name: 'openspec-explore' }), undefined);

  // A later healthy refresh clears the warning and returns the catalog again.
  const healthy = createFallbackProvider(async () => NO_NATIVE, {
    loadSkill: async (name) => ({ name, description: 'ok', content: 'body', metadata: {} }),
  });
  assert.equal((await healthy.list({ cwd: 'C:/work' })).length, 12);
  assert.deepEqual(healthy.warnings, []);
});

test('a partially unreadable snapshot skips the broken skill and warns', async () => {
  const provider = createFallbackProvider(async () => NO_NATIVE, {
    loadSkill: async (name) => {
      if (name === 'openspec-onboard') throw new Error('snapshot entry is corrupt');
      return {
        name,
        description: `description of ${name}`,
        content: `---\nname: ${name}\n---\nbody`,
        metadata: { vendoredFrom: 'Fission-AI/OpenSpec' },
      };
    },
  });
  const candidates = await provider.list({ cwd: 'C:/work' });
  assert.equal(candidates.length, 11);
  assert.equal(candidates.some((candidate) => candidate.name === 'openspec-onboard'), false);
  assert.equal(provider.warnings.length, 1);
  assert.match(provider.warnings[0], /some vendored OPSX fallback skills are unavailable/);
  assert.match(provider.warnings[0], /openspec-onboard: snapshot entry is corrupt/);
});

// ---------------------------------------------------------------------------
// No-mutation guard: source and behaviour
// ---------------------------------------------------------------------------

test('skills modules only import read operations and contain no write API calls', async () => {
  const skillsSource = await readFile(new URL('../src/native/skills.js', import.meta.url), 'utf8');
  const adaptationSource = await readFile(new URL('../src/native/skill-adaptation.js', import.meta.url), 'utf8');
  for (const [label, source] of [
    ['skills.js', skillsSource],
    ['skill-adaptation.js', adaptationSource],
  ]) {
    assert.doesNotMatch(
      source,
      /\b(?:writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync|renameSync|copyFile|copyFileSync|rmdir|truncate)\b/,
      `${label} must not contain filesystem write calls`,
    );
    assert.doesNotMatch(source, /child_process|execSync|spawnSync|fetch\(/, label);
  }
  assert.doesNotMatch(skillsSource, /skills-fallback\.js/, 'the superseded six-skill module must not be imported');
  const fsImport = skillsSource.match(/import\s*\{([^}]+)\}\s*from\s*'node:fs\/promises'/);
  assert.ok(fsImport, 'skills.js imports node:fs/promises');
  assert.deepEqual(
    fsImport[1]
      .split(',')
      .map((part) => part.trim())
      .sort(),
    ['readFile', 'readdir', 'stat'],
  );
  const adaptationFsImport = adaptationSource.match(/import\s*\{([^}]+)\}\s*from\s*'node:fs\/promises'/);
  assert.ok(adaptationFsImport, 'skill-adaptation.js imports node:fs/promises');
  assert.deepEqual(
    adaptationFsImport[1]
      .split(',')
      .map((part) => part.trim())
      .sort(),
    ['readFile'],
  );
});
