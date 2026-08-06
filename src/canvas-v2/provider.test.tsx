// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useCanvasV2State, useCanvasV2TaskView } from './hooks'
import { emptyCanvasDocumentV2 } from './model'
import { CanvasV2Persistence, MemoryCanvasV2PersistenceAdapter } from './persistence'
import { CanvasV2Provider } from './provider'
import { CanvasV2Store } from './store'

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

function Probe() {
  const state = useCanvasV2State()
  const task = useCanvasV2TaskView('task-1')
  return (
    <output data-hydration={state.hydration.status} data-status={task?.status.kind ?? 'missing'}>
      {task?.ghosts.length ?? 0}
    </output>
  )
}

describe('Canvas V2 React provider', () => {
  it('loads once and projects transient runtime updates through stable external snapshots', async () => {
    const canvasDocument = emptyCanvasDocumentV2()
    canvasDocument.tasks.push({
      id: 'task-1',
      title: 'Scatter plot',
      goal: 'Create a scatter plot',
      anchor: { x: 10, y: 20 },
      origin: { kind: 'user' },
    })
    const store = new CanvasV2Store({
      daemonBaseUrl: 'http://127.0.0.1:7380',
      scope: { projectDir: '/workspace/project', branch: 'main' },
      persistence: new CanvasV2Persistence({
        adapter: new MemoryCanvasV2PersistenceAdapter(),
      }),
      client: {
        getCanvas: async () => ({
          branch: 'main',
          revision: 0,
          updatedAt: '2026-08-05T00:00:00.000Z',
          lastMutationId: null,
          document: canvasDocument,
        }),
        flushOutbox: async () => ({ status: 'flushed', acknowledged: 0, envelope: null }),
      },
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasV2Provider store={store}>
          <Probe />
        </CanvasV2Provider>,
      )
    })

    await viWaitForOutput(container, 'ready', 'draft', '0')
    act(() => {
      store.setTaskRuntime({
        taskId: 'task-1',
        phase: 'running',
        ghosts: [{ key: 'preview', title: 'Preview', phase: 'writing' }],
      })
    })
    await viWaitForOutput(container, 'ready', 'generating', '1')
  })
})

async function viWaitForOutput(
  host: HTMLElement,
  hydration: string,
  status: string,
  text: string,
): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const output = host.querySelector('output')
  expect(output?.getAttribute('data-hydration')).toBe(hydration)
  expect(output?.getAttribute('data-status')).toBe(status)
  expect(output?.textContent).toBe(text)
}
