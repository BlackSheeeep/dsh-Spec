import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { autoCommit, buildCommitMessage, parseStatus, shouldIgnorePath } from '../src/native/autocommit.js'

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autocommit-'))
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd })
  fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n')
  execFileSync('git', ['add', 'README.md'], { cwd })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd })
  return cwd
}

test('autocommit filters junk and commits only safe files', async () => {
  const cwd = repo()
  fs.writeFileSync(path.join(cwd, 'src.ts'), 'export const value = 1\n')
  fs.writeFileSync(path.join(cwd, 'debug.log'), 'noise\n')
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n')
  fs.mkdirSync(path.join(cwd, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'node_modules', 'x', 'index.js'), 'x\n')

  const preview = await autoCommit(cwd, { dryRun: true })
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.files.map((entry) => entry.path), ['src.ts'])
  assert.ok(preview.skipped.some((entry) => entry.path === 'debug.log'))
  assert.ok(preview.skipped.some((entry) => entry.path === '.env'))
  assert.ok(preview.skipped.some((entry) => entry.path.includes('node_modules')))

  const committed = await autoCommit(cwd, { dryRun: false })
  assert.equal(committed.ok, true)
  assert.match(committed.message.header, /update 1 file/)
  const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd, encoding: 'utf8' }).trim()
  assert.equal(log, committed.message.header)
  const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
  assert.doesNotMatch(status, /src\.ts/)
  assert.match(status, /debug\.log/)
  assert.match(status, /\.env/)
  assert.match(status, /node_modules/)
})

test('status parsing and ignore rules cover names with spaces', () => {
  const parsed = parseStatus(' M file with spaces.ts\0?? new.md\0')
  assert.deepEqual(parsed.map((entry) => entry.path), ['file with spaces.ts', 'new.md'])
  assert.equal(shouldIgnorePath('node_modules/x.js'), true)
  assert.equal(shouldIgnorePath('openspec/.trash/x.json'), true)
  assert.equal(shouldIgnorePath('src/app.ts'), false)
  const message = buildCommitMessage(['src/app.ts'], { added: [], modified: ['src/app.ts'], deleted: [], renamed: [] })
  assert.match(message.header, /chore/)
})
