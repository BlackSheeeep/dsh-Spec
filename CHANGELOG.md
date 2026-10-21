# Changelog

## 0.6.0

快捷条 / 面板的「归档」按钮改回 OPSX AI 归档工作流，并修复新会话（还没进入对话）时点「归档」、回车后没有任何反应的问题。

### Fixed

- **新会话里「归档」按钮无效**：按钮此前填入 `/opsx-archive <name> --yes` 走确定性路径，Host 返回的是**直接命令结果**，而 DSH 只在会话轨迹里渲染它；新会话 hero 页没有轨迹，结果被静默丢弃，草稿被清空、页面停在 hero，用户看到的就是「点了没反应」。现在按钮填入 `/opsx-archive <name>`（OPSX AI 归档工作流）：命令提交后作为模型回合进入会话，hero 页会直接切到对话并显示归档工作流提示词，AI 先检查完成度并向用户确认，再智能合并 / 跳过同步、校验，最后用 `/opsx-archive <name> --yes --skip-specs` 确定性收尾。

### Changed

- `src/client-helpers.js` 的 `deriveNextAction()`：`complete` 状态的下一步改为输出 `/opsx-archive <name>`（AI 默认）；确定性快路径（`--yes`）/ 只读预览（`--dry-run`）/ 只移动（`--skip-specs`）仍由用户显式加参数触发。
- README 与单测同步更新；插件版本 `0.5.0` → `0.6.0`。

### Notes

- 确定性 `--yes` 仍是可用的对照/回退路径，但它返回的直接命令结果需要已有会话轨迹才能看见；新会话里请用默认 AI 路径（本次修复后的按钮行为）。

## 0.5.0

多进行中 change 时，五条 change 命令改为从列表选择 change 名并自动回填输入框。

### Added

- **变更名选择器（DSH Web 客户端）**：`/opsx-update`、`/opsx-apply`、`/opsx-sync`、`/opsx-archive`、`/opsx-validate` 在工作区存在两个及以上进行中 change 时，裸提交或从 `/` 菜单选中会先弹出可筛选的「选择变更」列表（DSH `commandUi.decorate` + `popupSelect`，与 `/model` 同款弹层）；每行显示 change 名与原生状态摘要（规划中 / 可实施 / 已完成、任务 x/y、N ERROR / N WARNING、`skip_specs`）。
- 选中后只把 `/opsx-<command> <change-name> ` 回填到会话输入框并把光标放到末尾，不自动发送、不产生模型消息；用户补充修订要求或参数后回车才执行。

### Changed

- 多 change 场景下，这五条命令的「裸提交」与「`/` 菜单点选」从直接执行 / 插入命令改为先弹选择器；单个进行中 change 仍自动选中，没有进行中 change 仍走既有提示，手打参数的命令行不变。
- `src/client-helpers.js` 新增 `CHANGE_PICKER_COMMANDS` / `changePickerAvailable` / `changePickerOptions` / `changePickerLine` 纯函数与单测；`src/client.js` 新增 zh/en 选择器文案与 `commandUi.decorate` 接线（嵌套 inject，缺少客户端服务时自动跳过，面板与快捷条不受影响）。
- 插件版本 `0.4.1` → `0.5.0`。

### Notes

- 选择器只在 DSH Web 客户端生效；TUI 等非 Web 客户端与未提供 `commandUi` 的组合保持既有命令语义。
- 已知限制：DSH 不支持空格后的内联参数补全，因此是「回车 / 菜单选中 → 二级列表」；不提供 sync / archive 标志（`--yes` / `--dry-run` / `--skip-specs`）的第二级选择，也不选择已归档 change。

## 0.4.1

窄窗口下快捷条排版不再换行错位。

### Fixed

- **窄窗口快捷条换行**：快捷条与宿主自带的 context meter 共用输入框下方同一行，窗口变窄时原来会折成两行（状态单独一行、动作按钮被顶到右边，和宿主的统计行挤在一起）。现在快捷条始终单行：变更名自动省略号截断；按窗口宽度分级隐藏次要控件——≤1300px 收起 skills 徽标、≤1200px 收起状态区徽标、≤1100px 收起「状态」按钮、≤1000px 收起「探索 / 提案」次级按钮，只保留「当前变更 + 下一步主按钮 + 面板入口」。
- **hero 行的变更切换菜单**：新会话态位于窗口顶部、工作区行右端，变更切换下拉改为向下展开并右对齐，避免超出视口被裁掉。

