# Native module contract (implementation guide for the align-native-openspec change)

Authoritative interface contract for the multi-agent implementation of
`openspec/changes/align-native-openspec/`. Follow the signatures literally; other workstreams
are written against them in parallel. Read the change artifacts first:
`../openspec/changes/align-native-openspec/{proposal.md,design.md,tasks.md,specs/**}`.

## 0. Environment and collaboration rules

- Repo: `D:\DSHarness\dsh-Spec` (ESM, Node >= 22, zero runtime dependencies).
- **Tests**: the DSH sandbox blocks child-process spawning and child-process file writes
  (`EPERM`). Run tests with `node --test --test-isolation=none "tests/*.test.mjs"` (or
  `node --test --test-isolation=none tests/<file>.test.mjs`). Do **not** write fixture files
  from test code; test pure functions with in-memory strings and injectable `io` fakes.
  A test that truly needs real disk writes must be skipped by default and reported to the Lead
  (the Lead runs escalated integration checks).
- **File edits**: only through DSH `edit`/`write` tools (shell redirection is sandbox-denied).
  Never run `git add/commit`.
- **Scope**: only write files inside your assigned scope (§1). Never edit another workstream's
  files, `lib/`, `openspec/`, `tasks.md`, `package.json`, `README.md` or this contract. If the
  contract is wrong, message the Lead instead of improvising.
- Do not touch `openspec/changes/align-native-openspec/tasks.md` — the Lead owns checkboxes.
- Plain ESM JavaScript, JSDoc on exported functions, no new dependencies.
- User-facing UI strings are Chinese; code, comments, issue messages and model-facing prompts are
  English.
- Host half (`src/host.js`, `src/commands.js`, `src/native/**`) uses `node:` builtins and relative
  imports freely. Client half (`src/client.js`) is a classic script: no top-level import/export,
  only `require('react')`; it is wrapped by `tools/build.mjs`.
- Report to the Lead via `send_message` when a workstream is done or blocked, with: files added,
  tests run + exact command + result, and any contract deviations.

## 1. File ownership

| Workstream | Files |
|---|---|
| engine (A) | `src/native/yaml.js`, `config.js`, `metadata.js`, `schema.js`, `graph.js`, `spec.js`, `tasks.js`, `validate.js`, `state.js`, `fsio.js`, `tests/native-*.test.mjs` |
| prompts (B) | `src/prompts.js`, `src/native/instruction.js`, `src/native-snapshot/**`, `tools/sync-native-snapshot.mjs`, `tests/prompts.test.mjs`, `tests/instruction.test.mjs`, `tests/snapshot.test.mjs` |
| merge (C) | `src/native/merge.js`, `src/native/archive.js`, `tests/merge.test.mjs`, `tests/archive.test.mjs` |
| panel (D) | `src/client.js`, `src/client-helpers.js`, `tests/client-helpers.test.mjs` |
| skills (E) | `src/native/skills.js`, `src/native/skills-fallback.js`, `tests/skills.test.mjs` |
| commands (F) | `src/commands.js`, `tests/commands.test.mjs` |
| lead | `src/host.js`, `src/native/init.js`, `tools/build.mjs`, `package.json`, `README.md`, `CHANGELOG.md`, `tests/host*.test.mjs`, this contract |

Shared import edges (fixed by this contract, implement exactly):
`state.js -> config/metadata/schema/graph/spec/tasks/validate/skills/fsio`;
`instruction.js -> schema/fsio`; `prompts.js -> instruction/graph/tasks`; `merge.js -> spec`;
`archive.js -> merge/metadata`; `commands.js -> state/instruction/prompts/merge/archive/init`;
`host.js -> everyone`.

## 2. Engine modules (A)

All filesystem work is plain `node:fs/promises` (the Host half may use `node:` builtins). `cwd` is
the **absolute** workspace root. All other paths are workspace-relative POSIX strings
(`openspec/changes/...`). Nothing in `src/native/**` spawns a process or touches the network.

### `fsio.js`
```js
export async function readTextOrNull(cwd, rel)        // string | null (missing/unreadable)
export async function readText(cwd, rel)             // throws when unreadable
export async function listDir(cwd, rel)              // [{name, type:'file'|'directory'|'other'}], [] when missing
export async function listTree(cwd, rel, { maxDepth = 12 } = {}) // [{rel, name, type}] flattened, tolerant
export async function pathExists(cwd, rel)           // boolean (file or directory)
export async function isFile(cwd, rel)              // boolean
export async function writeText(cwd, rel, content)   // mkdir -p parent, temp file + rename (atomic)
export async function removePath(cwd, rel)           // idempotent rm -rf, containment-checked
export async function movePath(cwd, fromRel, toRel)  // rename, falling back to copy+remove
export function joinRel(...parts)                    // posix join, no leading slash
export function normalizeRel(rel)                    // collapse . / .., reject escape
export function isInside(root, target)               // absolute-path containment (win32-safe)
export function toAbs(cwd, rel)                      // absolute host path for a workspace-relative path
```
Writes/moves/removes must reject any resolved path outside `cwd`. `listTree` never throws for a
missing root.

