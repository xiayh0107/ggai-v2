import type { CanvasAgentEvent } from '../src/agent/types.js'
import type { SuggestedAction } from '../src/agent/suggestedActions.js'
import type { ArtifactManifest } from './artifactManifest.js'
import type { ProjectionPlan } from './projectionPlan.js'

/** Stable provider-defined identifier; concrete transports are not a core protocol enum. */
export type AgentTransportKind = string

export interface AgentDescriptor {
  id: string
  label: string
  transport: AgentTransportKind
  available: boolean
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown' | 'not-applicable'
  version?: string
  /** Resolved executable used by the daemon, when it can be determined from PATH. */
  binaryPath?: string
  detail?: string
  models: string[]
}

export interface CreateRunResponse {
  runId: string
}

export type DaemonRunStatus =
  | 'preparing'
  | 'running'
  | 'awaiting-permission'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface RunSummary {
  runId: string
  /** Task ownership is authoritative for Canvas runs. */
  taskId?: string
  /** Persisted context revision accepted for this Task-owned run. */
  baseRevision?: number
  /** Exact prompt accepted for this Task-owned run. */
  prompt?: string
  /** Target identity; Task runs mirror taskId and Node Studio uses its design node. */
  nodeId: string
  agentId: string
  /** Logical canvas branch that owned the run. */
  canvasBranch: string
  /** Content-addressed artifact projection registry fixed when this run was accepted. */
  pluginCapabilityDigest?: string
  /** Exact Node-bound skill set and authority sources fixed at Run acceptance. */
  skillCapabilityDigest?: string
  /** Digest of the immutable Run Capability Receipt pinned before transport start. */
  capabilityReceiptDigest?: string
  /** Friendly historical labels/counts captured at acceptance; contains no raw capability data. */
  reproducibilitySnapshot?: RunReproducibilitySnapshot
  /** Internal product surface that owns a non-Canvas Run. */
  runKind?: 'node-studio'
  /** Optimistic concurrency base pinned when a Node Studio Run starts. */
  baseDefinitionId?: string
  baseDefinitionRevision?: number
  status: DaemonRunStatus
  startedAt: number
  finishedAt?: number
  sessionId: string | null
  error?: string
  logAvailable?: boolean
}

export interface RunReproducibilitySnapshot {
  generationService: string
  skillCount: number
  attachmentCount: number
  capabilityProfileLabel: string
}

export interface RunClosePayload {
  runId: string
  status: Extract<DaemonRunStatus, 'done' | 'error' | 'cancelled' | 'interrupted'>
  sessionId: string | null
  /** Complete terminal snapshot, relative to projectDir. */
  artifacts: string[]
  artifactsComplete: boolean
  /** Present only for Task-owned runs after durable artifact close. */
  artifactManifest?: ArtifactManifest
  /** Daemon-authored and durably pending plan for a Task-owned run. */
  projectionPlan?: ProjectionPlan
  /** Trusted successful-run actions persisted beside projectionPlan; partial plans use []. */
  suggestedActions?: SuggestedAction[]
}

export type RunStreamMessage =
  | { event: 'agent-event'; data: CanvasAgentEvent }
  | { event: 'session'; data: { sessionId: string } }
  | { event: 'close'; data: RunClosePayload }

export interface PermissionDecision {
  decision: 'allow' | 'deny'
}

export class ProtocolError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code = 'invalid_request', status = 400) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.status = status
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(
  value: unknown,
  name: string,
  options: { max: number; allowEmpty?: boolean },
): string {
  if (typeof value !== 'string') throw new ProtocolError(`${name} must be a string`)
  if (!options.allowEmpty && value.trim().length === 0) {
    throw new ProtocolError(`${name} must not be empty`)
  }
  if (value.length > options.max) throw new ProtocolError(`${name} is too long`)
  return value
}

function validIdentifier(value: unknown, name: string, allowNamespaceSlash = false): string {
  const id = requiredString(value, name, { max: 160 })
  const pattern = allowNamespaceSlash
    ? /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/
    : /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
  if (!pattern.test(id) || id.includes('..') || id.includes('//')) {
    throw new ProtocolError(`${name} contains unsupported characters`)
  }
  return id
}

export function parseRunId(value: unknown): string {
  return validIdentifier(value, 'runId')
}

export function parseNodeId(value: unknown): string {
  return validIdentifier(value, 'nodeId')
}

export const MAX_CANVAS_BRANCH_LENGTH = 120

/** Validates a branch label before it is used as a logical canvas key. */
export function parseCanvasBranch(value: unknown): string {
  const branch = requiredString(value, 'branch', { max: MAX_CANVAS_BRANCH_LENGTH })
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch)
    || branch.includes('..')
    || branch.includes('//')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.endsWith('.lock')
    || branch.split('/').some((part) => part === '.' || part.endsWith('.'))
  ) {
    throw new ProtocolError('branch contains unsupported characters')
  }
  return branch
}

export function parsePermissionDecision(value: unknown): PermissionDecision {
  if (!isRecord(value) || (value.decision !== 'allow' && value.decision !== 'deny')) {
    throw new ProtocolError('decision must be "allow" or "deny"')
  }
  return { decision: value.decision }
}
