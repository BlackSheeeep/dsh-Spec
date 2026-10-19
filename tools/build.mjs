/**
 * Build dsh-spec.
 *
 * Host half: `src/host.js` + `src/prompts.js` are copied to `lib/` verbatim —
 * plain ESM, relative imports, no bundler.
 *
 * Client half: the DSH client module system serves `lib/client.js` as a classic
 * script that registers a closure factory:
 *
 *   window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => { … } })
 *
 * so this script concatenates the (import-free) browser source into exactly
 * that wrapper. Nothing else may appear at the top level of the emitted file,
 * and `require` may only ask for platform modules.
 *
 * Usage: node tools/build.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

/** Module specifiers the shell seeds into the frozen module table. */
const PLATFORM_MODULES = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])

const manifest = JSON.parse(read('package.json'))

/** Fail loud instead of shipping a file the module system cannot evaluate. */
function assertNoModuleSyntax(label, source) {
  const match = /^\s*(import|export)\s/m.exec(source)
  if (match !== null) {
    throw new Error(`${label}: top-level "${match[1]}" is not allowed in the factory body`)
  }
}

/** Every `require('…')` inside the browser half must name a platform module. */
function assertPlatformRequires(source) {
  const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(pattern)) {
    if (!PLATFORM_MODULES.has(match[1])) {
      throw new Error(`src/client.js requires "${match[1]}", which is not a platform module`)
    }
  }
}

const client = read('src/client.js')
assertNoModuleSyntax('src/client.js', client)
assertPlatformRequires(client)

const emitted = `${client.trimEnd()}\n`
fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
fs.writeFileSync(path.join(root, 'lib', 'index.js'), read('src/host.js'))
fs.writeFileSync(path.join(root, 'lib', 'prompts.js'), read('src/prompts.js'))
fs.writeFileSync(path.join(root, 'lib', 'client.js'), emitted)
console.log('dsh-spec: built lib/index.js, lib/prompts.js, lib/client.js')
