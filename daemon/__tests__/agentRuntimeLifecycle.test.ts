import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry.js'
import { createDaemonServer } from '../server.js'

test('daemon shutdown unloads its explicitly composed Agent runtime plugins', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-agent-runtime-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new AgentRegistry({})
  const daemon = createDaemonServer({ projectRoot: root, registry })

  assert.ok(daemon.registry.resolve('codex'))
  await daemon.close()
  assert.equal(daemon.registry.resolve('codex'), null)
})

test('provider-neutral registries do not install a builtin Agent implicitly', async () => {
  const registry = new AgentRegistry()
  assert.equal(registry.resolve('codex'), null)
  assert.deepEqual(await registry.probe(), [])
  assert.equal(registry.runtimeDiagnostics().profile.id, '@ggai/empty-agent-runtime')
  await registry.dispose()
})
