import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CanvasDocumentV2 } from '../../src/canvas-v2/model.js'
import { CanvasRevisionConflictV2Error } from '../canvasCommandStoreV2.js'
import { ProtocolError } from '../protocol.js'
import type { AgentRegistry } from '../registry.js'
import { RunManager } from '../runs.js'
import { createDaemonServer, type DaemonServer } from '../server.js'
import type { ResolvedTaskRunRequestV2 } from '../taskRunTypesV2.js'
import type {
  AgentProcessTransport,
  TransportRunOptions,
  TransportRunResult,
} from '../transport/types.js'

interface ControlledTransport {
  transport: AgentProcessTransport
  started: Map<string, ReturnType<typeof deferred>>
  releases: Map<string, ReturnType<typeof deferred>>
  releaseAll(): void
}

function controlledTransport(): ControlledTransport {
  const started = new Map<string, ReturnType<typeof deferred>>()
  const releases = new Map<string, ReturnType<typeof deferred>>()
  return {
    started,
    releases,
    transport: {
      kind: 'codex',
      async run(options: TransportRunOptions): Promise<TransportRunResult> {
        const start = started.get(options.runId) ?? deferred()
        started.set(options.runId, start)
        start.resolve()
        const release = releases.get(options.runId) ?? deferred()
        releases.set(options.runId, release)
        await release.promise
        options.onEvent({ type: 'done', stopReason: 'end_turn' })
        return { sessionId: null }
      },
      async cancel(runId: string) {
        releases.get(runId)?.resolve()
        return true
      },
    },
    releaseAll() {
      for (const release of releases.values()) release.resolve()
    },
  }
}

function registry(transport: AgentProcessTransport): AgentRegistry {
  return {
    resolve: (agentId: string) => agentId === 'controlled' ? transport : null,
    probe: async () => [{
      id: 'controlled',
      label: 'Controlled',
      transport: 'codex',
      available: true,
      authStatus: 'authenticated',
      models: [],
    }],
  } as unknown as AgentRegistry
}

function taskRequest(
  runId: string,
  taskId: string,
  canvasDocument: CanvasDocumentV2,
): ResolvedTaskRunRequestV2 {
  return {
    schemaVersion: 2,
    runId,
    taskId,
    agentId: 'controlled',
    canvasBranch: 'main',
    baseRevision: 3,
    prompt: `execute ${taskId}`,
    attachments: [],
    materializationPolicy: 'auto',
    projectDir: '.',
    canvasDocument,
    resolvedArtifactAttachments: [],
    automationMode: 'confirm',
  }
}

async function seedCollection(daemon: DaemonServer): Promise<CanvasDocumentV2> {
  const first = await daemon.canvasV2.commit('.', 'main', 0, 'seed-task-a', {
    type: 'CreateTask',
    task: {
      id: 'task-a',
      title: 'Task A',
      goal: 'Keep running',
      anchor: { x: 100, y: 100 },
      origin: { kind: 'user' },
    },
  })
  const second = await daemon.canvasV2.commit('.', 'main', first.revision, 'seed-task-b', {
    type: 'CreateTask',
    task: {
      id: 'task-b',
      title: 'Task B',
      goal: 'Independent task',
      anchor: { x: 500, y: 100 },
      origin: { kind: 'user' },
    },
  })
  const third = await daemon.canvasV2.commit('.', 'main', second.revision, 'seed-collection', {
    type: 'CreateCollectionFromSelection',
    collection: {
      id: 'collection-a',
      title: 'Task collection',
      anchor: { x: 80, y: 80 },
    },
    members: [
      { kind: 'task', id: 'task-a' },
      { kind: 'task', id: 'task-b' },
    ],
  })
  return third.document
}

