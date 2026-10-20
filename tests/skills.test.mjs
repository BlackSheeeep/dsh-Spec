/**
 * Tests for the native OpenSpec skills coexistence workstream:
 * `src/native/skills.js` (detection + fallback provider) and
 * `src/native/skills-fallback.js` (the six file-based fallback skills).
 *
 * Run: node --test --test-isolation=none tests/skills.test.mjs
 *
 * The sandbox blocks test-process file writes, so these tests never create
 * fixture files: filesystem input is injected through the exported
 * `scanSkillsRoot(root, { io })` seam, parsing is exercised on in-memory
 * strings, and `detectNativeSkills` is exercised against non-existent roots and
 * explicit `dshHome` / `agentsHome` paths (never the real user skills roots).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FALLBACK_PROVIDER_NAME,
  FALLBACK_SKILLS,
  FALLBACK_WORKFLOWS,
  createFallbackProvider,
  detectNativeSkills,
  parseNativeSkill,
  parseSkillFrontmatter,
  scanSkillsRoot,
  workflowForSkillName,
} from '../src/native/skills.js';

const EXPECTED_NAMES = [
  'openspec-explore',
  'openspec-propose',
  'openspec-apply-change',
  'openspec-update-change',
  'openspec-sync-specs',
  'openspec-archive-change',
];

const EXPECTED_COMMAND_BY_WORKFLOW = {
  explore: '/opsx-explore',
  propose: '/opsx-propose',
  apply: '/opsx-apply',
  update: '/opsx-update',
  sync: '/opsx-sync',
  archive: '/opsx-archive',
};

/** Directory that does not exist and is never created by these tests. */
const MISSING_WORKSPACE = path.join(process.cwd(), 'tests', '__missing_skills_fixture__');

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
 * Build a valid skill document.
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
// parseSkillFrontmatter (pure)
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
  assert.equal(parsed.body.includes('Read the config.'), true);
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

test('parseSkillFrontmatter excludes leading blank lines from the body but keeps content intact', () => {
  const parsed = parseSkillFrontmatter('---\nname: openspec-x\n---\n\n\n# Title\n\ntext\n');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.body.startsWith('# Title'), true);
  assert.equal(parsed.body.endsWith('text\n'), true);
});

// ---------------------------------------------------------------------------
// workflow naming
// ---------------------------------------------------------------------------

