import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { RunSummary } from '../protocol.js'
import { RunLogExistsError, RunLogStore } from '../runLogs.js'

async function fixture(): Promise<{ root: string; store: RunLogStore; close(): Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-run-log-'))
  return {
    root,
    store: new RunLogStore(root),
    async close() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

function summary(runId: string, status: RunSummary['status'] = 'running'): RunSummary {
  return {
    runId,
    nodeId: 'node-1',
    agentId: 'codex',
    canvasBranch: 'main',
    status,
    startedAt: 100,
    sessionId: null,
  }
}

function taskSummary(
  runId: string,
  status: RunSummary['status'] = 'running',
): RunSummary {
  return {
    ...summary(runId, status),
    taskId: 'task-1',
    nodeId: 'task-1',
    baseRevision: 17,
    prompt: 'Render the accepted revision exactly.',
  }
}

async function writeRawSummary(root: string, value: RunSummary): Promise<void> {
  const directory = path.join(root, '.gg', 'runtime', 'runs', value.runId)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'summary.json'), `${JSON.stringify(value)}\n`, 'utf8')
}

test('run history can be scoped to its logical canvas branch', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-main'))
    await subject.store.finish({ ...summary('run-main', 'done'), finishedAt: 200 })
    await subject.store.start({ ...summary('run-feature'), canvasBranch: 'feature/a' })
    await subject.store.finish({
      ...summary('run-feature', 'done'),
      canvasBranch: 'feature/a',
      finishedAt: 300,
    })

    assert.deepEqual(
      (await subject.store.list({ canvasBranch: 'feature/a' })).map((entry) => entry.runId),
      ['run-feature'],
    )
  } finally {
    await subject.close()
  }
})

test('task-owned history filtering happens before pagination', async () => {
  const subject = await fixture()
  try {
    await subject.store.start({ ...summary('run-legacy', 'done'), startedAt: 300 })
    await subject.store.start({
      ...summary('run-task-v2', 'done'),
      taskId: 'task-v2',
      nodeId: 'task-v2',
      startedAt: 200,
    })

    assert.deepEqual(
      (await subject.store.list({ taskOwned: true, limit: 1 })).map((entry) => entry.runId),
      ['run-task-v2'],
    )
    assert.deepEqual(
      (await subject.store.list({ taskOwned: false, limit: 1 })).map((entry) => entry.runId),
      ['run-legacy'],
    )
  } finally {
    await subject.close()
  }
})

test('legacy summaries without a canvas branch normalize to main', async () => {
  const subject = await fixture()
  try {
    const legacy = summary('run-legacy', 'done')
    delete legacy.canvasBranch
    await subject.store.start(legacy)

    assert.equal((await subject.store.summary('run-legacy'))?.canvasBranch, 'main')
    assert.deepEqual(
      (await subject.store.list({ canvasBranch: 'main' })).map((entry) => entry.runId),
      ['run-legacy'],
    )
  } finally {
    await subject.close()
  }
})

test('Task-owned intent metadata survives finish, list, and a new store instance', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(taskSummary('run-task-intent'))
    await subject.store.finish({
      ...taskSummary('run-task-intent', 'done'),
      finishedAt: 200,
      sessionId: 'task-session',
    })

    const restarted = new RunLogStore(subject.root)
    assert.deepEqual(await restarted.summary('run-task-intent'), {
      ...taskSummary('run-task-intent', 'done'),
      finishedAt: 200,
      sessionId: 'task-session',
    })
    assert.deepEqual(
      (await restarted.list({ taskId: 'task-1' })).map((entry) => ({
        runId: entry.runId,
        baseRevision: entry.baseRevision,
        prompt: entry.prompt,
      })),
      [{
        runId: 'run-task-intent',
        baseRevision: 17,
        prompt: 'Render the accepted revision exactly.',
      }],
    )
  } finally {
    await subject.close()
  }
})

test('Task-owned intent metadata rejects malformed or legacy-owned fields', async () => {
  const subject = await fixture()
  try {
    const invalid = [
      { ...taskSummary('run-negative-revision'), baseRevision: -1 },
      { ...taskSummary('run-fractional-revision'), baseRevision: 1.5 },
      { ...taskSummary('run-missing-prompt'), prompt: undefined },
      { ...taskSummary('run-missing-revision'), baseRevision: undefined },
      { ...taskSummary('run-oversized-prompt'), prompt: 'x'.repeat(250_001) },
      { ...summary('run-legacy-intent'), baseRevision: 1, prompt: 'not a V1 field' },
    ]
    for (const entry of invalid) {
      await writeRawSummary(subject.root, entry as RunSummary)
      await assert.rejects(
        subject.store.summary(entry.runId),
        /invalid durable summary: schema validation failed/u,
      )
    }
    assert.deepEqual(await subject.store.list(), [])
  } finally {
    await subject.close()
  }
})

