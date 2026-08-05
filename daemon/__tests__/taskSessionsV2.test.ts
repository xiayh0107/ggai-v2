import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  TaskSessionStoreV2,
  TaskSessionsV2CorruptionError,
  taskSessionKeyV2,
} from '../taskSessionsV2.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ggai-task-sessions-v2-'))
  temporaryDirectories.push(directory)
  return directory
}

test('persists exact task session records using a constructor-owned file path', async () => {
  const directory = await temporaryDirectory()
  const filePath = join(directory, 'state', 'task-sessions-v2.json')
  let now = 100
  const store = new TaskSessionStoreV2(filePath, { now: () => now })

  const initial = await store.upsert({
    canvasBranch: 'main',
    taskId: 'task-1',
    agentId: '@openai/codex',
    sessionId: null,
  })
  assert.deepEqual(initial, {
    canvasBranch: 'main',
    taskId: 'task-1',
    agentId: '@openai/codex',
    sessionId: null,
    createdAt: 100,
    lastActiveAt: 100,
  })

  now = 150
  const resumed = await store.upsert({
    canvasBranch: 'main',
    taskId: 'task-1',
    agentId: '@openai/codex',
    sessionId: 'session-1',
  })
  assert.equal(resumed.createdAt, 100)
  assert.equal(resumed.lastActiveAt, 150)
  assert.deepEqual(
    await new TaskSessionStoreV2(filePath).get('main', 'task-1', '@openai/codex'),
    resumed,
  )

  const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
  const key = taskSessionKeyV2('main', 'task-1', '@openai/codex')
  assert.deepEqual(onDisk[key], resumed)
  assert.deepEqual(Object.keys(onDisk[key] as object).sort(), [
    'agentId',
    'canvasBranch',
    'createdAt',
    'lastActiveAt',
    'sessionId',
    'taskId',
  ])
  assert.equal(
    (await readdir(join(directory, 'state'))).some((entry) => entry.endsWith('.tmp')),
    false,
  )
})

test('isolates sessions by both canvas branch and task id', async () => {
  const directory = await temporaryDirectory()
  const store = new TaskSessionStoreV2(join(directory, 'sessions.json'))

  await store.upsert({
    canvasBranch: 'main',
    taskId: 'task-shared',
    agentId: 'codex',
    sessionId: 'main-session',
  })
  await store.upsert({
    canvasBranch: 'experiment/a',
    taskId: 'task-shared',
    agentId: 'codex',
    sessionId: 'branch-session',
  })
  await store.upsert({
    canvasBranch: 'main',
    taskId: 'task-other',
    agentId: 'codex',
    sessionId: 'other-task-session',
  })

  assert.equal(
    (await store.get('main', 'task-shared', 'codex'))?.sessionId,
    'main-session',
  )
  assert.equal(
    (await store.get('experiment/a', 'task-shared', 'codex'))?.sessionId,
    'branch-session',
  )
  assert.equal(
    (await store.get('main', 'task-other', 'codex'))?.sessionId,
    'other-task-session',
  )
  assert.deepEqual(
    (await store.list({ canvasBranch: 'main' })).map((record) => record.taskId),
    ['task-other', 'task-shared'],
  )
  assert.deepEqual(
    (await store.list({ taskId: 'task-shared' })).map((record) => record.canvasBranch),
    ['experiment/a', 'main'],
  )
})

test('serializes concurrent upserts without losing records', async () => {
  const directory = await temporaryDirectory()
  const filePath = join(directory, 'sessions.json')
  let now = 0
  const store = new TaskSessionStoreV2(filePath, { now: () => (now += 1) })

  await Promise.all(Array.from({ length: 40 }, (_, index) => store.upsert({
    canvasBranch: index % 2 === 0 ? 'main' : 'experiment',
    taskId: `task-${index}`,
    agentId: 'codex',
    sessionId: `session-${index}`,
  })))

  assert.equal((await store.list()).length, 40)
  assert.equal((await new TaskSessionStoreV2(filePath).list()).length, 40)
})

