import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeDefinitionClient } from './client'
import { createBlankNodeStudioDefinition } from './model'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NodeDefinitionClient', () => {
  it('starts a restricted Agent run with the current definition and AbortSignal', async () => {
    const draft = createBlankNodeStudioDefinition(new Date('2026-01-01T00:00:00.000Z'))
    const controller = new AbortController()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/node-studio/runs')
      expect(init?.method).toBe('POST')
      expect(init?.signal).toBe(controller.signal)
      expect(JSON.parse(String(init?.body))).toEqual({
        requirement: '创建一个研究卡片节点',
        definition: draft,
      })
      return json({ schemaVersion: 1, runId: 'studio-run-1', status: 'preparing' })
    })
    vi.stubGlobal('fetch', fetch)
    const client = new NodeDefinitionClient({ baseUrl: 'http://daemon.test/' })

    await expect(client.startAgent('创建一个研究卡片节点', draft, controller.signal))
      .resolves.toBe('studio-run-1')
  })

  it('strictly decodes an Agent candidate and rejects protocol drift', async () => {
    const candidate = createBlankNodeStudioDefinition(new Date('2026-01-01T00:00:00.000Z'))
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        schemaVersion: 1,
        runId: 'studio-run-1',
        status: 'done',
        definition: candidate,
      }))
      .mockResolvedValueOnce(json({
        schemaVersion: 1,
        runId: 'studio-run-1',
        status: 'done',
        definition: candidate,
        installed: true,
      }))
    vi.stubGlobal('fetch', fetch)
    const client = new NodeDefinitionClient({ baseUrl: 'http://daemon.test' })

    await expect(client.getAgentRun('studio-run-1')).resolves.toMatchObject({
      status: 'done',
      definition: candidate,
    })
    await expect(client.getAgentRun('studio-run-1')).rejects.toBeInstanceOf(TypeError)
  })

  it('surfaces the structured daemon error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      error: { code: 'node_studio_run_not_found', message: '节点设计运行不存在' },
    }, 404)))
    const client = new NodeDefinitionClient({ baseUrl: 'http://daemon.test' })

    await expect(client.getAgentRun('studio-missing')).rejects.toThrow('节点设计运行不存在')
  })
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
