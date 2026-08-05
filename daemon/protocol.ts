import type { CanvasAgentEvent } from '../src/agent/types.js'
import {
  inspectRunOutcome,
  type RunOutcome,
  type SuggestedAction,
} from '../src/agent/outcome.js'
import type { CanvasNode, Edge } from '../src/types/canvas.js'
import type { ArtifactManifestV1 } from './artifactManifestV2.js'
import type { ProjectionPlanV2 } from './projectionPlanV2.js'

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
  nodes: CanvasNode[]
  edges: Edge[]
  plugins?: PluginContract[]
}

export interface CanvasDocumentV1 {
  schemaVersion: 1
  nodes: CanvasNode[]
  edges: Edge[]
  everCreated: boolean
  /** Transitional persisted UI log until durable run logs become authoritative. */
  generationByNodeId: Record<string, PersistedGenerationPanelState>
  /** Stable migration hook for durable run summaries/logs. */
  latestRunByNodeId: Record<string, string>
  /** Cursor used to reconnect a browser to a durable daemon run after refresh. */
  runRefsByNodeId: Record<string, PersistedRunRef>
}

export interface PersistedRunRef {
  runId: string
  lastEventId: number
  previousPhase: 'idle' | 'done'
}

export type PersistedGenerationActivityKind =
  | 'connecting'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'artifact'
  | 'finishing'
  | 'warning'

export interface PersistedGenerationActivity {
  key: string
  kind: PersistedGenerationActivityKind
  label: string
}

export interface PersistedGenerationPanelState {
  epoch: number
  current: PersistedGenerationActivity
  recent: PersistedGenerationActivity[]
  log: Array<{
    kind: 'thinking' | 'output' | 'tool' | 'artifact' | 'warning' | 'info'
    text: string
  }>
}

export interface CanvasEnvelope {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  lastCheckpoint: string | null
  document: CanvasDocumentV1
}

export interface PutCanvasRequest {
  baseRevision: number
  mutationId: string
  changeKind: string
  document: CanvasDocumentV1
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
  /** Task ownership is authoritative for Canvas V2 runs. */
  taskId?: string
  /** Legacy target identity; V2 mirrors taskId here for transport compatibility. */
  nodeId: string
  agentId: string
  /** Logical canvas branch that owned the run; absent only on legacy summaries. */
  canvasBranch?: string
  status: DaemonRunStatus
  startedAt: number
  finishedAt?: number
  sessionId: string | null
  error?: string
  logAvailable?: boolean
}

export interface RunClosePayload {
  runId: string
  status: Extract<DaemonRunStatus, 'done' | 'error' | 'cancelled'>
  sessionId: string | null
  /** Complete terminal snapshot, relative to projectDir. */
  artifacts: string[]
  artifactsComplete: boolean
  /** Present only for Task-owned V2 runs after durable artifact close. */
  artifactManifest?: ArtifactManifestV1
  /** Optional, bounded semantic result authored by the Agent for a successful run. */
  outcome?: RunOutcome
  /** Daemon-authored and durably pending plan for a Task-owned V2 run. */
  projectionPlan?: ProjectionPlanV2
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

const GENERATION_ACTIVITY_KINDS = new Set([
  'connecting',
  'thinking',
  'writing',
  'tool',
  'artifact',
  'finishing',
  'warning',
])
const GENERATION_LOG_KINDS = new Set([
  'thinking',
  'output',
  'tool',
  'artifact',
  'warning',
  'info',
])

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

/** Runtime validation for the durable semantic canvas document. */
export function parseCanvasDocument(value: unknown): CanvasDocumentV1 {
  if (!isRecord(value)) throw new ProtocolError('document must be an object')
  if (value.schemaVersion !== 1) {
    throw new ProtocolError('document.schemaVersion must be 1', 'unsupported_canvas_schema')
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new ProtocolError('document.nodes and document.edges must be arrays')
  }
  if (value.nodes.length > 10_000 || value.edges.length > 50_000) {
    throw new ProtocolError('document exceeds the supported graph size')
  }
  if (typeof value.everCreated !== 'boolean') {
    throw new ProtocolError('document.everCreated must be a boolean')
  }

  const nodeIds = new Set<string>()
  for (const [index, node] of value.nodes.entries()) {
    validateCanvasNode(node, index, nodeIds)
  }
  const edgeIds = new Set<string>()
  for (const [index, edge] of value.edges.entries()) {
    validateCanvasEdge(edge, index, nodeIds, edgeIds)
  }

  const generationByNodeId = parseGenerationPanels(
    value.generationByNodeId ?? {},
    nodeIds,
  )
  const latestRunByNodeId = parseLatestRuns(value.latestRunByNodeId ?? {}, nodeIds)
  const runRefsByNodeId = parseRunRefs(value.runRefsByNodeId ?? {}, nodeIds)
  return {
    schemaVersion: 1,
    nodes: structuredClone(value.nodes) as CanvasNode[],
    edges: structuredClone(value.edges) as Edge[],
    everCreated: value.everCreated,
    generationByNodeId,
    latestRunByNodeId,
    runRefsByNodeId,
  }
}

export function parsePutCanvasRequest(value: unknown): PutCanvasRequest {
  if (!isRecord(value)) throw new ProtocolError('request body must be a JSON object')
  if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) {
    throw new ProtocolError('baseRevision must be a non-negative safe integer')
  }
  const mutationId = validIdentifier(value.mutationId, 'mutationId')
  const changeKind = requiredString(value.changeKind, 'changeKind', { max: 64 })
  if (!/^[a-z][a-z0-9-]*$/u.test(changeKind)) {
    throw new ProtocolError('changeKind contains unsupported characters')
  }
  return {
    baseRevision: value.baseRevision as number,
    mutationId,
    changeKind,
    document: parseCanvasDocument(value.document),
  }
}

