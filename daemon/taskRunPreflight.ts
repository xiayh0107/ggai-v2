import type { AgentDescriptor } from './protocol.js'
import {
  BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
} from './pluginCapabilities.js'
import type { AgentRegistry } from './registry.js'
import type {
  RunManager,
} from './runs.js'
import {
  resolveRunIntentAttachments,
  resolveRunIntentSkills,
} from './serverLegacy.js'
import type { SkillAssetCatalog } from './skillAssets.js'
import {
  parseRunIntent,
  TaskRunProtocolError,
  type AttachmentRef,
  type RunIntent,
} from './taskRunProtocol.js'
import type { WorkspaceVersionManager } from './workspaceVersioning.js'

export type TaskRunPreflightIssueCode =
  | 'generation_service_unavailable'
  | 'generation_service_unauthenticated'
  | 'task_agent_mismatch'
  | 'attachment_unavailable'
  | 'skill_unavailable'
  | 'canvas_revision_changed'

export interface TaskRunPreflightIssue {
  code: TaskRunPreflightIssueCode
  message: string
  retryable: boolean
}

export interface TaskRunPreflightRequest {
  taskId: string
  agentId: string
  canvasBranch: string
  baseRevision: number
  attachments: AttachmentRef[]
}

export type TaskRunPreflightReport =
  | { status: 'ready'; issues: [] }
  | { status: 'blocked'; issues: TaskRunPreflightIssue[] }

export interface TaskRunPreflightDependencies {
  registry: Pick<AgentRegistry, 'probe'>
  runs: Pick<
    RunManager,
    'inspectTaskRunAvailability' | 'listTaskSessions' | 'lookupRunArtifact'
  >
  versions: Pick<WorkspaceVersionManager, 'getCanvas'>
  skillAssets: Pick<SkillAssetCatalog, 'typeBindings' | 'resolve'>
}

const ISSUE_COPY: Record<TaskRunPreflightIssueCode, {
  message: string
  retryable: boolean
}> = {
  generation_service_unavailable: {
    message: '当前生成服务不可用，请检查本地运行环境后重试。',
    retryable: true,
  },
  generation_service_unauthenticated: {
    message: '生成服务尚未登录，请完成登录后重试。',
    retryable: true,
  },
  task_agent_mismatch: {
    message: '该任务已绑定另一生成服务；请使用原服务继续，或新建任务。',
    retryable: false,
  },
  attachment_unavailable: {
    message: '一个或多个附件不可用或未通过完整性校验，请重新选择。',
    retryable: false,
  },
  skill_unavailable: {
    message: '节点所需 Skills 不可用或版本冲突，请检查后重试。',
    retryable: false,
  },
  canvas_revision_changed: {
    message: '画布状态已经变化或正在处理其他操作，请刷新后重试。',
    retryable: true,
  },
}

/**
 * Parses the UI-facing preflight shape through the real RunIntent parser so
 * identity, revision, attachment count, and duplicate rules cannot drift.
 */
export function parseTaskRunPreflightRequest(value: unknown): TaskRunPreflightRequest {
  if (!isExactRecord(value, [
    'taskId',
    'agentId',
    'canvasBranch',
    'baseRevision',
    'attachments',
  ])) {
    throw new TaskRunProtocolError('Task Run preflight request has unsupported fields')
  }
  const intent = parseRunIntent({
    schemaVersion: 2,
    runId: 'preflight',
    ...value,
    prompt: '',
    materializationPolicy: 'auto',
  })
  return requestFromIntent(intent)
}

/**
 * Read-only early feedback. Every check is repeated by the authoritative Run
 * creation path after its acceptance reservation; this report is never a
 * permission ticket and carries no provider, service, or digest identity.
 */
export class TaskRunPreflightService {
  readonly #registry: TaskRunPreflightDependencies['registry']
  readonly #runs: TaskRunPreflightDependencies['runs']
  readonly #versions: TaskRunPreflightDependencies['versions']
  readonly #skillAssets: TaskRunPreflightDependencies['skillAssets']

