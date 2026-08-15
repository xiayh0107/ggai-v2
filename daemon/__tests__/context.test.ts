import assert from 'node:assert/strict'
import test from 'node:test'
import {
  packLegacyCanvasContext,
  renderLegacyCanvasPrompt,
  type LegacyCanvasEdge,
  type LegacyCanvasNode,
} from '../legacyCanvasContext.js'

function node(id: string, text = id, attachments: string[] = []): LegacyCanvasNode {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    title: id,
    text,
    instruction: { attachments },
    payload: {},
  }
}

test('L2 includes the target, direct sources, and attachments but not remote ancestors', () => {
  const nodes = [
    node('ancestor', 'ancestor body'),
    node('source', 'source body'),
    node('target', 'target body', ['notes/reference.pdf']),
  ]
  const edges: LegacyCanvasEdge[] = [
    { id: 'e1', from: 'ancestor', to: 'source', label: 'source' },
    { id: 'e2', from: 'source', to: 'target', label: 'source' },
  ]
  const pack = packLegacyCanvasContext({ targetNodeId: 'target', nodes, edges, projectDir: '.' })

  assert.deepEqual(Object.keys(pack.sourceContents), ['target', 'source'])
  assert.deepEqual(pack.sourceContents.target?.attachments, ['notes/reference.pdf'])
  assert.equal(pack.graphSummary.nodes.length, 3)
  assert.equal(pack.graphSummary.edges.length, 2)
  assert.match(renderLegacyCanvasPrompt(pack, 'edit it'), /notes\/reference\.pdf/)
})

test('large ancestry chains are collected iteratively', () => {
  const size = 5_000
  const nodes = Array.from({ length: size }, (_, index) => node(`n_${index}`))
  const edges: LegacyCanvasEdge[] = Array.from({ length: size - 1 }, (_, index) => ({
    id: `e_${index}`,
    from: `n_${index}`,
    to: `n_${index + 1}`,
    label: 'source',
  }))
  const pack = packLegacyCanvasContext({
    targetNodeId: `n_${size - 1}`,
    nodes,
    edges,
    projectDir: '.',
  })
  assert.equal(pack.graphSummary.nodes.length, size)
  assert.equal(pack.graphSummary.edges.length, size - 1)
  assert.deepEqual(Object.keys(pack.sourceContents), [`n_${size - 1}`, `n_${size - 2}`])
})
