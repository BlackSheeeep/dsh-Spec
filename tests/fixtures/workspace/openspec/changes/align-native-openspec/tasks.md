# Tasks

## 1. Native data engine (host, pure JS)

- [x] 1.1 Implement `src/native/yaml.js`: a YAML subset parser (comments, scalars, block scalars `|`/`>`, indented sequences and mappings, flow collections, quoted strings) with path/line-aware errors and unit tests
- [x] 1.2 Implement `src/native/config.js`: read `openspec/config.yaml` with `config.yml` fallback, parse `schema`/`context`/`rules`/`operations`, warn-and-degrade on invalid fields, ignore context over 50KB
- [x] 1.3 Implement `src/native/metadata.js`: read `.openspec.yaml`, resolve schema precedence (change > project > default), expose `created`/`goal`/`skip_specs`/`retire_capabilities`, warn on unknown keys, accept `x-` keys
- [x] 1.4 Implement `src/native/schema.js`: resolve schemas from `openspec/schemas/<name>/schema.yaml` before the bundled snapshot, expose artifact definitions and apply contract with source metadata
- [x] 1.5 Validate schema graphs: duplicate artifact ids, dangling `requires`, dependency cycles, missing `apply.requires`/`apply.tracks` targets, with per-artifact issues
- [x] 1.6 Implement artifact state detection: match `generates` paths including globs, derive `done`/`skipped`/`ready`/`blocked`, report `missingDeps`
- [x] 1.7 Derive change-level state: `no-tasks`/`in-progress`/`complete`, `applyRequires`, `nextSteps` and task progress; remove all dependence on legacy draft/proposed/apply/ready as truth
- [x] 1.8 Implement main spec parsing: `## Purpose`, requirement blocks, scenario counts, nested capability paths, missing-section issues
- [x] 1.9 Implement delta spec parsing: ADDED/MODIFIED/REMOVED/RENAMED operations, `### Requirement:` and `#### Scenario:` recognition, wrong heading level, stray `specs/spec.md`, missing scenarios
- [x] 1.10 Align tasks parsing with native rules: `-`/`*`/`+` bullets, any non-`x` marker incomplete, empty checkboxes counted, link bullets ignored, task ids preserved
- [x] 1.11 Implement `src/native/validate.js`: deterministic issue model with ERROR/WARNING/INFO, native checks for Why length, What Changes, deltas, scenarios, SHALL/MUST, `skip_specs` conflict, metadata and required spec sections
- [x] 1.12 Add guard tests asserting the engine never spawns subprocesses or uses network for parsing/state/validation (injected stubs)
- [x] 1.13 Add native-fixture tests: run the engine against upstream-like `openspec/` trees and assert artifact states, tasks counts and validation findings remain stable

## 2. Native prompt composition

- [x] 2.1 Add `src/native-snapshot/spec-driven/` with the pinned schema instructions and four templates plus `ATTRIBUTION.md` (upstream repo, version, commit, MIT, extraction notes)
- [x] 2.2 Add `tools/sync-native-snapshot.mjs` and a test that checks snapshot structure and the recorded version marker
- [x] 2.3 Implement `src/native/instruction.js`: compose instruction, project context, artifact rules, template, dependency status, resolved paths and unlocks in native order
- [x] 2.4 Rewrite phase prompt builders (`src/prompts.js`) for explore/propose/apply/update with native boundaries: read-only explore, plan-only propose, planning-only update, tasks tracking for apply
- [x] 2.5 Inject context/rules/`operations.apply.guidance` into prompts, exclude create instructions for `skipped`/blocked artifacts, and document the composition order
- [x] 2.6 Add prompt composition tests: project schema precedence, snapshot fallback with note, rules filtering, context inclusion and phase boundary wording

## 3. Command surface

- [x] 3.1 Register/update the command family: add `opsx-update`, `opsx-sync`, `opsx-validate`, keep `opsx-explore`/`opsx-propose`/`opsx-apply`/`opsx-archive`/`opsx-status`/`openspec-init`, and document native `opsx:*` mapping in descriptions
- [x] 3.2 Implement native propose scaffolding: slug validation, initialize when missing, refuse existing change, write `.openspec.yaml` with effective schema and local `created` before submitting the prompt
- [x] 3.3 Implement `/opsx-update` handler: target existing change, compose the native update instruction, keep the model on planning artifacts only
- [x] 3.4 Extract change-selection logic: explicit name, single active change auto-select, multiple changes list candidates, unknown name lists actives
- [x] 3.5 Make `opsx-status`/`opsx-validate`/`openspec-init` direct outputs from the native engine, with idempotent init reporting only newly created items
- [x] 3.6 Wire `/opsx-sync` and `/opsx-archive` to the deterministic engine: preview, confirmation, ERROR refusal, incomplete-task refusal
- [x] 3.7 Add command handler tests with fake invocations covering success text, error branches, no model message for direct commands and change-selection cases

