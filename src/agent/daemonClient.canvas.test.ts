import { describe, expect, it, vi } from 'vitest'
import {
  DaemonClient,
  DaemonHttpError,
  DaemonProtocolError,
  decodeDaemonRunLogEntry,
  type DaemonCanvasDocumentV1,
} from './daemonClient'

const document: DaemonCanvasDocumentV1 = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  everCreated: false,
  generationByNodeId: {},
  latestRunByNodeId: {},
  runRefsByNodeId: {},
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status === 409 ? 'Conflict' : 'OK',
    headers: { 'Content-Type': 'application/json' },
  })
}

function envelope(revision = 0, mutationId: string | null = null) {
  return {
    branch: 'experiment-a',
    revision,
    updatedAt: new Date(0).toISOString(),
    lastMutationId: mutationId,
    lastCheckpoint: null,
    document,
  }
}

describe('DaemonClient canvas persistence', () => {
  it('decodes both legacy close events and optional structured outcomes', () => {
    const legacy = decodeDaemonRunLogEntry({
      id: 1,
      recordedAt: 1,
      event: 'close',
      data: {
        runId: 'run-legacy',
        status: 'done',
        sessionId: null,
        artifacts: [],
        artifactsComplete: true,
      },
    }, 'run-legacy')
    expect(legacy).toMatchObject({ event: 'close', data: { status: 'done' } })
    if (legacy.event === 'close') expect(legacy.data.outcome).toBeUndefined()

    const withOutcome = decodeDaemonRunLogEntry({
      id: 2,
      recordedAt: 2,
      event: 'close',
      data: {
        runId: 'run-outcome',
        status: 'done',
        sessionId: null,
        artifacts: [],
        artifactsComplete: true,
        outcome: {
          schemaVersion: 1,
          suggestedActions: [
            { id: 'chart', label: '生成图表', prompt: '将这份数据生成趋势图。' },
            { id: 'summary', label: '提取结论', prompt: '提取三条核心结论。' },
            { id: 'risks', label: '标注风险', prompt: '标注数据中的风险信号。' },
          ],
        },
      },
    }, 'run-outcome')
    expect(withOutcome).toMatchObject({
      event: 'close',
      data: {
        outcome: {
          schemaVersion: 1,
          suggestedActions: expect.arrayContaining([
            expect.objectContaining({ label: '生成图表', prompt: '将这份数据生成趋势图。' }),
          ]),
        },
      },
    })
  })

  it('rejects a malformed close outcome instead of leaking it into canvas state', () => {
    expect(() => decodeDaemonRunLogEntry({
      id: 1,
      recordedAt: 1,
      event: 'close',
      data: {
        runId: 'run-bad-outcome',
        status: 'done',
        sessionId: null,
        artifacts: [],
        artifactsComplete: true,
        outcome: {
          schemaVersion: 1,
          suggestedActions: [{ id: 'missing-prompt', label: '无效' }],
        },
      },
    }, 'run-bad-outcome')).toThrow(DaemonProtocolError)
  })

  it('ignores an unknown outcome schema without losing the terminal close', () => {
    const decoded = decodeDaemonRunLogEntry({
      id: 1,
      recordedAt: 1,
      event: 'close',
      data: {
        runId: 'run-future-outcome',
        status: 'done',
        sessionId: null,
        artifacts: ['result.txt'],
        artifactsComplete: true,
        outcome: { schemaVersion: 2, nextSteps: [] },
      },
    }, 'run-future-outcome')

    expect(decoded).toMatchObject({
      event: 'close',
      data: { runId: 'run-future-outcome', status: 'done', artifacts: ['result.txt'] },
    })
    if (decoded.event === 'close') expect(decoded.data.outcome).toBeUndefined()
  })

  it('loads a typed branch-scoped canvas document', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input
      return response(envelope(7, 'mutation-7'))
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    const result = await client.getCanvas({ projectDir: '.', branch: 'experiment-a' })

    expect(result).toMatchObject({ branch: 'experiment-a', revision: 7 })
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(requestedUrl.pathname).toBe('/canvas')
    expect(requestedUrl.searchParams.get('projectDir')).toBe('.')
    expect(requestedUrl.searchParams.get('branch')).toBe('experiment-a')
  })

  it('sends revision and mutation metadata with a canvas save', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { mutationId: string }
      return response(envelope(8, body.mutationId))
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    const result = await client.putCanvas({
      baseRevision: 7,
      mutationId: 'mutation-8',
      changeKind: 'autosave',
      document,
    }, { projectDir: '.', branch: 'experiment-a' })

    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      baseRevision: 7,
      mutationId: 'mutation-8',
      changeKind: 'autosave',
    })
    expect(result).toMatchObject({ revision: 8, lastMutationId: 'mutation-8' })
  })

  it('surfaces daemon revision conflicts as HTTP 409', async () => {
    const fetchMock = vi.fn(async () => response({
      error: { code: 'canvas_revision_conflict', currentRevision: 9 },
    }, 409))
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    await expect(client.putCanvas({
      baseRevision: 7,
      mutationId: 'stale-mutation',
      changeKind: 'autosave',
      document,
    }, { branch: 'experiment-a' })).rejects.toBeInstanceOf(DaemonHttpError)
  })
})