function validateCanvasNode(
  value: unknown,
  index: number,
  nodeIds: Set<string>,
): void {
  const label = `nodes[${index}]`
  if (!isRecord(value)) throw new ProtocolError(`${label} must be an object`)
  const id = validIdentifier(value.id, `${label}.id`)
  if (nodeIds.has(id)) throw new ProtocolError(`duplicate node id: ${id}`)
  nodeIds.add(id)
  validIdentifier(value.type, `${label}.type`, true)
  finiteNumber(value.x, `${label}.x`)
  finiteNumber(value.y, `${label}.y`)
  positiveFiniteNumber(value.w, `${label}.w`)
  positiveFiniteNumber(value.h, `${label}.h`)
  requiredString(value.title, `${label}.title`, { max: 1_000, allowEmpty: true })

  if (value.text !== undefined) {
    requiredString(value.text, `${label}.text`, { max: 1_000_000, allowEmpty: true })
  }
  if (value.meta !== undefined && (
    !Array.isArray(value.meta)
    || value.meta.length > 1_000
    || !value.meta.every((entry) => typeof entry === 'string' && entry.length <= 10_000)
  )) {
    throw new ProtocolError(`${label}.meta must be a string array`)
  }
  for (const property of ['bold', 'italic'] as const) {
    if (value[property] !== undefined && typeof value[property] !== 'boolean') {
      throw new ProtocolError(`${label}.${property} must be a boolean`)
    }
  }
  if (
    value.heading !== undefined
    && value.heading !== 0
    && value.heading !== 1
    && value.heading !== 2
  ) {
    throw new ProtocolError(`${label}.heading must be 0, 1, or 2`)
  }
  validateInstruction(value.instruction, label)
  if (value.smart !== undefined) validateSmart(value.smart, label)
  if (value.payload !== undefined) {
    if (!isRecord(value.payload)) throw new ProtocolError(`${label}.payload must be an object`)
    assertJsonValue(value.payload, `${label}.payload`, 0, new WeakSet())
  }
}

function validateInstruction(value: unknown, nodeLabel: string): void {
  const label = `${nodeLabel}.instruction`
  if (!isRecord(value)) throw new ProtocolError(`${label} must be an object`)
  if (value.phase !== 'idle' && value.phase !== 'generating' && value.phase !== 'done') {
    throw new ProtocolError(`${label}.phase is invalid`)
  }
  requiredString(value.prompt, `${label}.prompt`, { max: 250_000, allowEmpty: true })
  if (
    !Array.isArray(value.attachments)
    || value.attachments.length > 100
    || !value.attachments.every((entry) =>
      typeof entry === 'string' && entry.length > 0 && entry.length <= 4_096)
  ) {
    throw new ProtocolError(`${label}.attachments is invalid`)
  }
  if (
    !Array.isArray(value.sources)
    || value.sources.length > 10_000
    || !value.sources.every((entry) => {
      try {
        validIdentifier(entry, `${label}.sources[]`)
        return true
      } catch {
        return false
      }
    })
  ) {
    throw new ProtocolError(`${label}.sources is invalid`)
  }
  if (value.suggestedActions !== undefined) {
    if (!isRecord(value.suggestedActions)
      || Object.keys(value.suggestedActions).length !== 2) {
      throw new ProtocolError(`${label}.suggestedActions is invalid`)
    }
    validIdentifier(value.suggestedActions.runId, `${label}.suggestedActions.runId`)
    const inspection = inspectRunOutcome({
      schemaVersion: 1,
      suggestedActions: value.suggestedActions.actions,
    })
    if (inspection.status !== 'valid') {
      throw new ProtocolError(`${label}.suggestedActions is invalid`)
    }
  }
  if (typeof value.open !== 'boolean') {
    throw new ProtocolError(`${label}.open must be a boolean`)
  }
}

