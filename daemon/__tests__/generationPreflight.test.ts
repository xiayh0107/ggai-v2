import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentDescriptor } from '../protocol.js'
import { inspectGenerationServicePreflight } from '../generationPreflight.js'
import type { AgentTransportCatalog } from '../transport/types.js'

function catalog(
  descriptors: AgentDescriptor[] | Error,
): AgentTransportCatalog {
  return {
    resolve: () => null,
    async probe() {
      if (descriptors instanceof Error) throw descriptors
      return descriptors.map((descriptor) => ({
        ...descriptor,
        models: [...descriptor.models],
      }))
    },
  }
}

function descriptor(
  input: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    id: 'codex',
    label: 'Codex',
    transport: 'codex',
    available: true,
    authStatus: 'authenticated',
    models: [],
    ...input,
  }
}

test('generation preflight projects a ready service without runtime internals', async () => {
  const report = await inspectGenerationServicePreflight(catalog([descriptor()]), 'codex')
  assert.deepEqual(report, {
    schemaVersion: 1,
    agentId: 'codex',
    state: 'ready',
    ready: true,
    retryable: false,
  })
  assert.equal('provider' in report, false)
  assert.equal('digest' in report, false)
  assert.equal('binaryPath' in report, false)
})

test('generation preflight distinguishes authentication and availability failures', async () => {
  const unauthenticated = await inspectGenerationServicePreflight(catalog([
    descriptor({ available: false, authStatus: 'unauthenticated' }),
  ]), 'codex')
  assert.equal(unauthenticated.state, 'not-authenticated')
  assert.equal(unauthenticated.issue?.code, 'generation_service_not_authenticated')
  assert.equal(unauthenticated.retryable, true)

  const unavailable = await inspectGenerationServicePreflight(catalog([
    descriptor({ available: false, authStatus: 'unknown', detail: 'private diagnostic' }),
  ]), 'codex')
  assert.equal(unavailable.state, 'unavailable')
  assert.equal(unavailable.issue?.code, 'generation_service_unavailable')
  assert.equal(JSON.stringify(unavailable).includes('private diagnostic'), false)
})

test('generation preflight safely reports missing and failed probes', async () => {
  const missing = await inspectGenerationServicePreflight(catalog([]), 'codex')
  assert.equal(missing.state, 'not-found')
  assert.equal(missing.issue?.code, 'generation_service_not_found')

  const failed = await inspectGenerationServicePreflight(
    catalog(new Error('sensitive probe output')),
    'codex',
  )
  assert.equal(failed.state, 'probe-failed')
  assert.equal(failed.issue?.code, 'generation_service_probe_failed')
  assert.equal(JSON.stringify(failed).includes('sensitive probe output'), false)
})

test('generation preflight rejects malformed agent ids', async () => {
  await assert.rejects(
    inspectGenerationServicePreflight(catalog([]), '../codex'),
    /agentId is invalid/u,
  )
})
