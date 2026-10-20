# Spec Delta

## Purpose

以确定性方式把 change 的 delta specs 合并进主 specs 并归档 change，完整支持 ADDED、MODIFIED、REMOVED、RENAMED 语义，配合校验门禁、dry-run 预览、确认后写入与失败不落盘的写入安全。

## ADDED Requirements

### Requirement: Delta application

合并引擎 SHALL 把 change 的 delta specs 应用到 `openspec/specs/<capability-path>/spec.md`：ADDED 追加 requirement、MODIFIED 整体替换同名 requirement 块、REMOVED 删除同名块、RENAMED 重命名标题；delta 未提及的内容 SHALL 逐字节保留。

#### Scenario: ADDED appends a requirement

- **WHEN** delta 含 `## ADDED Requirements` 且主 spec 中不存在同名 requirement
- **THEN** 主 spec 的 Requirements 区按 delta 顺序追加该 requirement 及其 scenarios

#### Scenario: MODIFIED replaces the whole block

- **WHEN** delta 含与主 spec 同名的 MODIFIED requirement
- **THEN** 主 spec 中原 requirement 的正文与全部 scenarios 被完整替换，而不是仅追加缺失部分

#### Scenario: REMOVED deletes the requirement

- **WHEN** delta 含与主 spec 同名的 REMOVED requirement
- **THEN** 主 spec 中对应的 requirement 块被删除

#### Scenario: RENAMED retitles in place

- **WHEN** delta 的 `## RENAMED Requirements` 使用 FROM/TO 声明改名
- **THEN** 主 spec 中 FROM 的 requirement 标题改为 TO，其余内容保持原位

#### Scenario: Untouched content preserved

- **WHEN** 主 spec 含 delta 未提及的 requirement、Purpose 或说明文字
- **THEN** 合并结果中这些内容与合并前完全一致

#### Scenario: New capability creation

- **WHEN** delta 指向一个尚不存在的主 spec
- **THEN** 引擎按原生结构创建 `openspec/specs/<capability-path>/spec.md`，写入 Purpose（delta 无 Purpose 时写原生占位文本）与 Requirements

#### Scenario: Unsafe merge rejected

- **WHEN** ADDED 与主 spec 同名，或 MODIFIED / REMOVED / RENAMED 指向不存在的 requirement
- **THEN** 引擎报告对应 ERROR，且不写入任何文件

### Requirement: Validation gate

sync 与 archive SHALL 在写入前执行原生校验；存在 ERROR 时 SHALL 拒绝写入，存在 WARNING 时 SHALL 继续并在结果中列出警告。

#### Scenario: Error blocks the write

- **WHEN** change 校验存在 ERROR
- **THEN** 引擎返回问题清单并拒绝合并或归档，主 specs 与 change 目录保持原样

#### Scenario: Warnings allowed but reported

- **WHEN** change 校验只有 WARNING
- **THEN** 引擎继续执行并把警告包含在结果中

#### Scenario: Clean change proceeds

- **WHEN** change 校验没有任何问题
- **THEN** 引擎进入预览或写入流程

### Requirement: Preview and confirmation

写入前引擎 SHALL 生成 dry-run 预览，列出受影响的主 spec、每个 requirement 的操作与归档目标；SHALL 仅在显式确认后写入。

#### Scenario: Preview writes nothing

- **WHEN** 生成 sync 或 archive 预览
- **THEN** 工作区文件内容与修改时间保持不变

#### Scenario: Confirmation applies changes

- **WHEN** 用户在预览后确认
- **THEN** 引擎按预览内容写入主 specs 并（归档时）移动 change 目录

#### Scenario: Cancel preserves files

- **WHEN** 预览被取消或未确认
- **THEN** 不写入任何主 spec，不移动 change 目录

### Requirement: Archive semantics

归档 SHALL 把 change 移动到 `openspec/changes/archive/YYYY-MM-DD-<name>/`（本地日期）、拒绝已存在的目标目录、保留 `.openspec.yaml`，并 SHALL 遵守 `skip_specs` 与 `retire_capabilities`。

#### Scenario: Local date prefix

- **WHEN** 在本地时间 2026-10-20 归档 change `add-x`
- **THEN** 目标目录为 `openspec/changes/archive/2026-10-20-add-x/`

#### Scenario: Existing archive target refused

- **WHEN** 归档目标目录已存在
- **THEN** 归档返回错误并不移动任何内容

#### Scenario: skip_specs archive

- **WHEN** change 声明 `skip_specs: true`
- **THEN** 归档不写主 specs，只执行移动与结果报告

#### Scenario: retire_capabilities honored

- **WHEN** change 声明 `retire_capabilities: true` 且 delta 删除了某 capability 的最后一条 requirement
- **THEN** 对应主 spec 文件被移除；未声明 retire_capabilities 时保留空 capability

#### Scenario: Metadata retained in archive

- **WHEN** change 含 `.openspec.yaml`
- **THEN** 归档后的目录中仍保留该文件

### Requirement: Write safety

引擎 SHALL 把写入限制在会话工作区内，SHALL 在任一步失败时保持主 specs 与 change 目录与操作前一致。

#### Scenario: Writes stay inside the workspace

- **WHEN** 目标路径解析后位于工作区之外
- **THEN** 写入被拒绝并返回错误，不产生任何文件

#### Scenario: Failure leaves files unchanged

- **WHEN** 合并或移动过程中发生写入错误
- **THEN** 已写入的临时内容被清理，主 specs 与 change 目录恢复为操作前状态

#### Scenario: Path traversal rejected

- **WHEN** capability 路径或 change 名包含 `..` 或其他越界片段
- **THEN** 引擎拒绝处理并返回 ERROR
