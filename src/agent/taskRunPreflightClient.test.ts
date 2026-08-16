import { describe, expect, it, vi } from 'vitest'
import { TaskRunPreflightClient } from './taskRunPreflightClient'

describe('TaskRunPreflightClient', () => {
  it('posts the exact advisory request and decodes a blocked result', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'blocked',
      issues: [{
        code: 'generation_service_unauthenticated',
        message: '生成服务尚未登录，请完成登录后重试。',
        retryable: true,
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new TaskRunPreflightClient({
      baseUrl: 'http://127.0.0.1:7380',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.check({
      projectDir: '/workspace/demo',
      taskId: 'task-1',
      agentId: 'codex',
      canvasBranch: 'main',
      baseRevision: 12,
    })).resolves.toEqual({
      status: 'blocked',
      issues: [{
        code: 'generation_service_unauthenticated',
        message: '生成服务尚未登录，请完成登录后重试。',
        retryable: true,
      }],
    })

    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe(
      'http://127.0.0.1:7380/task-runs/preflight?projectDir=%2Fworkspace%2Fdemo',
    )
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      taskId: 'task-1',
      agentId: 'codex',
      canvasBranch: 'main',
      baseRevision: 12,
      attachments: [],
    })
  })

  it('rejects responses that leak undeclared infrastructure fields', async () => {
    const client = new TaskRunPreflightClient({
      baseUrl: 'http://127.0.0.1:7380',
      fetch: vi.fn(async () => new Response(JSON.stringify({
        status: 'ready',
        issues: [],
        provider: '@ggai/codex',
      }), { status: 200 })) as typeof globalThis.fetch,
    })

    await expect(client.check({
      projectDir: '.',
      taskId: 'task-1',
      agentId: 'codex',
      canvasBranch: 'main',
      baseRevision: 1,
    })).rejects.toThrow('malformed')
  })
})