async function postCommand(
  baseUrl: string,
  input: {
    baseRevision: number
    mutationId: string
    command: Record<string, unknown>
  },
): Promise<Response> {
  return fetch(`${baseUrl}/canvas/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: 'main', ...input }),
  })
}

test('daemon blocks destructive Task and collection commands while a member Run is active', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-task-delete-guard-'))
  const control = controlledTransport()
  const runs = new RunManager({
    projectRoot: root,
    registry: registry(control.transport),
    watchArtifacts: async () => ({ close: async () => undefined }),
  })
  const daemon = createDaemonServer({ projectRoot: root, runManager: runs, canvasModel: 'v2' })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const document = await seedCollection(daemon)
    await runs.create(taskRequest('active-task-a', 'task-a', document))
    await waitFor(() => control.started.has('active-task-a'))

    for (const [mutationId, command] of [
      ['delete-task', { type: 'DeleteTask', taskId: 'task-a' }],
      ['delete-task-views', { type: 'DeleteTaskAndViews', taskId: 'task-a' }],
    ] as const) {
      const response = await postCommand(baseUrl, { baseRevision: 3, mutationId, command })
      assert.equal(response.status, 409)
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'task_run_active')
    }

    const deleteOther = await postCommand(baseUrl, {
      baseRevision: 3,
      mutationId: 'delete-independent-task',
      command: { type: 'DeleteTask', taskId: 'task-b' },
    })
    assert.equal(deleteOther.status, 200, await deleteOther.text())

    const deleteContents = await postCommand(baseUrl, {
      baseRevision: 4,
      mutationId: 'delete-collection-contents',
      command: { type: 'DeleteCollectionAndContents', collectionId: 'collection-a' },
    })
    assert.equal(deleteContents.status, 409)
    assert.equal(
      (await deleteContents.json() as { error: { code: string } }).error.code,
      'task_run_active',
    )

    const dissolve = await postCommand(baseUrl, {
      baseRevision: 4,
      mutationId: 'dissolve-active-collection',
      command: { type: 'DeleteCollection', collectionId: 'collection-a' },
    })
    const dissolveText = await dissolve.text()
    assert.equal(dissolve.status, 200, dissolveText)
    const dissolved = JSON.parse(dissolveText) as {
      revision: number
      document: { tasks: Array<{ id: string; collectionId?: string }> }
    }
    assert.equal(dissolved.revision, 5)
    assert.equal(dissolved.document.tasks.find((task) => task.id === 'task-a')?.collectionId, undefined)
  } finally {
    control.releaseAll()
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('pending Run creation and Task mutation reservations are mutually exclusive and scoped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-task-pending-guard-'))
  const control = controlledTransport()
  const manager = new RunManager({
    projectRoot: root,
    registry: registry(control.transport),
    watchArtifacts: async () => ({ close: async () => undefined }),
  })
  const document: CanvasDocumentV2 = {
    schemaVersion: 2,
    nodes: [],
    tasks: [
      {
        id: 'task-a',
        title: 'Task A',
        goal: 'Pending creation',
        anchor: { x: 0, y: 0 },
        origin: { kind: 'user' },
      },
      {
        id: 'task-b',
        title: 'Task B',
        goal: 'Independent mutation',
        anchor: { x: 400, y: 0 },
        origin: { kind: 'user' },
      },
    ],
    collections: [],
    edges: [],
    receipts: [],
    everCreated: true,
  }
  const validationEntered = deferred()
  const releaseValidation = deferred()
  const mutationEntered = deferred()
  const releaseMutation = deferred()
  let mutatingTaskB: Promise<void> | null = null

  try {
    const creating = manager.create(taskRequest('pending-task-a', 'task-a', document), {
      validateReserved: async () => {
        validationEntered.resolve()
        await releaseValidation.promise
      },
    })
    await validationEntered.promise

    await assert.rejects(
      manager.withIdleTasks('.', 'main', ['task-a'], async () => undefined),
      (error: unknown) => error instanceof ProtocolError && error.code === 'task_run_active',
    )
    assert.equal(
      await manager.withIdleTasks('.', 'main', ['task-b'], async () => 'task-b-mutated'),
      'task-b-mutated',
    )
    assert.equal(
      await manager.withIdleTasks('.', 'feature', ['task-a'], async () => 'other-branch'),
      'other-branch',
    )

    mutatingTaskB = manager.withIdleTasks('.', 'main', ['task-b'], async () => {
      mutationEntered.resolve()
      await releaseMutation.promise
    })
    await mutationEntered.promise
    await assert.rejects(
      manager.create(taskRequest('blocked-by-task-mutation', 'task-b', document)),
      (error: unknown) => error instanceof ProtocolError && error.code === 'task_busy',
    )
    releaseMutation.resolve()
    await mutatingTaskB
    await manager.create(taskRequest('accepted-after-task-mutation', 'task-b', document))
    await waitFor(() => control.started.has('accepted-after-task-mutation'))

    releaseValidation.resolve()
    await creating
    await waitFor(() => control.started.has('pending-task-a'))
  } finally {
    releaseValidation.resolve()
    releaseMutation.resolve()
    await mutatingTaskB?.catch(() => undefined)
    control.releaseAll()
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Task mutation leases do not cross project boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-task-project-scope-'))
  const projectA = path.join(root, 'project-a')
  const projectB = path.join(root, 'project-b')
  await Promise.all([mkdir(projectA), mkdir(projectB)])
  const control = controlledTransport()
  const manager = new RunManager({
    projectRoot: root,
    registry: registry(control.transport),
    watchArtifacts: async () => ({ close: async () => undefined }),
  })
  const entered = deferred()
  const release = deferred()
  let mutation: Promise<void> | null = null

  try {
    mutation = manager.withIdleTasks(projectA, 'main', ['task-a'], async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    assert.equal(
      await manager.withIdleTasks(projectB, 'main', ['task-a'], async () => 'project-b'),
      'project-b',
    )
  } finally {
    release.resolve()
    await mutation?.catch(() => undefined)
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('failed mutation and failed reserved validation always release the Task lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-task-lease-release-'))
  const control = controlledTransport()
  const manager = new RunManager({
    projectRoot: root,
    registry: registry(control.transport),
    watchArtifacts: async () => ({ close: async () => undefined }),
  })
  const document: CanvasDocumentV2 = {
    schemaVersion: 2,
    nodes: [],
    tasks: [{
      id: 'task-a',
      title: 'Task A',
      goal: 'Lease release',
      anchor: { x: 0, y: 0 },
      origin: { kind: 'user' },
    }],
    collections: [],
    edges: [],
    receipts: [],
    everCreated: true,
  }

  try {
    await assert.rejects(
      manager.withIdleTasks('.', 'main', ['task-a'], async () => {
        throw new Error('synthetic commit failure')
      }),
      /synthetic commit failure/u,
    )
    assert.equal(
      await manager.withIdleTasks('.', 'main', ['task-a'], async () => 'retried'),
      'retried',
    )

    await assert.rejects(
      manager.create(taskRequest('stale-reserved-run', 'task-a', document), {
        validateReserved: async () => {
          throw new CanvasRevisionConflictV2Error(4)
        },
      }),
      (error: unknown) =>
        error instanceof CanvasRevisionConflictV2Error && error.currentRevision === 4,
    )
    assert.equal(
      await manager.withIdleTasks('.', 'main', ['task-a'], async () => 'released'),
      'released',
    )
  } finally {
    control.releaseAll()
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition was not met before timeout')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: () => resolvePromise?.() }
}