function validateSmart(value: unknown, nodeLabel: string): void {
  const label = `${nodeLabel}.smart`
  if (!isRecord(value)) throw new ProtocolError(`${label} must be an object`)
  if (!['柱状图', '折线图', '面积图'].includes(value.chartType as string)) {
    throw new ProtocolError(`${label}.chartType is invalid`)
  }
  if (!['简洁', '学术', '信息图'].includes(value.style as string)) {
    throw new ProtocolError(`${label}.style is invalid`)
  }
  finiteNumber(value.count, `${label}.count`)
  finiteNumber(value.seed, `${label}.seed`)
}

function validateCanvasEdge(
  value: unknown,
  index: number,
  nodeIds: ReadonlySet<string>,
  edgeIds: Set<string>,
): void {
  const label = `edges[${index}]`
  if (!isRecord(value)) throw new ProtocolError(`${label} must be an object`)
  const id = validIdentifier(value.id, `${label}.id`)
  if (edgeIds.has(id)) throw new ProtocolError(`duplicate edge id: ${id}`)
  edgeIds.add(id)
  const from = validIdentifier(value.from, `${label}.from`)
  const to = validIdentifier(value.to, `${label}.to`)
  if (!nodeIds.has(from) || !nodeIds.has(to)) {
    throw new ProtocolError(`${label} references a missing node`)
  }
  requiredString(value.label, `${label}.label`, { max: 500, allowEmpty: true })
}

function parseGenerationPanels(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): Record<string, PersistedGenerationPanelState> {
  if (!isRecord(value)) {
    throw new ProtocolError('document.generationByNodeId must be an object')
  }
  if (Object.keys(value).length > nodeIds.size) {
    throw new ProtocolError('document.generationByNodeId has too many entries')
  }
  const panels: Record<string, PersistedGenerationPanelState> = Object.create(null) as Record<
    string,
    PersistedGenerationPanelState
  >
  for (const [nodeId, panel] of Object.entries(value)) {
    validIdentifier(nodeId, 'generationByNodeId node id')
    if (!nodeIds.has(nodeId)) {
      throw new ProtocolError(`generationByNodeId references a missing node: ${nodeId}`)
    }
    if (!isRecord(panel)) {
      throw new ProtocolError(`generationByNodeId.${nodeId} must be an object`)
    }
    if (!Number.isSafeInteger(panel.epoch) || (panel.epoch as number) < 0) {
      throw new ProtocolError(`generationByNodeId.${nodeId}.epoch is invalid`)
    }
    const current = parseGenerationActivity(panel.current, `${nodeId}.current`)
    if (!Array.isArray(panel.recent) || panel.recent.length > 3) {
      throw new ProtocolError(`generationByNodeId.${nodeId}.recent is invalid`)
    }
    const recent = panel.recent.map((activity, index) =>
      parseGenerationActivity(activity, `${nodeId}.recent[${index}]`))
    if (!Array.isArray(panel.log) || panel.log.length > 200) {
      throw new ProtocolError(`generationByNodeId.${nodeId}.log is invalid`)
    }
    const log = panel.log.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.kind !== 'string'
        || !GENERATION_LOG_KINDS.has(entry.kind)) {
        throw new ProtocolError(`generationByNodeId.${nodeId}.log[${index}] is invalid`)
      }
      return {
        kind: entry.kind as PersistedGenerationPanelState['log'][number]['kind'],
        text: requiredString(entry.text, `generationByNodeId.${nodeId}.log[${index}].text`, {
          max: 400,
          allowEmpty: true,
        }),
      }
    })
    panels[nodeId] = {
      epoch: panel.epoch as number,
      current,
      recent,
      log,
    }
  }
  return panels
}

