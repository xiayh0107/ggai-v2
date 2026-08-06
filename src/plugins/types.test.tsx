import { FileQuestion } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN_V2 } from './artifactContracts'
import {
  enabledArtifactCapabilitySnapshotV2,
  getPlugin,
  registerPlugin,
  type NodePlugin,
  unregisterPlugin,
  setPluginEnabled,
} from './types'

function plugin(
  id: string,
  artifactClaims: NodePlugin['artifactClaims'] = [],
): NodePlugin {
  return {
    id,
    label: id,
    desc: 'Test plugin',
    icon: FileQuestion,
    defaultWidth: 300,
    initialPayload: () => ({}),
    isEmpty: () => true,
    views: { Empty: () => null, Content: () => null },
    instr: { placeholder: 'Test', actions: [] },
    artifactClaims,
    demoResult: () => null,
  }
}

describe('browser plugin registry artifact boundary', () => {
  it('rejects duplicate plugin ids', () => {
    const subject = plugin('@tests/duplicate-artifact-plugin')
    registerPlugin(subject)
    expect(() => registerPlugin(subject)).toThrow(/重复注册/u)
  })

  it('allows explicit unload before hot-module re-registration', () => {
    const subject = plugin('@tests/hot-reloaded-plugin')
    registerPlugin(subject)
    expect(unregisterPlugin(subject.id)).toBe(true)
    expect(() => registerPlugin({ ...subject, label: 'Reloaded plugin' })).not.toThrow()
    expect(getPlugin(subject.id).label).toBe('Reloaded plugin')
  })

  it('rejects malformed and excessive artifact claims', () => {
    expect(() => registerPlugin(plugin('@tests/uppercase-extension', [
      { extensions: ['.PNG'] },
    ]))).toThrow(/artifactClaims/u)
    expect(() => registerPlugin(plugin(
      '@tests/excessive-claims',
      Array.from(
        { length: MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN_V2 + 1 },
        () => ({ extensions: ['.txt'] }),
      ),
    ))).toThrow(/artifactClaims/u)
  })

  it('stores canonical claims and exposes a content-only V2 projector', () => {
    const subject = {
      ...plugin('@tests/pure-projector', [{ extensions: ['.txt'], priority: 0 }]),
      projectArtifact: ({ title }: { title: string }) => ({ title }),
    } satisfies NodePlugin
    registerPlugin(subject)

    const registered = getPlugin(subject.id)
    expect(registered.artifactClaims).toEqual([{ extensions: ['.txt'] }])
    expect(registered.projectArtifact?.({
      runId: 'run-1',
      artifactId: 'artifact-1',
      mediaType: 'text/plain',
      title: 'notes.txt',
    })).toEqual({ title: 'notes.txt' })
  })

  it('snapshots only enabled non-builtin serializable artifact claims', () => {
    const enabled = plugin('@tests/enabled-capability', [{ extensions: ['.enabled'] }])
    const disabled = plugin('@tests/disabled-capability', [{ extensions: ['.disabled'] }])
    const protectedBuiltin = plugin('image', [{ extensions: ['.forged'] }])
    registerPlugin(enabled)
    registerPlugin(disabled)
    registerPlugin(protectedBuiltin)
    setPluginEnabled(disabled.id, false)
    try {
      expect(enabledArtifactCapabilitySnapshotV2()).toMatchObject({
        schemaVersion: 2,
        plugins: expect.arrayContaining([{
          id: enabled.id,
          artifactClaims: [{ extensions: ['.enabled'] }],
        }]),
      })
      const ids = enabledArtifactCapabilitySnapshotV2().plugins.map(({ id }) => id)
      expect(ids).not.toContain(disabled.id)
      expect(ids).not.toContain('image')
    } finally {
      unregisterPlugin(enabled.id)
      unregisterPlugin(disabled.id)
      unregisterPlugin(protectedBuiltin.id)
    }
  })
})
