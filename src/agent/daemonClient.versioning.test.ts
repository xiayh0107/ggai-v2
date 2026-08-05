import { describe, expect, it, vi } from 'vitest'
import { DaemonClient, DaemonProtocolError } from './daemonClient'

const versioning = { state: 'ready', initialized: true, gitAvailable: true }
const source = { status: 'unavailable', reason: 'not a Git repository', branches: [] }
const statuses = { versioning, source }
const canvas = {
  branch: 'main',
  revision: 1,
  updatedAt: new Date(0).toISOString(),
  lastMutationId: null,
  lastCheckpoint: 'abc123',
  document: {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    everCreated: false,
    generationByNodeId: {},
    latestRunByNodeId: {},
    runRefsByNodeId: {},
  },
}
const branch = { name: 'main', commit: 'abc123', worktree: null }
const binding = {
  logicalBranch: 'main',
  gitBranch: 'ggai/main',
  worktreeId: 'worktree-1',
  worktreePath: '/workspace/.gg/source-worktrees/worktree-1',
  projectDir: '/workspace/.gg/source-worktrees/worktree-1/app',
  head: 'abc123',
  dirty: false,
}
const mergePreview = {
  sourceBranch: 'experiment',
  targetBranch: 'main',
  sourceCommit: 'def456',
  targetCommit: 'abc123',
  baseCommit: 'base123',
  state: 'ready',
  changed: true,
  paths: ['nodes/node-1.json'],
  conflicts: [],
}
const mergeExpectation = {
  canvas: {
    sourceCommit: 'def456',
    targetCommit: 'abc123',
    sourceRevision: 2,
    targetRevision: 3,
  },
  source: null,
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function success<T>(value: T) {
  return { ok: true, partial: false, sourceDegraded: false, value, ...statuses }
}

describe('DaemonClient canvas versioning reads', () => {
  it('loads status, branches, history, source binding and preferences', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/canvas/status') return json(statuses)
      if (url.pathname === '/canvas/branches') return json(success([branch]))
      if (url.pathname === '/canvas/history') {
        return json(success({
          entries: [{
            commit: 'abc123',
            parents: [],
            committedAt: new Date(0).toISOString(),
            subject: 'ggai(canvas): autosave',
          }],
          nextCursor: null,
        }))
      }
      if (url.pathname === '/canvas/source') return json(source)
      if (url.pathname === '/canvas/preferences') {
        return json({ schemaVersion: 1, automationMode: 'confirm' })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    const [statusResult, branchResult, historyResult, sourceResult, preferences] = await Promise.all([
      client.getCanvasStatus({ projectDir: 'app' }),
      client.listCanvasBranches({ projectDir: 'app' }),
      client.getCanvasHistory({ projectDir: 'app', branch: 'main', limit: 20 }),
      client.getCanvasSourceStatus({ projectDir: 'app' }),
      client.getCanvasPreferences({ projectDir: 'app' }),
    ])

    expect(statusResult.versioning.state).toBe('ready')
    expect(branchResult.value?.[0]?.name).toBe('main')
    expect(historyResult.value?.entries[0]?.commit).toBe('abc123')
    expect(sourceResult.status).toBe('unavailable')
    expect(preferences.automationMode).toBe('confirm')
    const historyUrl = new URL(String(fetchMock.mock.calls[2]?.[0]))
    expect(historyUrl.searchParams.get('branch')).toBe('main')
    expect(historyUrl.searchParams.get('limit')).toBe('20')
  })

  it('rejects malformed versioning payloads as protocol errors', async () => {
    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:7380',
      fetch: vi.fn(async () => json({ versioning: { state: 'mystery' }, source })),
    })

    await expect(client.getCanvasStatus()).rejects.toBeInstanceOf(DaemonProtocolError)
  })
})

