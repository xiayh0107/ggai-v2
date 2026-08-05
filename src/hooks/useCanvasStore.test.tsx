// @vitest-environment jsdom
import { StrictMode, act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import { DaemonClient, type DaemonCanvasDocumentV1 } from '@/agent/daemonClient'
import { useCanvasStore, type CanvasStore, type CanvasStoreOptions } from './useCanvasStore'
import type { CanvasNode } from '@/types/canvas'

interface StoreProbeProps {
  onStore: (store: CanvasStore) => void
  options?: CanvasStoreOptions
}

function StoreProbe({ onStore, options }: StoreProbeProps) {
  const store = useCanvasStore(options)
  useEffect(() => onStore(store), [onStore, store])
  return null
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function envelope(document: DaemonCanvasDocumentV1, revision = 0, mutationId: string | null = null) {
  return {
    branch: 'main',
    revision,
    updatedAt: new Date(0).toISOString(),
    lastMutationId: mutationId,
    lastCheckpoint: null,
    document,
  }
}

const emptyDocument = (): DaemonCanvasDocumentV1 => ({
  schemaVersion: 1,
  nodes: [],
  edges: [],
  everCreated: false,
  generationByNodeId: {},
  latestRunByNodeId: {},
  runRefsByNodeId: {},
})

async function waitForStore(
  readStore: () => CanvasStore,
  predicate: (store: CanvasStore) => boolean,
): Promise<void> {
  await vi.waitFor(() => expect(predicate(readStore())).toBe(true))
}

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  registerBuiltinPlugins()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  root = null
  container?.remove()
  container = null
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe('useCanvasStore node creation', () => {
  it('consumes a create menu once under StrictMode', async () => {
    let latestStore: CanvasStore | null = null
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }
    const captureStore = (store: CanvasStore) => { latestStore = store }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <StrictMode>
          <StoreProbe onStore={captureStore} />
        </StrictMode>,
      )
    })

    let sourceId = ''
    act(() => { sourceId = readStore().addNode('text', 10, 20).id })
    act(() => readStore().openCreateMenu({
      sx: 100,
      sy: 100,
      wx: 200,
      wy: 220,
      sourceIds: [sourceId],
    }))
    act(() => {
      readStore().createFromMenu('image')
      // A second event before React commits must see the menu as consumed.
      readStore().createFromMenu('image')
    })

    expect(readStore().nodes).toHaveLength(2)
    expect(readStore().nodes.filter((node) => node.type === 'image')).toHaveLength(1)
    expect(readStore().edges).toHaveLength(1)
    expect(readStore().edges[0]).toMatchObject({ from: sourceId, to: readStore().nodes[1]?.id })
    expect(readStore().nodes[1]?.instruction.sources).toEqual([sourceId])
  })

  it('duplicates one node and selects the committed copy under StrictMode', async () => {
    let latestStore: CanvasStore | null = null
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }
    const captureStore = (store: CanvasStore) => { latestStore = store }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <StrictMode>
          <StoreProbe onStore={captureStore} />
        </StrictMode>,
      )
    })

    let sourceId = ''
    act(() => { sourceId = readStore().addNode('text', 10, 20).id })
    act(() => readStore().duplicateNode(sourceId))

    expect(readStore().nodes).toHaveLength(2)
    expect(readStore().selectedId).toBe(readStore().nodes[1]?.id)
    expect(readStore().selectedIds).toEqual([readStore().nodes[1]?.id])
  })

  it('invalidates Agent suggestions through the downstream graph but not for geometry changes', async () => {
    let latestStore: CanvasStore | null = null
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe onStore={(store) => { latestStore = store }} />)
    })

    let sourceId = ''
    let targetId = ''
    let downstreamId = ''
    act(() => { sourceId = readStore().addNode('text', 0, 0).id })
    act(() => { targetId = readStore().addNode('text', 200, 0).id })
    act(() => { downstreamId = readStore().addNode('text', 400, 0).id })
    act(() => readStore().addEdge(sourceId, targetId))
    act(() => readStore().addEdge(targetId, downstreamId))

    const seedSuggestions = (id: string) => {
      const current = readStore().nodes.find((node) => node.id === id)
      if (!current) throw new Error(`missing ${id}`)
      act(() => readStore().updateNode(id, {
        instruction: {
          ...current.instruction,
          suggestedActions: {
            runId: `run-${id}`,
            actions: [{ id: 'next', label: '下一步', prompt: '继续' }],
          },
        },
      }))
    }
    seedSuggestions(sourceId)
    seedSuggestions(targetId)
    seedSuggestions(downstreamId)

    act(() => readStore().updateNode(sourceId, { x: 42, y: 18 }))
    expect(readStore().nodes.every((node) => node.instruction.suggestedActions)).toBe(true)

    act(() => readStore().updateNode(sourceId, { text: '源内容已改变' }))
    expect(readStore().nodes.every((node) => !node.instruction.suggestedActions)).toBe(true)

    seedSuggestions(targetId)
    seedSuggestions(downstreamId)
    const firstEdge = readStore().edges.find((edge) => edge.from === sourceId && edge.to === targetId)
    if (!firstEdge) throw new Error('missing source edge')
    act(() => readStore().cycleEdgeLabel(firstEdge.id))
    expect(readStore().nodes.find((node) => node.id === targetId)?.instruction.suggestedActions).toBeUndefined()
    expect(readStore().nodes.find((node) => node.id === downstreamId)?.instruction.suggestedActions).toBeUndefined()

    seedSuggestions(targetId)
    seedSuggestions(downstreamId)
    act(() => readStore().removeEdge(firstEdge.id))
    expect(readStore().nodes.find((node) => node.id === targetId)?.instruction.sources).toEqual([])
    expect(readStore().nodes.find((node) => node.id === targetId)?.instruction.suggestedActions).toBeUndefined()
    expect(readStore().nodes.find((node) => node.id === downstreamId)?.instruction.suggestedActions).toBeUndefined()
  })
})

