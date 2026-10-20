/**
 * Native OpenSpec workspace scaffold (Host half).
 *
 * `openspec-init` and the panel's session-less init action both call
 * {@link ensureSkeleton}. The scaffold mirrors upstream OpenSpec's native
 * layout: a `config.yaml` carrying only the effective schema plus comment
 * examples, and the `specs/` / `changes/archive/` anchors. It deliberately
 * writes no README and no placeholder `context:` — project facts are added by
 * the user, and the plugin never invents them.
 *
 * Creation is idempotent and additive: existing files and directories are
 * probed and left untouched, and only newly created items are reported.
 *
 * @module dsh-spec/native/init
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Generated `openspec/config.yaml`: schema plus commented examples, no placeholder context. */
const CONFIG_YAML = [
  'schema: spec-driven',
  '',
  '# OpenSpec 项目配置（由 dsh-spec 初始化，可按需补充）。',
  '# schema: 本项目生效的工作流 schema 名，对应 openspec/schemas/<name>/schema.yaml；',
  '#         项目目录不存在该 schema 时使用插件内置的 spec-driven 快照。',
  '# context: | 项目级事实（技术栈、启动命令、关键目录、团队约定），planning 阶段注入模型上下文。',
  '# rules: 按 artifact 分组的额外约束，例如：',
  '#   rules:',
  '#     proposal:',
  '#       - 提案必须先列出受影响的 capability。',
  '# operations: 覆盖 apply / archive 阶段的行为说明，例如：',
  '#   operations:',
  '#     apply:',
  '#       guidance: 每完成一个任务立即勾选 tasks.md 复选框。',
  '',
].join('\n')

/** Native `config.yaml` text produced by initialization. */
export function serializeConfigYaml() {
  return CONFIG_YAML
}

/** Whether one absolute path exists (file or directory). */
async function exists(absolute) {
  try {
    await stat(absolute)
    return true
  } catch {
    return false
  }
}

/** Path shown in the "created" report: anchors report their directory. */
function displayRel(rel) {
  return rel.endsWith('.gitkeep') ? rel.slice(0, -'.gitkeep'.length) : rel
}

/**
 * Ensure the native OpenSpec skeleton exists under one workspace.
 *
 * @param {string} cwd - absolute workspace root.
 * @returns {Promise<{ created: string[], configContent: string }>} created items
 *   (workspace-relative, directories end with `/`) and the config text used.
 */
export async function ensureSkeleton(cwd) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) throw new Error('工作区路径无效')

  const created = []
  const ensure = async (rel, content) => {
    const absolute = join(cwd, ...rel.split('/'))
    if (await exists(absolute)) return
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
    created.push(displayRel(rel))
  }

  await ensure('openspec/config.yaml', CONFIG_YAML)
  await ensure('openspec/specs/.gitkeep', '')
  await ensure('openspec/changes/archive/.gitkeep', '')
  return { created, configContent: CONFIG_YAML }
}
