# Proposal

## Why

dsh-spec 目前把 OpenSpec 简化成硬编码的四阶段（draft / proposed / apply / ready）与固定的 proposal / specs / tasks 三件套：它不读 `openspec/config.yaml` 的 context/rules，不读 `.openspec.yaml`，不认项目自定义 schema，也不解析 delta 操作与原生校验结果。同一个 OpenSpec 仓库因此在 CLI 与面板里呈现两套结论：只含 `.openspec.yaml` 的 change 被标成「草稿」，`skip_specs` 的 change 被误判为缺 specs，`- [~]` / `+ [ ]` 任务不计入进度，归档日期与 spec 合并完全交给模型自由发挥。上游 OpenSpec 1.14 已把工作流重构为 schema 驱动的 OPSX，并原生支持 DSH skills；继续维护一套偏离原生的语义，会让面板、命令与 agent 提示词同时失去可信度。因此需要一个不依赖 openspec CLI、完全由工作区文件推导的原生语义层，把插件升级为 OpenSpec 原生内容的 DSH 前端。

## What Changes

- 新增 Host 侧纯 JS 原生语义引擎：读取 `config.yaml` / `.openspec.yaml`，解析项目 schema 与 artifact 依赖图，推导 done / skipped / ready / blocked 状态，解析主 specs 与 delta specs、任务清单，并给出原生分级校验结果。
- 阶段提示词改为由原生 `instruction` + template + context + rules + 依赖状态组合而成；内置一份带版本与 MIT 归属的原生 `spec-driven` 快照作为无项目 schema 时的回退。
- 面板改为展示原生数据：change 的 schema 与 artifact 状态、元数据、delta 操作统计、校验问题、capability Purpose / 需求 / 场景、按本地日期分组的归档；移除静默截断与硬编码四阶段。
- 命令面补齐原生 core profile：`opsx-update`、`opsx-sync`、`opsx-validate`，并让 `opsx-propose` 创建包含 `.openspec.yaml` 的原生 change 骨架；补全变更选择与直出输出语义。
- 新增确定性 spec 同步与归档引擎：按 ADDED / MODIFIED / REMOVED / RENAMED 合并 delta specs，校验门禁、dry-run 预览、确认后写入、本地日期归档。
- 检测并共存于 OpenSpec 原生 DSH skills；原生 skills 缺失时提供仅用于 core 工作流的文件语义 fallback skill provider（不调用 CLI）。
- `openspec-init` 对齐原生骨架（仅 schema/注释、原生锚点，不创建非原生 README 与占位 context），并更新 README、测试与版本说明。

## Capabilities

### New Capabilities

- `native-opsx-model`: Host 侧纯 JS 原生语义引擎——项目配置、change 元数据、schema 与 artifact 图、原生状态、主/增量 specs、任务清单与分级校验。
- `native-workflow-prompts`: 按原生指令、模板、context、rules 与依赖状态组合各阶段提示词，并内置带版本与归属的原生快照回退。
- `opsx-command-surface`: 对齐原生 core 工作流的 DSH 命令面，含 propose 原生脚手架、update 规划修订、变更选择与 status/validate 直出。
- `openspec-panel`: 面板与快捷条展示原生状态、元数据、delta 统计、校验问题、capability 规格与归档，并消除静默截断。
- `specs-sync-archive`: 确定性合并 delta specs 与归档 change，含校验门禁、预览确认与失败不落盘的写入安全。
- `openspec-skills-integration`: 检测并共存于 OpenSpec 原生 DSH skills，在缺失时提供不依赖 CLI 的文件语义 fallback。

### Modified Capabilities

（无：当前 `openspec/specs/` 为空，本次全部是新增能力。）

## Impact

- 代码：`src/host.js`、`src/prompts.js`、`src/client.js`、`tools/build.mjs`，新增 `src/native/**` 与 `src/native-snapshot/**`；`package.json` 版本与 `files` 调整。
- 行为：面板阶段徽标与派生逻辑被原生 artifact 状态取代；`/opsx-*` 命令新增 update / sync / validate，propose 会写入 `.openspec.yaml`；初始化不再写占位 context 与 README。
- 兼容性：不依赖 openspec CLI 或新运行时依赖；已有 `openspec/` 目录不被迁移或删除，新逻辑只读文件、按需写入。
- 风险：原生语义随上游演进而漂移，需要内置快照的版本标注与刷新机制；确定性 spec 合并需要原生 fixture 测试与失败回滚。
- 范围内不做：自定义 schema 的可视化编辑、store / workspace / initiative 等进阶原生能力、expanded 命令（new / continue / ff / verify / bulk-archive / onboard）的完整实现。
