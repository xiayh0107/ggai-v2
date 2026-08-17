import { describe, expect, it } from 'vitest'
import { createBlankCustomNodeManifest } from './model'
import { getPluginRegistryVersion, unregisterPlugin } from '@/plugins/types'
import { createCustomNodeType, installCustomNodeManifest } from './runtime'

describe('node studio runtime compiler', () => {
  it('compiles an immutable plugin without making a new node look populated', () => {
    const manifest = {
      ...createBlankCustomNodeManifest(new Date('2026-01-01T00:00:00.000Z')),
      id: '@local/research-card',
      revision: 4,
      installed: true,
      actions: ['核对证据', '补充结论'],
    }
    const plugin = createCustomNodeType(manifest)

    expect(plugin.id).toBe('@local/research-card@4')
    expect(plugin.initialPayload).toEqual({})
    expect(plugin.instruction.actions).toEqual(['核对证据', '补充结论'])
    expect(plugin.ui).toEqual({ schemaVersion: 1, template: 'card' })
    expect(plugin.artifactClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ mediaTypes: ['text/*'] }),
    ]))
  })

  it('keeps historical revisions renderable but out of creation menus', () => {
    const plugin = createCustomNodeType({
      ...createBlankCustomNodeManifest(),
      id: '@local/research-card',
      revision: 2,
      installed: true,
    }, false)

    expect(plugin.creatable).toBe(false)
  })

  it('publishes a changing registry snapshot when a custom plugin is installed', () => {
    const manifest = {
      ...createBlankCustomNodeManifest(),
      id: '@local/registry-snapshot-test',
      revision: 1,
      installed: true,
    }
    const before = getPluginRegistryVersion()
    try {
      installCustomNodeManifest(manifest)
      expect(getPluginRegistryVersion()).toBeGreaterThan(before)
    } finally {
      unregisterPlugin('@local/registry-snapshot-test@1')
    }
  })
})
