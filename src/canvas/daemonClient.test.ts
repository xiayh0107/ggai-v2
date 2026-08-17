import { describe, expect, it, vi } from 'vitest'
import type {
  CanvasCommand,
  TrustedGraphMaterializationPlanInput,
  TrustedProjectionPlanInput,
} from './commands'
import {
  CanvasDaemonClient,
  CanvasHttpError,
  CanvasProtocolError,
  MAX_CANVAS_CONFLICT_MUTATIONS,
  serializeCanvasCommand,
} from './daemonClient'
import { emptyCanvasDocument } from './model'
import {
  CanvasPersistence,
  MemoryCanvasPersistenceAdapter,
  type CanvasPersistenceScope,
} from './persistence'

const scope = { projectDir: '/workspace/project', branch: 'main' }
const persistenceScope: CanvasPersistenceScope = {
  daemonBaseUrl: 'http://127.0.0.1:7380',
  ...scope,
}

function envelope(
  revision: number,
  lastMutationId: string | null = null,
  branch = 'main',
) {
  return {
    branch,
    revision,
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastMutationId,
    document: emptyCanvasDocument(),
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function command(type: 'UpdateTaskGoal', goal = 'New goal'): CanvasCommand {
  return { type, taskId: 'task-1', goal }
}

function plan(): TrustedProjectionPlanInput {
  return {
    schemaVersion: 2,
    taskId: 'task-1',
    planId: `plan_${'a'.repeat(64)}`,
    runId: 'run-1',
    status: 'complete',
    manifestDigest: 'manifest-digest',
    outputs: [],
    taskProposals: [],
    warnings: [],
    digest: 'plan-digest',
  }
}

describe('Canvas daemon client', () => {
  it('reads the daemon Canvas capability from health without a canvas scope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/health')
      expect(url.search).toBe('')
      expect(init?.method).toBe('GET')
      return json({
        capabilities: { canvas: true },
        canvas: { schemaVersion: 3, initializationRequired: false },
      })
    })
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    await expect(client.getCapabilities()).resolves.toEqual({
      canvas: true,
      schemaVersion: 3,
      initializationRequired: false,
    })
  })

  it('binds the default browser fetch to its global receiver', async () => {
    const receiverFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(json({
        capabilities: { canvas: true },
        canvas: { schemaVersion: 3, initializationRequired: false },
      }))
    })
    vi.stubGlobal('fetch', receiverFetch)
    try {
      const client = new CanvasDaemonClient({ baseUrl: persistenceScope.daemonBaseUrl })
      await expect(client.getCapabilities()).resolves.toMatchObject({ canvas: true })
      expect(receiverFetch).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects contradictory health model declarations instead of guessing', async () => {
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch: async () => json({
        capabilities: { canvas: false },
        canvas: { schemaVersion: 1, initializationRequired: false },
      }),
    })

    await expect(client.getCapabilities()).rejects.toThrow(
      'Daemon Canvas capabilities are inconsistent',
    )
  })

  it('GETs and validates a branch Canvas envelope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/canvas')
      expect(url.searchParams.get('projectDir')).toBe(scope.projectDir)
      expect(url.searchParams.get('branch')).toBe('main')
      expect(init?.method).toBe('GET')
      return json(envelope(4))
    })
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    expect((await client.getCanvas(scope)).revision).toBe(4)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('POSTs one command envelope and never sends a document', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual([
        'baseRevision',
        'branch',
        'command',
        'mutationId',
      ])
      expect(body).not.toHaveProperty('document')
      expect(body).toMatchObject({
        branch: 'main',
        baseRevision: 4,
        mutationId: 'mutation-1',
        command: { type: 'UpdateTaskGoal', taskId: 'task-1', goal: 'New goal' },
      })
      return json(envelope(5, 'mutation-1'))
    })
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    const result = await client.executeCommand(scope, {
      branch: 'main',
      baseRevision: 4,
      initialBaseRevision: 4,
      mutationId: 'mutation-1',
      command: command('UpdateTaskGoal'),
      createdAt: 1,
    })
    expect(result.revision).toBe(5)
  })

  it('saves only serialized conflict mutations and strictly accepts the HTTP 201 result', async () => {
    const trustedPlan = plan()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/canvas/conflicts')
      expect(url.searchParams.get('projectDir')).toBe(scope.projectDir)
      expect(url.searchParams.has('branch')).toBe(false)
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual([
        'baseRevision',
        'mutations',
        'newBranch',
        'sourceBranch',
      ])
      expect(body).toEqual({
        sourceBranch: 'main',
        newBranch: 'conflicts/chart',
        baseRevision: 4,
        mutations: [
          {
            mutationId: 'mutation-1',
            command: { type: 'UpdateTaskGoal', taskId: 'task-1', goal: 'Keep local' },
          },
          {
            mutationId: 'mutation-2',
            command: { type: 'MaterializeProjectionPlan', planId: trustedPlan.planId },
          },
        ],
      })
      expect(JSON.stringify(body)).not.toContain('document')
      expect(JSON.stringify(body)).not.toContain('manifestDigest')
      return json({
        sourceBranch: 'main',
        newBranch: 'conflicts/chart',
        baseRevision: 4,
        canvas: envelope(6, 'mutation-2', 'conflicts/chart'),
      }, 201)
    })
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    await expect(client.saveConflictBranch(scope, {
      sourceBranch: 'main',
      newBranch: 'conflicts/chart',
      baseRevision: 4,
      mutations: [
        { mutationId: 'mutation-1', command: command('UpdateTaskGoal', 'Keep local') },
        {
          mutationId: 'mutation-2',
          command: { type: 'MaterializeProjectionPlan', plan: trustedPlan },
        },
      ],
    })).resolves.toMatchObject({
      sourceBranch: 'main',
      newBranch: 'conflicts/chart',
      baseRevision: 4,
      canvas: { branch: 'conflicts/chart', revision: 6 },
    })
  })

  it('rejects oversized conflict batches and non-201 or drifting responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })
    await expect(client.saveConflictBranch(scope, {
      sourceBranch: 'main',
      newBranch: 'conflicts/too-many',
      baseRevision: 1,
      mutations: Array.from({ length: MAX_CANVAS_CONFLICT_MUTATIONS + 1 }, (_, index) => ({
        mutationId: `mutation-${index}`,
        command: command('UpdateTaskGoal'),
      })),
    })).rejects.toThrow(`1-${MAX_CANVAS_CONFLICT_MUTATIONS} mutations`)
    expect(fetch).not.toHaveBeenCalled()

    const wrongStatus = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch: async () => json({
        sourceBranch: 'main',
        newBranch: 'conflicts/chart',
        baseRevision: 1,
        canvas: envelope(2, null, 'conflicts/chart'),
      }, 200),
    })
    await expect(wrongStatus.saveConflictBranch(scope, {
      sourceBranch: 'main',
      newBranch: 'conflicts/chart',
      baseRevision: 1,
      mutations: [{ mutationId: 'mutation-1', command: command('UpdateTaskGoal') }],
    })).rejects.toBeInstanceOf(CanvasProtocolError)

    const drift = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch: async () => json({
        sourceBranch: 'main',
        newBranch: 'other-branch',
        baseRevision: 1,
        canvas: envelope(2, null, 'other-branch'),
      }, 201),
    })
    await expect(drift.saveConflictBranch(scope, {
      sourceBranch: 'main',
      newBranch: 'conflicts/chart',
      baseRevision: 1,
      mutations: [{ mutationId: 'mutation-1', command: command('UpdateTaskGoal') }],
    })).rejects.toThrow('response is invalid')
  })

  it('reduces trusted commands to plan references and bounded user choices', () => {
    const trustedPlan = plan()
    expect(serializeCanvasCommand({
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })).toEqual({
      type: 'MaterializeProjectionPlan',
      planId: trustedPlan.planId,
    })
    const graphPlan = { planId: trustedPlan.planId } as TrustedGraphMaterializationPlanInput
    expect(serializeCanvasCommand({
      type: 'MaterializeGraphPlan',
      plan: graphPlan,
    })).toEqual({
      type: 'MaterializeGraphPlan',
      planId: trustedPlan.planId,
    })
    expect(serializeCanvasCommand({
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['proposal-1'],
    })).toEqual({
      type: 'AcceptTaskProposals',
      planId: trustedPlan.planId,
      proposalKeys: ['proposal-1'],
    })
    const edited = {
      type: 'AcceptTaskProposals' as const,
      plan: trustedPlan,
      proposalKeys: ['proposal-1'],
      edits: {
        'proposal-1': {
          title: 'Edited title',
          prompt: 'Edited prompt',
          dependsOn: [],
        },
      },
    }
    expect(serializeCanvasCommand(edited)).toEqual({
      type: 'AcceptTaskProposals',
      planId: trustedPlan.planId,
      proposalKeys: ['proposal-1'],
      edits: {
        'proposal-1': {
          title: 'Edited title',
          prompt: 'Edited prompt',
          dependsOn: [],
        },
      },
    })
    expect(serializeCanvasCommand({
      type: 'DismissPlan',
      plan: trustedPlan,
    })).toEqual({
      type: 'DismissPlan',
      planId: trustedPlan.planId,
    })
    expect(serializeCanvasCommand({
      type: 'DetachInstance',
      nodeId: 'instance-node',
    })).toEqual({
      type: 'DetachInstance',
      nodeId: 'instance-node',
    })
  })

  it('exposes a 409 currentRevision without hiding it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      error: {
        code: 'canvas_revision_conflict',
        message: 'stale base revision',
        currentRevision: 9,
      },
    }, 409))
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    await expect(client.executeCommand(scope, {
      branch: 'main',
      baseRevision: 4,
      initialBaseRevision: 4,
      mutationId: 'mutation-1',
      command: command('UpdateTaskGoal'),
      createdAt: 1,
    })).rejects.toMatchObject({
      status: 409,
      currentRevision: 9,
      code: 'canvas_revision_conflict',
    })
  })

  it('flushes strictly FIFO and acks only successful commands', async () => {
    const persistence = new CanvasPersistence<CanvasCommand>({
      adapter: new MemoryCanvasPersistenceAdapter(),
      now: (() => {
        let value = 1
        return () => value++
      })(),
    })
    await persistence.enqueue(persistenceScope, {
      baseRevision: 0,
      mutationId: 'mutation-a',
      command: command('UpdateTaskGoal', 'A'),
    })
    await persistence.enqueue(persistenceScope, {
      baseRevision: 1,
      mutationId: 'mutation-b',
      command: command('UpdateTaskGoal', 'B'),
    })
    const sent: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { mutationId: string; baseRevision: number }
      sent.push(body.mutationId)
      return json(envelope(body.baseRevision + 1, body.mutationId))
    })
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    expect(await client.flushOutbox(scope, persistence)).toMatchObject({
      status: 'flushed',
      acknowledged: 2,
      envelope: { revision: 2 },
    })
    expect(sent).toEqual(['mutation-a', 'mutation-b'])
    expect(await persistence.list(persistenceScope)).toEqual([])
  })

  it('refetches and rebases once after the first 409, then replays FIFO', async () => {
    const persistence = new CanvasPersistence<CanvasCommand>({
      adapter: new MemoryCanvasPersistenceAdapter(),
      now: () => 1,
    })
    await persistence.enqueue(persistenceScope, {
      baseRevision: 2,
      mutationId: 'mutation-rebase',
      command: command('UpdateTaskGoal'),
    })
    const requests: Array<{ method: string; baseRevision?: number }> = []
    let postCount = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET') {
        requests.push({ method })
        return json(envelope(7))
      }
      const body = JSON.parse(String(init?.body)) as { baseRevision: number }
      requests.push({ method, baseRevision: body.baseRevision })
      postCount += 1
      if (postCount === 1) return json({
        error: {
          code: 'canvas_revision_conflict',
          message: 'stale',
          currentRevision: 7,
        },
      }, 409)
      return json(envelope(8, 'mutation-rebase'))
    })
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    expect(await client.flushOutbox(scope, persistence)).toMatchObject({
      status: 'flushed',
      acknowledged: 1,
      envelope: { revision: 8 },
    })
    expect(requests).toEqual([
      { method: 'POST', baseRevision: 2 },
      { method: 'GET' },
      { method: 'POST', baseRevision: 7 },
    ])
  })

  it('returns an explicit conflict after a second 409 and keeps the command queued', async () => {
    const persistence = new CanvasPersistence<CanvasCommand>({
      adapter: new MemoryCanvasPersistenceAdapter(),
      now: () => 1,
    })
    await persistence.enqueue(persistenceScope, {
      baseRevision: 2,
      mutationId: 'mutation-conflict',
      command: command('UpdateTaskGoal'),
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.method === 'GET') return json(envelope(7))
      return json({
        error: {
          code: 'canvas_revision_conflict',
          message: 'still stale',
          currentRevision: 8,
        },
      }, 409)
    })
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    expect(await client.flushOutbox(scope, persistence)).toMatchObject({
      status: 'conflict',
      reason: 'revision',
      mutationId: 'mutation-conflict',
      currentRevision: 8,
    })
    expect((await persistence.list(persistenceScope)).map((entry) => entry.mutationId))
      .toEqual(['mutation-conflict'])
  })

  it('returns a precondition conflict without rebasing or swallowing other HTTP errors', async () => {
    const persistence = new CanvasPersistence<CanvasCommand>({
      adapter: new MemoryCanvasPersistenceAdapter(),
      now: () => 1,
    })
    await persistence.enqueue(persistenceScope, {
      baseRevision: 2,
      mutationId: 'mutation-precondition',
      command: command('UpdateTaskGoal'),
    })
    const preconditionFetch = vi.fn<typeof globalThis.fetch>(async () => json({
      error: {
        code: 'command_precondition_failed',
        message: 'task was deleted',
        currentRevision: 3,
      },
    }, 412))
    const client = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch: preconditionFetch,
    })

    expect(await client.flushOutbox(scope, persistence)).toMatchObject({
      status: 'conflict',
      reason: 'precondition',
      code: 'command_precondition_failed',
      currentRevision: 3,
    })
    expect(preconditionFetch).toHaveBeenCalledOnce()

    const failingClient = new CanvasDaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch: vi.fn<typeof globalThis.fetch>(async () => json({
        error: { code: 'internal_error', message: 'broken' },
      }, 500)),
    })
    await expect(failingClient.getCanvas(scope)).rejects.toBeInstanceOf(CanvasHttpError)
  })
})
