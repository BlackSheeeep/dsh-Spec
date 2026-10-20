# Design

## Context

dsh-spec 是 DSH 的 Host + Client 双半插件：Host 注册 `/opsx-*` 命令并以 `agent.followup()` 提交阶段提示词，Client 注册 `sidebar.panellist`、`main` 面板与 `conversation.composer.dock` 快捷条，通过 `workspaceFiles` Remote 读 `openspec/` 并监听变化。当前实现把 OpenSpec 视为固定的四阶段工作流：`parseTasks` 只认 `-`/`*` 复选框，`derivePhase` 只看 proposal / specs / tasks，面板按 `.md` 后缀与固定文件名枚举文档，归档与 spec 合并完全交给模型按提示词执行（见 `src/prompts.js`、`src/host.js`、`src/client.js`）。

上游 OpenSpec 1.14 的事实模型与本仓库的假设不同：工作流由 `openspec/schemas/<name>/schema.yaml` 定义 artifact 图（`generates`、`requires`、`apply`），`openspec/config.yaml` 携带 `schema`、`context`、`rules`、`operations`，每个 change 的 `.openspec.yaml` 可覆盖 schema 并携带 `created`、`goal`、`skip_specs`、`retire_capabilities`，状态按文件存在性与依赖推导为 `done` / `skipped` / `ready` / `blocked`，delta specs 按 `ADDED` / `MODIFIED` / `REMOVED` / `RENAMED` 操作合并，任务只认 `x` 为完成，归档使用本地日期并先校验、再合并、再移动。用户已明确两条约束：以仓库原生语义为准；插件不依赖 openspec CLI（全部纯 JS、零新增运行时依赖、零子进程）。

DSH 平台约束同样决定设计：命令名只能是 `[a-z0-9_-]`（`/opsx:propose` 无法注册，只能保持 `/opsx-propose`），命令只能携带自由文本 `rawInput`；Host 插件可直接使用 `node:fs`；Client 不能新增 `ctx.remote.<ns>`，但沿用现有 `webServer` 私有路由 + `connection.admit` 信封即可扩展只读接口；技能注册可通过 `ctx.skills` 的 runtime 能力或 workspace 感知 provider 完成；项目级技能根 `<project>/.dsh/skills` 的优先级高于 runtime 注册。

## Goals / Non-Goals

**Goals:**

- 用一份 Host 侧纯 JS 引擎实现 OpenSpec 原生文件语义，面板、命令、提示词、校验共用同一份数据。
- 让面板在无会话、无 CLI 的情况下也能正确展示原生状态；让阶段命令按原生指令与项目上下文组装。
- 让 sync / archive 成为确定性、可预览、可回滚的操作，而不是模型自由发挥的内容。
- 在不调用 openspec CLI 的前提下，与 OpenSpec 原生 DSH skills 共存；原生缺失时提供明确的 fallback。
- 保持零新增运行时依赖、文件即真相源、无隐藏状态。

**Non-Goals:**

- 不实现自定义 schema 的交互式编辑、schema fork/init 命令。
- 不支持 workspace / store / initiative / context-store 等进阶原生协作模型。
- 不完整移植 13 个原生 OpenSpec skills 的正文；不调用 `openspec` 可执行文件。
- 不迁移或删除已有 `openspec/` 内容；不改变 DSH 命令语法限制。
- 首期不实现 expanded 命令族（new / continue / ff / verify / bulk-archive / onboard），仅在设计中预留。

## Decisions

### D1. 纯 JS 语义引擎放在 Host，Client 只渲染

Host 新增 `src/native/` 纯函数模块（YAML 子集解析、config、metadata、schema resolver、artifact graph、state、spec/delta parser、tasks parser、validation、instruction composer、merge/archive）。浏览器半不重复实现模型，而是通过现有 `/dsh-spec` 路由扩展只读方法（`state` / `validate` / `instructions` / `sync-preview`），用 `workspaceRegistry.resolveByPath` 校验工作区路径，并沿用现有 `{type:'client-request', rpcId, method, payload}` 信封与 `connection.admit`。文档正文仍走 `workspaceFiles.read`，会话内文件 watch 作为刷新触发信号；无会话的工作区由面板轮询（2–10s）刷新。

- 备选：在 client 内复制一套解析逻辑（当前做法）。否决——两份实现必然漂移，且原生校验/合并逻辑体量大、client bundle 会显著膨胀。
- 备选：新增 `ctx.remote` 命名空间。否决——DSH 的 Remote 命名空间在构建期固化，第三方插件无法注册。

### D2. 所有写操作仍走命令（会话作用域），只读接口不写

