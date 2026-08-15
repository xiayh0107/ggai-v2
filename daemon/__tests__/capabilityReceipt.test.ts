import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createRunCapabilityReceipt,
  inspectRunCapabilityReceipt,
  RunCapabilityReceiptStore,
} from '../capabilityReceipt.js'
import { CapabilityExecutionScopes } from '../capabilityScopes.js'
import { AgentRegistry } from '../registry.js'

test('Run capability receipts are canonical and order independent', async () => {
  const registry = new AgentRegistry({ codexCommand: '/definitely/missing/codex' })
  const scopes = new CapabilityExecutionScopes(registry.runtimeServices)
  const run = scopes.workspace(path.resolve('receipt-fixtures')).run('receipt-run')
  const profile = registry.runtimeDiagnostics().profile
  const semantic = [{
    key: 'ggai.node-projection.v1',
    provider: '@ggai/projection-registry',
    digest: 'a'.repeat(64),
  }]
  const first = run.acceptCapabilities(profile, semantic)
  const second = createRunCapabilityReceipt({
    runId: 'receipt-run',
    profile,
    services: [...run.services.snapshot()].reverse(),
    semanticCapabilities: [...semantic].reverse(),
  })

  assert.deepEqual(first, second)
  assert.equal(first.digest.length, 64)
  assert.equal(first.profileDigest.length, 64)
  assert.equal(inspectRunCapabilityReceipt(first).status, 'valid')
  await scopes.dispose()
  await registry.dispose()
})

test('receipt storage is immutable, idempotent, and rejects another digest', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-receipts-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new RunCapabilityReceiptStore(root)
  const profile = {
    schemaVersion: 1 as const,
    id: '@ggai/test-profile',
    version: '1.0.0',
    bundles: [],
  }
  const first = createRunCapabilityReceipt({
    runId: 'stable-run',
    profile,
    services: [{ id: 'ggai.agent-transports.v1', owner: '@ggai/test' }],
  })
  const conflicting = createRunCapabilityReceipt({
    runId: 'stable-run',
    profile,
    services: [{ id: 'ggai.agent-transports.v1', owner: '@ggai/other' }],
  })

  assert.deepEqual(await store.pin(first), first)
  assert.deepEqual(await store.pin(first), first)
  await assert.rejects(store.pin(conflicting), /another digest/u)
  assert.deepEqual(await store.get('stable-run'), first)
})

test('tampered receipt digests fail inspection', () => {
  const receipt = createRunCapabilityReceipt({
    runId: 'tampered-run',
    profile: {
      schemaVersion: 1,
      id: '@ggai/test-profile',
      version: '1.0.0',
      bundles: [],
    },
    services: [],
  })
  const tampered = { ...receipt, digest: '0'.repeat(64) }
  assert.deepEqual(inspectRunCapabilityReceipt(tampered), {
    status: 'invalid',
    reason: 'capability receipt digest does not match',
  })
})