test('workflowForSkillName maps the six core names and extended native names', () => {
  assert.deepEqual(
    EXPECTED_NAMES.map((name) => workflowForSkillName(name)),
    FALLBACK_WORKFLOWS,
  );
  assert.equal(workflowForSkillName('openspec-verify-change'), 'verify-change');
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

test('detectNativeSkills reads repo-local native skills when fixtures are present', async (t) => {
  const repoRoot = process.cwd();
  const projectRoots = [
    path.join(repoRoot, '.dsh', 'skills'),
    path.join(repoRoot, '.agents', 'skills'),
  ];
  if (!projectRoots.some((root) => existsSync(root))) {
    t.skip('repo has no .dsh/skills or .agents/skills fixtures');
    return;
  }
  const detection = await detectNativeSkills(repoRoot, {
    dshHome: path.join(repoRoot, 'tests', '__missing_skills_fixture__', 'dsh-home'),
    agentsHome: path.join(repoRoot, 'tests', '__missing_skills_fixture__', 'agents-home'),
  });
  assert.equal(detection.rootsScanned[0].exists || detection.rootsScanned[1].exists, true);
  for (const skill of detection.skills) {
    assert.ok(skill.name.startsWith('openspec-'), skill.name);
    assert.ok(skill.path.endsWith('SKILL.md') || skill.path.endsWith('.md'), skill.path);
    assert.equal(workflowForSkillName(skill.name) !== null, true);
  }
});

// ---------------------------------------------------------------------------
// Fallback catalog content
// ---------------------------------------------------------------------------

test('fallback catalog exposes the six core workflows in contract order', () => {
  assert.equal(FALLBACK_SKILLS.length, 6);
  assert.deepEqual(
    FALLBACK_SKILLS.map((skill) => skill.name),
    EXPECTED_NAMES,
  );
  assert.deepEqual(
    FALLBACK_SKILLS.map((skill) => skill.workflow),
    FALLBACK_WORKFLOWS,
  );
  for (const skill of FALLBACK_SKILLS) {
    assert.equal(typeof skill.description, 'string');
    assert.ok(skill.description.length > 0);
    assert.equal(typeof skill.whenToUse, 'string');
    assert.ok(skill.whenToUse.length > 0);
  }
});

test('fallback frontmatter records adaptation source, upstream version and MIT license', () => {
  for (const skill of FALLBACK_SKILLS) {
    assert.deepEqual(skill.metadata.adaptedFrom, 'Fission-AI/OpenSpec');
    assert.equal(skill.metadata.upstreamVersion, '1.14.3');
    assert.equal(skill.metadata.license, 'MIT');
    assert.equal(skill.metadata.workflow, skill.workflow);
    assert.match(skill.metadata.upstreamPath, /^skills\/openspec-[a-z-]+\/SKILL\.md$/);

    assert.match(skill.content, /^---\n/, skill.name);
    assert.match(skill.content, /adaptedFrom: Fission-AI\/OpenSpec/, skill.name);
    assert.match(skill.content, /upstreamVersion: "1\.14\.3"/, skill.name);
    assert.match(skill.content, /license: MIT/, skill.name);

    const parsed = parseSkillFrontmatter(skill.content);
    assert.equal(parsed.ok, true, skill.name);
    assert.equal(parsed.name, skill.name);
    assert.equal(parsed.description, skill.description);
    assert.equal(parsed.whenToUse, skill.whenToUse);
    assert.equal(parsed.metadata.adaptedFrom, 'Fission-AI/OpenSpec');
    assert.equal(parsed.metadata.upstreamVersion, '1.14.3');
    assert.equal(parsed.metadata.license, 'MIT');
  }
});

test('fallback bodies are file-based, use DSH commands and never invoke an external command', () => {
  for (const skill of FALLBACK_SKILLS) {
    const { content, name, workflow } = skill;
    assert.equal(content.startsWith('---\n'), true, name);
    assert.equal(content.endsWith('\n'), true, name);
    for (const section of ['## Goal', '## Read first', '## Steps', '## Boundaries', '## Done criteria']) {
      assert.ok(content.includes(section), `${name} must document ${section}`);
    }
    // File-based semantics: the OpenSpec root and change metadata are the inputs.
    assert.ok(content.includes('openspec/'), `${name} must reference the openspec/ tree`);
    assert.ok(content.includes('.openspec.yaml'), `${name} must reference change metadata`);
    // The DSH command for this workflow is named as the preferred entry point.
    assert.ok(
      content.includes(EXPECTED_COMMAND_BY_WORKFLOW[workflow]),
      `${name} must reference ${EXPECTED_COMMAND_BY_WORKFLOW[workflow]}`,
    );
    // No command-line invocations: the lowercase CLI name followed by an
    // argument is exactly what such an invocation would look like.
    assert.doesNotMatch(content, /\bopenspec\s+\S/, name);
    assert.doesNotMatch(
      content,
      /\bopenspec\s+(?:validate|archive|show|list|instructions|status|init|context|new|schemas|doctor|view|sync|update)\b/i,
      name,
    );
    assert.doesNotMatch(content, /Bash\(openspec/i, name);
    assert.doesNotMatch(content, /allowed-tools:/i, name);
  }
});

// ---------------------------------------------------------------------------
// createFallbackProvider
// ---------------------------------------------------------------------------

test('createFallbackProvider lists six well-shaped candidates when detection finds no native skill', async () => {
  const detectCalls = [];
  const provider = createFallbackProvider(async (cwd, options) => {
    detectCalls.push({ cwd, options });
    return { skills: [], rootsScanned: [], warnings: [] };
  });
  const controller = new AbortController();
  const candidates = await provider.list({ cwd: 'C:/work/project', signal: controller.signal });

  assert.equal(provider.name, FALLBACK_PROVIDER_NAME);
  assert.equal(provider.name, 'openspec-native-fallback');
  assert.equal(detectCalls.length, 1);
  assert.equal(detectCalls[0].cwd, 'C:/work/project');
  assert.equal(detectCalls[0].options.signal, controller.signal);
  assert.equal(candidates.length, 6);
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
    assert.ok(candidate.whenToUse.length > 0);
    assert.equal(typeof candidate.name, 'string');
  }
});

test('a detected native openspec skill suppresses all fallback candidates', async () => {
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

  // Contract: any native openspec-* skill suppresses the fallback catalog, not
  // only skills with a fallback name.
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
  assert.equal((await provider.list({ cwd: 'C:/work' })).length, 6);
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
  assert.equal((await provider.list({ cwd: 'C:/work' })).length, 6);
});

test('createFallbackProvider fails closed when detection throws; tolerant of array/undefined results', async () => {
  const throwing = createFallbackProvider(async () => {
    throw new Error('detection exploded');
  });
  assert.deepEqual(await throwing.list({ cwd: 'C:/work' }), []);

  const arrayDetect = createFallbackProvider(async () => []);
  assert.equal((await arrayDetect.list({ cwd: 'C:/work' })).length, 6);

  const emptyDetect = createFallbackProvider(async () => undefined);
  assert.equal((await emptyDetect.list({ cwd: 'C:/work' })).length, 6);

  assert.throws(() => createFallbackProvider('not a function'), TypeError);
});

test('createFallbackProvider.get returns the full SKILL.md definition for each candidate', async () => {
  const provider = createFallbackProvider(async () => ({ skills: [], rootsScanned: [], warnings: [] }));
  const candidates = await provider.list({ cwd: 'C:/work' });
  for (const candidate of candidates) {
    const definition = await provider.get(candidate, { cwd: 'C:/work' });
    const source = FALLBACK_SKILLS.find((skill) => skill.name === candidate.name);
    assert.ok(source);
    assert.equal(definition.name, candidate.name);
    assert.equal(definition.description, source.description);
    assert.equal(definition.content, source.content);
    assert.equal(definition.whenToUse, candidate.whenToUse);
    assert.deepEqual(definition.invocation, candidate.invocation);
    assert.deepEqual(definition.locator, candidate.locator);
    assert.equal(definition.provider, 'openspec-native-fallback');

    const parsed = parseSkillFrontmatter(definition.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.name, candidate.name);
    assert.equal(parsed.metadata.adaptedFrom, 'Fission-AI/OpenSpec');
  }

  assert.equal(await provider.get({ name: 'openspec-unknown' }), undefined);
  assert.equal(await provider.get({}), undefined);
  assert.equal(await provider.get(null), undefined);
  assert.equal(await provider.get(undefined), undefined);
});

// ---------------------------------------------------------------------------
// No-mutation guard: source and behaviour
// ---------------------------------------------------------------------------

test('skills modules import only read operations and contain no write API calls', async () => {
  const skillsSource = await readFile(new URL('../src/native/skills.js', import.meta.url), 'utf8');
  const fallbackSource = await readFile(
    new URL('../src/native/skills-fallback.js', import.meta.url),
    'utf8',
  );
  for (const [label, source] of [
    ['skills.js', skillsSource],
    ['skills-fallback.js', fallbackSource],
  ]) {
    assert.doesNotMatch(
      source,
      /\b(?:writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync|renameSync|copyFile|copyFileSync)\b/,
      `${label} must not contain filesystem write calls`,
    );
  }
  const fsImport = skillsSource.match(/import\s*\{([^}]+)\}\s*from\s*'node:fs\/promises'/);
  assert.ok(fsImport, 'skills.js imports node:fs/promises');
  assert.deepEqual(
    fsImport[1]
      .split(',')
      .map((part) => part.trim())
      .sort(),
    ['readFile', 'readdir', 'stat'],
  );
});
