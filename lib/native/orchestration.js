/**
 * Multi-role OpenSpec orchestration (Host half).
 *
 * A *program* groups child OpenSpec changes that share one goal. Each child
 * change is a normal native change; roles only exchange file artifacts and short
 * handoff notes, never conversation transcripts.
 *
 * Layout:
 *
 *   openspec/orchestration/<program>/program.json
 *   openspec/orchestration/<program>/handoffs/<task>-<role>.md
 *
 * The manifest is JSON on purpose: it is written by the panel and must remain
 * easy to parse without a YAML serializer dependency.
 *
 * @module dsh-spec/native/orchestration
 */

import { joinRel, listDir, pathExists, readTextOrNull, writeText } from './fsio.js'
import { ensureSkeleton } from './init.js'
import { readProjectConfig } from './config.js'
import {
  formatLocalDate,
  resolveSchemaName,
  serializeChangeMetadata,
} from './metadata.js'

/** Directory that holds all programs. */
export const ORCHESTRATION_DIR = 'openspec/orchestration'

/** Draft and plan files used by the AI task-splitting flow. */
export const PLAN_DRAFT_DIR = 'openspec/orchestration/.drafts'
export const PLAN_DIR = 'openspec/orchestration/.plans'

/**
 * Single execution role. PM plans and manages; one developer agent implements
 * each OpenSpec task; the user accepts the result.
 */
export const ROLE_IDS = ['dev']

/** Roles that have a model (PM coordinates the program; work roles execute). */
export const MODEL_ROLE_IDS = ['pm', ...ROLE_IDS]

/** Default labels and prompts. */
export const ROLE_DEFINITIONS = {
  pm: {
    label: 'PM',
    color: 'cyan',
    summary: '把控项目进度、识别阻塞、决定下一步；不写业务代码，不代替用户最终验收。',
  },
  product: {
    label: '产品',
    color: 'blue',
    summary: '写出可评审的 proposal、delta specs、验收标准与任务清单；不写代码。',
  },
  design: {
    label: '设计',
    color: 'violet',
    summary: '根据产品规格产出 design.md、视觉规范与资源清单；不写业务代码。',
  },
  dev: {
    label: '开发',
    color: 'green',
    summary: '按规格与设计实现代码，勾选 tasks.md；UI 工作必须等设计完成。',
  },
  test: {
    label: '测试',
    color: 'amber',
    summary: '按验收标准做功能与视觉验证，写 qa/report.md；不代替用户最终验收。',
  },
}

/**
 * @typedef {{provider: string, model: string, label?: string}} RoleModel
 * @typedef {{id: string, title: string, change: string, description: string, dependsOn: string[], roles: string[], accepted: boolean}} Task
 * @typedef {{version: number, id: string, title: string, goal: string, created: string, roles: Record<string, RoleModel>, tasks: Task[]}} Program
 */

/**
 * Slugify an ASCII identifier. Chinese titles need an explicit id from the UI.
 * @param {string} value
 * @returns {string}
 */
export function slugifyId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * Validate a change/program id.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value) && value.length <= 64
}

/**
 * Directory of one program.
 * @param {string} id
 * @returns {string}
 */
export function programRel(id) {
  return joinRel(ORCHESTRATION_DIR, id)
}

/**
 * Normalize the four role assignments shared by programs and planning drafts.
 * @param {any} rawRoles
 * @returns {Record<string, RoleModel>}
 */
export function normalizeRoles(rawRoles) {
  /** @type {Record<string, RoleModel>} */
  const roles = {}
  for (const role of MODEL_ROLE_IDS) {
    const value = rawRoles !== null && typeof rawRoles === 'object' ? rawRoles[role] : undefined
    const provider = value !== null && typeof value === 'object' && typeof value.provider === 'string' ? value.provider.trim() : ''
    const model = value !== null && typeof value === 'object' && typeof value.model === 'string' ? value.model.trim() : ''
    const skills = Array.isArray(value?.skills)
      ? [...new Set(value.skills.filter((name) => typeof name === 'string').map((name) => name.trim()).filter(Boolean))]
      : []
    roles[role] = { provider, model, label: ROLE_DEFINITIONS[role].label, skills }
  }
  return roles
}

/**
 * Normalize a raw manifest into the stable shape used by the panel.
 *
 * Invalid references are rejected rather than silently rewritten: a wrong
 * dependency order is a coordination bug, not a display detail.
 *
 * @param {any} raw
 * @returns {Program}
 */
