import { describe, expect, it, vi } from 'vitest'
import { loadArtifactProjection } from './artifactProjection'

const artifactId = `artifact_${'a'.repeat(64)}`

describe('loadArtifactProjection', () => {
  it('binds the default browser fetch to its global receiver', async () => {
    const receiverFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify({
        schemaVersion: 2,
        runId: 'run-1',
        artifactId,
        mediaType: 'image/png',
        size: 42,
        contentDigest: 'b'.repeat(64),
      })))
    })
    vi.stubGlobal('fetch', receiverFetch)
    try {
      await expect(loadArtifactProjection({
        runId: 'run-1',
        artifactId,
        projectDir: '/project',
        title: 'Preview',
      })).resolves.toMatchObject({ artifactId, mediaType: 'image/png' })
      expect(receiverFetch).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns a runtime-only trusted projection from exact daemon metadata', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      runId: 'run-1',
      artifactId,
      mediaType: 'image/png',
      size: 42,
      contentDigest: 'b'.repeat(64),
    }), { headers: { 'Content-Type': 'application/json' } }))

    const projection = await loadArtifactProjection({
      runId: 'run-1',
      artifactId,
      projectDir: '/project',
      title: 'Preview',
      fetch,
    })
    expect(projection).toMatchObject({
      runId: 'run-1',
      artifactId,
      mediaType: 'image/png',
      size: 42,
      title: 'Preview',
    })
    expect(projection.url).toContain('/runs/run-1/artifacts/')
    expect(projection.url).toContain('projectDir=%2Fproject')
  })

  it('rejects identity mismatches, extra authority, and malformed digests', async () => {
    for (const value of [{
      schemaVersion: 2,
      runId: 'foreign-run',
      artifactId,
      mediaType: 'image/png',
      size: 42,
      contentDigest: 'b'.repeat(64),
    }, {
      schemaVersion: 2,
      runId: 'run-1',
      artifactId,
      mediaType: 'image/png',
      size: 42,
      contentDigest: 'not-a-digest',
      payload: { forged: true },
    }]) {
      await expect(loadArtifactProjection({
        runId: 'run-1',
        artifactId,
        projectDir: '/project',
        title: 'Preview',
        fetch: vi.fn(async () => new Response(JSON.stringify(value))),
      })).rejects.toThrow(/metadata response is invalid/u)
    }
  })
})
