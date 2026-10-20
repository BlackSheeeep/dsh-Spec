# dsh-spec — OpenSpec 原生语义的 DSH 前端

把 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 的规格驱动开发（SDD）工作流完整桥接进 DeepSeek Harness（DSH）：**工作区原生面板 + 会话快捷命令条 + 九条 `/opsx-*` 命令**，直接读取仓库里的 `openspec/` 原生文件，**不依赖 openspec CLI**。

目标原生契约：**OpenSpec 1.14.3**（schema 驱动 OPSX）。插件内置一份带版本与 MIT 归属的 `spec-driven` schema + 四份模板快照（上游 commit `c794978`，见 `src/native-snapshot/ATTRIBUTION.md`），仅当项目没有同名 `openspec/schemas/<name>/` 时作为回退。

```text
探索 想清楚 ──► 提案 写计划 ──► 人工评审 ──► 实施 逐项勾选 ──► 同步 specs ──► 归档
/opsx-explore    /opsx-propose                     /opsx-apply      /opsx-sync   /opsx-archive
```

## 命令面与原生映射

DSH 的命令名只能是 `[a-z0-9_-]`，原生 `/opsx:*` 冒号语法无法注册，因此统一映射为 kebab-case。每条命令的描述里也标注了对应原生动作。

| 原生 | DSH 命令 | 作用 |
|---|---|---|
| `opsx:explore` | `/opsx-explore [主题]` | 只调查、讨论、给出选项与建议；**不写任何文件** |
| `opsx:propose` | `/opsx-propose <name> [说明]` | 幂等初始化 → 创建 `openspec/changes/<name>/` 与原生 `.openspec.yaml` → 提交 plan-only 提示词并停下等评审 |
| `opsx:update` | `/opsx-update [name] [修订要求]` | 只修改已有规划工件并保持工件间一致；代码改动交给 apply |
| `opsx:apply` | `/opsx-apply [name]` | 从第一个未勾选任务继续实施，随做随勾 `tasks.md` |
| `opsx:sync` | `/opsx-sync [name] [--yes]` | 校验门禁 → 预览 delta 合并计划 → 确认后确定性写入主 specs |
| `opsx:archive` | `/opsx-archive [name] [--yes]` | 校验 + 任务全勾 → 合并 specs → 移入 `changes/archive/YYYY-MM-DD-<name>/` |
| — | `/opsx-validate [name]` | 直接输出原生分级校验结果（ERROR / WARNING / INFO），不占模型 token |
| — | `/opsx-status` | 直接输出进行中变更、artifact 状态、任务进度与已归档数量 |
| — | `/openspec-init` | 幂等创建原生骨架（`config.yaml` + `specs/` + `changes/archive/`） |

`sync` / `archive` 是**确定性操作**：先校验（有 ERROR 直接拒绝并列出问题），再给出 dry-run 预览，只有显式 `--yes`（或第二次确认）才写盘。合并规则完整支持 `ADDED` / `MODIFIED` / `REMOVED` / `RENAMED`，delta 未提及的内容逐字节保留；写入走"内存生成 → 校验 → 临时文件 + rename"，任一步失败不改变原文件。

**范围说明**：本版只覆盖原生 core 工作流。expanded 命令族（`new` / `continue` / `ff` / `verify` / `bulk-archive` / `onboard`）以及 store / workspace / initiative 进阶模型尚未实现。

## 它长什么样

### 工作区面板（对话开始前也能用）

侧栏点 **OpenSpec** 图标进入。面板不再套用固定四阶段，而是展示 OpenSpec 原生数据模型：

- **项目配置**：生效 schema、context 摘要、按 artifact 分组的 rules、项目本地与内置快照 schema 来源；
- **进行中的变更**：生效 schema 名、每个 artifact 的原生状态（`done` / `skipped` / `ready` / `blocked`）、可展开的 `missingDeps`、`skip_specs` 信号、独立的任务进度，以及按 artifact 状态推导的下一步动作；
- **变更详情**：工件文档按 schema 的 `generates` 路径列出（自定义 artifact、glob 输出都能显示），`.openspec.yaml` 元数据（schema / created / goal / skip_specs），delta 操作统计（ADDED / MODIFIED / REMOVED / RENAMED），以及带文件路径与行号的分级校验问题；
- **能力 Spec**：每个 capability 的 Purpose、requirement / scenario 数量与校验问题，嵌套路径（如 `identity/user-auth`）按层级分组；
- **已归档**：按本地归档日期分组，按需读取工件、任务与元数据；
- **不做静默截断**：列表超出单页显示分页/「还有 N 个」，文档读取被截断时显示提示并支持继续读取。

