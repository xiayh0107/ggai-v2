import { describe, expect, it, vi } from 'vitest'
import type { CanvasAgentEvent } from '@/agent/types'
import { emptyCanvasDocument, type CanvasDocument } from './model'
import type { CanvasTaskRuntime } from './selectors'
import {
  CanvasTaskRunBusyError,
  CanvasTaskRunController,
  type CanvasRunIntent,
  type CanvasRunStore,
  type CanvasRunStoreSnapshot,
  type CanvasProjectionPlanNotice,
  type CanvasTaskRunClient,
  type CanvasTaskRunClose,
  type CanvasTaskRunSummary,
} from './runController'

function projectionPlan(
  runId: string,
  digestCharacter: string,
  overrides: Partial<CanvasProjectionPlanNotice> = {},
): CanvasProjectionPlanNotice {
  return {
    schemaVersion: 2,
    planId: `plan_${digestCharacter.repeat(64)}`,
    runId,
    taskId: 'task-a',
    status: 'complete',
    manifestDigest: 'e'.repeat(64),
    outputs: [{
      key: 'image',
      pluginId: 'image',
      role: 'primary',
      title: 'Image',
      artifactRefs: [{
        runId,
        artifactId: `artifact_${'f'.repeat(64)}`,
      }],
      derivedFrom: [],
      materialize: true,
    }],
    taskProposals: [],
    warnings: [],
    digest: digestCharacter.repeat(64),
    ...overrides,
  }
}

function taskDocument(...taskIds: string[]): CanvasDocument {
  return {
    ...emptyCanvasDocument(),
    everCreated: true,
    tasks: taskIds.map((id) => ({
      id,
      title: `Task ${id}`,
      goal: `Goal ${id}`,
      anchor: { x: 20, y: 30 },
      origin: { kind: 'user' as const },
    })),
  }
}

class FakeStore implements CanvasRunStore {
  readonly order: string[] = []
  reloadCount = 0
  snapshot: CanvasRunStoreSnapshot

  constructor(document = taskDocument('task-a')) {
    this.snapshot = {
      scope: { projectDir: '/project', branch: 'main' },
      hydration: { status: 'ready', error: null },
      commandSync: {
        status: 'saved',
        pendingCount: 0,
        error: null,
        conflict: null,
      },
      envelope: { branch: 'main', revision: 7, document },
      document,
      runtimeByTaskId: {},
    }
  }

  getSnapshot(): CanvasRunStoreSnapshot {
    return this.snapshot
  }

  async flushCommands(): Promise<void> {
    this.order.push('flush')
  }

  async reload(): Promise<void> {
    this.order.push('reload')
    this.reloadCount += 1
  }

  setTaskRuntime(runtime: CanvasTaskRuntime): void {
    this.order.push(`runtime:${runtime.phase}`)
    this.snapshot = {
      ...this.snapshot,
      runtimeByTaskId: {
        ...this.snapshot.runtimeByTaskId,
        [runtime.taskId]: structuredClone(runtime),
      },
    }
  }

  upsertTaskGhost(taskId: string, ghost: CanvasTaskRuntime['ghosts'][number]): void {
    const runtime = this.snapshot.runtimeByTaskId[taskId]
    if (!runtime) throw new Error('missing runtime')
    const ghosts = runtime.ghosts.filter((candidate) => candidate.key !== ghost.key)
    this.setTaskRuntime({ ...runtime, ghosts: [...ghosts, structuredClone(ghost)] })
  }

  clearTaskRuntime(taskId: string): void {
    const runtimeByTaskId = { ...this.snapshot.runtimeByTaskId }
    delete runtimeByTaskId[taskId]
    this.snapshot = { ...this.snapshot, runtimeByTaskId }
  }
}

interface PendingAttach {
  input: Parameters<CanvasTaskRunClient['attachTaskRun']>[0]
  resolve: (value: { close: CanvasTaskRunClose }) => void
  reject: (error: unknown) => void
}

class FakeClient implements CanvasTaskRunClient {
  readonly created: Array<{ projectDir: string; intent: CanvasRunIntent }> = []
  readonly attaches = new Map<string, PendingAttach>()
  readonly cancelled: string[] = []
  readonly readRunIds: string[] = []
  readonly summaryReads: Array<{ projectDir: string; runId: string }> = []
  readCount = 0
  summaries: CanvasTaskRunSummary[] = []
  summary: CanvasTaskRunSummary = {
    runId: 'run-origin',
    taskId: 'task-a',
    agentId: 'codex',
    canvasBranch: 'main',
    baseRevision: 7,
    prompt: 'Create the original chart.',
    status: 'done',
    startedAt: 1,
  }
  createError: unknown = null
  reconcileSummary: CanvasTaskRunSummary | null = null
  logEntries: Awaited<ReturnType<CanvasTaskRunClient['readTaskRunLog']>> = {
    entries: [],
    nextEventId: null,
  }