test('starting an existing durable run id never overwrites its summary or events', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-stable'))
    await subject.store.append('run-stable', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'original' },
    })
    await assert.rejects(
      subject.store.start({ ...summary('run-stable'), nodeId: 'replacement' }),
      RunLogExistsError,
    )
    assert.equal((await subject.store.summary('run-stable'))?.nodeId, 'node-1')
    assert.equal((await subject.store.page('run-stable'))?.entries.length, 1)
  } finally {
    await subject.close()
  }
})

test('run log persists ordered messages and paginates by event id', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-1'))
    await Promise.all([
      subject.store.append('run-1', {
        id: 1,
        event: 'agent-event',
        data: { type: 'thinking', text: 'first' },
      }),
      subject.store.append('run-1', {
        id: 2,
        event: 'agent-event',
        data: { type: 'text-delta', text: 'second' },
      }),
      subject.store.append('run-1', {
        id: 3,
        event: 'agent-event',
        data: { type: 'done', stopReason: 'end_turn' },
      }),
    ])
    await subject.store.finish({ ...summary('run-1', 'done'), finishedAt: 200 })

    const first = await subject.store.page('run-1', { limit: 2 })
    assert.deepEqual(first?.entries.map((entry) => entry.id), [1, 2])
    assert.equal(first?.nextEventId, 2)
    const second = await subject.store.page('run-1', { afterEventId: 2, limit: 2 })
    assert.deepEqual(second?.entries.map((entry) => entry.id), [3])
    assert.equal(second?.nextEventId, null)
    assert.equal((await subject.store.summary('run-1'))?.status, 'done')
  } finally {
    await subject.close()
  }
})

test('legacy close messages without an outcome remain replayable', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-legacy-close'))
    await subject.store.append('run-legacy-close', {
      id: 1,
      event: 'close',
      data: {
        runId: 'run-legacy-close',
        status: 'done',
        sessionId: null,
        artifacts: [],
        artifactsComplete: true,
      },
    })
    await subject.store.finish({
      ...summary('run-legacy-close', 'done'),
      finishedAt: 200,
    })

    const page = await subject.store.page('run-legacy-close')
    const close = page?.entries[0]
    assert.ok(close && close.event === 'close')
    assert.equal(close.data.outcome, undefined)
  } finally {
    await subject.close()
  }
})

test('startup recovery marks unfinished runs interrupted without deleting logs', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-active'))
    await subject.store.append('run-active', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'still working' },
    })

    assert.equal(await subject.store.markInterrupted(), 1)
    assert.equal((await subject.store.summary('run-active'))?.status, 'interrupted')
    assert.equal((await subject.store.page('run-active'))?.entries.length, 1)
  } finally {
    await subject.close()
  }
})

test('V2 startup recovery returns durable Task identity and appends one replayable close', async () => {
  const subject = await fixture()
  try {
    await subject.store.start({
      ...taskSummary('run-task-recovery'),
      canvasBranch: 'feature/recovery',
    })
    await subject.store.append('run-task-recovery', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'before restart' },
    })

    const [candidate] = await subject.store.prepareInterruptedRecovery()
    assert.deepEqual(candidate?.summary, {
      ...taskSummary('run-task-recovery', 'interrupted'),
      canvasBranch: 'feature/recovery',
      finishedAt: candidate?.summary.finishedAt,
      error: 'daemon restarted before the run completed',
    })
    assert.equal(await subject.store.appendInterruptedCloseIfMissing('run-task-recovery', {
      runId: 'run-task-recovery',
      status: 'interrupted',
      sessionId: null,
      artifacts: [],
      artifactsComplete: false,
    }), true)
    assert.equal(await subject.store.appendInterruptedCloseIfMissing('run-task-recovery', {
      runId: 'run-task-recovery',
      status: 'interrupted',
      sessionId: null,
      artifacts: [],
      artifactsComplete: false,
    }), false)

    const page = await subject.store.page('run-task-recovery')
    assert.deepEqual(page?.entries.map(({ id, event }) => ({ id, event })), [
      { id: 1, event: 'agent-event' },
      { id: 2, event: 'close' },
    ])
    const close = page?.entries.at(-1)
    assert.ok(close && close.event === 'close')
    assert.equal(close.data.status, 'interrupted')
    assert.deepEqual(await subject.store.terminalClose('run-task-recovery'), close.data)
    assert.equal((await subject.store.prepareInterruptedRecovery()).length, 1)
  } finally {
    await subject.close()
  }
})

