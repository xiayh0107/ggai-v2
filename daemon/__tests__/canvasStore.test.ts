import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  CanvasCorruptionError,
  CanvasRevisionConflictError,
  CanvasStore,
  CanvasStoreManager,
  canvasBranchStorageId,
  canvasSnapshotPath,
  emptyCanvasDocument,
} from '../canvasStore.js'
import {
  parseCanvasDocument,
  parsePutCanvasRequest,
  ProtocolError,
  type CanvasDocumentV1,
} from '../protocol.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-canvas-'))
  temporaryDirectories.push(directory)
  return directory
}

function document(title = 'Node'): CanvasDocumentV1 {
  return {
    schemaVersion: 1,
    nodes: [{
      id: 'node_1',
      type: 'text',
      x: 10,
      y: 20,
      w: 320,
      h: 120,
      title,
      instruction: {
        phase: 'done',
        prompt: 'Write',
        attachments: [],
        sources: [],
        open: false,
      },
      payload: { text: 'persisted' },
    }],
    edges: [],
    everCreated: true,
    generationByNodeId: {
      node_1: {
        epoch: 1,
        current: { key: 'finishing', kind: 'finishing', label: '正在整理结果' },
        recent: [{ key: 'writing', kind: 'writing', label: '正在生成文本' }],
        log: [{ kind: 'output', text: 'persistent log' }],
      },
    },
    latestRunByNodeId: { node_1: 'run-1' },
    runRefsByNodeId: {
      node_1: { runId: 'run-1', lastEventId: 4, previousPhase: 'idle' },
    },
  }
}

function putRequest(baseRevision: number, mutationId: string, next = document()) {
  return parsePutCanvasRequest({
    baseRevision,
    mutationId,
    changeKind: 'autosave',
    document: next,
  })
}

test('canvas state persists atomically and reopens with logs', async () => {
  const projectDir = await temporaryProject()
  let now = Date.parse('2026-08-05T12:00:00.000Z')
  const store = new CanvasStore(projectDir, 'feature/persist', { now: () => now })
  assert.deepEqual(await store.get(), {
    branch: 'feature/persist',
    revision: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
    lastMutationId: null,
    lastCheckpoint: null,
    document: emptyCanvasDocument(),
  })

  const saved = await store.put(putRequest(0, 'mutation-1'))
  assert.equal(saved.revision, 1)
  assert.equal(saved.updatedAt, '2026-08-05T12:00:00.000Z')
  assert.equal(saved.document.generationByNodeId.node_1?.log[0]?.text, 'persistent log')
  assert.equal(saved.document.latestRunByNodeId.node_1, 'run-1')

  // Returned values are defensive copies.
  saved.document.nodes[0]!.title = 'mutated by caller'
  now += 1
  assert.equal((await store.get()).document.nodes[0]?.title, 'Node')

  const reopened = new CanvasStore(projectDir, 'feature/persist')
  assert.equal((await reopened.get()).document.nodes[0]?.title, 'Node')
  assert.equal(
    canvasSnapshotPath(projectDir, 'feature/persist').includes('feature/persist'),
    false,
  )
  assert.match(canvasBranchStorageId('feature/persist'), /^[0-9a-f]{64}$/u)
  const entries = await readdir(path.dirname(canvasSnapshotPath(projectDir, 'feature/persist')))
  assert.equal(entries.some((entry) => entry.endsWith('.tmp')), false)
})

test('serialized writes enforce CAS and idempotent mutation retry', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasStore(projectDir, 'main')
  const firstRequest = putRequest(0, 'mutation-one', document('First'))
  const [left, right] = await Promise.allSettled([
    store.put(firstRequest),
    store.put(putRequest(0, 'mutation-two', document('Second'))),
  ])
  assert.equal(left.status, 'fulfilled')
  assert.equal(right.status, 'rejected')
  assert.ok(right.status === 'rejected' && right.reason instanceof CanvasRevisionConflictError)
  assert.equal((right as PromiseRejectedResult).reason.currentRevision, 1)

  const retried = await store.put(firstRequest)
  assert.equal(retried.revision, 1)
  assert.equal(retried.document.nodes[0]?.title, 'First')
  await assert.rejects(
    store.put(putRequest(1, 'mutation-one', document('Reused'))),
    /mutation id was reused/,
  )
})