面板的初始化、sync、archive 按钮继续遵循“切到工作区会话并把命令填入输入框”的模式，由用户回车后经 `commands.execute` 在 Host 侧执行，从而复用 `sandboxPolicy.resolve({session})` 与工作区根约束。`/dsh-spec` 路由保持只读（含 sync 预览）。备选：让路由直接写盘。否决——没有会话策略可解析，越权与误触风险不可接受。

### D3. YAML 使用自研子集解析器，不引入运行时依赖

在 `src/native/yaml.js` 实现覆盖本用途的 YAML 子集：注释、键值、块标量（`|` / `>`）、缩进数组、缩进映射、flow 数组 / 映射、单双引号与简单转义。用于 `config.yaml` / `config.yml`、`schema.yaml`、`.openspec.yaml`；遇到不支持的结构返回带行号的解析告警并降级（config 丢失字段可降级，schema 无法解析则该 change 标记 schema 错误）。备选：引入 `yaml` npm 依赖。否决——link 安装不会自动安装依赖，违背零依赖与开箱即用承诺；备选：沿用 1.4.1 CLI 自带的解析器。否决——依赖外部安装路径与版本。

### D4. 内置原生快照是“回退”，项目 schema 永远优先

`src/native-snapshot/` 存放从上游 OpenSpec 1.14.3 固定提取的 `spec-driven/schema.yaml`、四个模板与 `ATTRIBUTION.md`（记录上游版本、commit、MIT 归属与提取方式），构建时复制到 `lib/native-snapshot/`，用 `node:fs` 相对 `import.meta.url` 读取。解析顺序：`openspec/schemas/<name>/` → `lib/native-snapshot/<name>/`。新增 `tools/sync-native-snapshot.mjs`（开发期运行）用于刷新快照并更新版本标记；测试校验快照结构与版本标记存在。

### D5. 原生 artifact 状态取代 legacy phase，展示层派生“下一步”

状态唯一来源：schema 图 + 文件系统 + `.openspec.yaml`。每 artifact 输出 `{id, outputPath, status, missingDeps?}`；change 级输出 `isPlanningComplete`、`applyRequires`、`nextSteps`、`tasks {done,total}`、`listStatus: no-tasks | in-progress | complete`。面板展示 artifact chips 与 next step；快捷条阶段按钮由 `nextSteps` / 可执行动作派生，不再存在 draft/proposed/apply/ready 的真相字段。保留纯展示的“阶段标签”时只作为派生的样式映射，不参与任何判定。

### D6. 确定性 delta 合并算法

主 spec 先解析为 requirement block 列表（identity = 折叠空白后的 `### Requirement:` 名称）。合并规则：`ADDED` 追加（同名已存在 → ERROR）；`MODIFIED` 整体替换同名 block（不存在 → ERROR）；`REMOVED` 删除同名 block（不存在 → WARNING）；`RENAMED` 将 FROM 的标题改为 TO（两侧校验）。未在 delta 中提及的内容逐字节保留；新 capability 无 `## Purpose` 时写入原生占位 `TBD - created by archiving change <name>. Update Purpose after archive.`；`retire_capabilities: true` 且最后一条 requirement 被 REMOVED 时删除主 spec 文件，否则保留。写盘统一走“内容在内存生成 → 校验 → 临时文件 → rename”的路径，任一步失败不改变原文件。

### D7. 提示词组合严格遵循原生顺序

`instruction`（schema）+ `context`（config，包裹 `<context>`）+ 该 artifact 的 `rules`（包裹 `<rules>`）+ template + 依赖完成情况 + 输出路径 + 阶段边界。若项目无对应 schema 则使用快照；若 artifact 的 `generates` 已满足依赖或状态为 `skipped`，不生成创建该 artifact 的提示。explore / propose / apply / update 继续通过 `agent.followup()` 提交，保持“命令直出 UI 不占模型 token”的既有机制。archive 不再生成模型提示词，由 D6 引擎执行。

### D8. sync / archive 的交互与门禁

命令执行流程：解析 change → 校验（ERROR 则拒绝并直出问题）→ 生成预览（受影响主 specs 摘要、新增/修改/删除的 requirement、归档目标目录）→ 等待用户确认（命令输入支持 `--yes`；无 `--yes` 时返回预览并要求确认，确认走第二次执行）→ 写入 → 归档移动。归档目录名使用本地日期 `YYYY-MM-DD-<name>`；目标已存在则拒绝；`.openspec.yaml` 保留；`skip_specs: true` 时不写主 specs；任务未全部完成时拒绝归档。

### D9. Skills 集成采用 workspace 感知 provider，而非 runtime 注册

