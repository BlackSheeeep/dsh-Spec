# Spec Delta

## Purpose

检测并共存于 OpenSpec 原生 DSH skills，在不调用 openspec CLI、不复制原生技能正文的前提下，为原生技能缺失的 core 工作流提供基于文件语义的 fallback 技能，使模型的 OpenSpec 工作流入口保持可用且不与原生内容冲突。

## ADDED Requirements

### Requirement: Native skill detection

插件 SHALL 检测项目 `.dsh/skills`、项目 `.agents/skills` 与用户技能根目录下的 `openspec-*` 技能，并在面板与快捷条中展示其存在与覆盖的工作流。

#### Scenario: Native skills detected

- **WHEN** 项目 `.dsh/skills/openspec-propose/SKILL.md` 存在
- **THEN** 面板与快捷条显示检测到原生 OpenSpec 技能，并列出其名称与对应工作流

#### Scenario: No native skills present

- **WHEN** 三个技能根目录中都不存在 `openspec-*` 技能
- **THEN** 展示未检测到原生技能，并按 fallback 规则处理

#### Scenario: Malformed native skill ignored

- **WHEN** 存在名为 `openspec-*` 但缺少有效 frontmatter 的目录或文件
- **THEN** 检测忽略该项并给出警告，不影响其他技能与面板状态

### Requirement: Coexistence with native skills

当原生 OpenSpec 技能存在时，插件 SHALL NOT 注册同名 fallback 技能，SHALL NOT 改写、移动或删除原生技能文件，且 SHALL 保持命令与面板可用。

#### Scenario: Native present suppresses fallback

- **WHEN** 工作区存在原生 `openspec-propose` 技能
- **THEN** 插件不注册同名 fallback 候选，模型目录与 `/openspec-*` 用户调用使用原生技能

#### Scenario: Native skill files untouched

- **WHEN** 插件在任何工作区运行
- **THEN** 不修改、移动或删除 `.dsh/skills` 与 `.agents/skills` 下的原生技能文件

#### Scenario: Commands remain available

- **WHEN** 原生技能存在
- **THEN** `/opsx-*` 命令仍可用，并与原生技能并存

### Requirement: File-based fallback provider

当原生 OpenSpec 技能缺失且 DSH 提供技能注册能力时，插件 SHALL 提供工作区感知的 fallback 技能 provider，覆盖 explore、propose、apply、update、sync、archive 六个 core 工作流；其正文 SHALL 使用插件的文件语义组织步骤，SHALL NOT 要求或调用 openspec CLI，并 SHALL 在 frontmatter 中记录改编来源与上游版本。

#### Scenario: Fallback listed when native absent

- **WHEN** 工作区没有原生 OpenSpec 技能且技能注册可用
- **THEN** 技能目录中出现六个 core 工作流对应的 fallback 技能

#### Scenario: Fallback body avoids CLI

- **WHEN** 读取任一 fallback 技能正文
- **THEN** 正文不包含 `openspec` CLI 命令调用，步骤基于读取工作区文件与 DSH 命令完成

#### Scenario: Native appears later and wins

- **WHEN** 插件运行期间工作区新增了原生 `openspec-propose` 技能
- **THEN** 下一次目录刷新时 fallback 候选不再返回该名称，原生技能生效

#### Scenario: No skills service available

- **WHEN** DSH 组合未提供技能注册能力
- **THEN** 插件跳过 fallback 注册且不报错，面板与命令照常工作

#### Scenario: Adapted metadata recorded

- **WHEN** 查看 fallback 技能元数据
- **THEN** 可以看到改编自 OpenSpec 原生技能、MIT 归属与参考的上游版本
