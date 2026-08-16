import { describe, expect, it, vi } from 'vitest'
import type { CanvasRunIntent } from '@/canvas/runController'
import {
  TaskRunHttpClient,
  TaskRunClientError,
  TaskRunProtocolError,
} from './taskRunHttpClient'
import { DaemonTaskRunClient } from './taskRunClient'

const CAPABILITY_DIGEST = 'e'.repeat(64)

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status === 404 ? 'Not Found' : status === 202 ? 'Accepted' : 'OK',
    headers: { 'Content-Type': 'application/json' },
  })
}

function intent(overrides: Partial<CanvasRunIntent> = {}): CanvasRunIntent {
  return {
    schemaVersion: 2,
    runId: 'run-v2',
    taskId: 'task-v2',
    agentId: 'codex',
    canvasBranch: 'feature/task-v2',
    baseRevision: 17,
    prompt: 'Generate the requested outputs.',
    attachments: [{ kind: 'node', nodeId: 'source-node' }],
    materializationPolicy: 'auto',
    ...overrides,
  }
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-v2',
    taskId: 'task-v2',
    nodeId: 'task-v2',
    agentId: 'codex',
    canvasBranch: 'feature/task-v2',
    baseRevision: 17,
    prompt: 'Generate the requested outputs.',
    status: 'running',
    startedAt: 10,
    sessionId: null,
    ...overrides,
  }
}

function plan(runId = 'run-v2') {
  return {
    schemaVersion: 2,
    planId: `plan_${'a'.repeat(64)}`,
    runId,
    taskId: 'task-v2',
    status: 'complete',
    manifestDigest: 'b'.repeat(64),
    outputs: [{
      key: 'preview',
      pluginId: 'image',
      role: 'primary',
      title: 'Preview',
      artifactRefs: [{
        runId,
        artifactId: `artifact_${'c'.repeat(64)}`,
      }],
      derivedFrom: [],
      materialize: true,
    }],
    taskProposals: [{
      key: 'refine',
      title: 'Refine preview',
      prompt: 'Refine the preview.',
      inputOutputKeys: ['preview'],
      dependsOn: [],
    }],
    warnings: ['One input was summarized.'],
    digest: 'd'.repeat(64),
  }
}

function close(runId = 'run-v2') {
  return {
    runId,
    status: 'done',
    sessionId: null,
    artifacts: [],
    artifactsComplete: true,
    projectionPlan: plan(runId),
    suggestedActions: [{
      id: 'refine',
      label: 'Refine',
      prompt: 'Refine the preview.',
    }],
  }
}

function subject(fetch: typeof globalThis.fetch, historyLimit = 2_000) {
  const client = new TaskRunHttpClient({
    baseUrl: 'http://127.0.0.1:7380',
    fetch,
  })
  return {
    client,
    adapter: new DaemonTaskRunClient({
      client,
      historyLimit,
      pluginCapabilities: () => ({
        schemaVersion: 2,
        plugins: [{
          id: '@tests/notebook',
          artifactClaims: [{ extensions: ['.ipynb'] }],
        }],
      }),
    }),
  }
}

function requireUrl(value: URL | null): URL {
  if (!value) throw new Error('expected request URL')
  return value
}

