import assert from 'node:assert/strict'
import test from 'node:test'
import { createBuiltinAgentRuntimeProfile } from '../agentRuntime.js'
import {
  CAPABILITY_PROFILE_SCHEMA_VERSION,
  inspectCapabilityProfile,
  mountCapabilityProfile,
  mountCapabilityProfileSync,
} from '../runtime/composition.js'
import { CapabilityPluginHost } from '../runtime/pluginHost.js'

test('profile mounts in declared order and disposes in reverse order', async () => {
  const host = new CapabilityPluginHost()
  const order: string[] = []
  const dispose = mountCapabilityProfileSync(host, {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    id: '@test/profile',
    version: '1.0.0',
    bundles: [{
      id: '@test/base',
      version: '1.0.0',
      plugins: ['first', 'second'].map((id) => ({
        manifest: { id: `@test/${id}`, version: '1.0.0', apiVersion: 1 as const },
        activate() {
          order.push(`mount:${id}`)
          return () => { order.push(`unmount:${id}`) }
        },
      })),
    }],
  })

  assert.deepEqual(order, ['mount:first', 'mount:second'])
  await dispose()
  assert.deepEqual(order, [
    'mount:first',
    'mount:second',
    'unmount:second',
    'unmount:first',
  ])
  await host.dispose()
})

test('structural profile conflicts fail before any plugin activates', () => {
  const host = new CapabilityPluginHost()
  let activations = 0
  const duplicate = {
    manifest: { id: '@test/duplicate', version: '1.0.0', apiVersion: 1 as const },
    activate() { activations += 1 },
  }
  assert.throws(() => mountCapabilityProfileSync(host, {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    id: '@test/profile',
    version: '1.0.0',
    bundles: [
      { id: '@test/one', version: '1.0.0', plugins: [duplicate] },
      { id: '@test/two', version: '1.0.0', plugins: [duplicate] },
    ],
  }), /duplicate capability plugin/u)
  assert.equal(activations, 0)

  const invalid = {
    manifest: { id: '@test/invalid', version: 'broken', apiVersion: 1 as const },
    activate() { activations += 1 },
  }
  assert.throws(() => mountCapabilityProfileSync(host, {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    id: '@test/invalid-profile',
    version: '1.0.0',
    bundles: [{ id: '@test/base', version: '1.0.0', plugins: [duplicate, invalid] }],
  }), /invalid plugin version/u)
  assert.equal(activations, 0)
})

test('async profile activation failure awaits rollback of earlier plugins', async () => {
  const host = new CapabilityPluginHost()
  const order: string[] = []
  await assert.rejects(mountCapabilityProfile(host, {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    id: '@test/async-profile',
    version: '1.0.0',
    bundles: [{
      id: '@test/async-bundle',
      version: '1.0.0',
      plugins: [
        {
          manifest: { id: '@test/healthy', version: '1.0.0', apiVersion: 1 },
          activate() { return () => { order.push('rolled-back') } },
        },
        {
          manifest: { id: '@test/broken', version: '1.0.0', apiVersion: 1 },
          activate() { throw new Error('activation failed') },
        },
      ],
    }],
  }), /activation failed/u)
  assert.deepEqual(order, ['rolled-back'])
  assert.deepEqual(host.list(), [])
  await host.dispose()
})

test('default Agent runtime is expressed as a data-inspectable profile', () => {
  const base = inspectCapabilityProfile(createBuiltinAgentRuntimeProfile())
  assert.deepEqual(base.bundles.map(({ id }) => id), ['@ggai/codex-transport-bundle'])
  assert.deepEqual(
    base.bundles.flatMap(({ plugins }) => plugins.map(({ id }) => id)),
    ['@ggai/agent-transport-codex'],
  )

  const withAcpx = inspectCapabilityProfile(createBuiltinAgentRuntimeProfile({
    acpxAgents: ['codex'],
  }))
  assert.deepEqual(withAcpx.bundles.map(({ id }) => id), [
    '@ggai/codex-transport-bundle',
    '@ggai/acpx-transport-bundle',
  ])
})
