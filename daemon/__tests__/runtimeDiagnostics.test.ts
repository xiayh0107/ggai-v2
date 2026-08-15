import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentRegistry } from '../registry.js'
import { inspectRuntimeDoctor } from '../runtimeDoctor.js'

test('Agent runtime diagnostics are deterministic and contain no service values', async () => {
  const registry = new AgentRegistry({ codexCommand: '/definitely/missing/codex' })
  const first = registry.runtimeDiagnostics()
  const second = registry.runtimeDiagnostics()

  assert.deepEqual(first, second)
  assert.equal(first.schemaVersion, 1)
  assert.equal(first.profile.id, '@ggai/default-agent-runtime')
  assert.deepEqual(first.services, [{
    id: 'ggai.agent-transports.v1',
    owner: '@ggai/agent-runtime',
  }])
  assert.deepEqual(first.agentTransports, [{
    id: '@ggai/agent-transport-codex',
    agentIds: ['codex'],
  }])
  assert.deepEqual(first.eventFailures, [])
  assert.equal(JSON.stringify(first).includes('AgentTransportRegistry'), false)
  await registry.dispose()
})

test('runtime doctor reports unavailable providers without leaking executable state', async () => {
  const registry = new AgentRegistry({ codexCommand: '/definitely/missing/codex' })
  const report = await inspectRuntimeDoctor(registry)

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.status, 'degraded')
  assert.deepEqual(report.problems.map(({ code }) => code), [
    'agent_transport_unavailable',
  ])
  assert.equal(report.agents[0]?.id, 'codex')
  await registry.dispose()
})
