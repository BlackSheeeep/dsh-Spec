/**
 * dsh-spec — Host half.
 *
 * Bridges the OpenSpec workflow into DSH:
 * - `/openspec-init`   create the `openspec/` skeleton in the session workspace
 * - `/opsx-explore`    submit the explore prompt (thinking mode, no writes)
 * - `/opsx-propose`    submit the propose prompt (creates the change folder)
 * - `/opsx-apply`      submit the apply prompt (works through tasks.md)
 * - `/opsx-archive`    submit the archive prompt (sync specs, move to archive/)
 * - `/opsx-status`     direct status text, no model message
 *
 * The phase commands submit an ordinary user message via `agent.followup()`
 * (the shipped `/plan` and `/goal` commands use the same mechanism), so the
 * model sees the workflow instruction as the user's request. The monitoring
 * state itself lives only in the workspace files — the plugin derives
 * everything from `openspec/` and stores nothing of its own.
 *
 * File access goes through `ctx.fs` (the harness filesystem seam) so sandbox
 * policy stays in charge; the working directory comes from the
 * `workingDirectory` service, like the shipped working-directory tool.
 *
 * @module dsh-spec
 */

import { randomUUID } from 'node:crypto'

import {
  applyPrompt,
  archivePrompt,
  derivePhase,
  explorePrompt,
  firstToken,
  parseTasks,
  proposePrompt,
  restAfterFirstToken,
  slugify,
} from './prompts.js'

/** Cordis plugin name; also the service key provided to other plugins. */
export const name = 'openSpec'

/** `commands` registers the slash commands, `fs` does bounded workspace file work, `workingDirectory` resolves the session root. */
export const inject = ['commands', 'fs', 'workingDirectory']

/** Generated `openspec/config.yaml` seed. Project facts go to `context`; the AI reads it in every phase. */
const CONFIG_YAML = [
  'schema: spec-driven',
  '',
  '# OpenSpec 项目上下文（由 dsh-spec /openspec-init 生成）。',
  '# 用简洁的项目级事实填充：技术栈、运行方式、关键目录、团队约定。',
  '# AI 在 explore / propose / apply / archive 每个阶段都会读取这里。',
  'context: |',
  '  （在此填写项目级事实，例如：技术栈、启动命令、目录结构、代码约定）',
  '',
].join('\n')

/** Short zh explanation of the OpenSpec tree for DSH-only users. */
const README_MD = [
  '# openspec/',
  '',
  'OpenSpec 规格驱动开发的工作目录（由 DSH 插件 dsh-spec 初始化）。',
  '',
  '```text',
  'openspec/',
  '├── config.yaml        项目上下文：技术栈、约定、关键目录',
  '├── specs/             已定稿的能力规格（当前行为的真相源）',
  '└── changes/           进行中的变更，一个文件夹一个变更',
  '    ├── <change-name>/  proposal.md + specs/ + tasks.md（+ design.md）',
  '    └── archive/        完成并归档的变更',
  '```',
  '',
  '工作循环：/opsx-explore 想清楚 → /opsx-propose 写计划 → 人工评审 →',
  '/opsx-apply 逐项实现并勾选 tasks.md → /opsx-archive 同步 specs 并归档。',
  '进度只存在于 tasks.md 的复选框里，没有隐藏状态。',
  '',
].join('\n')

/** Marker that also materializes the empty official directories. */
const KEEP = ''

/** Wrap one handler so expected failures become direct command errors. */
function safe(handler) {
  return async (invocation) => {
    try {
      return await handler(invocation)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `OpenSpec 命令失败：${message}` }
    }
  }
}

/** Resolve the session's working directory the way the shipped tool does. */
async function resolveCwd(ctx, agent) {
  const wd = ctx.workingDirectory
  if (wd && typeof wd.ensure === 'function') {
    try {
      const value = await wd.ensure(agent)
      if (value) return value
    } catch {
      /* fall through to the read-only getter */
    }
  }
  if (wd && typeof wd.get === 'function') {
    const value = wd.get(agent)
    if (value) return value
  }
  throw new Error('无法确定当前会话的工作目录')
}

/** List one workspace-relative directory as `{name, type}` rows; throws when absent. */
async function listNames(ctx, cwd, rel, signal) {
  const target = await ctx.fs.resolve(rel, { cwd, signal })
  const entries = await ctx.fs.listDir(target, signal)
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.type ?? 'other',
  }))
}

/** Read one workspace-relative text file, or `null` when it cannot be read. */
async function readTextOrNull(ctx, cwd, rel, signal) {
  try {
    const target = await ctx.fs.resolve(rel, { cwd, signal })
    return await ctx.fs.readText(target, signal)
  } catch {
    return null
  }
}

/** Write one workspace-relative file; returns whether a new file was created. */
async function ensureFile(ctx, cwd, rel, content, signal) {
  const existing = await readTextOrNull(ctx, cwd, rel, signal)
  if (existing !== null) return false
  const target = await ctx.fs.resolve(rel, { cwd, signal })
  await ctx.fs.writeText(target, content, undefined, signal)
  return true
}

