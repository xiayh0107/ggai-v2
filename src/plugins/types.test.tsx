import { FileQuestion } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN } from './artifactContracts'
import { LEGACY_NODE_CONTEXT_POLICY } from './contextContracts'
import { defineNodeUi } from './uiContracts'
import {
  enabledArtifactCapabilitySnapshot,
  getPlugin,
  listCreatablePlugins,
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
    ui: defineNodeUi('card'),
    instr: { placeholder: 'Test', actions: [] },
    nodeContext: structuredClone(LEGACY_NODE_CONTEXT_POLICY),
    artifactClaims,
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
        { length: MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN + 1 },
        () => ({ extensions: ['.txt'] }),
      ),
    ))).toThrow(/artifactClaims/u)
  })

  it('rejects arbitrary plugin UI instead of accepting JSX or CSS hooks', () => {
    expect(() => registerPlugin({
      ...plugin('@tests/arbitrary-ui'),
      ui: { schemaVersion: 1, template: 'card', className: 'bg-red-500' },
    } as unknown as NodePlugin)).toThrow(/ui 无效/u)
  })

  it('stores canonical claims and a strict platform UI template', () => {
    const subject = plugin('@tests/canonical-plugin', [{ extensions: ['.txt'], priority: 0 }])
    registerPlugin(subject)

    const registered = getPlugin(subject.id)
    expect(registered.artifactClaims).toEqual([{ extensions: ['.txt'] }])
    expect(registered.ui).toEqual(defineNodeUi('card'))
  })

  it('keeps projection-only plugins out of creation', () => {
    const subject = {
      ...plugin('@tests/projection-only', [{ extensions: ['.safe'] }]),
      creatable: false,
    } satisfies NodePlugin
    registerPlugin(subject)
    try {
      expect(listCreatablePlugins().map(({ id }) => id)).not.toContain(subject.id)
    } finally {
      unregisterPlugin(subject.id)
    }
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
      const snapshot = enabledArtifactCapabilitySnapshot()
      expect(snapshot.schemaVersion).toBe(2)
      expect(snapshot.plugins).toEqual(expect.arrayContaining([expect.objectContaining({
          id: enabled.id,
          artifactClaims: [{ extensions: ['.enabled'] }],
          nodeContext: LEGACY_NODE_CONTEXT_POLICY,
        })]))
      const ids = snapshot.plugins.map(({ id }) => id)
      expect(ids).not.toContain(disabled.id)
      expect(ids).not.toContain('image')
    } finally {
      unregisterPlugin(enabled.id)
      unregisterPlugin(disabled.id)
      unregisterPlugin(protectedBuiltin.id)
    }
  })
})
