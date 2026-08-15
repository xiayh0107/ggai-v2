import { describe, expect, it } from 'vitest'
import {
  BUILTIN_NODE_CONTEXT_POLICY_REGISTRY,
  LEGACY_NODE_CONTEXT_POLICY,
  MAX_NODE_CONTEXT_PAYLOAD_FIELDS,
  NODE_CONTEXT_POLICY_SCHEMA_VERSION,
  inspectNodeContextPolicy,
  nodeContextPolicyForBuiltin,
} from './contextContracts'

describe('node context policy contract', () => {
  it('keeps a conservative, serializable policy for every built-in node type', () => {
    expect(BUILTIN_NODE_CONTEXT_POLICY_REGISTRY.map(({ id }) => id)).toEqual([
      'pdf', 'web', 'image', 'text', 'table', 'formula', 'code', 'graphic', 'smart', 'file',
    ])
    expect(nodeContextPolicyForBuiltin('text')).toMatchObject({
      schemaVersion: 1,
      summary: { textMaxChars: 800, payloadFields: ['heading'] },
      full: {
        textMaxChars: 250_000,
        payloadFields: ['bold', 'heading', 'italic'],
        artifactRefs: 'all',
      },
    })
    expect(structuredClone(LEGACY_NODE_CONTEXT_POLICY)).toEqual(LEGACY_NODE_CONTEXT_POLICY)
  })

  it('canonicalizes payload allow-lists and rejects executable or ambiguous shapes', () => {
    expect(inspectNodeContextPolicy({
      schemaVersion: NODE_CONTEXT_POLICY_SCHEMA_VERSION,
      summary: { textMaxChars: 20, payloadFields: ['zeta', 'alpha'] },
      full: { textMaxChars: 100, payloadFields: ['visible'], artifactRefs: 'none' },
    })).toEqual({
      status: 'valid',
      policy: {
        schemaVersion: 1,
        summary: { textMaxChars: 20, payloadFields: ['alpha', 'zeta'] },
        full: { textMaxChars: 100, payloadFields: ['visible'], artifactRefs: 'none' },
      },
    })
    expect(inspectNodeContextPolicy({
      schemaVersion: 1,
      summary: { textMaxChars: 0, payloadFields: [] },
      full: { textMaxChars: 1, payloadFields: [], artifactRefs: 'none' },
      projector: () => null,
    }).status).toBe('invalid')
    expect(inspectNodeContextPolicy({
      schemaVersion: 1,
      summary: { textMaxChars: 0, payloadFields: ['__proto__'] },
      full: { textMaxChars: 1, payloadFields: [], artifactRefs: 'none' },
    }).status).toBe('invalid')
    expect(inspectNodeContextPolicy({
      schemaVersion: 1,
      summary: {
        textMaxChars: 0,
        payloadFields: Array.from(
          { length: MAX_NODE_CONTEXT_PAYLOAD_FIELDS + 1 },
          (_, index) => `field${index}`,
        ),
      },
      full: { textMaxChars: 1, payloadFields: 'all', artifactRefs: 'all' },
    }).status).toBe('invalid')
  })
})
