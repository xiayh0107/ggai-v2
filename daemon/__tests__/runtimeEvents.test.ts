import assert from 'node:assert/strict'
import test from 'node:test'
import { TypedEventBus } from '../runtime/events.js'
import { CapabilityPluginHost } from '../runtime/pluginHost.js'

interface TestEvents {
  message: { readonly text: string }
}

test('typed event bus contains failures and continues notifying observers', () => {
  const bus = new TypedEventBus<TestEvents>()
  const seen: string[] = []
  bus.on('message', () => { throw new Error('observer failed') })
  const release = bus.on('message', ({ text }) => { seen.push(text) })

  const failures = bus.emit('message', { text: 'hello' })
  assert.deepEqual(seen, ['hello'])
  assert.equal(failures.length, 1)
  assert.match(String(failures[0]?.error), /observer failed/u)

  release()
  assert.equal(bus.listenerCount('message'), 1)
  bus.dispose()
  assert.deepEqual(bus.emit('message', { text: 'ignored' }), [])
})

test('plugin lifecycle listeners are scoped to the subscribing plugin', async () => {
  const host = new CapabilityPluginHost()
  const seen: string[] = []
  const unloadObserver = host.mountSync({
    manifest: { id: '@test/observer', version: '1.0.0', apiVersion: 1 },
    activate(context) {
      context.onEvent('plugin/mounted', ({ manifest }) => { seen.push(manifest.id) })
    },
  })
  assert.deepEqual(seen, ['@test/observer'])

  const unloadFirst = host.mountSync({
    manifest: { id: '@test/first', version: '1.0.0', apiVersion: 1 },
    activate() {},
  })
  assert.deepEqual(seen, ['@test/observer', '@test/first'])

  await unloadObserver()
  const unloadSecond = host.mountSync({
    manifest: { id: '@test/second', version: '1.0.0', apiVersion: 1 },
    activate() {},
  })
  assert.deepEqual(seen, ['@test/observer', '@test/first'])

  await unloadSecond()
  await unloadFirst()
  await host.dispose()
})

test('lifecycle observer failures never grant control over mount or unload', async () => {
  const host = new CapabilityPluginHost()
  host.events.on('plugin/mounted', () => { throw new Error('telemetry failed') })
  host.events.on('plugin/unmounting', async () => undefined)

  const unload = host.mountSync({
    manifest: { id: '@test/stable', version: '1.0.0', apiVersion: 1 },
    activate() {},
  })
  assert.deepEqual(host.list().map(({ id }) => id), ['@test/stable'])
  assert.equal(host.drainEventFailures().length, 1)

  await unload()
  assert.deepEqual(host.list(), [])
  const failures = host.drainEventFailures()
  assert.equal(failures.length, 1)
  assert.match(String(failures[0]?.error), /must be synchronous/u)
  await host.dispose()
})
