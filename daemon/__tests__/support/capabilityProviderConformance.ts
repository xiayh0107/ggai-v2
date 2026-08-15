import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapabilityPlugin,
  CapabilityPluginHost,
} from '../../runtime/pluginHost.js'
import type { ServiceKey } from '../../runtime/services.js'

export function providerConformanceCase<Service>(
  family: string,
  createFixture: () => Promise<{
    host: CapabilityPluginHost
    plugin: CapabilityPlugin
    key: ServiceKey<Service>
    assertService(service: Service): void | Promise<void>
  }> | {
    host: CapabilityPluginHost
    plugin: CapabilityPlugin
    key: ServiceKey<Service>
    assertService(service: Service): void | Promise<void>
  },
): void {
  test(`capability provider conformance: ${family}`, async () => {
    const fixture = await createFixture()
    try {
      assert.equal(fixture.host.services.get(fixture.key), undefined)
      const unmount = await fixture.host.mount(fixture.plugin)
      await fixture.assertService(fixture.host.services.require(fixture.key))
      await assert.rejects(fixture.host.mount(fixture.plugin), /already mounted or mounting/u)
      await unmount()
      assert.equal(fixture.host.services.get(fixture.key), undefined)
      await unmount()
    } finally {
      await fixture.host.dispose()
    }
  })
}

export function contributionProviderConformanceCase<Snapshot>(
  family: string,
  createFixture: () => Promise<{
    host: CapabilityPluginHost
    plugin: CapabilityPlugin
    snapshot(): Snapshot
    isEmpty(snapshot: Snapshot): boolean
    assertPopulated(snapshot: Snapshot): void | Promise<void>
  }> | {
    host: CapabilityPluginHost
    plugin: CapabilityPlugin
    snapshot(): Snapshot
    isEmpty(snapshot: Snapshot): boolean
    assertPopulated(snapshot: Snapshot): void | Promise<void>
  },
): void {
  test(`capability contribution conformance: ${family}`, async () => {
    const fixture = await createFixture()
    try {
      assert.equal(fixture.isEmpty(fixture.snapshot()), true)
      const unmount = await fixture.host.mount(fixture.plugin)
      await fixture.assertPopulated(fixture.snapshot())
      await assert.rejects(fixture.host.mount(fixture.plugin), /already mounted or mounting/u)
      await unmount()
      assert.equal(fixture.isEmpty(fixture.snapshot()), true)
      await unmount()
    } finally {
      await fixture.host.dispose()
    }
  })
}
