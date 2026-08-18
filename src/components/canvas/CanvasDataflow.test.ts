import { describe, expect, it } from 'vitest'
import type { PortDefinition } from '@/plugins/nodeTypeContracts'
import { resolveDataPortConnection } from './CanvasDataflow'

const output: PortDefinition = {
  key: 'content', direction: 'output', schema: 'ggai://value/text', cardinality: 'one',
}
const input: PortDefinition = {
  key: 'content-in', direction: 'input', schema: 'ggai://value/text', cardinality: 'one',
}

describe('Canvas dataflow connection', () => {
  it('creates ordered data edges only for compatible output-to-input ports', () => {
    expect(resolveDataPortConnection({
      source: { kind: 'node', id: 'source', dataPort: output },
      target: { kind: 'node', id: 'target', dataPort: input },
      edges: [],
      edgeId: 'edge-data',
    })).toMatchObject({
      handled: true,
      edge: {
        relation: 'data',
        contextRole: 'none',
        from: { port: 'content' },
        to: { port: 'content-in' },
      },
    })
  })

  it('rejects reversed, incompatible, and occupied cardinality-one ports', () => {
    expect(resolveDataPortConnection({
      source: { kind: 'node', id: 'source', dataPort: input },
      target: { kind: 'node', id: 'target', dataPort: output },
      edges: [], edgeId: 'edge-data',
    })).toMatchObject({ handled: true, error: expect.stringContaining('output') })
    expect(resolveDataPortConnection({
      source: { kind: 'node', id: 'source', dataPort: output },
      target: { kind: 'node', id: 'target', dataPort: { ...input, schema: 'ggai://value/json' } },
      edges: [], edgeId: 'edge-data',
    })).toMatchObject({ handled: true, error: expect.stringContaining('不兼容') })
  })
})
