import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  SessionStore,
  SessionsCorruptionError,
  sessionKey,
  sessionsFilePath,
  type SessionRecord,
} from '../sessions.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ggai-sessions-'))
  temporaryDirectories.push(directory)
  return directory
}

test('upsert, get, and list persist sessions by node and agent key', async () => {
  const projectDir = await temporaryProject()
  let now = 100
  const store = new SessionStore(projectDir, { now: () => now })

  const initial = await store.upsert({
    nodeId: 'node:one',
    agentId: 'agent/acp',
    sessionId: null,
  })
  assert.deepEqual(initial, {
    canvasBranch: 'main',
    nodeId: 'node:one',
    agentId: 'agent/acp',
    sessionId: null,
    createdAt: 100,
    lastActiveAt: 100,
  })

  now = 150
  const resumed = await store.upsert({
    nodeId: 'node:one',
    agentId: 'agent/acp',
    sessionId: 'session-1',
  })
  assert.equal(resumed.createdAt, 100)
  assert.equal(resumed.lastActiveAt, 150)

  now = 200
  await store.upsert({ nodeId: 'node-2', agentId: 'agent/acp', sessionId: 'session-2' })
  assert.equal((await store.list()).length, 2)
  assert.deepEqual(await store.list({ nodeId: 'node:one' }), [resumed])

  const reopened = new SessionStore(projectDir)
  assert.deepEqual(await reopened.get('node:one', 'agent/acp'), resumed)
  assert.equal(sessionKey('node:one', 'agent/acp'), 'main:node%3Aone:agent%2Facp')

  const onDisk = JSON.parse(await readFile(sessionsFilePath(projectDir), 'utf8')) as Record<
    string,
    unknown
  >
  assert.ok(onDisk['main:node%3Aone:agent%2Facp'])
  assert.equal(
    (await readdir(join(projectDir, '.gg'))).some((entry) => entry.endsWith('.tmp')),
    false,
  )
})

test('serialized concurrent upserts do not lose records', async () => {
  const projectDir = await temporaryProject()
  let now = 0
  const store = new SessionStore(projectDir, { now: () => (now += 1) })

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.upsert({
        nodeId: `node-${index}`,
        agentId: 'agent',
        sessionId: `session-${index}`,
      }),
    ),
  )

  assert.equal((await store.list()).length, 20)
  assert.equal((await new SessionStore(projectDir).list()).length, 20)
})

test('damaged JSON is quarantined and requires explicit recovery', async () => {
  const projectDir = await temporaryProject()
  const filePath = sessionsFilePath(projectDir)
  await mkdir(join(projectDir, '.gg'), { recursive: true })
  await writeFile(filePath, '{ this is not valid JSON', 'utf8')

  const store = new SessionStore(projectDir)
  let corruption: SessionsCorruptionError | undefined
  await assert.rejects(store.list(), (error: unknown) => {
    assert.ok(error instanceof SessionsCorruptionError)
    corruption = error
    return true
  })

  assert.ok(corruption)
  assert.equal(await readFile(corruption.recovery.quarantinePath, 'utf8'), '{ this is not valid JSON')
  await assert.rejects(
    store.upsert({ nodeId: 'node', agentId: 'agent', sessionId: 'would-overwrite' }),
    SessionsCorruptionError,
  )

  // A process restart must also notice an awaiting quarantine rather than
  // silently creating a fresh file.
  await assert.rejects(new SessionStore(projectDir).list(), SessionsCorruptionError)

  const recovered: SessionRecord = {
    canvasBranch: 'main',
    nodeId: 'node',
    agentId: 'agent',
    sessionId: 'salvaged-session',
    createdAt: 10,
    lastActiveAt: 20,
  }
  assert.deepEqual(await store.recover([recovered]), [recovered])
  assert.deepEqual(await store.get('node', 'agent'), recovered)
  assert.deepEqual(await new SessionStore(projectDir).get('node', 'agent'), recovered)
  assert.equal(await readFile(corruption.recovery.quarantinePath, 'utf8'), '{ this is not valid JSON')
})

test('sessions with the same node id remain isolated by canvas branch', async () => {
  const projectDir = await temporaryProject()
  const store = new SessionStore(projectDir)

  await store.upsert({
    canvasBranch: 'main',
    nodeId: 'shared-node',
    agentId: 'codex',
    sessionId: 'main-session',
  })
  await store.upsert({
    canvasBranch: 'experiment/a',
    nodeId: 'shared-node',
    agentId: 'codex',
    sessionId: 'experiment-session',
  })

  assert.equal(
    (await store.get('shared-node', 'codex', 'main'))?.sessionId,
    'main-session',
  )
  assert.equal(
    (await store.get('shared-node', 'codex', 'experiment/a'))?.sessionId,
    'experiment-session',
  )
  assert.deepEqual(
    (await store.list({ canvasBranch: 'experiment/a' })).map((record) => record.sessionId),
    ['experiment-session'],
  )
})

test('legacy node and agent keys reopen as main-branch sessions', async () => {
  const projectDir = await temporaryProject()
  const filePath = sessionsFilePath(projectDir)
  await mkdir(join(projectDir, '.gg'), { recursive: true })
  await writeFile(
    filePath,
    JSON.stringify({
      'legacy-node:codex': {
        sessionId: 'legacy-session',
        createdAt: 10,
        lastActiveAt: 20,
      },
    }),
    'utf8',
  )

  const record = await new SessionStore(projectDir).get('legacy-node', 'codex', 'main')
  assert.equal(record?.canvasBranch, 'main')
  assert.equal(record?.sessionId, 'legacy-session')
})

test('schema-invalid session data is treated as corruption, not partially accepted', async () => {
  const projectDir = await temporaryProject()
  const filePath = sessionsFilePath(projectDir)
  await mkdir(join(projectDir, '.gg'), { recursive: true })
  await writeFile(
    filePath,
    JSON.stringify({ 'node:agent': { sessionId: 'session', lastActiveAt: 'yesterday' } }),
    'utf8',
  )

  const store = new SessionStore(projectDir)
  await assert.rejects(store.get('node', 'agent'), SessionsCorruptionError)
  assert.ok(store.recovery?.quarantinePath.includes('sessions.json.corrupt-'))
})

test('a sessions.json symlink is never followed or overwritten', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  const outsideFile = join(outside, 'outside-sessions.json')
  await mkdir(join(projectDir, '.gg'), { recursive: true })
  await writeFile(outsideFile, '{"outside":true}\n', 'utf8')
  await symlink(outsideFile, sessionsFilePath(projectDir))

  const store = new SessionStore(projectDir)
  await assert.rejects(store.list())
  await assert.rejects(
    store.upsert({ nodeId: 'node', agentId: 'codex', sessionId: 'must-not-write' }),
  )
  assert.equal(await readFile(outsideFile, 'utf8'), '{"outside":true}\n')
})

test('option-like session ids are never persisted for a future CLI resume', async () => {
  const projectDir = await temporaryProject()
  const store = new SessionStore(projectDir)
  await assert.rejects(
    store.upsert({ nodeId: 'node', agentId: 'codex', sessionId: '--dangerous' }),
    /safe non-empty CLI session identifier/,
  )
})
