# Spec Delta

## Purpose

在不调用 openspec CLI 的前提下，把 OpenSpec 原生项目配置、变更元数据、schema、artifact 状态、规格文档、任务清单与校验规则解析为插件内部可复用的数据模型，作为面板、命令与提示词的唯一事实来源。

## ADDED Requirements

### Requirement: Project configuration parsing

宿主侧 SHALL 读取 `openspec/config.yaml`，仅当它不存在时回退到 `config.yml`，并解析 `schema`、`context`、`rules`、`operations`；单字段非法、YAML 语法错误或超过 50KB 的 context SHALL 以警告降级，且不得阻断其余能力。

#### Scenario: Read a valid project config

- **WHEN** `openspec/config.yaml` 包含 `schema`、`context` 与按 artifact 分组的 `rules`
- **THEN** 引擎返回解析后的 schema 名、context 文本，以及以 artifact ID 为键的 rules 映射

#### Scenario: Fall back to config.yml

- **WHEN** 工作区只有 `openspec/config.yml`
- **THEN** 引擎从 `config.yml` 读取同样的字段，并在仅两者都存在时优先 `config.yaml`

#### Scenario: Degrade on invalid YAML

- **WHEN** 配置文件存在但 YAML 语法非法
- **THEN** 引擎返回带文件路径与行号的警告，并使用默认值 `schema: spec-driven`、空 context 与空 rules 继续工作

#### Scenario: Ignore oversized context

- **WHEN** `context` 字段超过 50KB
- **THEN** 引擎忽略该字段、保留其他字段，并返回一条 context 过大的警告

### Requirement: Change metadata awareness

引擎 SHALL 读取每个 change 的 `.openspec.yaml`，按“change 元数据 > 项目 config > 内置默认”的优先级解析生效 schema，并识别 `created`、`goal`、`skip_specs`、`retire_capabilities`；未知键 SHALL 产生警告，`x-` 前缀扩展键 SHALL 静默接受。

#### Scenario: Metadata overrides project schema

- **WHEN** change 的 `.openspec.yaml` 声明 `schema: research-first`，项目 config 声明 `schema: spec-driven`
- **THEN** 该 change 使用 `research-first` 解析 artifact 图，其他 change 仍使用 `spec-driven`

#### Scenario: Metadata absent

- **WHEN** change 目录没有 `.openspec.yaml`
- **THEN** 生效 schema 取自项目 config，缺省时为 `spec-driven`，且不产生错误

#### Scenario: Invalid metadata is reported

- **WHEN** `.openspec.yaml` 的 `created` 不是 `YYYY-MM-DD`
- **THEN** 引擎返回 ERROR 级元数据问题，同时仍把该 change 列在面板中供查看与修复

#### Scenario: Unknown and extension keys

- **WHEN** `.openspec.yaml` 含未知键 `owner` 与扩展键 `x-team`
- **THEN** `owner` 产生 WARNING，`x-team` 被接受且不产生问题

#### Scenario: Honor skip_specs

- **WHEN** `.openspec.yaml` 声明 `skip_specs: true`
- **THEN** 该 change 的 specs artifact 状态为 `skipped`，且不因缺少 delta specs 而报“必须至少有一个 delta”

### Requirement: Schema resolution and artifact graph

引擎 SHALL 先从 `openspec/schemas/<name>/schema.yaml` 解析 schema，找不到时才使用内置快照，并 SHALL 校验 artifact 的 `id`、`generates`、`requires` 与 `apply.requires`，对重复 ID、悬空依赖、循环依赖和缺失的 apply 引用给出带路径的问题。

#### Scenario: Project-local schema wins

- **WHEN** 项目 `openspec/schemas/research-first/schema.yaml` 与内置快照存在同名或不同名 schema
- **THEN** 项目目录中的定义被使用，内置快照只在该名称不存在时被读取

#### Scenario: Built-in snapshot fallback

- **WHEN** 项目没有 `openspec/schemas/spec-driven/` 目录
- **THEN** 引擎使用内置 `spec-driven` 快照，并记录快照的上游版本

#### Scenario: Custom artifacts and glob outputs

- **WHEN** schema 声明 artifact `research` 生成 `research.md`，以及 artifact `specs` 生成 `specs/**/*.md`
- **THEN** 引擎识别两种输出路径，并按 glob 是否至少匹配一个文件判定该 artifact 是否完成

