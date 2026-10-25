/**
 * Tests for the multi-role orchestration engine (Host half).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { computeWorkspaceState } from '../src/native/state.js'
import { readForRole, writeForRole } from '../src/native/write-coordinator.js'
import {
  acceptTask,
  buildPlanPrompt,
  buildPmPrompt,
  buildRolePrompt,
  createProgram,
  evaluateProgram,
  normalizeProgram,
  readPlan,
  readPrograms,
  updateProgramRoles,
  writePmContext,
  writePlanDraft,
} from '../src/native/orchestration.js'

function makeWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spec-orch-'))
  fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'schema: spec-driven\n')
  return cwd
}

function write(cwd, rel, text) {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true })
  fs.writeFileSync(path.join(cwd, rel), text)
}

function baseProgram(overrides = {}) {
  return {
    id: 'skills',
    title: '技能系统',
    goal: '为游戏新增技能系统',
    created: '2026-10-23',
    roles: {
      product: { provider: 'openai', model: 'gpt-5' },
      design: { provider: 'moonshot', model: 'kimi-k2' },
      dev: { provider: 'deepseek', model: 'deepseek-v3' },
      test: { provider: 'deepseek', model: 'deepseek-v3' },
    },
    tasks: [
      { id: 'core', change: 'skill-core', title: '技能核心', description: '共享数据结构', dependsOn: [], roles: ['product', 'design', 'dev', 'test'] },
      { id: 'fireball', change: 'skill-fireball', title: '火球术', description: '新增火球术', dependsOn: ['core'], roles: ['product', 'design', 'dev', 'test'] },
    ],
    ...overrides,
  }
}

/** Complete the product contract for one change. */
function completeProduct(cwd, change) {
  write(cwd, `openspec/changes/${change}/proposal.md`, '## Why\n\nneed this change because it is useful.\n\n## What Changes\n\n- add the thing\n')
  write(cwd, `openspec/changes/${change}/specs/${change}/spec.md`, '## ADDED Requirements\n\n### Requirement: Thing\n\nThe system SHALL do the thing.\n\n#### Scenario: works\n\n- **WHEN** called\n- **THEN** it works\n')
  write(cwd, `openspec/changes/${change}/tasks.md`, '- [ ] 1.1 implement the thing\n')
}

test('createProgram scaffolds child changes and evaluates dependency gates', async () => {
  const cwd = makeWorkspace()
  const program = await createProgram(cwd, baseProgram())
  assert.equal(program.id, 'skills')
  assert.equal(program.auto, true)
  assert.equal(program.roles.pm.label, 'PM')
  assert.ok(fs.existsSync(path.join(cwd, 'openspec/changes/skill-core/.openspec.yaml')))
  assert.ok(fs.existsSync(path.join(cwd, 'openspec/changes/skill-fireball/.openspec.yaml')))
  assert.ok(fs.existsSync(path.join(cwd, 'openspec/orchestration/skills/program.json')))

  const initial = await computeWorkspaceState(cwd)
  const first = await readPrograms(cwd, initial)
  assert.equal(first.programs.length, 1)
  const core = first.programs[0].tasks.find((task) => task.id === 'core')
  const fireball = first.programs[0].tasks.find((task) => task.id === 'fireball')
  assert.deepEqual(core.roles.dev.status, 'ready')
  assert.equal(fireball.roles.dev.status, 'waiting')
  assert.match(fireball.roles.dev.missing.join('；'), /技能核心/)

  completeProduct(cwd, 'skill-core')
  write(cwd, 'openspec/changes/skill-core/tasks.md', '- [x] implement core\n')
  write(cwd, 'openspec/changes/skill-core/qa/dev-done.md', '# Dev done\n\nCore implemented.\n')
  const afterDev = await readPrograms(cwd, await computeWorkspaceState(cwd))
  const core2 = afterDev.programs[0].tasks.find((task) => task.id === 'core')
  const fireball2 = afterDev.programs[0].tasks.find((task) => task.id === 'fireball')
  assert.equal(core2.roles.dev.done, true)
  assert.equal(fireball2.roles.dev.ready, true)
})

