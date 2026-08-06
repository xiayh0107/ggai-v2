import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceProjectClient,
  WorkspaceProjectProtocolError,
  WorkspaceProjectRequestError,
  type WorkspaceProject,
} from './projectClient'

describe('WorkspaceProjectClient', () => {
  it('decodes the exact list envelope and forwards AbortSignal', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return json({ schemaVersion: 1, projects: [project()] })
    })
    const client = new WorkspaceProjectClient({ baseUrl: 'http://daemon.test', fetch })

    await expect(client.list(controller.signal)).resolves.toEqual([project()])
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe('/projects')
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
  })

  it('trims a create title and decodes the returned project', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ title: '新项目' })
      return json({ schemaVersion: 1, project: project({ title: '新项目' }) })
    })
    const client = new WorkspaceProjectClient({ baseUrl: 'http://daemon.test', fetch })

    await expect(client.create('  新项目  ')).resolves.toMatchObject({ title: '新项目' })
  })

  it('uses the validated opaque project id for an open request', async () => {
    const id = 'project_22222222222222222222222222222222'
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(`/projects/${id}/open`)
      expect(init?.method).toBe('POST')
      return json({ schemaVersion: 1, project: project({ id }) })
    })
    const client = new WorkspaceProjectClient({ baseUrl: 'http://daemon.test', fetch })

    await expect(client.open(id)).resolves.toMatchObject({ id })
  })

  it('fails closed when an open response belongs to another project', async () => {
    const requestedId = 'project_22222222222222222222222222222222'
    const returnedId = 'project_33333333333333333333333333333333'
    const client = new WorkspaceProjectClient({
      baseUrl: 'http://daemon.test',
      fetch: async () => json({
        schemaVersion: 1,
        project: project({ id: returnedId }),
      }),
    })

    await expect(client.open(requestedId)).rejects.toBeInstanceOf(WorkspaceProjectProtocolError)
  })

  it('rejects forged ids and id/path mismatches before they can scope a Canvas', async () => {
    const fetch = vi.fn()
    const client = new WorkspaceProjectClient({ baseUrl: 'http://daemon.test', fetch })

    await expect(client.open('../other-project')).rejects.toBeInstanceOf(Error)
    expect(fetch).not.toHaveBeenCalled()

    const mismatched = new WorkspaceProjectClient({
      baseUrl: 'http://daemon.test',
      fetch: async () => json({
        schemaVersion: 1,
        projects: [project({
          id: 'project_33333333333333333333333333333333',
          projectDir: '.gg/workspace/projects/project_44444444444444444444444444444444',
        })],
      }),
    })
    await expect(mismatched.list()).rejects.toBeInstanceOf(Error)
  })

  it('preserves a structured daemon error', async () => {
    const fetch = vi.fn(async () => json({
      error: { code: 'project_unavailable', message: '项目目录不可用' },
    }, 409))
    const client = new WorkspaceProjectClient({ baseUrl: 'http://daemon.test', fetch })

    await expect(client.open('project_ffffffffffffffffffffffffffffffff')).rejects.toMatchObject({
      status: 409,
      code: 'project_unavailable',
      message: '项目目录不可用',
    } satisfies Partial<WorkspaceProjectRequestError>)
  })
})

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  const id = overrides.id ?? 'project_11111111111111111111111111111111'
  return {
    id,
    title: '项目一',
    projectDir: id === 'project_root' ? '.' : `.gg/workspace/projects/${id}`,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-05T10:00:00.000Z',
    lastOpenedAt: null,
    state: 'ready',
    summary: { taskCount: 1, nodeCount: 2, collectionCount: 0 },
    ...overrides,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
