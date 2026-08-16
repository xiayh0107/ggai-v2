import { describe, expect, it, vi } from 'vitest'
import { TaskRunPreflightClient } from './taskRunPreflightClient'

describe('TaskRunPreflightClient', () => {
  it('posts the exact advisory request and decodes a blocked result', async () => {
    let capturedRequest: {
      input: RequestInfo | URL
      init?: RequestInit
    } | undefined
    const fetch: typeof globalThis.fetch = async (input, init) => {
      capturedRequest = { input, init }
      return new Response(JSON.stringify({
        status: 'blocked',
        issues: [{
          code: 'generation_service_unauthenticated',
          message: '生成服务尚未登录，请完成登录后重试。',
          retryable: true,
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const client = new TaskRunPreflightClient({
      baseUrl: 'http://127.0.0.1:7380',
      fetch,
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

    expect(capturedRequest).toBeDefined()
    expect(String(capturedRequest?.input)).toBe(
      'http://127.0.0.1:7380/task-runs/preflight?projectDir=%2Fworkspace%2Fdemo',
    )
    expect(capturedRequest?.init?.method).toBe('POST')
    expect(JSON.parse(String(capturedRequest?.init?.body))).toEqual({
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