  async createTaskRun(input: {
    projectDir: string
    intent: CanvasRunIntent
  }): Promise<{ runId: string }> {
    this.created.push(structuredClone(input))
    if (this.createError) throw this.createError
    return { runId: input.intent.runId }
  }

  async reconcileTaskRun(): Promise<CanvasTaskRunSummary | null> {
    return this.reconcileSummary
  }

  async listTaskRuns(): Promise<readonly CanvasTaskRunSummary[]> {
    return this.summaries
  }

  async readTaskRunSummary(input: {
    projectDir: string
    runId: string
  }): Promise<CanvasTaskRunSummary> {
    this.summaryReads.push(structuredClone(input))
    return { ...this.summary, runId: input.runId }
  }

  async readTaskRunLog(input: {
    projectDir: string
    runId: string
    afterEventId: number
  }): Promise<{
    entries: Awaited<ReturnType<CanvasTaskRunClient['readTaskRunLog']>>['entries']
    nextEventId: number | null
  }> {
    this.readCount += 1
    this.readRunIds.push(input.runId)
    return this.logEntries
  }

  attachTaskRun(
    input: Parameters<CanvasTaskRunClient['attachTaskRun']>[0],
  ): Promise<{ close: CanvasTaskRunClose }> {
    return new Promise((resolve, reject) => {
      this.attaches.set(input.runId, { input, resolve, reject })
    })
  }

  async cancelTaskRun(input: { projectDir: string; runId: string }): Promise<void> {
    this.cancelled.push(input.runId)
  }

  emit(runId: string, id: number, data: CanvasAgentEvent): void {
    const attach = this.attaches.get(runId)
    if (!attach) throw new Error(`missing attach ${runId}`)
    attach.input.onEvent({ id, data })
  }

  close(close: CanvasTaskRunClose): void {
    const attach = this.attaches.get(close.runId)
    if (!attach) throw new Error(`missing attach ${close.runId}`)
    attach.resolve({ close })
  }
}

function controller(
  store: FakeStore,
  client: FakeClient,
  overrides: Partial<ConstructorParameters<typeof CanvasTaskRunController>[0]> = {},
): CanvasTaskRunController {
  let next = 0
  return new CanvasTaskRunController({
    store,
    client,
    runId: () => `run-${++next}`,
    ...overrides,
  })
}