/** Directory existence probe for one workspace-relative path. */
async function dirExists(ctx, cwd, rel, signal) {
  try {
    await listNames(ctx, cwd, rel, signal)
    return true
  } catch {
    return false
  }
}

/** Derive one change folder's workflow state from its files. */
async function changeState(ctx, cwd, changeName, signal) {
  const base = `openspec/changes/${changeName}`
  const files = await listNames(ctx, cwd, base, signal)
  const names = files.map((file) => file.name)
  const hasProposal = names.includes('proposal.md')
  const hasSpecs = files.some((file) => file.type === 'directory' && file.name === 'specs')
  let tasks = null
  if (names.includes('tasks.md')) {
    const text = await readTextOrNull(ctx, cwd, `${base}/tasks.md`, signal)
    if (text !== null) tasks = parseTasks(text)
  }
  return {
    name: changeName,
    phase: derivePhase({ hasProposal, hasSpecs, tasks }),
    tasks,
    files: names.slice(0, 12),
  }
}

/** Full workspace workflow state, derived only from `openspec/`. */
async function openspecState(ctx, cwd, signal) {
  let tops
  try {
    tops = await listNames(ctx, cwd, 'openspec/changes', signal)
  } catch {
    return { initialized: false }
  }
  const changes = []
  let archived = 0
  for (const entry of tops) {
    if (entry.type !== 'directory') continue
    if (entry.name === 'archive') {
      try {
        archived = (await listNames(ctx, cwd, 'openspec/changes/archive', signal))
          .filter((child) => child.type === 'directory').length
      } catch {
        archived = 0
      }
      continue
    }
    try {
      changes.push(await changeState(ctx, cwd, entry.name, signal))
    } catch {
      /* unreadable folder: skip rather than fail the whole state */
    }
  }
  return { initialized: true, changes, archived }
}

/** One ordinary user message carrying the phase prompt (plain shape, no dsh imports). */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Submit the prompt as the user's request and answer the command directly. */
function submit(agent, prompt, label) {
  if (typeof agent?.followup !== 'function') {
    throw new Error('当前会话不能接受命令提交（agent.followup 不可用）')
  }
  agent.followup(userMessage(prompt))
  return { kind: 'success', text: label }
}

/** Idempotent skeleton initialization; returns the direct result text. */
async function runInit(ctx, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const created = []
  if (await ensureFile(ctx, cwd, 'openspec/config.yaml', CONFIG_YAML, invocation.signal)) created.push('openspec/config.yaml')
  if (await ensureFile(ctx, cwd, 'openspec/README.md', README_MD, invocation.signal)) created.push('openspec/README.md')
  if (await ensureFile(ctx, cwd, 'openspec/specs/.gitkeep', KEEP, invocation.signal)) created.push('openspec/specs/')
  if (await ensureFile(ctx, cwd, 'openspec/changes/.gitkeep', KEEP, invocation.signal)) created.push('openspec/changes/')
  if (await ensureFile(ctx, cwd, 'openspec/changes/archive/.gitkeep', KEEP, invocation.signal)) created.push('openspec/changes/archive/')
  if (created.length === 0) {
    return { kind: 'success', text: 'OpenSpec 已初始化过，没有需要补建的文件。用 /opsx-status 查看当前状态。' }
  }
  return {
    kind: 'success',
    text: `OpenSpec 骨架已就绪（新建：${created.join('、')}）。\n下一步：/opsx-explore 想清楚，或 /opsx-propose <change-name> 直接写计划。监控面板会自动显示 openspec/ 的状态。`,
  }
}

async function runExplore(ctx, invocation) {
  const topic = String(invocation.rawInput ?? '').trim()
  return submit(
    invocation.agent,
    explorePrompt(topic),
    `已向会话发送 OpenSpec 探索任务${topic ? `（主题：${topic}）` : ''}。这是纯思考模式，不会改动文件。`,
  )
}

async function runPropose(ctx, invocation) {
  const changeName = slugify(firstToken(invocation.rawInput))
  if (!changeName) {
    return { kind: 'error', text: '用法：/opsx-propose <change-name> [说明]——例如 /opsx-propose add-dark-mode 支持深色主题' }
  }
  const cwd = await resolveCwd(ctx, invocation.agent)
  const intent = restAfterFirstToken(invocation.rawInput)
  const state = await openspecState(ctx, cwd, invocation.signal)
  if (!state.initialized) await runInit(ctx, invocation)
  if (await dirExists(ctx, cwd, `openspec/changes/${changeName}`, invocation.signal)) {
    return { kind: 'error', text: `变更 openspec/changes/${changeName}/ 已存在。要继续实现请用 /opsx-apply ${changeName}；要修改计划，直接让 AI 更新该文件夹里的工件。` }
  }
  return submit(
    invocation.agent,
    proposePrompt(changeName, intent),
    `已发送提案任务：AI 将创建 openspec/changes/${changeName}/（proposal + specs + tasks），写完计划会停下等你评审。面板中可跟踪进度。`,
  )
}

