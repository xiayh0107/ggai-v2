import { describe, expect, it, vi } from 'vitest'
import { runCli } from './main'

function io() {
  const stdout = vi.fn<(text: string) => void>()
  const stderr = vi.fn<(text: string) => void>()
  return { stdout, stderr }
}

describe('gg CLI foundation', () => {
  it('checks strict daemon health in human-readable mode', async () => {
    const output = io()
    const fetch = vi.fn(async () => json({
      status: 'ok',
      version: 1,
      capabilities: { canvas: true },
      canvas: { schemaVersion: 2, initializationRequired: false },
      projectRoot: '/workspace',
    }))

    await expect(runCli(['doctor'], { io: output, fetch, environment: {} })).resolves.toBe(0)
    expect(output.stdout.mock.calls.flat().join('')).toContain('Canvas schema 2')
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe('/health')
  })

  it('invokes daemon bootstrap unless explicitly disabled', async () => {
    const output = io()
    const ensureDaemon = vi.fn(async () => undefined)
    const fetch = vi.fn(async () => json({
      status: 'ok',
      capabilities: { canvas: true },
      canvas: { schemaVersion: 2 },
      projectRoot: '/workspace',
    }))
    await runCli(['doctor'], { io: output, fetch, environment: {}, ensureDaemon })
    expect(ensureDaemon).toHaveBeenCalledOnce()

    ensureDaemon.mockClear()
    await runCli(['--no-start-daemon', 'doctor'], {
      io: output,
      fetch,
      environment: {},
      ensureDaemon,
    })
    expect(ensureDaemon).not.toHaveBeenCalled()
  })

  it('emits stable JSON for project list', async () => {
    const output = io()
    const project = fixtureProject()
    const exitCode = await runCli(['--json', 'project', 'list'], {
      io: output,
      fetch: async () => json({ schemaVersion: 1, projects: [project] }),
      environment: {},
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(output.stdout.mock.calls[0]![0])).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'project.list',
      result: { projects: [project] },
    })
  })

  it('creates a project through the catalog client', async () => {
    const output = io()
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ title: 'demo project' })
      return json({ schemaVersion: 1, project: fixtureProject({ title: 'demo project' }) })
    })

    const exitCode = await runCli(['project', 'create', 'demo', 'project'], {
      io: output,
      fetch,
      environment: {},
    })
    expect(exitCode).toBe(0)
    expect(output.stdout.mock.calls.flat().join('')).toContain('Created demo project')
  })

  it('fails closed with stable usage and daemon-unavailable exits', async () => {
    const usage = io()
    await expect(runCli(['unknown'], { io: usage, environment: {} })).resolves.toBe(2)
    expect(usage.stderr.mock.calls[0]![0]).toContain('usage_error')

    const unavailable = io()
    await expect(runCli(['doctor'], {
      io: unavailable,
      fetch: async () => { throw new TypeError('fetch failed') },
      environment: {},
    })).resolves.toBe(3)
    expect(unavailable.stderr.mock.calls[0]![0]).toContain('daemon_unavailable')

    const malformed = io()
    await expect(runCli(['--json', '--daemon-url', 'file:///tmp/daemon', 'doctor'], {
      io: malformed,
      environment: {},
    })).resolves.toBe(2)
    expect(JSON.parse(malformed.stderr.mock.calls[0]![0])).toMatchObject({
      ok: false,
      error: { code: 'usage_error' },
    })
  })
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fixtureProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project_11111111111111111111111111111111',
    title: 'demo',
    projectDir: '.gg/workspace/projects/project_11111111111111111111111111111111',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    lastOpenedAt: null,
    state: 'ready',
    summary: { taskCount: 0, nodeCount: 0, collectionCount: 0 },
    ...overrides,
  }
}