无会话的工作区由面板每 4s 轮询 Host 只读接口；有会话时改用 `workspaceFiles` 文件监听触发刷新。界面不存任何隐藏状态——所有内容每次从文件推导。

工作区还没有 `openspec/` 时，卡片给出一键初始化，生成与原生一致的骨架（`config.yaml`、`specs/`、`changes/archive/` 锚点），不写 README、不写占位 context，已存在文件一律不覆盖。

### 会话快捷命令条

会话开始后，输入框下方常驻一条：当前变更名、artifact 状态摘要、任务进度，加上按原生下一步推导的动作按钮（探索 / 提案 / 实施 / 更新 / 同步 / 归档 / 状态）与「检测到的原生 OpenSpec skills」指示。

面板按钮**不自动执行**：点击会切到对应工作区的会话并把 `/opsx-*` 指令填入输入框；确认后再回车，避免误触直接跑模型。

界面完全使用 DSH 宿主的主题 token（`--dsw-*`）与弹窗规范：浅色 / 深色自动跟随。

### 截图（本机 DSH Web 验证实例）

| 面板（artifact chips / 原生下一步 / 校验问题） | 项目配置与可用 schema |
|---|---|
| ![面板](docs/panel.png) | ![项目配置](docs/config-view.png) |

| 同步 dry-run 预览 | 归档视图（本地日期分组 + 按需详情） |
|---|---|
| ![同步预览](docs/sync-preview.png) | ![归档](docs/archive.png) |

| 长文档截断提示 + 继续读取 | 检测到原生 OpenSpec skills |
|---|---|
| ![文档截断](docs/doc-truncation.png) | ![原生 skills](docs/native-skills.png) |

| 会话快捷条（原生下一步 / 任务进度 / skills 指示） |
|---|
| ![快捷条](docs/quickbar.png) |

## 原生语义：状态与校验

### artifact 状态只看文件

状态唯一来源：生效 schema 的 artifact 图 + 文件系统 + `.openspec.yaml`。

| 状态 | 判定 |
|---|---|
| `done` | artifact 的 `generates` 路径存在（glob 至少命中一个文件） |
| `skipped` | `.openspec.yaml` 的 `skip_specs: true` 跳过 specs artifact（并满足依赖它的 artifact） |
| `ready` | 依赖全部 done/skipped，且自身输出尚未生成 |
| `blocked` | 还有未完成的依赖，`missingDeps` 给出依赖 ID |

change 级状态为 `no-tasks` / `in-progress` / `complete`（任务进度独立展示）；不再有 draft / proposed / apply / ready 这类硬编码阶段作为判定真相。

### 校验子集（高保真、非全量）

`/opsx-validate` 与面板校验问题是确定性的、只读的原生校验子集：proposal 的 `## Why` 长度（50–1000）与 `## What Changes`、delta 必须位于 `specs/<capability-path>/spec.md`、ADDED/MODIFIED requirement 的 SHALL/MUST 与 `#### Scenario:`、场景标题层级、`skip_specs` 与 delta 冲突、`tasks.md` 原生复选框解析（`-`/`*`/`+`，只有 `x` 算完成，`[~]`/空框算未完成，链接 bullet 忽略）、change 元数据与主 spec 必需章节。

不冒充全量：OpenSpec CLI 的一些错误/警告不在子集内，见「已知边界」。

## 安装与构建

仓库已提交构建产物 `lib/`，从 GitHub 面板安装不需要构建。本地开发改代码后：

```powershell
node tools/build.mjs
```

构建会：把 `src/host.js`、`src/prompts.js`、`src/commands.js` 原样拷到 `lib/`；把 `src/native/**` 与 `src/native-snapshot/**` 镜像到 `lib/`；把 `src/client-helpers.js` 内联进 `lib/client.js` 的 `__ModuleLoader__` 闭包。Host 半改动需要重启 DSH 进程，client 半改动重新构建后刷新页面即可。

```powershell
node --test --test-isolation=none "tests/*.test.mjs"
```

### 方式一：插件面板安装（推荐）

侧栏 **插件 → 添加插件**，填本地目录绝对路径（`link` 接入，改代码后构建 + 刷新页面）、Git 仓库地址（仓库自带 `lib/`）或 npm 包名（暂未发布）。首次安装需重启 DSH 一次；本插件零依赖、无安装脚本。

### 方式二：CLI

```powershell
dsh plugin --profile <profile> add D:\DSHarness\dsh-Spec
```

要求：DSH 0.2.x（web bundle），无需 Node CLI、无需安装 openspec。

## 与原生 OpenSpec skills 共存

