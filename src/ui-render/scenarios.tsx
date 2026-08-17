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
import {
  emptyCanvasDocument,
  type CanvasDocument,
  type CanvasTask,
} from '@/canvas/model'
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
import type { CanvasTaskRuntime, CanvasTaskStatus } from '@/canvas/selectors'
import CanvasNodeCard from '@/components/canvas/CanvasNodeCard'
import CanvasRunLogViewer from '@/components/canvas/CanvasRunLogViewer'
import CanvasTaskRunPanel from '@/components/canvas/CanvasTaskRunPanel'
import CanvasWorkbench from '@/components/canvas/CanvasWorkbench'
import type { NodeDefinitionApi } from '@/node-studio/client'
import { createBlankCustomNodeManifest } from '@/node-studio/model'
import NodeStudio from '@/pages/NodeStudio'
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

const lifecycleTask: CanvasTask = {
  id: 'task-node-lifecycle',
  title: '形成研究结论',
  goal: '梳理现有证据，形成一段清晰、可引用的研究结论',
  anchor: { x: 120, y: 90 },
  origin: { kind: 'user' },
}
const LIFECYCLE_NODE_ID = 'node-lifecycle-output'
const LIFECYCLE_RUN_ID = 'run-node-lifecycle'
const LIFECYCLE_LOGS: readonly CanvasTaskRunLogEntry[] = [
  { eventId: 1, kind: 'thinking', text: '正在核对材料中的主要证据与限制条件。' },
  { eventId: 2, kind: 'tool', text: '→ read_evidence {"scope":"selected attachments"}' },
  { eventId: 3, kind: 'tool', text: '← 已读取 4 项可信材料' },
  { eventId: 4, kind: 'text', text: '已形成结论，并保留不确定性说明。' },
]

type NodeLifecyclePhase = 'empty' | 'generating' | 'complete' | 'failed'

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
    id: 'node-lifecycle-empty',
    title: '空节点 · Task 准备生成',
    render: () => <NodeLifecycleScenario id="node-lifecycle-empty" phase="empty" />,
  },
  {
    id: 'node-lifecycle-generating',
    title: '生成中节点 · Task 持续控权',
    render: () => <NodeLifecycleScenario id="node-lifecycle-generating" phase="generating" />,
  },
  {
    id: 'node-lifecycle-complete',
    title: '完成节点 · 内容与轻量活动摘要',
    render: () => <NodeLifecycleScenario id="node-lifecycle-complete" phase="complete" />,
  },
  {
    id: 'node-lifecycle-failed',
    title: '失败节点 · 空槽回到 Task 重试',
    render: () => <NodeLifecycleScenario id="node-lifecycle-failed" phase="failed" />,
  },
  {
    id: 'node-process-drawer',
    title: '完成节点 · 过程进入右侧抽屉',
    render: () => (
      <NodeLifecycleScenario id="node-process-drawer" phase="complete" showProcessDrawer />
    ),
  },
  {
    id: 'node-studio-lifecycle',
    title: 'Node Studio · 画布生命周期与平台边界',
    render: () => (
      <MemoryRouter>
        <NodeStudio api={renderNodeDefinitionApi()} />
      </MemoryRouter>
    ),
  },
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

