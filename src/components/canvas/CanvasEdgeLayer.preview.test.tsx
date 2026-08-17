// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { emptyCanvasDocument } from '@/canvas/model'
import { selectTaskView } from '@/canvas/selectors'
import CanvasEdgeLayer, { type CanvasEdgePreview } from './CanvasEdgeLayer'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe('CanvasEdgeLayer drag preview', () => {
  it('moves an edge endpoint with the output Node of a dragged Task', () => {
    const canvasDocument = emptyCanvasDocument()
    canvasDocument.tasks.push({
      id: 'task-plot',
      title: 'Plot task',
      goal: 'Create a plot',
      anchor: { x: 80, y: 60 },
      origin: { kind: 'user' },
    })
    canvasDocument.nodes.push(
      {
        id: 'node-output',
        type: 'image',
        frame: { x: 100, y: 100, w: 100, h: 80, z: 1 },
        title: 'Task output',
        artifactRefs: [],
        homeTaskId: 'task-plot',
        origin: { kind: 'user' },
      },
      {
        id: 'node-target',
        type: 'text',
        frame: { x: 500, y: 100, w: 100, h: 80, z: 2 },
        title: 'Target',
        artifactRefs: [],
        origin: { kind: 'user' },
      },
    )
    canvasDocument.edges.push({
      id: 'edge-output-target',
      from: { kind: 'node', id: 'node-output' },
      to: { kind: 'node', id: 'node-target' },
      relation: 'references',
      contextRole: 'summary',
      origin: { kind: 'user' },
    })
    const taskView = selectTaskView(canvasDocument, 'task-plot', { zoom: 1 })
    expect(taskView).not.toBeNull()

    const render = (preview: CanvasEdgePreview) => {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      act(() => root?.render(
        <CanvasEdgeLayer
          document={canvasDocument}
          taskViewsById={new Map([['task-plot', taskView!]])}
          collectionViewsById={new Map()}
          collapsedCollectionIds={new Set()}
          taskIdsWithoutTopChrome={new Set()}
          preview={preview}
          nodeFrames={new Map()}
          onDeleteEdges={() => undefined}
        />,
      ))
      return container.querySelector('path[stroke="#7DA7E8"]')?.getAttribute('d')
    }

    const restingPath = render(null)
    act(() => root?.unmount())
    root = null
    container?.remove()
    container = null
    const previewPath = render({ kind: 'task', id: 'task-plot', dx: 40, dy: 20 })

    expect(restingPath).toBe('M 200 140 C 305 140, 395 140, 500 140')
    expect(previewPath).toBe('M 240 160 C 331 160, 409 140, 500 140')
  })

  it('announces agent-only connections as read-only and ignores delete keys', () => {
    const canvasDocument = emptyCanvasDocument()
    canvasDocument.nodes.push(
      {
        id: 'node-source',
        type: 'text',
        frame: { x: 100, y: 100, w: 100, h: 80, z: 1 },
        title: 'Source',
        artifactRefs: [],
        origin: { kind: 'user' },
      },
      {
        id: 'node-target',
        type: 'text',
        frame: { x: 500, y: 100, w: 100, h: 80, z: 2 },
        title: 'Target',
        artifactRefs: [],
        origin: { kind: 'user' },
      },
    )
    canvasDocument.edges.push({
      id: 'edge-agent',
      from: { kind: 'node', id: 'node-source' },
      to: { kind: 'node', id: 'node-target' },
      relation: 'references',
      contextRole: 'summary',
      origin: { kind: 'agent', runId: 'run-1', planId: 'plan-1' },
    })
    const deleted: string[][] = []
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root?.render(
      <CanvasEdgeLayer
        document={canvasDocument}
        taskViewsById={new Map()}
        collectionViewsById={new Map()}
        collapsedCollectionIds={new Set()}
        taskIdsWithoutTopChrome={new Set()}
        preview={null}
        nodeFrames={new Map()}
        onDeleteEdges={(edgeIds) => deleted.push(edgeIds)}
      />,
    ))

    const bundle = container.querySelector<SVGGElement>('[data-edge-bundle-count]')
    expect(bundle?.getAttribute('role')).toBe('group')
    expect(bundle?.getAttribute('aria-label')).toContain('Agent 创建的连接，只读')
    act(() => bundle?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    })))
    expect(deleted).toEqual([])
  })
})
