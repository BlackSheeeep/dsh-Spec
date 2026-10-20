/**
 * dsh-spec — browser half (source).
 *
 * This file is NOT a module: tools/build.mjs inlines it into the
 * `window.__ModuleLoader__.load({ id, factory })` closure that the DSH client
 * module system serves, exactly like a shipped `lib/client.js`. It may use
 * only the platform modules the shell seeds — here: `react`.
 *
 * Surfaces registered here:
 *   - `main` (keyed PANEL_ID)         — the openspec monitoring page
 *   - `sidebar.panellist`             — the page's sidebar glyph
 *   - `conversation.composer.dock`    — the quick phase command bar under the composer
 *
 * All workflow state is derived from the session workspace's `openspec/`
 * directory through the `workspaceFiles` Remote namespace (list/read/changes
 * stream), the same seam the shipped file tree uses. The plugin stores
 * nothing of its own; files are the truth.
 *
 * Visual language: the plugin is part of the Harness UI, so it copies the
 * host's management-page patterns (20px page title, 13px secondary text,
 * 960px content column, settings-card surface, 32px primary buttons on
 * `--dsw-alias-button-primary-*`) and Modal conventions (fixed mask, 28px
 * panel radius, Esc/backdrop close, restored focus). Only `--dsw-*` theme
 * tokens are used for color, so light/dark and custom themes follow the host.
 */

