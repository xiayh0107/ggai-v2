import assert from 'node:assert/strict'
import test from 'node:test'
import { buildArtifactManifest } from '../artifactManifest.js'
import {
  ArtifactCatalogCursorError,
  listArtifactCatalog,
  type ArtifactCatalogRunSource,
  type VerifiedArtifactCatalogEntry,
} from '../artifactCatalog.js'
import type { RunClosePayload, RunSummary } from '../protocol.js'

const digest = 'a'.repeat(64)

function summary(
  runId: string,
  startedAt: number,
  overrides: Partial<RunSummary> = {},
): RunSummary {
  return {
    runId,
    taskId: `task-${runId}`,
    nodeId: `task-${runId}`,
    agentId: 'agent-1',
    canvasBranch: 'main',
    status: 'done',
    startedAt,
    finishedAt: startedAt + 10,
    sessionId: null,
    ...overrides,
  }
}

function close(runId: string, paths: string[], complete = true): RunClosePayload {
  return {
    runId,
    status: 'done',
    sessionId: null,
    artifacts: paths,
    artifactsComplete: complete,
    artifactManifest: buildArtifactManifest({
      runId,
      complete,
      files: paths.map((relativePath, index) => ({
        ownerRunId: runId,
        relativePath,
        kind: 'file' as const,
        temporary: false,
        mediaType: relativePath.endsWith('.png') ? 'image/png' : 'text/plain',
        size: index + 1,
        contentDigest: digest,
      })),
    }),
  }
}

function source(
  summaries: RunSummary[],
  closes: Map<string, RunClosePayload | Error>,
  verify?: (
    entry: VerifiedArtifactCatalogEntry,
  ) => VerifiedArtifactCatalogEntry | null | Promise<VerifiedArtifactCatalogEntry | null>,
): ArtifactCatalogRunSource {
  return {
    async listRunHistory(_projectDir, filter) {
      return summaries
        .filter((entry) => entry.taskId !== undefined)
        .filter((entry) => !filter.canvasBranch || entry.canvasBranch === filter.canvasBranch)
        .filter((entry) => !filter.before
          || (filter.includeBefore
            ? compareHistory(entry, filter.before) >= 0
            : compareHistory(entry, filter.before) > 0))
        .sort(compareHistory)
        .slice(0, filter.limit)
    },
    async readTerminalClose(runId) {
      const value = closes.get(runId)
      if (value instanceof Error) throw value
      return value ?? null
    },
    async lookupRunArtifact(runId, artifactId) {
      const value = closes.get(runId)
      if (!value || value instanceof Error) return null
      const artifact = value.artifactManifest?.entries.find((entry) =>
        entry.artifactId === artifactId)
      const run = summaries.find((entry) => entry.runId === runId)
      if (!artifact || !run) return null
      const verified = {
        runId,
        artifactId,
        canvasBranch: run.canvasBranch ?? 'main',
        relativePath: artifact.relativePath,
        mediaType: artifact.mediaType,
        size: artifact.size,
        contentDigest: artifact.contentDigest,
      }
      return verify ? await verify(verified) : verified
    },
  }
}

function compareHistory(
  left: Pick<RunSummary, 'startedAt' | 'runId'>,
  right: Pick<RunSummary, 'startedAt' | 'runId'>,
): number {
  return right.startedAt - left.startedAt || left.runId.localeCompare(right.runId)
}

test('artifact catalog is independent of Canvas node references and uses verified manifests', async () => {
  const run = summary('run-1', 100)
  const page = await listArtifactCatalog(source(
    [run],
    new Map([['run-1', close('run-1', ['preview.png', 'notes/readme.txt'])]]),
  ), '/project')

  assert.equal(page.schemaVersion, 2)
  assert.equal(page.partial, false)
  assert.equal(page.truncated, false)
  assert.equal(page.nextCursor, null)
  assert.deepEqual(page.artifacts.map((entry) => ({
    runId: entry.runId,
    taskId: entry.taskId,
    relativePath: entry.relativePath,
    createdAt: entry.createdAt,
  })), [
    { runId: 'run-1', taskId: 'task-run-1', relativePath: 'notes/readme.txt', createdAt: 110 },
    { runId: 'run-1', taskId: 'task-run-1', relativePath: 'preview.png', createdAt: 110 },
  ])
})

