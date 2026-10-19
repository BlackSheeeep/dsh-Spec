# dsh-spec — OpenSpec 工作流的 DSH 适配插件

把 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 的规格驱动开发（SDD）工作流完整桥接进 DeepSeek Harness（DSH）：**实时监控面板 + 会话快捷命令条 + `/opsx-*` 阶段命令**，不依赖 openspec CLI。

```text
探索 想清楚 ──► 提案 写计划 ──► 人工评审 ──► 实施 逐项勾选 ──► 归档 同步 specs
/opsx-explore    /opsx-propose                     /opsx-apply       /opsx-archive
```

## 它长什么样

### 监控面板（对话开始前也能用）

侧栏点 **OpenSpec** 图标进入。每个工作区一张卡片：变更列表、阶段徽标、任务进度条（来自 `tasks.md` 复选框）、工件文件、归档计数；目录监听实时刷新。

![监控面板](docs/panel.png)

工作区还没有 `openspec/` 时，卡片给出一键初始化（生成 `config.yaml`、`specs/`、`changes/archive/` 骨架）：

![未初始化](docs/panel-init.png)

### 会话快捷命令条

会话开始后，输入框下方常驻一条：当前变更名 + 阶段徽标 + 进度 + 一键阶段命令，点「OpenSpec」直达面板。

![快捷命令条](docs/quickbar.png)

### 点「提案」→ 行内展开输入

输入 `change-name`（可附说明）回车即发送；AI 收到的是一份完整的 OpenSpec 提案指令（创建 `proposal.md` + delta specs + `tasks.md`，写完停下等评审）。多个变更并行时「实施」会展开变更选择条。

![提案行内展开](docs/propose-inline.png)

指令作为普通用户消息进入会话（与 `/plan`、`/goal` 同机制），AI 按模板走流程：

![提案已发送](docs/propose-sent.png)

## 工作循环与命令

| 命令 | 作用 |
|---|---|
| `/opsx-explore [主题]` | 探索模式：调查代码、比较方案、给建议；**不写任何文件** |
| `/opsx-propose <name> [说明]` | 创建 `openspec/changes/<name>/`（proposal + specs + tasks），写完计划即停，等人工评审 |
| `/opsx-apply [name]` | 从第一个未勾选任务继续实施，随做随勾 `tasks.md` |
| `/opsx-archive [name]` | 校验任务全部勾选 → 同步 delta specs 进 `openspec/specs/` → 移入 `changes/archive/` |
| `/opsx-status` | 直接输出当前工作流状态（不进入模型） |
| `/openspec-init` | 初始化 `openspec/` 骨架（幂等） |

命令可以直接敲（输入框 `/` 菜单），也可以点面板/快捷条按钮——两者等价。

### 阶段与进度只看文件

| 阶段 | 判定 |
|---|---|
| 草稿 | 变更文件夹还没有 proposal/specs |
| 已提案 · 待评审 | 有 proposal.md / specs/，tasks.md 暂无可勾选任务 |
| 实施中 | tasks.md 有未勾选任务（面板显示 x/y） |
| 待归档 | tasks.md 全部勾选 |
| 已归档 | 文件夹在 `openspec/changes/archive/` |

没有隐藏状态——插件不存储任何东西，`openspec/` 目录就是真相源，外部改文件面板同样实时反映。

## 对话开始前？

- **面板**：完全可用——查看状态、一键初始化、点阶段按钮会自动开始该工作区的会话并执行命令（自动切入对话）。
- **快捷命令条**：随会话出现（DSH 的 composer 槽位是会话作用域，没有对话就没有这个区域）；`/` 命令菜单同理。

## 安装

```powershell
node tools/build.mjs
```

然后在 DSH Web 插件页把本目录作为本地 bundle 安装（或 `dsh plugin --profile <name> add <本目录>`）。安装后 Host 进程重启一次；此后改代码只需重新构建 + 刷新页面。

要求：DSH 0.2.x（web bundle），无需 Node CLI、无需安装 openspec。

## 架构

```text
src/host.js     Host 半：注册 /opsx-* 命令（ctx.commands）；ctx.fs 读写 openspec/；
                agent.followup() 把阶段指令作为用户消息提交（同 /plan、/goal 机制）
src/prompts.js  工作流提示词模板 + parseTasks / derivePhase 纯函数（语义对齐 OpenSpec 官方）
src/client.js   浏览器半：main 监控面板 + sidebar.panellist 图标 + conversation.composer.dock
                快捷条；状态经 workspaceFiles Remote（list/read/changes 流）从文件推导
tools/build.mjs 构建：Host 半原样拷贝，client 半内联进 __ModuleLoader__ 闭包（无打包器）
tests/          parseTasks / derivePhase / slugify 单元测试
```

设计遵循 Harness 插件实践：文件即真相源（零自有状态）、UI 走插槽与主题 token、文案走 locale 服务（zh/en）、命令直出 UI 不占模型 token、阶段指令模板忠实对齐 OpenSpec 官方工作流语义（MIT，注明来源）。

## 已知边界

- 会话未开始时快捷条与 `/` 菜单不出现（DSH 会话作用域机制），此阶段请使用面板。
- 提案/实施由 AI 执行，需要会话已配置模型；插件本身不调用模型。
- 一键初始化生成的 `openspec/config.yaml` 是最小骨架；装了 openspec CLI 的项目可用 `openspec init` 无损覆盖升级。

## License

MIT。OpenSpec 工作流语义来自 [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)（MIT）。
