import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { parseDaemonPort } from './dev-all-options.mjs'
import {
  classifyDaemonOccupant,
  EXPECTED_CANVAS_SCHEMA_VERSION,
  isCurrentCanvasHealth,
  parseDaemonHealth,
  parseLeasePid,
  probeDaemonHealth,
  readWorkspaceDaemonPid,
  sameProjectRoot,
  stopOwnedDaemon,
  waitForCurrentDaemon,
  waitUntilPortFree,
  WORKSPACE_DAEMON_LOCK_RELATIVE,
} from './dev-all-lifecycle.mjs'

function health(overrides = {}) {
  return {
    capabilities: { canvas: true },
    canvas: { schemaVersion: 3, initializationRequired: false },
    projectRoot: '/workspace/app',
    ...overrides,
  }
}

test('parses GGAI_DAEMON_PORT with the same integer bounds as Vite', () => {
  assert.equal(parseDaemonPort({}), 7380)
  assert.equal(parseDaemonPort({ GGAI_DAEMON_PORT: ' 7391 ' }), 7391)
  assert.throws(() => parseDaemonPort({ GGAI_DAEMON_PORT: 'nope' }), /GGAI_DAEMON_PORT/u)
})

test('accepts a current Canvas health payload and rejects a stale schema', () => {
  assert.deepEqual(parseDaemonHealth(health()), {
    schemaVersion: 3,
    projectRoot: '/workspace/app',
    initializationRequired: false,
  })
  assert.equal(isCurrentCanvasHealth(parseDaemonHealth(health({
    canvas: { schemaVersion: 2, initializationRequired: false },
  }))), false)
  assert.equal(parseDaemonHealth({ status: 'ok' }), null)
  assert.equal(EXPECTED_CANVAS_SCHEMA_VERSION, 3)
})

test('replaces a same-project daemon, including a still-healthy leftover process', () => {
  const current = parseDaemonHealth(health())
  assert.deepEqual(
    classifyDaemonOccupant({ kind: 'empty' }, '/workspace/app'),
    { action: 'start' },
  )
  assert.equal(
    classifyDaemonOccupant({ kind: 'ggai', health: current }, '/workspace/app').action,
    'replace',
  )
  assert.equal(
    classifyDaemonOccupant({
      kind: 'ggai',
      health: parseDaemonHealth(health({
        canvas: { schemaVersion: 2, initializationRequired: false },
      })),
    }, '/workspace/app').reason,
    'stale',
  )
  assert.equal(
    classifyDaemonOccupant({
      kind: 'ggai',
      health: parseDaemonHealth(health({ projectRoot: '/other/project' })),
    }, '/workspace/app').action,
    'abort',
  )
  assert.equal(
    classifyDaemonOccupant({ kind: 'occupied-unknown', status: 200 }, '/workspace/app').action,
    'abort',
  )
})

test('compares project roots after resolving the current working directory', () => {
  assert.equal(sameProjectRoot(process.cwd(), process.cwd()), true)
  assert.equal(sameProjectRoot('/workspace/a', '/workspace/b'), false)
})

test('reads a workspace daemon lease pid and ignores malformed locks', () => {
  assert.equal(parseLeasePid('{"pid":83045,"token":"abc"}\n'), 83045)
  assert.equal(parseLeasePid('{'), null)
  assert.equal(parseLeasePid('{"pid":1,"token":"abc"}'), null)
  const lockPath = path.join('/workspace/app', WORKSPACE_DAEMON_LOCK_RELATIVE)
  assert.equal(readWorkspaceDaemonPid('/workspace/app', {
    exists: (filePath) => filePath === lockPath,
    readFile: () => '{"pid":15138,"token":"lease"}\n',
  }), 15138)
  assert.equal(readWorkspaceDaemonPid('/workspace/app', { exists: () => false }), null)
})

test('treats a refused health probe as an empty port', async () => {
  const empty = await probeDaemonHealth('http://127.0.0.1:7380', async () => {
    throw new TypeError('fetch failed')
  })
  assert.deepEqual(empty, { kind: 'empty' })

  const timeout = await probeDaemonHealth('http://127.0.0.1:7380', async () => {
    const error = new Error('aborted')
    error.name = 'TimeoutError'
    throw error
  })
  assert.equal(timeout.kind, 'occupied-unknown')

  const stale = await probeDaemonHealth('http://127.0.0.1:7380', async () => new Response(
    JSON.stringify(health({ canvas: { schemaVersion: 2, initializationRequired: false } })),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))
  assert.equal(stale.kind, 'ggai')
  assert.equal(stale.health.schemaVersion, 2)
})

test('waits until a leftover daemon releases the port, then until the current schema is ready', async () => {
  let probes = 0
  const freed = await waitUntilPortFree(async () => {
    probes += 1
    return probes < 3 ? { kind: 'ggai', health: parseDaemonHealth(health()) } : { kind: 'empty' }
  }, { sleep: async () => undefined, intervalMs: 0 })
  assert.equal(freed, true)

  let readyProbes = 0
  const ready = await waitForCurrentDaemon(async () => {
    readyProbes += 1
    return readyProbes < 2
      ? { kind: 'empty' }
      : { kind: 'ggai', health: parseDaemonHealth(health()) }
  }, { sleep: async () => undefined, intervalMs: 0 })
  assert.equal(ready.schemaVersion, 3)

  await assert.rejects(
    waitForCurrentDaemon(async () => ({ kind: 'empty' }), {
      isDaemonAlive: () => false,
      sleep: async () => undefined,
    }),
    /就绪前退出/u,
  )
})

test('interrupts only a valid leftover pid and waits for the health probe to go empty', async () => {
  const signals = []
  const stopped = await stopOwnedDaemon(83045, {
    kill: (pid, signal) => signals.push([pid, signal]),
    isAlive: () => signals.length === 0,
    probe: async () => (signals.length === 0 ? { kind: 'ggai', health: parseDaemonHealth(health()) } : { kind: 'empty' }),
    sleep: async () => undefined,
  })
  assert.equal(stopped, true)
  assert.deepEqual(signals, [[83045, 'SIGINT']])
  await assert.rejects(stopOwnedDaemon(1), /PID 无效/u)
})