test('artifact catalog includes verified entries from a partial terminal manifest', async () => {
  const page = await listArtifactCatalog(source(
    [summary('run-bad', 300), summary('run-partial', 200), summary('run-good', 100)],
    new Map<string, RunClosePayload | Error>([
      ['run-bad', new Error('damaged terminal log')],
      ['run-partial', close('run-partial', ['draft.txt'], false)],
      ['run-good', close('run-good', ['final.txt'])],
    ]),
  ), '/project')

  assert.equal(page.partial, true)
  assert.deepEqual(
    page.artifacts.map((entry) => entry.relativePath),
    ['draft.txt', 'final.txt'],
  )
})

test('artifact catalog excludes manifest entries that fail verified file lookup', async () => {
  const closes = new Map([
    ['run-verify', close('run-verify', ['missing.txt', 'valid.txt'])],
  ])
  const page = await listArtifactCatalog(source(
    [summary('run-verify', 100)],
    closes,
    (entry) => entry.relativePath === 'missing.txt' ? null : entry,
  ), '/project')

  assert.equal(page.partial, true)
  assert.deepEqual(page.artifacts.map((entry) => entry.relativePath), ['valid.txt'])
})

test('artifact catalog resumes with an opaque cursor without duplicating resources', async () => {
  const summaries = [summary('run-page', 100)]
  const closes = new Map([[
    'run-page',
    close('run-page', ['a.txt', 'b.txt', 'c.txt']),
  ]])
  const resources: string[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  do {
    const page = await listArtifactCatalog(
      source(summaries, closes),
      '/project',
      { limit: 1, ...(cursor ? { cursor } : {}) },
    )
    resources.push(...page.artifacts.map((entry) => entry.relativePath))
    cursor = page.nextCursor ?? undefined
    if (cursor) {
      assert.match(cursor, /^[A-Za-z0-9_-]+$/u)
      assert.equal(cursor.includes('run-page'), false)
      assert.equal(cursors.has(cursor), false)
      cursors.add(cursor)
    }
  } while (cursor)

  assert.deepEqual(resources, ['a.txt', 'b.txt', 'c.txt'])
})

test('artifact catalog cursor crosses a stable 2000-Run history window', async () => {
  const active = Array.from({ length: 2_000 }, (_, index) => summary(
    `run-window-${String(index).padStart(4, '0')}`,
    3_000 - index,
    { status: 'running', finishedAt: undefined },
  ))
  const older = summary('run-older', 1)
  const summaries = [...active, older]
  const closes = new Map([['run-older', close('run-older', ['archive.txt'])]])

  const first = await listArtifactCatalog(source(summaries, closes), '/project')
  assert.deepEqual(first.artifacts, [])
  assert.equal(first.partial, false)
  assert.ok(first.nextCursor)

  const second = await listArtifactCatalog(source(summaries, closes), '/project', {
    cursor: first.nextCursor,
  })
  assert.deepEqual(second.artifacts.map((entry) => entry.relativePath), ['archive.txt'])
  assert.equal(second.nextCursor, null)
})

test('artifact catalog rejects malformed and cross-scope cursors', async () => {
  const summaries = [summary('run-cursor', 100)]
  const closes = new Map([['run-cursor', close('run-cursor', ['a.txt', 'b.txt'])]])
  const first = await listArtifactCatalog(source(summaries, closes), '/project', { limit: 1 })
  assert.ok(first.nextCursor)

  await assert.rejects(
    listArtifactCatalog(source(summaries, closes), '/other-project', {
      limit: 1,
      cursor: first.nextCursor,
    }),
    ArtifactCatalogCursorError,
  )
  await assert.rejects(
    listArtifactCatalog(source(summaries, closes), '/project', { cursor: 'not-json' }),
    ArtifactCatalogCursorError,
  )
})

test('artifact catalog applies branch bounds without exposing path-only output', async () => {
  const page = await listArtifactCatalog(source(
    [
      summary('run-main', 200),
      summary('run-other', 100, { canvasBranch: 'experiment' }),
    ],
    new Map([
      ['run-main', close('run-main', ['a.txt'])],
      ['run-other', close('run-other', ['other.txt'])],
    ]),
  ), '/project', { canvasBranch: 'main' })

  assert.equal(page.truncated, false)
  assert.equal(page.artifacts.length, 1)
  assert.equal(page.artifacts[0]?.canvasBranch, 'main')
})
