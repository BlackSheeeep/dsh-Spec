/**
 * OpenSpec workflow prompt templates (Host half).
 *
 * The wording follows the OpenSpec documented loop
 * (explore → propose → review → apply → archive, openspec.dev/docs/quickstart):
 * progress lives only in `openspec/changes/<name>/tasks.md` checkboxes, and
 * each phase has hard boundaries — explore never writes, propose never codes,
 * apply checks tasks off as they land, archive syncs delta specs into
 * `openspec/specs/` and moves the folder into `openspec/changes/archive/`.
 *
 * Templates are model-facing English; the direct command result text the user
 * sees lives in the command handlers (zh).
 *
 * @module dsh-spec/prompts
 */

/** Kebab-case change name: what OpenSpec itself uses for folder names. */
export const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/

/** Turn free text into a safe OpenSpec change folder name, or '' when impossible. */
export function slugify(raw) {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return CHANGE_NAME.test(slug) ? slug : ''
}

/** First whitespace token of a raw command input. */
export function firstToken(raw) {
  const text = String(raw ?? '').trim()
  const index = text.search(/\s/)
  return index === -1 ? text : text.slice(0, index)
}

/**
 * Count OpenSpec task checkboxes in a tasks.md text: `- [ ]` open, `- [x]` done.
 * This is the workflow's only progress state — there is nothing else to read.
 */
export function parseTasks(text) {
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

/** Derive one change's workflow phase from its files and parsed tasks. */
export function derivePhase({ hasProposal, hasSpecs, tasks }) {
  if (tasks !== null && tasks.total > 0) return tasks.done < tasks.total ? 'apply' : 'ready'
  if (hasProposal || hasSpecs) return 'proposed'
  return 'draft'
}

/** Everything after the first whitespace token, trimmed. */
export function restAfterFirstToken(raw) {
  const text = String(raw ?? '').trim()
  const index = text.search(/\s/)
  return index === -1 ? '' : text.slice(index + 1).trim()
}

/** Explore: thinking mode. Never writes code or files. */
export function explorePrompt(topic) {
  const focus = topic ? `Topic: ${topic}` : 'Topic: help me choose what to work on next'
  return [
    '/opsx explore — OpenSpec exploration mode',
    '',
    focus,
    '',
    'You are in OpenSpec exploration mode. This is thinking work, not building work.',
    '- Investigate the relevant code in this workspace before forming opinions.',
    '- Ask the questions that matter, sketch options, and challenge my assumptions.',
    '- Compare the realistic options with concrete trade-offs and end with a recommendation.',
    '- Do NOT write or modify any code, and do NOT create or change any files.',
    '- Only summarize in chat; if a decision settles, offer to capture it in the next proposal.',
    '',
    'When the idea feels sharp, suggest running: /opsx-propose <kebab-change-name>',
  ].join('\n')
}

/** Propose: create the change folder and plan. Stops at the plan. */
export function proposePrompt(name, intent) {
  const why = intent ? `Intent: ${intent}` : 'Intent: carry the context from our discussion.'
  return [
    `/opsx propose — create the OpenSpec change plan for "${name}"`,
    '',
    why,
    '',
    `Create a new OpenSpec change folder \`openspec/changes/${name}/\`. This step produces the plan only — do not write any product code yet.`,
    '',
    '1. Read `openspec/config.yaml` for project context, then investigate the relevant code in this workspace.',
    '2. Write `proposal.md`: why we are doing this and what changes, kept at the right size.',
    '3. Write delta specs under `specs/<capability>/spec.md`: use `## ADDED Requirements` (or `## MODIFIED Requirements` / `## REMOVED Requirements` when changing existing behavior); every requirement needs at least one `#### Scenario:` block with WHEN/THEN bullets.',
    '4. Write `tasks.md`: an implementation checklist grouped into numbered phases, one `- [ ] N.M task` checkbox per task, covering the specs and nothing more.',
    '5. Write `design.md` only when the change needs real technical decisions.',
    '',
    'Then STOP and summarize in chat: the proposal in one paragraph, the capabilities and requirement counts, the task count per phase, and what you want me to review. Wait for my review before any implementation.',
  ].join('\n')
}

/** Apply: implement the change task by task, ticking tasks.md. */
export function applyPrompt(name, progress) {
  const state = progress
    ? `Current progress: ${progress.done}/${progress.total} tasks checked. Resume at the first unchecked task — do not redo completed work.`
    : 'Current progress: tasks.md has no checkboxes yet — start from the first task.'
  return [
    `/opsx apply — implement the OpenSpec change "${name}"`,
    '',
    '1. Read `openspec/changes/' + name + '/` in full first: proposal.md, specs/, design.md (when present), and tasks.md.',
    '2. Work through `tasks.md` in order, starting at the first unchecked `- [ ]` task.',
    '3. Implement each task in this workspace. After a task is done, mark its checkbox `- [x]` in tasks.md before moving to the next one.',
    '4. Keep changes minimal and aligned with the specs. If the plan turns out to be wrong, stop and tell me what to fix in the artifacts instead of improvising.',
    '5. When every box is checked, do a final review pass against the specs and report: what shipped, files changed, and how to verify it.',
    '',
    state,
  ].join('\n')
}

/** Archive: sync delta specs into openspec/specs/ and move the folder. */
export function archivePrompt(name) {
  return [
    `/opsx archive — archive the completed OpenSpec change "${name}"`,
    '',
    '1. Confirm every checkbox in `openspec/changes/' + name + '/tasks.md` is `- [x]`. If any remain unchecked, STOP and report them instead of archiving.',
    '2. Sync the change\'s delta specs into `openspec/specs/`: apply its ADDED / MODIFIED / REMOVED requirements so the main specs describe current behavior.',
    '3. Move the whole change folder to `openspec/changes/archive/<YYYY-MM-DD>-' + name + '/` (today\'s date).',
    '4. Report in chat: what was archived and which spec files were created or updated.',
  ].join('\n')
}
