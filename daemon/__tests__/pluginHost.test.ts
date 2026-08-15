import assert from 'node:assert/strict'
import test from 'node:test'
import { CapabilityPluginHost } from '../runtime/pluginHost.js'
import { defineService, ServiceScope } from '../runtime/services.js'

const greetingService = defineService<{ greet(): string }>('ggai.greeting.v1')

test('service scopes shadow parent providers and restore them on disposal', async () => {
  const root = new ServiceScope({ label: 'root' })
  root.provide(greetingService, { greet: () => 'root' }, 'root-provider')
  const child = root.fork('child')
  child.provide(greetingService, { greet: () => 'child' }, 'child-provider')

  assert.equal(root.require(greetingService).greet(), 'root')
  assert.equal(child.require(greetingService).greet(), 'child')
  assert.equal(child.ownerOf(greetingService), 'child-provider')

  await child.dispose()
  assert.equal(root.require(greetingService).greet(), 'root')
  await root.dispose()
})

test('plugin host owns providers and reverses effects on unload', async () => {
  const order: string[] = []
  const host = new CapabilityPluginHost()
  const unload = await host.mount({
    manifest: { id: '@ggai/example', version: '1.0.0', apiVersion: 1 },
    activate(context) {
      context.provide(greetingService, { greet: () => 'plugin' })
      context.effect(() => { order.push('first') })
      context.effect(() => { order.push('second') })
    },
  })

  assert.equal(host.services.require(greetingService).greet(), 'plugin')
  assert.deepEqual(host.list().map(({ id }) => id), ['@ggai/example'])

  await unload()
  assert.equal(host.services.get(greetingService), undefined)
  assert.deepEqual(order, ['second', 'first'])
  assert.deepEqual(host.list(), [])
  await host.dispose()
})

test('failed activation rolls back every contribution', async () => {
  const host = new CapabilityPluginHost()
  await assert.rejects(host.mount({
    manifest: { id: '@ggai/broken', version: '1.0.0', apiVersion: 1 },
    activate(context) {
      context.provide(greetingService, { greet: () => 'broken' })
      throw new Error('activation failed')
    },
  }), /activation failed/u)

  assert.equal(host.services.get(greetingService), undefined)
  assert.deepEqual(host.list(), [])
  await host.dispose()
})
