/* eslint-disable react-refresh/only-export-components -- dedicated deterministic render registry */
import {
  useMemo,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import type { CanvasTaskRunDaemonApi } from '@/agent/taskRunClient'
import type {
  TaskRunPreflightApi,
  TaskRunPreflightResult,
} from '@/agent/taskRunPreflightClient'
import { emptyCanvasDocument, type CanvasDocument } from '@/canvas/model'
import {
  CanvasPersistence,
  MemoryCanvasPersistenceAdapter,
} from '@/canvas/persistence'
import { CanvasProvider } from '@/canvas/provider'
import {
  CanvasTaskRunProvider,
  type CanvasTaskRunControllerLike,
} from '@/canvas/runProvider'
import type {
  CanvasTaskRunClose,
  CanvasTaskRunHandle,
  CanvasTaskRunLogEntry,
  CanvasTaskRunSummary,
} from '@/canvas/runController'
import { CanvasStore } from '@/canvas/store'
import CanvasTaskRunPanel from '@/components/canvas/CanvasTaskRunPanel'
import type {
  ProjectArtifactCatalogApi,
  ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'

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

const READY: TaskRunPreflightResult = { status: 'ready', issues: [] }
const BLOCKED: TaskRunPreflightResult = {
  status: 'blocked',
  issues: [{
    code: 'generation_service_unauthenticated',
    message: '生成服务尚未登录，请完成登录后重试。',
    retryable: true,
  }],
}
const RESOURCES: ProjectArtifactResource[] = [
  {
    runId: 'run-reference-image',
    artifactId: `artifact_${'a'.repeat(64)}`,
    taskId: 'task-reference',
    canvasBranch: 'main',
    relativePath: 'figures/reference-layout.png',
    mediaType: 'image/png',
    size: 248_320,
    contentDigest: 'b'.repeat(64),
    createdAt: 1_765_843_200_000,
  },
  {
    runId: 'run-reference-table',
    artifactId: `artifact_${'c'.repeat(64)}`,
    taskId: 'task-reference-table',
    canvasBranch: 'main',
    relativePath: 'data/summary.csv',
    mediaType: 'text/csv',
    size: 18_432,
    contentDigest: 'd'.repeat(64),
    createdAt: 1_765_843_100_000,
  },
]

const scenarios: readonly UiRenderScenario[] = [
  {
    id: 'task-run-draft',
    title: '空输出节点 · 默认运行面板',
    render: () => <TaskRunScenario id="task-run-draft" preflight={READY} />,
  },
  {
    id: 'task-run-preflight-blocked',
    title: '空输出节点 · 生成服务需要处理',
    render: () => <TaskRunScenario id="task-run-preflight-blocked" preflight={BLOCKED} />,
  },
  {
    id: 'task-run-attachments',
    title: '空输出节点 · 从生成内容选择可信附件',
    render: () => (
      <TaskRunScenario
        id="task-run-attachments"
        preflight={READY}
        initialAttachments={[RESOURCES[0]]}
        initialAttachmentPickerOpen
      />
    ),
  },
]

export function getUiRenderScenario(id: string): UiRenderScenario {
  const scenario = scenarios.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Unknown UI render scenario: ${id}`)
  return scenario
}

function TaskRunScenario({
  id,
  preflight,
  initialAttachments = [],
  initialAttachmentPickerOpen = false,
}: {
  id: string
  preflight: TaskRunPreflightResult
  initialAttachments?: readonly ProjectArtifactResource[]
  initialAttachmentPickerOpen?: boolean
}) {
  const store = useMemo(() => createStore(), [])
  const controller = useMemo(() => new RenderController(), [])
  const daemonClient = useMemo(() => renderDaemonClient(), [])
  const preflightApi = useMemo<TaskRunPreflightApi>(() => ({
    check: async () => structuredClone(preflight),
  }), [preflight])
  const artifactCatalogApi = useMemo(() => renderArtifactApi(), [])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  return (
    <div
      data-ui-render-scenario={id}
      data-ui-render-settled={state.hydration.status === 'ready' ? 'true' : 'false'}
      className="flex h-screen w-screen items-center justify-center overflow-hidden bg-gg-bg p-12 font-sans text-gg-ink"
    >
      <CanvasProvider store={store}>
        <CanvasTaskRunProvider
          store={store}
          daemonClient={daemonClient}
          controllerFactory={controller.factory}
        >
          <div className="w-[460px]">
            <CanvasTaskRunPanel
              task={task}
              width={460}
              preflightApi={preflightApi}
              artifactCatalogApi={artifactCatalogApi}
              initialAttachments={initialAttachments}
              initialAttachmentPickerOpen={initialAttachmentPickerOpen}
            />
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

function renderArtifactApi(): Pick<ProjectArtifactCatalogApi, 'list'> {
  return {
    list: async () => ({
      schemaVersion: 2,
      artifacts: structuredClone(RESOURCES),
      truncated: false,
      partial: false,
      nextCursor: null,
    }),
  }
}

class RenderController implements CanvasTaskRunControllerLike {
  readonly factory = (): CanvasTaskRunControllerLike => this

  runTask(): Promise<CanvasTaskRunHandle> {
    return Promise.reject(new Error('UI render scenarios do not start real Runs'))
  }

  recoverAll(): Promise<CanvasTaskRunHandle[]> {
    return Promise.resolve([])
  }

  cancelTask(): Promise<CanvasTaskRunClose | null> {
    return Promise.resolve(null)
  }

  getRunLog(): readonly CanvasTaskRunLogEntry[] {
    return []
  }

  readTaskRunSummary(): Promise<CanvasTaskRunSummary> {
    return Promise.reject(new Error('The baseline scenario has no historical Run'))
  }

  readTaskRunLog() {
    return Promise.resolve({ entries: [], nextEventId: null, closed: false })
  }

  dispose(): void {
    // The render harness owns no external resources.
  }
}
