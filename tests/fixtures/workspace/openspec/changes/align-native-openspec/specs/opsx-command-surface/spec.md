# Spec Delta

## Purpose

把 OpenSpec 原生 core 工作流动作暴露为符合 DSH 命令语法与交互约束的 `/opsx-*` 命令，补齐 update、sync、validate，统一 propose 的原生脚手架、变更选择与直出输出语义。

## ADDED Requirements

### Requirement: Core command family

插件 SHALL 注册 explore、propose、apply、update、sync、archive、validate、status、init 九个命令，并 SHALL 在命令描述与文档中记录原生 `/opsx:*` 到 DSH kebab-case 名称的映射，因为 DSH 命令名不能包含冒号。

#### Scenario: All core commands registered

- **WHEN** 插件在 Host 侧启用
- **THEN** `/opsx-explore`、`/opsx-propose`、`/opsx-apply`、`/opsx-update`、`/opsx-sync`、`/opsx-archive`、`/opsx-validate`、`/opsx-status`、`/openspec-init` 均可被发现与执行

#### Scenario: Native mapping documented

- **WHEN** 用户查看 README 或命令描述
- **THEN** 可以看到原生 `explore`、`propose`、`apply`、`update`、`sync`、`archive` 分别对应哪些命令

#### Scenario: Colon syntax not advertised

- **WHEN** 文档或命令提示提及阶段命令
- **THEN** 使用 `opsx-*` 形式，不宣称支持 `opsx:*` 冒号语法

### Requirement: Propose native scaffolding

`/opsx-propose` SHALL 校验并规范化 change 名、在 `openspec/` 未初始化时先行初始化、拒绝已存在的 change 目录，并在提交 plan-only 提示词前创建包含生效 schema 与本地日期 `created` 的 `.openspec.yaml`。

#### Scenario: New change gets native metadata

- **WHEN** 对一个新名称执行 propose
- **THEN** 创建 `openspec/changes/<name>/` 与 `.openspec.yaml`（含 `schema` 与本地 `YYYY-MM-DD` 的 `created`），随后提交规划提示词

#### Scenario: Existing change refused

- **WHEN** `openspec/changes/<name>/` 已存在
- **THEN** 命令返回错误，并提示用 apply 继续或直接修改规划工件，不覆盖任何文件

#### Scenario: Uninitialized workspace initialized first

- **WHEN** 工作区还没有 `openspec/`
- **THEN** 命令先执行幂等初始化，再创建 change 骨架与提示词

#### Scenario: Schema comes from project config

- **WHEN** 项目 config 的 `schema` 不是默认值
- **THEN** `.openspec.yaml` 写入该生效 schema 名

#### Scenario: Invalid change name refused

- **WHEN** 输入的名称为空或无法规范化为 kebab-case
- **THEN** 命令返回用法错误，不创建任何目录

### Requirement: Update command

`/opsx-update` SHALL 针对已存在的 change 组合原生 update 指令，把模型限制在已有规划工件内并保持工件间一致，SHALL NOT 允许直接修改产品代码。

#### Scenario: Revise an existing artifact

- **WHEN** 对含 proposal、specs、tasks 的 change 执行 update 并给出修订要求
- **THEN** 提示词要求模型读取现有工件、修订目标工件并同步检查相关工件的一致性

#### Scenario: No Implementation code edits

- **WHEN** 修订会隐含代码变更
- **THEN** 提示词要求只改规划工件，并把代码变更交给 apply

#### Scenario: Missing target artifact

- **WHEN** update 需要修订的工件尚不存在
- **THEN** 命令提示该工件应由 propose 或后续 create 动作生成，而不是凭空创建

#### Scenario: Multiple active changes

- **WHEN** 存在多个进行中的 change 且未指定名称
- **THEN** 命令返回候选列表与各自状态，不进行猜测

### Requirement: Sync and archive command delegation

`/opsx-sync` 与 `/opsx-archive` SHALL 委托确定性合并与归档引擎执行，在写入前展示预览并要求确认；当校验存在 ERROR 时 SHALL 拒绝执行。

#### Scenario: Archive refused on validation errors

- **WHEN** change 校验存在 ERROR
- **THEN** archive 返回问题清单并拒绝合并与移动

#### Scenario: Sync previews before writing

- **WHEN** 执行 `/opsx-sync <name>`
- **THEN** 先返回受影响的主 specs 与 requirement 变更摘要，等待确认后才写入

#### Scenario: Confirmation applies the merge

- **WHEN** 用户确认预览
- **THEN** 引擎执行合并并返回更新了哪些主 spec 文件

#### Scenario: Cancel leaves files unchanged

- **WHEN** 用户取消预览或命令未获得确认
- **THEN** 不写入任何文件，主 specs 与 change 目录保持原样

#### Scenario: Incomplete tasks block archive

- **WHEN** `tasks.md` 仍存在未勾选任务
- **THEN** archive 返回未完成任务清单并拒绝归档

### Requirement: Change selection

对 change 执行动作的命令 SHALL 优先使用显式传入的名称；未传入时，若只有一个进行中的 change 则自动选中；存在多个时 SHALL 返回候选列表而不是猜测。

#### Scenario: Explicit name selected

- **WHEN** 命令输入包含 change 名
- **THEN** 直接对该 change 执行，名称不存在时返回当前进行中的候选列表

#### Scenario: Single active change auto-selected

- **WHEN** 未指定名称且只有一个进行中的 change
- **THEN** 自动选中该 change 并在结果中说明

#### Scenario: Ambiguous selection lists candidates

- **WHEN** 未指定名称且存在多个进行中的 change
- **THEN** 返回候选名称与状态，不执行写操作

### Requirement: Direct outputs and idempotent initialization

`/opsx-status`、`/opsx-validate` 与 `/openspec-init` SHALL 直接返回命令结果而不提交模型消息；初始化 SHALL 幂等，已存在的文件与目录不被覆盖或删除。

#### Scenario: Status is direct

- **WHEN** 执行 `/opsx-status`
- **THEN** 直接输出进行中的 change、artifact 状态、任务进度与已归档数量，不产生模型消息

#### Scenario: Validate is direct

- **WHEN** 执行 `/opsx-validate [name]`
- **THEN** 直接输出 ERROR/WARNING 清单与统计，不产生模型消息

#### Scenario: Init is idempotent

- **WHEN** 在已初始化的工作区再次执行 `/openspec-init`
- **THEN** 只补建缺失的原生锚点与配置文件，已存在文件保持不变，并报告实际补建项
