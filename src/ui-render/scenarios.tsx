/* eslint-disable react-refresh/only-export-components -- dedicated deterministic render registry */
import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import { MemoryRouter } from 'react-router'
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
import {
  CanvasWorkbenchControllerProvider,
  type CanvasWorkbenchSection,
} from '@/canvas/workbenchController'
import CanvasTaskRunPanel from '@/components/canvas/CanvasTaskRunPanel'
import CanvasWorkbench from '@/components/canvas/CanvasWorkbench'
import type {
  ProjectArtifactCatalogApi,
  ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'
import type { SkillAssetApi, SkillAssetCatalogPayload } from '@/skills/client'
import type { SkillAssetRef, SkillAssetSummary } from '@/skills/contracts'

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
const TYPE_SKILL: SkillAssetRef = {
  skillId: 'figure-layout',
  revision: 2,
  digest: 'e'.repeat(64),
}
const INSTANCE_SKILL: SkillAssetRef = {
  skillId: 'journal-style',
  revision: 1,
  digest: 'f'.repeat(64),
}
const SKILL_ASSETS: SkillAssetSummary[] = [
  {
    schemaVersion: 1,
    ...TYPE_SKILL,
    title: '科研图形布局',
    description: '将证据、结论与图例组织成清晰的期刊级图形。',
    entrypoint: 'SKILL.md',
    fileCount: 3,
    totalBytes: 12_480,
    importedAt: '2026-08-16T00:00:00.000Z',
    archived: false,
  },
  {
    schemaVersion: 1,
    ...INSTANCE_SKILL,
    title: '期刊视觉规范',
    description: '约束字体、留白、图例和注释层级。',
    entrypoint: 'SKILL.md',
    fileCount: 2,
    totalBytes: 8_192,
    importedAt: '2026-08-15T23:00:00.000Z',
    archived: false,
  },
]
const SKILL_CATALOG: SkillAssetCatalogPayload = {
  schemaVersion: 1,
  assets: SKILL_ASSETS,
  typeBindings: [{
    schemaVersion: 1,
    nodeType: 'image',
    revision: 4,
    skills: [TYPE_SKILL],
    updatedAt: '2026-08-16T00:10:00.000Z',
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
  {
    id: 'task-run-skills-summary',
    title: '空输出节点 · Skills 摘要入口',
    render: () => <TaskRunScenario id="task-run-skills-summary" preflight={READY} withSkills />,
  },
  {
    id: 'task-run-skills-workbench',
    title: '空输出节点 · 打开既有节点 Skills 工作台',
    render: () => (
      <TaskRunScenario
        id="task-run-skills-workbench"
        preflight={READY}
        withSkills
        workbenchSection="skills"
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
  withSkills = false,
  workbenchSection = null,
}: {
  id: string
  preflight: TaskRunPreflightResult
  initialAttachments?: readonly ProjectArtifactResource[]
  initialAttachmentPickerOpen?: boolean
  withSkills?: boolean
  workbenchSection?: CanvasWorkbenchSection | null
}) {
  const store = useMemo(() => createStore(), [])
  const controller = useMemo(() => new RenderController(), [])
  const daemonClient = useMemo(() => renderDaemonClient(), [])
  const preflightApi = useMemo<TaskRunPreflightApi>(() => ({
    check: async () => structuredClone(preflight),
  }), [preflight])
  const artifactCatalogApi = useMemo(() => renderArtifactApi(), [])
  const skillApi = useMemo(() => renderSkillApi(), [])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(() => {
    if (!withSkills || state.hydration.status !== 'ready') return
    if (state.view.selection.length === 1
      && state.view.selection[0]?.kind === 'node'
      && state.view.selection[0].id === 'node-ui-render') return
    store.setSelection([{ kind: 'node', id: 'node-ui-render' }])
  }, [state.hydration.status, state.view.selection, store, withSkills])

  const panel = (
    <div className={workbenchSection ? 'absolute right-12 top-28 w-[460px]' : 'w-[460px]'}>
      <CanvasTaskRunPanel
        task={task}
        width={460}
        preflightApi={preflightApi}
        artifactCatalogApi={artifactCatalogApi}
        initialAttachments={initialAttachments}
        initialAttachmentPickerOpen={initialAttachmentPickerOpen}
      />
    </div>
  )
  const runSurface = (
    <CanvasTaskRunProvider
      store={store}
      daemonClient={daemonClient}
      controllerFactory={controller.factory}
    >
      {panel}
      {workbenchSection && (
        <CanvasWorkbench
          projectId="ui-render-project"
          artifactApi={artifactCatalogApi}
          skillApi={skillApi}
          onOpenHistory={() => undefined}
        />
      )}
    </CanvasTaskRunProvider>
  )

  return (
    <MemoryRouter>
      <div
        data-ui-render-scenario={id}
        data-ui-render-settled={state.hydration.status === 'ready' ? 'true' : 'false'}
        className={`relative h-screen w-screen overflow-hidden bg-gg-bg font-sans text-gg-ink ${
          workbenchSection ? '' : 'flex items-center justify-center p-12'
        }`}
      >
        <CanvasProvider store={store}>
          {withSkills ? (
            <CanvasWorkbenchControllerProvider
              skillApi={skillApi}
              initialSection={workbenchSection}
            >
              {runSurface}
            </CanvasWorkbenchControllerProvider>
          ) : runSurface}
        </CanvasProvider>
      </div>
    </MemoryRouter>
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
    skillBindings: { inheritType: true, skills: [INSTANCE_SKILL] },
  })
  return document
}

function renderDaemonClient(): CanvasTaskRunDaemonApi {
  return {
    resolvePermission: async () => undefined,
  } as unknown as CanvasTaskRunDaemonApi
}

function renderArtifactApi(): ProjectArtifactCatalogApi {
  return {
    list: async () => ({
      schemaVersion: 2,
      artifacts: structuredClone(RESOURCES),
      truncated: false,
      partial: false,
      nextCursor: null,
    }),
    artifactUrl: () => 'about:blank',
  }
}

function renderSkillApi(): SkillAssetApi {
  return {
    list: async () => structuredClone(SKILL_CATALOG),
    import: async () => Promise.reject(new Error('UI render does not import Skills')),
    archive: async () => Promise.reject(new Error('UI render does not archive Skills')),
    updateTypeBindings: async () => Promise.reject(
      new Error('UI render does not update type bindings'),
    ),
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
