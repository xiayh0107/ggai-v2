import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDaemonServer } from '../server.js'

test('daemon shutdown unloads its Agent runtime plugins', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-agent-runtime-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const daemon = createDaemonServer({ projectRoot: root })

  assert.ok(daemon.registry.resolve('codex'))
  await daemon.close()
  assert.equal(daemon.registry.resolve('codex'), null)
})
