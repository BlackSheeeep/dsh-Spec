/**
 * Tests for src/native/spec.js — main spec / delta spec parsing.
 *
 * Run: node --test --test-isolation=none tests/native-spec.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  countScenarios,
  parseDeltaSpec,
  parseMainSpec,
  parseRequirementBlocks,
} from '../src/native/spec.js'

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
  '- **WHEN** a user submits a valid username and password',
  '- **THEN** the system returns a signed session token',
  '',
  '#### Scenario: Invalid credentials',
  '',
  '- **WHEN** a user submits a wrong password',
  '- **THEN** the system rejects the attempt',
  '',
  '### Requirement: Logout',
  '',
  'The system MUST invalidate the session on logout.',
  '',
  '#### Scenario: Logout invalidates',
  '',
  '- **WHEN** a user logs out',
  '- **THEN** the session token is rejected afterwards',
].join('\n')

const DELTA_SPEC = [
  '## ADDED Requirements',
  '',
  '### Requirement: Rate limiting',
  '',
  'The system SHALL rate limit login attempts.',
  '',
  '#### Scenario: Too many attempts',
  '',
  '- **WHEN** a user fails five times in a minute',
  '- **THEN** the system blocks further attempts',
  '',
  '## MODIFIED Requirements',
  '',
  '### Requirement: Login',
  '',
  'The system SHALL authenticate with a username and password and MUST audit the attempt.',
  '',
  '#### Scenario: Audited login',
  '',
  '- **WHEN** a user logs in',
  '- **THEN** the attempt is recorded',
  '',
  '## REMOVED Requirements',
  '',
  '### Requirement: Legacy login',
  '',
  '**Reason**: replaced by the new login flow.',
  '',
  '## RENAMED Requirements',
  '',
  '- FROM: `### Requirement: Logout`',
  '- TO: `### Requirement: Sign out`',
].join('\n')

test('parseMainSpec extracts title, purpose, requirements and scenarios', () => {
  const parsed = parseMainSpec(MAIN_SPEC)
  assert.equal(parsed.title, 'Authentication Specification')
  assert.match(parsed.purpose, /^Defines how users authenticate/)
  assert.deepEqual(parsed.issues, [])
  assert.deepEqual(
    parsed.requirements.map((requirement) => ({
      name: requirement.name,
      scenarios: requirement.scenarios.map((scenario) => scenario.name),
    })),
    [
      { name: 'Login', scenarios: ['Valid credentials', 'Invalid credentials'] },
      { name: 'Logout', scenarios: ['Logout invalidates'] },
    ],
  )
  assert.match(parsed.requirements[0].text, /SHALL authenticate/)
  assert.ok(parsed.requirements[0].raw.startsWith('### Requirement: Login'))
  assert.ok(!parsed.requirements[0].raw.includes('Logout'))
})

test('parseMainSpec tolerates missing sections without throwing', () => {
  const parsed = parseMainSpec('# Title\n\nSome text.\n')
  assert.equal(parsed.title, 'Title')
  assert.equal(parsed.purpose, null)
  assert.deepEqual(parsed.requirements, [])
  assert.deepEqual(parsed.issues, [])
})

test('parseDeltaSpec parses all four operations', () => {
  const parsed = parseDeltaSpec(DELTA_SPEC)
  assert.deepEqual(parsed.issues, [])
  assert.deepEqual(
    Object.fromEntries(Object.entries(parsed.operations).map(([key, value]) => [key, value.length])),
    { ADDED: 1, MODIFIED: 1, REMOVED: 1, RENAMED: 1 },
  )
  assert.equal(parsed.operations.ADDED[0].name, 'Rate limiting')
  assert.equal(parsed.operations.MODIFIED[0].name, 'Login')
  assert.equal(parsed.operations.REMOVED[0].name, 'Legacy login')
  assert.deepEqual(parsed.operations.RENAMED[0], {
    from: 'Logout',
    to: 'Sign out',
    raw: '- FROM: `### Requirement: Logout`\n- TO: `### Requirement: Sign out`',
  })
  assert.equal(countScenarios(parsed.operations.ADDED[0].raw), 1)
})

test('wrong-level scenario headings raise a WARNING and do not count as scenarios', () => {
  const text = [
    '## ADDED Requirements',
    '',
    '### Requirement: Widget',
    '',
    'The system SHALL render widgets.',
    '',
    '### Scenario: Rendered',
    '',
    '- **WHEN** a widget exists',
    '- **THEN** it renders',
    '',
    '##### Scenario: Deeper',
  ].join('\n')
  const parsed = parseDeltaSpec(text)
  const warnings = parsed.issues.filter((issue) => issue.message.includes('#### Scenario:'))
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every((issue) => issue.level === 'WARNING'))
  assert.equal(countScenarios(parsed.operations.ADDED[0].raw), 0)
  assert.equal(parsed.operations.ADDED[0].scenarios.length, 0)
})

test('requirements outside a delta section raise a WARNING', () => {
  const text = ['# Spec Delta', '', '### Requirement: Stray', '', 'The system SHALL exist.'].join('\n')
  const parsed = parseDeltaSpec(text)
  assert.equal(parsed.operations.ADDED.length, 0)
  assert.equal(parsed.issues.length, 1)
  assert.equal(parsed.issues[0].level, 'WARNING')
  assert.match(parsed.issues[0].message, /requirement "Stray" appears outside a delta section/)
  assert.equal(parsed.issues[0].line, 3)
})

test('REMOVED requirements without a Reason raise a WARNING', () => {
  const text = [
    '## REMOVED Requirements',
    '',
    '### Requirement: Gone',
    '',
    'It used to exist.',
  ].join('\n')
  const parsed = parseDeltaSpec(text)
  assert.equal(parsed.operations.REMOVED.length, 1)
  assert.equal(parsed.issues.length, 1)
  assert.equal(parsed.issues[0].level, 'WARNING')
  assert.match(parsed.issues[0].message, /must include a "\*\*Reason\*\*" line/)
})

test('RENAMED entries missing FROM or TO raise ERRORs', () => {
  const missingTo = parseDeltaSpec(['## RENAMED Requirements', '', '- FROM: `### Requirement: Old`'].join('\n'))
  assert.equal(missingTo.operations.RENAMED.length, 1)
  assert.equal(missingTo.operations.RENAMED[0].from, 'Old')
  assert.equal(missingTo.operations.RENAMED[0].to, null)
  assert.ok(missingTo.issues.some((issue) => issue.level === 'ERROR' && /missing its "- TO:"/.test(issue.message)))

  const missingFrom = parseDeltaSpec(['## RENAMED Requirements', '', '- TO: `### Requirement: New`'].join('\n'))
  assert.ok(missingFrom.issues.some((issue) => issue.level === 'ERROR' && /missing its "- FROM:"/.test(issue.message)))
})

test('parseRequirementBlocks returns an array with attached issues', () => {
  const blocks = parseRequirementBlocks(MAIN_SPEC)
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks.issues, [])
  assert.equal(Object.keys(blocks).includes('issues'), false)

  const broken = parseRequirementBlocks('### Requirement: A\n\n### Scenario: bad\n')
  assert.equal(broken.length, 1)
  assert.equal(broken.issues.length, 1)
})

test('countScenarios counts only four-level scenario headings', () => {
  assert.equal(countScenarios(''), 0)
  assert.equal(countScenarios('#### Scenario: one\n#### Scenario: two\n'), 2)
  assert.equal(countScenarios('### Scenario: wrong\n#### Scenario: right\n'), 1)
})
