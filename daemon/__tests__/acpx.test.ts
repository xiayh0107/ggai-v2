import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentRegistry } from '../registry.js'
import { AcpxTransport } from '../transport/acpx.js'

test('acpx uses strict JSON and safe non-interactive permission defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-acpx-'))
  const executable = path.join(root, 'fake-acpx.mjs')
  const capture = path.join(root, 'args.json')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n')`,
    "if (args.includes('ensure')) process.exit(0)",
    "console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'raw-adapter-id', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } }))",
    "console.log(JSON.stringify({ type: 'done', stopReason: 'end_turn' }))",
  ].join('\n'), 'utf8')
  await chmod(executable, 0o755)

  try {
    const transport = new AcpxTransport({ command: executable })
    const sessions: string[] = []
    const result = await transport.run({
      runId: 'run-acpx',
      nodeId: 'node-acpx',
      agentId: 'acpx:codex',
      sessionId: null,
      prompt: 'do the task',
      projectDir: root,
      contextFile: path.join(root, '.gg/context/runs/run-acpx/pack.md'),
      artifactDir: path.join(root, 'artifacts/node-acpx'),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onSessionId: (sessionId) => sessions.push(sessionId),
    })
    assert.match(result.sessionId ?? '', /^ggai-[a-f0-9]{16}$/u)
    assert.deepEqual(sessions, [result.sessionId])
    const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map((line) =>
      JSON.parse(line) as string[])
    assert.equal(invocations.length, 2)
    assert.deepEqual(invocations[0].slice(-5), [
      'codex', 'sessions', 'ensure', '--name', result.sessionId,
    ])
    const args = invocations[1]
    assert.deepEqual(args.slice(0, 8), [
      '--cwd', root,
      '--format', 'json',
      '--json-strict',
      '--non-interactive-permissions', 'fail',
      '--approve-reads',
    ])
    assert.deepEqual(args.slice(8, 12), ['codex', 'prompt', '-s', result.sessionId])
    assert.equal(args.at(-1), 'do the task')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acpx only honors approve-all for an explicitly bound source worktree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-acpx-source-boundary-'))
  const executable = path.join(root, 'fake-acpx.mjs')
  const capture = path.join(root, 'args.jsonl')
  const sourceProjectDir = path.join(root, '.gg', 'source-worktrees', 'managed-id')
  await mkdir(sourceProjectDir, { recursive: true })
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n')`,
    "if (args.includes('ensure')) process.exit(0)",
    "console.log(JSON.stringify({ type: 'done', stopReason: 'end_turn' }))",
  ].join('\n'), 'utf8')
  await chmod(executable, 0o755)

  const baseOptions = {
    agentId: 'acpx:codex',
    sessionId: null,
    projectDir: root,
    contextFile: path.join(root, '.gg/context/pack.md'),
    artifactDir: path.join(root, 'artifacts/node'),
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onSessionId: () => undefined,
  }

  try {
    const transport = new AcpxTransport({ command: executable, approvalMode: 'approve-all' })
    await transport.run({
      ...baseOptions,
      runId: 'run-unbound',
      nodeId: 'node-unbound',
      prompt: 'unbound prompt',
    })
    await transport.run({
      ...baseOptions,
      runId: 'run-bound',
      nodeId: 'node-bound',
      prompt: 'bound prompt',
      sourceProjectDir,
    })

    const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map((line) =>
      JSON.parse(line) as string[])
    const unbound = invocations.find((args) => args.at(-1) === 'unbound prompt')
    const bound = invocations.find((args) => args.at(-1) === 'bound prompt')
    assert.ok(unbound)
    assert.ok(bound)
    assert.deepEqual(unbound.slice(0, 2), ['--cwd', root])
    assert.equal(unbound.includes('--approve-reads'), true)
    assert.equal(unbound.includes('--approve-all'), false)
    assert.deepEqual(bound.slice(0, 2), ['--cwd', sourceProjectDir])
    assert.equal(bound.includes('--approve-all'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acpx does not expose a session name when session ensure fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-acpx-ensure-'))
  const executable = path.join(root, 'fake-acpx.mjs')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "console.error('session ensure failed')",
    'process.exitCode = 4',
  ].join('\n'), 'utf8')
  await chmod(executable, 0o755)

  try {
    const transport = new AcpxTransport({ command: executable })
    const sessions: string[] = []
    await assert.rejects(() => transport.run({
      runId: 'run-ensure-failure',
      nodeId: 'node-ensure-failure',
      agentId: 'acpx:codex',
      sessionId: null,
      prompt: 'do not send this',
      projectDir: root,
      contextFile: path.join(root, '.gg/context/pack.md'),
      artifactDir: path.join(root, 'artifacts/node-ensure-failure'),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onSessionId: (sessionId) => sessions.push(sessionId),
    }), /session ensure failed/u)
    assert.deepEqual(sessions, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acpx cooperatively cancels an active named session before process cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-acpx-cancel-'))
  const executable = path.join(root, 'fake-acpx.mjs')
  const capture = path.join(root, 'cancel-args.jsonl')
  const cancelMarker = path.join(root, 'cancelled')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n')`,
    "if (args.includes('ensure')) process.exit(0)",
    `if (args.includes('cancel')) { writeFileSync(${JSON.stringify(cancelMarker)}, '1'); process.exit(0) }`,
    "if (args.includes('prompt')) {",
    `  const timer = setInterval(() => { if (existsSync(${JSON.stringify(cancelMarker)})) { clearInterval(timer); process.exit(0) } }, 10)`,
    '}',
  ].join('\n'), 'utf8')
  await chmod(executable, 0o755)

  try {
    const transport = new AcpxTransport({ command: executable })
    const runPromise = transport.run({
      runId: 'run-cooperative-cancel',
      nodeId: 'node-cooperative-cancel',
      agentId: 'acpx:codex',
      sessionId: null,
      prompt: 'keep running',
      projectDir: root,
      contextFile: path.join(root, '.gg/context/pack.md'),
      artifactDir: path.join(root, 'artifacts/node-cooperative-cancel'),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onSessionId: () => undefined,
    })
    await waitForFileText(capture, 'prompt')
    const cancellationResults = await Promise.all([
      transport.cancel('run-cooperative-cancel'),
      transport.cancel('run-cooperative-cancel'),
      transport.cancel('run-cooperative-cancel'),
    ])
    assert.deepEqual(cancellationResults, [true, true, true])
    await assert.rejects(runPromise, /cancelled/u)

    const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map((line) =>
      JSON.parse(line) as string[])
    assert.equal(invocations.some((args) => args.includes('ensure')), true)
    assert.equal(invocations.some((args) => args.includes('prompt')), true)
    const cancellations = invocations.filter((args) => args.includes('cancel'))
    assert.equal(cancellations.length, 1)
    const cancellation = cancellations[0]
    assert.ok(cancellation)
    assert.deepEqual(cancellation.slice(-4), ['codex', 'cancel', '-s', cancellation.at(-1)])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acpx force-stops session ensure without issuing a premature session cancel', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-acpx-cancel-ensure-'))
  const executable = path.join(root, 'fake-acpx.mjs')
  const capture = path.join(root, 'ensure-cancel-args.jsonl')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n')`,
    "process.on('SIGTERM', () => process.exit(0))",
    "if (args.includes('ensure')) setInterval(() => undefined, 1_000)",
  ].join('\n'), 'utf8')
  await chmod(executable, 0o755)

  try {
    const transport = new AcpxTransport({ command: executable })
    const runPromise = transport.run({
      runId: 'run-cancel-ensure',
      nodeId: 'node-cancel-ensure',
      agentId: 'acpx:codex',
      sessionId: null,
      prompt: 'do not start',
      projectDir: root,
      contextFile: path.join(root, '.gg/context/pack.md'),
      artifactDir: path.join(root, 'artifacts/node-cancel-ensure'),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onSessionId: () => undefined,
    })
    const rejection = assert.rejects(runPromise, /cancelled/u)
    await waitForFileText(capture, 'ensure')
    assert.equal(await transport.cancel('run-cancel-ensure'), true)
    await rejection

    const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map((line) =>
      JSON.parse(line) as string[])
    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].includes('ensure'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acpx retries session cancellation after stopping a not-yet-registered prompt client', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-acpx-cancel-race-'))
  const executable = path.join(root, 'fake-acpx.mjs')
  const capture = path.join(root, 'race-cancel-args.jsonl')
  const queuedMarker = path.join(root, 'queued')
  const firstCancelMarker = path.join(root, 'first-cancel')
  const clientStoppedMarker = path.join(root, 'client-stopped')
  const cancelledMarker = path.join(root, 'owner-cancelled')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n')`,
    "if (args.includes('ensure')) process.exit(0)",
    "if (args.includes('cancel')) {",
    `  if (!existsSync(${JSON.stringify(firstCancelMarker)})) writeFileSync(${JSON.stringify(firstCancelMarker)}, '1')`,
    `  else if (existsSync(${JSON.stringify(queuedMarker)}) && existsSync(${JSON.stringify(clientStoppedMarker)})) writeFileSync(${JSON.stringify(cancelledMarker)}, '1')`,
    '  process.exit(0)',
    '}',
    "if (args.includes('prompt')) {",
    `  setTimeout(() => writeFileSync(${JSON.stringify(queuedMarker)}, '1'), 100)`,
    `  process.on('SIGTERM', () => setTimeout(() => { writeFileSync(${JSON.stringify(clientStoppedMarker)}, '1'); process.exit(0) }, 500))`,
    `  setInterval(() => { if (existsSync(${JSON.stringify(cancelledMarker)})) process.exit(0) }, 10)`,
    '}',
  ].join('\n'), 'utf8')
  await chmod(executable, 0o755)

  try {
    const transport = new AcpxTransport({ command: executable })
    const runPromise = transport.run({
      runId: 'run-cancel-registration-race',
      nodeId: 'node-cancel-registration-race',
      agentId: 'acpx:codex',
      sessionId: 'registration-race-session',
      prompt: 'race with cancellation',
      projectDir: root,
      contextFile: path.join(root, '.gg/context/pack.md'),
      artifactDir: path.join(root, 'artifacts/node-cancel-registration-race'),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onSessionId: () => undefined,
    })
    const rejection = assert.rejects(runPromise, /cancelled/u)
    await waitForFileText(capture, 'prompt')
    const cancellation = transport.cancel('run-cancel-registration-race')
    await waitForFileText(clientStoppedMarker, '1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await assert.rejects(() => transport.run({
      runId: 'run-cancel-registration-contender',
      nodeId: 'node-cancel-registration-contender',
      agentId: 'acpx:codex',
      sessionId: 'registration-race-session',
      prompt: 'must not start during cleanup',
      projectDir: root,
      contextFile: path.join(root, '.gg/context/pack.md'),
      artifactDir: path.join(root, 'artifacts/node-cancel-registration-contender'),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onSessionId: () => undefined,
    }), /session registration-race-session is already active/u)
    assert.equal(await cancellation, true)
    await rejection
    await waitForFileText(cancelledMarker, '1')

    const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map((line) =>
      JSON.parse(line) as string[])
    assert.equal(invocations.filter((args) => args.includes('cancel')).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acpx permits only one active run per cwd, adapter, and named session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-acpx-session-lock-'))
  const executable = path.join(root, 'fake-acpx.mjs')
  const capture = path.join(root, 'session-lock-args.jsonl')
  const cancelMarker = path.join(root, 'session-lock-cancelled')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n')`,
    "if (args.includes('ensure')) process.exit(0)",
    `if (args.includes('cancel')) { writeFileSync(${JSON.stringify(cancelMarker)}, '1'); process.exit(0) }`,
    "if (args.includes('prompt')) {",
    `  const timer = setInterval(() => { if (existsSync(${JSON.stringify(cancelMarker)})) { clearInterval(timer); process.exit(0) } }, 10)`,
    '}',
  ].join('\n'), 'utf8')
  await chmod(executable, 0o755)

  const options = {
    agentId: 'acpx:codex',
    sessionId: 'shared-session',
    prompt: 'hold the session',
    projectDir: root,
    contextFile: path.join(root, '.gg/context/pack.md'),
    artifactDir: path.join(root, 'artifacts/shared-session'),
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onSessionId: () => undefined,
  }

  try {
    const transport = new AcpxTransport({ command: executable })
    const firstRun = transport.run({
      ...options,
      runId: 'session-owner-run',
      nodeId: 'session-owner-node',
    })
    const firstRejection = assert.rejects(firstRun, /cancelled/u)
    await waitForFileText(capture, 'prompt')

    await assert.rejects(() => transport.run({
      ...options,
      runId: 'session-contender-run',
      nodeId: 'session-contender-node',
    }), /session shared-session is already active/u)

    assert.equal(await transport.cancel('session-owner-run'), true)
    await firstRejection
    const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map((line) =>
      JSON.parse(line) as string[])
    assert.equal(invocations.filter((args) => args.includes('ensure')).length, 1)
    assert.equal(invocations.filter((args) => args.includes('prompt')).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('registry resolves only explicitly configured acpx adapters', () => {
  assert.equal(new AgentRegistry().resolve('acpx:codex'), null)
  const registry = new AgentRegistry({ acpxAgents: ['codex'] })
  assert.ok(registry.resolve('acpx:codex'))
  assert.equal(registry.resolve('acpx:unconfigured'), null)
  assert.throws(() => new AgentRegistry({ acpxAgents: ['--approve-all'] }), /invalid configured/)
})

async function waitForFileText(file: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const contents = await readFile(file, 'utf8').catch(() => '')
    if (contents.includes(expected)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${expected} in ${file}`)
}

test('registry freezes a relative acpx path before the transport changes cwd', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-acpx-relative-'))
  const executable = path.join(root, 'fake-acpx.mjs')
  const capture = path.join(root, 'relative-args.json')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs'",
    "const args = process.argv.slice(2)",
    "if (args[0] === '--version') { console.log('acpx 0.13.0'); process.exit(0) }",
    "if (args[0] === '--help') { console.log('--cwd --format --json-strict --non-interactive-permissions --approve-reads'); process.exit(0) }",
    "if (args.at(-1) === '--help' && args.includes('prompt')) { console.log('-s --session'); process.exit(0) }",
    "if (args.at(-1) === '--help' && args.includes('ensure')) { console.log('--name'); process.exit(0) }",
    "if (args.at(-1) === '--help' && args.includes('cancel')) { console.log('-s --session'); process.exit(0) }",
    `writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args))`,
    "console.log(JSON.stringify({ type: 'done', stopReason: 'end_turn' }))",
  ].join('\n'), 'utf8')
  await chmod(executable, 0o755)

  try {
    const relativeCommand = path.relative(process.cwd(), executable)
    const registry = new AgentRegistry({
      codexCommand: path.join(root, 'missing-codex'),
      acpxCommand: relativeCommand,
      acpxAgents: ['codex'],
    })
    const descriptor = (await registry.probe()).find((agent) => agent.id === 'acpx:codex')
    assert.equal(descriptor?.available, true)

    const transport = registry.resolve('acpx:codex')
    assert.ok(transport)
    await transport.run({
      runId: 'relative-run',
      nodeId: 'relative-node',
      agentId: 'acpx:codex',
      sessionId: null,
      prompt: 'verify relative command',
      projectDir: root,
      contextFile: path.join(root, '.gg/context/pack.md'),
      artifactDir: path.join(root, 'artifacts/relative-node'),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onSessionId: () => undefined,
    })
    const args = JSON.parse(await readFile(capture, 'utf8')) as string[]
    assert.equal(args.at(-1), 'verify relative command')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
