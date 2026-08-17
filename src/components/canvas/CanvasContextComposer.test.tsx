// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyCanvasCommand, type CanvasCommand } from '@/canvas/commands'
import { CanvasContext } from '@/canvas/hooks'
import { emptyCanvasDocument } from '@/canvas/model'
import type { CanvasSelectionTarget } from '@/canvas/persistence'
import { CanvasTaskRunContext } from '@/canvas/runHooks'
import type { CanvasTaskRunLifecycle } from '@/canvas/runProvider'
import type {
  CanvasRunTaskInput,
} from '@/canvas/runController'
import {
  defaultCanvasViewState,
  type CanvasStore,
  type CanvasStoreState,
} from '@/canvas/store'
import CanvasContextComposer, { attachedComposerStyle } from './CanvasContextComposer'

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
  state: CanvasStoreState = {
    scope: { projectDir: '/workspace/project', branch: 'main' },
    hydration: { status: 'ready', error: null },
    refresh: { status: 'idle', error: null },
    commandSync: { status: 'idle', pendingCount: 0, error: null, conflict: null },
    viewSync: { status: 'idle', error: null },
    envelope: null,
    document: emptyCanvasDocument(),
    view: defaultCanvasViewState(),
    runtimeByTaskId: {},
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.state

  async dispatchCommand(command: CanvasCommand): Promise<{ mutationId: string }> {
    this.state = {
      ...this.state,
      document: applyCanvasCommand(this.state.document, command),
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

  setSelection(selection: CanvasSelectionTarget[]): void {
    this.state = { ...this.state, view: { ...this.state.view, selection } }
    this.emit()
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }
}

describe('Canvas context composer', () => {
  it('keeps an above-node composer below the selection toolbar lane', () => {
    const style = attachedComposerStyle({
      bounds: { x: 160, y: 560, w: 300, h: 180 },
      camera: { x: 0, y: 0, zoom: 1 },
      viewport: { left: 0, top: 0, width: 1_000, height: 800 },
      compound: false,
      provenance: true,
      actions: false,
    })

    expect(Number(style.top)).toBeLessThan(560)
  })

  it('keeps a compound Node on the standard prompt-control width', () => {
    const style = attachedComposerStyle({
      bounds: { x: 100, y: 120, w: 1_000, h: 360 },
      camera: { x: 0, y: 0, zoom: 1 },
      viewport: { left: 0, top: 0, width: 1_200, height: 900 },
      compound: true,
      provenance: false,
      actions: false,
    })

    expect(style.width).toBe(430)
    expect(style.left).toBe(385)
  })

  it('describes multiple selected members as one compound Node', async () => {
    const fakeStore = new FakeStore()
    fakeStore.state.document.nodes.push(
      {
        id: 'node-a',
        type: 'text',
        frame: { x: 100, y: 120, w: 300, h: 220, z: 1 },
        title: '节点 A',
        text: 'A',
        artifactRefs: [],
        origin: { kind: 'user' },
      },
      {
        id: 'node-b',
        type: 'text',
        frame: { x: 460, y: 120, w: 300, h: 220, z: 2 },
        title: '节点 B',
        text: 'B',
        artifactRefs: [],
        origin: { kind: 'user' },
      },
    )
    fakeStore.state.view.selection = [
      { kind: 'node', id: 'node-a' },
      { kind: 'node', id: 'node-b' },
    ]
    const store = fakeStore as unknown as CanvasStore
    const lifecycle = {} as unknown as CanvasTaskRunLifecycle
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasContext.Provider value={store}>
          <CanvasTaskRunContext.Provider value={lifecycle}>
            <CanvasContextComposer
              getAnchor={() => ({ x: 320, y: 240 })}
              selectionBounds={{ x: 86, y: 72, w: 688, h: 282 }}
              getViewport={() => ({ left: 0, top: 0, width: 1_000, height: 800 })}
            />
          </CanvasTaskRunContext.Provider>
        </CanvasContext.Provider>,
      )
    })

    const composer = container?.querySelector<HTMLElement>('[data-testid="canvas-context-composer"]')
    expect(composer?.textContent).toContain('从“组合节点”创建任务')
    expect(composer?.textContent).toContain('2 个成员共同提供上下文')
    expect(Number.parseFloat(composer?.style.width ?? '')).toBeLessThanOrEqual(430)
  })

  it('persists the Task command before explicitly starting its first Run', async () => {
    const fakeStore = new FakeStore()
    const store = fakeStore as unknown as CanvasStore
    const startTaskMock = vi.fn(async (input: CanvasRunTaskInput) => {
      expect(fakeStore.getSnapshot().document.tasks.some((task) => task.id === input.taskId))
        .toBe(true)
      return {
        taskId: input.taskId,
        runId: 'run-context-composer',
        completion: new Promise(() => undefined),
        detach: () => undefined,
      }
    })
    const lifecycle = { startTask: startTaskMock } as unknown as CanvasTaskRunLifecycle
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasContext.Provider value={store}>
          <CanvasTaskRunContext.Provider value={lifecycle}>
            <CanvasContextComposer getAnchor={() => ({ x: 320, y: 240 })} />
          </CanvasTaskRunContext.Provider>
        </CanvasContext.Provider>,
      )
    })
    await vi.waitFor(() => {
      expect(container?.querySelector('textarea')).not.toBeNull()
    })
    expect(container?.querySelector('[data-testid="canvas-prompt-control"][data-mode="draft"]'))
      .not.toBeNull()
    expect(container?.querySelector('[data-testid="canvas-prompt-control-surface"]'))
      .not.toBeNull()

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

  it('adds a verified generated resource and submits its artifact identity to the Agent', async () => {
    const fakeStore = new FakeStore()
    const store = fakeStore as unknown as CanvasStore
    const startTaskMock = vi.fn(async (input: CanvasRunTaskInput) => ({
      taskId: input.taskId,
      runId: 'run-with-attachment',
      completion: new Promise(() => undefined),
      detach: () => undefined,
    }))
    const lifecycle = { startTask: startTaskMock } as unknown as CanvasTaskRunLifecycle
    const artifact = {
      runId: 'run-source',
      artifactId: `artifact_${'a'.repeat(64)}`,
      taskId: 'task-source',
      canvasBranch: 'main',
      relativePath: 'images/reference.png',
      mediaType: 'image/png',
      size: 2_048,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      createdAt: 1_700_000_000_000,
    }
    const list = vi.fn(async () => ({
      schemaVersion: 2 as const,
      artifacts: [artifact],
      truncated: false,
      partial: false,
      nextCursor: null,
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasContext.Provider value={store}>
          <CanvasTaskRunContext.Provider value={lifecycle}>
            <CanvasContextComposer
              getAnchor={() => ({ x: 320, y: 240 })}
              artifactCatalogApi={{ list }}
            />
          </CanvasTaskRunContext.Provider>
        </CanvasContext.Provider>,
      )
    })

    expect(container?.querySelector('[aria-label="添加附件"]')).not.toBeNull()
    await act(async () => {
      ;(container?.querySelector('button[aria-label="添加附件"]') as HTMLButtonElement).click()
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
    })
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: '/workspace/project',
      branch: 'main',
      limit: 60,
      signal: expect.any(AbortSignal),
    }))
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('reference.png')
    })
    await act(async () => {
      ;(document.querySelector('[role="checkbox"]') as HTMLButtonElement).click()
    })
    expect(container?.querySelector('[aria-label="已添加附件"]')?.textContent)
      .toContain('reference.png')

    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    await act(async () => {
      valueSetter?.call(textarea, '参考附件生成一张新图')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(container?.querySelector('button[type="submit"]') as HTMLButtonElement).click()
      await vi.waitFor(() => expect(startTaskMock).toHaveBeenCalledOnce())
    })

    expect(startTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '参考附件生成一张新图',
      attachments: [{
        kind: 'artifact',
        runId: 'run-source',
        artifactId: `artifact_${'a'.repeat(64)}`,
      }],
    }))
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
    const store = fakeStore as unknown as CanvasStore
    const startTaskMock = vi.fn(async (input: CanvasRunTaskInput) => ({
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
    } as unknown as CanvasTaskRunLifecycle
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasContext.Provider value={store}>
          <CanvasTaskRunContext.Provider value={lifecycle}>
            <CanvasContextComposer
              getAnchor={() => ({ x: 320, y: 240 })}
              selectionBounds={{ x: 160, y: 180, w: 300, h: 240 }}
              getViewport={() => ({ left: 0, top: 0, width: 1_000, height: 800 })}
            />
          </CanvasTaskRunContext.Provider>
        </CanvasContext.Provider>,
      )
    })

    await vi.waitFor(() => {
      expect((container?.querySelector('textarea') as HTMLTextAreaElement).value)
        .toBe('展示生成的图片，并保留 ggplot 源代码')
    })
    expect(readTaskRunSummary).toHaveBeenCalledWith('run-exact-prompt')
    expect(container?.querySelector<HTMLElement>('[data-testid="canvas-context-composer"]')
      ?.dataset.attached).toBe('true')
    expect(container?.querySelector('[data-testid="canvas-node-provenance"]')?.textContent)
      .toContain('由“生成散点图”的提示词生成')
    expect(container?.querySelector('[data-testid="canvas-node-provenance-prompt"]')?.textContent)
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