### `yaml.js`
```js
export function parseYaml(text)
// -> { value: any|null, warnings: string[], error: { message: string, line: number } | null }
```
Supported subset: comments, `key: value` scalars (plain/quoted single or double), block scalars
`|` and `>`, indented sequences, indented mappings, flow arrays `[a, b]` and flow maps `{a: b}`,
booleans/null/numbers, empty values. Anchors/merge keys/multi-line flow are unsupported and return
`error` with a 1-based line number. Top-level indentation errors carry line numbers. Must parse
the real `openspec/config.yaml`, `.openspec.yaml`, and upstream `schema.yaml` (instructions are
multi-line `|` block scalars).

### `config.js`
```js
export function parseProjectConfig(text, file = 'config.yaml')
export async function readProjectConfig(cwd)
// -> { found: boolean, file: 'config.yaml'|'config.yml'|null, schema: 'spec-driven',
//      context: '', rules: {}, operations: { apply?: {guidance?:string}, archive?: {guidance?:string} },
//      warnings: string[] }
```
Try `openspec/config.yaml` then `openspec/config.yml` (yaml wins when both exist). Invalid YAML →
defaults + warning (with file and line). `context` > 51200 bytes is ignored with a warning.
`schema` must be a non-empty string; `rules` is `{ [artifactId]: string[] }` (accept a string or an
array of strings; drop empty/non-string entries with a warning); `operations.*.guidance` strings.

### `metadata.js`
```js
export function parseChangeMetadata(text)   // -> { value, warnings, error|null }
export async function readChangeMetadata(cwd, changeRel)
// -> { found, metadata: {schema, created, goal, skip_specs, retire_capabilities, ...}, warnings, error|null }
export function resolveSchemaName({ changeMetadata, projectConfig, fallback = 'spec-driven' })
export function formatLocalDate(date = new Date())  // 'YYYY-MM-DD' from local time
export function serializeChangeMetadata({ schema, created, goal })  // yaml text, trailing newline
```
Known keys: `schema`, `created`, `goal`, `skip_specs`, `retire_capabilities`, `affected_areas`,
`initiative`. Unknown keys → WARNING; `x-*` keys accepted silently. `created` must match
`YYYY-MM-DD` (else error). `skip_specs`/`retire_capabilities` accept booleans only.

### `schema.js`
```js
export function globToRegExp(pattern)   // **, *, ?, {a,b}
export function matchGlob(pattern, relPath)  // boolean
export function parseSchema(text, { sourceName = 'project' } = {})
// -> { schema: { name, version, description,
//               artifacts: [{ id, generates, description, template, instruction, requires: [] }],
//               apply: { requires: [], tracks: string|null, instruction: string } }, issues }
export function loadBundledSchemas()                    // Map name -> { schema, source:'builtin', dir }
export async function loadProjectSchemas(cwd)           // { schemas: [{schema, source:'project', dir}], issues }
export function resolveSchema({ name, projectSchemas }) // { schema, source:'project'|'builtin'|null, issues }
export async function readArtifactTemplate(cwd, resolvedSchema, artifact)
// string|null; project schemas resolve `<dir>/templates/<template>`, bundled ones are read
// relative to this module via `new URL('../native-snapshot/<name>/templates/...', import.meta.url)`
```
Bundled snapshot: `src/native-snapshot/spec-driven/schema.yaml` + `templates/`. Project schemas
live at `openspec/schemas/<name>/schema.yaml` and always win. `resolveSchema` records the snapshot
upstream version (`1.14.3`) on the returned object as `schema.sourceVersion` when builtin. Graph
validation (duplicate ids, dangling requires, cycles, apply refs) lives in `graph.js`.