function NodeLifecycleScenario({
  id,
  phase,
  showProcessDrawer = false,
}: {
  id: string
  phase: NodeLifecyclePhase
  showProcessDrawer?: boolean
}) {
  const document = useMemo(() => createLifecycleDocument(phase), [phase])
  const store = useMemo(() => createStore(document), [document])
  const controller = useMemo(() => new RenderController({
    summary: {
      runId: LIFECYCLE_RUN_ID,
      taskId: lifecycleTask.id,
      agentId: 'ui-render-agent',
      canvasBranch: 'main',
      baseRevision: 12,
      prompt: lifecycleTask.goal,
      status: phase === 'failed' ? 'error' : phase === 'generating' ? 'running' : 'done',
      startedAt: Date.parse('2026-08-16T00:00:00.000Z'),
      ...(phase === 'failed' ? { error: '生成过程意外中断' } : {}),
    },
    detailLogs: LIFECYCLE_LOGS,
  }), [phase])
  const daemonClient = useMemo(() => renderDaemonClient(), [])
  const preflightApi = useMemo<TaskRunPreflightApi>(() => ({
    check: async () => structuredClone(READY),
  }), [])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const runtime = lifecycleRuntime(phase)

  useEffect(() => {
    if (state.hydration.status !== 'ready') return
    if (state.view.selection.length !== 1
      || state.view.selection[0]?.kind !== 'node'
      || state.view.selection[0].id !== LIFECYCLE_NODE_ID) {
      store.setSelection([{ kind: 'node', id: LIFECYCLE_NODE_ID }])
    }
    if (runtime && state.runtimeByTaskId[lifecycleTask.id]?.phase !== runtime.phase) {
      store.setTaskRuntime(runtime)
    }
  }, [runtime, state.hydration.status, state.runtimeByTaskId, state.view.selection, store])

  const node = state.document.nodes.find((candidate) => candidate.id === LIFECYCLE_NODE_ID)
  const taskStatus = lifecycleTaskStatus(phase)
  const settled = state.hydration.status === 'ready'
    && Boolean(node)
    && (runtime === undefined
      || state.runtimeByTaskId[lifecycleTask.id]?.phase === runtime.phase)

  return (
    <MemoryRouter>
      <CanvasProvider store={store}>
        <CanvasTaskRunProvider
          store={store}
          daemonClient={daemonClient}
          controllerFactory={controller.factory}
        >
          <div
            data-ui-render-scenario={id}
            data-ui-render-settled={settled ? 'true' : 'false'}
            className="relative h-screen w-screen overflow-hidden bg-gg-bg font-sans text-gg-ink"
          >
            <div
              className={`relative flex h-full ${
                showProcessDrawer ? 'items-center justify-start pl-24' : 'items-center justify-center'
              }`}
              style={{
                backgroundImage: 'radial-gradient(#D8E2F0 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            >
              <div className="flex w-[460px] flex-col gap-6">
                <div className="relative h-[300px] w-[460px]">
                  {node && (
                    <CanvasNodeCard
                      node={node}
                      frame={{ ...node.frame, x: 0, y: 0 }}
                      projectDir="/ui-render/project"
                      selected
                      compact={false}
                      taskStatus={taskStatus}
                      taskRunId={phase === 'empty' ? undefined : LIFECYCLE_RUN_ID}
                      controlsLocked={phase !== 'complete'}
                      tabIndex={0}
                      onFocus={() => undefined}
                      onKeyDown={() => undefined}
                      onDragStart={() => undefined}
                      onResizeStart={() => undefined}
                      onMenuAction={() => undefined}
                      registerFocusable={() => undefined}
                    />
                  )}
                </div>
                {!showProcessDrawer && (
                  <CanvasTaskRunPanel
                    task={lifecycleTask}
                    width={460}
                    preflightApi={preflightApi}
                  />
                )}
              </div>
            </div>

            {showProcessDrawer && (
              <CanvasRunLogViewer
                request={{
                  runId: LIFECYCLE_RUN_ID,
                  title: '研究结论',
                  initialTab: 'process',
                }}
                onClose={() => undefined}
              />
            )}
          </div>
        </CanvasTaskRunProvider>
      </CanvasProvider>
    </MemoryRouter>
  )
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

function createStore(document = createDocument()): CanvasStore {
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

function createLifecycleDocument(phase: NodeLifecyclePhase): CanvasDocument {
  const document = emptyCanvasDocument()
  document.everCreated = true
  document.tasks.push(lifecycleTask)
  document.nodes.push({
    id: LIFECYCLE_NODE_ID,
    type: 'text',
    frame: { x: 180, y: 180, w: 460, h: 300, z: 1 },
    title: '研究结论',
    ...(phase === 'complete'
      ? {
          text: '现有证据支持干预方案能够稳定提升完成率；不同样本间仍存在差异，结论应保留适用范围说明。',
        }
      : {}),
    artifactRefs: [],
    homeTaskId: lifecycleTask.id,
    origin: phase === 'empty'
      ? { kind: 'user' }
      : {
          kind: 'agent-output',
          taskId: lifecycleTask.id,
          runId: LIFECYCLE_RUN_ID,
          planId: 'plan-node-lifecycle',
          outputKey: 'research-conclusion',
        },
  })
  return document
}

function lifecycleRuntime(phase: NodeLifecyclePhase): CanvasTaskRuntime | undefined {
  if (phase === 'empty') return undefined
  if (phase === 'generating') {
    return {
      taskId: lifecycleTask.id,
      runId: LIFECYCLE_RUN_ID,
      phase: 'running',
      progress: 0.56,
      message: '正在组织研究证据',
      ghosts: [],
    }
  }
  if (phase === 'failed') {
    return {
      taskId: lifecycleTask.id,
      runId: LIFECYCLE_RUN_ID,
      phase: 'error',
      message: '生成失败，可调整目标后重试',
      ghosts: [],
    }
  }
  return {
    taskId: lifecycleTask.id,
    runId: LIFECYCLE_RUN_ID,
    phase: 'done',
    progress: 1,
    message: '研究结论已生成',
    ghosts: [],
  }
}

function lifecycleTaskStatus(phase: NodeLifecyclePhase): CanvasTaskStatus | undefined {
  if (phase === 'generating') {
    return { kind: 'generating', label: '正在组织研究证据', progress: 0.56, live: 'off' }
  }
  if (phase === 'complete') {
    return { kind: 'done', label: '已完成', progress: 1, live: 'off' }
  }
  if (phase === 'failed') {
    return { kind: 'failed', label: '生成失败', live: 'off' }
  }
  return undefined
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

function renderNodeDefinitionApi(): NodeDefinitionApi {
  const definition = {
    ...createBlankCustomNodeManifest(new Date('2026-08-16T00:00:00.000Z')),
    revision: 3,
    installed: true,
    id: '@local/research-insight',
    label: '研究洞察',
    description: '承载证据支持的研究结论与适用范围',
    contentKind: 'text' as const,
    icon: 'text' as const,
    sampleTitle: '研究洞察示例',
    sampleContent: '主要证据支持该方案有效；仍需保留样本差异与适用范围说明。',
    placeholder: '补充证据，或说明需要重新组织的结论…',
    actions: ['补充证据', '压缩结论'],
  }
  return {
    list: async () => [structuredClone(definition)],
    save: async () => Promise.reject(new Error('UI render does not save node definitions')),
    delete: async () => Promise.reject(new Error('UI render does not delete node definitions')),
    startAgent: async () => Promise.reject(new Error('UI render does not start Node Studio runs')),
    getAgentRun: async () => Promise.reject(new Error('UI render has no Node Studio runs')),
    cancelAgentRun: async () => Promise.reject(new Error('UI render has no Node Studio runs')),
  }
}

class RenderController implements CanvasTaskRunControllerLike {
  readonly #summary?: CanvasTaskRunSummary
  readonly #detailLogs: readonly CanvasTaskRunLogEntry[]

  constructor(input: {
    summary?: CanvasTaskRunSummary
    detailLogs?: readonly CanvasTaskRunLogEntry[]
  } = {}) {
    this.#summary = input.summary
    this.#detailLogs = input.detailLogs ?? []
  }

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
    return this.#summary
      ? Promise.resolve(structuredClone(this.#summary))
      : Promise.reject(new Error('The baseline scenario has no historical Run'))
  }

  readTaskRunLog(_runId: string, afterEventId: number) {
    const entries = this.#detailLogs.filter((entry) => entry.eventId > afterEventId)
    return Promise.resolve({
      entries: structuredClone(entries),
      nextEventId: null,
      closed: this.#summary?.status === 'done'
        || this.#summary?.status === 'error'
        || this.#summary?.status === 'cancelled'
        || this.#summary?.status === 'interrupted',
    })
  }

  dispose(): void {
    // The render harness owns no external resources.
  }
}