#### Scenario: Invalid schema reported

- **WHEN** schema 含重复 artifact ID、未知的 `requires` 引用或依赖环
- **THEN** 引擎返回 ERROR 级 schema 问题并指出具体 artifact，change 仍可被列出但状态标记为 schema 错误

#### Scenario: Apply contract exposed

- **WHEN** schema 声明 `apply.requires` 与 `apply.tracks`
- **THEN** 引擎把 apply 前置 artifact 与任务跟踪文件暴露给命令与面板

### Requirement: Native artifact state

引擎 SHALL 从 schema 图与文件系统推导每个 artifact 的 `done`、`skipped`、`ready`、`blocked` 状态并报告 `missingDeps`，同时 SHALL 暴露 change 级状态 `no-tasks`、`in-progress`、`complete` 与任务进度，且不得再使用 draft / proposed / apply / ready 作为判定真相。

#### Scenario: Artifact completes when its output exists

- **WHEN** artifact 的 `generates` 指向的普通文件存在
- **THEN** 该 artifact 状态为 `done`

#### Scenario: Glob artifact completes on first match

- **WHEN** artifact 生成 `specs/**/*.md` 且至少存在一个匹配文件
- **THEN** 该 artifact 状态为 `done`

#### Scenario: Blocked artifacts report missing dependencies

- **WHEN** artifact 的某个 `requires` 尚未完成
- **THEN** 该 artifact 状态为 `blocked`，并按依赖 ID 列出 `missingDeps`

#### Scenario: Skipped artifact satisfies dependencies

- **WHEN** `.openspec.yaml` 的 `skip_specs: true` 使 specs artifact 为 `skipped`
- **THEN** 依赖 specs 的 artifact 不因 specs 缺失而被标记 blocked

#### Scenario: Change status follows native semantics

- **WHEN** 所有 artifact 均为 `done` 或 `skipped` 且任务全部勾选
- **THEN** change 状态为 `complete`；任务为空时为 `no-tasks`，其余为 `in-progress`

#### Scenario: Legacy phase is not authoritative

- **WHEN** 面板或命令需要展示 change 进展
- **THEN** 进展来自 artifact 状态、`nextSteps` 与任务进度，而不是 draft / proposed / apply / ready

### Requirement: Delta spec parsing

引擎 SHALL 解析 `specs/<capability-path>/spec.md` 中的 `ADDED`、`MODIFIED`、`REMOVED`、`RENAMED` requirement 操作，只在 `### Requirement:` 处识别 requirement、在 `#### Scenario:` 处识别 scenario，并 SHALL 把格式错误的标题与 `specs/` 根目录下的 spec 文件报告为问题。

#### Scenario: Parse all four delta operations

- **WHEN** delta 文件包含 `## ADDED Requirements`、`## MODIFIED Requirements`、`## REMOVED Requirements` 与 `## RENAMED Requirements`
- **THEN** 引擎分别给出四类操作及其 requirement 名称列表与数量

#### Scenario: Scenarios parsed with WHEN/THEN

- **WHEN** requirement 下包含 `#### Scenario: <name>` 与 `- **WHEN**` / `- **THEN**` 条目
- **THEN** 引擎把 scenario 名称与正文挂到对应 requirement 上

#### Scenario: Wrong scenario heading level

- **WHEN** 场景使用 `### Scenario:` 或普通 bullet 而非 `#### Scenario:`
- **THEN** 引擎报告 WARNING 或 ERROR，指出场景必须使用四级标题，且该 requirement 会被视为缺少 scenario

#### Scenario: Stray spec file at specs root

- **WHEN** change 的 `specs/spec.md` 直接位于 `specs/` 根而不是 capability 子目录
- **THEN** 引擎报告 ERROR，说明 delta 必须位于 `specs/<capability-path>/spec.md`

#### Scenario: Requirement without scenario

- **WHEN** `ADDED` 或 `MODIFIED` requirement 没有任何 `#### Scenario:` 块
- **THEN** 引擎报告 ERROR

### Requirement: Main specification parsing

引擎 SHALL 解析 `openspec/specs/<capability-path>/spec.md`（含嵌套 capability 路径）的 `## Purpose`、`## Requirements` 与 requirement/scenario 结构，供面板展示与合并计划使用。

