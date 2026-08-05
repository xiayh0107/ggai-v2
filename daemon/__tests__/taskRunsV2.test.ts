import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CanvasDocumentV2 } from '../../src/canvas-v2/model.js'
import { ProtocolError } from '../protocol.js'
import type { AgentRegistry } from '../registry.js'
import { RunManager } from '../runs.js'
import type { ResolvedTaskRunRequestV2 } from '../taskRunTypesV2.js'
import type {
  AgentProcessTransport,
  TransportRunOptions,
  TransportRunResult,
} from '../transport/types.js'

function document(): CanvasDocumentV2 {
  return {
    schemaVersion: 2,
    nodes: [{
      id: 'node-source',
      type: 'text',
      frame: { x: 0, y: 0, w: 320, h: 180, z: 1 },
      title: 'Pinned source',
      text: 'revision-one-source',
      artifactRefs: [],
      origin: { kind: 'user' },
    }],
    tasks: [
      {
        id: 'task-a',
        title: 'Task A',
        goal: 'Use the authorized source',
        anchor: { x: 400, y: 100 },
        origin: { kind: 'user' },
      },
      {
        id: 'task-b',
        title: 'Task B',
        goal: 'Independent task',
        anchor: { x: 800, y: 100 },
        origin: { kind: 'user' },
      },
    ],
    collections: [],
    edges: [{
      id: 'edge-source-task-a',
      from: { kind: 'node', id: 'node-source' },
      to: { kind: 'task', id: 'task-a' },
      relation: 'source',
      contextRole: 'full',
      origin: { kind: 'user' },
    }],
    receipts: [],
    everCreated: true,
  }
}

function request(
  runId: string,
  taskId = 'task-a',
  canvasDocument = document(),
): ResolvedTaskRunRequestV2 {
  return {
    schemaVersion: 2,
    runId,
    taskId,
    agentId: 'controlled',
    canvasBranch: 'main',
    baseRevision: 1,
    prompt: `execute ${taskId}`,
    attachments: [],
    materializationPolicy: 'auto',
    projectDir: '.',
    canvasDocument,
    resolvedArtifactAttachments: [],
    automationMode: 'confirm',
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

test('Task-owned runs pin persisted context and resume by branch + task + agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-task-runs-v2-'))
  const observed: Array<{ sessionId: string | null; pack: string }> = []
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions): Promise<TransportRunResult> {
      observed.push({
        sessionId: options.sessionId,
        pack: await readFile(options.contextFile, 'utf8'),
      })
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: 'task-session-a' }
    },
    async cancel() {
      return false
    },
  }
  const manager = new RunManager({ projectRoot: root, registry: registry(transport) })

  try {
    const canvasDocument = document()
    const firstRequest = request('task-run-first', 'task-a', canvasDocument)
    const first = await manager.create(firstRequest)
    canvasDocument.nodes[0]!.text = 'mutated-after-acceptance'
    assert.equal(first.taskId, 'task-a')
    assert.equal(first.nodeId, 'task-a')
    await waitFor(() => manager.get(first.runId)?.status === 'done')

    assert.equal(observed[0]?.sessionId, null)
    assert.match(observed[0]?.pack ?? '', /revision-one-source/u)
    assert.match(observed[0]?.pack ?? '', /execute task-a/u)
    assert.doesNotMatch(observed[0]?.pack ?? '', /mutated-after-acceptance/u)

    const second = await createWhenTaskIsClosed(manager, request('task-run-second'))
    await waitFor(() => manager.get(second.runId)?.status === 'done')
    assert.equal(observed[1]?.sessionId, 'task-session-a')
    assert.equal(
      (await manager.listTaskSessions('.', {
        canvasBranch: 'main',
        taskId: 'task-a',
        agentId: 'controlled',
      }))[0]?.sessionId,
      'task-session-a',
    )

    const durable = await manager.getPersisted(first.runId)
    assert.equal(durable?.taskId, 'task-a')
    assert.equal((await manager.listRunHistory('.', { taskId: 'task-a' })).length, 2)
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('one Task is single-flight while different Tasks may run concurrently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-task-runs-v2-flight-'))
  const started = new Map<string, ReturnType<typeof deferred>>()
  const releases = new Map<string, ReturnType<typeof deferred>>()
  const transport: AgentProcessTransport = {
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
  }
  const manager = new RunManager({ projectRoot: root, registry: registry(transport) })

  try {
    await manager.create(request('task-run-a', 'task-a'))
    await waitFor(() => started.has('task-run-a'))
    await assert.rejects(
      manager.create(request('task-run-a-competing', 'task-a')),
      (error: unknown) => error instanceof ProtocolError && error.code === 'task_run_active',
    )

    await manager.create(request('task-run-b', 'task-b'))
    await waitFor(() => started.has('task-run-b'))
    assert.equal(manager.get('task-run-a')?.status, 'running')
    assert.equal(manager.get('task-run-b')?.status, 'running')

    releases.get('task-run-a')?.resolve()
    releases.get('task-run-b')?.resolve()
    await waitFor(() => manager.get('task-run-a')?.status === 'done')
    await waitFor(() => manager.get('task-run-b')?.status === 'done')
  } finally {
    for (const release of releases.values()) release.resolve()
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('failed Task runs durably close and retain verified partial artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-task-runs-v2-partial-'))
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions): Promise<TransportRunResult> {
      await writeFile(path.join(options.artifactDir, 'partial.R'), 'plot(1:3)\n', 'utf8')
      throw new Error('synthetic task failure')
    },
    async cancel() {
      return false
    },
  }
  const manager = new RunManager({ projectRoot: root, registry: registry(transport) })

  try {
    const run = await manager.create(request('task-run-partial'))
    await waitFor(() => manager.get(run.runId)?.status === 'error')
    let close: {
      artifacts: string[]
      artifactsComplete: boolean
      artifactManifest?: {
        complete: boolean
        entries: Array<{ artifactId: string; relativePath: string; mediaType: string }>
      }
    } | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const page = await manager.readRunLog(run.runId)
      close = page?.entries.find((entry) => entry.event === 'close')?.data as typeof close
      if (close) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(close)
    assert.equal(close.artifactsComplete, false)
    assert.equal(close.artifactManifest?.complete, false)
    assert.deepEqual(close.artifactManifest?.entries.map((entry) => ({
      relativePath: entry.relativePath,
      mediaType: entry.mediaType,
    })), [{ relativePath: 'partial.R', mediaType: 'text/x-r' }])
    assert.match(close.artifacts[0] ?? '', /\/task-run-partial\/files\/partial\.R$/u)
    const artifactId = close.artifactManifest?.entries[0]?.artifactId
    assert.ok(artifactId)
    const lookup = await manager.lookupRunArtifact(run.runId, artifactId)
    assert.equal(await readFile(lookup!.absolutePath, 'utf8'), 'plot(1:3)\n')
  } finally {
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

async function createWhenTaskIsClosed(
  manager: RunManager,
  input: ResolvedTaskRunRequestV2,
): Promise<Awaited<ReturnType<RunManager['create']>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await manager.create(input)
    } catch (error) {
      if (!(error instanceof ProtocolError && error.code === 'task_run_active')) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error('Task run did not reach durable close')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: () => resolvePromise?.() }
}
