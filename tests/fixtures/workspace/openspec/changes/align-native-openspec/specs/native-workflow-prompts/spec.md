# Spec Delta

## Purpose

按 OpenSpec 原生的 schema instruction、模板、项目 context、artifact rules 与依赖状态组合阶段提示词，并内置一份带版本与 MIT 归属的原生快照作为回退，使模型收到的规划契约与原生 OpenSpec 一致。

## ADDED Requirements

### Requirement: Native instruction composition

提示词组合器 SHALL 使用生效 schema 中该 artifact 的 `instruction`、模板、依赖完成状态、解析后的输出路径、项目 `context` 与该 artifact 的 `rules` 组装消息，组合顺序 SHALL 与原生指令加载一致：instruction、context、rules、template、依赖、解锁项。

#### Scenario: Proposal prompt contains native instruction and template

- **WHEN** 为 `proposal` artifact 组合提示词
- **THEN** 消息包含 schema 的 proposal instruction、原生 proposal 模板、项目 context、proposal rules 与 proposal 的输出路径

#### Scenario: Apply prompt carries tracked tasks instruction

- **WHEN** 为 apply 组合提示词
- **THEN** 消息包含 apply instruction、`apply.tracks` 指向的任务文件、项目 context 与 apply rules

#### Scenario: Skipped artifact not offered for creation

- **WHEN** 某 artifact 状态为 `skipped` 或依赖未完成
- **THEN** 提示词不要求模型创建该 artifact，而是说明其状态与可用动作

#### Scenario: Unknown schema falls back to snapshot

- **WHEN** 项目 config 引用的 schema 不存在于项目目录
- **THEN** 组合器回退到内置快照并附加一条 schema 回退说明，而不是生成空提示词

### Requirement: Planning boundaries

每个工作流提示词 SHALL 保留原生边界：explore 只调查与讨论、propose 只产出规划工件并停止、update 只修改规划工件、apply 按任务实现并勾选、archive 由确定性引擎执行而不产生模型内容。

#### Scenario: Propose stops at the plan

- **WHEN** 执行 propose
- **THEN** 提示词要求模型写完 proposal、delta specs、design（按需）与 tasks 后停止，不写产品代码，并等待评审

#### Scenario: Update never edits code

- **WHEN** 执行 update
- **THEN** 提示词限定只修改已有规划工件，需要代码变更时指向 apply

#### Scenario: Apply ticks tasks as it works

- **WHEN** 执行 apply
- **THEN** 提示词要求从第一个未勾选任务开始、每完成一项修改对应复选框，并按 `apply.tracks` 的文件记录进度

#### Scenario: Archive produces no model message

- **WHEN** 执行 archive
- **THEN** 命令调用确定性合并与归档引擎并直出结果，不向模型提交归档内容

### Requirement: Bundled native snapshot

插件 SHALL 内置一份固定版本的原生 `spec-driven` schema instruction 与四个模板快照，附带 MIT 归属、上游版本与提取说明，且 SHALL 仅在项目没有同名 schema 时使用；快照的刷新方式 SHALL 可被开发者复现。

#### Scenario: Snapshot used only as fallback

- **WHEN** 项目存在 `openspec/schemas/spec-driven/schema.yaml`
- **THEN** 组合器使用项目定义，内置快照不参与该 schema 的指令生成

#### Scenario: Missing project schemas

- **WHEN** 项目没有任何 `openspec/schemas/` 目录
- **THEN** 使用内置快照完成组合，并在结果元数据中记录快照版本

#### Scenario: Attribution and version recorded

- **WHEN** 查看快照目录
- **THEN** 可以找到上游仓库地址、版本号、commit、MIT 声明与提取/刷新说明

#### Scenario: Snapshot refresh is reproducible

- **WHEN** 开发者运行快照同步脚本
- **THEN** 快照内容与版本标记被更新，且测试校验快照结构与版本标记存在

### Requirement: Context and rules injection

提示词 SHALL 为每个 artifact 注入项目 `context`、仅注入该 artifact 的 `rules`；当项目 config 定义了 `operations.apply` 或 `operations.archive` 的 guidance 时，apply 提示词 SHALL 包含对应说明。

#### Scenario: Context always included when present

- **WHEN** 项目 config 定义了非空 context
- **THEN** explore、propose、apply、update 的提示词都包含该 context

#### Scenario: Only matching rules included

- **WHEN** config 为 `specs` 与 `tasks` 分别定义了 rules，当前 artifact 是 `specs`
- **THEN** 提示词包含 specs rules，不包含 tasks rules

#### Scenario: Operation guidance applied

- **WHEN** config 的 `operations.apply.guidance` 非空
- **THEN** apply 提示词包含该 guidance；未配置时不出现该段
