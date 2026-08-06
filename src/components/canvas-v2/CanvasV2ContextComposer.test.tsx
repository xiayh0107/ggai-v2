// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyCanvasCommandV2, type CanvasCommandV2 } from '@/canvas-v2/commands'
import { CanvasV2Context } from '@/canvas-v2/hooks'
import { emptyCanvasDocumentV2 } from '@/canvas-v2/model'
import type { CanvasV2SelectionTarget } from '@/canvas-v2/persistence'
import { CanvasV2TaskRunContext } from '@/canvas-v2/runHooks'
import type { CanvasV2TaskRunLifecycle } from '@/canvas-v2/runProvider'
import type {
  CanvasV2RunTaskInput,
} from '@/canvas-v2/runController'
import {
  defaultCanvasV2ViewState,
  type CanvasV2Store,
  type CanvasV2StoreState,
} from '@/canvas-v2/store'
import CanvasV2ContextComposer from './CanvasV2ContextComposer'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  act(() => root?.unmount())
  await act(async () => Promise.resolve())
  root = null
  container?.remove()
  container = null
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

class FakeStore {
  readonly listeners = new Set<() => void>()
  state: CanvasV2StoreState = {
    scope: { projectDir: '/workspace/project', branch: 'main' },
    hydration: { status: 'ready', error: null },
    commandSync: { status: 'idle', pendingCount: 0, error: null, conflict: null },
    viewSync: { status: 'idle', error: null },
    envelope: null,
    document: emptyCanvasDocumentV2(),
    view: defaultCanvasV2ViewState(),
    runtimeByTaskId: {},
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.state

  async dispatchCommand(command: CanvasCommandV2): Promise<{ mutationId: string }> {
    this.state = {
      ...this.state,
      document: applyCanvasCommandV2(this.state.document, command),
    }
    this.emit()
    return { mutationId: 'context-command' }
  }

  setComposerDraft(key: string, draft: string): void {
    this.state = {
      ...this.state,
      view: {
        ...this.state.view,
        composerDrafts: { ...this.state.view.composerDrafts, [key]: draft },
      },
    }
    this.emit()
  }

  setSelection(selection: CanvasV2SelectionTarget[]): void {
    this.state = { ...this.state, view: { ...this.state.view, selection } }
    this.emit()
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }
}

describe('Canvas V2 context composer', () => {
  it('persists the Task command before explicitly starting its first Run', async () => {
    const fakeStore = new FakeStore()
    const store = fakeStore as unknown as CanvasV2Store
    const startTaskMock = vi.fn(async (input: CanvasV2RunTaskInput) => {
      expect(fakeStore.getSnapshot().document.tasks.some((task) => task.id === input.taskId))
        .toBe(true)
      return {
        taskId: input.taskId,
        runId: 'run-context-composer',
        completion: new Promise(() => undefined),
        detach: () => undefined,
      }
    })
    const lifecycle = { startTask: startTaskMock } as unknown as CanvasV2TaskRunLifecycle
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasV2Context.Provider value={store}>
          <CanvasV2TaskRunContext.Provider value={lifecycle}>
            <CanvasV2ContextComposer getAnchor={() => ({ x: 320, y: 240 })} />
          </CanvasV2TaskRunContext.Provider>
        </CanvasV2Context.Provider>,
      )
    })
    await vi.waitFor(() => {
      expect(container?.querySelector('textarea')).not.toBeNull()
    })

    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    await act(async () => {
      valueSetter?.call(textarea, '生成一个 ggplot 散点图')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(container?.querySelector('button[type="submit"]') as HTMLButtonElement).click()
      await vi.waitFor(() => expect(startTaskMock).toHaveBeenCalledOnce())
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const task = fakeStore.getSnapshot().document.tasks[0]
    expect(task).toMatchObject({
      title: '生成一个 ggplot 散点图',
      goal: '生成一个 ggplot 散点图',
      anchor: { x: 320, y: 240 },
    })
    expect(fakeStore.getSnapshot().view.selection).toEqual([{ kind: 'task', id: task?.id }])
    expect(startTaskMock).toHaveBeenCalledWith({
      taskId: task?.id,
      agentId: 'codex',
      prompt: '生成一个 ggplot 散点图',
    })
  })
})
