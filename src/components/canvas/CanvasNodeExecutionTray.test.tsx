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

it('requires an explicit click before approving compute code and environment', async () => {
  const pending = {
    executionId: 'execution_pending_compute',
    projectId: 'project', canvasBranch: 'main', nodeId: 'node-compute',
    nodeTypeRef: canvasNodeTypeRef('compute'), executorId: 'container-compute',
    artifactRunId: 'execution-artifacts-pending', inputsDigest: 'a'.repeat(64),
    codeDigest: 'b'.repeat(64), environmentDigest: 'c'.repeat(64), cacheKey: 'd'.repeat(64),
    status: 'awaiting-approval', outputs: {}, startedAt: '2026-08-17T00:00:00.000Z',
  }
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST' && String(input).includes('/approval')
      ? Response.json({ schemaVersion: 1, execution: { ...pending, status: 'running' } }, { status: 202 })
      : Response.json({ schemaVersion: 1, executions: [pending] }))
  vi.stubGlobal('fetch', fetch)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(
    <CanvasNodeExecutionTray
      node={{
        id: 'node-compute', typeRef: canvasNodeTypeRef('compute'),
        ...canvasNodeGeometry({ x: 0, y: 0, w: 420, h: 240, z: 1 }),
        title: 'Compute', artifactRefs: [], origin: { kind: 'user' },
      }}
      projectDir="/workspace/project"
      branch="main"
      executable={false}
    />,
  ))
  await vi.waitFor(() => expect(host.textContent).toContain('批准此代码与环境'))
  await act(async () => {
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('批准此代码与环境'))?.click()
    await vi.waitFor(() => expect(fetch.mock.calls.some(([input]) =>
      String(input).includes('/executions/execution_pending_compute/approval'))).toBe(true))
  })
  const approval = fetch.mock.calls.find(([input]) => String(input).includes('/approval'))
  expect(approval?.[1]).toEqual(expect.objectContaining({
    method: 'POST', body: JSON.stringify({ approve: true }),
  }))
  act(() => root.unmount())
})