### `graph.js`
```js
export function validateSchemaGraph(schema)  // -> { issues, artifacts: Map<id, artifact> }
export async function computeArtifactStates(cwd, changeRel, schema, { skipSpecs = false } = {})
// -> { artifacts: [{ id, outputPath, status:'done'|'skipped'|'ready'|'blocked', missingDeps?: [] }],
//      applyRequires: [], tracks: string|null, isPlanningComplete: boolean, nextSteps: string[] }
```
Rules: `generates` may be one path or a glob; output exists (exact file, or glob matching >=1 file
under the change dir) → `done`; artifact id `specs` (or output under `specs/`) when `skipSpecs` →
`skipped` and satisfies dependents; all deps done/skipped → `ready`; else `blocked` + `missingDeps`
(dependency ids). `isPlanningComplete` = every artifact done/skipped. `nextSteps` = short English
hints, e.g. `create design (design.md)`, `run apply on tasks.md`, `archive` when complete.

### `spec.js`
```js
export function parseMainSpec(text)
// -> { title, purpose, requirements: [{ name, raw, text, scenarios: [{ name, raw }] }], issues }
export function parseDeltaSpec(text)
// -> { operations: { ADDED: [req], MODIFIED: [req], REMOVED: [req], RENAMED: [{from, to, raw}] }, issues }
export function parseRequirementBlocks(text)  // [{name, raw, text, scenarios}] + { issues }
export function countScenarios(requirementRaw) // number
```
Recognition: requirements only at `^### Requirement: (.+)$`; scenarios only at
`^#### Scenario: (.+)$`; delta sections only at `^## (ADDED|MODIFIED|REMOVED|RENAMED)
Requirements$` (case-sensitive). `raw` = exact block text including the heading line; `text` = body
between heading and first scenario, trimmed. Issue codes: wrong-level scenario heading
(`WARNING`), requirement outside a delta section (`WARNING`), REMOVED without `**Reason**`
(`WARNING`), RENAMED missing FROM/TO (`ERROR`). Keep issue shape `{ level, path?, line?, message }`
(`path` filled by callers that know it).

### `tasks.js`
```js
export function parseTasks(text)
// -> { total, done, items: [{ id: string|null, text, done, depth }], issues }
```
Native parity: bullets `-`, `*`, `+`; `[x]`/`[X]` (optionally spaced: `[ x]`, `[x ]`) = done; any
other bracket marker (`[~]`, `[-]`, `[]`) = unfinished task; an empty task text still counts; a
link bullet `- [text](url)` is **not** a task; `id` = leading `N.M` token when present; `depth`
from leading two spaces (max 3). `issues` has `{level:'WARNING', line, message}` for unusual
markers outside `[ ]`/`[x]`.

### `validate.js`
```js
export function validateChange({ changeName, schema, config, metadata, metadataResult, proposalText, deltas, tasksText })
// -> { issues: [{ level:'ERROR'|'WARNING'|'INFO', path, line?, message }], summary: { errors, warnings, infos } }
export function validateMainSpec({ path, text, parsed })
// same shape
```
`deltas` = `[{ path, text, parsed }]`. Deterministic and read-only; identical input → identical
output (sort by path then line then message). Minimum checks:
- proposal: `## Why` present and 50..1000 chars (ERROR below, WARNING above); `## What Changes`
  non-empty (ERROR); `## Capabilities` missing = WARNING. `path` = `proposal.md`.
- deltas: at least one delta unless `skip_specs` (ERROR otherwise, message says how to opt out);
  a file at `specs/spec.md` (root) = ERROR; each ADDED/MODIFIED requirement needs SHALL or MUST
  (ERROR), >=1 scenario (ERROR), body <= 500 chars (WARNING); duplicate ADDED names = ERROR;
  RENAMED FROM/TO validation. `skip_specs: true` + delta files = ERROR.
- tasks: no hard requirement; numbering gaps = WARNING.
- metadata: `metadataResult.error` → ERROR; invalid `created`/`schema` → ERROR; warnings from
  `metadataResult.warnings` → WARNING.
- main spec (`validateMainSpec`): `## Purpose` required (WARNING if <50 chars), `## Requirements`
  required (ERROR), >=1 requirement (ERROR), requirement SHALL/MUST + scenario checks.

### `state.js`
```js
export async function computeWorkspaceState(cwd, { signal, dshHome } = {})
// -> WorkspaceState JSON (§4)
export async function computeChangeState(cwd, changeName, { projectConfig } = {})
// -> one ChangeState (§4); throws when the change directory is missing
export async function validateChangeByName(cwd, changeName)
// -> { name, validation, metadata, schemaName, deltas, tasks }
export async function listMainSpecs(cwd)  // -> [SpecState]
export function limitTaskItems(items)     // -> <= 200 normalized { id, text, done, depth } rows
```
`computeWorkspaceState`: read config, project schemas, bundled schemas, list `openspec/changes/*`
(skip `archive`), compute each change (metadata, resolved schema, artifact states, tasks, docs,
delta summary, validation), read main specs under `openspec/specs/**`, list archive directories
(local-date grouping data), detect native skills via `./skills.js` `detectNativeSkills(cwd, {
dshHome })`, collect workspace `warnings`. `status`: `'missing'` when `openspec/changes` cannot be
listed (uninitialized), `'error'` on a fatal read error, else `'ready'`. Include `archivedCount`.
`ChangeState.tasks` carries `items` through `limitTaskItems` (200-row payload cap; `total` / `done`
stay complete). Never throw for one bad change; surface it with `validation` errors and
`schemaError`.