export function normalizeProgram(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('program 不是对象')
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!isValidId(id)) throw new Error('program id 无效（只允许小写字母、数字和连字符）')
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : id
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  const created = typeof raw.created === 'string' && raw.created.trim() !== '' ? raw.created.trim() : formatLocalDate()
  const roles = normalizeRoles(raw.roles)
  const auto = raw.auto === true

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error('program 至少需要一个子任务')
  const tasks = []
  const seenIds = new Set()
  const seenChanges = new Set()
  for (const item of raw.tasks) {
    if (item === null || typeof item !== 'object') throw new Error('子任务不是对象')
    const taskId = typeof item.id === 'string' ? item.id.trim() : ''
    if (!isValidId(taskId)) throw new Error(`子任务 id 无效：${String(item.id ?? '')}`)
    if (seenIds.has(taskId)) throw new Error(`子任务 id 重复：${taskId}`)
    seenIds.add(taskId)
    const change = typeof item.change === 'string' ? item.change.trim() : taskId
    if (!isValidId(change)) throw new Error(`子任务 ${taskId} 的 change 名称无效`)
    if (seenChanges.has(change)) throw new Error(`子任务 change 重复：${change}`)
    seenChanges.add(change)
    // Old programs carried product/design/dev/test roles; normalize every task
    // to the single developer executor.
    const roleList = [...ROLE_IDS]
    tasks.push({
      id: taskId,
      title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : taskId,
      change,
      description: typeof item.description === 'string' ? item.description.trim() : '',
      dependsOn: Array.isArray(item.dependsOn)
        ? [...new Set(item.dependsOn.filter((dep) => typeof dep === 'string' && dep.trim() !== '').map((dep) => dep.trim()))]
        : [],
      roles: roleList,
      writeScope: Array.isArray(item.writeScope)
        ? [...new Set(item.writeScope.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim()))]
        : [],
      developmentDone: item.developmentDone === true,
      accepted: item.accepted === true,
    })
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!seenIds.has(dep)) throw new Error(`子任务 ${task.id} 依赖不存在的任务：${dep}`)
      if (dep === task.id) throw new Error(`子任务 ${task.id} 不能依赖自己`)
    }
  }
  // Detect dependency cycles (depth-first).
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set()
  const visited = new Set()
  const visit = (taskId) => {
    if (visited.has(taskId)) return
    if (visiting.has(taskId)) throw new Error('子任务依赖存在环')
    visiting.add(taskId)
    for (const dep of byId.get(taskId)?.dependsOn ?? []) visit(dep)
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const task of tasks) visit(task.id)

  return { version: 1, id, title, goal, created, roles, auto, tasks }
}

/**
 * Read one program (without evaluation).
 * @param {string} cwd
 * @param {string} id
 * @returns {Promise<Program>}
 */
export async function readProgram(cwd, id) {
  if (!isValidId(id)) throw new Error('program id 无效')
  const text = await readTextOrNull(cwd, joinRel(programRel(id), 'program.json'))
  if (text === null) throw new Error(`找不到多角色任务：${id}`)
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`program.json 解析失败：${error.message}`)
  }
  return normalizeProgram(raw)
}

/**
 * Persist the user's goal + role models while the planner model splits it.
 * @param {string} cwd
 * @param {any} input
 * @param {{date?: string}} [options]
 * @returns {Promise<{id:string,goal:string,roles:Record<string,RoleModel>,created:string}>}
 */
export async function writePlanDraft(cwd, input, { date = formatLocalDate() } = {}) {
  if (input === null || typeof input !== 'object') throw new Error('缺少规划草稿')
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!isValidId(id)) throw new Error('规划草稿 id 无效')
  const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
  if (goal === '') throw new Error('最终目标不能为空')
  if (goal.length > 20_000) throw new Error('最终目标过长（最多 20000 字）')
  const draft = { id, goal, roles: normalizeRoles(input.roles), created: date }
  await writeText(cwd, joinRel(PLAN_DRAFT_DIR, `${id}.json`), `${JSON.stringify(draft, null, 2)}\n`)
  // Give the planner an existing directory to write into.
  await writeText(cwd, joinRel(PLAN_DIR, '.gitkeep'), '')
  return draft
}

/**
 * Read a planning draft.
 * @param {string} cwd
 * @param {string} id
 * @returns {Promise<{id:string,goal:string,roles:Record<string,RoleModel>,created:string}>}
 */
export async function readPlanDraft(cwd, id) {
  if (!isValidId(id)) throw new Error('规划草稿 id 无效')
  const text = await readTextOrNull(cwd, joinRel(PLAN_DRAFT_DIR, `${id}.json`))
  if (text === null) throw new Error(`找不到规划草稿：${id}`)
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`规划草稿解析失败：${error.message}`)
  }
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  if (goal === '') throw new Error(`规划草稿 ${id} 缺少最终目标`)
  return { id, goal, roles: normalizeRoles(raw.roles), created: typeof raw.created === 'string' ? raw.created : formatLocalDate() }
}

/**
 * Read the planner's proposed task split. Null means the planner has not
 * written it yet; malformed JSON / invalid tasks throw and the caller can show
 * a retryable error.
 *
 * @param {string} cwd
 * @param {string} id
 * @returns {Promise<{title:string,tasks:Task[]}|null>}
 */
export async function readPlan(cwd, id) {
  if (!isValidId(id)) throw new Error('规划 id 无效')
  const text = await readTextOrNull(cwd, joinRel(PLAN_DIR, `${id}.json`))
  if (text === null) return null
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`规划文件还不是合法 JSON：${error.message}`)
  }
  const draft = await readPlanDraft(cwd, id)
  const program = normalizeProgram({
    id,
    title: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : draft.goal.slice(0, 80),
    goal: draft.goal,
    created: draft.created,
    roles: draft.roles,
    tasks: raw.tasks,
  })
  return { title: program.title, tasks: program.tasks }
}

/**
 * Build the planner prompt. The planner writes exactly one JSON file; the Host
 * remains responsible for creating `.openspec.yaml` and the change directories.
 *
 * @param {string} cwd
 * @param {{id:string,goal:string,roles:Record<string,RoleModel>}} draft
 * @returns {Promise<string>}
 */
