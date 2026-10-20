/**
 * Tests for src/native/validate.js — deterministic native validation.
 *
 * Run: node --test --test-isolation=none tests/native-validate.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateChange, validateMainSpec } from '../src/native/validate.js'
import { parseDeltaSpec } from '../src/native/spec.js'

const WHY_OK =
  'The plugin currently ignores native OpenSpec configuration, so the panel, commands and prompts disagree with the CLI about the same repository.'

/** @param {string} why @param {{whatChanges?: boolean, capabilities?: boolean}} [options] */
function proposalText(why, { whatChanges = true, capabilities = true } = {}) {
  return [
    '# Proposal',
    '',
    '## Why',
    '',
    why,
    '',
    ...(whatChanges ? ['## What Changes', '', '- Read native configuration and metadata.', ''] : []),
    ...(capabilities ? ['## Capabilities', '', '### New Capabilities', '', '- `native-model`', ''] : []),
  ].join('\n')
}

/** @param {string} requirementBody @param {string} [scenario] */
function deltaText(requirementBody, scenario = '- **WHEN** something happens\n- **THEN** it works') {
  return [
    '## ADDED Requirements',
    '',
    '### Requirement: Native model',
    '',
    requirementBody,
    '',
    '#### Scenario: It works',
    '',
    scenario,
    '',
  ].join('\n')
}

/** @param {string} path @param {string} text */
function delta(path, text) {
  return { path, text, parsed: parseDeltaSpec(text) }
}

/** @param {object} [overrides] */
function changeInput(overrides = {}) {
  return {
    changeName: 'sample-change',
    schema: { name: 'spec-driven', artifacts: [], apply: {} },
    config: { found: true, schema: 'spec-driven', context: '', rules: {}, operations: {}, warnings: [] },
    metadata: {
      found: true,
      schema: 'spec-driven',
      created: '2026-10-20',
      goal: null,
      skip_specs: false,
      retire_capabilities: false,
    },
    metadataResult: { found: true, warnings: [], error: null },
    proposalText: proposalText(WHY_OK),
    deltas: [delta('specs/native-model/spec.md', deltaText('The system SHALL read native configuration.'))],
    tasksText: ['# Tasks', '- [ ] 1.1 first', '- [ ] 1.2 second'].join('\n'),
    ...overrides,
  }
}

test('a clean change produces no issues', () => {
  const result = validateChange(changeInput())
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.summary, { errors: 0, warnings: 0, infos: 0 })
})

test('Why shorter than 50 characters is an ERROR, longer than 1000 a WARNING', () => {
  const short = validateChange(changeInput({ proposalText: proposalText('Too short.') }))
  const shortIssue = short.issues.find((issue) => issue.path === 'proposal.md' && issue.message.includes('"## Why"'))
  assert.equal(shortIssue.level, 'ERROR')
  assert.match(shortIssue.message, /between 50 and 1000 characters \(currently 10\)/)

  const long = validateChange(changeInput({ proposalText: proposalText('x'.repeat(1001)) }))
  const longIssue = long.issues.find((issue) => issue.message.includes('"## Why"'))
  assert.equal(longIssue.level, 'WARNING')
  assert.match(longIssue.message, /at or below 1000 characters \(currently 1001\)/)

  const boundary = validateChange(changeInput({ proposalText: proposalText('y'.repeat(50)) }))
  assert.equal(boundary.summary.errors, 0)
})

test('missing/empty What Changes is an ERROR, missing Capabilities a WARNING', () => {
  const missingWhat = validateChange(
    changeInput({ proposalText: proposalText(WHY_OK, { whatChanges: false }) }),
  )
  assert.ok(missingWhat.issues.some((issue) => issue.level === 'ERROR' && /"## What Changes"/.test(issue.message)))

  const emptyWhat = validateChange(
    changeInput({ proposalText: proposalText(WHY_OK, { whatChanges: false }) + '\n## What Changes\n\n## Capabilities\n' }),
  )
  assert.ok(emptyWhat.issues.some((issue) => issue.level === 'ERROR' && /"## What Changes"/.test(issue.message)))

  const missingCapabilities = validateChange(
    changeInput({ proposalText: proposalText(WHY_OK, { capabilities: false }) }),
  )
  assert.ok(
    missingCapabilities.issues.some(
      (issue) => issue.level === 'WARNING' && /"## Capabilities"/.test(issue.message),
    ),
  )
  assert.equal(missingCapabilities.summary.errors, 0)
})

test('missing or empty proposal is an ERROR', () => {
  for (const proposalTextValue of [null, '', '   ']) {
    const result = validateChange(changeInput({ proposalText: proposalTextValue }))
    assert.ok(
      result.issues.some(
        (issue) => issue.path === 'proposal.md' && issue.message === 'proposal.md is missing or empty',
      ),
    )
  }
})

