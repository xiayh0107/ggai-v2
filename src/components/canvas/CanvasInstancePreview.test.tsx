// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canvasNodeGeometry, canvasNodeTypeRef } from '@/canvas/model'

const store = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async () => undefined),
  flushCommands: vi.fn(async () => undefined),
}))

vi.mock('@/canvas/hooks', () => ({ useCanvasStore: () => store }))

import CanvasInstancePreview from './CanvasInstancePreview'

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  document.body.replaceChildren()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

it('previews a pinned revision and detaches through the opaque command', async () => {
  let resolveFetch!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve
  })))
  const response = () => Response.json({
    schemaVersion: 1,
    resolved: {
      nodes: [{
        id: 'instance', typeRef: canvasNodeTypeRef('text'),
        ...canvasNodeGeometry({ x: 0, y: 0, w: 320, h: 200, z: 1 }),
        title: 'Resolved text', artifactRefs: [], origin: { kind: 'user' },
      }],
      edges: [],
    },
  })
  const node = {
    id: 'instance', typeRef: canvasNodeTypeRef('instance'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 480, h: 200, z: 1 }),
    title: 'Instance', payload: { overrides: {} }, artifactRefs: [],
    instanceRef: { definitionId: 'template', revision: 3, digest: 'a'.repeat(64) },
    origin: { kind: 'user' as const },
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(
    <CanvasInstancePreview node={node} projectDir="." branch="main" />,
  ))
  await act(async () => {
    resolveFetch(response())
    await Promise.resolve()
  })
  expect(host.textContent).toContain('Resolved text')
  expect(host.textContent).toContain('template · rev 3')
  await act(async () => {
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('分离实例'))?.click()
    await vi.waitFor(() => expect(store.flushCommands).toHaveBeenCalledOnce())
  })
  expect(store.dispatchCommand).toHaveBeenCalledWith({
    type: 'DetachInstance', nodeId: 'instance',
  })
  act(() => root.unmount())
})
