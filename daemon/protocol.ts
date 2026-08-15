import type { CanvasAgentEvent } from '../src/agent/types.js'
import type { LegacyRunOutcome } from './legacyOutcome.js'
import type { SuggestedAction } from '../src/agent/suggestedActions.js'
import type { LegacyCanvasEdge, LegacyCanvasNode } from './legacyCanvasContext.js'
import type { ArtifactManifest } from './artifactManifest.js'
import type { ProjectionPlan } from './projectionPlan.js'

export type AgentTransportKind = 'acpx' | 'codex'

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

/** Serializable subset of NodePlugin. React components deliberately never cross the wire. */
export interface PluginContract {
  id: string
  label: string
  description: string
  instruction?: {
    placeholder: string
    actions: string[]
  }
  initialPayload?: Record<string, unknown>
}

export interface CanvasSnapshot {
  nodes: LegacyCanvasNode[]
  edges: LegacyCanvasEdge[]
  plugins?: PluginContract[]
}

export interface CreateRunRequest {
  /** Optional idempotency/cancellation handle allocated by the client. */
  runId?: string
  nodeId: string
  agentId: string
  prompt: string
  /** Relative paths are resolved underneath the daemon's configured project root. */
  projectDir?: string
  /** Logical canvas branch used by later source-worktree binding. */
  canvasBranch?: string
  /** Project default can be overridden per run without changing legacy callers. */
  automationMode?: 'auto' | 'confirm'
  /** Optional browser hint. The daemon's persisted mapping remains authoritative. */
  sessionId?: string | null
  canvasSnapshot: CanvasSnapshot
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
  /** Compatibility target identity; current Task runs mirror taskId here. */
  nodeId: string
  agentId: string
  /** Logical canvas branch that owned the run; absent only on legacy summaries. */
  canvasBranch?: string
  /** Content-addressed artifact projection registry fixed when this run was accepted. */
  pluginCapabilityDigest?: string
  /** Exact Node-bound skill set and authority sources fixed at Run acceptance. */
  skillCapabilityDigest?: string
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

export interface RunClosePayload {
  runId: string
  status: Extract<DaemonRunStatus, 'done' | 'error' | 'cancelled' | 'interrupted'>
  sessionId: string | null
  /** Complete terminal snapshot, relative to projectDir. */
  artifacts: string[]
  artifactsComplete: boolean
  /** Present only for Task-owned runs after durable artifact close. */
  artifactManifest?: ArtifactManifest
  /** Optional, bounded semantic result authored by the Agent for a successful run. */
  outcome?: LegacyRunOutcome
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

function parsePlugins(value: unknown): PluginContract[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ProtocolError('canvasSnapshot.plugins must be an array')
  if (value.length > 500) throw new ProtocolError('canvasSnapshot.plugins has too many entries')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new ProtocolError(`plugins[${index}] must be an object`)
    const contract: PluginContract = {
      id: validIdentifier(entry.id, `plugins[${index}].id`, true),
      label: requiredString(entry.label, `plugins[${index}].label`, { max: 120 }),
      description: requiredString(entry.description, `plugins[${index}].description`, {
        max: 1_000,
        allowEmpty: true,
      }),
    }
    if (entry.initialPayload !== undefined) {
      if (!isRecord(entry.initialPayload)) {
        throw new ProtocolError(`plugins[${index}].initialPayload must be an object`)
      }
      contract.initialPayload = entry.initialPayload
    }
    if (entry.instruction !== undefined) {
      if (!isRecord(entry.instruction) || !Array.isArray(entry.instruction.actions)) {
        throw new ProtocolError(`plugins[${index}].instruction is invalid`)
      }
      if (entry.instruction.actions.length > 100) {
        throw new ProtocolError(`plugins[${index}].instruction has too many actions`)
      }
      contract.instruction = {
        placeholder: requiredString(
          entry.instruction.placeholder,
          `plugins[${index}].instruction.placeholder`,
          { max: 500, allowEmpty: true },
        ),
        actions: entry.instruction.actions.map((action, actionIndex) =>
          requiredString(action, `plugins[${index}].instruction.actions[${actionIndex}]`, {
            max: 200,
          })),
      }
    }
    return contract
  })
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

/** Runtime validation at the localhost trust boundary. */
export function parseCreateRunRequest(value: unknown): CreateRunRequest {
  if (!isRecord(value)) throw new ProtocolError('request body must be a JSON object')
  if (!isRecord(value.canvasSnapshot)) {
    throw new ProtocolError('canvasSnapshot must be an object')
  }
  const { canvasSnapshot } = value
  if (!Array.isArray(canvasSnapshot.nodes) || !Array.isArray(canvasSnapshot.edges)) {
    throw new ProtocolError('canvasSnapshot.nodes and canvasSnapshot.edges must be arrays')
  }
  if (canvasSnapshot.nodes.length > 10_000 || canvasSnapshot.edges.length > 50_000) {
    throw new ProtocolError('canvasSnapshot exceeds the supported graph size')
  }

  const nodeId = validIdentifier(value.nodeId, 'nodeId')
  const nodeIds = new Set<string>()
  for (const [index, node] of canvasSnapshot.nodes.entries()) {
    if (!isRecord(node)) throw new ProtocolError(`nodes[${index}] must be an object`)
    const currentId = validIdentifier(node.id, `nodes[${index}].id`)
    if (nodeIds.has(currentId)) throw new ProtocolError(`duplicate node id: ${currentId}`)
    nodeIds.add(currentId)
    validIdentifier(node.type, `nodes[${index}].type`, true)
    requiredString(node.title, `nodes[${index}].title`, { max: 1_000, allowEmpty: true })
    if (node.text !== undefined && typeof node.text !== 'string') {
      throw new ProtocolError(`nodes[${index}].text must be a string`)
    }
    if (node.meta !== undefined && (
      !Array.isArray(node.meta)
      || node.meta.length > 1_000
      || !node.meta.every((entry) => typeof entry === 'string' && entry.length <= 10_000)
    )) {
      throw new ProtocolError(`nodes[${index}].meta must be a string array`)
    }
    if (node.payload !== undefined && !isRecord(node.payload)) {
      throw new ProtocolError(`nodes[${index}].payload must be an object`)
    }
    if (node.instruction !== undefined) {
      if (!isRecord(node.instruction)) {
        throw new ProtocolError(`nodes[${index}].instruction must be an object`)
      }
      const attachments = node.instruction.attachments
      if (attachments !== undefined && (
        !Array.isArray(attachments)
        || attachments.length > 100
        || !attachments.every((entry) =>
          typeof entry === 'string' && entry.length > 0 && entry.length <= 4_096)
      )) {
        throw new ProtocolError(`nodes[${index}].instruction.attachments is invalid`)
      }
    }
  }
  for (const [index, edge] of canvasSnapshot.edges.entries()) {
    if (!isRecord(edge)) throw new ProtocolError(`edges[${index}] must be an object`)
    const from = validIdentifier(edge.from, `edges[${index}].from`)
    const to = validIdentifier(edge.to, `edges[${index}].to`)
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      throw new ProtocolError(`edges[${index}] references a missing node`)
    }
    requiredString(edge.label, `edges[${index}].label`, { max: 500, allowEmpty: true })
  }
  const nodes = canvasSnapshot.nodes as LegacyCanvasNode[]
  if (!nodeIds.has(nodeId)) {
    throw new ProtocolError('target node is missing from canvasSnapshot.nodes')
  }