## 3. Prompt modules (B)

`src/native/instruction.js`
```js
export async function composeArtifactPrompt({ cwd, schema, artifact, config, changeName, dependsDone = [], intent = '' })
// -> { text: string, warnings: [] }
export async function readNativeInstruction(cwd, schema, artifactId) // instruction string from the schema
export const SNAPSHOT_VERSION = '1.14.3'
```
Order (native): artifact `instruction` → placeholders (output path, dependencies, change name,
intent) → `<context>…</context>` when config context is non-empty → `<rules>…</rules>` for this
artifact only → template body → dependency status → unlocks (artifact ids this one unlocks) →
phase planning boundary. `dependsDone` = ids of completed dependencies. If the effective schema
was a fallback, append one short note naming the snapshot version.

`src/prompts.js` (ESM, no I/O; data passed in):
```js
export function slugify(raw)                 // kebab-case or ''
export function firstToken(raw)
export function restAfterFirstToken(raw)
export async function buildExplorePrompt({ cwd, config, topic })       // -> string
export async function buildProposePrompt({ cwd, changeName, intent, schema, config, change })
export async function buildApplyPrompt({ cwd, changeName, schema, config, change, artifactPrompt })
export async function buildUpdatePrompt({ cwd, changeName, schema, config, change })
```
Boundaries: explore read-only; propose plan-only + stop; apply task-by-task, tick `apply.tracks`
file as it works; update planning-only, no code (point to apply); archive produces no prompt.
`buildProposePrompt` must name precisely the artifacts in the effective schema that are `ready`
(in schema order) and stop when the planning artifacts are done. `buildApplyPrompt` includes
`operations.apply.guidance` when configured; `buildUpdatePrompt` includes the update boundary and
lists existing planning artifacts.

Snapshot (B): copy from the extracted upstream repo
`C:\Users\yaoyefeng\AppData\Local\Temp\dsh-ZdfUZx\openspec-src\schemas\spec-driven`
(version `1.14.3`, commit `c794978`, Fission-AI/OpenSpec, MIT) into
`src/native-snapshot/spec-driven/{schema.yaml,templates/{proposal,spec,design,tasks}.md}` and add
`src/native-snapshot/ATTRIBUTION.md` (upstream URL, version, commit, MIT, extraction notes).
`tools/sync-native-snapshot.mjs` takes `--source <openspec-repo>` (or `OPENSPEC_SOURCE`), copies
`schema.yaml` + `templates/*`, refreshes the `ATTRIBUTION.md` version/commit markers, and exits
non-zero with a clear message when the source is missing. Snapshot freshness must be testable
without network.

## 4. WorkspaceState JSON (host route + client contract)

```js
{
  status: 'ready'|'missing'|'error', cwd, root: 'openspec', archivedCount: number,
  config: { found, file, schema, context, rules, operations, warnings: [] },
  schemas: [{ name, source: 'project'|'builtin', description, artifacts: [ids] }],
  changes: [ChangeState], specs: [SpecState],
  archived: [{ name, changeName, date, path }],
  skills: { native: [{ name, root, path, description, workflow }], fallbackActive: boolean },
  warnings: []
}
```
```js
ChangeState = {
  name, schemaName, schemaSource: 'project'|'builtin',
  metadata: { found, schema, created, goal, skip_specs, retire_capabilities },
  artifacts: [{ id, outputPath, status: 'done'|'skipped'|'ready'|'blocked', missingDeps?: [] }],
  applyRequires: [], tracks: string|null, isPlanningComplete: boolean, nextSteps: [],
  listStatus: 'no-tasks'|'in-progress'|'complete',
  tasks: { total, done, items: [{ id: string|null, text, done: boolean, depth: 0..3 }] } | null,
  docs: [{ path, label, artifactId, kind: 'artifact'|'delta' }],
  delta: { ADDED: n, MODIFIED: n, REMOVED: n, RENAMED: n, files: [paths] },
  validation: { errors, warnings, infos, issues: [{ level, path, line?, message }] },
  files: [names]
}
SpecState = { name, path, purpose, requirementCount, scenarioCount, validation: { errors, warnings, infos } }
```
`listStatus`: `no-tasks` when the change has no tasks artifact/file, `complete` when every task is
checked, else `in-progress`. `docs`: one row per artifact that exists (path from `generates`; glob
artifacts expand to matched files) plus delta spec paths.