## 4. Deterministic sync and archive

- [x] 4.1 Implement main-spec requirement-block parsing, normalization and serialization that preserves untouched text byte-for-byte
- [x] 4.2 Implement delta application: ADDED append, MODIFIED whole-block replace, REMOVED delete, RENAMED retitle, with unsafe-merge errors
- [x] 4.3 Handle new capability creation with Purpose (including the native TBD placeholder) and `retire_capabilities` last-requirement removal
- [x] 4.4 Integrate the validation gate: abort on ERROR, surface WARNINGs in the result
- [x] 4.5 Build the dry-run preview model listing affected main specs, per-requirement operations and the archive target
- [x] 4.6 Implement confirmed apply and cancel semantics so preview never writes and cancel leaves files unchanged
- [x] 4.7 Implement archive move: local `YYYY-MM-DD-<name>`, refuse existing target, retain `.openspec.yaml`, honor `skip_specs`
- [x] 4.8 Implement write safety: workspace containment, path-traversal rejection, temp-file + rename writes, cleanup and rollback on failure
- [x] 4.9 Add merge tests using native fixtures, failure-injection tests proving files are unchanged on error, and idempotence/determinism checks

## 5. Panel and quick bar

- [x] 5.1 Extend the Host `/dsh-spec` route with read-only methods `state`, `validate`, `instructions` and `sync-preview`, validated through `workspaceRegistry.resolveByPath`, reusing `connection.admit` and the request size cap
- [x] 5.2 Replace the browser data layer: consume host-derived native state, refresh on session file watch and fall back to polling for session-less workspaces
- [x] 5.3 Rebuild change cards: schema name, per-artifact status chips, expandable `missingDeps`, `skip_specs` signal, task progress and native next step
- [x] 5.4 Rebuild change detail: documents from schema `generates` paths, `.openspec.yaml` metadata, delta operation counts, validation issues with paths/lines
- [x] 5.5 Add project configuration and schema view: effective schema, context summary, per-artifact rules, project-local vs built-in schema sources
- [x] 5.6 Add capability specs view: Purpose, requirement and scenario counts, validation issues, nested capability grouping
- [x] 5.7 Add archive view: local-date grouping and on-demand artifacts, tasks and metadata
- [x] 5.8 Remove silent truncation: paginate or flag change/spec lists, show document truncation with a follow-up read affordance
- [x] 5.9 Align the panel init action with the native scaffold (schema-only config, `specs/` and `changes/archive/` anchors, no README or placeholder context, preserve existing files)
- [x] 5.10 Update the composer quick bar: native next-step actions, `skip_specs`/blocked indication and detected-native-skills indicator
- [x] 5.11 Add tests for extracted pure client helpers (state formatting, artifact labels, pagination) runnable with `node --test`

## 6. Native skills coexistence

- [x] 6.1 Implement `src/native/skills.js`: detect `openspec-*` skills under project `.dsh/skills`, project `.agents/skills` and the user skills root, parse frontmatter, warn-and-skip malformed entries
- [x] 6.2 Surface detected native skills and their workflow coverage in the panel and quick bar, refreshing when files change
- [x] 6.3 Register a workspace-aware fallback skill provider when `ctx.skills` is available and only return the six core candidates when no native skill of the same name exists in that workspace
- [x] 6.4 Author fallback skill bodies and frontmatter: file-based semantics without CLI calls, adapted-from attribution and pinned upstream version
- [x] 6.5 Add coexistence tests: native arrival suppresses fallback, native files are never mutated, and a composition without `ctx.skills` skips registration without error

## 7. Verification and documentation

- [x] 7.1 Update README: native `opsx:*` mapping, targeted native version, snapshot attribution, zero-CLI stance, initialization behavior and expanded-command status
- [x] 7.2 Bump the plugin version and build config: copy `src/native` and `src/native-snapshot` into `lib/`, update `package.json` files/version
- [x] 7.3 Run the full test suite and `node tools/build.mjs`, and verify the emitted host/client modules load
- [x] 7.4 Validate this change against the native validation checklist (1.14 parity) and fix plan-level issues found before implementation
- [x] 7.5 Manual smoke test in DSH: panel with and without a session, all core commands, sync/archive preview and confirmation, fallback skills when native skills are absent
- [x] 7.6 Record the snapshot version and behavior changes in CHANGELOG/README and note any native rules intentionally left out of the validation subset