test('role prompt is built from dependency artifacts, not another role transcript', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, baseProgram())
  completeProduct(cwd, 'skill-core')
  write(cwd, 'openspec/changes/skill-core/design.md', '# Design\n\nBlue orb.\n')
  const evaluated = await readPrograms(cwd, await computeWorkspaceState(cwd))
  const program = evaluated.programs[0]
  const task = program.tasks.find((entry) => entry.id === 'fireball')
  const prompt = await buildRolePrompt(cwd, program, task, 'dev', await computeWorkspaceState(cwd))
  assert.match(prompt, /火球术/)
  assert.match(prompt, /为游戏新增技能系统/)
  assert.match(prompt, /openspec_write_file/)
  // Dependencies are contracts by path; the prompt must not inline the spec body.
  assert.match(prompt, /依赖任务：技能核心/)
  assert.match(prompt, /openspec\/changes\/skill-core\/design\.md/)
  assert.doesNotMatch(prompt, /Blue orb/)
})

test('plan draft and planner prompt describe the single JSON contract', async () => {
  const cwd = makeWorkspace()
  const draft = await writePlanDraft(cwd, {
    id: 'auto-test',
    goal: '为游戏新增技能系统',
    roles: baseProgram().roles,
  })
  assert.equal(draft.id, 'auto-test')
  assert.ok(fs.existsSync(path.join(cwd, 'openspec/orchestration/.plans/.gitkeep')))
  assert.equal(await readPlan(cwd, 'auto-test'), null)
  const prompt = await buildPlanPrompt(cwd, draft)
  assert.match(prompt, /openspec\/orchestration\/\.plans\/auto-test\.json/)
  assert.match(prompt, /1–8/)
  assert.match(prompt, /不要创建/)
  assert.match(prompt, /"id": "core"/)
})

test('PM prompt and status report are part of the program state', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, baseProgram())
  completeProduct(cwd, 'skill-core')
  const evaluated = await readPrograms(cwd, await computeWorkspaceState(cwd))
  const program = evaluated.programs[0]
  const prompt = await buildPmPrompt(cwd, program)
  assert.match(prompt, /项目经理/)
  assert.match(prompt, /pm\/status\.md/)
  assert.match(prompt, /技能核心/)
  write(cwd, 'openspec/orchestration/skills/pm/status.md', '当前阶段：规格评审。\n')
  const withStatus = await readPrograms(cwd, await computeWorkspaceState(cwd))
  assert.match(withStatus.programs[0].pmStatus, /规格评审/)
})

test('a logic-only task can skip the optional design role', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, {
    ...baseProgram(),
    tasks: [
      {
        id: 'api',
        change: 'add-api',
        title: 'API',
        description: 'pure logic',
        dependsOn: [],
        roles: ['product', 'dev'],
      },
    ],
  })
  completeProduct(cwd, 'add-api')
  write(cwd, 'openspec/changes/add-api/tasks.md', '- [x] implement the API\n')
  write(cwd, 'openspec/changes/add-api/qa/dev-done.md', '# Dev done\n\nImplemented.\n')
  const evaluated = await readPrograms(cwd, await computeWorkspaceState(cwd))
  const task = evaluated.programs[0].tasks[0]
  assert.equal(task.roles.design, undefined)
  assert.equal(task.roles.test, undefined)
  assert.equal(task.roles.dev.done, true)
})

