import { describe, expect, it, vi } from 'vitest'
import type { CanvasAgentEvent } from '../src/agent/types'
import { emptyCanvasDocument } from '../src/canvas/model'
import { CliCommandError } from './output'
import { executeHeadlessRun, type HeadlessRunDependencies } from './run'

describe('gg run vertical slice', () => {
  it('creates a Task, preflights, starts, waits, denies permission, and returns artifacts', async () => {
    const events: CanvasAgentEvent[] = []
    const { dependencies, calls } = fixtureDependencies(events)

    const result = await executeHeadlessRun({
      project: 'demo',
      prompt: 'Create a scatter plot',
      branch: 'main',
      agentId: 'codex',
      wait: true,
    }, dependencies)

    expect(calls.command).toMatchObject({
      command: {
        type: 'CreateTask',
        task: {
          id: 'task-id-1',
          title: 'Create a scatter plot',
          goal: 'Create a scatter plot',
          anchor: { x: 120, y: 120 },
        },
      },
    })
    expect(calls.preflight).toMatchObject({ taskId: 'task-id-1', baseRevision: 8 })
    expect(calls.capabilities).toEqual({ schemaVersion: 2, plugins: [] })
    expect(calls.intent).toMatchObject({
      runId: 'run-id-3',
      taskId: 'task-id-1',
      baseRevision: 8,
      materializationPolicy: 'auto',
    })
    expect(calls.permission).toMatchObject({ decision: 'deny' })
    expect(result).toMatchObject({
      project: { id: 'project_11111111111111111111111111111111', title: 'demo' },
      taskId: 'task-id-1',
      runId: 'run-id-3',
      status: 'done',
      artifacts: [{ artifactId: `artifact_${'a'.repeat(64)}`, relativePath: 'plot.png' }],
    })
    expect(events.map((event) => event.type)).toEqual(['permission-request'])
  })

  it('stops before capability registration when preflight blocks', async () => {
    const { dependencies, calls } = fixtureDependencies([])
    dependencies.preflight.check = vi.fn(async () => ({
      status: 'blocked' as const,
      issues: [{
        code: 'generation_service_unavailable' as const,
        message: 'Generation service unavailable',
        retryable: true,
      }],
    }))

    await expect(executeHeadlessRun({
      project: 'demo',
      prompt: 'Create a plot',
      branch: 'main',
      agentId: 'codex',
      wait: true,
    }, dependencies)).rejects.toMatchObject({
      code: 'preflight_blocked',
    } satisfies Partial<CliCommandError>)
    expect(calls.intent).toBeUndefined()
  })
})

function fixtureDependencies(events: CanvasAgentEvent[]) {
  let nextId = 0
  const calls: Record<string, unknown> = {}
  const dependencies: HeadlessRunDependencies = {
    projects: {
      list: vi.fn(async () => [project()]),
      open: vi.fn(async () => project()),
    },
    canvas: {
      getCanvas: vi.fn(async () => ({
        branch: 'main',
        revision: 7,
        updatedAt: '2026-08-17T00:00:00.000Z',
        lastMutationId: null,
        document: emptyCanvasDocument(),
      })),
      executeCommand: vi.fn(async (_scope, entry) => {
        calls.command = entry
        return {
          branch: 'main',
          revision: 8,
          updatedAt: '2026-08-17T00:00:01.000Z',
          lastMutationId: entry.mutationId,
          document: emptyCanvasDocument(),
        }
      }),
    },
    preflight: {
      check: vi.fn(async (input) => {
        calls.preflight = input
        return { status: 'ready', issues: [] }
      }),
    },
    runs: {
      registerPluginCapabilities: vi.fn(async (_projectDir, snapshot) => {
        calls.capabilities = snapshot
        return { schemaVersion: 3 as const, digest: 'b'.repeat(64), pluginCount: 6 }
      }),
      createTaskRun: vi.fn(async (intent) => {
        calls.intent = intent
        return { runId: intent.runId }
      }),
      attachRun: vi.fn(async (runId, options) => {
        const permission: CanvasAgentEvent = {
          type: 'permission-request',
          id: 'permission-1',
          action: 'write',
          detail: 'Write plot.png',
        }
        options.onEvent(permission)
        return {
          sessionId: null,
          stopReason: 'end_turn' as const,
          close: {
            runId,
            status: 'done' as const,
            sessionId: null,
            artifacts: ['plot.png'],
            artifactsComplete: true,
            artifactManifest: {
              version: 1 as const,
              runId,
              complete: true,
              entries: [{
                artifactId: `artifact_${'a'.repeat(64)}`,
                relativePath: 'plot.png',
                mediaType: 'image/png',
                size: 128,
                contentDigest: 'c'.repeat(64),
              }],
            },
          },
        }
      }),
      resolvePermission: vi.fn(async (_id, resolution) => {
        calls.permission = resolution
      }),
    },
    uuid: () => `id-${++nextId}`,
    now: () => 1_700_000_000_000,
    onEvent: (_runId, event) => events.push(event),
  }
  return { dependencies, calls }
}

function project() {
  return {
    id: 'project_11111111111111111111111111111111',
    title: 'demo',
    projectDir: '.gg/workspace/projects/project_11111111111111111111111111111111',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    lastOpenedAt: null,
    state: 'ready' as const,
    summary: { taskCount: 0, nodeCount: 0, collectionCount: 0 },
  }
}