### Changed

- `src/client.js`：`QuickBar` 的 dock 改为 `flex-wrap:nowrap` + 可收缩状态区（`min-width:0` + 省略号），新增 `dshspec-dockSkills` / `dshspec-dockStatusBtn` / `dshspec-dockGhost` 分级隐藏钩子。
- 插件版本 `0.4.0` → `0.4.1`。

## 0.4.0

工作区概览拆成「工件 / 任务」两个独立进度圈；变更详情与归档详情恢复默认收起、可展开的任务清单。

### Added

- **双进度圈**：工作区概览同时显示工件进度圈（`(done + skipped) / artifact 总数`）与任务进度圈（`已勾选 / 任务总数`），两圈各自独立聚合、独立配色、各自到 100% 才变绿；没有任务清单时任务圈显示 `—` 并提示还没有任务清单，不再出现「工件 100% 但任务仍有几十项未完成」的单一 100% 误导。原本的 artifact 状态分布条保留，标题改为「工件状态」。
- **任务清单折叠块**：进行中与已归档 change 的详情新增「任务清单 done/total 已完成」一行，默认收起；展开后逐条显示勾选状态、文本、编号与层级缩进。文件监听/轮询刷新时清单随状态实时更新。
- **Host 契约**：`ChangeState.tasks` 新增 `items`（`id` / `text` / `done` / `depth`），单 change 最多 200 条；超出时面板提示「还有 N 项，打开 tasks.md」，不静默截断；旧 Host 未提供明细时面板给出降级提示。

### Changed

- `src/native/state.js` 新增 `limitTaskItems`（导出，供单测与面板契约使用）并在 `computeChangeState` 中携带任务明细；`docs/native-module-contract.md` 的 `ChangeState` 契约同步更新。
- `src/client-helpers.js` 新增 `workspaceProgress`（双进度口径）与 `taskChecklistView`（勾选明细视图，含超上限 / 旧 Host 降级标记）两个纯函数，并补齐单测。
- `artifactProgress` 文案保留给工件圈；阶段分布条改用新文案「工件状态」。
- **概览排版打磨**：圈内只留百分比、口径标签移到环下方（不再挤在 64px 环内），两个进度环成组呈现；「工件状态」标题与「原生技能 / 内置技能」徽标并排，去掉底部孤零零的技能行；状态条加高、卡片内边距收紧，整体更紧凑。
- **快捷动作不再弹窗**：面板与快捷条的「探索」「提案」入口不再先弹输入弹窗，点击直接把 `/opsx-explore ` / `/opsx-propose ` 填入会话输入框（不自动发送），主题与 change 名由用户在输入框补充；校验、同步预览、能力 spec 问题等只读结果弹窗保持不变。
- 插件版本 `0.3.1` → `0.4.0`。

## 0.3.1

对话开始前也显示快捷条按钮。

### Added

- **对话开始前的快捷条入口**：新会话（还没有任何消息）时，快捷条通过 `conversation.hero.options` 槽位显示在「工作区 / 模式」那一行的右端——DSH 的 `conversation.composer.dock` 只在对话开始后挂载，此前插件完全看不到入口。hero 工作区行本身只在空白会话渲染，与 composer.dock 天然互斥：对话开始后自动切换到输入框下方的条，不会同时出现两条。

### Changed

- `src/client.js` 的 QuickBar 新增 `heroOnly` 行内变体；注册面新增 `conversation.hero.options`（id 仍为 `openspec-quickbar`，与 composer.dock 共用注入）。
- **对话开始前的快捷条排版**：不再横向铺满整宽、中间留一大片空白，改为并入工作区行右端的紧凑行内簇（无容器描边、更小字号、变更名限宽、去掉重复的「提案」按钮）。
- 插件版本 `0.3.0` → `0.3.1`。

## 0.3.0

直接复用上游 OpenSpec OPSX 工作流逻辑（MIT，标注出处），sync / archive 默认由 AI 参与。

### Added