test('deltas are required unless skip_specs opts out, and skip_specs conflicts with deltas', () => {
  const noDeltas = validateChange(changeInput({ deltas: [] }))
  const missing = noDeltas.issues.find((issue) => issue.path === 'specs')
  assert.equal(missing.level, 'ERROR')
  assert.match(missing.message, /at least one delta spec.*skip_specs: true/)

  const skipSpecs = validateChange(
    changeInput({
      deltas: [],
      metadata: { found: true, schema: 'spec-driven', created: '2026-10-20', goal: null, skip_specs: true, retire_capabilities: false },
    }),
  )
  assert.equal(skipSpecs.summary.errors, 0)

  const conflict = validateChange(
    changeInput({
      metadata: { found: true, schema: 'spec-driven', created: '2026-10-20', goal: null, skip_specs: true, retire_capabilities: false },
    }),
  )
  const conflictIssue = conflict.issues.find((issue) => issue.path === '.openspec.yaml')
  assert.equal(conflictIssue.level, 'ERROR')
  assert.match(conflictIssue.message, /"skip_specs: true" conflicts with 1 delta spec file/)
})

test('stray specs/spec.md at the delta root is an ERROR', () => {
  const result = validateChange(
    changeInput({ deltas: [delta('specs/spec.md', deltaText('The system SHALL read configuration.'))] }),
  )
  const issue = result.issues.find((candidate) => candidate.message.includes('not directly at specs/spec.md'))
  assert.equal(issue.level, 'ERROR')
  assert.equal(issue.path, 'specs/spec.md')
})

test('ADDED/MODIFIED requirements need SHALL or MUST and at least one scenario', () => {
  const noShall = validateChange(
    changeInput({ deltas: [delta('specs/a/spec.md', deltaText('The system reads native configuration.'))] }),
  )
  assert.ok(
    noShall.issues.some(
      (issue) =>
        issue.level === 'ERROR' &&
        /must contain SHALL or MUST/.test(issue.message) &&
        issue.message.includes('"Native model"'),
    ),
  )

  const noScenario = validateChange(
    changeInput({
      deltas: [
        delta('specs/a/spec.md', ['## ADDED Requirements', '', '### Requirement: Native model', '', 'The system SHALL exist.'].join('\n')),
      ],
    }),
  )
  assert.ok(
    noScenario.issues.some(
      (issue) => issue.level === 'ERROR' && /must include at least one "#### Scenario:"/.test(issue.message),
    ),
  )
})

test('long requirement bodies warn, duplicates error, RENAMED pairs are checked', () => {
  const longBody = validateChange(
    changeInput({
      deltas: [delta('specs/a/spec.md', deltaText(`The system SHALL exist. ${'x'.repeat(500)}`))],
    }),
  )
  assert.ok(
    longBody.issues.some((issue) => issue.level === 'WARNING' && /longer than 500 characters/.test(issue.message)),
  )

  const duplicate = validateChange(
    changeInput({
      deltas: [
        delta(
          'specs/a/spec.md',
          [
            '## ADDED Requirements',
            '',
            '### Requirement: Same',
            '',
            'The system SHALL exist.',
            '',
            '#### Scenario: One',
            '',
            '- **WHEN** a',
            '- **THEN** b',
            '',
            '### Requirement: Same',
            '',
            'The system SHALL exist too.',
            '',
            '#### Scenario: Two',
            '',
            '- **WHEN** a',
            '- **THEN** b',
          ].join('\n'),
        ),
      ],
    }),
  )
  assert.ok(
    duplicate.issues.some((issue) => issue.level === 'ERROR' && /duplicate ADDED requirement "Same"/.test(issue.message)),
  )

  const renamed = validateChange(
    changeInput({
      deltas: [
        delta(
          'specs/a/spec.md',
          ['## RENAMED Requirements', '', '- FROM: `### Requirement: Old`', '- TO: `### Requirement: New`'].join('\n'),
        ),
      ],
    }),
  )
  assert.equal(renamed.issues.some((issue) => /RENAMED entry is missing/.test(issue.message)), false)
})

test('metadata errors are relayed as ERROR and unknown keys as WARNING', () => {
  const withError = validateChange(
    changeInput({
      metadataResult: { found: true, warnings: [], error: { message: 'invalid YAML: bad indentation', line: 3 } },
    }),
  )
  const errors = withError.issues.filter((issue) => issue.level === 'ERROR' && issue.path === '.openspec.yaml')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 3)

  const withWarnings = validateChange(
    changeInput({
      metadataResult: { found: true, warnings: ['unknown change metadata key "owner" (line 2)'], error: null },
    }),
  )
  assert.ok(
    withWarnings.issues.some(
      (issue) => issue.level === 'WARNING' && issue.path === '.openspec.yaml' && /unknown change metadata key/.test(issue.message),
    ),
  )

  const invalidCreated = validateChange(
    changeInput({
      metadata: { found: true, schema: 'spec-driven', created: '20/10/2026', goal: null, skip_specs: false, retire_capabilities: false },
      metadataResult: { found: true, warnings: [], error: null },
    }),
  )
  assert.ok(
    invalidCreated.issues.some(
      (issue) => issue.level === 'ERROR' && /"created" must be a YYYY-MM-DD date/.test(issue.message),
    ),
  )
})