  const request: CreateRunRequest = {
    nodeId,
    agentId: validIdentifier(value.agentId, 'agentId'),
    prompt: requiredString(value.prompt, 'prompt', { max: 250_000, allowEmpty: true }),
    canvasSnapshot: {
      nodes,
      edges: canvasSnapshot.edges as LegacyCanvasEdge[],
      plugins: parsePlugins(canvasSnapshot.plugins),
    },
  }
  if (value.runId !== undefined) {
    request.runId = validIdentifier(value.runId, 'runId')
  }
  if (value.projectDir !== undefined) {
    request.projectDir = requiredString(value.projectDir, 'projectDir', { max: 4_096 })
  }
  if (value.canvasBranch !== undefined) {
    request.canvasBranch = parseCanvasBranch(value.canvasBranch)
  }
  if (value.automationMode !== undefined) {
    if (value.automationMode !== 'auto' && value.automationMode !== 'confirm') {
      throw new ProtocolError('automationMode must be "auto" or "confirm"')
    }
    request.automationMode = value.automationMode
  }
  if (value.sessionId !== undefined && value.sessionId !== null) {
    const sessionId = requiredString(value.sessionId, 'sessionId', { max: 512 })
    if (sessionId.startsWith('-') || hasControlCharacters(sessionId)) {
      throw new ProtocolError('sessionId contains unsupported characters')
    }
    request.sessionId = sessionId
  } else if (value.sessionId === null) {
    request.sessionId = null
  }
  return request
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

export function parsePermissionDecision(value: unknown): PermissionDecision {
  if (!isRecord(value) || (value.decision !== 'allow' && value.decision !== 'deny')) {
    throw new ProtocolError('decision must be "allow" or "deny"')
  }
  return { decision: value.decision }
}