插件会检测项目 `.dsh/skills`、项目 `.agents/skills`、用户技能根目录下的 `openspec-*` 技能，并在面板/快捷条展示其名称与覆盖的工作流。

- 检测到原生技能时：插件**不注册**同名 fallback，也不修改、移动或删除原生技能文件；
- 原生技能缺失且 DSH 组合提供 `ctx.skills` 时：注册工作区感知的 fallback 技能 provider，覆盖 explore / propose / apply / update / sync / archive 六个 core 工作流；正文是**文件语义**（读 `openspec/` 文件 + 用 DSH 命令），不调用 openspec CLI，frontmatter 标注改编来源（Fission-AI/OpenSpec、MIT、上游 1.14.3）；
- 工作区后来出现原生技能时，下一次目录刷新 fallback 自动让位；组合没有 skills 能力时跳过注册，命令与面板照常工作。

## 架构

```text
src/host.js            Host 半：注册命令族、只读 /dsh-spec 路由（state / validate /
                       instructions / sync-preview / document / init）、可选 fallback skills provider
src/commands.js        九条命令：变更选择、原生 propose 脚手架、sync/archive 预览确认、
                       status/validate/init 直出
src/prompts.js         原生阶段提示词组合（explore / propose / apply / update 边界）
src/native/**          纯 JS 原生语义引擎（零依赖、零子进程、零网络）：
                       yaml / config / metadata / schema / graph / spec / tasks / validate /
                       state / instruction / merge / archive / skills / init / fsio
src/native-snapshot/   固定版本 spec-driven schema + 模板快照（ATTRIBUTION 记录上游）
src/client.js          浏览器半：main 工作区面板 + sidebar.panellist 图标 +
                       conversation.composer.dock 快捷条；只渲染 Host 推导的原生状态
src/client-helpers.js  纯展示辅助（artifact 标签/排序、delta 摘要、日期分组、分页切片）
tools/build.mjs        构建（Host 半拷贝 + client 半内联，无打包器）
tools/sync-native-snapshot.mjs  开发期刷新内置快照与版本标记
tests/                 node:test 单元与集成测试
```

设计原则：文件即真相源（零自有状态）、Host 侧单一语义引擎（面板/命令/提示词共用）、UI 走插槽与主题 token、文案走 locale（zh/en）、命令直出 UI 不占模型 token、原生快照带版本与归属、零新增运行时依赖。

### 刷新内置快照

```powershell
node tools/sync-native-snapshot.mjs --source <path-to-OpenSpec-repo>
```

读取上游仓库的 `schemas/spec-driven/schema.yaml` 与 `templates/*.md`，刷新快照与 `ATTRIBUTION.md` 的版本/commit 标记；测试会校验快照结构与版本标记存在。来源缺失时脚本以非零状态明确报错。

## 已知边界

- **原生语义子集**：不依赖 CLI 意味着校验/合并是"高保真子集"，个别原生错误与警告不会出现；这是有意的取舍，README 与面板不把未覆盖规则伪装成已覆盖。
- **有意未覆盖的原生校验规则**（首期）：`--strict` 与默认模式的区分、proposal `Capabilities` 列表与 delta 文件的一一对应、`REMOVED` / `MODIFIED` / `RENAMED` 目标是否存在于主 spec 的*校验期*跨文件检查（改为合并/预览期以 ERROR 拒绝，不落盘）、`REMOVED` 的 `**Reason**` / `**Migration**` 强制、场景内 `WHEN` / `THEN` 的结构化检查、`affected_areas` / `initiative` 等进阶元数据语义。这些规则不影响确定性 sync/archive 的正确性，只是在 `/opsx-validate` 中不会出现对应的原生提示。
- **YAML 子集**：自研解析器覆盖评论、标量、块标量、缩进序列/映射、flow 集合与引号；anchor / merge key / 多行 flow 等结构会带行号报错，schema 解析失败时面板显示 schema 错误而不是静默回退默认 schema。
- **上下文长度**：`openspec/config.yaml` 的 `context` 超过 50KB 会被忽略并给出警告。
- **会话作用域**：快捷条与 `/` 菜单只在有会话时出现（DSH composer 槽位机制）；没有会话时请用面板（面板走 Host 只读接口，无需会话）。
- **写操作只走命令**：面板不直接写盘；sync / archive 需要用户确认。
- **expanded 命令族**：new / continue / ff / verify / bulk-archive / onboard 尚未实现，留待后续 change。
- 提案/实施由 AI 执行，需要会话已配置模型；插件本身不调用模型。

## License

MIT。OpenSpec 工作流语义与内置快照来自 [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)（MIT，1.14.3，commit `c794978`），归属与提取说明见 `src/native-snapshot/ATTRIBUTION.md`。