test('role skill allowlists are normalized, saved, and rendered in the role prompt', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, {
    ...baseProgram(),
    roles: {
      ...baseProgram().roles,
      dev: { provider: 'deepseek', model: 'deepseek-v3', skills: ['office', 'pdf-image-extractor', 'office'] },
    },
  })
  const evaluated = await readPrograms(cwd, await computeWorkspaceState(cwd))
  assert.deepEqual(evaluated.programs[0].roles.dev.skills, ['office', 'pdf-image-extractor'])
  const task = evaluated.programs[0].tasks[0]
  const prompt = await buildRolePrompt(cwd, evaluated.programs[0], task, 'dev', await computeWorkspaceState(cwd))
  assert.match(prompt, /office/)
  assert.match(prompt, /pdf-image-extractor/)
  assert.match(prompt, /建议优先使用以下 agent skills/)

  const updated = await updateProgramRoles(cwd, 'skills', { dev: { skills: ['openspec-apply-change'] } })
  assert.deepEqual(updated.roles.dev.skills, ['openspec-apply-change'])
  assert.equal(updated.roles.dev.provider, 'deepseek')
  assert.equal(updated.roles.dev.model, 'deepseek-v3')
})

test('PM prompt includes role context occupancy and the compact threshold', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, baseProgram())
  const evaluated = await readPrograms(cwd, await computeWorkspaceState(cwd))
  await writePmContext(cwd, 'skills', [
    { task: 'core', role: 'dev', sessionId: 's1', usedTokens: 850, contextWindow: 1000, percent: 85 },
  ])
  const prompt = await buildPmPrompt(cwd, evaluated.programs[0])
  assert.match(prompt, /角色会话上下文用量/)
  assert.match(prompt, /core \/ dev：85%/)
  assert.match(prompt, /\/compact/)
})

test('write coordinator serializes hashes and reports stale writes', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, baseProgram())
  const file = 'openspec/changes/skill-core/notes.md'
  const first = await readForRole(cwd, { program: 'skills', task: 'core', role: 'dev', path: file })
  assert.equal(first.exists, false)
  await writeForRole(cwd, { program: 'skills', task: 'core', role: 'dev', path: file, content: 'one\n' })
  const second = await readForRole(cwd, { program: 'skills', task: 'core', role: 'dev', path: file })
  assert.equal(second.content, 'one\n')
  await writeForRole(cwd, {
    program: 'skills',
    task: 'core',
    role: 'dev',
    path: file,
    content: 'two\n',
    expectedSha256: second.sha256,
  })
  await assert.rejects(
    writeForRole(cwd, {
      program: 'skills',
      task: 'core',
      role: 'dev',
      path: file,
      content: 'stale\n',
      expectedSha256: second.sha256,
    }),
    /写入冲突/,
  )
  const conflicts = fs.readFileSync(
    path.join(cwd, 'openspec/orchestration/skills/pm/conflicts.md'),
    'utf8',
  )
  assert.match(conflicts, /版本哈希不匹配/)
  completeProduct(cwd, 'skill-core')
  write(cwd, 'openspec/changes/skill-core/design.md', '# Design\n\nBlue orb.\n')
  await writeForRole(cwd, {
    program: 'skills',
    task: 'core',
    role: 'dev',
    path: 'src/game/skill.ts',
    content: 'export const skill = true\n',
  })
  assert.equal(fs.readFileSync(path.join(cwd, 'src/game/skill.ts'), 'utf8'), 'export const skill = true\n')
  await assert.rejects(
    writeForRole(cwd, {
      program: 'skills',
      task: 'core',
      role: 'dev',
      path: 'openspec/changes/skill-fireball/outside.md',
      content: 'x',
    }),
    /写入越界/,
  )
})

test('acceptTask records the user gate and normalizeProgram rejects cycles', async () => {
  const cwd = makeWorkspace()
  await createProgram(cwd, baseProgram())
  const accepted = await acceptTask(cwd, 'skills', 'fireball', true)
  assert.equal(accepted.tasks.find((task) => task.id === 'fireball').accepted, true)

  assert.throws(
    () =>
      normalizeProgram(
        baseProgram({
          tasks: [
            { id: 'a', change: 'a', title: 'A', description: '', dependsOn: ['b'], roles: ['product'] },
            { id: 'b', change: 'b', title: 'B', description: '', dependsOn: ['a'], roles: ['product'] },
          ],
        }),
      ),
    /依赖存在环/,
  )
})