export async function buildPlanPrompt(cwd, draft) {
  const planPath = joinRel(PLAN_DIR, `${draft.id}.json`)
  const roleLines = MODEL_ROLE_IDS.map((role) => {
    const model = draft.roles?.[role]
    const value = model?.provider && model?.model ? `${model.provider}/${model.model}` : '会话默认'
    return `- ${role}（${ROLE_DEFINITIONS[role].label}）：${value}`
  })
  return [
    '你在为 OpenSpec 多角色任务做**任务拆分规划**，不写业务代码，也不创建 change。',
    '',
    '## 最终目标',
    '',
    draft.goal,
    '',
    '## 角色与模型',
    '',
    ...roleLines,
    '',
    '## 任务',
    '',
    `把目标拆成 1–8 个子任务，写入唯一文件：\`${planPath}\`。`,
    'Host 拿到这个文件后才会创建每个子任务的 change、`.openspec.yaml` 和程序清单；你不要创建 `openspec/changes/**` 或 `program.json`。',
    '',
    '文件必须是合法 JSON，结构如下：',
    '',
    '```json',
    JSON.stringify(
      {
        title: '简短的中文程序标题',
        tasks: [
          {
            id: 'core',
            change: 'skill-core',
            title: '技能核心',
            description: '共享数据结构、接口与验收基线',
            dependsOn: [],
            roles: ['dev'],
          },
          {
            id: 'fireball',
            change: 'skill-fireball',
            title: '火球术',
            description: '在核心之上新增火球术技能与视觉',
            dependsOn: ['core'],
            roles: ['dev'],
          },
        ],
      },
      null,
      2,
    ),
    '```',
    '',
    '规则：',
    '',
    '- `id` 与 `change` 必须是小写 ASCII kebab-case，唯一，且不要带路径；',
    '- `title` / `description` 使用与最终目标相同的语言；',
    '- `dependsOn` 只能引用本文件中已经出现的任务 id，且不能成环；',
    '- 任务按可交付的子能力拆分，不要按“写代码 / 写测试”机械拆分；',
    '- 有共享基础时，先放一个 core 任务，其余任务依赖它；',
    '- 不再区分产品/设计/测试角色；每个子任务只有一个开发执行者，`roles` 固定为 `["dev"]`；',
    '- 需要设计说明时写进该 change 的 `design.md`，不要创建独立设计角色或设计会话；',
    '- 只写规划文件，不要写任何代码、proposal、specs、design 或 tasks。',
    '',
    '写完后用一句话说明拆分结果，不要粘贴 JSON 全文。',
  ].join('\n')
}

/**
 * Read and evaluate every program.
 *
 * @param {string} cwd
 * @param {any} workspaceState result of computeWorkspaceState
 * @returns {Promise<{programs: any[], warnings: string[]}>}
 */
export async function readPrograms(cwd, workspaceState) {
  const warnings = []
  const entries = await listDir(cwd, ORCHESTRATION_DIR).catch(() => [])
  const programs = []
  for (const entry of entries) {
    if (entry.type !== 'directory' || entry.name.startsWith('.')) continue
    try {
      const program = await readProgram(cwd, entry.name)
      programs.push(await evaluateProgram(cwd, program, workspaceState))
    } catch (error) {
      warnings.push(`${entry.name}: ${error.message}`)
    }
  }
  programs.sort((a, b) => String(a.created).localeCompare(String(b.created)) || a.title.localeCompare(b.title))
  return { programs, warnings }
}

/**
 * Write a normalized program.
 * @param {string} cwd
 * @param {Program} program
 */
/**
 * Persist the latest per-session context occupancy for PM review. This is a
 * runtime snapshot, not part of program.json; the panel refreshes it before a
 * PM turn and the PM prompt reads it back as evidence.
 *
 * @param {string} cwd
 * @param {string} programId
 * @param {any[]} contexts
 */
export async function writePmContext(cwd, programId, contexts) {
  const entries = (Array.isArray(contexts) ? contexts : [])
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      task: typeof entry.task === 'string' ? entry.task : '',
      role: typeof entry.role === 'string' ? entry.role : '',
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
      usedTokens: Number.isFinite(entry.usedTokens) ? entry.usedTokens : null,
      contextWindow: Number.isFinite(entry.contextWindow) ? entry.contextWindow : null,
      percent: Number.isFinite(entry.percent) ? entry.percent : null,
      updatedAt: new Date().toISOString(),
    }))
  await writeText(
    cwd,
    joinRel(programRel(programId), 'pm', 'context.json'),
    `${JSON.stringify({ contexts: entries }, null, 2)}\n`,
  )
  return entries
}

/** Read the latest context snapshot, tolerating a missing/corrupt file. */
async function readPmContext(cwd, programId) {
  try {
    const text = await readTextOrNull(cwd, joinRel(programRel(programId), 'pm', 'context.json'))
    if (text === null) return []
    const parsed = JSON.parse(text)
    return Array.isArray(parsed?.contexts) ? parsed.contexts : []
  } catch {
    return []
  }
}

