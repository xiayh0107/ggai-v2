import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import type { CanvasTaskRunDaemonApi } from '@/agent/taskRunClient'
import { emptyCanvasDocument, type CanvasDocument } from '@/canvas/model'
import {
  CanvasPersistence,
  MemoryCanvasPersistenceAdapter,
} from '@/canvas/persistence'
import { CanvasProvider } from '@/canvas/provider'
import {
  CanvasTaskRunProvider,
  type CanvasTaskRunControllerFactoryInput,
  type CanvasTaskRunControllerLike,
} from '@/canvas/runProvider'
import type {
  CanvasRunTaskInput,
  CanvasTaskRunClose,
  CanvasTaskRunHandle,
  CanvasTaskRunLogEntry,
  CanvasTaskRunSummary,
} from '@/canvas/runController'
import { CanvasStore } from '@/canvas/store'
import CanvasTaskRunPanel from '@/components/canvas/CanvasTaskRunPanel'

interface UiRenderScenario {
  id: string
  title: string
  render(): ReactElement
}

const task = {
  id: 'task-ui-render',
  title: '制作研究结果图',
  goal: '根据已有材料生成一张清晰的研究结果图',
  anchor: { x: 120, y: 90 },
  origin: { kind: 'user' as const },
}

const scenarios: readonly UiRenderScenario[] = [{
  id: 'task-run-draft',
  title: '空输出节点 · 默认运行面板',
  render: () => <TaskRunDraftScenario />,
}]

export function getUiRenderScenario(id: string): UiRenderScenario {
  const scenario = scenarios.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Unknown UI render scenario: ${id}`)
  return scenario
}

function TaskRunDraftScenario() {
  const store = useMemo(() => createStore(), [])
  const controller = useMemo(() => new RenderController(), [])
  const daemonClient = useMemo(renderDaemonClient, [])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(() => {
    if (state.hydration.status !== 'ready') return
    let cancelled = false
    void document.fonts.ready.then(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })).then(() => {
      if (!cancelled) document.documentElement.dataset.uiRenderReady = 'true'
    })
    return () => {
      cancelled = true
      delete document.documentElement.dataset.uiRenderReady
    }
  }, [state.hydration.status])

  return (
    <div
      data-ui-render-scenario="task-run-draft"
      className="flex h-screen w-screen items-center justify-center overflow-hidden bg-gg-bg p-12 font-sans text-gg-ink"
    >
      <CanvasProvider store={store}>
        <CanvasTaskRunProvider
          store={store}
          daemonClient={daemonClient}
          controllerFactory={controller.factory}
        >
          <div className="w-[460px]">
            <CanvasTaskRunPanel task={task} width={460} />
          </div>
        </CanvasTaskRunProvider>
      </CanvasProvider>
    </div>
  )
}

function createStore(): CanvasStore {
  const document = createDocument()
  return new CanvasStore({
    daemonBaseUrl: 'http://127.0.0.1:7380',
    scope: { projectDir: '/ui-render/project', branch: 'main' },
    persistence: new CanvasPersistence({
      adapter: new MemoryCanvasPersistenceAdapter(),
    }),
    client: {
      getCanvas: async () => ({
        branch: 'main',
        revision: 12,
        updatedAt: '2026-08-16T00:00:00.000Z',
        lastMutationId: null,
        document,
      }),
      flushOutbox: async () => ({
        status: 'flushed',
        acknowledged: 0,
        envelope: null,
      }),
    },
  })
}

function createDocument(): CanvasDocument {
  const document = emptyCanvasDocument()
  document.everCreated = true
  document.tasks.push(task)
  document.nodes.push({
    id: 'node-ui-render',
    type: 'image',
    frame: { x: 180, y: 180, w: 420, h: 280, z: 1 },
    title: '研究结果图',
    artifactRefs: [],
    homeTaskId: task.id,
    origin: { kind: 'user' },
  })
  return document
}

function renderDaemonClient(): CanvasTaskRunDaemonApi {
  return {
    resolvePermission: async () => undefined,
  } as unknown as CanvasTaskRunDaemonApi
}

class RenderController implements CanvasTaskRunControllerLike {
  readonly factory = (
    _input: CanvasTaskRunControllerFactoryInput,
  ): CanvasTaskRunControllerLike => this

  runTask(_input: CanvasRunTaskInput): Promise<CanvasTaskRunHandle> {
    return Promise.reject(new Error('UI render scenarios do not start real Runs'))
  }

  recoverAll(): Promise<CanvasTaskRunHandle[]> {
    return Promise.resolve([])
  }

  cancelTask(_taskId: string): Promise<CanvasTaskRunClose | null> {
    return Promise.resolve(null)
  }

  getRunLog(_runId: string): readonly CanvasTaskRunLogEntry[] {
    return []
  }

  readTaskRunSummary(_runId: string): Promise<CanvasTaskRunSummary> {
    return Promise.reject(new Error('The baseline scenario has no historical Run'))
  }

  readTaskRunLog(_runId: string, _afterEventId: number) {
    return Promise.resolve({ entries: [], nextEventId: null, closed: false })
  }

  dispose(): void {
    // The render harness owns no external resources.
  }
}