function parseGenerationActivity(
  value: unknown,
  label: string,
): PersistedGenerationPanelState['current'] {
  if (!isRecord(value) || typeof value.kind !== 'string'
    || !GENERATION_ACTIVITY_KINDS.has(value.kind)) {
    throw new ProtocolError(`generationByNodeId.${label} is invalid`)
  }
  return {
    key: requiredString(value.key, `generationByNodeId.${label}.key`, {
      max: 4_096,
    }),
    kind: value.kind as PersistedGenerationPanelState['current']['kind'],
    label: requiredString(value.label, `generationByNodeId.${label}.label`, {
      max: 1_000,
      allowEmpty: true,
    }),
  }
}

function parseLatestRuns(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): Record<string, string> {
  if (!isRecord(value)) throw new ProtocolError('document.latestRunByNodeId must be an object')
  if (Object.keys(value).length > nodeIds.size) {
    throw new ProtocolError('document.latestRunByNodeId has too many entries')
  }
  const runs: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [nodeId, runId] of Object.entries(value)) {
    validIdentifier(nodeId, 'latestRunByNodeId node id')
    if (!nodeIds.has(nodeId)) {
      throw new ProtocolError(`latestRunByNodeId references a missing node: ${nodeId}`)
    }
    runs[nodeId] = validIdentifier(runId, `latestRunByNodeId.${nodeId}`)
  }
  return runs
}

function parseRunRefs(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): Record<string, PersistedRunRef> {
  if (!isRecord(value)) throw new ProtocolError('document.runRefsByNodeId must be an object')
  if (Object.keys(value).length > nodeIds.size) {
    throw new ProtocolError('document.runRefsByNodeId has too many entries')
  }
  const refs: Record<string, PersistedRunRef> = Object.create(null) as Record<
    string,
    PersistedRunRef
  >
  for (const [nodeId, raw] of Object.entries(value)) {
    validIdentifier(nodeId, 'runRefsByNodeId node id')
    if (!nodeIds.has(nodeId)) {
      throw new ProtocolError(`runRefsByNodeId references a missing node: ${nodeId}`)
    }
    if (!isRecord(raw)) throw new ProtocolError(`runRefsByNodeId.${nodeId} must be an object`)
    if (!Number.isSafeInteger(raw.lastEventId) || (raw.lastEventId as number) < 0) {
      throw new ProtocolError(`runRefsByNodeId.${nodeId}.lastEventId is invalid`)
    }
    if (raw.previousPhase !== 'idle' && raw.previousPhase !== 'done') {
      throw new ProtocolError(`runRefsByNodeId.${nodeId}.previousPhase is invalid`)
    }
    refs[nodeId] = {
      runId: validIdentifier(raw.runId, `runRefsByNodeId.${nodeId}.runId`),
      lastEventId: raw.lastEventId as number,
      previousPhase: raw.previousPhase,
    }
  }
  return refs
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${name} must be a finite number`)
  }
  return value
}

function positiveFiniteNumber(value: unknown, name: string): number {
  const number = finiteNumber(value, name)
  if (number <= 0) throw new ProtocolError(`${name} must be positive`)
  return number
}

function assertJsonValue(
  value: unknown,
  name: string,
  depth: number,
  ancestors: WeakSet<object>,
): void {
  if (depth > 50) throw new ProtocolError(`${name} is nested too deeply`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProtocolError(`${name} contains a non-finite number`)
    return
  }
  if (typeof value !== 'object') throw new ProtocolError(`${name} is not JSON serializable`)
  if (ancestors.has(value)) throw new ProtocolError(`${name} contains a cycle`)
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertJsonValue(entry, `${name}[${index}]`, depth + 1, ancestors)
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${name}.${key}`, depth + 1, ancestors)
    }
  }
  ancestors.delete(value)
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
  const nodes = canvasSnapshot.nodes as CanvasNode[]
  if (!nodeIds.has(nodeId)) {
    throw new ProtocolError('target node is missing from canvasSnapshot.nodes')
  }

  const request: CreateRunRequest = {
    nodeId,
    agentId: validIdentifier(value.agentId, 'agentId'),
    prompt: requiredString(value.prompt, 'prompt', { max: 250_000, allowEmpty: true }),
    canvasSnapshot: {
      nodes,
      edges: canvasSnapshot.edges as Edge[],
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