test('quarantines damaged data and remains explicitly blocked', async () => {
  const directory = await temporaryDirectory()
  const filePath = join(directory, 'sessions.json')
  await writeFile(filePath, '{ invalid json', 'utf8')
  const store = new TaskSessionStoreV2(filePath)

  let corruption: TaskSessionsV2CorruptionError | undefined
  await assert.rejects(store.list(), (error: unknown) => {
    assert.ok(error instanceof TaskSessionsV2CorruptionError)
    corruption = error
    return true
  })
  assert.ok(corruption)
  assert.equal(await readFile(corruption.recovery.quarantinePath, 'utf8'), '{ invalid json')
  await assert.rejects(store.get('main', 'task-1', 'codex'), TaskSessionsV2CorruptionError)
  await assert.rejects(store.upsert({
    canvasBranch: 'main',
    taskId: 'task-1',
    agentId: 'codex',
    sessionId: 'must-not-overwrite',
  }), TaskSessionsV2CorruptionError)
  await assert.rejects(new TaskSessionStoreV2(filePath).list(), TaskSessionsV2CorruptionError)
})

test('quarantines records whose stored key or exact schema is invalid', async () => {
  const directory = await temporaryDirectory()
  const filePath = join(directory, 'sessions.json')
  await writeFile(filePath, JSON.stringify({
    [taskSessionKeyV2('main', 'task-1', 'codex')]: {
      canvasBranch: 'main',
      taskId: 'task-forged',
      agentId: 'codex',
      sessionId: 'session-1',
      createdAt: 10,
      lastActiveAt: 20,
      payload: { forbidden: true },
    },
  }), 'utf8')

  const store = new TaskSessionStoreV2(filePath)
  await assert.rejects(store.list(), TaskSessionsV2CorruptionError)
  assert.ok(store.recovery?.quarantinePath.includes('sessions.json.corrupt-'))
})

test('never follows or overwrites a task sessions symlink', async () => {
  const directory = await temporaryDirectory()
  const outside = await temporaryDirectory()
  const filePath = join(directory, 'sessions.json')
  const outsideFile = join(outside, 'outside.json')
  await writeFile(outsideFile, '{"outside":true}\n', 'utf8')
  await symlink(outsideFile, filePath)

  const store = new TaskSessionStoreV2(filePath)
  await assert.rejects(store.list(), /must not be a symlink/u)
  await assert.rejects(store.upsert({
    canvasBranch: 'main',
    taskId: 'task-1',
    agentId: 'codex',
    sessionId: 'must-not-write',
  }), /must not be a symlink/u)
  assert.equal(await readFile(outsideFile, 'utf8'), '{"outside":true}\n')
})

test('strictly rejects invalid branch, task, agent, session, and timestamps', async () => {
  const directory = await temporaryDirectory()
  const store = new TaskSessionStoreV2(join(directory, 'sessions.json'))
  const base = {
    canvasBranch: 'main',
    taskId: 'task-1',
    agentId: 'codex',
    sessionId: 'session-1',
  }

  await assert.rejects(store.upsert({ ...base, canvasBranch: '../escape' }), /branch/u)
  await assert.rejects(store.upsert({ ...base, taskId: 'task/escape' }), /taskId/u)
  await assert.rejects(store.upsert({ ...base, agentId: '../agent' }), /agentId/u)
  await assert.rejects(store.upsert({ ...base, sessionId: '--dangerous' }), /safe CLI/u)
  await assert.rejects(store.upsert({ ...base, sessionId: ' padded ' }), /safe CLI/u)
  await assert.rejects(store.upsert({
    ...base,
    createdAt: 20,
    lastActiveAt: 10,
  }), /earlier than createdAt/u)
  assert.throws(() => taskSessionKeyV2('main', 'task/escape', 'codex'), /taskId/u)
})