#### Scenario: Parse purpose and requirements

- **WHEN** 主 spec 含 `## Purpose` 与多条 `### Requirement:` 块
- **THEN** 引擎返回 Purpose 文本、requirement 数量与每个 requirement 的 scenario 数量

#### Scenario: Nested capability path

- **WHEN** capability 位于 `openspec/specs/identity/user-auth/spec.md`
- **THEN** 引擎以 `identity/user-auth` 作为 capability 路径读取并按树形分组展示

#### Scenario: Missing required sections

- **WHEN** 主 spec 缺少 `## Purpose` 或 `## Requirements`
- **THEN** 引擎报告 ERROR，指出缺失的小节，同时仍返回可解析出的其余内容

### Requirement: Tasks parsing parity

引擎 SHALL 按原生规则统计任务复选框：bullet 可为 `-`、`*` 或 `+`；只有勾选 `x`/`X` 视为完成；其他任何标记（如 `[~]`、`[-]`、空框）视为未完成；形如 `- [text](url)` 的链接 bullet 不参与统计；并保留编号任务 ID。

#### Scenario: Mixed bullet and marker forms

- **WHEN** `tasks.md` 同时包含 `- [x] 1.1`、`* [ ] 1.2`、`+ [~] 1.3` 与 `- [ ] 1.4`
- **THEN** 引擎统计 4 项任务、1 项完成，且不把 `1.3` 误计为已完成

#### Scenario: Empty checkbox counts as a task

- **WHEN** 某行是 `- [ ]` 且其后没有任务文字
- **THEN** 该行仍计入任务总数并记为未完成

#### Scenario: Link bullet ignored

- **WHEN** 某行是 `- [docs](https://example.com)` 这类链接 bullet
- **THEN** 该行不被计入任务数

#### Scenario: Task ids preserved

- **WHEN** 任务使用 `- [ ] 2.3 <description>` 编号
- **THEN** 引擎以 `2.3` 作为任务 ID 暴露，供面板与 apply 提示引用

### Requirement: Native validation subset

引擎 SHALL 对 proposal、delta spec、主 spec、tasks 与 change 元数据执行确定性校验，并按 `ERROR`、`WARNING`、`INFO` 级别返回问题、文件路径与可用时的行号；校验 SHALL NOT 写文件，也 SHALL NOT 提交模型工作。

#### Scenario: Clean change produces no issues

- **WHEN** proposal、delta、tasks 与元数据均满足原生格式
- **THEN** 校验返回空问题列表

#### Scenario: Why too short or too long

- **WHEN** `## Why` 少于 50 字符或超过 1000 字符
- **THEN** 引擎分别返回 ERROR 或 WARNING，并给出对应阈值

#### Scenario: Missing scenario or SHALL keyword

- **WHEN** ADDED requirement 缺少 `#### Scenario:` 或正文不含 SHALL/MUST
- **THEN** 引擎返回 ERROR 并指出具体 requirement 名称

#### Scenario: skip_specs conflict

- **WHEN** `.openspec.yaml` 声明 `skip_specs: true` 但 change 的 `specs/` 下存在 delta 文件
- **THEN** 引擎返回 ERROR，提示二者只能取其一

#### Scenario: Warnings do not block

- **WHEN** 校验只产生 WARNING 级问题
- **THEN** 结果把问题列出但报告为可通过，命令可继续执行

#### Scenario: Validation is deterministic and read-only

- **WHEN** 对同一份文件连续执行两次校验
- **THEN** 两次返回完全相同的问题列表，且工作区文件内容与修改时间不变

### Requirement: In-process computation

引擎 SHALL 仅使用工作区文件在进程内计算全部原生语义，SHALL NOT 要求或调用 openspec CLI、子进程或网络来解析配置、推导状态或执行校验。

#### Scenario: Works without the openspec CLI

- **WHEN** 机器上没有安装 openspec CLI 或不在 PATH 中
- **THEN** 配置解析、状态推导与校验仍全部可用

#### Scenario: No subprocess or network use

- **WHEN** 引擎执行任意解析、状态推导或校验操作
- **THEN** 不产生子进程调用，也不发起网络请求；测试以禁止的注入桩断言这一点
