# Native OpenSpec snapshot attribution

This directory vendors a pinned subset of the upstream OpenSpec project so that
dsh-spec can compose native artifact instructions, templates and the OPSX
workflow fallback skills without calling the `openspec` CLI and without a
network connection.

This snapshot is a **fallback only**: a project schema at
`openspec/schemas/<name>/schema.yaml` always wins over the bundled copy. See
`docs/native-module-contract.md` and the `native-workflow-prompts` capability.

## Pinned upstream revision

- Upstream repository: https://github.com/Fission-AI/OpenSpec
- Upstream version: 1.14.3
- Upstream commit: c794978f4f8845ce59693373c9dd882ee776588c
- Upstream release tag: v1.14.3 (commit subject: "Version Packages (#2112)")
- Extracted at: 2026-10-17
- License: MIT (full license text below)

## Extracted files

Copied verbatim from `schemas/spec-driven/` in the upstream repository (file
bytes preserved except for line endings, normalized to LF so the snapshot is
deterministic across platforms):

- `spec-driven/schema.yaml`
- `spec-driven/templates/proposal.md`
- `spec-driven/templates/spec.md`
- `spec-driven/templates/design.md`
- `spec-driven/templates/tasks.md`

`src/native/instruction.js` composes prompts in the native order: artifact
instruction, resolved placeholders (output path, dependencies, change name,
intent), `<context>`, artifact `<rules>`, template body, dependency status,
unlocks, and the phase boundary. The snapshot version is exported as
`SNAPSHOT_VERSION` from that module and is `1.14.3`.

## Vendored workflow skills

The same pinned upstream revision provides twelve agent workflow skills. They are
vendored verbatim from `skills/<name>/SKILL.md` in the upstream repository (file
bytes preserved, line endings normalized to LF) into
`src/native-snapshot/skills/<name>/SKILL.md`:

- `openspec-explore`
- `openspec-propose`
- `openspec-apply-change`
- `openspec-update-change`
- `openspec-sync-specs`
- `openspec-archive-change`
- `openspec-new-change`
- `openspec-continue-change`
- `openspec-ff-change`
- `openspec-verify-change`
- `openspec-bulk-archive-change`
- `openspec-onboard`

Upstream location and pinned revision:

- Upstream skills directory: `skills/` (the committed skills.sh distribution,
  generated upstream from `src/core/templates/workflows/*.ts`)
- Upstream repository: https://github.com/Fission-AI/OpenSpec
- Upstream version: 1.14.3
- Upstream commit: c794978f4f8845ce59693373c9dd882ee776588c
- License: MIT (it is the same MIT grant reproduced below)

The upstream files are generated, so do not edit the vendored copies by hand.
The extraction/refresh path is `tools/sync-native-snapshot.mjs`: with
`--source <OpenSpec repo>` it copies `schemas/spec-driven/**` plus the twelve
`skills/<name>/SKILL.md` files into this directory and refreshes every
`Upstream version:` and `Upstream commit:` marker in this file.

At runtime `src/native/skill-adaptation.js` reads the vendored files and rewrites
only their frontmatter: `license: MIT`, `allowed-tools` and `compatibility`
become the DSH file-semantics equivalents (file tools only, no CLI), and
`metadata` records `vendoredFrom: Fission-AI/OpenSpec`,
`upstreamVersion: 1.14.3`, `upstreamCommit: c794978…`, `license: MIT` and
`adaptedFor: dsh-spec`. A fixed `## DSH adaptation` section is inserted between
the frontmatter and the upstream body, mapping each `openspec …` command used by
the workflow to reading/editing workspace files or to the matching `/opsx-*`
DSH command; the CLI is not installed. The upstream body after that section is
kept byte-for-byte verbatim. The adapted skills are served as the fallback skill
catalog only while no native `openspec-*` skill exists in the workspace, and the
plugin never writes, moves or deletes user skill files.

## Refresh instructions

The snapshot is refreshed by a dev-time script (never at runtime, never by the
plugin host):

```bash
node tools/sync-native-snapshot.mjs --source <path-to-openspec-repo>
# or
OPENSPEC_SOURCE=<path-to-openspec-repo> node tools/sync-native-snapshot.mjs
```

The script reads `<openspec-repo>/schemas/spec-driven/schema.yaml`, every file
under `<openspec-repo>/schemas/spec-driven/templates/`, and all twelve
`<openspec-repo>/skills/<name>/SKILL.md` workflow files, copies them here
(normalizing line endings to LF), and refreshes every `Upstream version:` and
`Upstream commit:` marker in this file. The version is read from the upstream
`package.json`; the commit from the upstream git checkout (`.git/HEAD`),
falling back to the existing markers when neither is available. Run the snapshot
tests afterward:

```bash
node --test --test-isolation=none tests/snapshot.test.mjs
```

Keep the `Upstream version:` and `Upstream commit:` marker lines intact and
machine-readable — the refresh script updates them in place.

## License

OpenSpec is licensed under the MIT License. The vendored schema, templates and
workflow skills are reproduced under that license:

```text
MIT License

Copyright (c) 2024 OpenSpec Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
