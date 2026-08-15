import { describe, expect, it } from 'vitest'
import {
  promotedTaskInputsForOutputSlot,
  selectDirectTaskInputEdges,
} from './contextEdges'
import type { CanvasEdge } from './model'

function edge(
  id: string,
  sourceId: string,
  contextRole: CanvasEdge['contextRole'],
  target: CanvasEdge['to'] = { kind: 'node', id: 'slot' },
): CanvasEdge {
  return {
    id,
    from: { kind: 'node', id: sourceId },
    to: target,
    relation: 'references',
    contextRole,
    origin: { kind: 'user' },
  }
}

describe('Canvas context edge semantics', () => {
  it('uses one selector for direct Task inputs and excludes visual-only edges', () => {
    const edges = [
      edge('full', 'full-source', 'full', { kind: 'task', id: 'target' }),
      edge('summary', 'summary-source', 'summary', { kind: 'task', id: 'target' }),
      edge('none', 'visual-source', 'none', { kind: 'task', id: 'target' }),
      edge('other', 'other-source', 'full', { kind: 'task', id: 'other' }),
    ]

    expect(selectDirectTaskInputEdges(edges, 'target').map((entry) => entry.id))
      .toEqual(['full', 'summary'])
  })

  it('deduplicates promoted sources and keeps the strongest context role', () => {
    const edges = [
      edge('summary', 'same-source', 'summary'),
      edge('full', 'same-source', 'full'),
      edge('none', 'visual-source', 'none'),
      edge('second', 'second-source', 'summary'),
    ]

    expect(promotedTaskInputsForOutputSlot(edges, 'slot')).toEqual([
      {
        from: { kind: 'node', id: 'same-source' },
        contextRole: 'full',
      },
      {
        from: { kind: 'node', id: 'second-source' },
        contextRole: 'summary',
      },
    ])
  })
})