describe('DaemonClient canvas versioning writes', () => {
  it('uses the dedicated endpoints without mutating the source checkout directly', async () => {
    const seen: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      seen.push({ path: url.pathname, method: init?.method ?? 'GET', body })
      if (url.pathname === '/canvas/branches' && init?.method === 'POST') {
        return json(success({ branch: { ...branch, name: 'experiment' }, canvas, sourceBranch: null }))
      }
      if (url.pathname === '/canvas/branches' && init?.method === 'DELETE') {
        return json(success({
          branch: 'experiment',
          canvasDeleted: true,
          sourceDeleted: false,
          runtimeDeleted: true,
        }))
      }
      if (url.pathname === '/canvas/checkpoints') {
        return json(success({
          canvas,
          checkpoint: { branch: 'main', commit: 'abc123', changed: true, status: versioning },
        }))
      }
      if (url.pathname === '/canvas/restores') {
        return json(success({ branch: { ...branch, name: 'restored' }, canvas, sourceBranch: null }))
      }
      if (url.pathname === '/canvas/merges/preview') {
        return json(success({
          state: 'ready',
          canvas: mergePreview,
          source: null,
          expectation: mergeExpectation,
        }))
      }
      if (url.pathname === '/canvas/merges') {
        return json(success({
          state: 'merged',
          canvas: { ...mergePreview, merged: true, commit: 'merged123' },
          source: null,
          canvasEnvelope: canvas,
        }))
      }
      if (url.pathname === '/canvas/source/bind') return json(success(binding))
      if (url.pathname === '/canvas/source/checkpoints') {
        return json(success({
          changed: true,
          commit: 'def456',
          requiresConfirmation: false,
          warnings: [],
          paths: ['src/index.ts'],
        }))
      }
      if (url.pathname === '/canvas/preferences') {
        return json({ schemaVersion: 1, automationMode: body.automationMode })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    await client.createCanvasBranch({ projectDir: '.', name: 'experiment', fromBranch: 'main' })
    await client.deleteCanvasBranch({ projectDir: '.', branch: 'experiment' })
    await client.createCanvasCheckpoint({ projectDir: '.', branch: 'main', reason: 'manual' })
    await client.restoreCanvasCheckpoint({
      projectDir: '.',
      sourceBranch: 'main',
      checkpoint: 'abc123',
      newBranch: 'restored',
    })
    const preview = await client.previewCanvasMerge({
      projectDir: '.',
      sourceBranch: 'experiment',
      targetBranch: 'main',
    })
    const merged = await client.executeCanvasMerge({
      projectDir: '.',
      sourceBranch: 'experiment',
      targetBranch: 'main',
      confirmed: true,
      expected: preview.value!.expectation,
    })
    await client.bindCanvasSource({ projectDir: '.', branch: 'main' })
    await client.createCanvasSourceCheckpoint({
      projectDir: '.',
      branch: 'main',
      runId: 'run-1',
      nodeTitle: '分析结果',
    })
    await client.putCanvasPreferences({ projectDir: '.', automationMode: 'auto' })

    expect(seen.map(({ path, method }) => `${method} ${path}`)).toEqual([
      'POST /canvas/branches',
      'DELETE /canvas/branches',
      'POST /canvas/checkpoints',
      'POST /canvas/restores',
      'POST /canvas/merges/preview',
      'POST /canvas/merges',
      'POST /canvas/source/bind',
      'POST /canvas/source/checkpoints',
      'PUT /canvas/preferences',
    ])
    expect(seen[3]?.body).toMatchObject({ checkpoint: 'abc123', newBranch: 'restored' })
    expect(seen[5]?.body).toMatchObject({
      sourceBranch: 'experiment',
      targetBranch: 'main',
      confirmed: true,
      expected: mergeExpectation,
    })
    expect(seen[8]?.body).toMatchObject({ automationMode: 'auto' })
    expect(preview.value?.canvas.paths).toEqual(['nodes/node-1.json'])
    expect(merged.value?.canvas.merged).toBe(true)
  })

  it('decodes conflict paths but refuses execution without literal confirmation', async () => {
    const conflict = {
      path: 'nodes/node-1.json',
      kind: 'content',
      stages: { base: true, ours: true, theirs: true },
    }
    const fetchMock = vi.fn(async () => json(success({
      state: 'conflicts',
      canvas: {
        ...mergePreview,
        state: 'conflicts',
        conflicts: [conflict],
        resolution: { requiresExplicitApproval: true },
      },
      source: null,
      expectation: mergeExpectation,
    })))
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    const result = await client.previewCanvasMerge({
      sourceBranch: 'experiment',
      targetBranch: 'main',
    })
    expect(result.value?.canvas.conflicts[0]).toMatchObject({
      path: 'nodes/node-1.json',
      kind: 'content',
    })
    await expect(client.executeCanvasMerge({
      sourceBranch: 'experiment',
      targetBranch: 'main',
      confirmed: false,
      expected: mergeExpectation,
    } as never)).rejects.toThrow(/explicit confirmation/u)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