function createOpenSpecPlugin(require) {
  const React = require('react')
  const h = React.createElement
  const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React

  /** Sidebar row id and the `main` dispatch key — the SAME string in both. */
  const PANEL_ID = 'openspec'
  /** The composer-dock entry id. */
  const DOCK_ID = 'openspec-quickbar'
  /** Locale namespace registered in apply(). */
  const NS = 'openSpec'
  /** Absolute Host route for session-less initialization. */
  const ROUTE = '/dsh-spec'
  /** Debounce for watch-driven refreshes. */
  const REFRESH_DEBOUNCE_MS = 400
  /** Fallback poll when the directory watch is unsupported. */
  const FALLBACK_POLL_MS = 8000
  /** How long an inline result banner stays visible. */
  const NOTICE_MS = 5000
  /** Max change folders inspected per workspace. */
  const MAX_CHANGES = 12

  /** All user-visible copy lives here. */
  const T = {
    zh: {
      panel: 'OpenSpec',
      title: 'OpenSpec 工作流',
      subtitle: '进度只存在于 openspec/ 的文件里，这里只是它的实时视图。',
      refresh: '刷新',
      refreshAll: '刷新全部',
      loading: '正在读取 openspec/ …',
      nosession: '这里还没有已知的工作区会话。',
      nosessionHint: '在这个工作区开始对话后，这里会显示对应的 openspec/ 状态。',
      missing: '此工作区还没有 openspec/',
      missingHint: '初始化会生成 config.yaml、specs/ 与 changes/archive/ 骨架；之后 AI 就能用 /opsx-* 命令开始规格流程。',
      init: '初始化 OpenSpec',
      initBusy: '初始化中…',
      retry: '重试',
      error: '读取失败',
      noChanges: '还没有进行中的变更',
      noChangesHint: '用「提案」开始一个变更，或用「探索」先想清楚要做什么。',
      newProposal: '新建提案',
      changeCount: '{count} 个变更',
      archived: '已归档 {count} 个变更',
      watchDown: '目录监听不可用，已改用轮询刷新。',
      workspaceLabel: '工作区',
      specOverview: 'Spec 概览',
      activeChanges: '进行中的变更',
      capabilitySpecs: '已定稿 Spec',
      archivedChanges: '已归档',
      archivedHint: '按归档时间倒序沉底展示',
      noCapabilities: '还没有定稿的 Spec',
      noCapabilitiesHint: '实施并归档变更后，delta specs 会同步到这里。',
      noArchived: '还没有归档的变更。',
      noDocs: '没有可查看的文档',
      docs: '文档',
      taskList: '任务清单',
      tasksDone: '{done}/{total} 已完成',
      progressLabel: '任务进度',
      phaseDistribution: '阶段分布',
      statActive: '进行中',
      statSpecs: '能力 Spec',
      statArchived: '已归档',
      loadingDoc: '正在读取文档…',
      readDocFailed: '读取文档失败',
      docEmpty: '这个文档是空的。',
      docTruncated: '文档较长，仅显示前 2000 行。',
      viewDoc: '查看文档',
      expand: '展开',
      collapse: '收起',
      archiveDated: '{date} 归档',
      noTasks: '还没有任务清单',
      moreTasks: '还有 {count} 项',
      requirementCount: '{count} 项需求',
      switchFailed: '没有可用会话，无法切换到该工作区',
      explore: '探索',
      propose: '提案',
      apply: '实施',
      applyContinue: '继续实施',
      archive: '归档',
      status: '状态',
      openPanel: '打开 OpenSpec 面板',
      phaseDraft: '草稿',
      phaseProposed: '待评审',
      phaseApply: '实施中',
      phaseReady: '待归档',
      files: '工件',
      cancel: '取消',
      close: '关闭',
      fillComposer: '填入输入框',
      exploreGo: '开始探索',
      proposeGo: '发送',
      insertFailed: '没找到输入框。',
      proposeTitle: '提案新变更',
      proposeDesc: '创建一个 OpenSpec 变更：proposal.md、delta specs 与 tasks.md。写完计划会停下等你评审，不写产品代码。',
      proposeField: '变更名',
      proposePlaceholder: '例如 add-dark-mode',
      proposeHint: '小写连字符命名，可附一句说明，例如 add-dark-mode 支持深色主题。',
      exploreTitle: '探索模式',
      exploreDesc: '调查代码、比较方案、给出建议；这个阶段不写任何文件。',
      exploreField: '想探索什么',
      explorePlaceholder: '可以留空，让我根据现状帮你选下一步',
      exploreHint: '留空也可以；Enter 直接开始，Esc 取消。',
      pickTitle: '选择要实施的变更',
      pickDesc: '当前有多个进行中的变更，选择这次要推进的那个。',
      commandFailed: '命令执行失败',
      commandSent: '已发送',
      quickMissing: '未初始化',
      quickNoChange: '无进行中变更',
      taskProgress: '{done}/{total}',
      enterHint: 'Enter 确认 · Esc 取消',
    },
    en: {
      panel: 'OpenSpec',
      title: 'OpenSpec workflow',
      subtitle: 'Progress lives only in the openspec/ files — this is its live view.',
      refresh: 'Refresh',
      refreshAll: 'Refresh all',
      loading: 'Reading openspec/ …',
      nosession: 'No known workspace session here yet.',
      nosessionHint: 'Start a conversation in this workspace and its openspec/ state appears here.',
      missing: 'This workspace has no openspec/ yet',
      missingHint: 'Initializing writes config.yaml, specs/ and changes/archive/; the AI can then run the /opsx-* spec loop.',
      init: 'Initialize OpenSpec',
      initBusy: 'Initializing…',
      retry: 'Retry',
      error: 'Read failed',
      noChanges: 'No change in motion',
      noChangesHint: 'Start one with Propose, or think it through with Explore first.',
      newProposal: 'New proposal',
      changeCount: '{count} changes',
      archived: '{count} archived changes',
      watchDown: 'Directory watch unavailable; falling back to polling.',
      workspaceLabel: 'Workspace',
      specOverview: 'Spec overview',
      activeChanges: 'Changes in motion',
      capabilitySpecs: 'Capability specs',
      archivedChanges: 'Archived',
      archivedHint: 'Newest first, kept at the bottom',
      noCapabilities: 'No capability spec yet',
      noCapabilitiesHint: 'Archiving a change syncs its delta specs here.',
      noArchived: 'No archived change yet.',
      noDocs: 'No document to view',
      docs: 'Documents',
      taskList: 'Tasks',
      tasksDone: '{done}/{total} done',
      progressLabel: 'Task progress',
      phaseDistribution: 'Phase split',
      statActive: 'Active',
      statSpecs: 'Capabilities',
      statArchived: 'Archived',
      loadingDoc: 'Reading document…',
      readDocFailed: 'Failed to read the document',
      docEmpty: 'This document is empty.',
      docTruncated: 'Long document — showing the first 2000 lines.',
      viewDoc: 'View document',
      expand: 'Expand',
      collapse: 'Collapse',
      archiveDated: 'archived {date}',
      noTasks: 'No task list yet',
      moreTasks: '{count} more',
      requirementCount: '{count} requirements',
      switchFailed: 'No session available to open this workspace.',
      explore: 'Explore',
      propose: 'Propose',
      apply: 'Apply',
      applyContinue: 'Continue',
      archive: 'Archive',
      status: 'Status',
      openPanel: 'Open the OpenSpec panel',
      phaseDraft: 'Draft',
      phaseProposed: 'Review',
      phaseApply: 'Applying',
      phaseReady: 'Ready',
      files: 'Artifacts',
      cancel: 'Cancel',
      close: 'Close',
      fillComposer: 'Fill composer',
      exploreGo: 'Start exploring',
      proposeGo: 'Send',
      insertFailed: 'Composer not found.',
      proposeTitle: 'Propose a change',
      proposeDesc: 'Creates an OpenSpec change: proposal.md, delta specs and tasks.md. It stops after the plan for your review and writes no product code.',
      proposeField: 'Change name',
      proposePlaceholder: 'e.g. add-dark-mode',
      proposeHint: 'Kebab-case name, optionally with a note, e.g. add-dark-mode support dark theme.',
      exploreTitle: 'Explore mode',
      exploreDesc: 'Investigate code, compare options, give advice; this phase writes no files.',
      exploreField: 'What to explore',
      explorePlaceholder: 'Leave empty and I will pick the next step from the current state',
      exploreHint: 'Empty is fine; Enter starts, Esc cancels.',
      pickTitle: 'Choose a change to apply',
      pickDesc: 'Several changes are in motion; pick the one to advance now.',
      commandFailed: 'Command failed',
      commandSent: 'Sent',
      quickMissing: 'Not initialized',
      quickNoChange: 'No change in motion',
      taskProgress: '{done}/{total}',
      enterHint: 'Enter to confirm · Esc to cancel',
    },
  }

  /** Plugin-scoped styles; only --dsw-* theme tokens (plus host radii/elevation). */
  const CSS = `
.dshspec-root{height:100%;min-height:0;overflow-y:auto;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55}
.dshspec-page{max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 56px;display:flex;flex-direction:column;gap:20px}
.dshspec-pageHead{display:flex;align-items:flex-start;gap:16px}
.dshspec-pageHeadText{min-width:0;flex:1}
.dshspec-title{margin:0;font-size:20px;line-height:28px;font-weight:500;letter-spacing:0}
.dshspec-sub{margin-top:2px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshspec-pageActions{display:flex;align-items:center;gap:8px;flex:none}
.dshspec-space{flex:1}

/* Workspace switcher --------------------------------------------------- */
.dshspec-wsbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshspec-wsbarLabel{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshspec-wstabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dshspec-wstab{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;min-width:0;max-width:280px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.dshspec-wstab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-wstab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-wstab[data-active='true']{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
.dshspec-wstab .dshspec-icon{color:var(--dsw-alias-label-tertiary)}
.dshspec-wstabName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dshspec-wstabCount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* Detail toolbar ------------------------------------------------------- */
.dshspec-detail{display:flex;flex-direction:column;gap:16px}
.dshspec-detailBar{display:flex;align-items:center;gap:10px;min-width:0}
.dshspec-detailBarIcon{color:var(--dsw-alias-label-tertiary)}
.dshspec-detailBarPath{flex:1;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-detailActions{flex:none;display:flex;align-items:center;gap:8px}

/* Spec overview -------------------------------------------------------- */
.dshspec-summary{display:flex;align-items:center;gap:clamp(18px,3vw,32px);flex-wrap:wrap;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,16px);padding:16px 20px}
.dshspec-ringWrap{position:relative;width:72px;height:72px;flex:none}
.dshspec-ringText{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;pointer-events:none}
.dshspec-ringValue{font-size:16px;line-height:19px;font-weight:600;font-variant-numeric:tabular-nums}
.dshspec-ringLabel{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dshspec-summaryPhase{flex:1 1 240px;min-width:200px;display:flex;flex-direction:column;gap:8px}
.dshspec-summaryLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshspec-phaseBar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-phaseSeg{height:100%;min-width:3px;transition:flex-grow .24s ease}
.dshspec-phaseLegend{display:flex;flex-wrap:wrap;gap:6px 16px}
.dshspec-legendItem{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshspec-legendItem b{font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshspec-summaryStats{display:flex;align-items:flex-start;gap:clamp(16px,2.4vw,26px);flex:none}
.dshspec-stat{display:flex;flex-direction:column;gap:2px;min-width:48px}
.dshspec-statValue{font-size:18px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.dshspec-statLabel{font-size:11.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}

/* Sections ------------------------------------------------------------- */
.dshspec-section{display:flex;flex-direction:column;gap:8px}
.dshspec-sectionHead{display:flex;align-items:center;gap:8px;min-height:28px}
.dshspec-sectionTitle{font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-sectionCount{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:1px 7px;font-variant-numeric:tabular-nums}
.dshspec-sectionActions{margin-left:auto;display:flex;align-items:center;gap:6px}
.dshspec-sectionToggle{display:inline-flex;align-items:center;gap:8px;padding:2px 4px 2px 0;margin:0;border:none;border-radius:8px;background:transparent;font:inherit;color:inherit;cursor:pointer}
.dshspec-sectionToggle:hover .dshspec-sectionTitle{color:var(--dsw-alias-label-primary)}
.dshspec-sectionToggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-sectionBody{display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.dshspec-sectionEmpty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:24px 16px;text-align:center}
.dshspec-sectionEmptyIcon{width:36px;height:36px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-sectionEmptyTitle{font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-sectionEmptyHint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);max-width:420px}
.dshspec-sectionEmpty .dshspec-btn{margin-top:4px}
.dshspec-note{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}

/* Rows / collapsible items -------------------------------------------- */
.dshspec-rowItem{display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;border:none;background:transparent;font:inherit;text-align:left;color:inherit;cursor:pointer;min-width:0;transition:background .12s ease}
.dshspec-rowItem+.dshspec-rowItem{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-rowItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-rowItem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-rowIcon{flex:none;width:30px;height:30px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.dshspec-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshspec-rowName{font-size:13.5px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-rowMeta{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-rowEnd{flex:none;display:flex;align-items:center;gap:8px;color:var(--dshspec-label-tertiary,var(--dsw-alias-label-tertiary))}

.dshspec-item{display:flex;flex-direction:column;min-width:0}
.dshspec-item+.dshspec-item{border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-itemHead{display:flex;align-items:center;gap:10px;padding:10px 14px;min-width:0;cursor:pointer;user-select:none}
.dshspec-itemHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-itemHead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-itemHeadRow{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.dshspec-itemBody{display:flex;flex-direction:column;gap:12px;padding:12px 14px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshspec-chev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dshspec-chevOpen{transform:rotate(90deg)}
.dshspec-changeName{font-size:13.5px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-changeButtons{flex:none;display:flex;align-items:center;gap:6px}
.dshspec-changeProgress{flex:0 1 150px;min-width:96px}
.dshspec-dateChip{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:1px 6px;font-variant-numeric:tabular-nums}
.dshspec-decoIcon{opacity:.5}

/* Documents & tasks inside an expanded item --------------------------- */
.dshspec-subHead{display:flex;align-items:center;gap:8px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshspec-subHead b{font-weight:400;color:var(--dsw-alias-label-secondary)}
.dshspec-docGrid{display:flex;flex-wrap:wrap;gap:8px}
.dshspec-docBtn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.dshspec-docBtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dshspec-docBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-docBtn .dshspec-icon{color:var(--dsw-alias-label-tertiary)}
.dshspec-docKind{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dshspec-taskBlock{display:flex;flex-direction:column;gap:6px}
.dshspec-taskList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.dshspec-task{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshspec-task .dshspec-icon{margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.dshspec-taskDone{color:var(--dsw-alias-label-tertiary)}
.dshspec-taskDone .dshspec-icon{color:var(--dsw-alias-state-success-primary)}
.dshspec-inlineLoad{display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}

/* Badges, progress, chips (shared) ------------------------------------ */
.dshspec-badge{flex:none;display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 8px 0 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap;font-weight:400}
.dshspec-badgeDot{width:5px;height:5px;border-radius:50%;flex:none}
.dshspec-progress{display:flex;align-items:center;gap:8px;flex:0 1 170px;min-width:110px;max-width:220px}
.dshspec-progressTrack{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.dshspec-progressFill{height:100%;border-radius:2px;transition:width .24s ease}
.dshspec-progressCount{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshspec-fileChip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap}

/* Buttons -------------------------------------------------------------- */
.dshspec-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;border:none;font:inherit;cursor:pointer;white-space:nowrap;border-radius:12px;transition:background .12s ease,border-color .12s ease,color .12s ease,opacity .12s ease;-webkit-app-region:no-drag}
.dshspec-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-btn:disabled{opacity:.4;cursor:default}
.dshspec-btn-md{height:32px;padding:0 13px;font-size:13px}
.dshspec-btn-sm{height:28px;padding:0 10px;font-size:12.5px;border-radius:10px}
.dshspec-btn-lg{height:36px;padding:0 16px;font-size:13.5px;border-radius:12px}
.dshspec-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshspec-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshspec-btn-outline{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.dshspec-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dshspec-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary)}
.dshspec-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-iconBtn{display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;cursor:pointer;transition:background .12s ease,color .12s ease;-webkit-app-region:no-drag}
.dshspec-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshspec-iconBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshspec-icon{display:block;flex:none}

/* Composer dock -------------------------------------------------------- */
.dshspec-dock{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 2px 6px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);min-width:0}
.dshspec-dockStatus{display:flex;align-items:center;gap:7px;min-width:0}
.dshspec-dockName{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-dockActions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}
.dshspec-seg{display:flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-seg .dshspec-btn-sm{height:24px;padding:0 8px;font-size:12px;border-radius:8px}
.dshspec-seg .dshspec-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary)}
.dshspec-seg .dshspec-btn-primary{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-button-ghost-active-border)}
.dshspec-seg .dshspec-btn-primary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent)}
.dshspec-dot{width:7px;height:7px;border-radius:50%;flex:none}

/* Modal ---------------------------------------------------------------- */
.dshspec-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.24);animation:dshspec-fade .12s ease-out}
.dshspec-modal{width:100%;max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-panel,28px);box-shadow:var(--dsw-elevation-prominent);padding:22px 24px 20px;display:flex;flex-direction:column;gap:16px;animation:dshspec-pop .14s cubic-bezier(.2,.8,.2,1)}
.dshspec-modal:focus,.dshspec-modal:focus-visible{outline:none}
.dshspec-modalHead{display:flex;align-items:flex-start;gap:12px}
.dshspec-modalHeadText{flex:1;min-width:0}
.dshspec-modalTitle{margin:0;font-size:16px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshspec-modalDesc{margin:6px 0 0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshspec-modalBody{display:flex;flex-direction:column;gap:12px;min-width:0}
.dshspec-modalFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshspec-field{display:flex;flex-direction:column;gap:6px}
.dshspec-fieldLabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dshspec-input{height:40px;width:100%;box-sizing:border-box;border-radius:12px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;padding:0 13px;transition:border-color .12s ease,box-shadow .12s ease}
.dshspec-input::placeholder{color:var(--dsw-alias-label-caption)}
.dshspec-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.dshspec-hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dshspec-errorText{font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary)}
.dshspec-pickList{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto;margin:0 -6px}
.dshspec-pickRow{display:flex;align-items:center;gap:10px;width:100%;padding:9px 8px;border:none;border-radius:10px;background:transparent;font:inherit;text-align:left;cursor:pointer;color:inherit}
.dshspec-pickRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshspec-pickRow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshspec-pickName{flex:1;min-width:0;font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Document viewer ------------------------------------------------------ */
.dshspec-docViewport{max-height:min(62vh,620px);overflow:auto;padding:2px 2px 8px;border-top:.5px solid var(--dsw-alias-border-l1);margin-top:2px}
.dshspec-docPath{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshspec-markdown{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshspec-markdown>*:first-child{margin-top:0}
.dshspec-markdown>*:last-child{margin-bottom:0}
.dshspec-mdH{margin:18px 0 8px;font-weight:600;line-height:1.4}
.dshspec-mdH1{font-size:20px}
.dshspec-mdH2{font-size:17px}
.dshspec-mdH3{font-size:15px}
.dshspec-mdH4{font-size:14px}
.dshspec-mdP{margin:0 0 10px}
.dshspec-mdList{margin:0 0 10px;padding-left:20px}
.dshspec-mdLi{margin:2px 0}
.dshspec-mdCheck{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-right:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;font-size:10px;line-height:1;vertical-align:-2px;color:transparent}
.dshspec-mdCheckOn{background:var(--dsw-alias-state-success-secondary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dshspec-mdPre{background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-interactive-bg-hover));border-radius:10px;padding:10px 12px;margin:0 0 12px;overflow:auto;font-size:12.5px;line-height:1.6;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dshspec-mdCode{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12.5px;background:var(--dsw-alias-markdown-inline-code,var(--dsw-alias-interactive-bg-hover));border-radius:4px;padding:1px 5px}
.dshspec-mdQuote{margin:0 0 12px;padding:4px 0 4px 12px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.dshspec-mdHr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:16px 0}
.dshspec-markdown a{color:var(--dsw-alias-link);text-decoration:none}
.dshspec-markdown a:hover{text-decoration:underline}

/* State panels --------------------------------------------------------- */
.dshspec-card{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,16px);padding:18px 20px 16px;display:flex;flex-direction:column;gap:14px}
.dshspec-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:30px 16px 26px}
.dshspec-emptyIcon{flex:none;width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-emptyTitle{font-size:14px;line-height:20px;font-weight:500}
.dshspec-emptyDesc{font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);max-width:440px}
.dshspec-empty .dshspec-btn{margin-top:6px}
.dshspec-missing{display:flex;align-items:flex-start;gap:14px;padding:6px 0 4px}
.dshspec-missingText{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshspec-missingTitle{font-size:14px;line-height:20px;font-weight:500}
.dshspec-missingDesc{font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);max-width:620px}
.dshspec-missing .dshspec-btn{align-self:flex-start;margin-top:8px}
.dshspec-nosession{display:flex;align-items:flex-start;gap:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:2px 0}

.dshspec-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:12px;font-size:12.5px;line-height:18px}
.dshspec-bannerInfo{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshspec-bannerWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.dshspec-bannerError{background:var(--dsw-alias-state-error-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary)}
.dshspec-bannerText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-bannerTextWrap{min-width:0;overflow-wrap:anywhere}

.dshspec-foot{display:flex;align-items:center;gap:7px;padding-top:2px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshspec-loading{display:flex;flex-direction:column;gap:9px;padding:4px 0 6px}
.dshspec-skelLine{height:10px;border-radius:5px;background:var(--dsw-alias-bg-skeleton);animation:dshspec-pulse 1.4s ease-in-out infinite}
.dshspec-spin{animation:dshspec-rotate .8s linear infinite}
.dshspec-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:1001;display:flex;align-items:center;gap:8px;max-width:min(520px,calc(100vw - 48px));padding:9px 14px;border-radius:12px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:12.5px;line-height:18px;box-shadow:var(--dsw-elevation-prominent);animation:dshspec-fade .12s ease-out}
@keyframes dshspec-fade{from{opacity:0}to{opacity:1}}
@keyframes dshspec-pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
@keyframes dshspec-rotate{to{transform:rotate(360deg)}}
@keyframes dshspec-pulse{0%,100%{opacity:.65}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dshspec-overlay,.dshspec-modal,.dshspec-toast,.dshspec-spin,.dshspec-skelLine,.dshspec-chev,.dshspec-progressFill{animation:none;transition:none}}
`

  /** Inject the stylesheet once, tagged like shipped plugin CSS. */
  function injectStyle() {
    if (typeof document === 'undefined') return
    const tagId = 'dsh-spec/styles.css'
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-spec'
    tag.dataset.pluginCss = tagId
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  /* ------------------------------------------------------------------ *
   * Icons — 16px outline set matching the host's 1.2px stroke icons.
   * ------------------------------------------------------------------ */

  const ICONS = {
    refresh: [
      ['path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.61-3.89' }],
      ['path', { d: 'M13.5 2.5V6H10' }],
    ],
    compass: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M10.6 5.4 9.1 9.1 5.4 10.6l1.5-3.7z' }],
    ],
    filePlus: [
      ['path', { d: 'M9 2H4.6A1.6 1.6 0 0 0 3 3.6v8.8A1.6 1.6 0 0 0 4.6 14h6.8a1.6 1.6 0 0 0 1.6-1.6V6z' }],
      ['path', { d: 'M9 2v4h4' }],
      ['path', { d: 'M8 8.4v3.2M6.4 10h3.2' }],
    ],
    play: [['path', { d: 'M5.6 3.5v9L12.4 8z' }]],
    archive: [
      ['rect', { x: 2, y: 2.5, width: 12, height: 3.2, rx: 1 }],
      ['path', { d: 'M3 5.7v7.1a1.2 1.2 0 0 0 1.2 1.2h7.6a1.2 1.2 0 0 0 1.2-1.2V5.7' }],
      ['path', { d: 'M6.4 8.6h3.2' }],
    ],
    activity: [['path', { d: 'M1.8 8h2.7l1.9-4.6 2.9 9.2L11.4 8h2.8' }]],
    layout: [
      ['rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2 }],
      ['path', { d: 'M6 2.8v10.4' }],
    ],
    close: [['path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }]],
    check: [['path', { d: 'M3.4 8.4l3.1 3.1 6.1-7' }]],
    alert: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 4.8v3.9' }],
      ['circle', { cx: 8, cy: 11.2, r: 0.75, fill: 'currentColor', stroke: 'none' }],
    ],
    info: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 7.2v4' }],
      ['circle', { cx: 8, cy: 4.9, r: 0.75, fill: 'currentColor', stroke: 'none' }],
    ],
    folder: [
      ['path', { d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 2h4.8A1.6 1.6 0 0 1 14 6.6v5.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4z' }],
    ],
    folderPlus: [
      ['path', { d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 2h4.8A1.6 1.6 0 0 1 14 6.6v5.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4z' }],
      ['path', { d: 'M8 7.2v4.2M5.9 9.3h4.2' }],
    ],
    chevronRight: [['path', { d: 'M6.2 4l4 4-4 4' }]],
    sparkle: [
      ['path', { d: 'M7.2 2.4l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1z' }],
      ['path', { d: 'M12.2 9.4l.55 1.55 1.55.55-1.55.55-.55 1.55-.55-1.55-1.55-.55 1.55-.55z', opacity: 0.7 }],
    ],
    send: [
      ['path', { d: 'M8 13V3.2' }],
      ['path', { d: 'M4 7.1 8 3.1l4 4' }],
    ],
    file: [
      ['path', { d: 'M9 2H4.6A1.6 1.6 0 0 0 3 3.6v8.8A1.6 1.6 0 0 0 4.6 14h6.8a1.6 1.6 0 0 0 1.6-1.6V6z' }],
      ['path', { d: 'M9 2v4h4' }],
      ['path', { d: 'M5.4 8.4h5.2M5.4 10.8h3.6' }],
    ],
    layers: [
      ['path', { d: 'M8 2.2 13.4 5 8 7.8 2.6 5z' }],
      ['path', { d: 'M2.8 8 8 10.7 13.2 8' }],
      ['path', { d: 'M2.8 11 8 13.7 13.2 11' }],
    ],
    checkSquare: [
      ['rect', { x: 2.4, y: 2.4, width: 11.2, height: 11.2, rx: 2.4 }],
      ['path', { d: 'M5.4 8.2 7.3 10l3.6-4' }],
    ],
    square: [['rect', { x: 2.4, y: 2.4, width: 11.2, height: 11.2, rx: 2.4 }]],
    clock: [
      ['circle', { cx: 8, cy: 8, r: 5.6 }],
      ['path', { d: 'M8 4.9V8l2.1 1.3' }],
    ],
  }

  function Icon({ name, size = 16, className }) {
    const parts = ICONS[name] ?? ICONS.info
    return h(
      'svg',
      {
        className: 'dshspec-icon' + (className === undefined ? '' : ' ' + className),
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      parts.map(([tag, props], index) => h(tag, { key: index, ...props })),
    )
  }

  /* ------------------------------------------------------------------ *
   * Small presentational primitives (host-matched).
   * ------------------------------------------------------------------ */

  function Button({ variant = 'outline', size = 'md', icon, className, children, ...rest }) {
    const classes = ['dshspec-btn', `dshspec-btn-${variant}`, `dshspec-btn-${size}`]
    if (className !== undefined) classes.push(className)
    return h(
      'button',
      { type: 'button', className: classes.join(' '), ...rest },
      icon === undefined ? null : h(Icon, { name: icon, size: size === 'sm' ? 14 : 16 }),
      children === undefined || children === null || children === false ? null : h('span', null, children),
    )
  }

  function IconButton({ icon, label, size = 28, className, ...rest }) {
    const classes = ['dshspec-iconBtn']
    if (className !== undefined) classes.push(className)
    return h(
      'button',
      {
        type: 'button',
        className: classes.join(' '),
        title: label,
        'aria-label': label,
        style: { width: size, height: size },
        ...rest,
      },
      h(Icon, { name: icon, size: size >= 28 ? 16 : 14 }),
    )
  }

  /** Phase from files + parsed tasks; mirrors src/prompts.js derivePhase. */
  function derivePhase(change) {
    if (change.tasks !== null && change.tasks.total > 0) {
      return change.tasks.done < change.tasks.total ? 'apply' : 'ready'
    }
    if (change.hasProposal || change.hasSpecs) return 'proposed'
    return 'draft'
  }

  const PHASE_META = {
    draft: { key: 'phaseDraft', color: 'var(--dsw-alias-label-tertiary)' },
    proposed: { key: 'phaseProposed', color: 'var(--dsw-alias-state-business-primary)' },
    apply: { key: 'phaseApply', color: 'var(--dsw-alias-state-warn-primary)' },
    ready: { key: 'phaseReady', color: 'var(--dsw-alias-state-success-primary)' },
  }

  function PhaseBadge({ t, phase }) {
    const meta = PHASE_META[phase] ?? PHASE_META.draft
    return h(
      'span',
      { className: 'dshspec-badge', 'data-phase': phase },
      h('span', { className: 'dshspec-badgeDot', style: { background: meta.color } }),
      t(meta.key),
    )
  }

  function Progress({ done, total, color, compact }) {
    if (!(total > 0)) return null
    return h(
      'div',
      {
        className: 'dshspec-progress' + (compact === true ? ' dshspec-progressCompact' : ''),
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': total,
        'aria-valuenow': done,
      },
      h(
        'div',
        { className: 'dshspec-progressTrack' },
        h('div', {
          className: 'dshspec-progressFill',
          style: { width: `${Math.round((done / total) * 100)}%`, background: color },
        }),
      ),
      h('span', { className: 'dshspec-progressCount' }, `${done}/${total}`),
    )
  }

  /** Inline banner: info / warn / error with an icon. */
  function Banner({ tone = 'info', icon, children, wrap }) {
    const toneClass = tone === 'error' ? 'Error' : tone === 'warn' ? 'Warn' : 'Info'
    return h(
      'div',
      { className: `dshspec-banner dshspec-banner${toneClass}`, role: tone === 'error' ? 'alert' : 'status' },
      h(Icon, { name: icon ?? (tone === 'error' ? 'alert' : tone === 'warn' ? 'alert' : 'info'), size: 14 }),
      h('span', { className: wrap === true ? 'dshspec-bannerTextWrap' : 'dshspec-bannerText' }, children),
    )
  }

  /* ------------------------------------------------------------------ *
   * Modal — mirrors the host dialog: fixed mask, 28px panel radius, close
   * button, Esc / backdrop close, autofocus and focus restore.
   * ------------------------------------------------------------------ */

  function Modal({ t, title, description, children, footer, onClose, width = 512, focusCard }) {
    const cardRef = useRef(null)
    const restoreRef = useRef(null)
    const closeRef = useRef(onClose)
    closeRef.current = onClose

    useEffect(() => {
      restoreRef.current = typeof document === 'undefined' ? null : document.activeElement
      const card = cardRef.current
      const target =
        focusCard === true ? card : card?.querySelector('[data-autofocus]') ?? card?.querySelector('input, textarea, button')
      if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus()
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeRef.current()
        }
      }
      document.addEventListener('keydown', onKey, true)
      return () => {
        document.removeEventListener('keydown', onKey, true)
        const restore = restoreRef.current
        if (restore !== null && restore !== undefined && typeof restore.focus === 'function') {
          try {
            restore.focus()
          } catch {
            /* the trigger may be gone after a dispatch */
          }
        }
      }
    }, [])

    return h(
      'div',
      {
        className: 'dshspec-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) closeRef.current()
        },
      },
      h(
        'div',
        {
          ref: cardRef,
          className: 'dshspec-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          tabIndex: -1,
          style: { maxWidth: width },
        },
        h(
          'div',
          { className: 'dshspec-modalHead' },
          h('div', { className: 'dshspec-modalHeadText' },
            h('h2', { className: 'dshspec-modalTitle' }, title),
            description === undefined ? null : h('p', { className: 'dshspec-modalDesc' }, description),
          ),
          h(IconButton, { icon: 'close', label: t('close'), onClick: onClose }),
        ),
        h('div', { className: 'dshspec-modalBody' }, children),
        footer === undefined || footer === null ? null : h('div', { className: 'dshspec-modalFoot' }, footer),
      ),
    )
  }

  /* ------------------------------------------------------------------ *
   * Command dialogs — one hook owns explore / propose / pick flows for a
   * surface, so the panel and the dock share exactly the same markup.
   * `insert` present = fill the composer draft; absent = run the command.
   * ------------------------------------------------------------------ */

  function useCommands({ t, run, insert, changes, onResult }) {
    const [mode, setMode] = useState('none')
    const [draft, setDraft] = useState('')
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState(false)
    const hasInsert = typeof insert === 'function'

    const close = useCallback(() => {
      setMode('none')
      setDraft('')
      setError(null)
      setBusy(false)
    }, [])

    const open = useCallback((next) => {
      setDraft('')
      setError(null)
      setBusy(false)
      setMode(next)
    }, [])

    const execute = useCallback(
      (line) => {
        if (typeof insert === 'function') {
          let result
          try {
            result = insert(line)
          } catch (failure) {
            onResult?.({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }, line)
            return
          }
          if (result === false) {
            onResult?.({ ok: false, text: t('insertFailed') }, line)
            return
          }
          if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
            void result.then(
              (outcome) => {
                if (outcome !== undefined && outcome !== null && outcome.ok === false) onResult?.(outcome, line)
              },
              (failure) => onResult?.({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }, line),
            )
          }
          return
        }
        let promise
        try {
          promise = run(line)
        } catch (failure) {
          onResult?.({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }, line)
          return
        }
        if (promise !== null && typeof promise === 'object' && typeof promise.then === 'function') {
          void promise.then(
            (outcome) => onResult?.(outcome, line),
            (failure) => onResult?.({ ok: false, text: failure instanceof Error ? failure.message : String(failure) }, line),
          )
        }
      },
      [insert, onResult, run, t],
    )

    const submit = useCallback(
      async (line) => {
        if (busy || line === undefined || line === null || line === '') return
        if (typeof insert === 'function') {
          setBusy(true)
          setError(null)
          let outcome
          try {
            outcome = await insert(line)
          } catch (failure) {
            outcome = { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
          }
          setBusy(false)
          if (outcome !== undefined && outcome !== null && outcome.ok === false) {
            setError(outcome.text ?? t('commandFailed'))
            return
          }
          close()
          if (typeof onResult === 'function') onResult(outcome, line)
          return
        }
        setBusy(true)
        setError(null)
        let outcome
        try {
          outcome = await run(line)
        } catch (failure) {
          outcome = { ok: false, text: failure instanceof Error ? failure.message : String(failure) }
        }
        setBusy(false)
        if (outcome !== undefined && outcome.ok === true) {
          close()
          if (typeof onResult === 'function') onResult(outcome, line)
          return
        }
        setError(outcome?.text ?? t('commandFailed'))
      },
      [busy, close, insert, onResult, run, t],
    )

    const primaryLabel = hasInsert ? t('fillComposer') : mode === 'explore' ? t('exploreGo') : t('proposeGo')
    const footer = (line, disabled) => [
      h(Button, { key: 'cancel', variant: 'outline', size: 'lg', onClick: close, disabled: busy }, t('cancel')),
      h(
        Button,
        { key: 'go', variant: 'primary', size: 'lg', icon: 'send', disabled: disabled === true || busy, onClick: () => void submit(line) },
        primaryLabel,
      ),
    ]

    let modal = null
    if (mode === 'explore') {
      const lineOf = () => (draft.trim() === '' ? '/opsx-explore' : `/opsx-explore ${draft.trim()}`)
      modal = h(
        Modal,
        { t, title: t('exploreTitle'), description: t('exploreDesc'), onClose: close, footer: footer(lineOf(), false) },
        h(
          'div',
          { className: 'dshspec-field' },
          h('label', { className: 'dshspec-fieldLabel' }, t('exploreField')),
          h('input', {
            className: 'dshspec-input',
            value: draft,
            placeholder: t('explorePlaceholder'),
            autoFocus: true,
            'data-autofocus': 'true',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit(lineOf())
              }
            },
          }),
        ),
        h('div', { className: 'dshspec-hint' }, t('exploreHint')),
        error === null ? null : h('div', { className: 'dshspec-errorText' }, error),
      )
    } else if (mode === 'propose') {
      const lineOf = () => (draft.trim() === '' ? '' : `/opsx-propose ${draft.trim()}`)
      modal = h(
        Modal,
        { t, title: t('proposeTitle'), description: t('proposeDesc'), onClose: close, footer: footer(lineOf(), draft.trim() === '') },
        h(
          'div',
          { className: 'dshspec-field' },
          h('label', { className: 'dshspec-fieldLabel' }, t('proposeField')),
          h('input', {
            className: 'dshspec-input',
            value: draft,
            placeholder: t('proposePlaceholder'),
            autoFocus: true,
            'data-autofocus': 'true',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && draft.trim() !== '') {
                event.preventDefault()
                void submit(lineOf())
              }
            },
          }),
        ),
        h('div', { className: 'dshspec-hint' }, t('proposeHint')),
        error === null ? null : h('div', { className: 'dshspec-errorText' }, error),
      )
    } else if (mode === 'pick') {
      modal = h(
        Modal,
        {
          t,
          title: t('pickTitle'),
          description: t('pickDesc'),
          onClose: close,
          width: 512,
          footer: [h(Button, { key: 'cancel', variant: 'outline', size: 'lg', onClick: close }, t('cancel'))],
        },
        h(
          'div',
          { className: 'dshspec-pickList' },
          changes.map((candidate, index) =>
            h(
              'button',
              {
                key: candidate.name,
                type: 'button',
                className: 'dshspec-pickRow',
                title: `/opsx-apply ${candidate.name}`,
                ...(index === 0 ? { 'data-autofocus': 'true' } : null),
                onClick: () => {
                  close()
                  execute(`/opsx-apply ${candidate.name}`)
                },
              },
              h('span', { className: 'dshspec-pickName' }, candidate.name),
              h(PhaseBadge, { t, phase: candidate.phase }),
              candidate.tasks !== null && candidate.tasks.total > 0
                ? h(Progress, {
                    compact: true,
                    done: candidate.tasks.done,
                    total: candidate.tasks.total,
                    color: (PHASE_META[candidate.phase] ?? PHASE_META.draft).color,
                  })
                : null,
              h(Icon, { name: 'chevronRight', size: 14 }),
            ),
          ),
        ),
      )
    }
    return { open, close, execute, modal, mode }
  }

  /* ------------------------------------------------------------------ *
   * Data layer — workflow source derived from openspec/ files.
   * ------------------------------------------------------------------ */

  /** Join a workspace root and a workspace-relative path with `/`. */
  function joinPath(root, rel) {
    return `${String(root).replace(/[\\/]+$/, '')}/${rel}`
  }

  /** Count `- [ ]` / `- [x]` checkboxes — the workflow's only progress state. */
  function parseTasks(text) {
    let total = 0
    let done = 0
    const items = []
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const match = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/.exec(raw)
      if (match === null) continue
      total += 1
      const checked = match[2].toLowerCase() === 'x'
      if (checked) done += 1
      if (items.length < 200) {
        items.push({ text: match[3].trim(), done: checked, depth: Math.min(3, Math.floor(match[1].length / 2)) })
      }
    }
    return { total, done, items }
  }

  /** Count requirement headings in a spec document (`### Requirement: …`). */
  function countRequirements(text) {
    let count = 0
    for (const line of String(text ?? '').split(/\r?\n/)) {
      if (/^###\s+\S/.test(line)) count += 1
    }
    return count
  }

  /**
   * Per-session workflow source: one authoritative snapshot of the workspace's
   * openspec/ tree, kept fresh by the directory changes stream, with a manual
   * refresh and a command runner. Subscriptions drive its lifecycle.
   */
  function createOpenspecSource(ctx, sessionId) {
    let snapshot = { status: 'loading' }
    const listeners = new Set()
    let disposers = []
    let epoch = 0
    let watchAlive = false
    let watchFallback = null
    let debounceTimer = null
    let dirty = false

    const publish = (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    }

    const listDir = async (path) => {
      const listing = await ctx.remote.workspaceFiles.list(sessionId, path)
      if (!listing.ok) throw Object.assign(new Error(listing.error?.message ?? 'list failed'), { code: listing.error?.code })
      return listing.value.entries
    }

    const readFile = async (path, limit = 2000) => {
      try {
        const page = await ctx.remote.workspaceFiles.read(sessionId, path, { offset: 1, limit })
        if (!page.ok) {
          return { ok: false, path, text: '', error: page.error?.message ?? String(page.error?.code ?? 'read failed') }
        }
        const text = page.value?.text ?? ''
        return { ok: true, path, text, truncated: text.split(/\r?\n/).length >= limit }
      } catch (error) {
        return { ok: false, path, text: '', error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** Markdown documents directly inside a change / capability folder. */
    const docsIn = (base, entries) => {
      const docs = []
      for (const entry of entries) {
        if (entry.type !== 'file' || !entry.name.endsWith('.md')) continue
        const kind = entry.name === 'proposal.md' ? 'proposal' : entry.name === 'design.md' ? 'design' : entry.name === 'tasks.md' ? 'tasks' : 'doc'
        docs.push({ path: `${base}/${entry.name}`, label: entry.name, kind })
      }
      const order = { proposal: 0, design: 1, tasks: 2 }
      docs.sort((left, right) => (order[left.kind] ?? 3) - (order[right.kind] ?? 3) || left.label.localeCompare(right.label))
      return docs
    }

    /** Delta-spec documents under `<base>/specs/<capability>/spec.md`. */
    const deltaDocs = async (base) => {
      const docs = []
      try {
        const capabilities = (await listDir(`${base}/specs`)).filter((entry) => entry.type === 'directory')
        for (const capability of capabilities.slice(0, 12)) {
          let entries = []
          try {
            entries = await listDir(`${base}/specs/${capability.name}`)
          } catch {
            continue
          }
          if (entries.some((entry) => entry.name === 'spec.md' && entry.type === 'file')) {
            docs.push({ path: `${base}/specs/${capability.name}/spec.md`, label: `${capability.name}/spec.md`, kind: 'delta' })
          }
        }
      } catch {
        /* no specs/ folder inside this change */
      }
      return docs
    }

    const readChange = async (root, name) => {
      const base = `${root}/changes/${name}`
      const entries = await listDir(base)
      const names = entries.map((entry) => entry.name)
      let tasks = null
      if (names.includes('tasks.md')) {
        const page = await readFile(`${base}/tasks.md`, 400)
        if (page.ok) tasks = parseTasks(page.text)
      }
      return {
        name,
        hasProposal: names.includes('proposal.md'),
        hasSpecs: names.includes('specs'),
        tasks,
        phase: null,
        files: names.slice(0, 10),
        docs: docsIn(base, entries).concat(await deltaDocs(base)),
      }
    }

    const readCapability = async (root, name) => {
      const base = `${root}/specs/${name}`
      let entries = []
      try {
        entries = await listDir(base)
      } catch {
        /* unreadable capability folder */
      }
      const docs = docsIn(base, entries)
      let requirementCount = 0
      const spec = docs.find((doc) => doc.label === 'spec.md')
      if (spec !== undefined) {
        const page = await readFile(spec.path, 400)
        if (page.ok) requirementCount = countRequirements(page.text)
      }
      return { name, docs, requirementCount }
    }

    /** Load one archived change on demand (the panel lists names only). */
    const loadArchive = async (name) => {
      const cwd = cwdOf(ctx, sessionId)
      if (!cwd) return { ok: false, error: 'no workspace path' }
      const base = `${joinPath(cwd, 'openspec')}/changes/archive/${name}`
      try {
        const entries = await listDir(base)
        let tasks = null
        if (entries.some((entry) => entry.name === 'tasks.md' && entry.type === 'file')) {
          const page = await readFile(`${base}/tasks.md`, 400)
          if (page.ok) tasks = parseTasks(page.text)
        }
        return { ok: true, name, docs: docsIn(base, entries).concat(await deltaDocs(base)), tasks }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    const refresh = async () => {
      const request = ++epoch
      const cwd = cwdOf(ctx, sessionId)
      if (!cwd) {
        publish({ status: 'nosession' })
        return
      }
      if (snapshot.status === 'loading' || snapshot.status === 'missing' || snapshot.status === 'error') {
        publish({ ...snapshot, status: 'loading' })
      }
      const root = joinPath(cwd, 'openspec')
      try {
        const topLevel = await ctx.remote.workspaceFiles.list(sessionId, `${root}/changes`)
        if (request !== epoch) return
        if (!topLevel.ok) {
          const code = topLevel.error?.code
          if (code === 'workspace-file/not-found' || code === 'workspace-file/outside-workspace') {
            publish({ status: 'missing', cwd, root })
          } else {
            publish({ status: 'error', cwd, root, error: topLevel.error?.message ?? String(code ?? 'unknown') })
          }
          return
        }
        const dirs = topLevel.value.entries.filter((entry) => entry.type === 'directory' && entry.name !== 'archive')
        const changes = []
        for (const dir of dirs.slice(0, MAX_CHANGES)) {
          try {
            const change = await readChange(root, dir.name)
            change.phase = derivePhase(change)
            changes.push(change)
          } catch {
            /* unreadable folder: skip it rather than fail the workspace */
          }
          if (request !== epoch) return
        }
        let archived = []
        const archiveEntry = topLevel.value.entries.find((entry) => entry.name === 'archive' && entry.type === 'directory')
        if (archiveEntry !== undefined) {
          try {
            archived = (await listDir(`${root}/changes/archive`))
              .filter((entry) => entry.type === 'directory')
              .map((entry) => entry.name)
              .sort((left, right) => right.localeCompare(left))
          } catch {
            /* empty archive folder */
          }
        }
        if (request !== epoch) return
        const specs = []
        try {
          const capabilityDirs = (await listDir(`${root}/specs`)).filter((entry) => entry.type === 'directory')
          for (const dir of capabilityDirs.slice(0, 30)) {
            try {
              specs.push(await readCapability(root, dir.name))
            } catch {
              /* skip an unreadable capability */
            }
            if (request !== epoch) return
          }
        } catch {
          /* no specs/ folder yet */
        }
        publish({
          status: 'ready',
          cwd,
          root,
          changes,
          specs,
          archived,
          archivedCount: archived.length,
          watchDown: snapshot.watchDown === true,
        })
        ensureWatch(root)
      } catch (error) {
        if (request !== epoch) return
        publish({ status: 'error', cwd, root, error: error instanceof Error ? error.message : String(error) })
      }
    }

    const scheduleRefresh = () => {
      dirty = true
      if (debounceTimer !== null) return
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (dirty) {
          dirty = false
          void refresh()
        }
      }, REFRESH_DEBOUNCE_MS)
    }

    /** Follow the openspec/ directory; falls back to slow polling when unsupported. */
    const ensureWatch = (root) => {
      if (watchAlive || listeners.size === 0) return
      watchAlive = true
      let stream
      try {
        stream = ctx.remote.$stream({
          name: `openspec ${root}`,
          open: (lifetime) => ctx.remote.workspaceFiles.changes(sessionId, root, lifetime),
          ended: () => new Error(`openspec watch ended: ${root}`),
        })
      } catch {
        watchAlive = false
        startFallback()
        return
      }
      disposers.push(() => {
        watchAlive = false
        void stream.dispose()
      })
      void (async () => {
        try {
          for await (const item of stream) {
            if (typeof item?.accept === 'function') item.accept()
            if (item?.value?.kind === 'change') scheduleRefresh()
          }
        } catch {
          if (listeners.size > 0) {
            publish({ ...snapshot, watchDown: true })
            startFallback()
          }
        }
      })()
    }

    const startFallback = () => {
      if (watchFallback !== null || listeners.size === 0) return
      watchFallback = setInterval(() => {
        if (listeners.size > 0) void refresh()
      }, FALLBACK_POLL_MS)
      disposers.push(() => {
        clearInterval(watchFallback)
        watchFallback = null
      })
    }

    const start = () => {
      disposers.push(ctx.on('connection/reset', () => {
        watchAlive = false
        void refresh()
      }))
      void refresh()
    }

    const stop = () => {
      epoch += 1
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* best effort teardown */
        }
      }
      disposers = []
    }

    return {
      hooks: {
        state: {
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener)
            if (listeners.size === 1) start()
            return () => {
              listeners.delete(listener)
              if (listeners.size === 0) stop()
            }
          },
        },
      },
      refresh,
      /** Read one Markdown document for the viewer. */
      readFile,
      /** Load one archived change's artifacts on demand. */
      loadArchive,
      /** Run one /command line in this session and normalize the outcome.
       * The wire takes the exact receiving agent id plus the line; the dock
       * renders inside the session it targets. */
      async run(line) {
        try {
          const outcome = await ctx.remote.commands.execute(sessionId, line, [])
          if (outcome === undefined) return { ok: false, text: `${line} 不是可用命令` }
          if (!outcome.ok) return { ok: false, text: outcome.error?.message ?? `${line} 执行失败（${outcome.error?.code ?? 'unknown'}）` }
          const execution = outcome.value
          if (execution === undefined || execution.result === undefined) return { ok: false, text: `${line} 不是可用命令` }
          const result = execution.result
          if (result.kind === 'success') return { ok: true, text: result.text ?? '' }
          return { ok: false, text: result.text ?? `${line} 执行失败（无错误信息）` }
        } catch (error) {
          return { ok: false, text: error instanceof Error ? error.message : String(error) }
        }
      },
    }
  }

  /** The session row's cwd from the sessions store snapshot (shape-defensive). */
  function cwdOf(ctx, sessionId) {
    try {
      const snap = ctx.sessions.list.getSnapshot()
      if (!snap) return undefined
      const rows = Array.isArray(snap)
        ? snap
        : snap.byId !== undefined && snap.byId !== null
          ? Object.values(snap.byId)
          : Array.isArray(snap.sessions)
            ? snap.sessions
            : []
      for (const row of rows) {
        if (row !== null && typeof row === 'object' && (row.id === sessionId || row.sessionId === sessionId)) {
          return row.cwd
        }
      }
    } catch {
      /* store unavailable: no cwd */
    }
    return undefined
  }

  /**
   * Workspace rows for the panel: the workspaces store is authoritative
   * (workspaceId + canonical path + its accounted sessions), with the sessions
   * store as a fallback when the workspaces face is unavailable. `sessionId`
   * is the dispatch/read target — `undefined` means "no session yet".
   */
  function workspaceRows(ctx) {
    const joined = []
    try {
      const snap = ctx.workspaces.list.getSnapshot()
      if (snap) {
        const views = Array.isArray(snap)
          ? snap
          : snap.byId !== undefined && snap.byId !== null
            ? Object.values(snap.byId)
            : Array.isArray(snap.items)
              ? snap.items
              : Array.isArray(snap.workspaces)
                ? snap.workspaces
                : []
        for (const view of views) {
          if (view === null || typeof view !== 'object') continue
          const workspaceId = view.workspaceId ?? view.id
          const cwd = view.path ?? view.cwd
          if (typeof workspaceId !== 'string' || typeof cwd !== 'string' || cwd === '') continue
          const sessionIds = Array.isArray(view.sessionIds)
            ? view.sessionIds.filter((id) => typeof id === 'string')
            : []
          joined.push({
            workspaceId,
            cwd,
            sessionId: sessionIds.length > 0 ? sessionIds[sessionIds.length - 1] : undefined,
            sessionIds,
            title: typeof view.title === 'string' ? view.title : undefined,
          })
        }
      }
    } catch {
      /* workspaces store unavailable: fall back below */
    }
    if (joined.length > 0) return joined
    try {
      const snap = ctx.sessions.list.getSnapshot()
      if (!snap) return []
      const rows = Array.isArray(snap)
        ? snap
        : snap.byId !== undefined && snap.byId !== null
          ? Object.values(snap.byId)
          : Array.isArray(snap.sessions)
            ? snap.sessions
            : []
      const seen = new Map()
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const id = row.id ?? row.sessionId
        const cwd = row.cwd
        if (typeof id !== 'string' || typeof cwd !== 'string' || cwd === '') continue
        if (!seen.has(cwd)) seen.set(cwd, { workspaceId: undefined, sessionId: id, cwd })
      }
      return [...seen.values()]
    } catch {
      return []
    }
  }

  /** Reject after `ms` so a lost RPC cannot hang the UI silently. */
  function withTimeout(promise, ms, label) {
    let timer
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)
      }),
    ]).finally(() => clearTimeout(timer))
  }

  /** The change a one-click 实施/归档 acts on: applying first, then the first listed. */
  function primaryChange(state) {
    if (state.status !== 'ready' || state.changes.length === 0) return undefined
    return state.changes.find((change) => change.phase === 'apply') ?? state.changes.find((change) => change.phase === 'ready') ?? state.changes[0]
  }

  function statusColor(state) {
    if (state.status === 'error') return 'var(--dsw-alias-state-error-primary)'
    if (state.status === 'ready') {
      const primary = primaryChange(state)
      if (primary === undefined) return 'var(--dsw-alias-label-tertiary)'
      return (PHASE_META[primary.phase] ?? PHASE_META.draft).color
    }
    if (state.status === 'missing') return 'var(--dsw-alias-state-warn-primary)'
    return 'var(--dsw-alias-label-tertiary)'
  }

  /** The stage the workflow suggests next — used to highlight one dock button. */
  function nextStage(state) {
    if (state.status !== 'ready') return 'propose'
    const primary = primaryChange(state)
    if (primary === undefined) return 'propose'
    if (primary.phase === 'draft') return 'propose'
    if (primary.phase === 'ready') return 'archive'
    return 'apply'
  }

  function basenameOf(path) {
    const trimmed = String(path ?? '').replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return index === -1 ? trimmed : trimmed.slice(index + 1)
  }

  /**
   * Put one command line into the conversation draft WITHOUT sending it:
   * focus the composer editor, move the caret to the end, insert the text.
   * The user then completes the arguments and presses Enter themselves.
   */
  function insertIntoComposer(text) {
    const editor = document.querySelector('[contenteditable="true"]')
    if (editor === null) return false
    editor.focus()
    const selection = window.getSelection()
    if (selection !== null) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    const hadText = (editor.textContent ?? '').trim() !== ''
    if (hadText) document.execCommand('insertLineBreak', false, '')
    if (document.execCommand('insertText', false, text)) return true
    editor.textContent += (hadText ? '\n' : '') + text
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  /** Stable no-op external-store pieces for workspace cards without a session yet. */
  const NOOP_SUBSCRIBE = () => () => {}
  const NOSESSION_SNAPSHOT = { status: 'nosession' }
  const getNoSession = () => NOSESSION_SNAPSHOT

  /* ------------------------------------------------------------------ *
   * Panel surfaces.
   * ------------------------------------------------------------------ */

  const PHASE_ORDER = ['draft', 'proposed', 'apply', 'ready']

  /** One-click init control: posts the workspace to the Host's session-less init route, then refreshes. */
  function InitControl({ t, cwd, init, refresh }) {
    const [busy, setBusy] = useState(false)
    const [result, setResult] = useState(null)
    const initialize = async () => {
      setBusy(true)
      try {
        setResult(typeof init === 'function' ? await init(cwd) : { ok: false, text: t('commandFailed') })
      } catch (error) {
        setResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
      }
      if (typeof refresh === 'function') await refresh()
      setBusy(false)
    }
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' } },
      h(
        Button,
        { variant: 'primary', size: 'md', icon: 'folderPlus', disabled: busy, onClick: () => void initialize() },
        busy ? t('initBusy') : t('init'),
      ),
      result === null ? null : h(Banner, { tone: result.ok === true ? 'info' : 'error', wrap: result.ok !== true }, result.text),
    )
  }

  function MissingBody({ t, init, refresh, cwd }) {
    return h(
      'div',
      { className: 'dshspec-missing' },
      h('span', { className: 'dshspec-emptyIcon' }, h(Icon, { name: 'folderPlus', size: 20 })),
      h(
        'div',
        { className: 'dshspec-missingText' },
        h('div', { className: 'dshspec-missingTitle' }, t('missing')),
        h('div', { className: 'dshspec-missingDesc' }, t('missingHint')),
        h(InitControl, { t, init, refresh, cwd }),
      ),
    )
  }

  function LoadingBody() {
    return h(
      'div',
      { className: 'dshspec-loading', 'aria-hidden': 'true' },
      h('div', { className: 'dshspec-skelLine', style: { width: '42%' } }),
      h('div', { className: 'dshspec-skelLine', style: { width: '68%' } }),
      h('div', { className: 'dshspec-skelLine', style: { width: '55%' } }),
    )
  }

  function SectionEmpty({ icon, title, hint, action }) {
    return h(
      'div',
      { className: 'dshspec-sectionEmpty' },
      h('span', { className: 'dshspec-sectionEmptyIcon' }, h(Icon, { name: icon, size: 18 })),
      h('div', { className: 'dshspec-sectionEmptyTitle' }, title),
      hint === undefined ? null : h('div', { className: 'dshspec-sectionEmptyHint' }, hint),
      action ?? null,
    )
  }

  /* ------------------------------------------------------------------ *
   * Small document renderer — a safe Markdown subset, no HTML injection.
   * ------------------------------------------------------------------ */

  function renderInline(text, keyBase) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
    const out = []
    let last = 0
    let index = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index))
      const token = match[0]
      if (token.startsWith('`')) {
        out.push(h('code', { key: `${keyBase}-c${index++}`, className: 'dshspec-mdCode' }, token.slice(1, -1)))
      } else if (token.startsWith('**')) {
        out.push(h('strong', { key: `${keyBase}-b${index++}` }, token.slice(2, -2)))
      } else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
        if (link === null) out.push(token)
        else out.push(h('a', { key: `${keyBase}-a${index++}`, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]))
      }
      last = match.index + token.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }

  function Markdown({ text }) {
    const lines = String(text ?? '').split(/\r?\n/)
    const blocks = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') {
        i += 1
        continue
      }
      if (/^\s*```/.test(line)) {
        i += 1
        const code = []
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          code.push(lines[i])
          i += 1
        }
        if (i < lines.length) i += 1
        blocks.push(h('pre', { key: `b${blocks.length}`, className: 'dshspec-mdPre' }, h('code', null, code.join('\n'))))
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading !== null) {
        const level = heading[1].length
        const keyBase = `b${blocks.length}`
        blocks.push(
          h(
            `h${Math.min(level + 1, 4)}`,
            { key: keyBase, className: `dshspec-mdH dshspec-mdH${level}` },
            renderInline(heading[2], keyBase),
          ),
        )
        i += 1
        continue
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        blocks.push(h('hr', { key: `b${blocks.length}`, className: 'dshspec-mdHr' }))
        i += 1
        continue
      }
      if (/^\s*>/.test(line)) {
        const quote = []
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''))
          i += 1
        }
        const keyBase = `b${blocks.length}`
        blocks.push(
          h(
            'blockquote',
            { key: keyBase, className: 'dshspec-mdQuote' },
            quote.map((piece, qi) => h('p', { key: qi, className: 'dshspec-mdP' }, renderInline(piece, `${keyBase}-${qi}`))),
          ),
        )
        continue
      }
      if (/^\s*\|/.test(line)) {
        const table = []
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          table.push(lines[i])
          i += 1
        }
        blocks.push(h('pre', { key: `b${blocks.length}`, className: 'dshspec-mdPre' }, h('code', null, table.join('\n'))))
        continue
      }
      const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
      if (listItem !== null) {
        const ordered = /\d/.test(listItem[2])
        const baseIndent = listItem[1].length
        const items = []
        while (i < lines.length) {
          const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
          if (item === null) break
          const indent = item[1].length
          if (indent < baseIndent) break
          const checkbox = /^\[([ xX])\]\s*(.*)$/.exec(item[3])
          const content = checkbox === null ? item[3] : checkbox[2]
          const keyBase = `b${blocks.length}-${items.length}`
          items.push(
            h(
              'li',
              { key: keyBase, className: 'dshspec-mdLi', style: indent > baseIndent ? { marginLeft: 16 } : undefined },
              checkbox === null
                ? null
                : h('span', { className: 'dshspec-mdCheck' + (checkbox[1] !== ' ' ? ' dshspec-mdCheckOn' : '') }, checkbox[1] !== ' ' ? '✓' : ''),
              renderInline(content, keyBase),
            ),
          )
          i += 1
        }
        blocks.push(h(ordered ? 'ol' : 'ul', { key: `b${blocks.length}`, className: 'dshspec-mdList' }, items))
        continue
      }
      const paragraph = []
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^\s*(```|#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s)/.test(lines[i])
      ) {
        paragraph.push(lines[i])
        i += 1
      }
      const keyBase = `b${blocks.length}`
      blocks.push(h('p', { key: keyBase, className: 'dshspec-mdP' }, renderInline(paragraph.join(' '), keyBase)))
    }
    return h('div', { className: 'dshspec-markdown' }, blocks)
  }

  /** Read-only Markdown preview modal for one openspec/ document. */
  function DocModal({ t, doc, onClose }) {
    return h(
      Modal,
      {
        t,
        title: doc.title,
        description: doc.relPath ?? doc.path,
        onClose,
        width: 800,
        focusCard: true,
      },
      h(
        'div',
        { className: 'dshspec-docViewport' },
        doc.status === 'loading'
          ? h(LoadingBody)
          : doc.status === 'error'
            ? h(Banner, { tone: 'error', wrap: true }, `${t('readDocFailed')}：${doc.error ?? ''}`)
            : doc.text.trim() === ''
              ? h('div', { className: 'dshspec-sectionEmpty' }, t('docEmpty'))
              : h(Markdown, { text: doc.text }),
        doc.status === 'ready' && doc.truncated === true ? h(Banner, { tone: 'warn' }, t('docTruncated')) : null,
      ),
    )
  }

  /* ------------------------------------------------------------------ *
   * Spec overview widgets + expandable rows.
   * ------------------------------------------------------------------ */

  function Stat({ label, value }) {
    return h('div', { className: 'dshspec-stat' }, h('span', { className: 'dshspec-statValue' }, String(value)), h('span', { className: 'dshspec-statLabel' }, label))
  }

  function ProgressRing({ t, done, total }) {
    const size = 72
    const stroke = 7
    const radius = (size - stroke) / 2
    const circumference = 2 * Math.PI * radius
    const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0
    const color = total > 0 && ratio >= 1 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'
    return h(
      'div',
      {
        className: 'dshspec-ringWrap',
        title: t('tasksDone').replace('{done}', String(done)).replace('{total}', String(total)),
      },
      h(
        'svg',
        { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
        h('circle', {
          cx: size / 2,
          cy: size / 2,
          r: radius,
          fill: 'none',
          stroke: 'var(--dsw-alias-interactive-bg-hover)',
          strokeWidth: stroke,
        }),
        ratio > 0
          ? h('circle', {
              cx: size / 2,
              cy: size / 2,
              r: radius,
              fill: 'none',
              stroke: color,
              strokeWidth: stroke,
              strokeLinecap: 'round',
              strokeDasharray: `${circumference * ratio} ${circumference}`,
              transform: `rotate(-90 ${size / 2} ${size / 2})`,
              style: { transition: 'stroke-dasharray .3s ease' },
            })
          : null,
      ),
      h(
        'div',
        { className: 'dshspec-ringText' },
        h('span', { className: 'dshspec-ringValue' }, `${Math.round(ratio * 100)}%`),
        h('span', { className: 'dshspec-ringLabel' }, t('progressLabel')),
      ),
    )
  }

  function SpecSummary({ t, state }) {
    const changes = state.changes
    const done = changes.reduce((sum, change) => sum + (change.tasks?.done ?? 0), 0)
    const total = changes.reduce((sum, change) => sum + (change.tasks?.total ?? 0), 0)
    const counts = { draft: 0, proposed: 0, apply: 0, ready: 0 }
    for (const change of changes) counts[change.phase] = (counts[change.phase] ?? 0) + 1
    return h(
      'div',
      { className: 'dshspec-summary' },
      h(ProgressRing, { t, done, total }),
      h(
        'div',
        { className: 'dshspec-summaryPhase' },
        h('div', { className: 'dshspec-summaryLabel' }, t('phaseDistribution')),
        changes.length === 0
          ? h('div', { className: 'dshspec-note' }, t('noChanges'))
          : h(
              'div',
              { className: 'dshspec-phaseBar' },
              PHASE_ORDER.map((phase) =>
                counts[phase] > 0
                  ? h('span', {
                      key: phase,
                      className: 'dshspec-phaseSeg',
                      style: { flexGrow: counts[phase], background: PHASE_META[phase].color },
                      title: `${t(PHASE_META[phase].key)} ${counts[phase]}`,
                    })
                  : null,
              ),
            ),
        h(
          'div',
          { className: 'dshspec-phaseLegend' },
          PHASE_ORDER.map((phase) =>
            h(
              'span',
              { key: phase, className: 'dshspec-legendItem' },
              h('span', { className: 'dshspec-badgeDot', style: { background: PHASE_META[phase].color } }),
              t(PHASE_META[phase].key),
              h('b', null, String(counts[phase] ?? 0)),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'dshspec-summaryStats' },
        h(Stat, { label: t('statActive'), value: changes.length }),
        h(Stat, { label: t('statSpecs'), value: state.specs.length }),
        h(Stat, { label: t('statArchived'), value: state.archivedCount ?? state.archived.length }),
      ),
    )
  }

  function DocGrid({ t, docs, openDoc }) {
    if (docs.length === 0) return h('div', { className: 'dshspec-note' }, t('noDocs'))
    return h(
      'div',
      { className: 'dshspec-docGrid' },
      docs.map((doc) =>
        h(
          'button',
          {
            key: doc.path,
            type: 'button',
            className: 'dshspec-docBtn',
            title: doc.path,
            onClick: () => openDoc(doc),
          },
          h(Icon, { name: 'file', size: 14 }),
          h('span', null, doc.label),
        ),
      ),
    )
  }

  function TaskPreview({ t, tasks }) {
    if (tasks === null || tasks === undefined || tasks.items.length === 0) {
      return h('div', { className: 'dshspec-note' }, t('noTasks'))
    }
    const shown = tasks.items.slice(0, 12)
    return h(
      'div',
      { className: 'dshspec-taskBlock' },
      h(
        'div',
        { className: 'dshspec-subHead' },
        h('b', null, t('taskList')),
        h('span', null, t('tasksDone').replace('{done}', String(tasks.done)).replace('{total}', String(tasks.total))),
      ),
      h(
        'ul',
        { className: 'dshspec-taskList' },
        shown.map((item, index) =>
          h(
            'li',
            { key: index, className: 'dshspec-task' + (item.done ? ' dshspec-taskDone' : '') },
            h(Icon, { name: item.done ? 'checkSquare' : 'square', size: 14 }),
            h('span', null, item.text),
          ),
        ),
      ),
      tasks.items.length > shown.length
        ? h('div', { className: 'dshspec-note' }, t('moreTasks').replace('{count}', String(tasks.items.length - shown.length)))
        : null,
    )
  }

  /** One collapsible change row: status line always, artifacts + tasks when open. */
  function ChangeItem({ t, change, open, onToggle, execute, openDoc }) {
    const meta = PHASE_META[change.phase] ?? PHASE_META.draft
    const ready = change.phase === 'ready'
    const tasks = change.tasks
    const toggle = () => onToggle()
    return h(
      'div',
      { className: 'dshspec-item', 'data-dshspec-change': change.name },
      h(
        'div',
        {
          className: 'dshspec-itemHead',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          onClick: toggle,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggle()
            }
          },
        },
        h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (open ? ' dshspec-chevOpen' : '') }),
        h('span', { className: 'dshspec-changeName', title: change.name }, change.name),
        h(PhaseBadge, { t, phase: change.phase }),
        tasks !== null && tasks.total > 0
          ? h('div', { className: 'dshspec-changeProgress' }, h(Progress, { done: tasks.done, total: tasks.total, color: meta.color }))
          : null,
        h('span', { className: 'dshspec-space' }),
        h(
          'div',
          { className: 'dshspec-changeButtons' },
          h(
            Button,
            {
              variant: ready ? 'outline' : 'primary',
              size: 'md',
              icon: 'play',
              onClick: (event) => {
                event.stopPropagation()
                execute(`/opsx-apply ${change.name}`)
              },
            },
            change.phase === 'apply' ? t('applyContinue') : t('apply'),
          ),
          h(
            Button,
            {
              variant: ready ? 'primary' : 'ghost',
              size: 'md',
              icon: 'archive',
              onClick: (event) => {
                event.stopPropagation()
                execute(`/opsx-archive ${change.name}`)
              },
            },
            t('archive'),
          ),
        ),
      ),
      open
        ? h(
            'div',
            { className: 'dshspec-itemBody' },
            h('div', { className: 'dshspec-subHead' }, h('b', null, t('docs'))),
            h(DocGrid, { t, docs: change.docs, openDoc }),
            h(TaskPreview, { t, tasks }),
          )
        : null,
    )
  }

  /** One finalized capability spec row: click opens its spec.md. */
  function CapabilityRow({ t, capability, openDoc }) {
    const doc = capability.docs.find((item) => item.label === 'spec.md') ?? capability.docs[0]
    return h(
      'button',
      {
        type: 'button',
        className: 'dshspec-rowItem',
        title: doc === undefined ? t('noDocs') : doc.path,
        onClick: () => {
          if (doc !== undefined) openDoc(doc)
        },
      },
      h('span', { className: 'dshspec-rowIcon' }, h(Icon, { name: 'layers', size: 15 })),
      h(
        'span',
        { className: 'dshspec-rowText' },
        h('span', { className: 'dshspec-rowName' }, capability.name),
        h('span', { className: 'dshspec-rowMeta' }, doc === undefined ? t('noDocs') : doc.label),
      ),
      capability.requirementCount > 0
        ? h('span', { className: 'dshspec-legendItem' }, t('requirementCount').replace('{count}', String(capability.requirementCount)))
        : null,
      h(Icon, { name: 'chevronRight', size: 14 }),
    )
  }

  function archiveParts(name) {
    const match = /^(\d{4}-\d{2}-\d{2})-(.*)$/.exec(name)
    return match === null ? { date: null, label: name } : { date: match[1], label: match[2] }
  }

  /** Archived changes live at the bottom, newest first, loaded on demand. */
  function ArchiveSection({ t, source, archived, openDoc }) {
    const [open, setOpen] = useState(false)
    const [expanded, setExpanded] = useState({})
    const [details, setDetails] = useState({})

    const load = useCallback(
      (name) => {
        setDetails((prev) => (prev[name] === undefined ? { ...prev, [name]: { status: 'loading' } } : prev))
        if (source === undefined) {
          setDetails((prev) => ({ ...prev, [name]: { status: 'error', error: t('commandFailed') } }))
          return
        }
        void source.loadArchive(name).then((result) => {
          setDetails((prev) => ({
            ...prev,
            [name]:
              result !== null && result !== undefined && result.ok === true
                ? { status: 'ready', docs: result.docs, tasks: result.tasks }
                : { status: 'error', error: result?.error ?? t('commandFailed') },
          }))
        })
      },
      [source, t],
    )

    const toggleItem = (name) => {
      const willOpen = expanded[name] !== true
      setExpanded((prev) => ({ ...prev, [name]: willOpen }))
      if (willOpen && details[name] === undefined) load(name)
    }

    return h(
      'section',
      { className: 'dshspec-section' },
      h(
        'div',
        { className: 'dshspec-sectionHead' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshspec-sectionToggle',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (open ? ' dshspec-chevOpen' : '') }),
          h('span', { className: 'dshspec-sectionTitle' }, t('archivedChanges')),
          h('span', { className: 'dshspec-sectionCount' }, String(archived.length)),
        ),
        h('span', { className: 'dshspec-space' }),
        h('span', { className: 'dshspec-note' }, t('archivedHint')),
      ),
      open
        ? h(
            'div',
            { className: 'dshspec-sectionBody' },
            archived.length === 0
              ? h('div', { className: 'dshspec-sectionEmpty' }, t('noArchived'))
              : archived.map((name) => {
                  const parts = archiveParts(name)
                  const isOpen = expanded[name] === true
                  const detail = details[name]
                  return h(
                    'div',
                    { key: name, className: 'dshspec-item' },
                    h(
                      'div',
                      {
                        className: 'dshspec-itemHead',
                        role: 'button',
                        tabIndex: 0,
                        'aria-expanded': isOpen,
                        onClick: () => toggleItem(name),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleItem(name)
                          }
                        },
                      },
                      h(Icon, { name: 'chevronRight', size: 14, className: 'dshspec-chev' + (isOpen ? ' dshspec-chevOpen' : '') }),
                      h('span', { className: 'dshspec-changeName', title: name }, parts.label),
                      parts.date === null ? null : h('span', { className: 'dshspec-dateChip' }, parts.date),
                      detail !== undefined && detail.status === 'ready' && detail.tasks !== null && detail.tasks.total > 0
                        ? h('div', { className: 'dshspec-changeProgress' }, h(Progress, { done: detail.tasks.done, total: detail.tasks.total, color: 'var(--dsw-alias-state-success-primary)' }))
                        : null,
                      h('span', { className: 'dshspec-space' }),
                      h(Icon, { name: 'archive', size: 14, className: 'dshspec-decoIcon' }),
                    ),
                    isOpen
                      ? h(
                          'div',
                          { className: 'dshspec-itemBody' },
                          detail === undefined || detail.status === 'loading'
                            ? h('div', { className: 'dshspec-inlineLoad' }, h(Icon, { name: 'refresh', size: 14, className: 'dshspec-spin' }), h('span', null, t('loading')))
                            : detail.status === 'error'
                              ? h(Banner, { tone: 'error', wrap: true }, detail.error ?? t('error'))
                              : h(
                                  'div',
                                  { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                                  h('div', { className: 'dshspec-subHead' }, h('b', null, t('docs'))),
                                  h(DocGrid, { t, docs: detail.docs, openDoc }),
                                  h(TaskPreview, { t, tasks: detail.tasks }),
                                ),
                        )
                      : null,
                  )
                }),
          )
        : null,
    )
  }

  /** The selected workspace: overview diagram, changes, specs and archive. */
  function WorkspaceDetail({ t, row, source, compose, init, onRefresh }) {
    const stateSource = source !== undefined ? source.hooks.state : undefined
    const state = useSyncExternalStore(
      stateSource !== undefined ? stateSource.subscribe : NOOP_SUBSCRIBE,
      stateSource !== undefined ? stateSource.getSnapshot : getNoSession,
    )
    const [expanded, setExpanded] = useState({})
    const [doc, setDoc] = useState(null)
    const [notice, setNotice] = useState(null)
    const noticeTimer = useRef(null)

    useEffect(
      () => () => {
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
      },
      [],
    )

    const report = useCallback(
      (outcome, line) => {
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        const failed = outcome !== undefined && outcome !== null && outcome.ok === false
        setNotice({
          tone: failed ? 'error' : 'info',
          icon: failed ? 'alert' : 'check',
          text: failed ? outcome?.text ?? t('commandFailed') : `${t('fillComposer')} · ${line ?? ''}`,
        })
        noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
      },
      [t],
    )

    const commands = useCommands({
      t,
      insert: typeof compose === 'function' ? (line) => compose(row)(line) : undefined,
      changes: state.status === 'ready' ? state.changes : [],
      onResult: report,
    })

    const openDoc = useCallback(
      (item) => {
        const relative = item.path.startsWith(row.cwd)
          ? item.path.slice(row.cwd.length).replace(/^[\\/]+/, '')
          : item.path
        const base = { title: item.label, path: item.path, relPath: relative, status: 'loading', text: '', truncated: false }
        setDoc(base)
        if (source === undefined) {
          setDoc({ ...base, status: 'error', error: t('commandFailed') })
          return
        }
        void source.readFile(item.path).then((page) => {
          setDoc((prev) => {
            if (prev === null || prev.path !== item.path) return prev
            return page.ok
              ? { ...prev, status: 'ready', text: page.text, truncated: page.truncated === true }
              : { ...prev, status: 'error', error: page.error ?? '' }
          })
        })
      },
      [row.cwd, source, t],
    )

    const reload = useCallback(async () => {
      if (source === undefined) {
        if (typeof onRefresh === 'function') await onRefresh()
        return
      }
      await source.refresh()
    }, [source, onRefresh])

    const toggleChange = (name) => setExpanded((prev) => ({ ...prev, [name]: !prev[name] }))

    const changes = state.status === 'ready' ? state.changes : []
    const specs = state.status === 'ready' ? state.specs : []
    const archived = state.status === 'ready' ? state.archived : []

    return h(
      'section',
      { className: 'dshspec-detail', 'data-dshspec-workspace': row.cwd },
      h(
        'div',
        { className: 'dshspec-detailBar' },
        h(Icon, { name: 'folder', size: 15, className: 'dshspec-detailBarIcon' }),
        h('span', { className: 'dshspec-detailBarPath', title: row.cwd }, row.cwd),
        h(
          'div',
          { className: 'dshspec-detailActions' },
          h(Button, { variant: 'ghost', size: 'md', icon: 'compass', title: '/opsx-explore [主题]', onClick: () => commands.open('explore') }, t('explore')),
          h(Button, { variant: 'outline', size: 'md', icon: 'filePlus', title: '/opsx-propose <change-name> [说明]', onClick: () => commands.open('propose') }, t('propose')),
          h(Button, { variant: 'ghost', size: 'md', icon: 'activity', title: '/opsx-status', onClick: () => commands.execute('/opsx-status') }, t('status')),
        ),
      ),
      notice === null ? null : h(Banner, { tone: notice.tone, icon: notice.icon, wrap: notice.tone === 'error' }, notice.text),
      state.status === 'loading' ? h(LoadingBody) : null,
      state.status === 'nosession'
        ? h(
            'div',
            { className: 'dshspec-card' },
            h(
              'div',
              { className: 'dshspec-nosession' },
              h(Icon, { name: 'info', size: 14 }),
              h('span', null, row.sessionId === undefined ? t('nosessionHint') : t('nosession')),
            ),
          )
        : null,
      state.status === 'error'
        ? h(
            'div',
            { className: 'dshspec-card' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h(Banner, { tone: 'error', wrap: true }, `${t('error')}：${state.error ?? ''}`),
              h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void reload() }, t('retry')),
            ),
          )
        : null,
      state.status === 'missing' ? h('div', { className: 'dshspec-card' }, h(MissingBody, { t, init, refresh: () => void reload(), cwd: row.cwd })) : null,
      state.status === 'ready'
        ? [
            h(SpecSummary, { key: 'summary', t, state }),
            h(
              'section',
              { key: 'changes', className: 'dshspec-section' },
              h(
                'div',
                { className: 'dshspec-sectionHead' },
                h('span', { className: 'dshspec-sectionTitle' }, t('activeChanges')),
                h('span', { className: 'dshspec-sectionCount' }, String(changes.length)),
              ),
              h(
                'div',
                { className: 'dshspec-sectionBody' },
                changes.length === 0
                  ? h(SectionEmpty, {
                      icon: 'sparkle',
                      title: t('noChanges'),
                      hint: t('noChangesHint'),
                      action: h(Button, { variant: 'primary', size: 'md', icon: 'filePlus', onClick: () => commands.open('propose') }, t('newProposal')),
                    })
                  : changes.map((change) =>
                      h(ChangeItem, {
                        key: change.name,
                        t,
                        change,
                        open: expanded[change.name] === true,
                        onToggle: () => toggleChange(change.name),
                        execute: commands.execute,
                        openDoc,
                      }),
                    ),
              ),
            ),
            h(
              'section',
              { key: 'specs', className: 'dshspec-section' },
              h(
                'div',
                { className: 'dshspec-sectionHead' },
                h('span', { className: 'dshspec-sectionTitle' }, t('capabilitySpecs')),
                h('span', { className: 'dshspec-sectionCount' }, String(specs.length)),
              ),
              h(
                'div',
                { className: 'dshspec-sectionBody' },
                specs.length === 0
                  ? h(SectionEmpty, { icon: 'layers', title: t('noCapabilities'), hint: t('noCapabilitiesHint') })
                  : specs.map((capability) => h(CapabilityRow, { key: capability.name, t, capability, openDoc })),
              ),
            ),
            h(ArchiveSection, { key: 'archive', t, source, archived, openDoc }),
            state.watchDown === true
              ? h('div', { key: 'watch', className: 'dshspec-foot' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, t('watchDown')))
              : null,
          ]
        : null,
      commands.modal,
      doc === null ? null : h(DocModal, { t, doc, onClose: () => setDoc(null) }),
    )
  }

  /** Cached workspace selection so navigating away and back keeps the pick. */
  let lastSelectedWorkspace = null

  /** The monitoring page: workspace switcher on top, selected workspace below. */
  function OpenspecPanel({ t, rowsSource, sourceFor, composeFor, initFor, onRefreshSessions }) {
    const rows = useSyncExternalStore(rowsSource.subscribe, rowsSource.getSnapshot)
    const [selected, setSelected] = useState(() => lastSelectedWorkspace)
    const [nonce, setNonce] = useState(0)
    const [spinning, setSpinning] = useState(false)
    const selectedRow = rows.find((row) => row.cwd === selected) ?? rows[0]

    const select = (cwd) => {
      lastSelectedWorkspace = cwd
      setSelected(cwd)
    }

    const refreshAll = async () => {
      setSpinning(true)
      try {
        await onRefreshSessions()
      } finally {
        setSpinning(false)
        setNonce((value) => value + 1)
      }
    }

    return h(
      'div',
      { className: 'dshspec-root', 'data-dshspec-panel': true, 'data-dshspec-build': BUILD },
      h(
        'div',
        { className: 'dshspec-page' },
        h(
          'div',
          { className: 'dshspec-pageHead' },
          h(
            'div',
            { className: 'dshspec-pageHeadText' },
            h('h1', { className: 'dshspec-title' }, t('title')),
            h('p', { className: 'dshspec-sub', style: { margin: '2px 0 0' } }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'dshspec-pageActions' },
            h(IconButton, {
              icon: 'refresh',
              label: t('refreshAll'),
              size: 32,
              onClick: () => void refreshAll(),
              className: spinning ? 'dshspec-spin' : undefined,
            }),
          ),
        ),
        rows.length === 0
          ? h(
              'section',
              { className: 'dshspec-card' },
              h(
                'div',
                { className: 'dshspec-empty' },
                h('span', { className: 'dshspec-emptyIcon' }, h(Icon, { name: 'info', size: 20 })),
                h('div', { className: 'dshspec-emptyTitle' }, t('nosession')),
              ),
            )
          : [
              h(
                'div',
                { key: 'wsbar', className: 'dshspec-wsbar' },
                h('span', { className: 'dshspec-wsbarLabel' }, t('workspaceLabel')),
                h(
                  'div',
                  { className: 'dshspec-wstabs' },
                  rows.map((row) =>
                    h(
                      'button',
                      {
                        key: row.cwd,
                        type: 'button',
                        className: 'dshspec-wstab',
                        title: row.cwd,
                        'data-active': selectedRow !== undefined && row.cwd === selectedRow.cwd ? 'true' : undefined,
                        onClick: () => select(row.cwd),
                      },
                      h(Icon, { name: 'folder', size: 15 }),
                      h('span', { className: 'dshspec-wstabName' }, basenameOf(row.cwd)),
                    ),
                  ),
                ),
              ),
              selectedRow === undefined
                ? null
                : h(WorkspaceDetail, {
                    key: `${selectedRow.cwd}#${nonce}`,
                    t,
                    row: selectedRow,
                    source: selectedRow.sessionId !== undefined ? sourceFor(selectedRow.sessionId) : undefined,
                    compose: composeFor,
                    init: initFor,
                    onRefresh: onRefreshSessions,
                  }),
            ],
      ),
    )
  }



  function DockBody({ t, state, source, openPanel, init, sessionId }) {
    const [toast, setToast] = useState(null)
    const toastTimer = useRef(null)
    useEffect(
      () => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      },
      [],
    )
    const showToast = useCallback((text) => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current)
      setToast(text)
      toastTimer.current = setTimeout(() => setToast(null), 3200)
    }, [])

    const changes = state.status === 'ready' ? state.changes : []
    const target = primaryChange(state)
    const commands = useCommands({
      t,
      run: (line) => source.run(line),
      insert: (text) => insertIntoComposer(text),
      changes,
      onResult: (outcome) => {
        if (outcome !== undefined && outcome !== null && outcome.ok === false) showToast(outcome.text ?? t('commandFailed'))
      },
    })

    const stage = nextStage(state)
    const applyLine = target !== undefined ? `/opsx-apply ${target.name}` : '/opsx-apply '
    const archiveLine = target !== undefined ? `/opsx-archive ${target.name}` : '/opsx-archive '
    const multiple = changes.length > 1
    const progress =
      target !== undefined && target.tasks !== null && target.tasks.total > 0
        ? t('taskProgress').replace('{done}', String(target.tasks.done)).replace('{total}', String(target.tasks.total))
        : null

    const openApply = () => {
      if (target === undefined) return
      if (multiple) commands.open('pick')
      else commands.execute(applyLine)
    }

    return h(
      'div',
      { className: 'dshspec-dock', 'data-dshspec-quickbar': 'ready', 'data-dshspec-session': sessionId },
      h(
        'div',
        { className: 'dshspec-dockStatus' },
        target === undefined ? h('span', { className: 'dshspec-dot', style: { background: statusColor(state) } }) : null,
        target === undefined
          ? h('span', { className: 'dshspec-dockName', title: t('quickNoChange') }, `OpenSpec · ${t('quickNoChange')}`)
          : h('span', { className: 'dshspec-dockName', title: target.name }, target.name),
        target === undefined ? null : h(PhaseBadge, { t, phase: target.phase }),
        progress === null ? null : h('span', { className: 'dshspec-progressCount' }, progress),
      ),
      h(
        'div',
        { className: 'dshspec-dockActions' },
        h(
          'div',
          { className: 'dshspec-seg' },
          h(Button, {
            variant: stage === 'explore' ? 'primary' : 'ghost',
            size: 'sm',
            title: '/opsx-explore [主题]',
            onClick: () => commands.open('explore'),
          }, t('explore')),
          h(Button, {
            variant: stage === 'propose' ? 'primary' : 'ghost',
            size: 'sm',
            title: '/opsx-propose <change-name> [说明]',
            onClick: () => commands.open('propose'),
          }, t('propose')),
          h(Button, {
            variant: stage === 'apply' ? 'primary' : 'ghost',
            size: 'sm',
            title: applyLine,
            disabled: target === undefined,
            onClick: openApply,
          }, t('apply')),
          h(Button, {
            variant: stage === 'archive' ? 'primary' : 'ghost',
            size: 'sm',
            title: archiveLine,
            disabled: target === undefined,
            onClick: () => commands.execute(archiveLine),
          }, t('archive')),
        ),
        h(Button, { variant: 'ghost', size: 'sm', title: '/opsx-status', onClick: () => commands.execute('/opsx-status') }, t('status')),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      ),
      commands.modal,
      toast === null ? null : h('div', { className: 'dshspec-toast', role: 'status' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, toast)),
    )
  }

  /** The quick bar under the composer: status + one-click phase commands. */
  function QuickBar({ state: stateSource, source, openPanel, t, init, sessionId }) {
    if (stateSource === undefined) return null
    const state = useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot)
    if (state.status === 'loading' || state.status === 'nosession') return null
    if (state.status === 'error') {
      return h(
        'div',
        { className: 'dshspec-dock', 'data-dshspec-quickbar': 'error', 'data-dshspec-session': sessionId },
        h(
          'div',
          { className: 'dshspec-banner dshspec-bannerError', style: { flex: 1, minWidth: 0 } },
          h(Icon, { name: 'alert', size: 14 }),
          h('span', { className: 'dshspec-bannerText', title: state.error ?? '' }, `${t('error')}：${state.error ?? ''}`),
        ),
        h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void source.refresh() }, t('retry')),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      )
    }
    if (state.status === 'missing') {
      return h(
        'div',
        { className: 'dshspec-dock', 'data-dshspec-quickbar': 'missing', 'data-dshspec-session': sessionId },
        h('span', { className: 'dshspec-dot', style: { background: 'var(--dsw-alias-state-warn-primary)' } }),
        h('span', { className: 'dshspec-dockName' }, `OpenSpec · ${t('quickMissing')}`),
        h('span', { className: 'dshspec-space' }),
        h(InitControl, { t, init, refresh: () => source.refresh(), cwd: state.cwd }),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      )
    }
    return h(DockBody, { t, state, source, openPanel, init, sessionId })
  }

  /* ------------------------------------------------------------------ *
   * Registration.
   * ------------------------------------------------------------------ */

  /** Sidebar glyph: a small phase-loop mark. */
  function PanelIcon() {
    return h(
      'svg',
      { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' } },
      h('path', {
        d: 'M 8 7 a 6.5 6.5 0 1 1 -1 7.5',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
      }),
      h('circle', { cx: 8, cy: 7, r: 1.9, fill: 'currentColor' }),
      h('rect', { x: 10, y: 12.5, width: 8, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.9 }),
      h('rect', { x: 10, y: 16, width: 5.5, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.55 }),
    )
  }

  /** Build marker for served-bundle verification. */
  const BUILD = '20261020-spec-browser'

  /**
   * Register the locale dictionaries, the monitoring page, the sidebar glyph,
   * and the composer quick bar.
   * @param ctx - browser services used by these contributions.
   */
  function apply(ctx) {
    injectStyle()
    ctx.effect(() => ctx.locale.register(NS, { zh: T.zh, en: T.en }), 'dsh-spec: dictionaries')
    const t = ctx.locale.bind(NS)

    /** One source per session, shared by the dock and the panel. */
    const sources = new Map()
    const sourceFor = (sessionId) => {
      let source = sources.get(sessionId)
      if (source === undefined) {
        source = createOpenspecSource(ctx, sessionId)
        sources.set(sessionId, source)
      }
      return source
    }

    /** Wait until the target session's composer dock has mounted. */
    const waitForDock = (target, timeoutMs) =>
      new Promise((resolve) => {
        const started = Date.now()
        const probe = () => {
          if (typeof document === 'undefined') {
            resolve(false)
            return
          }
          const escaped = String(target).replace(/["\\]/g, '')
          if (document.querySelector('[data-dshspec-quickbar][data-dshspec-session="' + escaped + '"]') !== null) {
            resolve(true)
            return
          }
          if (Date.now() - started >= timeoutMs) {
            resolve(false)
            return
          }
          setTimeout(probe, 120)
        }
        probe()
      })

    /**
     * Bring one workspace's conversation on screen and put the command line
     * into its composer draft — never auto-send. An existing session is opened
     * first; only a workspace without any session asks the host to create one.
     * The dock marker tells us the target session has been mounted before we
     * type into the editor.
     */
    const composeFor = (row) => async (line) => {
      const fill = () => {
        const inserted = insertIntoComposer(line)
        return inserted === false ? { ok: false, text: t('insertFailed') } : { ok: true, text: line }
      }
      try {
        const existing = [
          ...(Array.isArray(row.sessionIds) ? row.sessionIds : []),
          row.sessionId,
        ].filter((id) => typeof id === 'string')
        for (const candidate of [...new Set(existing)]) {
          if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(candidate)
          if (await waitForDock(candidate, 1800)) return fill()
        }
        let created
        if (row.workspaceId !== undefined && typeof ctx.uiWorkspace?.connectWorkspace === 'function') {
          const connected = await withTimeout(
            Promise.resolve(ctx.uiWorkspace.connectWorkspace(row.workspaceId)),
            15000,
            '连接工作区',
          )
          if (typeof connected === 'string') created = connected
          else if (connected !== null && typeof connected === 'object') {
            if (typeof connected.sessionId === 'string') created = connected.sessionId
            else if (typeof connected.id === 'string') created = connected.id
          }
        }
        if (typeof created !== 'string') return { ok: false, text: t('switchFailed') }
        if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(created)
        await waitForDock(created, 10000)
        return fill()
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    }

    /**
     * Session-less init for a panel workspace row: post the workspace path to
     * the Host's /dsh-spec route, which validates it against the registered
     * workspaces and writes the fixed skeleton. No session or model needed.
     */
    const initFor = async (cwd) => {
      try {
        const result = await withTimeout(
          Promise.resolve(ctx.connection.rpc.call(ROUTE, 'init', { cwd: typeof cwd === 'string' ? cwd : '' })),
          15000,
          '初始化',
        )
        if (result !== null && typeof result === 'object' && result.ok === true) {
          return { ok: true, text: result.value?.text ?? 'OpenSpec 骨架已就绪。' }
        }
        return { ok: false, text: result?.error?.message ?? '初始化失败' }
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    }

    /** Stable rows snapshot for the panel: recomputed only when a store changes. */
    let lastRaw
    let lastRows = []
    const rowsSource = {
      subscribe: (listener) => ctx.workspaces.list.subscribe(listener),
      getSnapshot: () => {
        const raw = ctx.workspaces.list.getSnapshot()
        if (raw !== lastRaw) {
          lastRaw = raw
          lastRows = workspaceRows(ctx)
        }
        return lastRows
      },
    }

    const refreshAll = async () => {
      const rows = rowsSource.getSnapshot()
      await Promise.all(
        rows.map((row) => (row.sessionId !== undefined ? sourceFor(row.sessionId).refresh() : Promise.resolve())),
      )
    }

    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => ({
        t,
        rowsSource,
        sourceFor,
        composeFor,
        initFor,
        onRefreshSessions: refreshAll,
      }),
    }, OpenspecPanel))

    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 12,
      locale: NS,
      label: () => t('panel'),
    }, PanelIcon))

    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: DOCK_ID,
      order: 5,
      locale: NS,
      inject: (sessionId) => {
        const source = sourceFor(sessionId)
        return {
          sessionId,
          state: source.hooks.state,
          source,
          init: initFor,
          openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        }
      },
    }, QuickBar))
  }

  return { inject: ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'remote.commands', 'sessions', 'workspaces', 'uiWorkspace', 'connection', 'layout'], apply }
}

window.__ModuleLoader__.load({
  id: 'dsh-spec',
  factory: (require) => {
    const plugin = createOpenSpecPlugin(require)
    return { inject: plugin.inject, apply: plugin.apply }
  },
})