`tasks.items` carries at most 200 tracked-task rows per change (`state.js` `TASK_ITEM_LIMIT`,
normalized by the exported `limitTaskItems`); `total` / `done` always count the whole `tasks.md`, so
`total > items.length` means the panel must surface the remaining count explicitly (never silently
drop rows). `items[].depth` is the native two-space nesting depth (0–3).

## 5. Host route, init, commands

Route `/dsh-spec` keeps the existing envelope (`{type:'client-request', rpcId, method, payload}` →
`{type:'server-response', rpcId, result:{ok, value|error}}`), POST only, `connection.admit`, 64KB
request cap. Read-only methods (Lead, `src/host.js`):

| method | payload | value |
|---|---|---|
| `state` | `{ cwd }` | WorkspaceState |
| `validate` | `{ cwd, change? }` | `{ name?, validation }` or workspace summary |
| `instructions` | `{ cwd, kind, change?, topic? }` | `{ text }` |
| `sync-preview` | `{ cwd, change }` | `{ preview: MergePlanPreview, text }` |
| `document` | `{ cwd, path, offset?, limit? }` | `{ text, truncated, totalLines }` |
| `archive-detail` | `{ cwd, path }` or `{ cwd, name }` | `{ change: ChangeState }` for one archived change (same §4 shape) |
| `init` | `{ cwd }` | `{ ok: true, text, created }` |

`cwd` must be an absolute path accepted by `ctx.workspaceRegistry.resolveByPath`; otherwise reject.
Only `init` writes. Direct command results are `{kind:'success'|'error', text}`.

`src/native/init.js` (Lead):
```js
export function serializeConfigYaml()                     // native config.yaml text (schema + comment examples, no placeholder context)
export async function ensureSkeleton(cwd)                 // { created: string[], configContent }
```
Creates only `openspec/config.yaml`, `openspec/specs/.gitkeep`,
`openspec/changes/archive/.gitkeep`; never overwrites/deletes; reports only newly created items.
No README, no `context:` placeholder.

`src/commands.js` (F):
```js
export function registerCommands(ctx)   // registers the nine commands on ctx.commands
```
Nine commands: `openspec-init`, `opsx-explore`, `opsx-propose`, `opsx-apply`, `opsx-update`,
`opsx-sync`, `opsx-archive`, `opsx-validate`, `opsx-status`. Model phases submit through
`agent.followup(userMessage(text))` (same shape as today). Direct commands return
`{kind:'success'|'error', text}` without a model message. `opsx-sync` / `opsx-archive` accept
`--yes`; without it return the preview and write nothing. All handlers catch errors into
`{kind:'error', text}`.

## 6. Client contract (D)

- Data: `ctx.connection.rpc.call('/dsh-spec', method, payload)` — returns `{ok, value|error}`.
  There is no `ctx.remote.dshSpec`. Rows come from `ctx.workspaces.list` (as today); the
  workspace absolute path is the row's `path`. Session-less workspaces use the host route only.
- Freshness: refresh on session `workspaceFiles.changes` when a session exists, otherwise poll the
  host route every 4s while the panel is open; the quick bar refreshes on session changes and
  after command execution. No hidden state — everything re-derives from the route.
- Build: `src/client.js` stays a classic script (no import/export, only `require('react')`).
  `src/client-helpers.js` is ESM (exported pure functions, no imports) and is inlined by
  `tools/build.mjs` into the `/* @@CLIENT_HELPERS@@ */` marker inside the client factory
  (build strips `export ` keywords). Tests import `client-helpers.js` directly.
- UI requirements: change cards with schema name, per-artifact chips (done/skipped/ready/blocked),
  expandable `missingDeps`, `skip_specs`, task progress and native next step; change detail from
  schema `generates` docs + `.openspec.yaml` metadata + delta operation counts + validation issues
  (path/line); project config + schema view (project vs builtin source); capability specs view
  (Purpose, requirement/scenario counts, nested grouping); archive view grouped by local date with
  on-demand artifacts/tasks/metadata; pagination/“+N more” instead of silent truncation, document
  reader truncation notice; quick bar with native next-step actions, skip_specs/blocked signal and
  native-skills indicator. Keep DSH design language, `--dsw-*` tokens, slots `main`,
  `sidebar.panellist`, `conversation.composer.dock`.