  constructor(dependencies: TaskRunPreflightDependencies) {
    this.#registry = dependencies.registry
    this.#runs = dependencies.runs
    this.#versions = dependencies.versions
    this.#skillAssets = dependencies.skillAssets
  }

  async inspect(
    request: TaskRunPreflightRequest,
    projectDir = '.',
  ): Promise<TaskRunPreflightReport> {
    const issues: TaskRunPreflightIssue[] = []
    const addIssue = (code: TaskRunPreflightIssueCode) => {
      if (issues.some((issue) => issue.code === code)) return
      issues.push({ code, ...ISSUE_COPY[code] })
    }

    const [agentsResult, canvasResult] = await Promise.allSettled([
      this.#registry.probe(),
      this.#versions.getCanvas(projectDir, request.canvasBranch),
    ])
    if (agentsResult.status === 'rejected') {
      addIssue('generation_service_unavailable')
    } else {
      inspectAgent(agentsResult.value, request.agentId, addIssue)
    }
    if (canvasResult.status === 'rejected') {
      addIssue('canvas_revision_changed')
      return report(issues)
    }

    const envelope = canvasResult.value.canvas
    if (envelope.revision !== request.baseRevision
      || !envelope.document.tasks.some((task) => task.id === request.taskId)) {
      addIssue('canvas_revision_changed')
      return report(issues)
    }

    const intent = intentFromRequest(request)
    const [availability, sessions] = await Promise.allSettled([
      this.#runs.inspectTaskRunAvailability(
        projectDir,
        request.canvasBranch,
        request.taskId,
      ),
      this.#runs.listTaskSessions(projectDir, {
        canvasBranch: request.canvasBranch,
        taskId: request.taskId,
      }),
    ])
    if (availability.status === 'rejected' || availability.value !== 'ready') {
      addIssue(availability.status === 'fulfilled' && availability.value === 'capacity'
        ? 'generation_service_unavailable'
        : 'canvas_revision_changed')
    }
    if (sessions.status === 'rejected') {
      addIssue('task_agent_mismatch')
    } else if (sessions.value.some((session) => session.agentId !== request.agentId)) {
      addIssue('task_agent_mismatch')
    }

    // The v2 built-in snapshot is already canonical and content-addressed.
    // Browser/runtime provenance is deliberately deferred to snapshot v3.
    const pluginCapabilities = BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT
    try {
      await resolveRunIntentAttachments(
        intent,
        envelope.document,
        this.#runs,
        projectDir,
        pluginCapabilities,
      )
    } catch {
      addIssue('attachment_unavailable')
      return report(issues)
    }
    try {
      await resolveRunIntentSkills(intent, envelope.document, this.#skillAssets)
    } catch {
      addIssue('skill_unavailable')
    }
    return report(issues)
  }
}

function inspectAgent(
  descriptors: readonly AgentDescriptor[],
  agentId: string,
  addIssue: (code: TaskRunPreflightIssueCode) => void,
): void {
  const descriptor = descriptors.find((candidate) => candidate.id === agentId)
  if (descriptor?.authStatus === 'unauthenticated') {
    addIssue('generation_service_unauthenticated')
    return
  }
  if (!descriptor?.available) addIssue('generation_service_unavailable')
}

function report(issues: TaskRunPreflightIssue[]): TaskRunPreflightReport {
  return issues.length === 0
    ? { status: 'ready', issues: [] }
    : { status: 'blocked', issues }
}

function requestFromIntent(intent: RunIntent): TaskRunPreflightRequest {
  return {
    taskId: intent.taskId,
    agentId: intent.agentId,
    canvasBranch: intent.canvasBranch,
    baseRevision: intent.baseRevision,
    attachments: intent.attachments,
  }
}

function intentFromRequest(request: TaskRunPreflightRequest): RunIntent {
  return {
    schemaVersion: 2,
    runId: 'preflight',
    ...structuredClone(request),
    prompt: '',
    materializationPolicy: 'auto',
  }
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