describe('useCanvasStore persistence', () => {
  it('hydrates once under StrictMode and restores completed run logs', async () => {
    let latestStore: CanvasStore | null = null
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }
    const node: CanvasNode = {
      id: 'text-1',
      type: 'text',
      x: 10,
      y: 20,
      w: 320,
      h: 180,
      title: '文本',
      instruction: {
        phase: 'generating',
        prompt: '继续',
        attachments: [],
        sources: [],
        open: false,
      },
      payload: {},
    }
    const persistedDocument: DaemonCanvasDocumentV1 = {
      ...emptyDocument(),
      nodes: [node],
      everCreated: true,
      generationByNodeId: {
        [node.id]: {
          epoch: 3,
          current: { key: 'finishing', kind: 'finishing', label: '正在整理结果' },
          recent: [],
          log: [{ kind: 'output', text: 'persisted output' }],
        },
      },
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/runs') return jsonResponse({ runs: [] })
      return jsonResponse(envelope(persistedDocument, 4, 'previous'))
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <StrictMode>
          <StoreProbe onStore={(store) => { latestStore = store }} options={{ client }} />
        </StrictMode>,
      )
    })
    await waitForStore(readStore, (store) => store.hydrationState === 'ready')

    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/canvas'))
      .toHaveLength(1)
    expect(readStore().nodes[0]?.instruction).toMatchObject({ phase: 'idle', open: true })
    expect(readStore().generationByNodeId[node.id]?.log).toEqual([
      { kind: 'output', text: 'persisted output' },
    ])
  })

  it('rebuilds a durable run log and marks a daemon-restarted run interrupted', async () => {
    let latestStore: CanvasStore | null = null
    const node: CanvasNode = {
      id: 'text-interrupted',
      type: 'text',
      x: 10,
      y: 20,
      w: 320,
      h: 180,
      title: '文本',
      instruction: {
        phase: 'generating',
        prompt: 'continue',
        attachments: [],
        sources: [],
        open: false,
      },
      payload: {},
    }
    const persistedDocument: DaemonCanvasDocumentV1 = {
      ...emptyDocument(),
      nodes: [node],
      everCreated: true,
      generationByNodeId: {
        [node.id]: {
          epoch: 8,
          current: { key: 'connecting', kind: 'connecting', label: '正在连接 Agent' },
          recent: [],
          log: [],
        },
      },
      latestRunByNodeId: { [node.id]: 'run-interrupted' },
      runRefsByNodeId: {
        [node.id]: { runId: 'run-interrupted', lastEventId: 0, previousPhase: 'idle' },
      },
    }
    const savedDocuments: DaemonCanvasDocumentV1[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/canvas' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          mutationId: string
          document: DaemonCanvasDocumentV1
        }
        savedDocuments.push(body.document)
        return jsonResponse(envelope(body.document, 3, body.mutationId))
      }
      if (url.pathname === '/canvas') return jsonResponse(envelope(persistedDocument, 2))
      if (url.pathname === '/runs') return jsonResponse({ runs: [] })
      if (url.pathname === '/runs/run-interrupted') {
        return jsonResponse({
          runId: 'run-interrupted',
          nodeId: node.id,
          agentId: 'codex',
          status: 'interrupted',
          startedAt: 1,
          finishedAt: 2,
          sessionId: null,
          error: 'daemon restarted before the run completed',
          logAvailable: true,
        })
      }
      if (url.pathname === '/runs/run-interrupted/log') {
        return jsonResponse({
          entries: [{
            id: 1,
            recordedAt: 1,
            event: 'agent-event',
            data: { type: 'text-delta', text: 'durable partial output' },
          }],
          nextEventId: null,
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe onStore={(store) => { latestStore = store }} options={{ client }} />)
    })
    await waitForStore(readStore, (store) =>
      store.nodes[0]?.meta?.some((entry) => entry.startsWith('执行中断 ·')) === true)

    expect(readStore().nodes[0]?.instruction).toMatchObject({ phase: 'idle', open: true })
    expect(readStore().generationByNodeId[node.id]?.log).toContainEqual({
      kind: 'output',
      text: 'durable partial output',
    })
    await act(async () => {
      await vi.waitFor(() => expect(savedDocuments.at(-1)?.runRefsByNodeId).toEqual({}), {
        timeout: 1_500,
      })
    })
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .not.toContain('/runs/run-interrupted/cancel')
  })

  it('detaches a restored active run on unmount without cancelling it', async () => {
    let latestStore: CanvasStore | null = null
    const node: CanvasNode = {
      id: 'text-running',
      type: 'text',
      x: 0,
      y: 0,
      w: 320,
      h: 180,
      title: '文本',
      instruction: {
        phase: 'generating',
        prompt: 'keep running',
        attachments: [],
        sources: [],
        open: false,
      },
      payload: {},
    }
    const persistedDocument: DaemonCanvasDocumentV1 = {
      ...emptyDocument(),
      nodes: [node],
      generationByNodeId: {
        [node.id]: {
          epoch: 2,
          current: { key: 'connecting', kind: 'connecting', label: '正在连接 Agent' },
          recent: [],
          log: [],
        },
      },
      latestRunByNodeId: { [node.id]: 'run-running' },
      runRefsByNodeId: {
        [node.id]: { runId: 'run-running', lastEventId: 1, previousPhase: 'idle' },
      },
    }
    const requestedPaths: string[] = []
    let streamLastEventId: string | null = null
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requestedPaths.push(url.pathname)
      if (url.pathname === '/canvas') {
        return Promise.resolve(jsonResponse(envelope(persistedDocument, 1)))
      }
      if (url.pathname === '/runs') return Promise.resolve(jsonResponse({ runs: [] }))
      if (url.pathname === '/runs/run-running') {
        return Promise.resolve(jsonResponse({
          runId: 'run-running',
          nodeId: node.id,
          agentId: 'codex',
          canvasBranch: 'main',
          status: 'running',
          startedAt: 1,
          sessionId: null,
          logAvailable: true,
        }))
      }
      if (url.pathname === '/runs/run-running/log') {
        return Promise.resolve(jsonResponse({
          entries: [{
            id: 9,
            recordedAt: 9,
            event: 'agent-event',
            data: { type: 'thinking', text: 'replayed from durable log' },
          }],
          nextEventId: null,
        }))
      }
      if (url.pathname === '/runs/run-running/events') {
        streamLastEventId = new Headers(init?.headers).get('Last-Event-ID')
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe onStore={(store) => { latestStore = store }} options={{ client }} />)
    })
    await vi.waitFor(() => expect(requestedPaths).toContain('/runs/run-running/events'))
    await act(async () => {
      root?.unmount()
      root = null
      await Promise.resolve()
    })

    expect(requestedPaths).not.toContain('/runs/run-running/cancel')
    expect(streamLastEventId).toBe('9')
    expect((latestStore as CanvasStore | null)?.nodes[0]?.instruction.phase).toBe('generating')
  })

  it('debounces changes and acknowledges a real daemon save', async () => {
    let latestStore: CanvasStore | null = null
    let revision = 0
    const putBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse(envelope(emptyDocument()))
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      putBodies.push(body)
      revision += 1
      return jsonResponse(envelope(
        body.document as DaemonCanvasDocumentV1,
        revision,
        body.mutationId as string,
      ))
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe onStore={(store) => { latestStore = store }} options={{ client }} />)
    })
    await waitForStore(readStore, (store) => store.hydrationState === 'ready')
    vi.useFakeTimers()

    act(() => { readStore().addNode('text', 10, 20) })
    expect(readStore().savedState).toBe('local-pending')
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(putBodies).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(putBodies).toHaveLength(1)
    expect(putBodies[0]).toMatchObject({ baseRevision: 0, changeKind: 'autosave' })
    expect((putBodies[0].document as DaemonCanvasDocumentV1).nodes).toHaveLength(1)
    expect(readStore().savedState).toBe('saved')
  })

  it('serializes a newer snapshot behind an in-flight write', async () => {
    let latestStore: CanvasStore | null = null
    let resolveFirstPut: ((response: Response) => void) | null = null
    const putBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(jsonResponse(envelope(emptyDocument())))
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      putBodies.push(body)
      if (putBodies.length === 1) {
        return new Promise<Response>((resolve) => { resolveFirstPut = resolve })
      }
      return Promise.resolve(jsonResponse(envelope(
        body.document as DaemonCanvasDocumentV1,
        2,
        body.mutationId as string,
      )))
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe onStore={(store) => { latestStore = store }} options={{ client }} />)
    })
    await waitForStore(readStore, (store) => store.hydrationState === 'ready')
    vi.useFakeTimers()

    let nodeId = ''
    act(() => { nodeId = readStore().addNode('text', 10, 20).id })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(putBodies).toHaveLength(1)

    act(() => readStore().updateNode(nodeId, { title: '最新标题' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(putBodies).toHaveLength(1)

    const firstBody = putBodies[0]
    await act(async () => {
      resolveFirstPut?.(jsonResponse(envelope(
        firstBody.document as DaemonCanvasDocumentV1,
        1,
        firstBody.mutationId as string,
      )))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(putBodies).toHaveLength(2))

    expect(putBodies[1]).toMatchObject({ baseRevision: 1 })
    expect((putBodies[1].document as DaemonCanvasDocumentV1).nodes[0]?.title).toBe('最新标题')
    await waitForStore(readStore, (store) => store.savedState === 'saved')
  })

  it('preserves a conflicted local snapshot on a new branch without overwriting main', async () => {
    let latestStore: CanvasStore | null = null
    const navigated: string[] = []
    const writes: Array<{ branch: string; document: DaemonCanvasDocumentV1 }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/canvas' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(envelope(emptyDocument(), 1))
      }
      if (url.pathname === '/canvas' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          mutationId: string
          document: DaemonCanvasDocumentV1
        }
        const targetBranch = url.searchParams.get('branch') ?? 'main'
        writes.push({ branch: targetBranch, document: body.document })
        if (targetBranch === 'main') {
          return jsonResponse({ error: { code: 'canvas_revision_conflict' } }, 409)
        }
        return jsonResponse({
          ...envelope(body.document, 2, body.mutationId),
          branch: targetBranch,
        })
      }
      if (url.pathname === '/canvas/branches' && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          partial: false,
          sourceDegraded: false,
          versioning: { state: 'ready', initialized: true, gitAvailable: true },
          source: { status: 'unbound', branches: [] },
          value: {
            branch: { name: 'recover-local', commit: 'abc123', worktree: null },
            canvas: { ...envelope(emptyDocument(), 1), branch: 'recover-local' },
            sourceBranch: null,
          },
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe
        onStore={(store) => { latestStore = store }}
        options={{ client, navigateToBranch: (name) => navigated.push(name) }}
      />)
    })
    await waitForStore(readStore, (store) => store.hydrationState === 'ready')
    vi.useFakeTimers()
    act(() => { readStore().addNode('text', 10, 20) })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(readStore().savedState).toBe('conflict')

    await act(async () => { await readStore().preserveConflictAsBranch('recover-local') })

    expect(writes.map((write) => write.branch)).toEqual(['main', 'recover-local'])
    expect(writes[1]?.document.nodes).toHaveLength(1)
    expect(navigated).toEqual(['recover-local'])
    expect(readStore().savedState).toBe('saved')
  })
})

