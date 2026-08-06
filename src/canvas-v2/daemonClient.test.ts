import { describe, expect, it, vi } from 'vitest'
import type { CanvasCommandV2, TrustedProjectionPlanInputV2 } from './commands'
import {
  CanvasV2DaemonClient,
  CanvasV2HttpError,
  serializeCanvasCommandV2,
} from './daemonClient'
import { emptyCanvasDocumentV2 } from './model'
import {
  CanvasV2Persistence,
  MemoryCanvasV2PersistenceAdapter,
  type CanvasV2PersistenceScope,
} from './persistence'

const scope = { projectDir: '/workspace/project', branch: 'main' }
const persistenceScope: CanvasV2PersistenceScope = {
  daemonBaseUrl: 'http://127.0.0.1:7380',
  ...scope,
}

function envelope(revision: number, lastMutationId: string | null = null) {
  return {
    branch: 'main',
    revision,
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastMutationId,
    document: emptyCanvasDocumentV2(),
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function command(type: 'UpdateTaskGoal', goal = 'New goal'): CanvasCommandV2 {
  return { type, taskId: 'task-1', goal }
}

function plan(): TrustedProjectionPlanInputV2 {
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

describe('Canvas V2 daemon client', () => {
  it('reads the daemon V2 capability from health without a canvas scope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/health')
      expect(url.search).toBe('')
      expect(init?.method).toBe('GET')
      return json({
        capabilities: { canvasModelV1: false, canvasModelV2: true },
        canvas: { model: 'v2', schemaVersion: 2, resetRequired: false },
      })
    })
    const client = new CanvasV2DaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    await expect(client.getCapabilities()).resolves.toEqual({
      canvasModelV1: false,
      canvasModelV2: true,
      model: 'v2',
      schemaVersion: 2,
      resetRequired: false,
    })
  })

  it('rejects contradictory health model declarations instead of guessing', async () => {
    const client = new CanvasV2DaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch: async () => json({
        capabilities: { canvasModelV1: true, canvasModelV2: true },
        canvas: { model: 'v2', schemaVersion: 1, resetRequired: false },
      }),
    })

    await expect(client.getCapabilities()).rejects.toThrow(
      'Daemon canvas model capabilities are inconsistent',
    )
  })

  it('GETs and validates a branch V2 envelope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/canvas/v2')
      expect(url.searchParams.get('projectDir')).toBe(scope.projectDir)
      expect(url.searchParams.get('branch')).toBe('main')
      expect(init?.method).toBe('GET')
      return json(envelope(4))
    })
    const client = new CanvasV2DaemonClient({
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
    const client = new CanvasV2DaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    const result = await client.executeCommand(scope, {
      branch: 'main',
      baseRevision: 4,
      mutationId: 'mutation-1',
      command: command('UpdateTaskGoal'),
      createdAt: 1,
    })
    expect(result.revision).toBe(5)
  })

  it('reduces trusted commands to plan references and bounded user choices', () => {
    const trustedPlan = plan()
    expect(serializeCanvasCommandV2({
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })).toEqual({
      type: 'MaterializeProjectionPlan',
      planId: trustedPlan.planId,
    })
    expect(serializeCanvasCommandV2({
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
    expect(serializeCanvasCommandV2(edited)).toEqual({
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
    expect(serializeCanvasCommandV2({
      type: 'DismissPlan',
      plan: trustedPlan,
    })).toEqual({
      type: 'DismissPlan',
      planId: trustedPlan.planId,
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
    const client = new CanvasV2DaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch,
    })

    await expect(client.executeCommand(scope, {
      branch: 'main',
      baseRevision: 4,
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
    const persistence = new CanvasV2Persistence<CanvasCommandV2>({
      adapter: new MemoryCanvasV2PersistenceAdapter(),
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
    const client = new CanvasV2DaemonClient({
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
    const persistence = new CanvasV2Persistence<CanvasCommandV2>({
      adapter: new MemoryCanvasV2PersistenceAdapter(),
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
    const client = new CanvasV2DaemonClient({
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
    const persistence = new CanvasV2Persistence<CanvasCommandV2>({
      adapter: new MemoryCanvasV2PersistenceAdapter(),
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
    const client = new CanvasV2DaemonClient({
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
    const persistence = new CanvasV2Persistence<CanvasCommandV2>({
      adapter: new MemoryCanvasV2PersistenceAdapter(),
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
    const client = new CanvasV2DaemonClient({
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

    const failingClient = new CanvasV2DaemonClient({
      baseUrl: persistenceScope.daemonBaseUrl,
      fetch: vi.fn<typeof globalThis.fetch>(async () => json({
        error: { code: 'internal_error', message: 'broken' },
      }, 500)),
    })
    await expect(failingClient.getCanvas(scope)).rejects.toBeInstanceOf(CanvasV2HttpError)
  })
})