test('terminal close uses the indexed tail and rejects stale or truncated audit state', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-tail-open'))
    await subject.store.append('run-tail-open', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'not terminal' },
    })
    assert.equal(await subject.store.terminalClose('run-tail-open'), null)

    await subject.store.start(summary('run-tail-stale'))
    await subject.store.append('run-tail-stale', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'indexed' },
    })
    await appendFile(
      path.join(subject.store.rootDir, 'run-tail-stale', 'events.jsonl'),
      `${JSON.stringify({
        id: 2,
        event: 'close',
        data: {
          runId: 'run-tail-stale',
          status: 'interrupted',
          sessionId: null,
          artifacts: [],
          artifactsComplete: false,
        },
        recordedAt: 200,
      })}\n`,
      'utf8',
    )
    await assert.rejects(
      subject.store.terminalClose('run-tail-stale'),
      /index does not point at the terminal record/u,
    )

    await subject.store.start(summary('run-tail-truncated'))
    await subject.store.append('run-tail-truncated', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'indexed' },
    })
    await appendFile(
      path.join(subject.store.rootDir, 'run-tail-truncated', 'events.jsonl'),
      '{truncated',
      'utf8',
    )
    await assert.rejects(
      subject.store.terminalClose('run-tail-truncated'),
      /incomplete terminal record/u,
    )
  } finally {
    await subject.close()
  }
})

test('V2 recovery candidates exclude legacy and explicitly deleted logs', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-v1-active'))
    await subject.store.start({
      ...summary('run-v2-deleted'),
      taskId: 'task-deleted',
      nodeId: 'task-deleted',
      logAvailable: false,
    })

    assert.deepEqual(await subject.store.prepareInterruptedRecovery(), [])
    assert.equal((await subject.store.summary('run-v1-active'))?.status, 'interrupted')
    assert.equal((await subject.store.summary('run-v2-deleted'))?.status, 'interrupted')
  } finally {
    await subject.close()
  }
})

test('recovery refuses to append over a damaged log without blocking other runs', async () => {
  const subject = await fixture()
  try {
    for (const runId of ['run-damaged-events', 'run-valid-events']) {
      await subject.store.start({
        ...summary(runId),
        taskId: `task-${runId}`,
        nodeId: `task-${runId}`,
      })
    }
    await appendFile(
      path.join(subject.store.rootDir, 'run-damaged-events', 'events.jsonl'),
      '{incomplete',
      'utf8',
    )
    const candidates = await subject.store.prepareInterruptedRecovery()
    assert.equal(candidates.length, 2)
    await assert.rejects(subject.store.appendInterruptedCloseIfMissing('run-damaged-events', {
      runId: 'run-damaged-events',
      status: 'interrupted',
      sessionId: null,
      artifacts: [],
      artifactsComplete: false,
    }), /invalid|incomplete/u)
    assert.equal(await subject.store.appendInterruptedCloseIfMissing('run-valid-events', {
      runId: 'run-valid-events',
      status: 'interrupted',
      sessionId: null,
      artifacts: [],
      artifactsComplete: false,
    }), true)
    assert.equal(
      (await subject.store.page('run-valid-events'))?.entries.at(-1)?.event,
      'close',
    )
  } finally {
    await subject.close()
  }
})

test('startup recovery scans active runs beyond the public 2,000-entry history cap', async () => {
  const subject = await fixture()
  try {
    await writeRawSummary(subject.root, { ...summary('run-old-active'), startedAt: 1 })
    const terminal = Array.from({ length: 2_000 }, (_, index) => ({
      ...summary(`run-done-${index}`, 'done'),
      startedAt: index + 2,
      finishedAt: index + 2,
    }))
    for (let index = 0; index < terminal.length; index += 100) {
      await Promise.all(
        terminal.slice(index, index + 100).map((entry) => writeRawSummary(subject.root, entry)),
      )
    }

    assert.equal(await subject.store.markInterrupted(), 1)
    assert.equal((await subject.store.summary('run-old-active'))?.status, 'interrupted')
  } finally {
    await subject.close()
  }
})

test('one corrupt summary does not block recovery of other runs', async () => {
  const subject = await fixture()
  try {
    await writeRawSummary(subject.root, summary('run-valid-active'))
    const corruptDir = path.join(subject.store.rootDir, 'run-corrupt')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(path.join(corruptDir, 'summary.json'), '{broken json', 'utf8')

    assert.equal(await subject.store.markInterrupted(), 1)
    assert.equal((await subject.store.summary('run-valid-active'))?.status, 'interrupted')
    await assert.rejects(subject.store.summary('run-corrupt'), /invalid durable summary/u)
    assert.equal(await readFile(path.join(corruptDir, 'summary.json'), 'utf8'), '{broken json')
  } finally {
    await subject.close()
  }
})