export async function writeProgram(cwd, program) {
  const normalized = normalizeProgram(program)
  await writeText(cwd, joinRel(programRel(normalized.id), 'program.json'), `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

/**
 * Create a program and scaffold one native change per child task.
 *
 * The scaffold contains only `.openspec.yaml`; the product role is expected to
 * write proposal / specs / tasks. Existing changes are never overwritten.
 *
 * @param {string} cwd
 * @param {any} input
 * @param {{date?: string}} [options]
 * @returns {Promise<Program>}
 */
export async function createProgram(cwd, input, { date = formatLocalDate() } = {}) {
  if (input === null || typeof input !== 'object') throw new Error('缺少多角色任务定义')
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title === '') throw new Error('任务标题不能为空')
  const id = isValidId(input.id) ? input.id : slugifyId(title)
  if (!isValidId(id)) throw new Error('program id 无效，请填写一个英文 id（例如 skill-system）')
  if (await pathExists(cwd, programRel(id))) throw new Error(`多角色任务已存在：${id}`)
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error('至少需要一个子任务')

  await ensureSkeleton(cwd)
  const projectConfig = await readProjectConfig(cwd)
  const schema = resolveSchemaName({ projectConfig })
  const tasks = input.tasks.map((task, index) => {
    const fallback = `${id}-${index + 1}`
    return {
      ...task,
      id: isValidId(task?.id) ? task.id : fallback,
      change: isValidId(task?.change) ? task.change : (isValidId(task?.id) ? task.id : fallback),
    }
  })
  const program = normalizeProgram({
    id,
    title,
    goal: typeof input.goal === 'string' ? input.goal : '',
    created: date,
    roles: input.roles,
    auto: input.auto !== false,
    tasks,
  })

  for (const task of program.tasks) {
    const changeDir = joinRel('openspec', 'changes', task.change)
    if (await pathExists(cwd, changeDir)) {
      throw new Error(`change 已存在，拒绝覆盖：${task.change}`)
    }
  }
  for (const task of program.tasks) {
    await writeText(
      cwd,
      joinRel('openspec', 'changes', task.change, '.openspec.yaml'),
      serializeChangeMetadata({ schema, created: date, goal: task.title }),
    )
  }
  await writeText(cwd, joinRel(programRel(id), 'program.json'), `${JSON.stringify(program, null, 2)}\n`)
  await writeText(cwd, joinRel(programRel(id), 'handoffs', '.gitkeep'), '')
  return program
}

/**
 * Mark development complete when the dev role says implementation is done and
 * only manual-acceptance checkboxes remain.
 */
export async function markDevelopmentDone(cwd, programId, taskId) {
  const program = await readProgram(cwd, programId)
  const task = program.tasks.find((entry) => entry.id === taskId)
  if (task === undefined) throw new Error(`找不到子任务：${taskId}`)
  task.developmentDone = true
  return writeProgram(cwd, program)
}

/**
 * Enable/disable the optional art/design role for one task.
 * @param {string} cwd
 * @param {string} programId
 * @param {string} taskId
 * @param {boolean} enabled
 * @returns {Promise<Program>}
 */
export async function updateTaskDesign(cwd, programId, taskId, enabled) {
  const program = await readProgram(cwd, programId)
  const task = program.tasks.find((entry) => entry.id === taskId)
  if (task === undefined) throw new Error(`找不到子任务：${taskId}`)
  const roles = new Set(task.roles)
  if (enabled === true) roles.add('design')
  else roles.delete('design')
  task.roles = ROLE_IDS.filter((role) => roles.has(role))
  if (task.roles.length === 0) throw new Error('子任务至少需要一个角色')
  return writeProgram(cwd, program)
}

/**
 * Toggle the automatic coordinator for one program.
 * @param {string} cwd
 * @param {string} programId
 * @param {boolean} auto
 * @returns {Promise<Program>}
 */
export async function updateProgramAuto(cwd, programId, auto) {
  const program = await readProgram(cwd, programId)
  program.auto = auto === true
  return writeProgram(cwd, program)
}

/**
 * Update final acceptance for one task.
 * @param {string} cwd
 * @param {string} programId
 * @param {string} taskId
 * @param {boolean} accepted
 * @returns {Promise<Program>}
 */
export async function acceptTask(cwd, programId, taskId, accepted) {
  const program = await readProgram(cwd, programId)
  const task = program.tasks.find((entry) => entry.id === taskId)
  if (task === undefined) throw new Error(`找不到子任务：${taskId}`)
  task.accepted = accepted === true
  return writeProgram(cwd, program)
}

/**
 * Update role provider/model assignments.
 * @param {string} cwd
 * @param {string} programId
 * @param {Record<string, {provider?: string, model?: string}>} roles
 * @returns {Promise<Program>}
 */
export async function updateProgramRoles(cwd, programId, roles) {
  const program = await readProgram(cwd, programId)
  for (const role of MODEL_ROLE_IDS) {
    if (roles !== null && typeof roles === 'object' && roles[role] !== undefined) {
      const value = roles[role]
      const current = program.roles[role] ?? { provider: '', model: '', label: ROLE_DEFINITIONS[role].label, skills: [] }
      const currentSkills = Array.isArray(current.skills) ? current.skills : []
      program.roles[role] = {
        ...current,
        provider: typeof value.provider === 'string' ? value.provider.trim() : current.provider,
        model: typeof value.model === 'string' ? value.model.trim() : current.model,
        skills: Array.isArray(value.skills)
          ? [...new Set(value.skills.filter((name) => typeof name === 'string').map((name) => name.trim()).filter(Boolean))]
          : currentSkills,
      }
    }
  }
  return writeProgram(cwd, program)
}

/**
 * Find an artifact status by id.
 * @param {any} change
 * @param {string} id
 * @returns {string|null}
 */
function artifactStatus(change, id) {
  const artifacts = Array.isArray(change?.artifacts) ? change.artifacts : []
  return artifacts.find((artifact) => artifact?.id === id)?.status ?? null
}

/**
 * Whether the product contract is complete for one change.
 * @param {any} change
 * @returns {boolean}
 */
function productDone(change) {
  if (change === undefined || change === null) return false
  const docs = Array.isArray(change.docs) ? change.docs : []
  const hasDoc = (suffix) => docs.some((doc) => typeof doc.path === 'string' && doc.path.endsWith(suffix))
  const proposal = artifactStatus(change, 'proposal') === 'done' || hasDoc('/proposal.md')
  const specs =
    ['done', 'skipped'].includes(artifactStatus(change, 'specs')) ||
    change.metadata?.skip_specs === true ||
    docs.some((doc) => doc.kind === 'delta')
  const tasks = Number(change.tasks?.total ?? 0) > 0
  return proposal && specs && tasks
}

/**
 * Whether the design contract is complete for one change.
 * @param {any} change
 * @returns {boolean}
 */
function designDone(change) {
  if (change === undefined || change === null) return false
  if (artifactStatus(change, 'design') === 'done') return true
  const docs = Array.isArray(change.docs) ? change.docs : []
  return docs.some((doc) => typeof doc.path === 'string' && doc.path.endsWith('/design.md'))
}

/**
 * Evaluate one program against the current workspace state.
 *
 * This is the coordination contract:
 * - product may start when task dependencies are complete;
 * - design/dev need the product contract;
 * - test needs design + all dev tasks;
 * - user acceptance needs the test report.
 *
 * @param {string} cwd
 * @param {Program} program
 * @param {any} workspaceState
 * @returns {Promise<any>}
 */
export async function evaluateProgram(cwd, program, workspaceState) {
  const changes = new Map((workspaceState?.changes ?? []).map((change) => [change.name, change]))
  const base = new Map()
  for (const task of program.tasks) {
    const change = changes.get(task.change)
    const report = await pathExists(cwd, joinRel('openspec', 'changes', task.change, 'qa', 'dev-done.md'))
    const product = productDone(change)
    const design = product && designDone(change)
    const allChecked =
      Number(change?.tasks?.total ?? 0) > 0 && change?.tasks?.done === change?.tasks?.total
    // Manual-acceptance checkboxes intentionally stay unchecked; dev may finish
    // by writing qa/dev-done.md or by the panel's explicit completion action.
    const dev = Number(change?.tasks?.total ?? 0) > 0 && (allChecked || task.developmentDone === true || report)
    const needsDesign = task.roles.includes('design')
    const done = {
      product,
      design,
      dev,
      test: dev,
      user: task.accepted === true,
    }
    base.set(task.id, { change, report, done })
  }

  const roleState = (task) => {
    const info = base.get(task.id)
    if (info.done.dev) return { status: 'done', ready: true, done: true, missing: [] }
    const dependencyTasks = task.dependsOn
      .map((id) => program.tasks.find((entry) => entry.id === id))
      .filter(Boolean)
    const depMissing = dependencyTasks.filter((dep) => base.get(dep.id)?.done.dev !== true)
    const depsReady = depMissing.length === 0
    const missing = []
    if (!depsReady) missing.push(`等待依赖：${depMissing.map((dep) => dep.title).join('、')}`)
    return { status: depsReady ? 'ready' : 'waiting', ready: depsReady, done: false, missing }
  }

  const tasks = program.tasks.map((task) => {
    const info = base.get(task.id)
    const roles = { dev: roleState(task) }
    const doneCount = roles.dev.done ? 1 : 0
    const anyStarted = Number(info.change?.tasks?.done ?? 0) > 0
    const docs = Array.isArray(info.change?.docs) ? info.change.docs : []
    const hasDoc = (suffix) => docs.some((doc) => typeof doc.path === 'string' && doc.path.endsWith(suffix))
    const lifecycle = {
      proposal: artifactStatus(info.change, 'proposal') === 'done' || hasDoc('/proposal.md'),
      specs:
        ['done', 'skipped'].includes(artifactStatus(info.change, 'specs')) ||
        info.change?.metadata?.skip_specs === true ||
        docs.some((doc) => doc.kind === 'delta'),
      design: info.done.design,
      tasks: Number(info.change?.tasks?.total ?? 0) > 0,
      apply: info.done.dev,
      accepted: task.accepted === true,
    }
    return {
      ...task,
      roleIds: [...task.roles],
      lifecycle,
      changeExists: info.change !== undefined,
      summary: info.change?.summary?.headline ?? '',
      progress: {
        done: Number(info.change?.tasks?.done ?? 0),
        total: Number(info.change?.tasks?.total ?? 0),
      },
      roles,
      status: task.accepted
        ? 'accepted'
        : doneCount === 1
          ? 'done'
          : anyStarted
            ? 'active'
            : 'pending',
    }
  })
  const accepted = tasks.filter((task) => task.accepted).length
  const pmStatus = await readTextOrNull(cwd, joinRel(programRel(program.id), 'pm', 'status.md'))
  return {
    ...program,
    auto: program.auto === true,
    pmStatus: pmStatus === null ? '' : pmStatus.slice(0, 6000),
    tasks,
    progress: {
      accepted,
      total: tasks.length,
      done: tasks.filter((task) => task.status === 'done').length,
    },
  }
}

/** Maximum characters kept from one context document. */
const CONTEXT_CHARS = 3200

/**
 * Read one artifact as a bounded, labelled context block.
 * @param {string} cwd
 * @param {string} rel
 * @param {string} label
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
async function artifactRef(cwd, rel, label) {
  const exists = await pathExists(cwd, rel)
  return `- ${label}: \`${rel}\`${exists ? '' : '（尚未生成）'}`
}

/**
 * Read role handoffs for one task, optionally filtered by role.
 * @param {string} cwd
 * @param {string} programId
 * @param {string} taskId
 * @param {string[]} [roles]
 * @returns {Promise<string>}
 */
async function handoffBlocks(cwd, programId, taskId, roles = ROLE_IDS) {
  const blocks = []
  for (const role of roles) {
    const rel = joinRel(programRel(programId), 'handoffs', `${taskId}-${role}.md`)
    blocks.push(await artifactRef(cwd, rel, `${ROLE_DEFINITIONS[role].label}交接`))
  }
  return blocks.length === 0 ? '（暂无交接）\n' : blocks.join('\n')
}

/**
 * Build the role prompt from file artifacts only.
 *
 * The prompt deliberately does not include other agents' conversations. It
 * includes the program goal, the current task, dependency handoffs, and bounded
 * excerpts of the artifacts this role is allowed to consume.
 *
 * @param {string} cwd
 * @param {any} program evaluated program
 * @param {any} task evaluated task
 * @param {string} role one of ROLE_IDS
 * @param {any} workspaceState
 * @returns {Promise<string>}
 */
export async function buildRolePrompt(cwd, program, task, role, workspaceState) {
  if (!ROLE_IDS.includes(role)) throw new Error(`未知角色：${role}`)
  const def = ROLE_DEFINITIONS[role]
  const change = (workspaceState?.changes ?? []).find((entry) => entry.name === task.change)
  const changeDir = joinRel('openspec', 'changes', task.change)
  const specDocs = Array.isArray(change?.docs)
    ? change.docs.filter((doc) => doc.artifactId === 'specs').slice(0, 4)
    : []

  const context = []
  context.push(`### 任务说明\n${task.description || task.title}\n`)
  context.push(await artifactRef(cwd, joinRel(changeDir, 'proposal.md'), 'proposal'))
  for (const doc of specDocs) context.push(await artifactRef(cwd, doc.path, `规格：${doc.label}`))
  context.push(await artifactRef(cwd, joinRel(changeDir, 'design.md'), '设计文档（如存在）'))
  context.push(await artifactRef(cwd, joinRel(changeDir, 'tasks.md'), '任务清单'))

  const dependencyNotes = task.dependsOn.length === 0
    ? '无'
    : task.dependsOn.map((id) => {
        const dep = program.tasks.find((entry) => entry.id === id)
        return `${id}（${dep?.title ?? id}）`
      }).join('、')

  // Dependencies are contracts, so every role sees their proposal/spec/design
  // and handoff summary. This is intentionally not the dependency's transcript.
  for (const depId of task.dependsOn.slice(0, 3)) {
    const dep = program.tasks.find((entry) => entry.id === depId)
    if (dep === undefined) continue
    const depDir = joinRel('openspec', 'changes', dep.change)
    context.push(`### 依赖任务：${dep.title}（${dep.id}）\n`)
    context.push(await artifactRef(cwd, joinRel(depDir, 'proposal.md'), `依赖 ${depId} 的 proposal`))
    const depChange = (workspaceState?.changes ?? []).find((entry) => entry.name === dep.change)
    const depSpecs = Array.isArray(depChange?.docs)
      ? depChange.docs.filter((doc) => doc.artifactId === 'specs').slice(0, 2)
      : []
    for (const doc of depSpecs) context.push(await artifactRef(cwd, doc.path, `依赖 ${depId} 的规格：${doc.label}`))
    context.push(await artifactRef(cwd, joinRel(depDir, 'design.md'), `依赖 ${depId} 的设计`))
  }

  const roleRules = {
    product: [
      `在 \`${changeDir}/proposal.md\` 写清楚 Why / What Changes，在 \`${changeDir}/specs/<capability>/spec.md\` 写 delta 规格与验收场景。`,
      `在 \`${changeDir}/tasks.md\` 写出可执行的任务清单，必须包含功能验收项；需要人工验收的任务以 \`[人工验收]\` 开头。`,
      '不要修改代码，也不要写 design.md、视觉规范或交互实现细节；这些由设计角色负责。',
      '如果需要跳过 specs（例如纯视觉任务），把 `.openspec.yaml` 的 `skip_specs` 设为 true，并在 proposal 里说明原因。',
    ],
    design: [
      `在 \`${changeDir}/design.md\` 写技术/视觉设计：交互、状态、组件、资源、动效、验收要点。`,
      `如需要，补充 \`${changeDir}/design/visual.md\` 或资源清单；不要写业务代码。`,
      '视觉规范必须可执行、可检查；不要只写“好看”“高级”这类主观描述。',
    ],
    dev: [
      `按 \`${changeDir}/tasks.md\` 实现；每完成一项就把复选框改为 \`[x]\`，不要批量假装完成。`,
      '先读取 proposal / specs / design / tasks.md；如果这些文档缺失，先补齐再实现，不要直接进入代码。',
      '不要勾选以 `[人工验收]` 开头的任务，它们必须留给用户最终确认。',
      '当所有非人工验收任务都完成、且只剩 `[人工验收]` 项时，写 `qa/dev-done.md` 说明已实现内容、如何验证、剩余人工验收项；这是一次明确的开发完成信号。',
      '完成后在 handoff 里列出未完成任务、阻塞点和测试建议。',
    ],
    test: [
      `在 \`${changeDir}/qa/report.md\` 写测试报告：功能、视觉、复现步骤、命令、结果、未覆盖项。`,
      '不要代替用户做最终验收，也不要把 `[人工验收]` 任务标成通过；你只给证据和建议。',
      '发现 bug 时写到报告并给出最小复现，不要静默修改产品行为。',
    ],
  }

  const lines = [
    '你在 OpenSpec 中负责开发实现这个子任务，不扮演产品、设计或测试角色。',
    '',
    '## 工作原则',
    '',
    '- 不修改其他子任务的 change；产品代码只写本任务需要的文件；',
    '- 产物是事实源；如果某个文件不存在，就明确报告缺失，不要假设它已经完成。',
    '',
    '## OpenSpec 流程',
    '',
    '- 当前子任务是一个完整的 OpenSpec change：proposal → specs → design（可选）→ tasks → apply → 用户验收；',
    '- 文档缺失时由你先补齐或更新，再实现；进度以 `openspec/changes/<change>/` 与 tasks.md 为准。',
    '',
    '## 写入规则',
    '',
    '- 所有文件写入必须使用 `openspec_write_file`，不要用原生 `write` / `edit` / shell 重定向写文件；',
    '- 覆盖已有文件前先用 `openspec_read_file` 取得 `sha256`，写入时传 `expectedSha256`；',
    '- 如果返回写入冲突，不要绕过或反复覆盖；先重新读取，仍冲突就写进 `qa/dev-done.md` 的阻塞项，交给 PM 决策。',
    '',
    '## 程序目标',
    '',
    `- 程序：${program.title}（${program.id}）`,
    `- 目标：${program.goal || '（未填写，按任务说明执行）'}`,
    `- 当前子任务：${task.title}（${task.id}）`,
    `- change：${task.change}`,
    `- 依赖：${dependencyNotes}`,
    '',
    '## 工作依据',
    '',
    '- 你的工作必须围绕当前 change 的 OpenSpec 文档：proposal、delta specs、design（如存在）、tasks.md 与验收标准；',
    '- 开工前先按路径读取相关文档；缺失或冲突时先补齐文档，不要绕过文档直接写代码；',
    '- 代码实现必须能追溯到 tasks.md / specs；完成后同步更新 tasks.md。',
    '',
    '## 你的职责',
    '',
    `- ${def.summary}`,
    ...roleRules[role].map((rule) => `- ${rule}`),
    '',
    '## 可用上下文',
    '',
    '以下工件只给文件路径，不内联正文；需要时用读取工具打开具体文件，不要假设内容已经在提示词里。',
    '',
    ...context,
    '',
    ...(Array.isArray(program.roles?.[role]?.skills) && program.roles[role].skills.length > 0
      ? [
          '## 建议优先使用的 agent skills',
          '',
          `本角色建议优先使用以下 agent skills：${program.roles[role].skills.map((name) => `\`${name}\``).join('、')}。`,
          '当任务与这些 skill 的用途匹配时，主动通过 `skill` 工具加载并遵循其说明；如果任务不匹配，不必强行使用，也不需要为了用 skill 而偏离任务。',
          '',
        ]
      : []),
    '## 完成信号',
    '',
    '所有非人工验收项完成后，写 `qa/dev-done.md`，内容包含：已实现内容、验证方式、剩余人工验收项、阻塞。',
    '写完即视为开发完成，面板会把它作为进入用户验收的依据；不要勾选 `[人工验收]` 项。',
    '最终回复用一个简短段落总结本次产物与下一步；不要重复粘贴文件全文。',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * PM prompt for ordinary OpenSpec changes (no program/role layer).
 * @param {string} cwd
 * @param {any} workspaceState
 * @returns {Promise<string>}
 */
export async function buildWorkspacePmPrompt(cwd, workspaceState) {
  const statusPath = 'openspec/pm/status.md'
  const changes = (workspaceState?.changes ?? []).filter((change) => change?.archived !== true)
  const lines = [
    '你是这个 OpenSpec 工作区的 PM，负责管理普通 OpenSpec changes，不创建多角色程序。',
    '',
    '## 当前变更',
    '',
  ]
  if (changes.length === 0) {
    lines.push('（当前没有活动变更）')
  } else {
    for (const change of changes) {
      lines.push(`### ${change.name}`)
      const artifacts = (change.artifacts ?? []).map((artifact) => `${artifact.id}:${artifact.status}`).join('、')
      lines.push(`- 工件：${artifacts || '无'}`)
      lines.push(`- 任务：${change.tasks?.done ?? 0}/${change.tasks?.total ?? 0}`)
      const pending = (change.tasks?.items ?? []).filter((task) => task.done !== true).slice(0, 20)
      for (const task of pending) lines.push(`  - [ ] ${task.text ?? task.id ?? ''}`)
      if (pending.length > 0) lines.push('')
    }
  }
  lines.push(
    '## 你的职责',
    '',
    '- 找出阻塞、未完成工件、未勾选任务和跨变更依赖；',
    '- 用户要求调整方向/细节时，先确认理解与影响，再更新对应 `openspec/changes/<change>/` 文档与 tasks.md；',
    '- 需要用户拍板时直接提问，不要自己猜；',
    '- 不写业务代码，不代替用户验收。',
    '',
    '## 输出',
    '',
    `把不超过 600 字的巡检报告写到 \`${statusPath}\`，包含：当前阶段、阻塞/风险、下一步、需要用户决策的事项。`,
    '最终回复只给一段简短结论，不要粘贴大段文件内容。',
  )
  return `${lines.join('\n')}\n`
}