- **内置全部 12 个 OPSX 工作流 skills**：`explore / propose / apply-change / update-change / sync-specs / archive-change / new-change / continue-change / ff-change / verify-change / bulk-archive-change / onboard`。正文逐字来自 OpenSpec 1.14.3（commit `c794978`，MIT），存放在 `src/native-snapshot/skills/**`，随 `ATTRIBUTION.md` 记录来源与版本，`tools/sync-native-snapshot.mjs` 可复现刷新。
- **CLI → 文件语义适配层**（`src/native/skill-adaptation.js`）：加载 vendored SKILL.md 时重写 frontmatter（`vendoredFrom` / `upstreamVersion` / `upstreamCommit` / MIT / `adaptedFor: dsh-spec`）并在正文前注入映射说明（`openspec status/list/validate/instructions/show/archive/new change/sync/update` → 读 `openspec/` 文件或 `/opsx-*` 命令；声明无 CLI、无 store）。原生 skills 存在时 fallback 继续让位，且从不改写原生文件。
- **AI sync / archive 工作流**：`/opsx-sync`、`/opsx-archive` 默认组合「内置 OPSX 工作流正文 + 当前引擎事实（artifact/任务/delta/主 spec/校验/context/rules）+ 验证与收尾契约」并提交给模型；命令本身不写盘。
- **命令标志**：`--dry-run`（只读预览）、`--yes`（确定性合并/归档快路径，不产生模型消息）、archive 的 `--skip-specs`（AI 已完成合并时只移动目录）。
- Host `/dsh-spec` 的 `instructions` 路由新增 `sync`、`archive` 两种工作流提示词。

### Changed

- `/opsx-sync`、`/opsx-archive` 不带 `--yes` 时的默认行为从「确定性预览」改为「提交 OPSX AI 工作流」；预览改用 `--dry-run`。
- 面板/快捷条的「归档」按钮默认填入 `/opsx-archive <name> --yes`（确定性一键收尾）；手动输入不带 `--yes` 的 `/opsx-archive` 仍走 OPSX AI 归档工作流。
- 会话工作区在文件监听之外增加 4s 轮询兜底：归档（目录移动）等不一定触发文件监听的操作完成后，面板与快捷条会在几秒内刷新到新状态（归档按钮切换为下一步）。
- 归档未完成任务：确定性 `--yes` 路径对齐上游 CLI，改为**警告后继续**（校验 ERROR 仍一律拒绝）；AI 路径要求先向用户确认。
- 面板同步预览文案更新为「`--yes` 确定性写入，或直接执行让 AI 智能合并」；构建产物新增 `lib/native-snapshot/skills/**` 与 `lib/native/skill-adaptation.js`。
- 插件版本 `0.2.0` → `0.3.0`。

### Notes

- 扩展工作流（new / continue / ff / verify / bulk-archive / onboard）通过内置 skills 的**文件语义**完成，命令面仍保持九条（不新增 `/opsx-new` 等命令）。
- AI 智能合并直接编辑主 specs，提示词内嵌 canonical 验证契约（标题 / Purpose / 无 delta 头 / requirement+scenario 结构 / 四类操作结果）；确定性 `--yes` 路径始终可作为对照与回退。
- 测试改为使用提交到仓库的 `tests/fixtures/workspace/` 夹具，不再依赖宿主工作区的实时状态。

## 0.2.0

原生 OPSX 语义对齐（目标 OpenSpec 1.14.3，commit `c794978`，MIT）。插件从"硬编码四阶段 + 三件套"升级为 OpenSpec 原生内容的前端，仍然零运行时依赖、不调用 openspec CLI。

### Added