describe('CanvasTaskRunController', () => {
  it('reads one immutable Task Run summary without changing runtime state', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client)

    await expect(subject.readTaskRunSummary('run-origin')).resolves.toEqual(client.summary)
    expect(client.summaryReads).toEqual([{ projectDir: '/project', runId: 'run-origin' }])
    expect(store.snapshot.runtimeByTaskId).toEqual({})
    expect(store.order).toEqual([])
  })

  it('maps durable run log pages into display entries with meta lines and close detection', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    client.logEntries = {
      entries: [
        { id: 1, event: 'session', data: { sessionId: 'session-1' } },
        { id: 2, event: 'agent-event', data: { type: 'thinking', text: 'planning' } },
        {
          id: 3,
          event: 'agent-event',
          data: { type: 'tool-call', name: 'read_file', input: { path: 'a.md' } },
        },
        { id: 4, event: 'agent-event', data: { type: 'tool-result', result: 'ok' } },
        { id: 5, event: 'agent-event', data: { type: 'text-delta', text: 'hello' } },
        { id: 6, event: 'agent-event', data: { type: 'error', message: 'boom' } },
        {
          id: 7,
          event: 'close',
          data: { runId: 'run-x', status: 'done', artifactsComplete: true },
        },
      ],
      nextEventId: null,
    }
    const subject = controller(store, client)

    const page = await subject.readTaskRunLog('run-x', 0)
    expect(page.closed).toBe(true)
    expect(page.nextEventId).toBeNull()
    expect(page.entries).toEqual([
      { eventId: 1, kind: 'meta', text: '建立会话 session-1' },
      { eventId: 2, kind: 'thinking', text: 'planning' },
      { eventId: 3, kind: 'tool', text: '→ read_file {"path":"a.md"}' },
      { eventId: 4, kind: 'tool', text: '← ok' },
      { eventId: 5, kind: 'text', text: 'hello' },
      { eventId: 6, kind: 'warning', text: 'boom' },
      { eventId: 7, kind: 'meta', text: '运行结束 · done' },
    ])
    expect(client.readRunIds).toEqual(['run-x'])
    expect(store.snapshot.runtimeByTaskId).toEqual({})
  })

  it('flushes first and sends the exact revision-owned RunIntent without a snapshot', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client)

    const handle = await subject.runTask({
      taskId: 'task-a',
      agentId: 'codex',
      prompt: 'Make a plot',
      attachments: [{ kind: 'node', nodeId: 'source-node' }],
    })

    expect(store.order.slice(0, 3)).toEqual(['flush', 'runtime:queued', 'runtime:running'])
    expect(client.created).toEqual([{
      projectDir: '/project',
      intent: {
        schemaVersion: 2,
        runId: 'run-1',
        taskId: 'task-a',
        agentId: 'codex',
        canvasBranch: 'main',
        baseRevision: 7,
        prompt: 'Make a plot',
        attachments: [{ kind: 'node', nodeId: 'source-node' }],
        materializationPolicy: 'auto',
      },
    }])
    expect(Object.keys(client.created[0]?.intent ?? {}).sort()).toEqual([
      'agentId',
      'attachments',
      'baseRevision',
      'canvasBranch',
      'materializationPolicy',
      'prompt',
      'runId',
      'schemaVersion',
      'taskId',
    ])
    expect(handle.runId).toBe('run-1')
    expect(store.snapshot.runtimeByTaskId['task-a']).toMatchObject({
      runId: 'run-1',
      phase: 'running',
    })
    expect(store.snapshot.runtimeByTaskId['task-a']).not.toHaveProperty('message')
  })

  it('fails closed after flush when hydration, outbox, or acknowledged envelope is unsafe', async () => {
    const store = new FakeStore()
    store.snapshot = {
      ...store.snapshot,
      commandSync: { ...store.snapshot.commandSync, pendingCount: 1, status: 'pending' },
    }
    const client = new FakeClient()

    await expect(controller(store, client).runTask({
      taskId: 'task-a',
      agentId: 'codex',
    })).rejects.toThrow('outbox is not empty')
    expect(store.order).toEqual(['flush'])
    expect(client.created).toHaveLength(0)
  })

  it('enforces per-Task single flight while allowing different Tasks to run in parallel', async () => {
    const store = new FakeStore(taskDocument('task-a', 'task-b'))
    const client = new FakeClient()
    const subject = controller(store, client)
    const first = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })

    await expect(subject.runTask({ taskId: 'task-a', agentId: 'codex' }))
      .rejects.toBeInstanceOf(CanvasTaskRunBusyError)
    const second = await subject.runTask({ taskId: 'task-b', agentId: 'codex' })

    expect(first.runId).toBe('run-1')
    expect(second.runId).toBe('run-2')
    expect(client.created.map((entry) => entry.intent.taskId)).toEqual(['task-a', 'task-b'])
  })

  it('delegates an uncertain create to adapter reconciliation and then replays durable state', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    client.createError = new Error('response lost')
    client.reconcileSummary = {
      runId: 'run-1',
      taskId: 'task-a',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'running',
      startedAt: 1,
    }
    const subject = controller(store, client)

    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })

    expect(handle.runId).toBe('run-1')
    expect(client.readCount).toBe(1)
    await vi.waitFor(() => {
      expect(client.attaches.get('run-1')?.input.afterEventId).toBe(0)
    })
  })

  it('turns file-write into a normalized ghost without creating a fake Node', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client)
    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })
    const originalNodes = store.snapshot.document.nodes

    client.emit(handle.runId, 1, {
      type: 'file-write',
      path: 'artifacts\\nested\\Classic Scatter Plot.PNG',
    })

    expect(store.snapshot.runtimeByTaskId['task-a']?.ghosts).toEqual([{
      key: 'file:artifacts-nested-classic-scatter-plot.png',
      title: 'Classic Scatter Plot.PNG',
      phase: 'writing',
    }])
    client.emit(handle.runId, 2, {
      type: 'file-write',
      path: 'artifacts/alternate/Classic Scatter Plot.PNG',
    })
    expect(store.snapshot.runtimeByTaskId['task-a']?.ghosts.map((ghost) => ghost.key))
      .toEqual([
        'file:artifacts-nested-classic-scatter-plot.png',
        'file:artifacts-alternate-classic-scatter-plot.png',
      ])
    expect(store.snapshot.document.nodes).toBe(originalNodes)
    expect(store.snapshot.document.nodes).toHaveLength(0)
  })

  it('binds a file-write ghost to the sole owned output slot', async () => {
    const document = taskDocument('task-a')
    document.nodes.push({
      id: 'node-slot',
      typeRef: { id: 'text', revision: 1, digest: '0000000000000000000000000000000000000000000000000000000000000000' },
      parentId: null,
      orderKey: (1).toString(36).padStart(12, '0'),
      bounds: { w: 320, h: 256 },
      transform: { matrix: [1, 0, 0, 1, 40, 80] },
      title: 'Empty slot',
      artifactRefs: [],
      homeTaskId: 'task-a',
      origin: { kind: 'user' },
    })
    const store = new FakeStore(document)
    const client = new FakeClient()
    const handle = await controller(store, client).runTask({
      taskId: 'task-a',
      agentId: 'codex',
    })

    client.emit(handle.runId, 1, { type: 'file-write', path: 'files/result.md' })

    expect(store.snapshot.runtimeByTaskId['task-a']?.ghosts).toEqual([{
      key: 'file:node-slot:files-result.md',
      nodeId: 'node-slot',
      title: 'result.md',
      phase: 'writing',
    }])
  })

  it('does not treat Agent done as terminal and reloads only after durable close', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client)
    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })

    client.emit(handle.runId, 1, {
      type: 'file-write',
      path: 'files/classic_scatter_plot.png',
    })
    expect(store.snapshot.runtimeByTaskId['task-a']?.ghosts).toHaveLength(1)
    client.emit(handle.runId, 2, { type: 'done', stopReason: 'end_turn' })
    expect(store.reloadCount).toBe(0)
    expect(store.snapshot.runtimeByTaskId['task-a']?.phase).toBe('running')

    client.close({ runId: handle.runId, status: 'done', artifactsComplete: true })
    await expect(handle.completion).resolves.toMatchObject({ status: 'done' })
    expect(store.reloadCount).toBe(1)
    expect(store.snapshot.runtimeByTaskId['task-a']?.phase).toBe('done')
    expect(store.snapshot.runtimeByTaskId['task-a']?.ghosts).toEqual([])
    expect(store.order.indexOf('reload')).toBeLessThan(store.order.lastIndexOf('runtime:done'))
  })

  it('delivers a trusted close plan after reload without accepting or running proposals', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const notices: unknown[] = []
    const subject = controller(store, client, {
      onProjectionPlan: (notice) => {
        store.order.push('plan')
        notices.push(notice)
      },
    })
    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })
    const plan = projectionPlan(handle.runId, 'a', {
      taskProposals: [{
        key: 'follow-up',
        title: 'Refine colors',
        prompt: 'Refine colors',
        inputOutputKeys: ['image'],
        dependsOn: [],
      }],
    })
    client.close({
      runId: handle.runId,
      status: 'done',
      artifactsComplete: true,
      projectionPlan: plan,
      suggestedActions: [{ id: 'refine', label: 'Refine', prompt: 'Refine colors' }],
    })

    await handle.completion
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(store.order.indexOf('reload')).toBeLessThan(store.order.indexOf('plan'))
    expect(notices).toEqual([{
      taskId: 'task-a',
      runId: handle.runId,
      plan,
      suggestedActions: [{ id: 'refine', label: 'Refine', prompt: 'Refine colors' }],
    }])
    expect((notices[0] as { plan: unknown }).plan).toBe(plan)
    expect(client.created).toHaveLength(1)
  })

  it('projects permission requests to runtime and the UI callback without ending the run', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const permission = vi.fn()
    const subject = controller(store, client, { onPermissionRequest: permission })
    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })

    client.emit(handle.runId, 1, {
      type: 'permission-request',
      id: 'permission-1',
      action: 'write',
      detail: 'Write report.pdf',
    })

    expect(store.snapshot.runtimeByTaskId['task-a']).toMatchObject({
      runId: handle.runId,
      phase: 'awaiting-permission',
      message: 'Write report.pdf',
    })
    expect(permission).toHaveBeenCalledWith({
      taskId: 'task-a',
      runId: handle.runId,
      permissionId: 'permission-1',
      action: 'write',
      detail: 'Write report.pdf',
    })
    expect(store.reloadCount).toBe(0)
  })

  it('maps a verified partial plan to partial even when the daemon run ended in error', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client)
    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })

    client.close({
      runId: handle.runId,
      status: 'error',
      artifactsComplete: false,
      projectionPlan: projectionPlan(handle.runId, 'b', {
        status: 'partial',
        taskProposals: [],
      }),
    })
    await handle.completion

    expect(store.snapshot.runtimeByTaskId['task-a']?.phase).toBe('partial')
  })

  it('requests cancellation but waits for the durable cancelled close', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client)
    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })
    let settled = false

    const cancellation = subject.cancelTask('task-a').then((close) => {
      settled = true
      return close
    })
    await Promise.resolve()
    expect(client.cancelled).toEqual([handle.runId])
    expect(settled).toBe(false)
    expect(store.reloadCount).toBe(0)

    client.close({ runId: handle.runId, status: 'cancelled', artifactsComplete: false })
    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' })
    expect(store.reloadCount).toBe(1)
    expect(store.snapshot.runtimeByTaskId['task-a']?.phase).toBe('cancelled')
  })

  it('recovers by Task and branch, replays the durable cursor before attaching, and is idempotent', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    client.summaries = [{
      runId: 'recovered-run',
      taskId: 'task-a',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'running',
      startedAt: 1,
    }]
    client.logEntries = {
      entries: [{
        id: 3,
        event: 'agent-event',
        data: { type: 'file-write', path: 'files/recovered.png' },
      }],
      nextEventId: null,
    }
    const subject = controller(store, client)

    const [first, second] = await Promise.all([
      subject.recoverTask('task-a'),
      subject.recoverTask('task-a'),
    ])

    expect(first?.runId).toBe('recovered-run')
    expect(second?.runId).toBe('recovered-run')
    expect(client.readCount).toBe(1)
    expect(client.attaches.size).toBe(1)
    expect(client.attaches.get('recovered-run')?.input.afterEventId).toBe(3)
    expect(store.snapshot.runtimeByTaskId['task-a']?.ghosts[0]?.title).toBe('recovered.png')
  })

  it('does not restore file-write ghosts after the same Run output is materialized', async () => {
    const document = taskDocument('task-a')
    document.nodes.push({
      id: 'node-recovered',
      typeRef: { id: 'image', revision: 1, digest: '0000000000000000000000000000000000000000000000000000000000000000' },
      parentId: null,
      orderKey: (1).toString(36).padStart(12, '0'),
      bounds: { w: 320, h: 256 },
      transform: { matrix: [1, 0, 0, 1, 40, 80] },
      title: 'Recovered image',
      artifactRefs: [{ runId: 'recovered-run', artifactId: 'artifact-recovered' }],
      homeTaskId: 'task-a',
      origin: {
        kind: 'agent-output',
        taskId: 'task-a',
        runId: 'recovered-run',
        planId: `plan_${'a'.repeat(64)}`,
        outputKey: 'image',
      },
    })
    const store = new FakeStore(document)
    const client = new FakeClient()
    client.summaries = [{
      runId: 'recovered-run',
      taskId: 'task-a',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'running',
      startedAt: 1,
    }]
    client.logEntries = {
      entries: [{
        id: 3,
        event: 'agent-event',
        data: { type: 'file-write', path: 'files/recovered.png' },
      }],
      nextEventId: null,
    }

    const handle = await controller(store, client).recoverTask('task-a')

    expect(handle?.runId).toBe('recovered-run')
    expect(store.snapshot.runtimeByTaskId['task-a']?.ghosts).toEqual([])
    expect(store.snapshot.runtimeByTaskId['task-a']?.phase).toBe('done')
    expect(client.attaches.get('recovered-run')?.input.afterEventId).toBe(3)
  })

  it('recovers only the latest terminal close after refresh and redelivers its unsettled plan', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const plan = projectionPlan('recovered-close', 'c')
    const close: CanvasTaskRunClose = {
      runId: 'recovered-close',
      status: 'done',
      artifactsComplete: true,
      projectionPlan: plan,
    }
    client.summaries = [{
      runId: 'older-terminal',
      taskId: 'task-a',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'done',
      startedAt: 1,
    }, {
      runId: 'recovered-close',
      taskId: 'task-a',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'done',
      startedAt: 2,
    }]
    client.logEntries = {
      entries: [{ id: 4, event: 'close', data: close }],
      nextEventId: null,
    }
    const onProjectionPlan = vi.fn()
    const subject = controller(store, client, { onProjectionPlan })

    const handle = await subject.recoverTask('task-a')
    await expect(handle?.completion).resolves.toEqual(close)
    expect(client.readRunIds).toEqual(['recovered-close'])
    expect(client.attaches.size).toBe(0)
    expect(store.reloadCount).toBe(0)
    expect(onProjectionPlan).toHaveBeenCalledTimes(1)
    expect(await subject.recoverTask('task-a')).toBeNull()
    expect(store.reloadCount).toBe(0)
  })

  it('does not redeliver a terminal plan settled by a persistent Canvas receipt', async () => {
    const planId = `plan_${'d'.repeat(64)}`
    const document = taskDocument('task-a')
    document.receipts.push({
      kind: 'proposal-acceptance',
      planId,
      runId: 'settled-run',
      taskId: 'task-a',
      proposals: [{ proposalKey: 'accepted', taskId: 'accepted-task' }],
    })
    const store = new FakeStore(document)
    const client = new FakeClient()
    client.summaries = [{
      runId: 'settled-run',
      taskId: 'task-a',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'done',
      startedAt: 9,
    }]
    client.logEntries = {
      entries: [{
        id: 8,
        event: 'close',
        data: {
          runId: 'settled-run',
          status: 'done',
          artifactsComplete: true,
          projectionPlan: projectionPlan('settled-run', 'd', {
            planId,
            taskProposals: [{
              key: 'accepted',
              title: 'Accepted',
              prompt: 'Accepted',
              inputOutputKeys: [],
              dependsOn: [],
            }],
          }),
        },
      }],
      nextEventId: null,
    }
    const onProjectionPlan = vi.fn()
    const subject = controller(store, client, { onProjectionPlan })

    const handle = await subject.recoverTask('task-a')
    await handle?.completion

    expect(store.reloadCount).toBe(0)
    expect(onProjectionPlan).not.toHaveBeenCalled()
  })

  it('replays a terminal Run as history without restoring progress or permissions', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const permission = vi.fn()
    const close: CanvasTaskRunClose = {
      runId: 'terminal-run',
      status: 'done',
      artifactsComplete: true,
    }
    client.summaries = [{
      runId: 'terminal-run',
      taskId: 'task-a',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'done',
      startedAt: 10,
    }]
    client.logEntries = {
      entries: [
        { id: 1, event: 'agent-event', data: { type: 'thinking', text: 'Old thought' } },
        {
          id: 2,
          event: 'agent-event',
          data: {
            type: 'permission-request',
            id: 'old-permission',
            action: 'write',
            detail: 'Old request',
          },
        },
        { id: 3, event: 'agent-event', data: { type: 'done', stopReason: 'end_turn' } },
        { id: 4, event: 'close', data: close },
      ],
      nextEventId: null,
    }
    const subject = controller(store, client, { onPermissionRequest: permission })

    const handle = await subject.recoverTask('task-a')
    await expect(handle?.completion).resolves.toEqual(close)

    expect(permission).not.toHaveBeenCalled()
    expect(store.order).not.toContain('runtime:running')
    expect(store.order).not.toContain('runtime:awaiting-permission')
    expect(store.snapshot.runtimeByTaskId['task-a']?.phase).toBe('done')
    expect(subject.getRunLog('terminal-run')).toContainEqual({
      eventId: 1,
      kind: 'thinking',
      text: 'Old thought',
    })
    expect(store.reloadCount).toBe(0)
  })

  it('keeps a bounded thinking/tool/text log and ignores duplicate event ids', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client, {
      maxLogEntries: 2,
      maxLogCharacters: 40,
    })
    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })

    client.emit(handle.runId, 1, { type: 'thinking', text: 'first' })
    client.emit(handle.runId, 1, { type: 'thinking', text: 'duplicate' })
    client.emit(handle.runId, 2, { type: 'tool-call', name: 'read', input: { file: 'a' } })
    client.emit(handle.runId, 3, { type: 'text-delta', text: 'third' })

    expect(subject.getRunLog(handle.runId)).toEqual([
      { eventId: 2, kind: 'tool', text: '→ read {"file":"a"}' },
      { eventId: 3, kind: 'text', text: 'third' },
    ])
  })

  it('dispose only detaches subscribers and never sends cancellation', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client)
    const handle = await subject.runTask({ taskId: 'task-a', agentId: 'codex' })
    const attach = client.attaches.get(handle.runId)

    subject.dispose()

    expect(attach?.input.signal.aborted).toBe(true)
    expect(client.cancelled).toEqual([])
    expect(store.snapshot.runtimeByTaskId['task-a']?.phase).toBe('running')
  })
})