/**
 * Build the PM oversight prompt. The deterministic scheduler in the panel is
 * the PM's "hands"; this prompt gives the PM a compact status snapshot and asks
 * for a short review/blocker report.
 *
 * @param {string} cwd
 * @param {any} program evaluated program
 * @returns {Promise<string>}
 */
export async function buildPmPrompt(cwd, program) {
  const statusPath = joinRel(programRel(program.id), 'pm', 'status.md')
  const taskLines = []
  for (const task of program.tasks) {
    const roleBits = ROLE_IDS.map((role) => {
      const gate = task.roles?.[role]
      if (gate === undefined) return null
      const missing = Array.isArray(gate.missing) && gate.missing.length > 0 ? `（${gate.missing.join('；')}）` : ''
      return `${ROLE_DEFINITIONS[role].label}:${gate.done === true ? '完成' : gate.ready === true ? '可开始' : '等待'}${missing}`
    }).filter(Boolean)
    taskLines.push(
      `- ${task.title} (${task.id}, ${task.change})：${task.status}，任务 ${task.progress?.done ?? 0}/${task.progress?.total ?? 0}；${roleBits.join(' | ')}`,
    )
  }
  const contextUsage = await readPmContext(cwd, program.id)
  const conflicts = await readTextOrNull(cwd, joinRel(programRel(program.id), 'pm', 'conflicts.md'))
  return [
    '你是这个多角色项目的项目经理（PM）。',
    '',
    '## 程序目标',
    '',
    `- 程序：${program.title}（${program.id}）`,
    `- 目标：${program.goal || '（未填写）'}`,
    `- 自动推进：${program.auto === true ? '已开启（Host 会按门禁启动已就绪角色）' : '已暂停'}`,
    `- 进度：${program.progress?.accepted ?? 0}/${program.tasks.length} 已验收，${program.progress?.done ?? 0} 个任务完成`,
    '',
    '## 当前矩阵',
    '',
    ...taskLines,
    '',
    ...(contextUsage.length > 0
      ? [
          '## 角色会话上下文用量',
          '',
          ...contextUsage.map((entry) => {
            const label = `${entry.task || '?'} / ${entry.role || '?'}`
            const percent = Number.isFinite(entry.percent) ? `${entry.percent}%` : '未知'
            const figures =
              Number.isFinite(entry.usedTokens) && Number.isFinite(entry.contextWindow)
                ? `（${entry.usedTokens} / ${entry.contextWindow} tokens）`
                : ''
            return `- ${label}：${percent}${figures}`
          }),
          '',
          '超过 80% 时，建议在该角色会话执行 `/compact`；超过 90% 或压缩不可用时，建议先写好 handoff，再开新会话继续，避免上下文溢出。',
          '',
        ]
      : []),
    ...(conflicts !== null && conflicts.trim() !== ''
      ? [
          '## 写入冲突记录',
          '',
          conflicts.slice(0, 6000),
          '',
          '对每个冲突给出决策：允许覆盖、要求重新读取、拆分共享文件，或让一方开新会话重做；不要忽略。',
          '',
        ]
      : []),
    '## 你的职责',
    '',
    '- 检查各任务的产品规格、设计、开发任务与测试报告是否足以进入下一阶段；',
    '- 指出跨任务的冲突、遗漏、依赖风险，以及需要用户决策的事项；',
    '- 不要写业务代码，不要代替用户做最终验收；',
    '- 自动推进由 Host 按工件门禁执行；你负责巡检、发现阻塞、建议下一步，并在用户提出调整时更新项目文档；',
    '',
    '## 与用户协作',
    '',
    '- 用户随时可能提出方向或细节调整；先确认理解与影响，再更新 `pm/status.md` 和相关 change 的 proposal / specs / design / tasks；',
    '- 需要用户拍板时，使用 ask_user 工具或写 `pm/questions.md`，不要自己猜；',
    '- 涉及任务增删、依赖关系或 `program.json` 结构时，先给出调整方案并等待用户确认，不要静默修改。',
    '',
    ...(Array.isArray(program.roles?.pm?.skills) && program.roles.pm.skills.length > 0
      ? [
          '## 建议优先使用的 agent skills',
          '',
          `PM 建议优先使用以下 agent skills：${program.roles.pm.skills.map((name) => `\`${name}\``).join('、')}。`,
          '当巡检任务与这些 skill 的用途匹配时，主动加载并遵循；不匹配时不必强行使用。',
          '',
        ]
      : []),
    '## 输出',
    '',
    `把不超过 600 字的巡检报告写到 \`${statusPath}\`，包含：当前阶段、已完成、阻塞/风险、下一步、需要用户决策的事项。`,
    '最终回复只给一段简短结论；不要粘贴大段文件内容。',
  ].join('\n') + '\n'
}
