/**
 * Move active OpenSpec change directories into `openspec/.trash/` so they no
 * longer occupy the active change list. Archive entries are never touched.
 *
 * @module dsh-spec/native/clear
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const NAME = /^[a-z0-9][a-z0-9-]*$/

/** Move the given active change directories into the workspace trash. */
export async function clearChanges(cwd, names) {
  const removed = []
  const skipped = []
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== 'string' || !NAME.test(name)) {
      skipped.push({ name: String(name), reason: 'invalid-name' })
      continue
    }
    const dir = path.join(cwd, 'openspec', 'changes', name)
    try {
      const stat = await fs.stat(dir)
      if (!stat.isDirectory()) {
        skipped.push({ name, reason: 'not-a-directory' })
        continue
      }
      // Prefer a real delete. If Windows holds a handle, move the directory out
      // of the active changes area instead of failing the whole action.
      try {
        await fs.rm(dir, { recursive: true, force: true })
        removed.push(name)
      } catch (removeError) {
        const trashDir = path.join(cwd, 'openspec', '.trash')
        const target = path.join(trashDir, `${name}-${Date.now()}`)
        try {
          await fs.mkdir(trashDir, { recursive: true })
          try {
            await fs.rename(dir, target)
          } catch {
            // Last-resort soft delete: a tombstone hides this change from the
            // active workspace without requiring the locked files to move.
            await fs.writeFile(
              path.join(trashDir, `${name}.json`),
              `${JSON.stringify({ name, trashedAt: new Date().toISOString(), reason: 'filesystem-lock' }, null, 2)}\n`,
              'utf8',
            )
          }
          removed.push(name)
        } catch (moveError) {
          skipped.push({
            name,
            reason: `${removeError?.code ?? 'remove-failed'}; move: ${moveError?.code ?? String(moveError)}`,
          })
        }
      }
    } catch (error) {
      skipped.push({ name, reason: error?.code === 'ENOENT' ? 'not-found' : String(error?.message ?? error) })
    }
  }
  return { removed, skipped }
}