- `client-helpers.js` owns pure formatting helpers (artifact labels/order, status tone, delta
  summary text, local-date grouping, pagination slice, validation summary) with unit tests.

## 7. Merge/archive (C)

```js
// merge.js
export function planSync({ changeName, mainSpecs, deltas, retireCapabilities = false })
// mainSpecs: [{ path, text }], deltas: [{ path, text, parsed }]
// -> { ok, issues, writes: [{ path, action:'create'|'update'|'remove', content, summary }],
//      summary: { ADDED, MODIFIED, REMOVED, RENAMED } }
export function serializeMainSpec({ title, purpose, requirements })   // deterministic markdown
export function previewSyncPlan(plan)                                 // -> { text, files }
export async function applySyncPlan({ cwd, plan, io = nodeFsPromises }) // -> { written: [paths] }
// archive.js
export function planArchive({ changeName, localDate, metadata, validation, syncPlan, targetExists = false })
// -> { ok, issues, archiveRel: `openspec/changes/archive/YYYY-MM-DD-<name>`, write, move }
export function previewArchive(plan)                       // -> { text, target }
export async function executeArchive({ cwd, plan, io = nodeFsPromises }) // -> { moved, target }
```
`io` defaults to `node:fs/promises` but every fs method used must come from the injected object so
tests can pass an in-memory fake (e.g. `{ readFile, writeFile, rename, mkdir, rm, readdir, stat,
copyFile }`). Apply semantics per design D6: ADDED appends, MODIFIED whole-block replace, REMOVED
deletes, RENAMED retitles; untouched bytes preserved; new capability gets `# <Title>
Specification`, `## Purpose` (delta purpose or native TBD placeholder
`TBD - created by archiving change <name>. Update Purpose after archive.`) and `## Requirements`.
Unsafe merges are ERROR issues and nothing is written. Write safety: build all content in memory,
then write temp file + rename per file; on failure restore previously written originals from the
in-memory backups and remove temp files. Archive: refuse an existing target directory, retain
`.openspec.yaml`, honor `skip_specs`, move the change tree under
`openspec/changes/archive/YYYY-MM-DD-<name>/`, remove a main spec only when
`retire_capabilities: true` and its last requirement was REMOVED.

## 8. Skills (E)

Host service contract (verified against this DSH build):
```ts
ctx.get('skills')?.registerProvider((control: { signal, invalidate }) => SkillProvider)
SkillProvider = {
  name: string,
  list(options: { cwd?: string, signal?: AbortSignal }): Promise<readonly SkillCandidate[] | { candidates, complete: boolean }>,
  get(candidate: SkillCandidate, options): Promise<SkillDefinition | undefined>,
}
SkillCandidate = { name, description, invocation: { modelInvocable, userInvocable }, source, provider, rank, locator, path?, whenToUse?, metadata?, resourceBase? }
SkillDefinition = SkillCandidate & { content: string }
```
Project `.dsh/skills` and `.agents/skills` entries outrank runtime providers automatically, so the
fallback provider returns [] whenever a native `openspec-*` skill exists for that cwd.
```js
export const FALLBACK_WORKFLOWS = ['explore','propose','apply','update','sync','archive']
export async function detectNativeSkills(cwd, { signal, dshHome, agentsHome } = {})
// -> { skills: [{ name, root, path, description, workflow }], rootsScanned: [], warnings: [] }
export function createFallbackProvider(detect)   // { name: 'openspec-native-fallback', list, get }
export const FALLBACK_SKILLS = [...]             // name, description, whenToUse, content, metadata
```
Roots: `<cwd>/.dsh/skills`, `<cwd>/.agents/skills`, `<dshHome>/skills` (default env `DSH_HOME` or
`~/.dsh`), `<agentsHome>/skills` (default `~/.agents`). Only `openspec-*` entries; directory bundle
`<name>/SKILL.md` or flat `<name>.md`; parse YAML frontmatter (`name`, `description`,
`when-to-use`); malformed entries → warning + skip. Fallback names: `openspec-explore`,
`openspec-propose`, `openspec-apply-change`, `openspec-update-change`, `openspec-sync-specs`,
`openspec-archive-change`. Bodies are file-based (read `openspec/…` files, use `/opsx-*` DSH
commands), contain no `openspec` CLI invocation, and frontmatter metadata records
`adaptedFrom: 'Fission-AI/OpenSpec'`, `upstreamVersion: '1.14.3'`, MIT. `list({cwd})` returns []
when any native `openspec-*` skill was detected in that cwd; `get` returns the stored definition.

## 9. Definition of done / reporting