test('task numbering gaps and unusual markers are WARNINGs', () => {
  const result = validateChange(
    changeInput({
      tasksText: ['# Tasks', '- [ ] 1.1 first', '- [ ] 1.3 gap', '- [~] 1.4 unusual'].join('\n'),
    }),
  )
  assert.ok(
    result.issues.some(
      (issue) => issue.level === 'WARNING' && /task numbering gap: expected 1\.2 but found 1\.3/.test(issue.message),
    ),
  )
  assert.ok(result.issues.some((issue) => issue.level === 'WARNING' && /unusual task marker/.test(issue.message)))
  assert.equal(result.summary.errors, 0)
})

test('validation is deterministic for identical input', () => {
  const input = changeInput({
    deltas: [delta('specs/a/spec.md', deltaText('No keyword here.'))],
    tasksText: '- [ ] 1.1 a\n- [~] 1.2 b',
  })
  const first = validateChange(input)
  const second = validateChange(input)
  assert.deepEqual(first.issues, second.issues)
  assert.deepEqual(first.summary, second.summary)
  const sorted = [...first.issues].sort((a, b) => {
    const pathCompare = (a.path ?? '').localeCompare(b.path ?? '')
    if (pathCompare !== 0) return pathCompare
    return (a.line ?? 0) - (b.line ?? 0)
  })
  assert.deepEqual(first.issues, sorted)
})

const MAIN_SPEC = [
  '# Authentication Specification',
  '',
  '## Purpose',
  '',
  'Defines how users authenticate so that sessions are trustworthy across the product.',
  '',
  '## Requirements',
  '',
  '### Requirement: Login',
  '',
  'The system SHALL authenticate users with a username and password.',
  '',
  '#### Scenario: Valid credentials',
  '',
  '- **WHEN** a user submits valid credentials',
  '- **THEN** a session is created',
  '',
  '### Requirement: Logout',
  '',
  'The system MUST invalidate the session on logout.',
  '',
  '#### Scenario: Logout',
  '',
  '- **WHEN** a user logs out',
  '- **THEN** the session ends',
].join('\n')

test('validateMainSpec accepts a clean capability spec', () => {
  const result = validateMainSpec({ path: 'openspec/specs/auth/spec.md', text: MAIN_SPEC })
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.summary, { errors: 0, warnings: 0, infos: 0 })
})

test('validateMainSpec reports missing Purpose/Requirements sections', () => {
  const missingPurpose = validateMainSpec({
    path: 'openspec/specs/auth/spec.md',
    text: ['# Spec', '', '## Requirements', '', '### Requirement: A', '', 'The system SHALL exist.', '', '#### Scenario: S', '', '- **WHEN** a', '- **THEN** b'].join('\n'),
  })
  assert.ok(
    missingPurpose.issues.some(
      (issue) => issue.level === 'ERROR' && /missing a "## Purpose" section/.test(issue.message),
    ),
  )

  const shortPurpose = validateMainSpec({
    path: 'openspec/specs/auth/spec.md',
    text: MAIN_SPEC.replace(/Defines how users[\s\S]*?product\./, 'Short purpose.'),
  })
  assert.ok(
    shortPurpose.issues.some(
      (issue) => issue.level === 'WARNING' && /"## Purpose" should be at least 50 characters/.test(issue.message),
    ),
  )

  const missingRequirements = validateMainSpec({
    path: 'openspec/specs/auth/spec.md',
    text: '# Spec\n\n## Purpose\n\n' + 'y'.repeat(60) + '\n',
  })
  assert.ok(
    missingRequirements.issues.some(
      (issue) => issue.level === 'ERROR' && /missing a "## Requirements" section/.test(issue.message),
    ),
  )
  assert.ok(
    missingRequirements.issues.some(
      (issue) => issue.level === 'ERROR' && /at least one "### Requirement:" block/.test(issue.message),
    ),
  )
})

test('validateMainSpec checks requirement SHALL/MUST and scenarios', () => {
  const noShallNoScenario = validateMainSpec({
    path: 'openspec/specs/auth/spec.md',
    text: [
      '# Spec',
      '',
      '## Purpose',
      '',
      'z'.repeat(60),
      '',
      '## Requirements',
      '',
      '### Requirement: Widget',
      '',
      'Widgets exist.',
    ].join('\n'),
  })
  assert.ok(
    noShallNoScenario.issues.some(
      (issue) => issue.level === 'ERROR' && /"Widget" must contain SHALL or MUST/.test(issue.message),
    ),
  )
  assert.ok(
    noShallNoScenario.issues.some(
      (issue) => issue.level === 'ERROR' && /"Widget" must include at least one "#### Scenario:"/.test(issue.message),
    ),
  )
})
