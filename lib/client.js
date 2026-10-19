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
.dshspec-page{max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 56px;display:flex;flex-direction:column;gap:22px}
.dshspec-pageHead{display:flex;align-items:flex-start;gap:16px}
.dshspec-pageHeadText{min-width:0;flex:1}
.dshspec-title{margin:0;font-size:20px;line-height:28px;font-weight:500;letter-spacing:0}
.dshspec-sub{margin-top:2px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshspec-pageActions{display:flex;align-items:center;gap:8px;flex:none}
.dshspec-space{flex:1}

.dshspec-card{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,16px);padding:18px 20px 16px;display:flex;flex-direction:column;gap:14px}
.dshspec-wsHead{display:flex;align-items:center;gap:12px;min-width:0}
.dshspec-wsIcon{flex:none;width:36px;height:36px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.dshspec-wsText{min-width:0;display:flex;flex-direction:column;gap:1px;flex:1}
.dshspec-wsName{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-wsPath{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-wsMeta{flex:none;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshspec-wsActions{flex:none;display:flex;align-items:center;gap:4px;margin-left:4px}

.dshspec-changes{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l1)}
.dshspec-change{display:flex;align-items:center;gap:16px;padding:12px 0}
.dshspec-change+.dshspec-change{border-top:.5px solid var(--dsw-alias-border-l1)}
.dshspec-changeMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px}
.dshspec-changeHead{display:flex;align-items:center;gap:8px;min-width:0}
.dshspec-changeName{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshspec-changeMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:20px}
.dshspec-changeActions{flex:none;display:flex;align-items:center;gap:6px}

.dshspec-badge{flex:none;display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 8px 0 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap;font-weight:400}
.dshspec-badgeDot{width:5px;height:5px;border-radius:50%;flex:none}
.dshspec-progress{display:flex;align-items:center;gap:8px;flex:0 1 170px;min-width:110px;max-width:220px}
.dshspec-progressTrack{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.dshspec-progressFill{height:100%;border-radius:2px;transition:width .24s ease}
.dshspec-progressCount{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshspec-fileChip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap}

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

.dshspec-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.24);animation:dshspec-fade .12s ease-out}
.dshspec-modal{width:100%;max-height:calc(100vh - 48px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-panel,28px);box-shadow:var(--dsw-elevation-prominent);padding:22px 24px 20px;display:flex;flex-direction:column;gap:16px;animation:dshspec-pop .14s cubic-bezier(.2,.8,.2,1)}
.dshspec-modalHead{display:flex;align-items:flex-start;gap:12px}
.dshspec-modalHeadText{flex:1;min-width:0}
.dshspec-modalTitle{margin:0;font-size:16px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshspec-modalDesc{margin:6px 0 0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary)}
.dshspec-modalBody{display:flex;flex-direction:column;gap:12px}
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
@media (prefers-reduced-motion:reduce){.dshspec-overlay,.dshspec-modal,.dshspec-toast,.dshspec-spin,.dshspec-skelLine{animation:none}}
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

  function Modal({ t, title, description, children, footer, onClose, width = 512 }) {
    const cardRef = useRef(null)
    const restoreRef = useRef(null)
    const closeRef = useRef(onClose)
    closeRef.current = onClose

    useEffect(() => {
      restoreRef.current = typeof document === 'undefined' ? null : document.activeElement
      const card = cardRef.current
      const target = card?.querySelector('[data-autofocus]') ?? card?.querySelector('input, textarea, button')
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
          const inserted = insert(line)
          if (inserted === false) onResult?.({ ok: false, text: t('insertFailed') }, line)
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
          const inserted = insert(line)
          if (inserted === false) setError(t('insertFailed'))
          else close()
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
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const match = /^\s*[-*]\s+\[([ xX])\]\s+/.exec(line)
      if (match === null) continue
      total += 1
      if (match[1].toLowerCase() === 'x') done += 1
    }
    return { total, done }
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

    const readChange = async (root, name) => {
      const base = `${root}/changes/${name}`
      const listing = await ctx.remote.workspaceFiles.list(sessionId, base)
      if (!listing.ok) throw Object.assign(new Error(listing.error?.message ?? 'list failed'), { code: listing.error?.code })
      const names = []
      let hasProposal = false
      let hasSpecs = false
      for (const entry of listing.value.entries) {
        if (entry.name === 'proposal.md') hasProposal = true
        if (entry.name === 'specs' && entry.type === 'directory') hasSpecs = true
        names.push(entry.name)
      }
      let tasks = null
      if (names.includes('tasks.md')) {
        const page = await ctx.remote.workspaceFiles.read(sessionId, `${base}/tasks.md`, { offset: 1, limit: 400 })
        if (page.ok) tasks = parseTasks(page.value.text)
      }
      return { name, hasProposal, hasSpecs, tasks, phase: null, files: names.slice(0, 10) }
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
        let archived = 0
        const archiveEntry = topLevel.value.entries.find((entry) => entry.name === 'archive' && entry.type === 'directory')
        if (archiveEntry !== undefined) {
          const archiveList = await ctx.remote.workspaceFiles.list(sessionId, `${root}/changes/archive`)
          if (archiveList.ok && request === epoch) {
            archived = archiveList.value.entries.filter((entry) => entry.type === 'directory').length
          }
        }
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
        publish({ status: 'ready', cwd, root, changes, archived, watchDown: snapshot.watchDown === true })
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
    if (document.execCommand('insertText', false, text)) return true
    editor.textContent += text
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

  function EmptyBody({ t, onPropose }) {
    return h(
      'div',
      { className: 'dshspec-empty' },
      h('span', { className: 'dshspec-emptyIcon' }, h(Icon, { name: 'sparkle', size: 20 })),
      h('div', { className: 'dshspec-emptyTitle' }, t('noChanges')),
      h('div', { className: 'dshspec-emptyDesc' }, t('noChangesHint')),
      h(Button, { variant: 'primary', size: 'md', icon: 'filePlus', onClick: onPropose }, t('newProposal')),
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

  /** One change row: identity + phase + progress on the left, actions on the right. */
  function ChangeRow({ t, change, execute }) {
    const meta = PHASE_META[change.phase] ?? PHASE_META.draft
    const archiveFirst = change.phase === 'ready'
    const taskProgress = change.tasks !== null && change.tasks.total > 0
    return h(
      'div',
      { className: 'dshspec-change', 'data-dshspec-change': change.name },
      h(
        'div',
        { className: 'dshspec-changeMain' },
        h(
          'div',
          { className: 'dshspec-changeHead' },
          h('span', { className: 'dshspec-changeName', title: change.name }, change.name),
          h(PhaseBadge, { t, phase: change.phase }),
        ),
        h(
          'div',
          { className: 'dshspec-changeMeta' },
          taskProgress ? h(Progress, { done: change.tasks.done, total: change.tasks.total, color: meta.color }) : null,
          taskProgress && change.files.length > 0
            ? h('span', { style: { width: 3, height: 3, borderRadius: '50%', background: 'var(--dsw-alias-label-dimmed)', flex: 'none' } })
            : null,
          change.files.map((file) => h('span', { key: file, className: 'dshspec-fileChip' }, file)),
        ),
      ),
      h(
        'div',
        { className: 'dshspec-changeActions' },
        h(
          Button,
          {
            variant: archiveFirst ? 'outline' : 'primary',
            size: 'md',
            icon: 'play',
            onClick: () => execute(`/opsx-apply ${change.name}`),
          },
          change.phase === 'apply' ? t('applyContinue') : t('apply'),
        ),
        h(
          Button,
          {
            variant: archiveFirst ? 'primary' : 'ghost',
            size: 'md',
            icon: 'archive',
            onClick: () => execute(`/opsx-archive ${change.name}`),
          },
          t('archive'),
        ),
      ),
    )
  }

  /** One workspace section in the panel. */
  function WorkspaceCard({ t, row, source, dispatch, init, onRefreshAll }) {
    const stateSource = source !== undefined ? source.hooks.state : undefined
    const state = useSyncExternalStore(
      stateSource !== undefined ? stateSource.subscribe : NOOP_SUBSCRIBE,
      stateSource !== undefined ? stateSource.getSnapshot : getNoSession,
    )
    const [notice, setNotice] = useState(null)
    const [spinning, setSpinning] = useState(false)
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
          text: failed ? outcome?.text ?? t('commandFailed') : `${t('commandSent')} · ${line ?? ''}`,
        })
        noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
      },
      [t],
    )

    const commands = useCommands({
      t,
      run: (line) => dispatch(row, line),
      changes: state.status === 'ready' ? state.changes : [],
      onResult: report,
    })

    const refreshSelf = useCallback(async () => {
      if (source === undefined) return
      setSpinning(true)
      try {
        await source.refresh()
      } finally {
        setSpinning(false)
      }
    }, [source])

    const refresh = () => {
      if (source !== undefined) void refreshSelf()
      else if (typeof onRefreshAll === 'function') void onRefreshAll()
    }

    const changes = state.status === 'ready' ? state.changes : []
    const archived = state.status === 'ready' ? state.archived : 0
    const metaText = state.status === 'ready' ? t('changeCount').replace('{count}', String(changes.length)) : null

    return h(
      'section',
      { className: 'dshspec-card', 'data-dshspec-workspace': row.cwd },
      h(
        'div',
        { className: 'dshspec-wsHead' },
        h('span', { className: 'dshspec-wsIcon' }, h(Icon, { name: 'folder', size: 16 })),
        h(
          'div',
          { className: 'dshspec-wsText' },
          h('span', { className: 'dshspec-wsName', title: row.cwd }, basenameOf(row.cwd)),
          h('span', { className: 'dshspec-wsPath', title: row.cwd }, row.cwd),
        ),
        metaText === null ? null : h('span', { className: 'dshspec-wsMeta' }, metaText),
        h(
          'div',
          { className: 'dshspec-wsActions' },
          h(Button, { variant: 'ghost', size: 'md', icon: 'compass', title: '/opsx-explore [主题]', onClick: () => commands.open('explore') }, t('explore')),
          h(Button, { variant: 'outline', size: 'md', icon: 'filePlus', title: '/opsx-propose <change-name> [说明]', onClick: () => commands.open('propose') }, t('propose')),
          h(Button, { variant: 'ghost', size: 'md', icon: 'activity', title: '/opsx-status', onClick: () => commands.execute('/opsx-status') }, t('status')),
          h(IconButton, {
            icon: 'refresh',
            label: t('refresh'),
            onClick: refresh,
            className: spinning ? 'dshspec-spin' : undefined,
          }),
        ),
      ),
      notice === null ? null : h(Banner, { tone: notice.tone, icon: notice.icon, wrap: notice.tone === 'error' }, notice.text),
      state.status === 'loading' ? h(LoadingBody) : null,
      state.status === 'nosession'
        ? h(
            'div',
            { className: 'dshspec-nosession' },
            h(Icon, { name: 'info', size: 14 }),
            h('span', null, row.sessionId === undefined ? t('nosessionHint') : t('nosession')),
          )
        : null,
      state.status === 'error'
        ? h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(Banner, { tone: 'error', wrap: true }, `${t('error')}：${state.error ?? ''}`),
            h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => void refreshSelf() }, t('retry')),
          )
        : null,
      state.status === 'missing' ? h(MissingBody, { t, init, refresh: () => void refreshSelf(), cwd: row.cwd }) : null,
      state.status === 'ready'
        ? changes.length === 0
          ? h(EmptyBody, { t, onPropose: () => commands.open('propose') })
          : h(
              'div',
              { className: 'dshspec-changes' },
              changes.map((change) => h(ChangeRow, { key: change.name, t, change, execute: commands.execute })),
            )
        : null,
      archived > 0
        ? h(
            'div',
            { className: 'dshspec-foot' },
            h(Icon, { name: 'archive', size: 14 }),
            h('span', null, t('archived').replace('{count}', String(archived))),
          )
        : null,
      state.watchDown === true ? h('div', { className: 'dshspec-foot' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, t('watchDown'))) : null,
      commands.modal,
    )
  }

  /** The monitoring page: one card per known workspace. */
  function OpenspecPanel({ t, rowsSource, sourceFor, dispatchFor, initFor, onRefreshSessions }) {
    const rows = useSyncExternalStore(rowsSource.subscribe, rowsSource.getSnapshot)
    const [nonce, setNonce] = useState(0)
    const [spinning, setSpinning] = useState(false)
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
          : rows.map((row) =>
              h(WorkspaceCard, {
                key: `${row.cwd}#${nonce}`,
                t,
                row,
                source: row.sessionId !== undefined ? sourceFor(row.sessionId) : undefined,
                dispatch: dispatchFor,
                init: initFor,
                onRefreshAll: onRefreshSessions,
              }),
            ),
      ),
    )
  }

  /* ------------------------------------------------------------------ *
   * Composer dock — the compact phase bar under the input.
   * ------------------------------------------------------------------ */

  function DockBody({ t, state, source, openPanel, init }) {
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
      { className: 'dshspec-dock', 'data-dshspec-quickbar': 'ready' },
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
  function QuickBar({ state: stateSource, source, openPanel, t, init }) {
    if (stateSource === undefined) return null
    const state = useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot)
    if (state.status === 'loading' || state.status === 'nosession') return null
    if (state.status === 'error') {
      return h(
        'div',
        { className: 'dshspec-dock', 'data-dshspec-quickbar': 'error' },
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
        { className: 'dshspec-dock', 'data-dshspec-quickbar': 'missing' },
        h('span', { className: 'dshspec-dot', style: { background: 'var(--dsw-alias-state-warn-primary)' } }),
        h('span', { className: 'dshspec-dockName' }, `OpenSpec · ${t('quickMissing')}`),
        h('span', { className: 'dshspec-space' }),
        h(InitControl, { t, init, refresh: () => source.refresh(), cwd: state.cwd }),
        h(IconButton, { icon: 'layout', label: t('openPanel'), size: 28, onClick: openPanel }),
      )
    }
    return h(DockBody, { t, state, source, openPanel, init })
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
  const BUILD = '20261019-ui2'

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

    /** Normalize one raw commands.execute outcome. */
    const normalizeOutcome = (outcome, line) => {
      if (outcome === undefined) return { ok: false, text: `${line} 不是可用命令` }
      if (!outcome.ok) return { ok: false, text: outcome.error?.message ?? `${line} 执行失败（${outcome.error?.code ?? 'unknown'}）` }
      const execution = outcome.value
      if (execution === undefined || execution.result === undefined) return { ok: false, text: `${line} 不是可用命令` }
      const result = execution.result
      return result.kind === 'success'
        ? { ok: true, text: result.text ?? '' }
        : { ok: false, text: result.text ?? `${line} 执行失败（无错误信息）` }
    }
    const rawExecute = (agentId, line) => ctx.remote.commands.execute(agentId, line, [])

    /**
     * Dispatch one command line for a panel workspace row. The commands wire
     * requires the client's CURRENT session scope and the exact receiving
     * agent id, and the panel itself is root-scoped — so dispatch first
     * brings the workspace's conversation on screen (starting one when
     * needed) and then executes against that session. The user lands in the
     * conversation, where the command's direct output renders.
     */
    const dispatchFor = (row) => async (line) => {
      try {
        let connectedId
        if (row.workspaceId !== undefined && typeof ctx.uiWorkspace?.connectWorkspace === 'function') {
          const connected = await withTimeout(
            Promise.resolve(ctx.uiWorkspace.connectWorkspace(row.workspaceId)),
            15000,
            '连接工作区',
          )
          if (typeof connected === 'string') connectedId = connected
          else if (connected !== null && typeof connected === 'object') {
            if (typeof connected.sessionId === 'string') connectedId = connected.sessionId
            else if (typeof connected.id === 'string') connectedId = connected.id
          }
        }
        const candidates = [connectedId, row.sessionId, ...(Array.isArray(row.sessionIds) ? row.sessionIds : [])]
          .filter((id) => typeof id === 'string')
        const deduped = [...new Set(candidates)]
        if (deduped.length === 0) return { ok: false, text: '没有可用会话，无法执行该操作' }
        let lastOutcome
        for (const candidate of deduped) {
          if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(candidate)
          await new Promise((resolve) => setTimeout(resolve, 600))
          const outcome = await withTimeout(rawExecute(candidate, line), 20000, line)
          if (outcome !== undefined && outcome.ok) return normalizeOutcome(outcome, line)
          lastOutcome = outcome
        }
        return normalizeOutcome(lastOutcome, line)
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
        dispatchFor,
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
