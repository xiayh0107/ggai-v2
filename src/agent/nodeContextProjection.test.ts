import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../canvas/model'
import {
  NODE_CONTEXT_POLICY_SCHEMA_VERSION,
  type NodeContextPolicy,
} from '../plugins/contextContracts'
import { projectNodeContext } from './nodeContextProjection'

function node(): CanvasNode {
  return {
    id: 'node-source',
    typeRef: { id: '@tests/semantic', revision: 1, digest: '0000000000000000000000000000000000000000000000000000000000000000' },
    parentId: null,
    orderKey: (1).toString(36).padStart(12, '0'),
    bounds: { w: 320, h: 180 },
    transform: { matrix: [1, 0, 0, 1, 0, 0] },
    title: 'Source',
    text: 'A😀BCD',
    payload: { visible: { count: 2 }, secret: 'do-not-project' },
    artifactRefs: [{
      runId: 'run-source',
      artifactId: `artifact_${'a'.repeat(64)}`,
    }],
    origin: { kind: 'user' },
  }
}

const policy: NodeContextPolicy = {
  schemaVersion: NODE_CONTEXT_POLICY_SCHEMA_VERSION,
  summary: { textMaxChars: 2, payloadFields: ['visible'] },
  full: { textMaxChars: 4, payloadFields: ['visible'], artifactRefs: 'none' },
}

describe('Node context projection', () => {
  it('projects summary content without artifact authority and records every omission', () => {
    expect(projectNodeContext({ node: node(), contextRole: 'summary', policy })).toEqual({
      text: 'A😀',
      payload: { visible: { count: 2 } },
      artifactRefs: [],
      receipt: {
        policySource: 'plugin',
        text: { sourceChars: 5, includedChars: 2, truncated: true },
        payload: {
          sourceFields: 2,
          includedFields: ['visible'],
          omittedFields: 1,
        },
        artifactRefs: {
          source: 1,
          included: 0,
          omittedByPolicy: 1,
          omittedByBudget: 0,
        },
      },
    })
  })

  it('uses an explicit compatibility receipt when no plugin policy was pinned', () => {
    const projected = projectNodeContext({ node: node(), contextRole: 'full' })
    expect(projected.text).toBe('A😀BCD')
    expect(projected.payload).toEqual({ visible: { count: 2 }, secret: 'do-not-project' })
    expect(projected.artifactRefs).toHaveLength(1)
    expect(projected.receipt).toMatchObject({
      policySource: 'compatibility',
      text: { truncated: false },
      payload: { includedFields: ['secret', 'visible'], omittedFields: 0 },
      artifactRefs: { included: 1, omittedByPolicy: 0 },
    })
  })
})
