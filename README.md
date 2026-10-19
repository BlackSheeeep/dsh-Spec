# dsh-spec — OpenSpec 工作流的 DSH 适配插件

把 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 的规格驱动开发（SDD）工作流桥接进 DeepSeek Harness（DSH）：

- **监控面板** — 侧栏 OpenSpec 图标打开独立页面，实时显示每个工作区 `openspec/` 的变更列表、阶段、任务进度（`tasks.md` 复选框）和归档数量。
- **快捷命令条** — 会话输入框下方常驻条：当前变更的阶段徽标 + 一键 `探索 / 提案 / 实施 / 归档 / 状态`。
- **`/opsx-*` 命令桥接** — OpenSpec 官方 slash 命令的 DSH 实现。执行时把对应工作流指令作为用户消息发给当前会话的 AI，AI 按 OpenSpec 流程读写 `openspec/`。不依赖 openspec CLI。
- **一键初始化** — 未初始化的工作区可一键生成 `openspec/` 骨架（`config.yaml`、`specs/`、`changes/archive/`）。

## 工作循环

```text
/opsx-explore  想清楚（纯思考，不写文件）
/opsx-propose <change-name> [说明]   创建 openspec/changes/<name>/：proposal + specs + tasks
       （人工评审，直接改文件或让 AI 修改）
/opsx-apply [change-name]     逐项实现并勾选 tasks.md
/opsx-archive [change-name]   同步 delta specs 进 openspec/specs/，移入 changes/archive/
/opsx-status                  查看当前状态（不进入模型）
/openspec-init                初始化 openspec/ 骨架（幂等）
```

阶段与进度**只从文件推导**（没有隐藏状态）：

| 阶段 | 判定 |
|---|---|
| 草稿 | 变更文件夹还没有 proposal/specs |
| 已提案 · 待评审 | 有 proposal.md / specs/，tasks.md 没有可勾选任务 |
| 实施中 | tasks.md 有未勾选任务（面板显示 x/y） |
| 待归档 | tasks.md 全部勾选 |
| 已归档 | 文件夹在 `openspec/changes/archive/` |

## 安装（本地 profile）

```powershell
node tools/build.mjs
```

然后用 DSH 插件管理器（Web 界面 → 插件 → 本地安装）或 `dsh` CLI 把本目录作为 bundle 安装进当前 profile。安装后 Host 进程需重启一次；此后改代码只需重新构建并刷新页面（client 半走 HMR）。

## 架构

```text
src/host.js     Host 半：注册 /opsx-* 命令（ctx.commands），ctx.fs 读写 openspec/，
                agent.followup() 把阶段指令作为用户消息提交（同 /plan、/goal 机制）
src/prompts.js  工作流提示词模板 + 纯函数（parseTasks / derivePhase，MIT 语义对齐 OpenSpec）
src/client.js   浏览器半：main 面板 + sidebar.panellist 图标 + conversation.composer.dock 快捷条；
                状态经 workspaceFiles Remote（list/read/changes 流）从工作区文件推导
tools/build.mjs 构建：Host 半原样拷贝，client 半内联进 __ModuleLoader__ 闭包
```

设计遵循 Harness 插件实践：文件即真相源（插件不存任何状态）、UI 走插槽与主题 token、文案走 locale 服务、命令直出 UI 不占模型 token。

## License

MIT。OpenSpec 工作流语义来自 [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)（MIT）。
