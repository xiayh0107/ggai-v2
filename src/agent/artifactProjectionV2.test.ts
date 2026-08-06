import { describe, expect, it, vi } from 'vitest'
import { loadArtifactProjectionV2 } from './artifactProjectionV2'

const artifactId = `artifact_${'a'.repeat(64)}`

describe('loadArtifactProjectionV2', () => {
  it('returns a runtime-only trusted projection from exact daemon metadata', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      runId: 'run-1',
      artifactId,
      mediaType: 'image/png',
      size: 42,
      contentDigest: 'b'.repeat(64),
    }), { headers: { 'Content-Type': 'application/json' } }))

    const projection = await loadArtifactProjectionV2({
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
      await expect(loadArtifactProjectionV2({
        runId: 'run-1',
        artifactId,
        projectDir: '/project',
        title: 'Preview',
        fetch: vi.fn(async () => new Response(JSON.stringify(value))),
      })).rejects.toThrow(/metadata response is invalid/u)
    }
  })
})
