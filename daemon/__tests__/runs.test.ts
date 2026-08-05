import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CreateRunRequest } from '../protocol.js'
import { ProtocolError } from '../protocol.js'
import type { AgentRegistry } from '../registry.js'
import { RunManager } from '../runs.js'
import type {
  AgentProcessTransport,
  TransportRunOptions,
  TransportRunResult,
} from '../transport/types.js'

function request(runId: string, nodeId: string): CreateRunRequest {
  return {
    runId,
    nodeId,
    agentId: 'controlled',
    prompt: `run ${nodeId}`,
    projectDir: '.',
    canvasBranch: 'main',
    automationMode: 'auto',
    canvasSnapshot: {
      nodes: [{
        id: nodeId,
        type: 'text',
        x: 0,
        y: 0,
        w: 320,
        h: 120,
        title: nodeId,
        text: '',
        instruction: {
          phase: 'idle',
          prompt: `run ${nodeId}`,
          attachments: [],
          sources: [],
          open: true,
        },
        payload: {},
      }],
      edges: [],
      plugins: [],
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

test('one managed source worktree stays single-flight through post-run checkpointing', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-runs-source-flight-'))
  const root = await realpath(temporaryRoot)
  const sourceProjectDir = path.join(root, '.gg', 'source-worktrees', 'managed-id')
  await mkdir(sourceProjectDir, { recursive: true })
  const transportStarted = deferred()
  const releaseTransport = deferred()
  const postRunStarted = deferred()
  const releasePostRun = deferred()
  let transportRuns = 0
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions): Promise<TransportRunResult> {
      transportRuns += 1
      if (transportRuns === 1) {
        transportStarted.resolve()
        await releaseTransport.promise
      }
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: null }
    },
    async cancel() {
      releaseTransport.resolve()
      return true
    },
  }
  const manager = new RunManager({
    projectRoot: root,
    registry: registry(transport),
    resolveSourceProjectDir: async () => sourceProjectDir,
    onRunFinished: async ({ summary }) => {
      if (summary.runId !== 'run-first') return
      postRunStarted.resolve()
      await releasePostRun.promise
    },
  })

  try {
    await manager.create(request('run-first', 'node-first'))
    await withTimeout(transportStarted.promise)
    await assert.rejects(
      manager.create(request('run-during-transport', 'node-second')),
      isSourceWorktreeBusy,
    )
    await assert.rejects(
      manager.withIdleBranches('.', ['main'], async () => undefined),
      isBranchBusy,
    )

    releaseTransport.resolve()
    await withTimeout(postRunStarted.promise)
    assert.equal(manager.get('run-first')?.status, 'done')
    await assert.rejects(
      manager.create(request('run-during-checkpoint', 'node-third')),
      isSourceWorktreeBusy,
    )
    await assert.rejects(
      manager.withIdleBranches('.', ['main'], async () => undefined),
      isBranchBusy,
    )

    releasePostRun.resolve()
    const next = await createWhenSourceIsFree(
      manager,
      request('run-after-checkpoint', 'node-fourth'),
    )
    assert.equal(next.runId, 'run-after-checkpoint')
  } finally {
    releaseTransport.resolve()
    releasePostRun.resolve()
    await manager.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('branch leases cover pending resolution and deduplicate the same run id', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-runs-branch-lease-'))
  const root = await realpath(temporaryRoot)
  const resolverStarted = deferred()
  const releaseResolver = deferred()
  let resolverCalls = 0
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options) {
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: null }
    },
    async cancel() {
      return false
    },
  }
  const manager = new RunManager({
    projectRoot: root,
    registry: registry(transport),
    resolveSourceProjectDir: async () => {
      resolverCalls += 1
      resolverStarted.resolve()
      await releaseResolver.promise
      return null
    },
  })

  try {
    const first = manager.create(request('run-idempotent-pending', 'node-pending'))
    await withTimeout(resolverStarted.promise)
    const duplicate = manager.create(request('run-idempotent-pending', 'node-pending'))
    await assert.rejects(
      manager.withIdleBranches('.', ['main'], async () => undefined),
      isBranchBusy,
    )

    releaseResolver.resolve()
    const [firstSummary, duplicateSummary] = await Promise.all([first, duplicate])
    assert.equal(firstSummary.runId, 'run-idempotent-pending')
    assert.deepEqual(duplicateSummary, firstSummary)
    assert.equal(resolverCalls, 1)
  } finally {
    releaseResolver.resolve()
    await manager.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('a multi-branch mutation reservation blocks new runs before source resolution', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-runs-mutation-lease-'))
  const root = await realpath(temporaryRoot)
  const mutationStarted = deferred()
  const releaseMutation = deferred()
  let resolverCalls = 0
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run() {
      return { sessionId: null }
    },
    async cancel() {
      return false
    },
  }
  const manager = new RunManager({
    projectRoot: root,
    registry: registry(transport),
    resolveSourceProjectDir: async () => {
      resolverCalls += 1
      return null
    },
  })

  try {
    const mutation = manager.withIdleBranches('.', ['main', 'feature/a'], async () => {
      mutationStarted.resolve()
      await releaseMutation.promise
      return 'complete'
    })
    await withTimeout(mutationStarted.promise)
    await assert.rejects(
      manager.create(request('run-main-during-mutation', 'node-main')),
      isBranchBusy,
    )
    await assert.rejects(
      manager.create({
        ...request('run-feature-during-mutation', 'node-feature'),
        canvasBranch: 'feature/a',
      }),
      isBranchBusy,
    )
    assert.equal(resolverCalls, 0)
    releaseMutation.resolve()
    assert.equal(await mutation, 'complete')
  } finally {
    releaseMutation.resolve()
    await manager.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('a failed pending run releases its branch lease', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-runs-lease-failure-'))
  const root = await realpath(temporaryRoot)
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run() {
      return { sessionId: null }
    },
    async cancel() {
      return false
    },
  }
  const manager = new RunManager({
    projectRoot: root,
    registry: registry(transport),
    resolveSourceProjectDir: async () => {
      throw new Error('resolver failed')
    },
  })

  try {
    await assert.rejects(
      manager.create(request('run-resolver-failure', 'node-failure')),
      /resolver failed/u,
    )
    assert.equal(
      await manager.withIdleBranches('.', ['main'], async () => 'lease-released'),
      'lease-released',
    )
  } finally {
    await manager.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('a bound source worktree is revalidated immediately before transport spawn', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-runs-source-revalidate-'))
  const root = await realpath(temporaryRoot)
  const sourceProjectDir = path.join(root, '.gg', 'source-worktrees', 'managed-id')
  await mkdir(sourceProjectDir, { recursive: true })
  let resolverCalls = 0
  let transportInvoked = false
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run() {
      transportInvoked = true
      return { sessionId: null }
    },
    async cancel() {
      return false
    },
  }
  const manager = new RunManager({
    projectRoot: root,
    registry: registry(transport),
    resolveSourceProjectDir: async () => {
      resolverCalls += 1
      if (resolverCalls === 3) await rm(sourceProjectDir, { recursive: true, force: true })
      return sourceProjectDir
    },
  })

  try {
    await manager.create(request('run-revalidate', 'node-revalidate'))
    await waitFor(() => manager.get('run-revalidate')?.status === 'error')
    assert.equal(resolverCalls, 3)
    assert.equal(transportInvoked, false)
    await assert.rejects(access(sourceProjectDir), { code: 'ENOENT' })
  } finally {
    await manager.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('run outcomes stay run-bound, private, durable, and success-only', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-runs-outcome-'))
  const root = await realpath(temporaryRoot)
  const cancelStarted = deferred()
  const releaseCancel = deferred()
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options) {
      const controlDir = path.join(options.artifactDir, '.ggai')
      await mkdir(controlDir, { recursive: true })
      await Promise.all([
        writeFile(
          path.join(options.artifactDir, 'output.txt'),
          `result for ${options.nodeId}\n`,
          'utf8',
        ),
        writeFile(
          path.join(controlDir, 'run-result.json'),
          `${JSON.stringify(outcomeFor(options.nodeId))}\n`,
          'utf8',
        ),
      ])
      if (options.nodeId === 'node-cancel') {
        cancelStarted.resolve()
        await releaseCancel.promise
        return { sessionId: null }
      }
      options.onEvent({
        type: 'done',
        stopReason: options.nodeId === 'node-error' ? 'error' : 'end_turn',
      })
      return { sessionId: null }
    },
    async cancel() {
      releaseCancel.resolve()
      return true
    },
  }
  const manager = new RunManager({ projectRoot: root, registry: registry(transport) })

  try {
    await Promise.all([
      manager.create(request('run-outcome-a', 'node-a')),
      manager.create(request('run-outcome-b', 'node-b')),
    ])
    await waitFor(() => manager.get('run-outcome-a')?.status === 'done')
    await waitFor(() => manager.get('run-outcome-b')?.status === 'done')

    for (const [runId, nodeId] of [
      ['run-outcome-a', 'node-a'],
      ['run-outcome-b', 'node-b'],
    ] as const) {
      const subscription = manager.subscribe(runId, () => undefined)
      assert.ok(subscription)
      const close = subscription.history.find((message) => message.event === 'close')
      assert.ok(close && close.event === 'close')
      assert.deepEqual(close.data.outcome, outcomeFor(nodeId))
      assert.equal(close.data.artifacts.length, 1)
      assert.match(close.data.artifacts[0] ?? '', /\/output\.txt$/u)
      assert.ok(close.data.artifacts.every((file) => !file.includes('/.ggai/')))
      assert.ok(subscription.history.every((message) =>
        message.event !== 'agent-event'
        || message.data.type !== 'file-write'
        || !message.data.path.includes('/.ggai/')))

      const durable = await manager.readRunLog(runId)
      const durableClose = durable?.entries.find((message) => message.event === 'close')
      assert.ok(durableClose && durableClose.event === 'close')
      assert.deepEqual(durableClose.data.outcome, outcomeFor(nodeId))
    }

    await manager.create(request('run-outcome-error', 'node-error'))
    await waitFor(() => manager.get('run-outcome-error')?.status === 'error')
    const errorSubscription = manager.subscribe('run-outcome-error', () => undefined)
    const errorClose = errorSubscription?.history.find((message) => message.event === 'close')
    assert.ok(errorClose && errorClose.event === 'close')
    assert.equal(errorClose.data.status, 'error')
    assert.equal(errorClose.data.outcome, undefined)

    await manager.create(request('run-outcome-cancel', 'node-cancel'))
    await withTimeout(cancelStarted.promise)
    assert.equal(await manager.cancel('run-outcome-cancel'), true)
    const cancelSubscription = manager.subscribe('run-outcome-cancel', () => undefined)
    const cancelClose = cancelSubscription?.history.find((message) => message.event === 'close')
    assert.ok(cancelClose && cancelClose.event === 'close')
    assert.equal(cancelClose.data.status, 'cancelled')
    assert.equal(cancelClose.data.outcome, undefined)
  } finally {
    releaseCancel.resolve()
    await manager.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

function outcomeFor(nodeId: string): object {
  return {
    schemaVersion: 1,
    suggestedActions: [
      { id: `${nodeId}-summary`, label: `Summarize ${nodeId}`, prompt: `Summarize ${nodeId}.` },
      { id: `${nodeId}-chart`, label: `Chart ${nodeId}`, prompt: `Chart ${nodeId}.` },
      { id: `${nodeId}-brief`, label: `Brief ${nodeId}`, prompt: `Brief ${nodeId}.` },
    ],
  }
}

function isSourceWorktreeBusy(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === 'source_worktree_busy'
}

function isBranchBusy(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === 'branch_busy'
}

async function createWhenSourceIsFree(
  manager: RunManager,
  input: CreateRunRequest,
): Promise<Awaited<ReturnType<RunManager['create']>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await manager.create(input)
    } catch (error) {
      if (!isSourceWorktreeBusy(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error('source worktree did not become available')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition was not met before timeout')
}

async function withTimeout(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), 3_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: () => resolvePromise?.() }
}
