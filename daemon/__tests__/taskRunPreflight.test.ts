import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, CanvasNode } from '../../src/canvas/model.js'
import type { AgentDescriptor } from '../protocol.js'
import { createProjectionContributionSnapshot } from '../projectionContributions.js'
import type { SkillResolver } from '../skills/contracts.js'
import {
  parseTaskRunPreflightRequest,
  TaskRunPreflightService,
  type TaskRunPreflightDependencies,
  type TaskRunPreflightRequest,
} from '../taskRunPreflight.js'

const AGENT: AgentDescriptor = {
  id: 'codex',
  label: 'Codex',
  transport: 'codex',
  available: true,
  authStatus: 'authenticated',
  models: [],
}

const REQUEST: TaskRunPreflightRequest = {
  taskId: 'task-1',
  agentId: 'codex',
  canvasBranch: 'main',
  baseRevision: 4,
  attachments: [],
}

test('preflight parser reuses RunIntent identity and attachment validation', () => {
  assert.deepEqual(parseTaskRunPreflightRequest(REQUEST), REQUEST)
  assert.throws(() => parseTaskRunPreflightRequest({
    ...REQUEST,
    attachments: [
      { kind: 'node', nodeId: 'node-1' },
      { kind: 'node', nodeId: 'node-1' },
    ],
  }), /duplicates/u)
  assert.throws(() => parseTaskRunPreflightRequest({
    ...REQUEST,
    providerId: '@private/provider',
  }), /unsupported fields/u)
})

test('ready preflight has no side-effect token or runtime implementation details', async () => {
  const result = await service().inspect(REQUEST, '/project')
  assert.deepEqual(result, { status: 'ready', issues: [] })
  assert.deepEqual(Object.keys(result).sort(), ['issues', 'status'])
})

test('preflight reports stable UI issues for service, continuity, and canvas state', async () => {
  const unavailable = await service({ agents: [] }).inspect(REQUEST)
  assert.deepEqual(issueCodes(unavailable), ['generation_service_unavailable'])

  const unauthenticated = await service({
    agents: [{ ...AGENT, available: false, authStatus: 'unauthenticated' }],
  }).inspect(REQUEST)
  assert.deepEqual(issueCodes(unauthenticated), ['generation_service_unauthenticated'])

  const mismatch = await service({ sessionAgentId: 'other-agent' }).inspect(REQUEST)
  assert.deepEqual(issueCodes(mismatch), ['task_agent_mismatch'])

  const busy = await service({ availability: 'busy' }).inspect(REQUEST)
  assert.deepEqual(issueCodes(busy), ['canvas_revision_changed'])

  const changed = await service({ revision: REQUEST.baseRevision + 1 }).inspect(REQUEST)
  assert.deepEqual(issueCodes(changed), ['canvas_revision_changed'])

  const missingResolver = await service({ resolverMissing: true }).inspect(REQUEST)
  assert.deepEqual(issueCodes(missingResolver), ['skill_unavailable'])
})

test('preflight validates Node attachments and effective Skills against the exact revision', async () => {
  const missingAttachment = await service().inspect({
    ...REQUEST,
    attachments: [{ kind: 'node', nodeId: 'missing-node' }],
  })
  assert.deepEqual(issueCodes(missingAttachment), ['attachment_unavailable'])

  const digest = 'a'.repeat(64)
  const target: CanvasNode = {
    id: 'node-target',
    type: 'text',
    title: 'Target',
    frame: { x: 0, y: 0, w: 320, h: 240, z: 1 },
    artifactRefs: [],
    homeTaskId: REQUEST.taskId,
    origin: { kind: 'user' },
    skillBindings: {
      inheritType: false,
      skills: [{ skillId: '@workspace/missing', revision: 1, digest }],
    },
  }
  const unavailableSkill = await service({
    nodes: [target],
    resolveSkills: async () => { throw new Error('skill revision is unavailable') },
  }).inspect(REQUEST)
  assert.deepEqual(issueCodes(unavailableSkill), ['skill_unavailable'])
})

interface ServiceOverrides {
  agents?: AgentDescriptor[]
  availability?: 'ready' | 'busy' | 'capacity'
  revision?: number
  nodes?: CanvasNode[]
  sessionAgentId?: string
  resolveSkills?: SkillResolver['resolve']
  resolverMissing?: boolean
}

function service(overrides: ServiceOverrides = {}): TaskRunPreflightService {
  const document: CanvasDocument = {
    schemaVersion: 2,
    tasks: [{
      id: REQUEST.taskId,
      title: 'Task',
      goal: 'Generate',
      anchor: { x: 0, y: 0 },
      origin: { kind: 'user' },
    }],
    nodes: overrides.nodes ?? [],
    collections: [],
    edges: [],
    receipts: [],
    everCreated: true,
  }
  const dependencies = {
    registry: {
      probe: async () => structuredClone(overrides.agents ?? [AGENT]),
    },
    runs: {
      inspectTaskRunAvailability: async () => overrides.availability ?? 'ready',
      listTaskSessions: async () => overrides.sessionAgentId ? [{
        canvasBranch: REQUEST.canvasBranch,
        taskId: REQUEST.taskId,
        agentId: overrides.sessionAgentId,
        sessionId: 'session-1',
        createdAt: 1,
        lastActiveAt: 1,
      }] : [],
      lookupRunArtifact: async () => null,
    },
    versions: {
      getCanvas: async () => ({
        canvas: {
          branch: REQUEST.canvasBranch,
          revision: overrides.revision ?? REQUEST.baseRevision,
          updatedAt: '2026-08-15T00:00:00.000Z',
          lastMutationId: null,
          lastCheckpoint: null,
          document: structuredClone(document),
        },
      }),
    },
    skillAssets: {
      typeBindings: async () => new Map(),
    },
    skillResolver: () => {
      if (overrides.resolverMissing) throw new Error('resolver unavailable')
      return {
        resolver: {
          resolve: overrides.resolveSkills ?? (async () => ({
            assets: [],
            digest: 'a'.repeat(64),
          })),
        },
        provider: '@ggai/test-skill-resolver',
      }
    },
    projectionContributions: () => createProjectionContributionSnapshot([]),
  } as unknown as TaskRunPreflightDependencies
  return new TaskRunPreflightService(dependencies)
}

function issueCodes(result: Awaited<ReturnType<TaskRunPreflightService['inspect']>>): string[] {
  return result.issues.map((issue) => issue.code)
}