- Your modules export exactly these signatures; your unit tests pass with
  `node --test --test-isolation=none "tests/*.test.mjs"` (run your own files too); no writes
  outside your scope; no new dependencies; JSDoc on exports.
- Report to the Lead: task ids from `openspec/changes/bundle-native-opsx-skills/tasks.md` completed,
  files added/changed, exact test command + pass/fail counts, deviations from this contract, and
  anything the Lead must wire (host/route/build) or verify.
- The Lead owns `tasks.md` checkboxes, `lib/` builds, final spec review and the DSH web smoke test.

## 10. Phase 2 — bundled OPSX workflow skills and AI sync/archive

The change `openspec/changes/bundle-native-opsx-skills/` supersedes §8's simplified six-skill
fallback. It vendors all 12 upstream OPSX skills (MIT) and makes `/opsx-sync` / `/opsx-archive`
default to OPSX-style AI workflows. Read that change's proposal/design/specs/tasks first.

### 10.1 Vendored snapshot (workstream G)

Vendor the 12 upstream `skills/<name>/SKILL.md` files verbatim (LF-normalized) from the extracted
OpenSpec 1.14.3 tree (`C:\Users\yaoyefeng\AppData\Local\Temp\dsh-ZdfUZx\openspec-src\skills`) into:

```
src/native-snapshot/skills/<name>/SKILL.md   # 12 skills, exact names below
src/native-snapshot/ATTRIBUTION.md           # extend with a "Vendored workflow skills" section
```

Names: `openspec-explore`, `openspec-propose`, `openspec-apply-change`, `openspec-update-change`,
`openspec-sync-specs`, `openspec-archive-change`, `openspec-new-change`, `openspec-continue-change`,
`openspec-ff-change`, `openspec-verify-change`, `openspec-bulk-archive-change`, `openspec-onboard`.
Extend `tools/sync-native-snapshot.mjs` so its planner also covers these 12 files and refreshes the
attribution version/commit markers (the script already handles schema+templates; keep its pure
`planSnapshot`-style testability and missing-source failure).

### 10.2 Adaptation module (`src/native/skill-adaptation.js`, workstream G)

```js
export const VENDORED_SKILLS = [ ...12 names in upstream order... ]
export const UPSTREAM_VERSION = '1.14.3'
export const UPSTREAM_COMMIT = 'c794978f4f8845ce59693373c9dd882ee776588c'
export const ADAPTATION_MARKER = '## DSH adaptation'   // exact heading of the injected section
export function adaptationSection()                    // fixed markdown mapping table (see below)
export function parseSkillFrontmatter(text)            // { data, body, warnings } tolerant parser
export function adaptSkillContent(name, rawText)       // -> { name, description, content, metadata }
export async function loadVendoredSkill(name)          // reads snapshot via new URL('../native-snapshot/skills/<name>/SKILL.md', import.meta.url)
export async function loadAdaptedSkill(name)           // loadVendoredSkill + adaptSkillContent
```

`adaptSkillContent` keeps the upstream body verbatim, rewrites frontmatter to add
`license: MIT`, `metadata: { vendoredFrom: 'Fission-AI/OpenSpec', upstreamVersion, upstreamCommit,
license: 'MIT', adaptedFor: 'dsh-spec' }`, replaces `allowed-tools` / `compatibility` with the DSH
file-semantics equivalents, and inserts `ADAPTATION_MARKER` + `adaptationSection()` between the
frontmatter and the upstream body. `adaptationSection()` is English markdown and maps at least:

| upstream command | DSH file-semantics action |
|---|---|
| `openspec status/list --json` | read `.openspec.yaml` + `openspec/changes/**` files, or `/opsx-status` |
| `openspec validate` | `/opsx-validate` |
| `openspec instructions <artifact>` | read `openspec/changes/<name>/<artifact>` + project `config.yaml` (+ bundled schema instructions) |
| `openspec show` | read the spec/change file directly |
| `openspec archive <name> [--yes]` | `/opsx-archive <name> --yes` (deterministic) or `--yes --skip-specs` after an AI merge |
| `openspec new change <name>` | `/opsx-propose <name>` or create `openspec/changes/<name>/.openspec.yaml` by hand |
| `openspec sync specs` | no CLI: edit `openspec/specs/**/spec.md` directly per the sync contract, or `/opsx-sync --yes` |
| `openspec update` | `/opsx-update` |
| `openspec instructions archive` | project `config.yaml` `context` + `operations.archive.guidance` |

It must also state: the `openspec` CLI is not installed in DSH, store/workspace/initiative features
are unavailable (treat everything as the current workspace), and a command's JSON fields should be
derived from reading workspace files instead. No network, no subprocess.

