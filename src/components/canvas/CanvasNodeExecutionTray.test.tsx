// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canvasNodeGeometry, canvasNodeTypeRef } from '@/canvas/model'
import CanvasNodeExecutionTray from './CanvasNodeExecutionTray'

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

it('shows named output counts and pins a selected execution', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    schemaVersion: 1,
    executions: [{
      executionId: 'execution_0123456789abcdef0123456789abcdef',
      projectId: 'project',
      canvasBranch: 'main',
      nodeId: 'node-smart',
      nodeTypeRef: canvasNodeTypeRef('smart'),
      executorId: 'test',
      artifactRunId: 'execution-artifacts',
      inputsDigest: 'a'.repeat(64),
      environmentDigest: 'b'.repeat(64),
      cacheKey: 'c'.repeat(64),
      status: 'succeeded',
      outputs: { result: [{ kind: 'json', value: 1 }, { kind: 'json', value: 2 }] },
      startedAt: '2026-08-17T00:00:00.000Z',
      finishedAt: '2026-08-17T00:00:01.000Z',
    }],
  })))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onSelect = vi.fn()
  act(() => {
    root.render(
      <CanvasNodeExecutionTray
        node={{
          id: 'node-smart',
          typeRef: canvasNodeTypeRef('smart'),
          ...canvasNodeGeometry({ x: 0, y: 0, w: 320, h: 200, z: 1 }),
          title: 'Smart',
          artifactRefs: [],
          origin: { kind: 'user' },
        }}
        projectDir="/workspace/project"
        branch="main"
        executable={false}
        onSelect={onSelect}
      />,
    )
  })
  await vi.waitFor(() => expect(host.textContent).toContain('2 outputs'))
  act(() => [...host.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('outputs'))?.click())
  expect(onSelect).toHaveBeenCalledWith('execution_0123456789abcdef0123456789abcdef')
  act(() => root.unmount())
})
