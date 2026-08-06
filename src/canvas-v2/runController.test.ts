import { describe, expect, it, vi } from 'vitest'
import type { CanvasAgentEvent } from '@/agent/types'
import { emptyCanvasDocumentV2, type CanvasDocumentV2 } from './model'
import type { CanvasTaskRuntimeV2 } from './selectors'
import {
  CanvasV2TaskRunBusyError,
  CanvasV2TaskRunController,
  type CanvasV2RunIntent,
  type CanvasV2RunStore,
  type CanvasV2RunStoreSnapshot,
  type CanvasV2ProjectionPlanNotice,
  type CanvasV2TaskRunClient,
  type CanvasV2TaskRunClose,
  type CanvasV2TaskRunSummary,
} from './runController'

function projectionPlan(
  runId: string,
  digestCharacter: string,
  overrides: Partial<CanvasV2ProjectionPlanNotice> = {},
): CanvasV2ProjectionPlanNotice {
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

function taskDocument(...taskIds: string[]): CanvasDocumentV2 {
  return {
    ...emptyCanvasDocumentV2(),
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

class FakeStore implements CanvasV2RunStore {
  readonly order: string[] = []
  reloadCount = 0
  snapshot: CanvasV2RunStoreSnapshot

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

  getSnapshot(): CanvasV2RunStoreSnapshot {
    return this.snapshot
  }

  async flushCommands(): Promise<void> {
    this.order.push('flush')
  }

  async reload(): Promise<void> {
    this.order.push('reload')
    this.reloadCount += 1
  }

  setTaskRuntime(runtime: CanvasTaskRuntimeV2): void {
    this.order.push(`runtime:${runtime.phase}`)
    this.snapshot = {
      ...this.snapshot,
      runtimeByTaskId: {
        ...this.snapshot.runtimeByTaskId,
        [runtime.taskId]: structuredClone(runtime),
      },
    }
  }

  upsertTaskGhost(taskId: string, ghost: CanvasTaskRuntimeV2['ghosts'][number]): void {
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
  input: Parameters<CanvasV2TaskRunClient['attachTaskRun']>[0]
  resolve: (value: { close: CanvasV2TaskRunClose }) => void
  reject: (error: unknown) => void
}

class FakeClient implements CanvasV2TaskRunClient {
  readonly created: Array<{ projectDir: string; intent: CanvasV2RunIntent }> = []
  readonly attaches = new Map<string, PendingAttach>()
  readonly cancelled: string[] = []
  readonly readRunIds: string[] = []
  readonly summaryReads: Array<{ projectDir: string; runId: string }> = []
  readCount = 0
  summaries: CanvasV2TaskRunSummary[] = []
  summary: CanvasV2TaskRunSummary = {
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
  reconcileSummary: CanvasV2TaskRunSummary | null = null
  logEntries: Awaited<ReturnType<CanvasV2TaskRunClient['readTaskRunLog']>> = {
    entries: [],
    nextEventId: null,
  }

  async createTaskRun(input: {
    projectDir: string
    intent: CanvasV2RunIntent
  }): Promise<{ runId: string }> {
    this.created.push(structuredClone(input))
    if (this.createError) throw this.createError
    return { runId: input.intent.runId }
  }

  async reconcileTaskRun(): Promise<CanvasV2TaskRunSummary | null> {
    return this.reconcileSummary
  }

  async listTaskRuns(): Promise<readonly CanvasV2TaskRunSummary[]> {
    return this.summaries
  }

  async readTaskRunSummary(input: {
    projectDir: string
    runId: string
  }): Promise<CanvasV2TaskRunSummary> {
    this.summaryReads.push(structuredClone(input))
    return { ...this.summary, runId: input.runId }
  }

  async readTaskRunLog(input: {
    projectDir: string
    runId: string
    afterEventId: number
  }): Promise<{
    entries: Awaited<ReturnType<CanvasV2TaskRunClient['readTaskRunLog']>>['entries']
    nextEventId: number | null
  }> {
    this.readCount += 1
    this.readRunIds.push(input.runId)
    return this.logEntries
  }

  attachTaskRun(
    input: Parameters<CanvasV2TaskRunClient['attachTaskRun']>[0],
  ): Promise<{ close: CanvasV2TaskRunClose }> {
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

  close(close: CanvasV2TaskRunClose): void {
    const attach = this.attaches.get(close.runId)
    if (!attach) throw new Error(`missing attach ${close.runId}`)
    attach.resolve({ close })
  }
}

function controller(
  store: FakeStore,
  client: FakeClient,
  overrides: Partial<ConstructorParameters<typeof CanvasV2TaskRunController>[0]> = {},
): CanvasV2TaskRunController {
  let next = 0
  return new CanvasV2TaskRunController({
    store,
    client,
    runId: () => `run-${++next}`,
    ...overrides,
  })
}

describe('CanvasV2TaskRunController', () => {
  it('reads one immutable Task Run summary without changing runtime state', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const subject = controller(store, client)

    await expect(subject.readTaskRunSummary('run-origin')).resolves.toEqual(client.summary)
    expect(client.summaryReads).toEqual([{ projectDir: '/project', runId: 'run-origin' }])
    expect(store.snapshot.runtimeByTaskId).toEqual({})
    expect(store.order).toEqual([])
  })

  it('flushes first and sends the exact revision-owned RunIntent V2 without a snapshot', async () => {
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
      .rejects.toBeInstanceOf(CanvasV2TaskRunBusyError)
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
      key: 'file:classic-scatter-plot.png',
      title: 'Classic Scatter Plot.PNG',
      phase: 'writing',
    }])
    expect(store.snapshot.document.nodes).toBe(originalNodes)
    expect(store.snapshot.document.nodes).toHaveLength(0)
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

  it('recovers only the latest terminal close after refresh and redelivers its unsettled plan', async () => {
    const store = new FakeStore()
    const client = new FakeClient()
    const plan = projectionPlan('recovered-close', 'c')
    const close: CanvasV2TaskRunClose = {
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
    expect(store.reloadCount).toBe(1)
    expect(onProjectionPlan).toHaveBeenCalledTimes(1)
    expect(await subject.recoverTask('task-a')).toBeNull()
    expect(store.reloadCount).toBe(1)
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

    expect(store.reloadCount).toBe(1)
    expect(onProjectionPlan).not.toHaveBeenCalled()
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
      { eventId: 2, kind: 'tool', text: 'read {"file":"a"}' },
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