新增 `src/native/skills.js`：检测 `<project>/.dsh/skills`、`<project>/.agents/skills`、`<dshHome>/skills` 下 `openspec-*` 技能；面板展示其名称与工作流覆盖。若 DSH 组合暴露 `ctx.skills`，注册一个 provider：`list({cwd})` 检查该工作区是否已有原生 OpenSpec skills，有则返回空目录，无则返回 core 工作流的 fallback 候选（`openspec-explore`、`openspec-propose`、`openspec-apply-change`、`openspec-update-change`、`openspec-sync-specs`、`openspec-archive-change`）；`get()` 返回插件内置的、改写为文件语义的正文（不出现 `openspec` CLI 调用），frontmatter 记录改编来源与上游版本。项目级技能 rank 高于该 provider，因此原生技能出现时自动胜出；provider 只在能力可用时注册，不影响命令与面板。备选：直接 runtime `ctx.skills.register` 同名技能。否决——runtime 注册不感知工作区，且无法在原生技能存在时自动让位。

### D10. 初始化与脚手架对齐原生

`openspec-init` / 面板初始化只创建：`openspec/config.yaml`（`schema: spec-driven` 加注释示例，不含占位 context）、`openspec/specs/`、`openspec/changes/archive/` 及 `.gitkeep` 锚点；不再创建 `openspec/README.md` 与中文占位 context（已存在的文件不删除）。propose 创建 change 目录时写入 `.openspec.yaml`：`schema`（生效 schema）+ `created`（本地日期，`YYYY-MM-DD`）+ 可选 `goal`。`skip_specs` 由提案内容决定时，propose 阶段提示模型写入。

### D11. 快照与版本策略

插件语义以“快照版本”声明目标原生契约（1.14.3），README 与 `ATTRIBUTION.md` 各记录一次；当检测到项目 `.openspec.yaml` 中出现快照不认识的 metadata 键时给出警告而非报错；schema 解析失败时面板显示 schema 错误并提供“查看问题”而不是隐藏 change。

## Risks / Trade-offs

- **上游漂移**：1.4 → 1.14 仅数月；快照、校验规则、JSON 语义都可能变化。缓解：快照带版本与提取脚本、测试断言版本标记、README 声明目标版本、不把未覆盖规则伪装成已覆盖。
- **YAML 子集边界**：自定义 schema 若使用 anchor / merge key / 多行 flow 等结构会解析失败。缓解：带行号告警、schema 错误可见、不静默降级为默认 schema；文档注明支持范围。
- **确定性合并正确性**：MODIFIED 全量替换、RENAMED、REMOVED 与 retire 的边界最容易出错。缓解：以原生 fixture 建立单测、失败不落盘、预览先行；首期对无法安全合并的输入直接报 ERROR。
- **与原生 CLI 行为差异**：不依赖 CLI 意味着校验与归档只能是“高保真子集”，个别原生错误/警告不会出现。缓解：面板与 README 明示“原生语义子集”，保留后续接入 CLI 的扩展点（但不作为依赖）。
- **路由扩展**：`/dsh-spec` 只读方法增加后需要鉴权与体积边界（沿用 `connection.admit` 与 64KB 限制，状态响应分页）。
- **Client 重建**：client 半改动必须重新执行 `tools/build.mjs` 才生效；开发流程需在 README 与测试脚本中明确。
- **技能 fallback 分叉**：改写正文与原生 skill 内容不完全一致，属于有意取舍；通过 frontmatter 的改编来源与版本标注降低误解。

## Migration Plan

插件版本从 0.1.x 升到 0.2.0；不迁移任何用户数据、不重写已有 `openspec/`；初始化行为对已初始化项目保持幂等且只增不改。回滚方式为回退 `lib/` 与 `package.json` 版本，工作区文件不受影响。发布前执行：`node --test`、`node tools/build.mjs`、原生规则校验本 change、面板与命令的手工冒烟（含无会话工作区与无原生 skills 的工作区）。

## Open Questions

- expanded 命令族（new / continue / ff / verify / bulk-archive / onboard）何时进入下一 change；本 change 是否至少暴露 `/opsx-verify` 的只读报告。
- fallback skills 默认开启还是由插件配置显式开启（当前无插件配置页，倾向默认开启且仅在原生缺失时出现）。
- 是否在面板增加宿主右侧资源页签（`sidebar.right.pane.tab`）承载文档预览，或继续使用现有 Modal；本 change 不阻塞。
- 原生 1.14 的 `operations.apply/archive.guidance` 注入范围是否在首期覆盖 archive（确定性归档无模型提示词，可能只需 apply）。
