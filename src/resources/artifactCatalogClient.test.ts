import { describe, expect, it, vi } from 'vitest'
import {
  ArtifactCatalogProtocolError,
  ProjectArtifactCatalogClient,
  parseArtifactCatalogPage,
} from './artifactCatalogClient'

describe('ProjectArtifactCatalogClient', () => {
  it('requests an explicitly scoped project catalog and builds verified artifact URLs', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/artifact-catalog')
      expect(url.searchParams.get('projectDir')).toBe('/project')
      expect(url.searchParams.get('branch')).toBe('main')
      expect(url.searchParams.get('limit')).toBe('20')
      expect(url.searchParams.get('cursor')).toBeNull()
      expect(init?.signal).toBe(controller.signal)
      return json(page())
    })
    const client = new ProjectArtifactCatalogClient({ baseUrl: 'http://daemon.test', fetch })

    const result = await client.list({
      projectDir: '/project',
      branch: 'main',
      limit: 20,
      signal: controller.signal,
    })
    const artifact = result.artifacts[0]!
    const artifactUrl = new URL(client.artifactUrl('/project', artifact))
    expect(artifactUrl.pathname).toBe(`/runs/${artifact.runId}/artifacts/${artifact.artifactId}`)
    expect(artifactUrl.searchParams.get('projectDir')).toBe('/project')
  })

  it('fails closed on unknown fields, duplicate identities, and unsafe paths', () => {
    expect(() => parseArtifactCatalogPage({ ...page(), deletedNodeId: 'node-1' }))
      .toThrow(ArtifactCatalogProtocolError)
    expect(() => parseArtifactCatalogPage({
      ...page(),
      artifacts: [resource(), resource()],
    })).toThrow(ArtifactCatalogProtocolError)
    expect(() => parseArtifactCatalogPage({
      ...page(),
      artifacts: [resource({ relativePath: '../secret.txt' })],
    })).toThrow(ArtifactCatalogProtocolError)
    expect(() => parseArtifactCatalogPage({
      ...page(),
      truncated: true,
    })).toThrow(ArtifactCatalogProtocolError)
    expect(() => parseArtifactCatalogPage({
      ...page(),
      nextCursor: 'cursor_next',
    })).toThrow(ArtifactCatalogProtocolError)
  })

  it('sends an opaque continuation cursor and rejects a repeated cursor', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('cursor')).toBe('cursor_request')
      return json(page({ truncated: true, nextCursor: 'cursor_next' }))
    })
    const client = new ProjectArtifactCatalogClient({ baseUrl: 'http://daemon.test', fetch })

    const result = await client.list({ projectDir: '/project', cursor: 'cursor_request' })
    expect(result.nextCursor).toBe('cursor_next')

    fetch.mockResolvedValueOnce(json(page({
      truncated: true,
      nextCursor: 'cursor_request',
    })))
    await expect(client.list({
      projectDir: '/project',
      cursor: 'cursor_request',
    })).rejects.toBeInstanceOf(ArtifactCatalogProtocolError)
  })

  it('rejects an oversized request before fetch', async () => {
    const fetch = vi.fn()
    const client = new ProjectArtifactCatalogClient({ baseUrl: 'http://daemon.test', fetch })

    await expect(client.list({ projectDir: '/project', limit: 501 })).rejects.toBeInstanceOf(TypeError)
    await expect(client.list({ projectDir: '/project', cursor: 'not allowed!' }))
      .rejects.toBeInstanceOf(ArtifactCatalogProtocolError)
    expect(fetch).not.toHaveBeenCalled()
  })
})

function page(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    artifacts: [resource()],
    truncated: false,
    partial: false,
    nextCursor: null,
    ...overrides,
  }
}

function resource(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    artifactId: `artifact_${'a'.repeat(64)}`,
    taskId: 'task-1',
    canvasBranch: 'main',
    relativePath: 'images/preview.png',
    mediaType: 'image/png',
    size: 1_024,
    contentDigest: 'b'.repeat(64),
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
