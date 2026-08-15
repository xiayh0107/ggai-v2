import { describe, expect, it, vi } from 'vitest'
import { emptyCanvasDocument } from './model'
import {
  CanvasVersioningClient,
  CanvasVersioningProtocolError,
} from './versioningClient'

const projectDir = '/workspace/project'
const commitA = 'a'.repeat(40)
const commitB = 'b'.repeat(40)
const commitC = 'c'.repeat(40)
const commitSha256 = 'd'.repeat(64)
const ready = { state: 'ready', initialized: true, gitAvailable: true } as const

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function envelope(branch = 'main', revision = 3) {
  return {
    branch,
    revision,
    updatedAt: '2026-08-05T12:00:00.000Z',
    lastMutationId: null,
    lastCheckpoint: commitA,
    document: emptyCanvasDocument(),
  }
}

function branch(name = 'main', commit = commitA) {
  return { name, commit, worktree: null }
}

function success(value: unknown) {
  return { ok: true, partial: false, value, versioning: ready }
}

function client(fetch: typeof globalThis.fetch) {
  return new CanvasVersioningClient({ baseUrl: 'http://127.0.0.1:7380', fetch })
}

describe('Canvas versioning client', () => {
  it('binds the default browser fetch to its global receiver', async () => {
    const receiverFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(response({ versioning: ready }))
    })
    vi.stubGlobal('fetch', receiverFetch)
    try {
      const versioning = new CanvasVersioningClient({ baseUrl: 'http://127.0.0.1:7380' })
      await expect(versioning.status({ projectDir })).resolves.toEqual({ versioning: ready })
      expect(receiverFetch).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('decodes the current status envelope and rejects legacy source state', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/canvas/status')
      expect(url.searchParams.get('projectDir')).toBe(projectDir)
      expect(init?.method).toBe('GET')
      return response({ versioning: ready })
    })

    await expect(client(fetch).status({ projectDir })).resolves.toEqual({ versioning: ready })

    const legacy = client(async () => response({ versioning: ready, source: { state: 'ready' } }))
    await expect(legacy.status({ projectDir })).rejects.toBeInstanceOf(
      CanvasVersioningProtocolError,
    )
  })

  it('uses strict operation envelopes for branches and includes projectDir in POST bodies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (init?.method === 'GET') {
        expect(url.pathname).toBe('/canvas/branches')
        expect(url.searchParams.get('projectDir')).toBe(projectDir)
        return response(success([branch()]))
      }
      expect(url.pathname).toBe('/canvas/branches')
      expect(url.search).toBe('')
      expect(JSON.parse(String(init?.body))).toEqual({
        projectDir,
        name: 'feature/chart',
        fromBranch: 'main',
      })
      return response(success({
        branch: branch('feature/chart', commitB),
        canvas: envelope('feature/chart', 0),
      }))
    })
    const versioning = client(fetch)

    await expect(versioning.listBranches({ projectDir })).resolves.toMatchObject({
      ok: true,
      value: [{ name: 'main', commit: commitA }],
    })
    await expect(versioning.createBranch(
      { projectDir },
      { name: 'feature/chart', fromBranch: 'main' },
    )).resolves.toMatchObject({
      ok: true,
      value: { branch: { name: 'feature/chart' }, canvas: { lastCheckpoint: commitA } },
    })
  })

  it('decodes manual checkpoints, restores, and explicit partial failures without losing value', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ path, body })
      if (path === '/canvas/checkpoints') {
        return response(success({
          canvas: envelope(),
          checkpoint: { branch: 'main', commit: commitB, changed: true, status: ready },
        }))
      }
      return response({
        ok: false,
        partial: true,
        error: { code: 'materialize_failed', message: 'Runtime materialization failed' },
        value: {
          branch: branch('restore/chart', commitA),
          canvas: envelope('restore/chart', 0),
        },
        versioning: ready,
      })
    })
    const versioning = client(fetch)

    await expect(versioning.checkpoint(
      { projectDir },
      { branch: 'main', reason: 'Before chart edit' },
    )).resolves.toMatchObject({ ok: true, value: { checkpoint: { changed: true } } })
    await expect(versioning.restoreAsNewBranch(
      { projectDir },
      { sourceBranch: 'main', newBranch: 'restore/chart', checkpoint: commitA },
    )).resolves.toMatchObject({
      ok: false,
      partial: true,
      error: { code: 'materialize_failed' },
      value: { branch: { name: 'restore/chart' } },
    })
    expect(calls).toEqual([
      {
        path: '/canvas/checkpoints',
        body: { projectDir, branch: 'main', reason: 'Before chart edit' },
      },
      {
        path: '/canvas/restores',
        body: { projectDir, sourceBranch: 'main', newBranch: 'restore/chart', checkpoint: commitA },
      },
    ])
  })

  it('paginates history with full commits', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/canvas/history')
      expect(url.searchParams.get('projectDir')).toBe(projectDir)
      expect(url.searchParams.get('branch')).toBe('main')
      expect(url.searchParams.get('cursor')).toBe(commitB)
      expect(url.searchParams.get('limit')).toBe('25')
      return response(success({
        entries: [{
          commit: commitA,
          parents: [commitB],
          committedAt: '2026-08-05T10:00:00.000Z',
          subject: 'manual checkpoint',
        }],
        nextCursor: commitC,
      }))
    })

    await expect(client(fetch).history(
      { projectDir },
      { branch: 'main', cursor: commitB, limit: 25 },
    )).resolves.toMatchObject({
      ok: true,
      value: { entries: [{ commit: commitA }], nextCursor: commitC },
    })
  })

  it('accepts full SHA-256 commit identifiers from Canvas repositories', async () => {
    const versioning = client(async () => response(success({
      entries: [{
        commit: commitSha256,
        parents: [],
        committedAt: '2026-08-05T10:00:00.000Z',
        subject: 'sha256 checkpoint',
      }],
      nextCursor: commitSha256,
    })))

    await expect(versioning.history(
      { projectDir },
      { branch: 'main', cursor: commitSha256 },
    )).resolves.toMatchObject({
      ok: true,
      value: { entries: [{ commit: commitSha256 }], nextCursor: commitSha256 },
    })
  })

  it('round-trips a flat merge expectation from preview to confirmed execution', async () => {
    const expectation = {
      sourceCommit: commitA,
      targetCommit: commitB,
      sourceRevision: 7,
      targetRevision: 11,
    }
    const canvas = {
      sourceBranch: 'feature/chart',
      targetBranch: 'main',
      sourceCommit: commitA,
      targetCommit: commitB,
      baseCommit: commitC,
      state: 'ready',
      changed: true,
      paths: ['nodes/node.json'],
      conflicts: [],
    } as const
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/preview')) {
        return response(success({ state: 'ready', canvas, expectation }))
      }
      expect(JSON.parse(String(init?.body))).toEqual({
        projectDir,
        sourceBranch: 'feature/chart',
        targetBranch: 'main',
        confirmed: true,
        expected: expectation,
      })
      return response(success({
        state: 'merged',
        canvas: { ...canvas, merged: true, commit: commitC },
        canvasEnvelope: envelope('main', 12),
      }))
    })
    const versioning = client(fetch)
    const preview = await versioning.previewMerge(
      { projectDir },
      { sourceBranch: 'feature/chart', targetBranch: 'main' },
    )
    expect(preview).toMatchObject({ ok: true, value: { expectation } })
    if (!preview.ok) throw new Error('expected merge preview')

    await expect(versioning.executeMerge(
      { projectDir },
      {
        sourceBranch: 'feature/chart',
        targetBranch: 'main',
        confirmed: true,
        expected: preview.value.expectation,
      },
    )).resolves.toMatchObject({ ok: true, value: { state: 'merged' } })
  })

  it('rejects nested or extra merge expectations instead of accepting archived shapes', async () => {
    const malformedExpectation = {
      canvas: {
        sourceCommit: commitA,
        targetCommit: commitB,
        sourceRevision: 1,
        targetRevision: 2,
      },
    }
    const versioning = client(async () => response(success({
      state: 'ready',
      canvas: {
        sourceBranch: 'feature/chart',
        targetBranch: 'main',
        sourceCommit: commitA,
        targetCommit: commitB,
        baseCommit: null,
        state: 'ready',
        changed: true,
        paths: [],
        conflicts: [],
      },
      expectation: malformedExpectation,
    })))

    await expect(versioning.previewMerge(
      { projectDir },
      { sourceBranch: 'feature/chart', targetBranch: 'main' },
    )).rejects.toBeInstanceOf(CanvasVersioningProtocolError)
  })

  it('rejects success partials, envelope drift, malformed JSON, and explicit HTTP failures', async () => {
    const partial = client(async () => response({
      ok: true,
      partial: true,
      value: [],
      versioning: ready,
    }))
    await expect(partial.listBranches({ projectDir })).rejects.toBeInstanceOf(
      CanvasVersioningProtocolError,
    )

    const drift = client(async () => response(success({
      branch: branch(),
      canvas: { ...envelope(), source: { state: 'clean' } },
    })))
    await expect(drift.createBranch({ projectDir }, { name: 'chart' })).rejects.toBeInstanceOf(
      CanvasVersioningProtocolError,
    )

    const malformed = client(async () => new Response('{', { status: 200 }))
    await expect(malformed.status({ projectDir })).rejects.toBeInstanceOf(
      CanvasVersioningProtocolError,
    )

    const failed = client(async () => response({
      error: { code: 'daemon_busy', message: 'Daemon is busy' },
    }, 409))
    await expect(failed.status({ projectDir })).rejects.toMatchObject({
      status: 409,
      code: 'daemon_busy',
      message: 'Daemon is busy',
    })
  })
})
