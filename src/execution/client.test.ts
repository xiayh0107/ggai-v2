import { describe, expect, it, vi } from 'vitest'
import { NodeExecutionClient } from './client'

const execution = {
  executionId: 'execution_0123456789abcdef0123456789abcdef',
  projectId: 'project-test',
  canvasBranch: 'main',
  nodeId: 'node-smart',
  nodeTypeRef: { id: 'smart', revision: 1, digest: 'a'.repeat(64) },
  executorId: 'test',
  artifactRunId: 'execution-artifacts',
  inputsDigest: 'b'.repeat(64),
  environmentDigest: 'c'.repeat(64),
  cacheKey: 'd'.repeat(64),
  status: 'succeeded',
  outputs: { result: [{ kind: 'json', value: { ok: true } }] },
  startedAt: '2026-08-17T00:00:00.000Z',
  finishedAt: '2026-08-17T00:00:01.000Z',
} as const

describe('NodeExecutionClient', () => {
  it('sends only force plus URL-scoped node identity', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ force: false })
      return Response.json({ schemaVersion: 1, execution }, { status: 202 })
    })
    const client = new NodeExecutionClient('http://daemon.test', fetch)
    await expect(client.start({
      projectDir: '/workspace/project', branch: 'main', nodeId: 'node-smart',
    })).resolves.toMatchObject({ executionId: execution.executionId })
    const url = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/nodes/node-smart/executions')
    expect(url.searchParams.get('projectDir')).toBe('/workspace/project')
  })

  it('strictly reads execution history', async () => {
    const client = new NodeExecutionClient('http://daemon.test', vi.fn(async () =>
      Response.json({ schemaVersion: 1, executions: [execution] })))
    await expect(client.list({ projectDir: '.', branch: 'main', nodeId: 'node-smart' }))
      .resolves.toEqual([execution])
  })
})