test('manual log deletion preserves summary metadata', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-delete'))
    await subject.store.append('run-delete', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'sensitive detail' },
    })
    await subject.store.finish({ ...summary('run-delete', 'done'), finishedAt: 200 })

    assert.equal(await subject.store.deleteLog('run-delete'), true)
    assert.deepEqual((await subject.store.page('run-delete'))?.entries, [])
    const raw = JSON.parse(await readFile(
      path.join(subject.root, '.gg/runtime/runs/run-delete/summary.json'),
      'utf8',
    )) as { logAvailable?: boolean }
    assert.equal(raw.logAvailable, false)
  } finally {
    await subject.close()
  }
})

test('unsafe run ids cannot escape the runtime root', async () => {
  const subject = await fixture()
  try {
    await assert.rejects(
      subject.store.start(summary('../escape')),
      /unsupported characters/u,
    )
  } finally {
    await subject.close()
  }
})

test('a symlinked run directory cannot redirect durable logs outside the project', async () => {
  const subject = await fixture()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-run-log-outside-'))
  try {
    await mkdir(subject.store.rootDir, { recursive: true })
    await symlink(outside, path.join(subject.store.rootDir, 'run-escape'), 'dir')
    await assert.rejects(
      subject.store.start(summary('run-escape')),
      /unsafe run log directory/u,
    )
    await assert.rejects(readFile(path.join(outside, 'summary.json'), 'utf8'), { code: 'ENOENT' })
  } finally {
    await subject.close()
    await rm(outside, { recursive: true, force: true })
  }
})

test('symlinked run-log files are never followed for reads or appends', async () => {
  const subject = await fixture()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-run-log-leaf-'))
  try {
    const outsideEvents = path.join(outside, 'events.txt')
    const outsideSummary = path.join(outside, 'summary.json')
    await Promise.all([
      appendFile(outsideEvents, 'outside events\n', 'utf8'),
      appendFile(outsideSummary, '{"outside":true}\n', 'utf8'),
    ])

    await subject.store.start(summary('run-leaf-events'))
    await symlink(
      outsideEvents,
      path.join(subject.store.rootDir, 'run-leaf-events', 'events.jsonl'),
    )
    await assert.rejects(subject.store.append('run-leaf-events', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'must stay inside' },
    }))
    assert.equal(await readFile(outsideEvents, 'utf8'), 'outside events\n')

    await subject.store.start(summary('run-leaf-summary'))
    const summaryPath = path.join(subject.store.rootDir, 'run-leaf-summary', 'summary.json')
    await rm(summaryPath)
    await symlink(outsideSummary, summaryPath)
    await assert.rejects(subject.store.summary('run-leaf-summary'))
    assert.equal(await readFile(outsideSummary, 'utf8'), '{"outside":true}\n')
  } finally {
    await subject.close()
    await rm(outside, { recursive: true, force: true })
  }
})

test('a crash-truncated final JSONL record preserves all complete events', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-truncated'))
    await subject.store.append('run-truncated', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'durable prefix' },
    })
    await appendFile(
      path.join(subject.store.rootDir, 'run-truncated', 'events.jsonl'),
      '{"id":2,"event":"agent-event"',
      'utf8',
    )

    const page = await subject.store.page('run-truncated')
    assert.deepEqual(page?.entries.map((entry) => entry.id), [1])
    assert.equal(page?.truncated, true)
  } finally {
    await subject.close()
  }
})

test('an index entry that survived beyond its event falls back to a verified scan', async () => {
  const subject = await fixture()
  try {
    await subject.store.start(summary('run-index-ahead'))
    await subject.store.append('run-index-ahead', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'first' },
    })
    await subject.store.append('run-index-ahead', {
      id: 2,
      event: 'agent-event',
      data: { type: 'thinking', text: 'second' },
    })
    const index = Buffer.alloc(16)
    index.writeBigUInt64LE(0n, 0)
    index.writeBigUInt64LE(9_999_999n, 8)
    await writeFile(
      path.join(subject.store.rootDir, 'run-index-ahead', 'events.idx'),
      index,
    )

    const page = await subject.store.page('run-index-ahead', { afterEventId: 1 })
    assert.deepEqual(page?.entries.map((entry) => entry.id), [2])
  } finally {
    await subject.close()
  }
})
