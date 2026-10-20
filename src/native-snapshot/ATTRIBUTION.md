# Native OpenSpec snapshot attribution

This directory vendors a pinned subset of the upstream OpenSpec project so that
dsh-spec can compose native artifact instructions and templates without calling
the `openspec` CLI and without a network connection.

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

## Refresh instructions

The snapshot is refreshed by a dev-time script (never at runtime, never by the
plugin host):

```bash
node tools/sync-native-snapshot.mjs --source <path-to-openspec-repo>
# or
OPENSPEC_SOURCE=<path-to-openspec-repo> node tools/sync-native-snapshot.mjs
```

The script reads `<openspec-repo>/schemas/spec-driven/schema.yaml` plus every
file under `<openspec-repo>/schemas/spec-driven/templates/`, copies them here,
and refreshes the `Upstream version:` and `Upstream commit:` lines above. The
version is read from the upstream `package.json`; the commit from the upstream
git checkout (`.git/HEAD`), falling back to the existing marker when neither is
available. Run the snapshot tests afterward:

```bash
node --test --test-isolation=none tests/snapshot.test.mjs
```

Keep the `Upstream version:` and `Upstream commit:` marker lines intact and
machine-readable — the refresh script updates them in place.

## License

OpenSpec is licensed under the MIT License. The vendored schema and templates
are reproduced under that license:

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