describe('useCanvasStore run races', () => {
  const runnableNode = (): CanvasNode => ({
    id: 'text-run',
    type: 'text',
    x: 10,
    y: 20,
    w: 320,
    h: 180,
    title: '文本',
    instruction: {
      phase: 'idle',
      prompt: 'generate',
      attachments: [],
      sources: [],
      open: true,
    },
    payload: {},
  })

  it('keeps the run reference and live subscription when cancellation is rejected', async () => {
    let latestStore: CanvasStore | null = null
    let streamAborted = false
    let revision = 1
    const node = runnableNode()
    const initial = { ...emptyDocument(), nodes: [node], everCreated: true }
    const requested: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requested.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname === '/canvas' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          mutationId: string
          document: DaemonCanvasDocumentV1
        }
        revision += 1
        return Promise.resolve(jsonResponse(envelope(body.document, revision, body.mutationId)))
      }
      if (url.pathname === '/canvas') return Promise.resolve(jsonResponse(envelope(initial, revision)))
      if (url.pathname === '/runs' && init?.method === 'GET') {
        return Promise.resolve(jsonResponse({ runs: [] }))
      }
      if (url.pathname === '/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { runId: string }
        return Promise.resolve(jsonResponse({ runId: body.runId }, 202))
      }
      if (url.pathname.endsWith('/events')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            streamAborted = true
            reject(init.signal?.reason)
          }, { once: true })
        })
      }
      if (url.pathname.endsWith('/cancel')) {
        return Promise.resolve(jsonResponse({ error: { code: 'cancel_failed' } }, 500))
      }
      throw new Error(`unexpected request ${url}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe onStore={(store) => { latestStore = store }} options={{ client }} />)
    })
    await waitForStore(readStore, (store) => store.hydrationState === 'ready')
    act(() => readStore().runInstruction(node.id))
    await vi.waitFor(() => expect(requested.some((entry) => entry === 'POST /runs')).toBe(true))
    act(() => readStore().cancelInstruction(node.id))
    await waitForStore(readStore, (store) =>
      store.nodes[0]?.meta?.some((entry) => entry.startsWith('取消失败 ·')) === true)

    expect(readStore().nodes[0]?.instruction.phase).toBe('generating')
    expect(streamAborted).toBe(false)
  })

  it('awaits confirmed cancellation before posting a replacement run', async () => {
    let latestStore: CanvasStore | null = null
    let resolveCancellation: ((response: Response) => void) | null = null
    const node = runnableNode()
    const initial = { ...emptyDocument(), nodes: [node], everCreated: true }
    const postedRuns: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/canvas' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          mutationId: string
          document: DaemonCanvasDocumentV1
        }
        return Promise.resolve(jsonResponse(envelope(body.document, 2, body.mutationId)))
      }
      if (url.pathname === '/canvas') return Promise.resolve(jsonResponse(envelope(initial, 1)))
      if (url.pathname === '/runs' && init?.method === 'GET') {
        return Promise.resolve(jsonResponse({ runs: [] }))
      }
      if (url.pathname === '/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { runId: string }
        postedRuns.push(body.runId)
        return Promise.resolve(jsonResponse({ runId: body.runId }, 202))
      }
      if (url.pathname.endsWith('/events')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      if (url.pathname.endsWith('/cancel')) {
        return new Promise<Response>((resolve) => { resolveCancellation = resolve })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe onStore={(store) => { latestStore = store }} options={{ client }} />)
    })
    await waitForStore(readStore, (store) => store.hydrationState === 'ready')
    act(() => readStore().runInstruction(node.id))
    await vi.waitFor(() => expect(postedRuns).toHaveLength(1))
    act(() => readStore().runInstruction(node.id))
    await vi.waitFor(() => expect(resolveCancellation).not.toBeNull())
    expect(postedRuns).toHaveLength(1)

    await act(async () => {
      resolveCancellation?.(jsonResponse({ status: 'cancelled' }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(postedRuns).toHaveLength(2))
    expect(postedRuns[1]).not.toBe(postedRuns[0])
  })

  it('discovers an accepted active run when the pre-POST runRef save was interrupted', async () => {
    let latestStore: CanvasStore | null = null
    const node = { ...runnableNode(), instruction: { ...runnableNode().instruction, phase: 'generating' as const } }
    const initial = { ...emptyDocument(), nodes: [node], everCreated: true }
    const requestedPaths: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requestedPaths.push(url.pathname)
      if (url.pathname === '/canvas' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          mutationId: string
          document: DaemonCanvasDocumentV1
        }
        return Promise.resolve(jsonResponse(envelope(body.document, 2, body.mutationId)))
      }
      if (url.pathname === '/canvas') return Promise.resolve(jsonResponse(envelope(initial, 1)))
      if (url.pathname === '/runs') {
        return Promise.resolve(jsonResponse({
          runs: [{
            runId: 'run-crash-window',
            nodeId: node.id,
            agentId: 'codex',
            canvasBranch: 'main',
            status: 'running',
            startedAt: 2,
            sessionId: null,
          }, {
            runId: 'run-other-branch',
            nodeId: node.id,
            agentId: 'codex',
            canvasBranch: 'experiment-b',
            status: 'running',
            startedAt: 3,
            sessionId: null,
          }],
        }))
      }
      if (url.pathname === '/runs/run-crash-window') {
        return Promise.resolve(jsonResponse({
          runId: 'run-crash-window',
          nodeId: node.id,
          agentId: 'codex',
          canvasBranch: 'main',
          status: 'running',
          startedAt: 2,
          sessionId: null,
        }))
      }
      if (url.pathname === '/runs/run-crash-window/log') {
        return Promise.resolve(jsonResponse({ entries: [], nextEventId: null }))
      }
      if (url.pathname === '/runs/run-crash-window/events') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch: fetchMock })
    const readStore = (): CanvasStore => {
      if (!latestStore) throw new Error('store probe has not rendered')
      return latestStore
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<StoreProbe onStore={(store) => { latestStore = store }} options={{ client }} />)
    })
    await vi.waitFor(() => expect(requestedPaths).toContain('/runs/run-crash-window/events'))

    expect(readStore().nodes[0]?.instruction.phase).toBe('generating')
    expect(requestedPaths).not.toContain('/runs/run-other-branch')
  })
})
