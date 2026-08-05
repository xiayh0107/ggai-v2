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
