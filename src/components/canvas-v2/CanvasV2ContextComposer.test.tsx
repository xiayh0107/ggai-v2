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

  it('attaches to a generated Node and restores the exact immutable Run prompt', async () => {
    const fakeStore = new FakeStore()
    fakeStore.state.document.tasks.push({
      id: 'task-origin',
      title: '生成散点图',
      goal: '旧任务目标不能代替本次 Run prompt',
      anchor: { x: 120, y: 80 },
      origin: { kind: 'user' },
    })
    fakeStore.state.document.nodes.push({
      id: 'node-image',
      type: 'image',
      frame: { x: 160, y: 180, w: 300, h: 240, z: 1 },
      title: '散点图预览',
      artifactRefs: [],
      homeTaskId: 'task-origin',
      origin: {
        kind: 'agent-output',
        taskId: 'task-origin',
        runId: 'run-exact-prompt',
        planId: `plan_${'a'.repeat(64)}`,
        outputKey: 'preview',
      },
    })
    fakeStore.state.document.receipts.push({
      kind: 'materialization',
      planId: `plan_${'a'.repeat(64)}`,
      runId: 'run-exact-prompt',
      taskId: 'task-origin',
      outcomes: [{ outputKey: 'preview', nodeId: 'node-image' }],
      dismissedProposalKeys: [],
    })
    fakeStore.state.view.selection = [{ kind: 'node', id: 'node-image' }]
    const store = fakeStore as unknown as CanvasV2Store
    const startTaskMock = vi.fn(async (input: CanvasV2RunTaskInput) => ({
      taskId: input.taskId,
      runId: 'run-derived',
      completion: new Promise(() => undefined),
      detach: () => undefined,
    }))
    const readTaskRunSummary = vi.fn(async () => ({
      runId: 'run-exact-prompt',
      taskId: 'task-origin',
      agentId: 'codex',
      canvasBranch: 'main',
      baseRevision: 17,
      prompt: '展示生成的图片，并保留 ggplot 源代码',
      status: 'done' as const,
      startedAt: 1,
    }))
    const lifecycle = {
      startTask: startTaskMock,
      readTaskRunSummary,
      getSuggestedActions: () => [],
    } as unknown as CanvasV2TaskRunLifecycle
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasV2Context.Provider value={store}>
          <CanvasV2TaskRunContext.Provider value={lifecycle}>
            <CanvasV2ContextComposer
              getAnchor={() => ({ x: 320, y: 240 })}
              selectionBounds={{ x: 160, y: 180, w: 300, h: 240 }}
              getViewport={() => ({ left: 0, top: 0, width: 1_000, height: 800 })}
            />
          </CanvasV2TaskRunContext.Provider>
        </CanvasV2Context.Provider>,
      )
    })

    await vi.waitFor(() => {
      expect((container?.querySelector('textarea') as HTMLTextAreaElement).value)
        .toBe('展示生成的图片，并保留 ggplot 源代码')
    })
    expect(readTaskRunSummary).toHaveBeenCalledWith('run-exact-prompt')
    expect(container?.querySelector('form')?.dataset.attached).toBe('true')
    expect(container?.querySelector('[data-testid="canvas-v2-node-provenance"]')?.textContent)
      .toContain('由“生成散点图”的提示词生成')
    expect(container?.querySelector('[data-testid="canvas-v2-node-provenance-prompt"]')?.textContent)
      .toContain('展示生成的图片，并保留 ggplot 源代码')
    expect(container?.textContent).toContain('Canvas r17')

    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    await act(async () => {
      valueSetter?.call(textarea, '调整配色并生成新图')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(() => {
      expect((container?.querySelector('textarea') as HTMLTextAreaElement).value)
        .toBe('调整配色并生成新图')
      expect((container?.querySelector('button[type="submit"]') as HTMLButtonElement).disabled)
        .toBe(false)
    })
    await act(async () => {
      ;(container?.querySelector('button[type="submit"]') as HTMLButtonElement).click()
      await vi.waitFor(() => expect(startTaskMock).toHaveBeenCalledOnce())
    })

    expect(fakeStore.getSnapshot().document.nodes.find((node) => node.id === 'node-image'))
      .toMatchObject({ title: '散点图预览', homeTaskId: 'task-origin' })
    const derivedTask = fakeStore.getSnapshot().document.tasks.find((task) =>
      task.id !== 'task-origin')
    expect(derivedTask).toMatchObject({ goal: '调整配色并生成新图' })
    expect(fakeStore.getSnapshot().document.edges).toContainEqual(expect.objectContaining({
      from: { kind: 'node', id: 'node-image' },
      to: { kind: 'task', id: derivedTask?.id },
      relation: 'modified',
      contextRole: 'full',
    }))
  })
})
