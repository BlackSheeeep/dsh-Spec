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
 */

function createOpenSpecPlugin(require) {
  const React = require('react')
  const h = React.createElement
  const { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } = React

  /** Sidebar row id and the `main` dispatch key — the SAME string in both. */
  const PANEL_ID = 'openspec'
  /** The composer-dock entry id. */
  const DOCK_ID = 'openspec-quickbar'
  /** Locale namespace registered in apply(). */
  const NS = 'openSpec'
  /** Debounce for watch-driven refreshes. */
  const REFRESH_DEBOUNCE_MS = 400
  /** Fallback poll when the directory watch is unsupported. */
  const FALLBACK_POLL_MS = 8000
  /** How long a direct command result line stays visible. */
  const RESULT_MS = 6000
  /** Max change folders inspected per workspace. */
  const MAX_CHANGES = 12

  /** All user-visible copy lives here. */
  const T = {
    zh: {
      panel: 'OpenSpec',
      title: 'OpenSpec 工作流',
      subtitle: '进度只存在于 openspec/ 的文件里，这里只是它的实时视图。',
      refresh: '刷新',
      loading: '读取 openspec/ …',
      nosession: '这里还没有已知的工作区会话。',
      missing: '此工作区还没有 openspec/。',
      missingHint: '一键初始化后，AI 就能用 /opsx-* 命令走 探索 → 提案 → 实施 → 归档 的规格流程。',
      init: '初始化 OpenSpec',
      error: '读取失败',
      retry: '重试',
      ready: '就绪',
      noChanges: '没有进行中的变更。用输入框上方的 /opsx-propose 或下方快捷条开始一个。',
      archived: '已归档 {count} 个变更',
      explore: '探索',
      propose: '提案',
      apply: '实施',
      archive: '归档',
      status: '状态',
      proposePlaceholder: 'change-name（可附说明，如：add-dark-mode 支持深色主题）',
      proposeGo: '发送 /opsx-propose',
      cancel: '取消',
      pickChange: '选择变更',
      phaseDraft: '草稿',
      phaseProposed: '已提案 · 待评审',
      phaseApply: '实施中',
      phaseReady: '待归档',
      files: '工件',
      tasks: '任务',
      openPanel: '打开 OpenSpec 面板',
      quickMissing: '未初始化',
      quickNoChange: '无进行中变更',
      nosessionHint: '对话还没开始：点任意按钮会自动开始会话并执行。',
      commandFailed: '命令失败',
      commandSent: '已发送',
      watchDown: '（实时监听不可用，手动刷新）',
    },
    en: {
      panel: 'OpenSpec',
      title: 'OpenSpec workflow',
      subtitle: 'Progress lives only in the openspec/ files — this is its live view.',
      refresh: 'Refresh',
      loading: 'Reading openspec/ …',
      nosession: 'No known workspace session here yet.',
      missing: 'This workspace has no openspec/ yet.',
      missingHint: 'Initialize once and the AI can run the spec loop — explore, propose, apply, archive — through /opsx-* commands.',
      init: 'Initialize OpenSpec',
      error: 'Read failed',
      retry: 'Retry',
      ready: 'Ready',
      noChanges: 'No change in motion. Start one with /opsx-propose or the quick bar under the composer.',
      archived: '{count} archived changes',
      explore: 'Explore',
      propose: 'Propose',
      apply: 'Apply',
      archive: 'Archive',
      status: 'Status',
      proposePlaceholder: 'change-name (optional note, e.g. add-dark-mode)',
      proposeGo: 'Send /opsx-propose',
      cancel: 'Cancel',
      pickChange: 'Pick a change',
      phaseDraft: 'Draft',
      phaseProposed: 'Proposed · review',
      phaseApply: 'Applying',
      phaseReady: 'Ready to archive',
      files: 'Artifacts',
      tasks: 'Tasks',
      openPanel: 'Open the OpenSpec panel',
      quickMissing: 'Not initialized',
      quickNoChange: 'No change in motion',
      nosessionHint: 'No conversation yet: any button starts a session, then runs.',
      commandFailed: 'Command failed',
      commandSent: 'Sent',
      watchDown: '(live watch unavailable, refresh manually)',
    },
  }

  /** Plugin-scoped styles; only --dsw-alias-* / --dsw-radius-* / --dsh-content-* tokens. */
  const CSS = [
    '.dshspec-root{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;min-height:0;flex:auto;}',
    '.dshspec-page{max-width:880px;width:100%;margin:0 auto;padding:20px 24px 48px;display:flex;flex-direction:column;gap:16px;}',
    '.dshspec-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}',
    '.dshspec-title{font-size:18px;font-weight:600;}',
    '.dshspec-sub{color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);}',
    '.dshspec-space{flex:1;}',
    '.dshspec-btn{cursor:pointer;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:4px 10px;font:inherit;font-size:12px;line-height:1.6;}',
    '.dshspec-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));}',
    '.dshspec-btn:disabled{opacity:0.45;cursor:default;}',
    '.dshspec-btnPrimary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff;}',
    '.dshspec-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;}',
    '.dshspec-noteError{color:var(--dsw-alias-state-error-primary);}',
    '.dshspec-card{background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
    '.dshspec-workspace{display:flex;flex-direction:column;gap:10px;}',
    '.dshspec-wsHead{display:flex;align-items:center;gap:10px;}',
    '.dshspec-wsPath{font-size:13px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
    '.dshspec-change{display:flex;flex-direction:column;gap:8px;border-top:0.5px solid var(--dsw-alias-border-l1);padding-top:10px;}',
    '.dshspec-change:first-of-type{border-top:0;padding-top:0;}',
    '.dshspec-changeHead{display:flex;align-items:center;gap:8px;min-width:0;}',
    '.dshspec-changeName{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dshspec-chip{flex:none;font-size:11px;border-radius:999px;padding:1px 8px;border:0.5px solid var(--dsw-alias-border-l2);white-space:nowrap;}',
    '.dshspec-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
    '.dshspec-barFill{height:100%;border-radius:2px;}',
    '.dshspec-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.dshspec-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}',
    '.dshspec-fileChip{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
    '.dshspec-dock{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 2px 6px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
    '.dshspec-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
    '.dshspec-dockName{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);}',
    '.dshspec-actwrap{display:contents;}',
    '.dshspec-inline{display:flex;gap:6px;width:100%;align-items:center;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);padding:6px 8px;}',
    '.dshspec-input{flex:1;min-width:220px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:4px 8px;font:inherit;font-size:12px;}',
    '.dshspec-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
  ].join('\n')

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

  /** Phase from files + parsed tasks; mirrors src/prompts.js derivePhase. */
  function derivePhase(change) {
    if (change.tasks !== null && change.tasks.total > 0) {
      return change.tasks.done < change.tasks.total ? 'apply' : 'ready'
    }
    if (change.hasProposal || change.hasSpecs) return 'proposed'
    return 'draft'
  }

  const PHASE_META = {
    draft: { key: 'phaseDraft', color: 'var(--dsw-alias-state-idle-primary)' },
    proposed: { key: 'phaseProposed', color: 'var(--dsw-alias-brand-primary)' },
    apply: { key: 'phaseApply', color: 'var(--dsw-alias-state-warn-primary)' },
    ready: { key: 'phaseReady', color: 'var(--dsw-alias-state-success-primary)' },
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

    const readChange = async (root, name, request) => {
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
            const change = await readChange(root, dir.name, request)
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
        } catch (error) {
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

  function subscribeStore(ctx) {
    return (listener) => ctx.sessions.list.subscribe(listener)
  }

  function getStore(ctx) {
    return () => ctx.sessions.list.getSnapshot()
  }

  /** Phase label chip. */
  function PhaseChip({ t, phase }) {
    const meta = PHASE_META[phase] ?? PHASE_META.draft
    return h('span', { className: 'dshspec-chip', style: { color: meta.color, borderColor: meta.color } }, t(meta.key))
  }

  function Progress({ done, total, color }) {
    if (!(total > 0)) return null
    return h('div', { className: 'dshspec-row', style: { flex: '1 1 120px', gap: 6 } },
      h('div', { className: 'dshspec-bar', style: { flex: 1 } },
        h('div', { className: 'dshspec-barFill', style: { width: `${Math.round((done / total) * 100)}%`, background: color } })),
      h('span', { className: 'dshspec-note', style: { fontVariantNumeric: 'tabular-nums' } }, `${done}/${total}`),
    )
  }

  /** Stable no-op external-store pieces for workspace cards without a session yet. */
  const NOOP_SUBSCRIBE = () => () => {}
  const NOSession_SNAPSHOT = { status: 'nosession' }
  const getNoSession = () => NOSession_SNAPSHOT

  /** One workspace section in the panel. */
  function WorkspaceCard({ t, row, source, dispatch }) {
    const stateSource = source !== undefined ? source.hooks.state : undefined
    const state = useSyncExternalStore(
      stateSource !== undefined ? stateSource.subscribe : NOOP_SUBSCRIBE,
      stateSource !== undefined ? stateSource.getSnapshot : getNoSession,
    )
    const primary = primaryChange(state)
    const run = (line) => dispatch(row, line)
    const refresh = source !== undefined ? () => source.refresh() : undefined
    return h('div', { className: 'dshspec-card', 'data-dshspec-workspace': row.cwd },
      h('div', { className: 'dshspec-wsHead' },
        h('span', { className: 'dshspec-dot', style: { background: statusColor(state) } }),
        h('span', { className: 'dshspec-wsPath' }, row.cwd),
        h('span', { className: 'dshspec-space' }),
        refresh !== undefined && h('button', { type: 'button', className: 'dshspec-btn', onClick: refresh }, t('refresh')),
      ),
      state.status === 'loading' && h('div', { className: 'dshspec-note' }, t('loading')),
      state.status === 'nosession' && h('div', { className: 'dshspec-workspace' },
        h('div', { className: 'dshspec-note' }, row.sessionId === undefined ? t('nosessionHint') : t('nosession')),
        h(Actions, { t, state, run, refresh, compact: false }),
      ),
      state.status === 'error' && h('div', { className: 'dshspec-note dshspec-noteError' }, `${t('error')}: ${state.error ?? ''}`),
      state.status === 'missing' && h(MissingBody, { t, run, refresh }),
      state.status === 'ready' && h(ReadyBody, { t, state, run, refresh, primary }),
    )
  }

  function ReadyBody({ t, state, run, refresh, primary }) {
    if (state.changes.length === 0) {
      return h('div', { className: 'dshspec-note' },
        t('noChanges'),
        state.archived > 0 ? ` ${t('archived').replace('{count}', String(state.archived))}` : '',
      )
    }
    return h('div', { className: 'dshspec-workspace' },
      state.changes.map((change) => h(ChangeRow, { key: change.name, t, change, run, refresh, primary })),
      state.archived > 0 && h('div', { className: 'dshspec-note' }, t('archived').replace('{count}', String(state.archived))),
      state.watchDown === true && h('div', { className: 'dshspec-note' }, t('watchDown')),
    )
  }

  function ChangeRow({ t, change, run, refresh, primary }) {
    const meta = PHASE_META[change.phase] ?? PHASE_META.draft
    return h('div', { className: 'dshspec-change', 'data-dshspec-change': change.name },
      h('div', { className: 'dshspec-changeHead' },
        h('span', { className: 'dshspec-changeName' }, change.name),
        h(PhaseChip, { t, phase: change.phase }),
        h(Progress, { done: change.tasks?.done ?? 0, total: change.tasks?.total ?? 0, color: meta.color }),
      ),
      h('div', { className: 'dshspec-row' },
        change.files.map((file) => h('span', { key: file, className: 'dshspec-fileChip' }, file)),
      ),
      h(Actions, { t, state: { status: 'ready', changes: [change] }, run, refresh, primary, change, compact: false }),
    )
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
      if (primary === undefined) return 'var(--dsw-alias-state-idle-primary)'
      return (PHASE_META[primary.phase] ?? PHASE_META.draft).color
    }
    if (state.status === 'missing') return 'var(--dsw-alias-state-warn-primary)'
    return 'var(--dsw-alias-state-idle-primary)'
  }

  /** Shared phase action block: a buttons row, an inline expand row (propose input or change picker), and the result line. */
  function Actions({ t, state, run, refresh, primary, change, compact }) {
    const [mode, setMode] = useState('none') // none | propose | pick
    const [draft, setDraft] = useState('')
    const [result, setResult] = useState(null)
    const resultTimer = useRef(null)

    useEffect(() => () => {
      if (resultTimer.current !== null) clearTimeout(resultTimer.current)
    }, [])

    const report = (outcome) => {
      setResult(outcome)
      if (resultTimer.current !== null) clearTimeout(resultTimer.current)
      resultTimer.current = setTimeout(() => setResult(null), RESULT_MS)
    }

    const runLine = async (line) => {
      const outcome = await run(line)
      report(outcome)
      setMode('none')
      if (typeof refresh === 'function') void refresh()
    }

    const changes = state.status === 'ready' ? state.changes : []
    const target = change ?? primary
    const multiple = changes.length > 1

    const submitPropose = () => {
      if (draft.trim() === '') return
      const line = `/opsx-propose ${draft.trim()}`
      setDraft('')
      void runLine(line)
    }

    const expanded = mode === 'propose'
      ? h('div', { className: 'dshspec-inline', role: 'group', 'aria-label': t('propose') },
        h('input', {
          className: 'dshspec-input',
          value: draft,
          placeholder: t('proposePlaceholder'),
          autoFocus: true,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') setMode('none')
            if (event.key === 'Enter') submitPropose()
          },
        }),
        h('button', { type: 'button', className: 'dshspec-btn dshspec-btnPrimary', disabled: draft.trim() === '', onClick: submitPropose }, t('proposeGo')),
        h('button', { type: 'button', className: 'dshspec-btn', onClick: () => setMode('none') }, t('cancel')),
      )
      : mode === 'pick'
        ? h('div', { className: 'dshspec-inline', role: 'group', 'aria-label': t('pickChange') },
          h('span', { className: 'dshspec-note' }, t('pickChange')),
          changes.map((candidate) => h('button', {
            key: candidate.name,
            type: 'button',
            className: 'dshspec-btn',
            title: `/opsx-apply ${candidate.name}`,
            onClick: () => void runLine(`/opsx-apply ${candidate.name}`),
          }, `${candidate.name} · ${t((PHASE_META[candidate.phase] ?? PHASE_META.draft).key)}`)),
          h('button', { type: 'button', className: 'dshspec-btn', onClick: () => setMode('none') }, t('cancel')),
        )
        : null

    return h('div', { className: 'dshspec-actwrap', 'data-dshspec-actions': true },
      h('div', { className: 'dshspec-actions' },
        h('button', { type: 'button', className: 'dshspec-btn', title: '/opsx-explore', onClick: () => void runLine('/opsx-explore') }, t('explore')),
        h('button', {
          type: 'button',
          className: mode === 'propose' ? 'dshspec-btn dshspec-btnPrimary' : 'dshspec-btn',
          title: '/opsx-propose',
          onClick: () => setMode((value) => (value === 'propose' ? 'none' : 'propose')),
        }, t('propose')),
        h('button', {
          type: 'button',
          className: 'dshspec-btn',
          disabled: target === undefined,
          title: '/opsx-apply',
          onClick: () => {
            if (change !== undefined) {
              void runLine(`/opsx-apply ${target.name}`)
              return
            }
            if (multiple) {
              setMode((value) => (value === 'pick' ? 'none' : 'pick'))
              return
            }
            if (target !== undefined) void runLine(`/opsx-apply ${target.name}`)
          },
        }, t('apply')),
        h('button', {
          type: 'button',
          className: 'dshspec-btn',
          disabled: target === undefined,
          title: '/opsx-archive',
          onClick: () => {
            if (target !== undefined) void runLine(`/opsx-archive ${target.name}`)
          },
        }, t('archive')),
        h('button', { type: 'button', className: 'dshspec-btn', title: '/opsx-status', onClick: () => void runLine('/opsx-status') }, t('status')),
      ),
      expanded,
      result !== null && h('div', {
        className: result.ok ? 'dshspec-note' : 'dshspec-note dshspec-noteError',
        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: compact ? 'nowrap' : 'normal' },
        title: result.text,
      }, result.ok ? result.text : `${t('commandFailed')}: ${result.text}`),
    )
  }

  /** One-click init control: the button plus its inline settled outcome. */
  function InitControl({ t, run, refresh }) {
    const [busy, setBusy] = useState(false)
    const [result, setResult] = useState(null)
    const initialize = async () => {
      setBusy(true)
      const outcome = await run('/openspec-init')
      setResult(outcome)
      if (typeof refresh === 'function') await refresh()
      setBusy(false)
    }
    return h('span', { className: 'dshspec-actions' },
      h('button', { type: 'button', className: 'dshspec-btn dshspec-btnPrimary', disabled: busy, onClick: () => void initialize() }, t('init')),
      result !== null && h('span', {
        className: result.ok ? 'dshspec-note' : 'dshspec-note dshspec-noteError',
        style: { maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: result.text,
      }, result.text),
    )
  }

  /** Missing-state body with the one-click init (panel). */
  function MissingBody({ t, run, refresh }) {
    return h('div', { className: 'dshspec-workspace' },
      h('div', { className: 'dshspec-note', style: { color: 'var(--dsw-alias-label-primary)' } }, t('missing')),
      h('div', { className: 'dshspec-note' }, t('missingHint')),
      h(InitControl, { t, run, refresh }),
    )
  }

  /** The quick bar under the composer: phase badge + one-click phase commands. */
  function QuickBar({ state: stateSource, source, openPanel, t }) {
    if (stateSource === undefined) return null
    const state = useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot)
    if (state.status === 'loading' || state.status === 'nosession') return null
    if (state.status === 'error') {
      return h('div', { className: 'dshspec-dock', 'data-dshspec-quickbar': 'error' },
        h('span', { className: 'dshspec-dot', style: { background: 'var(--dsw-alias-state-error-primary)' } }),
        h('span', { className: 'dshspec-note dshspec-noteError' }, `${t('error')}: ${state.error ?? ''}`),
        h('button', { type: 'button', className: 'dshspec-btn', onClick: () => void source.refresh() }, t('retry')),
      )
    }
    if (state.status === 'missing') {
      return h('div', { className: 'dshspec-dock', 'data-dshspec-quickbar': 'missing' },
        h('span', { className: 'dshspec-dot', style: { background: 'var(--dsw-alias-state-warn-primary)' } }),
        h('span', null, `OpenSpec · ${t('quickMissing')}`),
        h(InitControl, { t, run: (line) => source.run(line), refresh: () => source.refresh() }),
      )
    }
    const primary = primaryChange(state)
    return h('div', { className: 'dshspec-dock', 'data-dshspec-quickbar': 'ready' },
      h('span', { className: 'dshspec-dot', style: { background: statusColor(state) } }),
      primary === undefined
        ? h('span', null, `OpenSpec · ${t('quickNoChange')}`)
        : h('span', { className: 'dshspec-row', style: { gap: 6 } },
          h('span', { className: 'dshspec-dockName' }, primary.name),
          h(PhaseChip, { t, phase: primary.phase }),
          primary.tasks !== null && primary.tasks.total > 0
            ? h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${primary.tasks.done}/${primary.tasks.total}`)
            : null,
        ),
      h(Actions, { t, state, run: (line) => source.run(line), refresh: () => source.refresh(), primary, compact: true }),
      h('button', { type: 'button', className: 'dshspec-btn', onClick: openPanel, title: t('openPanel') }, t('panel')),
    )
  }

  /** Build marker for served-bundle verification. */
  const BUILD = '20261019c'

  /** The monitoring page: one card per known workspace. */
  function OpenspecPanel({ t, rowsSource, sourceFor, dispatchFor, onRefreshSessions }) {
    const rows = useSyncExternalStore(rowsSource.subscribe, rowsSource.getSnapshot)
    const [nonce, setNonce] = useState(0)
    return h('div', { className: 'dshspec-root', 'data-dshspec-panel': true, 'data-dshspec-build': BUILD },
      h('div', { className: 'dshspec-page' },
        h('div', { className: 'dshspec-head' },
          h('span', { className: 'dshspec-title' }, t('title')),
          h('span', { className: 'dshspec-sub' }, t('subtitle')),
          h('span', { className: 'dshspec-space' }),
          h('button', {
            type: 'button',
            className: 'dshspec-btn',
            onClick: () => {
              onRefreshSessions()
              setNonce((value) => value + 1)
            },
          }, t('refresh')),
        ),
        rows.length === 0
          ? h('div', { className: 'dshspec-card' }, h('div', { className: 'dshspec-note' }, t('nosession')))
          : rows.map((row) => h(WorkspaceCard, {
            key: `${row.cwd}#${nonce}`,
            t,
            row,
            source: row.sessionId !== undefined ? sourceFor(row.sessionId) : undefined,
            dispatch: dispatchFor,
          })),
      ),
    )
  }

  /** Sidebar glyph: a small phase-loop mark. */
  function PanelIcon() {
    return h('svg', {
      viewBox: '0 0 24 24',
      width: 20,
      height: 20,
      'aria-hidden': true,
      style: { display: 'block' },
    },
      h('path', {
        d: 'M 8 7 a 6.5 6.5 0 1 1 -1 7.5',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
      }),
      h('circle', { cx: 8, cy: 7, r: 2.2, fill: 'currentColor' }),
      h('rect', { x: 10, y: 12.5, width: 8, height: 1.8, rx: 0.9, fill: 'currentColor', opacity: 0.9 }),
      h('rect', { x: 10, y: 16, width: 5.5, height: 1.8, rx: 0.9, fill: 'currentColor', opacity: 0.55 }),
    )
  }

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
          const connected = await ctx.uiWorkspace.connectWorkspace(row.workspaceId)
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
          const outcome = await rawExecute(candidate, line)
          if (outcome !== undefined && outcome.ok) return normalizeOutcome(outcome, line)
          lastOutcome = outcome
        }
        return normalizeOutcome(lastOutcome, line)
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

    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => ({
        t,
        rowsSource,
        sourceFor,
        dispatchFor,
        onRefreshSessions: () => {
          for (const row of rowsSource.getSnapshot()) {
            if (row.sessionId !== undefined) void sourceFor(row.sessionId).refresh()
          }
        },
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
          openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        }
      },
    }, QuickBar))
  }

  return { inject: ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'remote.commands', 'sessions', 'workspaces', 'uiWorkspace', 'layout'], apply }
}

window.__ModuleLoader__.load({
  id: 'dsh-spec',
  factory: (require) => {
    const plugin = createOpenSpecPlugin(require)
    return { inject: plugin.inject, apply: plugin.apply }
  },
})