- **原生语义引擎**（`src/native/**`，Host 侧纯 JS，零子进程零网络）：YAML 子集解析、项目 `config.yaml`（`config.yml` 回退）、change `.openspec.yaml`（schema 优先级 change > project > 默认，`skip_specs` / `retire_capabilities`、未知键警告、`x-` 键静默接受）、schema 解析（项目 `openspec/schemas/<name>/` 优先，内置快照回退）、artifact 图校验（重复 ID / 悬空依赖 / 环 / apply 引用）、artifact 状态推导（`done` / `skipped` / `ready` / `blocked` + `missingDeps`，glob 输出）、change 级状态（`no-tasks` / `in-progress` / `complete` + `nextSteps` / `applyRequires` / `tracks`）、主 spec 与 delta spec 解析（ADDED / MODIFIED / REMOVED / RENAMED）、原生任务清单解析（`-`/`*`/`+`，只有 `x` 算完成，链接 bullet 忽略、编号任务 ID 保留）、确定性分级校验（ERROR / WARNING / INFO，带路径与行号）。
- **原生提示词组合**：按 `instruction` → `context` → `rules` → template → 依赖 → 解锁项的原生顺序组装 explore / propose / apply / update 提示词；仅注入当前 artifact 的 rules 与 `operations.apply.guidance`；`skipped` / blocked artifact 不生成创建指令。
- **内置快照**：`src/native-snapshot/spec-driven/`（schema + proposal/spec/design/tasks 四份模板）与 `ATTRIBUTION.md`；`tools/sync-native-snapshot.mjs` 可复现刷新，测试校验结构与版本标记。
- **确定性 sync / archive**：ADDED 追加、MODIFIED 整块替换、REMOVED 删除、RENAMED 重命名，delta 未提及内容逐字节保留；新 capability 自动写入 Purpose（缺失时写原生 TBD 占位）；`retire_capabilities` 删除最后一条 requirement 后移除主 spec；归档到本地日期 `YYYY-MM-DD-<name>`、拒绝已存在目标、保留 `.openspec.yaml`、遵守 `skip_specs`；写入前 dry-run 预览、ERROR 门禁、失败不落盘（临时文件 + rename）。
- **命令面补齐**：新增 `/opsx-update`、`/opsx-sync`、`/opsx-validate`；`/opsx-propose` 写入含生效 schema 与本地 `created` 的 `.openspec.yaml`；`/opsx-sync`、`/opsx-archive` 支持预览 + `--yes` 确认；`/opsx-status`、`/opsx-validate`、`/openspec-init` 直出不占模型 token；统一变更选择（显式名 / 单一自动选中 / 多个列候选）。
- **原生面板与快捷条**：面板展示生效 schema、artifact 状态 chips、可展开 `missingDeps`、`skip_specs` 信号、任务进度、原生下一步、按 `generates` 路径的工件文档、delta 操作统计、带行号的校验问题、项目配置/schema 来源、capability specs（Purpose/需求/场景计数、嵌套分组）、按本地日期分组的归档；列表分页/「还有 N 个」与文档截断提示取代静默截断。快捷条按原生下一步给出动作、显示 `skip_specs`/blocked 与检测到的原生 skills。
- **与原生 OpenSpec skills 共存**：检测项目 `.dsh/skills`、项目 `.agents/skills` 与用户技能根目录下的 `openspec-*` 技能；原生缺失且 DSH 提供 `ctx.skills` 时注册工作区感知 fallback provider（六个 core 工作流，文件语义、无 CLI 调用、带改编来源与版本标注），原生技能出现后自动让位，且从不改写原生技能文件。

### Changed

- `/openspec-init` 与面板初始化改为原生骨架：只创建 `openspec/config.yaml`（`schema` + 注释示例，不含占位 context）、`openspec/specs/`、`openspec/changes/archive/` 锚点；不再创建 `openspec/README.md` 与中文占位 context；已存在文件不覆盖，只报告新建项。
- 面板与命令中的 change 进展不再来自 draft / proposed / apply / ready 四阶段，而是 schema artifact 状态 + `nextSteps` + 任务进度；旧阶段徽标只保留为派生的样式映射。
- `/opsx-archive` 不再向模型提交归档提示词，改由确定性引擎执行。
- 构建流程：`node tools/build.mjs` 现在同时拷贝 `src/native/**`、`src/native-snapshot/**`，并内联 `src/client-helpers.js`；构建结束会 import 生成的 Host 模块做加载自检。
- 插件版本 `0.1.4` → `0.2.0`。

### Notes

- 原生校验与合并是"高保真子集"：个别 OpenSpec CLI 规则不在覆盖范围（见 README「已知边界」）。有意未覆盖：`--strict` 区分、proposal Capabilities 与 delta 文件的一一对应、校验期的跨文件 REMOVED/MODIFIED 目标检查（改为合并期 ERROR）、`**Reason**`/`**Migration**` 强制、场景 WHEN/THEN 结构检查、`affected_areas`/`initiative` 语义。
- YAML 解析器覆盖常见结构；anchor / merge key / 多行 flow 等会带行号报错。
- 已有 `openspec/` 内容不做迁移或删除；`openspec/config.yaml` 中超过 50KB 的 `context` 被忽略并告警。
