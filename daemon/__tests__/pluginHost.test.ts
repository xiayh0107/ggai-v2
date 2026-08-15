import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CapabilityPluginHost,
  type CapabilityPluginContext,
} from '../runtime/pluginHost.js'
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
  assert.throws(() => child.require(greetingService), /service scope is disposed/u)
  await root.dispose()
})

test('plugin dependencies are declared before activation and revoked after unload', async () => {
  const host = new CapabilityPluginHost()
  host.services.provide(greetingService, { greet: () => 'root' }, 'root-provider')
  let activated = false
  await assert.rejects(host.mount({
    manifest: { id: '@ggai/missing-dependency', version: '1.0.0', apiVersion: 1 },
    inject: [{ id: 'ggai.missing.v1' }],
    activate() { activated = true },
  }), /required service is unavailable/u)
  assert.equal(activated, false)

  let retainedContext: CapabilityPluginContext | undefined
  const unload = await host.mount({
    manifest: { id: '@ggai/consumer', version: '1.0.0', apiVersion: 1 },
    inject: [greetingService],
    activate(context) {
      retainedContext = context
      assert.equal(context.require(greetingService).greet(), 'root')
    },
  })
  await unload()
  assert.throws(
    () => retainedContext?.require(greetingService),
    /service scope is disposed/u,
  )
  await host.dispose()
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

test('activation and rollback failures are both preserved', async () => {
  const host = new CapabilityPluginHost()
  await assert.rejects(host.mount({
    manifest: { id: '@ggai/double-failure', version: '1.0.0', apiVersion: 1 },
    activate(context) {
      context.effect(() => { throw new Error('rollback failed') })
      throw new Error('activation failed')
    },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors.map(String), [
      'Error: activation failed',
      'Error: rollback failed',
    ])
    return true
  })
  await host.dispose()
})

test('host disposal waits for in-flight activation and then unloads it', async () => {
  const host = new CapabilityPluginHost()
  let finishActivation: (() => void) | undefined
  let unloaded = false
  const mounting = host.mount({
    manifest: { id: '@ggai/slow', version: '1.0.0', apiVersion: 1 },
    activate() {
      return new Promise((resolve) => {
        finishActivation = () => resolve(() => { unloaded = true })
      })
    },
  })
  const closing = host.dispose()
  let closed = false
  void closing.then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)

  finishActivation?.()
  await mounting
  await closing
  assert.equal(unloaded, true)
  assert.deepEqual(host.list(), [])
})