test('an empty revision-zero canvas remains readable after its first Git checkpoint', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasStore(projectDir, 'main')
  const checkpoint = 'a'.repeat(40)
  const checkpointed = await store.setLastCheckpoint(0, checkpoint)
  assert.equal(checkpointed.revision, 0)
  assert.equal(checkpointed.lastCheckpoint, checkpoint)
  await store.close()

  const reopened = new CanvasStore(projectDir, 'main')
  const loaded = await reopened.get()
  assert.equal(loaded.revision, 0)
  assert.equal(loaded.lastCheckpoint, checkpoint)
  assert.deepEqual(loaded.document, emptyCanvasDocument())

  const firstEdit = await reopened.put(putRequest(0, 'after-empty-checkpoint'))
  assert.equal(firstEdit.revision, 1)
  assert.equal(firstEdit.lastCheckpoint, checkpoint)
})

test('invalid snapshots are quarantined and require explicit recovery', async () => {
  const projectDir = await temporaryProject()
  const filePath = canvasSnapshotPath(projectDir, 'main')
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, '{ broken json', 'utf8')
  const store = new CanvasStore(projectDir, 'main')

  let corruption: CanvasCorruptionError | undefined
  await assert.rejects(store.get(), (error: unknown) => {
    assert.ok(error instanceof CanvasCorruptionError)
    corruption = error
    return true
  })
  assert.ok(corruption)
  assert.equal(await readFile(corruption.recovery.quarantinePath, 'utf8'), '{ broken json')
  await assert.rejects(new CanvasStore(projectDir, 'main').get(), CanvasCorruptionError)

  const recovered = await store.recover(document('Recovered'))
  assert.equal(recovered.revision, 1)
  assert.equal((await new CanvasStore(projectDir, 'main').get()).document.nodes[0]?.title, 'Recovered')
})

test('canvas protocol rejects malformed graphs, non-finite geometry, and oversized logs', () => {
  const valid = document()
  assert.throws(
    () => parseCanvasDocument({ ...valid, nodes: [valid.nodes[0], valid.nodes[0]] }),
    /duplicate node id/,
  )
  assert.throws(
    () => parseCanvasDocument({
      ...valid,
      edges: [{ id: 'edge_1', from: 'node_1', to: 'missing', label: '' }],
    }),
    /missing node/,
  )
  assert.throws(
    () => parseCanvasDocument({
      ...valid,
      nodes: [{ ...valid.nodes[0], x: Number.NaN }],
    }),
    /finite number/,
  )
  assert.throws(
    () => parseCanvasDocument({
      ...valid,
      generationByNodeId: {
        node_1: {
          ...valid.generationByNodeId.node_1,
          log: [{ kind: 'output', text: 'x'.repeat(401) }],
        },
      },
    }),
    /too long/,
  )
})

test('canvas protocol validates the persisted suggested-action projection', () => {
  const valid = document()
  valid.nodes[0]!.instruction.suggestedActions = {
    runId: 'run-1',
    actions: [
      { id: 'summarize', label: '提炼摘要', prompt: '请把当前内容提炼成三点摘要' },
      { id: 'compare', label: '对比来源', prompt: '请对比当前内容与来源节点的差异' },
      { id: 'visualize', label: '生成图表', prompt: '请将关键指标整理为图表' },
    ],
  }
  assert.equal(
    parseCanvasDocument(valid).nodes[0]?.instruction.suggestedActions?.runId,
    'run-1',
  )

  const malformed = structuredClone(valid)
  malformed.nodes[0]!.instruction.suggestedActions!.actions = [
    { id: 'only-one', label: '只有一个', prompt: '建议数量不符合契约' },
  ]
  assert.throws(
    () => parseCanvasDocument(malformed),
    /suggestedActions is invalid/u,
  )
})

