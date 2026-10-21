/**
 * Build dsh-spec.
 *
 * Host half: `src/host.js`, `src/prompts.js`, `src/commands.js` and
 * `src/session-titles.js` are copied to `lib/` verbatim, and the plain-JS
 * native engine (`src/native/**`) plus the pinned upstream snapshot
 * (`src/native-snapshot/**`) are mirrored under `lib/` with their relative
 * layout preserved — plain ESM, relative imports, no bundler.
 *
 * Client half: the DSH client module system serves `lib/client.js` as a classic
 * script that registers a closure factory:
 *
 *   window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => { … } })
 *
 * so this script concatenates the (import-free) browser source into exactly
 * that wrapper and inlines the import-free helper module
 * (`src/client-helpers.js`) at the `@@CLIENT_HELPERS@@` marker inside the
 * factory. Nothing else may appear at the top level of the emitted file, and
 * `require` may only ask for platform modules.
 *
 * The emitted host modules are imported once at the end so a build fails loud
 * when a relative import is missing or a module does not parse.
 *
 * Usage: node tools/build.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

/** Module specifiers the shell seeds into the frozen module table. */
const PLATFORM_MODULES = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])

/** Marker inside the client factory replaced with the helper module body. */
const HELPER_MARKER = '/* @@CLIENT_HELPERS@@ */'

const manifest = JSON.parse(read('package.json'))

/** Fail loud instead of shipping a file the module system cannot evaluate. */
function assertNoModuleSyntax(label, source) {
  const match = /^\s*(import|export)\s/m.exec(source)
  if (match !== null) {
    throw new Error(`${label}: top-level "${match[1]}" is not allowed in the factory body`)
  }
}

/** Every `require('…')` inside the browser half must name a platform module. */
function assertPlatformRequires(label, source) {
  const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(pattern)) {
    if (!PLATFORM_MODULES.has(match[1])) {
      throw new Error(`${label} requires "${match[1]}", which is not a platform module`)
    }
  }
}

/** Strip ESM `export` keywords so one module can be inlined into the classic-script factory. */
function stripExports(label, source) {
  const stripped = source.replace(/^export\s+(?=(async\s+function|function|const|let|class)\b)/gm, '')
  const leftover = /^\s*(import|export)\s/m.exec(stripped)
  if (leftover !== null) {
    throw new Error(`${label}: "${leftover[1]}" cannot be inlined into the client factory`)
  }
  return stripped
}

/** Copy one directory tree under lib/ (files only, relative layout preserved). */
function copyTree(fromRelative, toRelative) {
  const from = path.join(root, fromRelative)
  if (!fs.existsSync(from)) throw new Error(`missing source directory: ${fromRelative}`)
  const walk = (directory, target) => {
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name)
      const destination = path.join(target, entry.name)
      if (entry.isDirectory()) walk(source, destination)
      else if (entry.isFile()) fs.copyFileSync(source, destination)
    }
  }
  walk(from, path.join(root, toRelative))
}

/** Compile one classic script without executing it. */
function assertClassicScript(label, source) {
  assertNoModuleSyntax(label, source)
  assertPlatformRequires(label, source)
  // `Function` compiles the body; the emitted wrapper must also keep its loader call.
  new Function(source)
  if (!source.includes('window.__ModuleLoader__.load(')) {
    throw new Error(`${label}: missing window.__ModuleLoader__.load(...) wrapper`)
  }
}

const client = read('src/client.js')
const helpers = stripExports('src/client-helpers.js', read('src/client-helpers.js'))
if (!client.includes(HELPER_MARKER)) {
  throw new Error(`src/client.js: helper marker ${HELPER_MARKER} not found`)
}
// A function replacement keeps `$&`/`$\`` sequences inside the helper source
// literal (JSDoc regex examples contain `$``), instead of letting String.replace
// interpret them as replacement patterns.
const clientWithHelpers = client.replace(HELPER_MARKER, () => helpers.trimEnd())
assertClassicScript('src/client.js', clientWithHelpers)

// Rebuild lib/ from scratch so deleted sources never linger in the shipped tree.
const lib = path.join(root, 'lib')
fs.rmSync(lib, { recursive: true, force: true })
fs.mkdirSync(lib, { recursive: true })

fs.writeFileSync(path.join(lib, 'index.js'), read('src/host.js'))
fs.writeFileSync(path.join(lib, 'prompts.js'), read('src/prompts.js'))
fs.writeFileSync(path.join(lib, 'commands.js'), read('src/commands.js'))
fs.writeFileSync(path.join(lib, 'session-titles.js'), read('src/session-titles.js'))
copyTree('src/native', 'lib/native')
copyTree('src/native-snapshot', 'lib/native-snapshot')
fs.writeFileSync(path.join(lib, 'client.js'), `${clientWithHelpers.trimEnd()}\n`)

const HOST_MODULES = ['index.js', 'prompts.js', 'commands.js', 'session-titles.js']
for (const module of HOST_MODULES) {
  await import(pathToFileURL(path.join(lib, module)).href)
}
console.log(
  `dsh-spec: built lib/index.js, lib/prompts.js, lib/commands.js, lib/session-titles.js, lib/client.js, lib/native/, lib/native-snapshot/ (v${manifest.version})`,
)
