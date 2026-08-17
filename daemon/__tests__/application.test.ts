import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DaemonApplication } from '../application.js'
import type { DaemonConfig } from '../startupOptions.js'

test('diagnostic operations use the application composition root without listening', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-application-')))
  const application = new DaemonApplication(config(root, 'dump-runtime'))

  assert.equal(application.runtimeDiagnostics().profile.id, '@ggai/default-agent-runtime')
  await assert.rejects(application.listen(), /does not start an HTTP server/u)
  await application.close()
  assert.equal(application.registry.resolve('codex'), null)
  await rm(root, { recursive: true, force: true })
})

test('application owns HTTP startup and idempotent shutdown', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-application-http-')))
  const application = new DaemonApplication({
    ...config(root, 'serve'),
    port: 0,
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  await application.listen()
  assert.ok(application.server.listening)
  assert.equal((await application.metadata.diagnostics()).integrity, 'ok')
  await Promise.all([application.close(), application.close()])
  assert.equal(application.registry.resolve('codex'), null)
})

function config(projectRoot: string, operation: DaemonConfig['operation']): DaemonConfig {
  return {
    operation,
    host: '127.0.0.1',
    port: 7380,
    projectRoot,
    allowedOrigins: [],
    acpxAgents: [],
    acpxApprovalMode: 'approve-reads',
    codexCommand: '/definitely/missing/codex',
    acpxCommand: '/definitely/missing/acpx',
  }
}