test('manager rejects traversal, managed symlink escapes, and use after close', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  const manager = new CanvasStoreManager({ projectRoot: projectDir })
  await assert.rejects(
    manager.get('..', 'main'),
    (error: unknown) => error instanceof Error && error.message.includes('outside configured root'),
  )

  await symlink(outside, path.join(projectDir, '.gg'), 'dir')
  await assert.rejects(
    manager.get('.', 'main'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'unsafe_managed_path',
  )
  await manager.close()
  await assert.rejects(
    manager.get('.', 'main'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'daemon_shutting_down',
  )
})

test('a cached canvas store revalidates .gg before every write', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  const manager = new CanvasStoreManager({ projectRoot: projectDir })
  await manager.get('.', 'main')
  await rename(path.join(projectDir, '.gg'), path.join(projectDir, '.gg-original'))
  await symlink(outside, path.join(projectDir, '.gg'), 'dir')

  await assert.rejects(
    manager.put('.', 'main', putRequest(0, 'must-not-escape')),
    (error: unknown) => error instanceof ProtocolError && error.code === 'unsafe_managed_path',
  )
  assert.deepEqual(await readdir(outside), [])
  await manager.close()
})

test('a branch storage directory cannot redirect to another branch inside .gg', async () => {
  const projectDir = await temporaryProject()
  const manager = new CanvasStoreManager({ projectRoot: projectDir })
  await manager.put('.', 'main', putRequest(0, 'main-state', document('Main only')))

  const mainDir = path.dirname(canvasSnapshotPath(projectDir, 'main'))
  const featureDir = path.dirname(canvasSnapshotPath(projectDir, 'feature/isolated'))
  await mkdir(path.dirname(featureDir), { recursive: true })
  await symlink(mainDir, featureDir, 'dir')

  await assert.rejects(
    manager.get('.', 'feature/isolated'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'unsafe_managed_path',
  )
  assert.equal((await manager.get('.', 'main')).document.nodes[0]?.title, 'Main only')
  await manager.close()
})

test('the daemon lease rejects an in-.gg runtime redirect', async () => {
  const projectDir = await temporaryProject()
  await mkdir(path.join(projectDir, '.gg', 'redirect'), { recursive: true })
  await symlink(
    path.join(projectDir, '.gg', 'redirect'),
    path.join(projectDir, '.gg', 'runtime'),
    'dir',
  )
  const manager = new CanvasStoreManager({ projectRoot: projectDir })
  await assert.rejects(
    manager.get('.', 'main'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'unsafe_managed_path',
  )
  await manager.close()
})

test('only one daemon manager can own a project at a time', async () => {
  const projectDir = await temporaryProject()
  const first = new CanvasStoreManager({ projectRoot: projectDir })
  const second = new CanvasStoreManager({ projectRoot: projectDir })
  await first.get('.', 'main')
  await assert.rejects(
    second.get('.', 'main'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'daemon_instance_active',
  )

  await first.close()
  assert.equal((await second.get('.', 'main')).revision, 0)
  await second.close()
})

test('stale leases are never reclaimed by competing daemon managers', async () => {
  const projectDir = await temporaryProject()
  const lockPath = path.join(projectDir, '.gg', 'runtime', 'canvas-daemon.lock')
  await mkdir(path.dirname(lockPath), { recursive: true })
  const staleContents = `${JSON.stringify({ pid: 2_147_483_647, token: 'stale-owner' })}\n`
  await writeFile(lockPath, staleContents, 'utf8')

  const first = new CanvasStoreManager({ projectRoot: projectDir })
  const second = new CanvasStoreManager({ projectRoot: projectDir })
  const attempts = await Promise.allSettled([
    first.get('.', 'main'),
    second.get('.', 'main'),
  ])
  assert.deepEqual(attempts.map((entry) => entry.status), ['rejected', 'rejected'])
  for (const attempt of attempts) {
    assert.ok(
      attempt.status === 'rejected'
      && attempt.reason instanceof ProtocolError
      && attempt.reason.code === 'daemon_lease_stale',
    )
  }
  assert.equal(await readFile(lockPath, 'utf8'), staleContents)

  // Explicit operator recovery returns to the ordinary atomic acquisition
  // path, where exactly one contender can own the project.
  await rm(lockPath)
  const recovered = await Promise.allSettled([
    first.get('.', 'main'),
    second.get('.', 'main'),
  ])
  assert.equal(recovered.filter((entry) => entry.status === 'fulfilled').length, 1)
  assert.equal(recovered.filter((entry) => entry.status === 'rejected').length, 1)
  await Promise.all([first.close(), second.close()])
})