### 10.3 Fallback provider (`src/native/skills.js`, workstream G)

`createFallbackProvider(detect)` lists the 12 adapted vendored skills as candidates when no native
`openspec-*` skill exists for the cwd; `get()` loads `loadAdaptedSkill(name)` and returns
`{ ...candidate, description, content }`. Native detection / suppression / non-mutation rules are
unchanged from §8. `FALLBACK_WORKFLOWS` becomes the 12 upstream workflow suffixes; keep
`workflowForSkillName` (extend it to new/continue/ff/verify/bulk-archive/onboard). `skills.js` may
read snapshot files with `node:fs/promises`; it must tolerate a missing snapshot directory (warn,
return no candidates) and never write.

### 10.4 AI workflow prompts (`src/prompts.js`, workstream H)

```js
export async function buildSyncWorkflowPrompt({ cwd, changeName, schema, config, change, facts })
export async function buildArchiveWorkflowPrompt({ cwd, changeName, schema, config, change, facts })
```
`facts` is prepared by the caller (commands/host) and has shape:
```js
{
  validation: { errors, warnings, infos, issues },
  artifacts: [{ id, status }],
  tasks: { total, done, pending: [text] } | null,
  deltas: [{ path, capability, added, modified, removed, renamed }],
  mainSpecs: [{ path, exists, requirementCount }],
  isPlanningComplete: boolean,
  archiveTarget: string|null,
}
```
Each prompt = adapted vendored skill body (`loadAdaptedSkill('openspec-sync-specs')` /
`'openspec-archive-change'`) + a `Current facts` markdown block + project context/rules and
`operations.sync|archive.guidance` when configured + explicit finish contract:
- sync: before any edit stop when `validation.errors > 0`; perform the OPSX intelligent merge by
  editing `openspec/specs/**/spec.md`; verify title/Purpose/no delta headers/requirement+scenario
  structure/ADDED-MODIFIED-REMOVED-RENAMED results; then `/opsx-validate`.
- archive: confirm artifact/task state with the user first; stop on validation errors; either
  intelligent-merge then `/opsx-archive <name> --yes --skip-specs`, or skip sync and use
  `/opsx-archive <name> --yes --skip-specs` (specs untouched); validate before finalizing.
`prompts.js` stays I/O-free except reading the vendored skill text via the adaptation module.

### 10.5 Commands (`src/commands.js`, workstream H)

Flag parsing: `--yes`, `--dry-run`, `--skip-specs` (archive only), tokens stripped before change
name parsing. Behaviour:
- `/opsx-sync [name]` default: compose `buildSyncWorkflowPrompt`, `agent.followup`, return
  `{kind:'success', text}`; no writes.
- `/opsx-sync [name] --yes`: current deterministic merge / apply path; no model message.
- `/opsx-sync [name] --dry-run`: current preview-only path; no writes; no model message.
- `/opsx-archive [name]` default: compose `buildArchiveWorkflowPrompt`, followup, no writes.
- `/opsx-archive [name] --yes`: deterministic plan+execute; incomplete tasks → WARNING text and
  continue (upstream CLI parity), validation ERROR still refuses; no model message.
- `/opsx-archive [name] --yes --skip-specs`: plan with `metadata: { ...metadata, skip_specs: true }`
  and `syncPlan: null`, execute move only.
- `/opsx-archive [name] --dry-run`: preview only.
- Change selection / validation gate / target-exists refusal logic is shared with the current code.

### 10.6 Host + panel (Lead)

`/dsh-spec` `instructions` supports `kind: 'sync' | 'archive'` (compose the same prompts from
engine-derived facts, read-only). Panel/quick-bar copy is updated to explain "default = OPSX AI
workflow, `--yes` = deterministic fast path, `--dry-run` = preview"; no client logic changes.

### 10.7 Ownership and tests

| Workstream | Files |
|---|---|
| G (vendor+adaptation+provider) | `src/native-snapshot/skills/**`, `src/native-snapshot/ATTRIBUTION.md`, `tools/sync-native-snapshot.mjs`, `src/native/skill-adaptation.js`, `src/native/skills.js`, `tests/skills.test.mjs`, `tests/snapshot.test.mjs` |
| H (prompts+commands) | `src/prompts.js`, `src/commands.js`, `tests/prompts.test.mjs`, `tests/commands.test.mjs` |
| Lead | `src/host.js`, `src/client.js` copy, `tests/host.test.mjs`, README/CHANGELOG/package.json, build, web smoke, `tasks.md` |

Tests must not write real files. Workstream H may stub `loadAdaptedSkill` for prompt tests but must
also run against G's real module once it lands. Report per §9.