/** Resolve the change a phase command should act on from the argument and live state. */
async function pickChange(ctx, invocation, state) {
  const asked = slugify(firstToken(invocation.rawInput))
  if (asked) {
    const match = state.changes.find((change) => change.name === asked)
    if (!match) {
      const known = state.changes.map((change) => change.name).join('、') || '（无）'
      throw new Error(`找不到变更 "${asked}"。进行中的变更：${known}`)
    }
    return match
  }
  if (state.changes.length === 0) throw new Error('没有进行中的变更，先用 /opsx-propose <change-name> 创建一个。')
  if (state.changes.length > 1) {
    const known = state.changes.map((change) => change.name).join('、')
    throw new Error(`有 ${state.changes.length} 个进行中的变更（${known}），请指定：/opsx-… ${state.changes[0].name}`)
  }
  return state.changes[0]
}

async function runApply(ctx, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const state = await openspecState(ctx, cwd, invocation.signal)
  if (!state.initialized) return { kind: 'error', text: '此工作区还没有 openspec/。先运行 /openspec-init 或用面板的一键初始化。' }
  let change
  try {
    change = await pickChange(ctx, invocation, state)
  } catch (error) {
    return { kind: 'error', text: `OpenSpec 命令失败：${error.message}` }
  }
  if (change.phase === 'draft') {
    return { kind: 'error', text: `变更 ${change.name} 还没有 proposal/tasks，先 /opsx-propose ${change.name} 或手动补全计划。` }
  }
  const note = change.phase === 'ready' ? '（tasks.md 已全部勾选，AI 会做最终核对）' : ''
  return submit(
    invocation.agent,
    applyPrompt(change.name, change.tasks),
    `已发送实施任务：${change.name}${note}。AI 会从第一个未勾选任务继续，并随做随勾 tasks.md。`,
  )
}

async function runArchive(ctx, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const state = await openspecState(ctx, cwd, invocation.signal)
  if (!state.initialized) return { kind: 'error', text: '此工作区还没有 openspec/。先运行 /openspec-init 或用面板的一键初始化。' }
  let change
  try {
    change = await pickChange(ctx, invocation, state)
  } catch (error) {
    return { kind: 'error', text: `OpenSpec 命令失败：${error.message}` }
  }
  if (!change.tasks || change.tasks.total === 0) {
    return { kind: 'error', text: `变更 ${change.name} 的 tasks.md 还没有任务清单，不能归档。` }
  }
  if (change.tasks.done < change.tasks.total) {
    return { kind: 'error', text: `变更 ${change.name} 还有 ${change.tasks.total - change.tasks.done}/${change.tasks.total} 项任务未完成。全部勾选后再归档；如需强行归档，请直接让 AI 处理。` }
  }
  return submit(
    invocation.agent,
    archivePrompt(change.name),
    `已发送归档任务：${change.name}。AI 会先把 delta specs 同步进 openspec/specs/，再把文件夹移入 changes/archive/。`,
  )
}

async function runStatus(ctx, invocation) {
  const cwd = await resolveCwd(ctx, invocation.agent)
  const state = await openspecState(ctx, cwd, invocation.signal)
  if (!state.initialized) {
    return { kind: 'success', text: '此工作区还没有 openspec/。运行 /openspec-init，或用输入框下方快捷条的「初始化」按钮。' }
  }
  const lines = []
  if (state.changes.length === 0) {
    lines.push('进行中的变更：无（/opsx-propose <change-name> 开始一个）')
  } else {
    lines.push('进行中的变更：')
    for (const change of state.changes) {
      const progress = change.tasks && change.tasks.total > 0 ? `，任务 ${change.tasks.done}/${change.tasks.total}` : ''
      lines.push(`  • ${change.name} — ${change.phase}${progress}`)
    }
  }
  lines.push(`已归档：${state.archived} 个变更`)
  return { kind: 'success', text: lines.join('\n') }
}

/** Register the OpenSpec command family on every composed command adapter. */
export function apply(ctx) {
  ctx.commands.register({ name: 'openspec-init', description: 'OpenSpec: 在当前工作区初始化 openspec/ 骨架', handler: safe((invocation) => runInit(ctx, invocation)) })
  ctx.commands.register({ name: 'opsx-explore', description: 'OpenSpec: 探索模式——只想清楚，不写代码', input: { hint: '[主题]' }, handler: safe((invocation) => runExplore(ctx, invocation)) })
  ctx.commands.register({ name: 'opsx-propose', description: 'OpenSpec: 提案——创建变更计划（proposal/specs/tasks）', input: { hint: '<change-name> [说明]' }, handler: safe((invocation) => runPropose(ctx, invocation)) })
  ctx.commands.register({ name: 'opsx-apply', description: 'OpenSpec: 实施——按 tasks.md 逐项实现并勾选', input: { hint: '[change-name]' }, handler: safe((invocation) => runApply(ctx, invocation)) })
  ctx.commands.register({ name: 'opsx-archive', description: 'OpenSpec: 归档——同步 specs 并移入 archive/', input: { hint: '[change-name]' }, handler: safe((invocation) => runArchive(ctx, invocation)) })
  ctx.commands.register({ name: 'opsx-status', description: 'OpenSpec: 查看当前工作流状态（不进入模型）', handler: safe((invocation) => runStatus(ctx, invocation)) })
}
