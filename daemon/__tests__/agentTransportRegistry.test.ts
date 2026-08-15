import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProcessTransport } from '../transport/types.js'
import { AgentTransportRegistry } from '../transport/registry.js'

const transport: AgentProcessTransport = {
  kind: 'codex',
  async run() { return { sessionId: null } },
  async cancel() { return false },
}

test('provider registration owns agent ids and unload restores absence', async () => {
  const registry = new AgentTransportRegistry()
  const release = registry.register({
    id: '@test/provider',
    agentIds: ['test-agent'],
    async probe() {
      return [{
        id: 'test-agent',
        label: 'Test',
        transport: 'codex',
        available: true,
        authStatus: 'not-applicable',
        models: [],
      }]
    },
    resolve(agentId) {
      return agentId === 'test-agent' ? transport : null
    },
  })

  assert.equal(registry.resolve('test-agent'), transport)
  assert.deepEqual((await registry.probe()).map(({ id }) => id), ['test-agent'])
  release()
  assert.equal(registry.resolve('test-agent'), null)
  assert.deepEqual(await registry.probe(), [])
})

test('agent ids cannot be claimed by two providers', () => {
  const registry = new AgentTransportRegistry()
  registry.register({
    id: '@test/first',
    agentIds: ['shared'],
    async probe() { return [] },
    resolve() { return transport },
  })
  assert.throws(() => registry.register({
    id: '@test/second',
    agentIds: ['shared'],
    async probe() { return [] },
    resolve() { return transport },
  }), /already claimed/u)
})

test('a removed provider cannot repopulate the probe cache from an old flight', async () => {
  const registry = new AgentTransportRegistry()
  let finish: ((value: Awaited<ReturnType<AgentTransportRegistry['probe']>>) => void) | undefined
  const release = registry.register({
    id: '@test/slow',
    agentIds: ['slow'],
    probe() {
      return new Promise((resolve) => { finish = resolve })
    },
    resolve() { return transport },
  })

  const stale = registry.probe()
  release()
  finish?.([{
    id: 'slow',
    label: 'Slow',
    transport: 'codex',
    available: true,
    authStatus: 'not-applicable',
    models: [],
  }])
  assert.deepEqual((await stale).map(({ id }) => id), ['slow'])
  assert.deepEqual(await registry.probe(), [])
})
