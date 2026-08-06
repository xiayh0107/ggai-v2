// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { emptyCanvasDocumentV2 } from '@/canvas-v2/model'
import { selectTaskViewV2 } from '@/canvas-v2/selectors'
import CanvasV2EdgeLayer, { type CanvasV2EdgePreview } from './CanvasV2EdgeLayer'

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

describe('CanvasV2EdgeLayer drag preview', () => {
  it('moves an edge endpoint with the output Node of a dragged Task', () => {
    const canvasDocument = emptyCanvasDocumentV2()
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
    const taskView = selectTaskViewV2(canvasDocument, 'task-plot', { zoom: 1 })
    expect(taskView).not.toBeNull()

    const render = (preview: CanvasV2EdgePreview) => {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      act(() => root?.render(
        <CanvasV2EdgeLayer
          document={canvasDocument}
          taskViewsById={new Map([['task-plot', taskView!]])}
          collectionViewsById={new Map()}
          collapsedCollectionIds={new Set()}
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
})
