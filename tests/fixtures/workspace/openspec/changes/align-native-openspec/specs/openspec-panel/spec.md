# Spec Delta

## Purpose

让 DSH 侧栏面板与会话快捷条直接呈现 OpenSpec 原生数据模型：artifact 状态、change 元数据、项目配置、delta 操作、校验问题、capability 规格与本地日期归档，并消除静默截断与硬编码阶段判定。

## ADDED Requirements

### Requirement: Native change cards

面板 SHALL 为每个进行中的 change 展示生效 schema 名、每个 artifact 的原生状态标记、任务进度、`skip_specs` / `blocked` 信号与原生建议的下一步动作。

#### Scenario: Artifact status chips shown

- **WHEN** 一个 change 含 proposal、design、specs、tasks 四个 artifact
- **THEN** 卡片按 artifact 展示 done / skipped / ready / blocked 状态，而不是单一阶段徽标

#### Scenario: Blocked dependencies explained

- **WHEN** 某 artifact 状态为 blocked
- **THEN** 卡片可展开查看其 `missingDeps` 列表

#### Scenario: Skipped specs indicated

- **WHEN** change 声明 `skip_specs: true`
- **THEN** specs artifact 显示为 skipped，且卡片不把“缺少 specs”当作错误

#### Scenario: Task progress is independent

- **WHEN** 所有 artifact 均完成但任务仍有未勾选项
- **THEN** 卡片同时显示 artifact 完成与任务进度，不把二者混为一个状态

#### Scenario: Next step follows native semantics

- **WHEN** 存在可创建的 artifact 或可执行动作
- **THEN** 卡片与快捷条展示由 artifact 状态推导的下一步，而不是固定四阶段顺序

### Requirement: Change detail

change 详情 SHALL 按生效 schema 的 `generates` 路径列出工件文档，展示 `.openspec.yaml` 元数据、delta 操作统计与校验问题，SHALL NOT 假设工件名一定是 proposal.md / specs / tasks.md。

#### Scenario: Custom artifact document shown

- **WHEN** 自定义 schema 声明 artifact `research` 生成 `research.md`
- **THEN** 详情中可打开 `research.md` 并标注其 artifact ID

#### Scenario: Metadata visible

- **WHEN** change 含 `.openspec.yaml`
- **THEN** 详情展示生效 schema、created 与 goal 等元数据

#### Scenario: Delta operation summary

- **WHEN** change 的 specs/ 下含多个 delta 文件
- **THEN** 详情按 ADDED / MODIFIED / REMOVED / RENAMED 汇总 requirement 数量

#### Scenario: Validation issues listed

- **WHEN** 校验存在 ERROR 或 WARNING
- **THEN** 详情按级别列出问题，并可定位到文件路径与可用时的行号

### Requirement: Project configuration and schemas

面板 SHALL 展示项目生效 schema、context 摘要、按 artifact 分组的 rules，以及可用的项目本地与内置 schema 列表。

#### Scenario: Config summary displayed

- **WHEN** 项目 `openspec/config.yaml` 含 schema、context 与 rules
- **THEN** 面板展示 schema 名、context 摘要与规则数量，并可展开查看 rules

#### Scenario: Available schemas listed

- **WHEN** 项目存在 `openspec/schemas/<name>/schema.yaml`
- **THEN** 面板把这些 schema 与内置快照一起列出并标明来源

### Requirement: Capability specs view

主 specs 视图 SHALL 为每个 capability 展示 Purpose、requirement 数量、scenario 数量与校验问题，并支持嵌套 capability 路径分组。

#### Scenario: Capability summary shown

- **WHEN** `openspec/specs/<capability>/spec.md` 含 Purpose 与多条 requirement
- **THEN** 列表展示 Purpose 摘要、requirement 数与 scenario 数

#### Scenario: Nested capabilities grouped

- **WHEN** capability 路径为 `identity/user-auth`
- **THEN** 面板按路径层级分组展示，而不是把斜杠路径当作单个名称

### Requirement: Archive view

归档视图 SHALL 按本地归档日期对已归档 change 分组，并按需读取其工件、任务与元数据。

#### Scenario: Archive grouped by local date

- **WHEN** `changes/archive/` 下存在 `2026-10-20-<name>` 形式的目录
- **THEN** 面板按日期分组展示，并显示该 change 的名称

#### Scenario: Archived detail on demand

- **WHEN** 用户展开一个已归档 change
- **THEN** 面板按需读取并展示其工件、任务完成情况与元数据

### Requirement: Data volume and freshness

面板 SHALL 避免静默截断：change/spec/文档数量超过展示阈值时应分页或明确提示，文档读取被截断时应显示提示；状态 SHALL 由文件变化驱动刷新，且不保存任何隐藏状态。

#### Scenario: Many changes are paged or flagged

- **WHEN** 进行中的 change 数量超过单页阈值
- **THEN** 面板显示分页或“还有 N 个”提示，而不是静默丢弃

#### Scenario: Truncated document is indicated

- **WHEN** 单文档读取达到行数或字节上限
- **THEN** 阅读器显示截断提示与后续读取入口

#### Scenario: Changes refresh from files

- **WHEN** 外部进程修改 `openspec/` 下的文件
- **THEN** 面板在监听或兜底轮询后刷新状态；工作区无会话时使用轮询

#### Scenario: No hidden state

- **WHEN** 面板重启或刷新
- **THEN** 全部展示内容重新从工作区文件推导，不依赖插件内部保存的进度

### Requirement: Native initialization

面板的初始化动作 SHALL 创建与原生一致的最小骨架：仅含 schema 与注释示例的 `config.yaml`、`specs/` 与 `changes/archive/` 锚点；SHALL NOT 创建非原生 README 或占位 context，且已存在文件不被覆盖。

#### Scenario: Initialize a fresh workspace

- **WHEN** 对没有 `openspec/` 的工作区点击初始化
- **THEN** 创建 `config.yaml`、`specs/.gitkeep` 与 `changes/archive/.gitkeep`，并返回新建项列表

#### Scenario: No placeholder context written

- **WHEN** 初始化生成 `config.yaml`
- **THEN** 文件中只有 `schema: spec-driven` 与注释示例，不写入占位 project context

#### Scenario: Existing files preserved

- **WHEN** 工作区已有 `config.yaml` 或 specs 内容
- **THEN** 初始化不覆盖、不删除任何已存在文件