describe('DaemonTaskRunClient', () => {
  it('POSTs only the exact RunIntent body and keeps projectDir in the query', async () => {
    let requestUrl: URL | null = null
    let requestBody: Record<string, unknown> | null = null
    let capabilityBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/plugin-capabilities') {
        capabilityBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return response({ schemaVersion: 3, digest: CAPABILITY_DIGEST, pluginCount: 7 })
      }
      requestUrl = url
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return response({ runId: 'run-v2' }, 202)
    })
    const { adapter } = subject(fetchMock)
    const unsafe = {
      ...intent(),
      canvasSnapshot: { nodes: [{ id: 'forged' }], edges: [] },
      nodeId: 'legacy-node',
      projectDir: '/forged',
      automationMode: 'auto',
    } as CanvasRunIntent

    await expect(adapter.createTaskRun({
      projectDir: '/real-project',
      intent: unsafe,
    })).resolves.toEqual({ runId: 'run-v2' })

    const capturedUrl = requireUrl(requestUrl)
    expect(capturedUrl.pathname).toBe('/runs')
    expect(capturedUrl.searchParams.get('projectDir')).toBe('/real-project')
    expect(capturedUrl.searchParams.get('pluginCapabilityDigest')).toBe(CAPABILITY_DIGEST)
    expect(capabilityBody).toEqual({
      schemaVersion: 2,
      plugins: [{
        id: '@tests/notebook',
        artifactClaims: [{ extensions: ['.ipynb'] }],
      }],
    })
    expect(Object.keys(requestBody ?? {}).sort()).toEqual([
      'agentId',
      'attachments',
      'baseRevision',
      'canvasBranch',
      'materializationPolicy',
      'prompt',
      'runId',
      'schemaVersion',
      'taskId',
    ])
    expect(requestBody).not.toHaveProperty('canvasSnapshot')
    expect(requestBody).not.toHaveProperty('nodeId')
    expect(requestBody).not.toHaveProperty('projectDir')
  })

  it('lists runs with Task, branch, and bounded history filters', async () => {
    let requested: URL | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requested = new URL(String(input))
      return response({ runs: [summary()] })
    })
    const { adapter } = subject(fetchMock, 37)

    await expect(adapter.listTaskRuns({
      projectDir: '/project',
      taskId: 'task-v2',
      branch: 'feature/task-v2',
    })).resolves.toEqual([{
      runId: 'run-v2',
      taskId: 'task-v2',
      agentId: 'codex',
      canvasBranch: 'feature/task-v2',
      baseRevision: 17,
      prompt: 'Generate the requested outputs.',
      status: 'running',
      startedAt: 10,
    }])
    const capturedUrl = requireUrl(requested)
    expect(capturedUrl.pathname).toBe('/runs')
    expect(Object.fromEntries(capturedUrl.searchParams)).toEqual({
      projectDir: '/project',
      taskId: 'task-v2',
      branch: 'feature/task-v2',
      limit: '37',
    })
  })

  it('reads immutable intent metadata for one Task-owned run', async () => {
    let requested: URL | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requested = new URL(String(input))
      return response(summary({
        status: 'done',
        finishedAt: 20,
      }))
    })
    const { adapter } = subject(fetchMock)

    await expect(adapter.readTaskRunSummary({
      projectDir: '/project',
      runId: 'run-v2',
    })).resolves.toEqual({
      runId: 'run-v2',
      taskId: 'task-v2',
      agentId: 'codex',
      canvasBranch: 'feature/task-v2',
      baseRevision: 17,
      prompt: 'Generate the requested outputs.',
      status: 'done',
      startedAt: 10,
    })
    const capturedUrl = requireUrl(requested)
    expect(capturedUrl.pathname).toBe('/runs/run-v2')
    expect(capturedUrl.searchParams.get('projectDir')).toBe('/project')
  })

  it.each([
    ['missing prompt', { prompt: undefined }],
    ['missing revision', { baseRevision: undefined }],
    ['negative revision', { baseRevision: -1 }],
    ['oversized prompt', { prompt: 'x'.repeat(250_001) }],
  ])('rejects run summaries with %s', async (_label, overrides) => {
    const candidate = summary(overrides)
    if ('prompt' in overrides && overrides.prompt === undefined) {
      delete candidate.prompt
    }
    if ('baseRevision' in overrides && overrides.baseRevision === undefined) {
      delete candidate.baseRevision
    }
    const fetchMock = vi.fn(async () => response(candidate))
    const { adapter } = subject(fetchMock)

    await expect(adapter.readTaskRunSummary({
      projectDir: '/project',
      runId: 'run-v2',
    })).rejects.toBeInstanceOf(TaskRunProtocolError)
  })

  it('fails before Run creation when the capability handshake is malformed', async () => {
    const requests: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(new URL(String(input)).pathname)
      return response({ schemaVersion: 3, digest: 'not-a-digest', pluginCount: 7 })
    })
    const { adapter } = subject(fetchMock)

    await expect(adapter.createTaskRun({
      projectDir: '/project',
      intent: intent(),
    })).rejects.toBeInstanceOf(TaskRunProtocolError)
    expect(requests).toEqual(['/plugin-capabilities'])
  })

  it.each([
    ['missing', undefined],
    ['malicious', '../other-task'],
  ])('rejects a %s taskId in a Task Run summary', async (_label, taskId) => {
    const candidate = summary()
    if (taskId === undefined) delete candidate.taskId
    else candidate.taskId = taskId
    const fetchMock = vi.fn(async () => response({ runs: [candidate] }))
    const { adapter } = subject(fetchMock)

    await expect(adapter.listTaskRuns({
      projectDir: '/project',
      taskId: 'task-v2',
      branch: 'feature/task-v2',
    })).rejects.toBeInstanceOf(TaskRunProtocolError)
  })

  it('strictly decodes paged durable entries and preserves the complete trusted close plan', async () => {
    let requested: URL | null = null
    const terminal = close()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requested = new URL(String(input))
      return response({
        entries: [{
          id: 42,
          recordedAt: 100,
          event: 'close',
          data: terminal,
        }],
        nextEventId: 42,
      })
    })
    const { adapter } = subject(fetchMock)

    const page = await adapter.readTaskRunLog({
      projectDir: '/project',
      runId: 'run-v2',
      afterEventId: 12,
    })

    const capturedUrl = requireUrl(requested)
    expect(capturedUrl.pathname).toBe('/runs/run-v2/log')
    expect(capturedUrl.searchParams.get('afterEventId')).toBe('12')
    expect(capturedUrl.searchParams.get('limit')).toBe('2000')
    expect(page.nextEventId).toBe(42)
    expect(page.entries).toEqual([{
      id: 42,
      event: 'close',
      data: terminal,
    }])
    const entry = page.entries[0]
    expect(entry?.event === 'close' ? entry.data.projectionPlan : undefined).toEqual(plan())
  })

  it('attaches with Last-Event-ID and forwards the exact SSE event cursor', async () => {
    let headers = new Headers()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      return new Response([
        'id: 5',
        'event: agent-event',
        'data: {"type":"thinking","text":"working"}',
        '',
        'id: 6',
        'event: close',
        `data: ${JSON.stringify(close())}`,
        '',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const { adapter } = subject(fetchMock)
    const events: unknown[] = []

    const result = await adapter.attachTaskRun({
      projectDir: '/project',
      runId: 'run-v2',
      afterEventId: 4,
      signal: new AbortController().signal,
      onEvent: (entry) => events.push(entry),
    })

    expect(headers.get('Last-Event-ID')).toBe('4')
    expect(events).toEqual([{ id: 5, data: { type: 'thinking', text: 'working' } }])
    expect(result.close.projectionPlan).toEqual(plan())
  })

  it('fails closed when an SSE Agent event has no durable id', async () => {
    const fetchMock = vi.fn(async () => new Response([
      'event: agent-event',
      'data: {"type":"thinking","text":"unidentified"}',
      '',
      '',
    ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } }))
    const { adapter } = subject(fetchMock)

    await expect(adapter.attachTaskRun({
      projectDir: '/project',
      runId: 'run-v2',
      afterEventId: 0,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).rejects.toBeInstanceOf(TaskRunProtocolError)
  })

  it('reconciles network uncertainty only by GET runId and never sends cancellation on 404', async () => {
    vi.useFakeTimers()
    const requests: Array<{ method: string; pathname: string }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ method: init?.method ?? 'GET', pathname: url.pathname })
      if (url.pathname === '/plugin-capabilities' && init?.method === 'PUT') {
        return response({ schemaVersion: 3, digest: CAPABILITY_DIGEST, pluginCount: 7 })
      }
      if (url.pathname === '/runs' && init?.method === 'POST') {
        throw new TypeError('network response was lost')
      }
      if (url.pathname === '/runs/run-v2' && init?.method === 'GET') {
        return response({ error: 'not found' }, 404)
      }
      throw new Error(`unexpected request ${url.pathname}`)
    })
    try {
      const { adapter } = subject(fetchMock)
      const runIntent = intent()
      let createError: unknown
      try {
        await adapter.createTaskRun({ projectDir: '/project', intent: runIntent })
      } catch (error) {
        createError = error
      }
      expect(createError).toBeInstanceOf(TaskRunClientError)

      const reconciliation = adapter.reconcileTaskRun({
        projectDir: '/project',
        intent: runIntent,
        cause: createError,
      })
      await vi.runAllTimersAsync()
      await expect(reconciliation).resolves.toBeNull()
      expect(requests).toEqual([
        { method: 'PUT', pathname: '/plugin-capabilities' },
        { method: 'POST', pathname: '/runs' },
        { method: 'GET', pathname: '/runs/run-v2' },
        { method: 'GET', pathname: '/runs/run-v2' },
        { method: 'GET', pathname: '/runs/run-v2' },
      ])
      expect(requests.some((request) => request.pathname.endsWith('/cancel'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a pending Run create and leaves timeout reconciliation to the controller', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason)
          }, { once: true })
        }))
      const { adapter, client } = subject(fetchMock)
      const cancel = vi.spyOn(client, 'cancelRun')

      const creating = adapter.createTaskRun({
        projectDir: '/project',
        intent: intent(),
      })
      const rejected = expect(creating).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(15_000)
      await rejected

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(cancel).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects reconciliation when Task, Agent, or branch identity differs', async () => {
    const fetchMock = vi.fn(async () => response(summary({ agentId: 'other-agent' })))
    const { adapter } = subject(fetchMock)

    await expect(adapter.reconcileTaskRun({
      projectDir: '/project',
      intent: intent(),
      cause: new Error('uncertain'),
    })).rejects.toBeInstanceOf(TaskRunProtocolError)
  })

  it('uses AbortSignal only to detach and never invokes cancel implicitly', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('detached', 'AbortError')
    })
    const { adapter, client } = subject(fetchMock)
    const cancel = vi.spyOn(client, 'cancelRun')
    const abort = new AbortController()
    abort.abort(new DOMException('detached', 'AbortError'))

    await expect(adapter.attachTaskRun({
      projectDir: '/project',
      runId: 'run-v2',
      afterEventId: 0,
      signal: abort.signal,
      onEvent: () => undefined,
    })).rejects.toBeInstanceOf(DOMException)
    expect(cancel).not.toHaveBeenCalled()
  })
})
