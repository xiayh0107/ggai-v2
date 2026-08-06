import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  CanvasCommandStoreV2,
  CanvasMutationReuseV2Error,
  CanvasRevisionConflictV2Error,
  CanvasSnapshotV2Error,
} from '../canvasCommandStoreV2.js'
import { emptyCanvasDocumentV2 } from '../../src/canvas-v2/model.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporarySnapshot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-canvas-v2-store-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'nested', 'snapshot.json')
}

function createTask(id: string, title = id) {
  return {
    type: 'CreateTask' as const,
    task: {
      id,
      title,
      goal: `Complete ${title}`,
      anchor: { x: 100, y: 120 },
      origin: { kind: 'user' as const },
    },
  }
}

test('serializes concurrent commits with revision CAS', async () => {
  const filePath = await temporarySnapshot()
  const store = new CanvasCommandStoreV2('main', { filePath })

  assert.deepEqual(await store.get(), {
    branch: 'main',
    revision: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
    lastMutationId: null,
    lastCheckpoint: null,
    document: emptyCanvasDocumentV2(),
  })

  const results = await Promise.allSettled([
    store.commit(0, 'mutation-a', createTask('task-a')),
    store.commit(0, 'mutation-b', createTask('task-b')),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')

  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  const conflict = rejected[0]?.reason
  assert.ok(conflict instanceof CanvasRevisionConflictV2Error)
  assert.equal(conflict.currentRevision, 1)
  assert.equal((await store.get()).revision, 1)
})

test('returns the committed envelope for an idempotent mutation retry', async () => {
  const filePath = await temporarySnapshot()
  const store = new CanvasCommandStoreV2('main', { filePath })
  const command = createTask('task-1')
  const first = await store.commit(0, 'mutation-1', command)
  const retried = await store.commit(0, 'mutation-1', command)

  assert.deepEqual(retried, first)
  assert.equal(retried.revision, 1)
  assert.equal(retried.document.tasks.length, 1)
  await assert.rejects(
    store.commit(1, 'mutation-1', createTask('task-2')),
    CanvasMutationReuseV2Error,
  )
})

test('keeps memory and disk unchanged when a command fails atomically', async () => {
  const filePath = await temporarySnapshot()
  const store = new CanvasCommandStoreV2('main', { filePath })
  const committed = await store.commit(0, 'mutation-1', createTask('task-1'))
  const diskBefore = await readFile(filePath, 'utf8')

  await assert.rejects(store.commit(1, 'mutation-2', {
    type: 'UpdateTaskGoal',
    taskId: 'missing-task',
    goal: 'This reducer operation must fail',
  }))

  assert.deepEqual(await store.get(), committed)
  assert.equal(await readFile(filePath, 'utf8'), diskBefore)
})

test('persists an atomically-written envelope and reloads it defensively', async () => {
  const filePath = await temporarySnapshot()
  let now = Date.parse('2026-08-05T12:00:00.000Z')
  const store = new CanvasCommandStoreV2('feature/rich-nodes', {
    filePath,
    now: () => now,
  })
  const first = await store.commit(0, 'mutation-1', createTask('task-1', 'Plot'))
  now += 1_000
  const second = await store.commit(1, 'mutation-2', {
    type: 'UpdateTaskGoal',
    taskId: 'task-1',
    goal: 'Create, explain, and export the plot',
  })

  assert.equal(first.updatedAt, '2026-08-05T12:00:00.000Z')
  assert.equal(second.updatedAt, '2026-08-05T12:00:01.000Z')
  const reopened = new CanvasCommandStoreV2('feature/rich-nodes', { filePath })
  const loaded = await reopened.get()
  assert.deepEqual(loaded, second)
  loaded.document.tasks[0]!.goal = 'mutated by caller'
  assert.equal(
    (await reopened.get()).document.tasks[0]?.goal,
    'Create, explain, and export the plot',
  )
  assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true)
})

test('fails explicitly without overwriting an invalid stored snapshot', async () => {
  const filePath = await temporarySnapshot()
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify({ branch: 'main', revision: 7 }), 'utf8')
  const source = await readFile(filePath, 'utf8')
  const store = new CanvasCommandStoreV2('main', { filePath })

  await assert.rejects(store.get(), CanvasSnapshotV2Error)
  assert.equal(await readFile(filePath, 'utf8'), source)
})

test('anchors checkpoints without changing the semantic revision', async () => {
  const filePath = await temporarySnapshot()
  const store = new CanvasCommandStoreV2('main', { filePath })
  const committed = await store.commit(0, 'mutation-1', createTask('task-1'))
  const checkpoint = 'a'.repeat(40)
  const anchored = await store.setLastCheckpoint(committed.revision, checkpoint)

  assert.equal(anchored.revision, committed.revision)
  assert.equal(anchored.updatedAt, committed.updatedAt)
  assert.equal(anchored.lastCheckpoint, checkpoint)
  assert.deepEqual(await store.setLastCheckpoint(committed.revision, checkpoint), anchored)
  await assert.rejects(
    store.setLastCheckpoint(0, 'b'.repeat(40)),
    CanvasRevisionConflictV2Error,
  )
})

test('materializes and applies Git documents behind revision CAS', async () => {
  const filePath = await temporarySnapshot()
  let now = Date.parse('2026-08-05T12:00:00.000Z')
  const store = new CanvasCommandStoreV2('restored', { filePath, now: () => now })
  const document = emptyCanvasDocumentV2()
  document.tasks.push(createTask('task-1').task)
  document.everCreated = true
  const firstCommit = 'c'.repeat(40)

  const materialized = await store.materialize(document, firstCommit)
  assert.equal(materialized.revision, 1)
  assert.equal(materialized.lastMutationId, null)
  assert.equal(materialized.lastCheckpoint, firstCommit)
  await assert.rejects(
    store.materialize(document, firstCommit),
    CanvasRevisionConflictV2Error,
  )

  now += 1_000
  const mergedDocument = structuredClone(document)
  mergedDocument.tasks[0]!.goal = 'Merged goal'
  const secondCommit = 'd'.repeat(40)
  const applied = await store.applyCheckpoint(mergedDocument, secondCommit, 1)
  assert.equal(applied.revision, 2)
  assert.equal(applied.lastMutationId, null)
  assert.equal(applied.lastCheckpoint, secondCommit)
  assert.equal(applied.document.tasks[0]?.goal, 'Merged goal')
  await assert.rejects(
    store.applyCheckpoint(document, firstCommit, 1),
    CanvasRevisionConflictV2Error,
  )
})