describe('DaemonClient resumable runs', () => {
  it('lists branch-scoped run summaries for crash recovery', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input
      return response({
        runs: [{
          runId: 'run-active',
          nodeId: 'node-1',
          agentId: 'codex',
          canvasBranch: 'experiment-a',
          status: 'running',
          startedAt: 1,
          sessionId: null,
        }],
      })
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    const runs = await client.listRuns({
      projectDir: '.',
      nodeId: 'node-1',
      branch: 'experiment-a',
      limit: 10,
    })

    expect(runs[0]).toMatchObject({ runId: 'run-active', canvasBranch: 'experiment-a' })
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.searchParams.get('nodeId')).toBe('node-1')
    expect(url.searchParams.get('branch')).toBe('experiment-a')
  })

  it('preserves an optional canvas branch in persisted run summaries', async () => {
    const fetchMock = vi.fn(async () => response({
      runId: 'run-branch',
      nodeId: 'node-1',
      agentId: 'codex',
      canvasBranch: 'experiment-a',
      status: 'interrupted',
      startedAt: 1,
      finishedAt: 2,
      sessionId: null,
    }))
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    await expect(client.getRun('run-branch')).resolves.toMatchObject({
      runId: 'run-branch',
      canvasBranch: 'experiment-a',
      status: 'interrupted',
    })
  })

  it('normalizes a legacy run summary without a branch to main', async () => {
    const fetchMock = vi.fn(async () => response({
      runId: 'run-legacy-main',
      nodeId: 'node-1',
      agentId: 'codex',
      status: 'interrupted',
      startedAt: 1,
      finishedAt: 2,
      sessionId: null,
    }))
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    await expect(client.getRun('run-legacy-main')).resolves.toMatchObject({
      runId: 'run-legacy-main',
      canvasBranch: 'main',
      status: 'interrupted',
    })
  })

  it('starts independently and attaches with Last-Event-ID', async () => {
    const seenEvents: string[] = []
    const seenIds: number[] = []
    let streamHeaders = new Headers()
    let createBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { runId: string } & Record<string, unknown>
        createBody = body
        return response({ runId: body.runId }, 202)
      }
      if (url.pathname.endsWith('/events')) {
        streamHeaders = new Headers(init?.headers)
        return new Response([
          'id: 5',
          'event: agent-event',
          'data: {"type":"text-delta","text":"hello"}',
          '',
          'id: 6',
          'event: close',
          'data: {"runId":"00000000-0000-4000-8000-000000000001","status":"done","sessionId":null,"artifacts":[],"artifactsComplete":true}',
          '',
          '',
        ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001')
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    const created = await client.startRun({
      nodeId: 'node-1',
      agentId: 'codex',
      sessionId: null,
      prompt: 'hello',
      projectDir: '.',
      canvasBranch: 'experiment-a',
      canvasSnapshot: { nodes: [], edges: [] },
      onEvent: () => undefined,
    })
    const result = await client.attachRun(created.runId, {
      afterEventId: 4,
      onEvent: (event) => seenEvents.push(event.type),
      onEventId: (id) => seenIds.push(id),
    })

    expect(streamHeaders.get('Last-Event-ID')).toBe('4')
    expect(createBody).toMatchObject({ canvasBranch: 'experiment-a' })
    expect(seenEvents).toEqual(['text-delta'])
    expect(seenIds).toEqual([5, 6])
    expect(result.close.status).toBe('done')
  })

  it('combines caller cancellation with the create timeout and recovers an accepted POST', async () => {
    const runId = '00000000-0000-4000-8000-000000000009'
    let postWasAborted = false
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/runs' && init?.method === 'POST') {
        const postSignal = init.signal
        return new Promise<Response>((_resolve, reject) => {
          postSignal?.addEventListener('abort', () => {
            postWasAborted = true
            reject(postSignal?.reason ?? new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      if (url.pathname === `/runs/${runId}`) {
        return Promise.resolve(response({
          runId,
          nodeId: 'node-1',
          agentId: 'codex',
          canvasBranch: 'main',
          status: 'running',
          startedAt: 1,
          sessionId: null,
        }))
      }
      throw new Error(`unexpected request ${url}`)
    })
    const controller = new AbortController()
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    const starting = client.startRun({
      runId,
      nodeId: 'node-1',
      agentId: 'codex',
      sessionId: null,
      prompt: 'hello',
      projectDir: '.',
      canvasBranch: 'main',
      canvasSnapshot: { nodes: [], edges: [] },
      onEvent: () => undefined,
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort(new DOMException('tab detached', 'AbortError'))

    await expect(starting).resolves.toEqual({ runId })
    expect(postWasAborted).toBe(true)
    expect(client.activeRunIds).toContain(runId)
  })

  it('detaches an aborted subscription without posting cancel', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('detached', 'AbortError')
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })
    const cancel = vi.spyOn(client, 'cancelRun')
    const controller = new AbortController()
    controller.abort()

    await expect(client.attachRun('run-1', {
      signal: controller.signal,
      onEvent: () => undefined,
    })).rejects.toBeInstanceOf(DOMException)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('fills an SSE replay gap from the durable run log', async () => {
    const requestedPaths: string[] = []
    const events: string[] = []
    const ids: number[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requestedPaths.push(url.pathname)
      if (url.pathname === '/runs/run-gap/events') {
        return response({ error: { code: 'event_history_gap' } }, 409)
      }
      if (url.pathname === '/runs/run-gap/log') {
        return response({
          entries: [
            {
              id: 10,
              recordedAt: 10,
              event: 'agent-event',
              data: { type: 'text-delta', text: 'recovered' },
            },
            {
              id: 11,
              recordedAt: 11,
              event: 'close',
              data: {
                runId: 'run-gap',
                status: 'done',
                sessionId: null,
                artifacts: [],
                artifactsComplete: true,
              },
            },
          ],
          nextEventId: null,
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    const result = await client.attachRun('run-gap', {
      projectDir: '.',
      afterEventId: 1,
      onEvent: (event) => events.push(event.type),
      onEventId: (id) => ids.push(id),
    })

    expect(requestedPaths).toEqual(['/runs/run-gap/events', '/runs/run-gap/log'])
    expect(events).toEqual(['text-delta'])
    expect(ids).toEqual([10, 11])
    expect(result.close.status).toBe('done')
  })
})
