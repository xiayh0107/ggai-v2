import type { CanvasAgentEvent } from './types'
import type { PermissionDecision, PermissionResolution } from './permissions'
import type {
  DaemonPendingProjection,
  DaemonGraphMaterializationPlan,
  DaemonProjectionOutput,
  DaemonProjectionPlanQuery,
  DaemonProjectionPlan,
  DaemonProjectionTaskProposal,
} from './projectionPlan'
import {
  MAX_SUGGESTED_ACTION_ID_LENGTH,
  MAX_SUGGESTED_ACTION_LABEL_LENGTH,
  MAX_SUGGESTED_ACTION_PROMPT_LENGTH,
  MAX_SUGGESTED_ACTIONS,
  type SuggestedAction,
} from './suggestedActions'
import {
  inspectArtifactCapabilitySnapshotRequest,
  type ArtifactCapabilitySnapshotRequest,
} from '@/plugins/artifactContracts'
import { consumeSse } from './sse'
export type { PermissionDecision, PermissionResolution } from './permissions'
export type {
  DaemonPendingProjection,
  DaemonGraphMaterializationPlan,
  DaemonProjectionArtifactRef,
  DaemonProjectionOutput,
  DaemonProjectionPlanQuery,
  DaemonProjectionPlan,
  DaemonProjectionTaskProposal,
} from './projectionPlan'

export const DEFAULT_TASK_RUN_BASE_URL = 'http://127.0.0.1:7380'
const CREATE_RUN_TIMEOUT_MS = 15_000
const MAX_TEXT_ARTIFACT_BYTES = 1 * 1024 * 1024

type FetchImplementation = typeof globalThis.fetch

export interface TaskRunHttpClientOptions {
  /** HTTP origin (and optional path prefix) of the local daemon. */
  baseUrl?: string
  /** Primarily useful for tests or an Electron IPC-to-fetch bridge. */
  fetch?: FetchImplementation
  /** Headers sent with every request (for example a per-launch daemon token). */
  headers?: HeadersInit
}

export type DaemonRunStatus =
  | 'preparing'
  | 'running'
  | 'awaiting-permission'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export type DaemonCloseStatus = Extract<
  DaemonRunStatus,
  'done' | 'error' | 'cancelled' | 'interrupted'
>

export interface TaskRunCreateResponse {
  runId: string
  /** Some daemon implementations can resolve this before opening the stream. */
  sessionId?: string
}

export type TaskRunIntentAttachment =
  | { kind: 'artifact'; runId: string; artifactId: string }
  | { kind: 'node'; nodeId: string }

/** Exact Canvas POST /runs body. Project scope belongs in the query string. */
export interface TaskRunIntentPayload {
  schemaVersion: 2
  runId: string
  taskId: string
  agentId: string
  canvasBranch: string
  baseRevision: number
  prompt: string
  attachments: TaskRunIntentAttachment[]
  materializationPolicy: 'auto'
}

export interface TaskRunClosePayload {
  runId: string
  status: DaemonCloseStatus
  sessionId: string | null
  artifacts: string[]
  artifactsComplete: boolean
  artifactManifest?: TaskRunArtifactManifest
  projectionPlan?: DaemonProjectionPlan
  suggestedActions?: SuggestedAction[]
}

export interface TaskRunArtifactManifestEntry {
  artifactId: string
  relativePath: string
  mediaType: string
  size: number
  contentDigest: string
}

export interface TaskRunArtifactManifest {
  version: 1
  runId: string
  complete: boolean
  entries: TaskRunArtifactManifestEntry[]
}

export interface TaskRunStreamOptions {
  onEvent: (event: CanvasAgentEvent) => void
  /** Exact daemon event identity, unlike retired split event/id callbacks. */
  onEventEnvelope?: (entry: { id: number | null; data: CanvasAgentEvent }) => void
  signal?: AbortSignal
  projectDir?: string
  afterEventId?: number
  onEventId?: (eventId: number) => void
  /** A resumed session can be used if the daemon does not repeat its id. */
  sessionId?: string | null
  onSessionId?: (sessionId: string) => void
}

export interface TaskRunStreamResult {
  sessionId: string | null
  close: TaskRunClosePayload
  stopReason: Extract<CanvasAgentEvent, { type: 'done' }>['stopReason'] | null
}

export interface TaskRunSummaryPayload {
  runId: string
  /** Required and strictly decoded by the Canvas task-run methods. */
  taskId?: string
  /** Persisted Canvas revision accepted for this Task-owned run. */
  baseRevision?: number
  /** Exact prompt accepted for this Task-owned run. */
  prompt?: string
  nodeId: string
  agentId: string
  /** Required logical Canvas branch. */
  canvasBranch: string
  status: DaemonRunStatus
  startedAt: number
  finishedAt?: number
  sessionId: string | null
  error?: string
  logAvailable?: boolean
  skillCapabilityDigest?: string
}

export interface TaskRunPluginCapabilityRegistration {
  schemaVersion: 3
  digest: string
  pluginCount: number
}

export interface TaskRunsQuery {
  projectDir: string
  taskId: string
  branch: string
  limit: number
}

export interface TaskRunLogEntryPayload {
  id: number
  recordedAt: number
  event: 'agent-event' | 'session' | 'close'
  data: unknown
}

export interface TaskRunLogPage {
  entries: TaskRunLogEntryPayload[]
  nextEventId: number | null
}

export type DecodedTaskRunLogEntry =
  | { id: number; event: 'agent-event'; data: CanvasAgentEvent }
  | { id: number; event: 'session'; data: { sessionId: string } }
  | { id: number; event: 'close'; data: TaskRunClosePayload }

export class TaskRunClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TaskRunClientError'
  }
}

export class TaskRunHttpError extends TaskRunClientError {
  readonly status: number
  readonly statusText: string
  readonly responseBody: string

  constructor(status: number, statusText: string, responseBody: string) {
    const detail = responseBody ? `: ${responseBody}` : ''
    super(`Daemon request failed with HTTP ${status} ${statusText}${detail}`)
    this.name = 'TaskRunHttpError'
    this.status = status
    this.statusText = statusText
    this.responseBody = responseBody
  }
}

export class TaskRunProtocolError extends TaskRunClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TaskRunProtocolError'
  }
}

interface ActiveRun {
  runId: string
  sessionId: string | null
}

interface AgentEventEnvelope {
  event: CanvasAgentEvent
  sessionId?: string
}

const RUN_STATUSES = new Set<DaemonRunStatus>([
  'preparing',
  'running',
  'awaiting-permission',
  'done',
  'error',
  'cancelled',
  'interrupted',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRunStatus(value: unknown): value is DaemonRunStatus {
  return typeof value === 'string' && RUN_STATUSES.has(value as DaemonRunStatus)
}

function isCloseStatus(value: unknown): value is DaemonCloseStatus {
  return value === 'done'
    || value === 'error'
    || value === 'cancelled'
    || value === 'interrupted'
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => hasOwn(value, key))
}

function decodeSuggestedActions(value: unknown): SuggestedAction[] {
  if (!Array.isArray(value) || value.length > MAX_SUGGESTED_ACTIONS) {
    throw new TaskRunProtocolError('ProjectionPlan suggestedActions were malformed')
  }
  const ids = new Set<string>()
  const contents = new Set<string>()
  return value.map((candidate) => {
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, ['id', 'label', 'prompt'])
      || !isStableProjectionKey(candidate.id)
      || candidate.id.length > MAX_SUGGESTED_ACTION_ID_LENGTH
      || !isDisplayString(candidate.label, MAX_SUGGESTED_ACTION_LABEL_LENGTH)
      || !isDisplayString(candidate.prompt, MAX_SUGGESTED_ACTION_PROMPT_LENGTH)) {
      throw new TaskRunProtocolError('ProjectionPlan suggestedActions were malformed')
    }
    const contentKey = JSON.stringify([candidate.label, candidate.prompt])
    if (ids.has(candidate.id) || contents.has(contentKey)) {
      throw new TaskRunProtocolError('ProjectionPlan suggestedActions were duplicated')
    }
    ids.add(candidate.id)
    contents.add(contentKey)
    return { id: candidate.id, label: candidate.label, prompt: candidate.prompt }
  })
}

export function decodePendingProjection(value: unknown): DaemonPendingProjection {
  if (!isRecord(value) || !hasExactKeys(value, ['plan', 'suggestedActions'])) {
    throw new TaskRunProtocolError('Pending ProjectionPlan response was malformed')
  }
  const plan = decodeProjectionPlan(value.plan)
  const suggestedActions = decodeSuggestedActions(value.suggestedActions)
  if (plan.status === 'partial' && suggestedActions.length > 0) {
    throw new TaskRunProtocolError('Partial ProjectionPlan retained suggestedActions')
  }
  return { plan, suggestedActions }
}

export function decodeProjectionPlan(
  value: unknown,
  expectedRunId?: string,
): DaemonProjectionPlan {
  const rootKeys = [
    'schemaVersion',
    'planId',
    'runId',
    'taskId',
    'status',
    'manifestDigest',
    'outputs',
    'taskProposals',
    'warnings',
    'digest',
    ...(isRecord(value) && value.graphPlan !== undefined ? ['graphPlan'] : []),
  ] as const
  if (!isRecord(value)
    || !hasExactKeys(value, rootKeys)
    || value.schemaVersion !== 2
    || !isProjectionPlanId(value.planId)
    || !isDaemonIdentifier(value.runId)
    || !isDaemonIdentifier(value.taskId)
    || (value.status !== 'complete' && value.status !== 'partial')
    || !isSha256(value.manifestDigest)
    || !isSha256(value.digest)
    || !Array.isArray(value.outputs)
    || value.outputs.length > 32
    || !Array.isArray(value.taskProposals)
    || value.taskProposals.length > 12
    || !Array.isArray(value.warnings)
    || value.warnings.length > 1_000) {
    throw new TaskRunProtocolError('ProjectionPlan was malformed')
  }
  if (expectedRunId !== undefined && value.runId !== expectedRunId) {
    throw new TaskRunProtocolError('ProjectionPlan belonged to a different run')
  }

  const outputs = value.outputs.map((candidate, index) =>
    decodeProjectionOutput(candidate, value.runId as string, index))
  const outputKeys = new Set(outputs.map((output) => output.key))
  if (outputKeys.size !== outputs.length
    || outputs.some((output) => output.derivedFrom.some((key) => !outputKeys.has(key)))
    || hasKeyDependencyCycle(outputs.map((output) => ({
      key: output.key,
      dependencies: output.derivedFrom,
    })))) {
    throw new TaskRunProtocolError('ProjectionPlan had invalid output relations')
  }
  const materialized = new Set([
    ...outputs.filter((output) => output.role === 'primary'),
    ...outputs.filter((output) => output.role === 'supporting'),
  ].slice(0, 12).map((output) => output.key))
  if (outputs.some((output) => output.materialize !== materialized.has(output.key))) {
    throw new TaskRunProtocolError('ProjectionPlan had a non-canonical materialization policy')
  }

  const taskProposals = value.taskProposals.map((candidate, index) =>
    decodeProjectionTaskProposal(candidate, index))
  const proposalKeys = new Set(taskProposals.map((proposal) => proposal.key))
  if (proposalKeys.size !== taskProposals.length
    || taskProposals.some((proposal) =>
      proposal.inputOutputKeys.some((key) => !outputKeys.has(key))
      || proposal.dependsOn.some((key) => !proposalKeys.has(key)))
    || hasKeyDependencyCycle(taskProposals.map((proposal) => ({
      key: proposal.key,
      dependencies: proposal.dependsOn,
    })))) {
    throw new TaskRunProtocolError('ProjectionPlan had invalid task proposal relations')
  }
  if (value.status === 'partial' && taskProposals.length > 0) {
    throw new TaskRunProtocolError('Partial ProjectionPlan retained task proposals')
  }
  if (!value.warnings.every((warning) => isDisplayString(warning, 1_000))) {
    throw new TaskRunProtocolError('ProjectionPlan had invalid warnings')
  }
  const graphPlan = value.graphPlan === undefined
    ? undefined
    : decodeGraphMaterializationPlan(value.graphPlan, value.planId, value.runId, value.taskId)

  return {
    schemaVersion: 2,
    planId: value.planId,
    runId: value.runId,
    taskId: value.taskId,
    status: value.status,
    manifestDigest: value.manifestDigest,
    outputs,
    taskProposals,
    ...(graphPlan ? { graphPlan } : {}),
    warnings: [...value.warnings] as string[],
    digest: value.digest,
  }
}

function decodeGraphMaterializationPlan(
  value: unknown,
  planId: string,
  runId: string,
  taskId: string,
): DaemonGraphMaterializationPlan {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'planId', 'runId', 'taskId', 'nodes', 'edges', 'nodeTypes', 'digest',
  ]) || value.schemaVersion !== 1 || value.planId !== planId
    || value.runId !== runId || value.taskId !== taskId || !isSha256(value.digest)
    || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 256
    || !Array.isArray(value.edges) || value.edges.length > 512
    || !Array.isArray(value.nodeTypes) || value.nodeTypes.length > 256) {
    throw new TaskRunProtocolError('GraphMaterializationPlan was malformed')
  }
  for (const entry of value.nodes) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['logicalKey', 'node'])
      || !isStableProjectionKey(entry.logicalKey) || !isRecord(entry.node)
      || typeof entry.node.id !== 'string' || typeof entry.node.title !== 'string'
      || !isRecord(entry.node.typeRef) || !isRecord(entry.node.bounds)
      || !isRecord(entry.node.transform)) {
      throw new TaskRunProtocolError('GraphMaterializationPlan node was malformed')
    }
  }
  return structuredClone(value) as unknown as DaemonGraphMaterializationPlan
}

function decodeProjectionOutput(
  value: unknown,
  expectedRunId: string,
  index: number,
): DaemonProjectionOutput {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'key',
      'pluginId',
      'role',
      'title',
      'artifactRefs',
      'derivedFrom',
      'materialize',
    ])
    || !isStableProjectionKey(value.key)
    || !isProjectionPluginId(value.pluginId)
    || (value.role !== 'primary' && value.role !== 'supporting' && value.role !== 'auxiliary')
    || !isDisplayString(value.title, 240)
    || !Array.isArray(value.artifactRefs)
    || value.artifactRefs.length === 0
    || value.artifactRefs.length > 8
    || !Array.isArray(value.derivedFrom)
    || value.derivedFrom.length > 8
    || !value.derivedFrom.every(isStableProjectionKey)
    || new Set(value.derivedFrom).size !== value.derivedFrom.length
    || typeof value.materialize !== 'boolean') {
    throw new TaskRunProtocolError(`ProjectionPlan output ${index} was malformed`)
  }
  const artifactRefs = value.artifactRefs.map((candidate, artifactIndex) => {
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, ['runId', 'artifactId'])
      || candidate.runId !== expectedRunId
      || !/^artifact_[0-9a-f]{64}$/u.test(candidate.artifactId as string)) {
      throw new TaskRunProtocolError(
        `ProjectionPlan output ${index} artifact ${artifactIndex} was malformed`,
      )
    }
    return {
      runId: candidate.runId as string,
      artifactId: candidate.artifactId as string,
    }
  })
  if (new Set(artifactRefs.map((artifact) => artifact.artifactId)).size !== artifactRefs.length) {
    throw new TaskRunProtocolError(`ProjectionPlan output ${index} duplicated an artifact`)
  }
  return {
    key: value.key,
    pluginId: value.pluginId,
    role: value.role,
    title: value.title,
    artifactRefs,
    derivedFrom: [...value.derivedFrom] as string[],
    materialize: value.materialize,
  }
}

function decodeProjectionTaskProposal(
  value: unknown,
  index: number,
): DaemonProjectionTaskProposal {
  if (!isRecord(value)
    || !hasExactKeys(value, ['key', 'title', 'prompt', 'inputOutputKeys', 'dependsOn'])
    || !isStableProjectionKey(value.key)
    || !isDisplayString(value.title, 240)
    || !isDisplayString(value.prompt, 10_000)
    || !Array.isArray(value.inputOutputKeys)
    || value.inputOutputKeys.length > 32
    || !value.inputOutputKeys.every(isStableProjectionKey)
    || new Set(value.inputOutputKeys).size !== value.inputOutputKeys.length
    || !Array.isArray(value.dependsOn)
    || value.dependsOn.length > 8
    || !value.dependsOn.every(isStableProjectionKey)
    || new Set(value.dependsOn).size !== value.dependsOn.length) {
    throw new TaskRunProtocolError(`ProjectionPlan task proposal ${index} was malformed`)
  }
  return {
    key: value.key,
    title: value.title,
    prompt: value.prompt,
    inputOutputKeys: [...value.inputOutputKeys] as string[],
    dependsOn: [...value.dependsOn] as string[],
  }
}

function hasKeyDependencyCycle(
  entries: readonly { key: string; dependencies: readonly string[] }[],
): boolean {
  const dependencies = new Map(entries.map((entry) => [entry.key, entry.dependencies]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true
    if (visited.has(key)) return false
    visiting.add(key)
    for (const dependency of dependencies.get(key) ?? []) if (visit(dependency)) return true
    visiting.delete(key)
    visited.add(key)
    return false
  }
  return entries.some((entry) => visit(entry.key))
}

function isProjectionPlanId(value: unknown): value is string {
  return typeof value === 'string' && /^plan_[0-9a-f]{64}$/u.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isDaemonIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u.test(value)
    && !value.includes('..')
}

function isStableProjectionKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 80
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}

function isProjectionPluginId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 160
    && /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
    && !value.includes('..')
    && !value.includes('//')
}

function isDisplayString(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function isCanvasAgentEvent(value: unknown): value is CanvasAgentEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  switch (value.type) {
    case 'thinking':
    case 'text-delta':
      return typeof value.text === 'string'
    case 'tool-call':
      return isNonEmptyString(value.name) && hasOwn(value, 'input')
    case 'tool-result':
      return hasOwn(value, 'result')
    case 'file-write':
      return typeof value.path === 'string'
        && (value.nodeId === undefined || typeof value.nodeId === 'string')
    case 'permission-request':
      return isNonEmptyString(value.id)
        && typeof value.action === 'string'
        && typeof value.detail === 'string'
    case 'usage':
      return isFiniteNumber(value.tokensIn) && isFiniteNumber(value.tokensOut)
    case 'error':
      return typeof value.message === 'string'
    case 'done':
      return value.stopReason === 'end_turn'
        || value.stopReason === 'cancelled'
        || value.stopReason === 'error'
    default:
      return false
  }
}

function normalizeBaseUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch (error) {
    throw new TaskRunClientError(`Invalid daemon base URL: ${input}`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TaskRunClientError('Daemon base URL must use http: or https:')
  }
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const excerpt = text.length > 240 ? `${text.slice(0, 240)}…` : text
    throw new TaskRunProtocolError(`${context} contained invalid JSON: ${excerpt}`, { cause: error })
  }
}

function errorBodyExcerpt(text: string): string {
  const compact = text.trim().replace(/\s+/g, ' ')
  if (!compact) return ''
  try {
    const body = JSON.parse(compact) as unknown
    if (isRecord(body)) {
      if (typeof body.message === 'string') return body.message.slice(0, 1_000)
      if (typeof body.error === 'string') return body.error.slice(0, 1_000)
      if (isRecord(body.error) && typeof body.error.message === 'string') {
        return body.error.message.slice(0, 1_000)
      }
    }
  } catch {
    // Fall through to the compact plain-text response.
  }
  return compact.slice(0, 1_000)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return isRecord(error) && error.name === 'AbortError'
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(abortReason(signal))
      break
    }
    const listener = () => controller.abort(abortReason(signal))
    signal.addEventListener('abort', listener, { once: true })
    listeners.push({ signal, listener })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener('abort', listener)
      }
    },
  }
}

function decodeAgentEvent(value: unknown, context: string): AgentEventEnvelope {
  let candidate = value
  let sessionId: string | undefined

  if (isRecord(value)) {
    if (isNonEmptyString(value.sessionId)) sessionId = value.sessionId
    if (hasOwn(value, 'event')) candidate = value.event
  }
  if (!isCanvasAgentEvent(candidate)) {
    throw new TaskRunProtocolError(`${context} was not a valid CanvasAgentEvent`)
  }
  return { event: candidate, sessionId }
}

function decodeSessionId(value: unknown, context: string): string {
  if (isNonEmptyString(value)) return value
  if (isRecord(value) && isNonEmptyString(value.sessionId)) return value.sessionId
  throw new TaskRunProtocolError(`${context} did not contain a non-empty sessionId`)
}

function canonicalRunIntent(intent: TaskRunIntentPayload): TaskRunIntentPayload {
  if (!isRecord(intent)
    || intent.schemaVersion !== 2
    || !isDaemonIdentifier(intent.runId)
    || !isDaemonIdentifier(intent.taskId)
    || !isDaemonIdentifier(intent.agentId)
    || !isCanvasBranch(intent.canvasBranch)
    || !Number.isSafeInteger(intent.baseRevision)
    || intent.baseRevision < 0
    || typeof intent.prompt !== 'string'
    || intent.prompt.length > 250_000
    || !Array.isArray(intent.attachments)
    || intent.attachments.length > 100
    || intent.materializationPolicy !== 'auto') {
    throw new TaskRunClientError('RunIntent is invalid')
  }
  const attachments = intent.attachments.map((attachment): TaskRunIntentAttachment => {
    if (!isRecord(attachment) || typeof attachment.kind !== 'string') {
      throw new TaskRunClientError('RunIntent attachment is invalid')
    }
    if (attachment.kind === 'node' && isDaemonIdentifier(attachment.nodeId)) {
      return { kind: 'node', nodeId: attachment.nodeId }
    }
    if (attachment.kind === 'artifact'
      && isDaemonIdentifier(attachment.runId)
      && typeof attachment.artifactId === 'string'
      && /^artifact_[0-9a-f]{64}$/u.test(attachment.artifactId)) {
      return {
        kind: 'artifact',
        runId: attachment.runId,
        artifactId: attachment.artifactId,
      }
    }
    throw new TaskRunClientError('RunIntent attachment is invalid')
  })
  const keys = attachments.map((attachment) => attachment.kind === 'node'
    ? `node:${attachment.nodeId}`
    : `artifact:${attachment.runId}:${attachment.artifactId}`)
  if (new Set(keys).size !== keys.length) {
    throw new TaskRunClientError('RunIntent attachments contain duplicates')
  }
  return {
    schemaVersion: 2,
    runId: intent.runId,
    taskId: intent.taskId,
    agentId: intent.agentId,
    canvasBranch: intent.canvasBranch,
    baseRevision: intent.baseRevision,
    prompt: intent.prompt,
    attachments,
    materializationPolicy: 'auto',
  }
}

function isCanvasBranch(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 120
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && !value.includes('..')
    && !value.includes('//')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && !value.endsWith('.lock')
    && value.split('/').every((part) => part !== '.' && !part.endsWith('.'))
}

function decodeCloseEvent(value: unknown, expectedRunId: string): TaskRunClosePayload {
  if (!isRecord(value)
    || !isNonEmptyString(value.runId)
    || !isCloseStatus(value.status)
    || !Array.isArray(value.artifacts)
    || !value.artifacts.every((artifact) => isNonEmptyString(artifact))
    || typeof value.artifactsComplete !== 'boolean') {
    throw new TaskRunProtocolError('SSE close event was malformed')
  }
  if (value.runId !== expectedRunId) {
    throw new TaskRunProtocolError(
      `SSE close event runId mismatch (expected ${expectedRunId}, received ${value.runId})`,
    )
  }
  if (value.sessionId !== undefined
    && value.sessionId !== null
    && !isNonEmptyString(value.sessionId)) {
    throw new TaskRunProtocolError('SSE close event had an invalid sessionId')
  }
  const artifactManifest = value.artifactManifest === undefined
    ? undefined
    : decodeArtifactManifest(value.artifactManifest, expectedRunId)
  const projectionPlan = value.projectionPlan === undefined
    ? undefined
    : decodeProjectionPlan(value.projectionPlan, expectedRunId)
  const suggestedActions = projectionPlan
    ? decodeSuggestedActions(value.suggestedActions)
    : undefined
  if (!projectionPlan && value.suggestedActions !== undefined) {
    throw new TaskRunProtocolError('SSE close event exposed actions without a projection plan')
  }
  if (projectionPlan?.status === 'partial' && suggestedActions?.length) {
    throw new TaskRunProtocolError('Partial ProjectionPlan retained suggestedActions')
  }
  return {
    runId: value.runId,
    status: value.status,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    artifacts: value.artifacts as string[],
    artifactsComplete: value.artifactsComplete,
    ...(artifactManifest ? { artifactManifest } : {}),
    ...(projectionPlan ? { projectionPlan } : {}),
    ...(suggestedActions ? { suggestedActions } : {}),
  }
}

function decodeArtifactManifest(
  value: unknown,
  expectedRunId: string,
): TaskRunArtifactManifest {
  if (!isRecord(value)
    || value.version !== 1
    || value.runId !== expectedRunId
    || typeof value.complete !== 'boolean'
    || !Array.isArray(value.entries)) {
    throw new TaskRunProtocolError('SSE close event artifact manifest was malformed')
  }
  const paths = new Set<string>()
  const artifactIds = new Set<string>()
  const entries = value.entries.map((entry, index): TaskRunArtifactManifestEntry => {
    if (!isRecord(entry)
      || Object.keys(entry).length !== 5
      || typeof entry.artifactId !== 'string'
      || !/^artifact_[0-9a-f]{64}$/u.test(entry.artifactId)
      || typeof entry.relativePath !== 'string'
      || entry.relativePath.length === 0
      || entry.relativePath.startsWith('/')
      || entry.relativePath.includes('\\')
      || entry.relativePath.includes('\0')
      || entry.relativePath.split('/').some((segment) =>
        segment.length === 0
        || segment === '.'
        || segment === '..'
        || segment.toLowerCase() === '.ggai')
      || typeof entry.mediaType !== 'string'
      || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(entry.mediaType)
      || !Number.isSafeInteger(entry.size)
      || (entry.size as number) < 0
      || typeof entry.contentDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(entry.contentDigest)
      || paths.has(entry.relativePath)
      || artifactIds.has(entry.artifactId)) {
      throw new TaskRunProtocolError(
        `SSE close event artifact manifest entry ${index} was malformed`,
      )
    }
    paths.add(entry.relativePath)
    artifactIds.add(entry.artifactId)
    return {
      artifactId: entry.artifactId,
      relativePath: entry.relativePath,
      mediaType: entry.mediaType,
      size: entry.size as number,
      contentDigest: entry.contentDigest,
    }
  })
  return {
    version: 1,
    runId: expectedRunId,
    complete: value.complete,
    entries,
  }
}

function decodeEventId(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TaskRunProtocolError('SSE event contained an invalid id')
  }
  return parsed
}

function decodeRunSummary(value: unknown, requireTaskId = false): TaskRunSummaryPayload {
  if (!isRecord(value)
    || !isNonEmptyString(value.runId)
    || !isNonEmptyString(value.nodeId)
    || !isNonEmptyString(value.agentId)
    || !isRunStatus(value.status)
    || !isFiniteNumber(value.startedAt)
    || !(value.sessionId === null || isNonEmptyString(value.sessionId))) {
    throw new TaskRunProtocolError('GET /runs/:id response was malformed')
  }
  if (value.finishedAt !== undefined && !isFiniteNumber(value.finishedAt)) {
    throw new TaskRunProtocolError('GET /runs/:id response had an invalid finishedAt')
  }
  if (!isNonEmptyString(value.canvasBranch)) {
    throw new TaskRunProtocolError('GET /runs/:id response had an invalid canvasBranch')
  }
  if ((requireTaskId && !isDaemonIdentifier(value.taskId))
    || (value.taskId !== undefined && !isDaemonIdentifier(value.taskId))) {
    throw new TaskRunProtocolError('GET /runs/:id response had an invalid taskId')
  }
  const hasBaseRevision = value.baseRevision !== undefined
  const hasPrompt = value.prompt !== undefined
  if (hasBaseRevision !== hasPrompt
    || ((hasBaseRevision || hasPrompt) && value.taskId === undefined)
    || (hasBaseRevision
      && (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0))) {
    throw new TaskRunProtocolError('GET /runs/:id response had invalid RunIntent metadata')
  }
  if (hasPrompt
    && (typeof value.prompt !== 'string' || value.prompt.length > 250_000)) {
    throw new TaskRunProtocolError('GET /runs/:id response had invalid RunIntent metadata')
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new TaskRunProtocolError('GET /runs/:id response had an invalid error')
  }
  if (value.logAvailable !== undefined && typeof value.logAvailable !== 'boolean') {
    throw new TaskRunProtocolError('GET /runs/:id response had an invalid logAvailable')
  }
  if (value.skillCapabilityDigest !== undefined
    && (typeof value.skillCapabilityDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(value.skillCapabilityDigest))) {
    throw new TaskRunProtocolError('GET /runs/:id response had an invalid skillCapabilityDigest')
  }
  return {
    runId: value.runId,
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    ...(typeof value.baseRevision === 'number' ? { baseRevision: value.baseRevision } : {}),
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    nodeId: value.nodeId,
    agentId: value.agentId,
    canvasBranch: value.canvasBranch,
    status: value.status,
    startedAt: value.startedAt,
    sessionId: value.sessionId,
    ...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.logAvailable === 'boolean' ? { logAvailable: value.logAvailable } : {}),
    ...(typeof value.skillCapabilityDigest === 'string'
      ? { skillCapabilityDigest: value.skillCapabilityDigest }
      : {}),
  }
}

function decodeRunLogPage(value: unknown): TaskRunLogPage {
  if (!isRecord(value)
    || !Array.isArray(value.entries)
    || !(value.nextEventId === null
      || (Number.isSafeInteger(value.nextEventId) && (value.nextEventId as number) > 0))) {
    throw new TaskRunProtocolError('GET /runs/:id/log response was malformed')
  }
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry)
      || !Number.isSafeInteger(entry.id)
      || (entry.id as number) < 1
      || !isFiniteNumber(entry.recordedAt)
      || (entry.event !== 'agent-event' && entry.event !== 'session' && entry.event !== 'close')) {
      throw new TaskRunProtocolError('GET /runs/:id/log response contained an invalid entry')
    }
    return entry as unknown as TaskRunLogEntryPayload
  })
  return { entries, nextEventId: value.nextEventId as number | null }
}

export function decodeTaskRunLogEntry(
  entry: TaskRunLogEntryPayload,
  expectedRunId: string,
): DecodedTaskRunLogEntry {
  if (entry.event === 'agent-event') {
    return { id: entry.id, event: 'agent-event', data: decodeAgentEvent(entry.data, 'run log event').event }
  }
  if (entry.event === 'session') {
    return {
      id: entry.id,
      event: 'session',
      data: { sessionId: decodeSessionId(entry.data, 'run log session event') },
    }
  }
  return {
    id: entry.id,
    event: 'close',
    data: decodeCloseEvent(entry.data, expectedRunId),
  }
}

/** Focused HTTP/SSE client for Canvas Task Runs. */
export class TaskRunHttpClient {
  readonly baseUrl: string
  private readonly fetchImplementation: FetchImplementation
  private readonly commonHeaders: Headers
  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(options: TaskRunHttpClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_TASK_RUN_BASE_URL)
    this.fetchImplementation = options.fetch
      ?? ((input, init) => globalThis.fetch(input, init))
    this.commonHeaders = new Headers(options.headers)
  }

  /** Snapshot of active run ids, useful for wiring a Cancel button. */
  get activeRunIds(): readonly string[] {
    return [...this.activeRuns.keys()]
  }

  /** Read one immutable manifest-backed artifact by its daemon-authored manifest identity. */
  async runArtifactText(
    runId: string,
    artifactId: string,
    projectDir = '.',
    signal?: AbortSignal,
  ): Promise<string> {
    if (!isNonEmptyString(runId)) throw new TaskRunClientError('runId must not be empty')
    if (!/^artifact_[0-9a-f]{64}$/u.test(artifactId)) {
      throw new TaskRunClientError('artifactId is invalid')
    }
    const url = new URL(this.endpoint(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    ))
    url.searchParams.set('projectDir', projectDir)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > MAX_TEXT_ARTIFACT_BYTES) {
      throw new TaskRunProtocolError('Text artifact is too large to preview')
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_TEXT_ARTIFACT_BYTES) {
      throw new TaskRunProtocolError('Text artifact is too large to preview')
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new TaskRunProtocolError('Text artifact was not valid UTF-8', { cause: error })
    }
  }

  /** Read a daemon-authored plan only while it remains pending on this branch. */
  async getPendingProjectionPlan(
    planId: string,
    query: DaemonProjectionPlanQuery = {},
    signal?: AbortSignal,
  ): Promise<DaemonPendingProjection> {
    if (!isProjectionPlanId(planId)) throw new TaskRunClientError('planId is invalid')
    const url = new URL(this.endpoint(`/projection-plans/${encodeURIComponent(planId)}`))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    if (query.branch !== undefined) url.searchParams.set('branch', query.branch)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodePendingProjection(
      await this.readJson(response, 'GET /projection-plans/:id response'),
    )
  }

  async getGraphPlan(
    planId: string,
    query: DaemonProjectionPlanQuery = {},
    signal?: AbortSignal,
  ): Promise<DaemonGraphMaterializationPlan> {
    if (!isProjectionPlanId(planId)) throw new TaskRunClientError('planId is invalid')
    const url = new URL(this.endpoint(`/graph-plans/${encodeURIComponent(planId)}`))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    if (query.branch !== undefined) url.searchParams.set('branch', query.branch)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    const value = await this.readJson(response, 'GET /graph-plans/:id response')
    if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'graphPlan', 'state'])
      || value.schemaVersion !== 1 || value.state !== 'pending' || !isRecord(value.graphPlan)
      || typeof value.graphPlan.runId !== 'string' || typeof value.graphPlan.taskId !== 'string') {
      throw new TaskRunProtocolError('Graph plan response was malformed')
    }
    return decodeGraphMaterializationPlan(
      value.graphPlan, planId, value.graphPlan.runId, value.graphPlan.taskId,
    )
  }

  /** POST /permissions/:id */
  async permissions(
    permissionId: string,
    resolution: PermissionDecision | PermissionResolution,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!permissionId) throw new TaskRunClientError('permissionId must not be empty')
    const body: PermissionResolution = typeof resolution === 'string'
      ? { decision: resolution }
      : resolution
    if (body.decision !== 'allow' && body.decision !== 'deny') {
      throw new TaskRunClientError('permission decision must be "allow" or "deny"')
    }
    if (body.remember !== undefined && typeof body.remember !== 'boolean') {
      throw new TaskRunClientError('permission remember flag must be a boolean')
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      throw new TaskRunClientError('permission reason must be a string')
    }
    await this.request(
      `/permissions/${encodeURIComponent(permissionId)}`,
      { method: 'POST', body: JSON.stringify(body) },
      signal,
    )
  }

  async resolvePermission(
    permissionId: string,
    resolution: PermissionDecision | PermissionResolution,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.permissions(permissionId, resolution, signal)
  }

  /** PUT a strict data-only plugin registry and receive its immutable digest. */
  async registerPluginCapabilities(
    projectDir: string,
    snapshot: ArtifactCapabilitySnapshotRequest,
    signal?: AbortSignal,
  ): Promise<TaskRunPluginCapabilityRegistration> {
    if (!projectDir) throw new TaskRunClientError('projectDir must not be empty')
    const inspection = inspectArtifactCapabilitySnapshotRequest(snapshot)
    if (inspection.status !== 'valid') {
      throw new TaskRunClientError(`plugin capability snapshot is invalid: ${inspection.reason}`)
    }
    const url = new URL(this.endpoint('/plugin-capabilities'))
    url.searchParams.set('projectDir', projectDir)
    const timeout = new AbortController()
    const timeoutId = setTimeout(() => {
      timeout.abort(new DOMException('Registering plugin capabilities timed out', 'TimeoutError'))
    }, CREATE_RUN_TIMEOUT_MS)
    const combined = combineAbortSignals([signal, timeout.signal])
    try {
      const response = await this.requestUrl(url, {
        method: 'PUT',
        body: JSON.stringify(inspection.snapshot),
      }, combined.signal)
      const payload = await this.readJson(response, 'PUT /plugin-capabilities response')
      if (!isRecord(payload)
        || !hasExactKeys(payload, ['schemaVersion', 'digest', 'pluginCount'])
        || payload.schemaVersion !== 3
        || typeof payload.digest !== 'string'
        || !/^[0-9a-f]{64}$/u.test(payload.digest)
        || !Number.isSafeInteger(payload.pluginCount)
        || (payload.pluginCount as number) < 1
        || (payload.pluginCount as number) > 500) {
        throw new TaskRunProtocolError('PUT /plugin-capabilities response was malformed')
      }
      return {
        schemaVersion: 3,
        digest: payload.digest,
        pluginCount: payload.pluginCount as number,
      }
    } finally {
      clearTimeout(timeoutId)
      combined.dispose()
    }
  }

  /** POST /runs?projectDir= with the exact Task-owned intent. */
  async createTaskRun(
    intent: TaskRunIntentPayload,
    projectDir: string,
    signal?: AbortSignal,
    pluginCapabilityDigest?: string,
  ): Promise<TaskRunCreateResponse> {
    if (!projectDir) throw new TaskRunClientError('projectDir must not be empty')
    if (pluginCapabilityDigest !== undefined
      && !/^[0-9a-f]{64}$/u.test(pluginCapabilityDigest)) {
      throw new TaskRunClientError('pluginCapabilityDigest is invalid')
    }
    const body = canonicalRunIntent(intent)
    const url = new URL(this.endpoint('/runs'))
    url.searchParams.set('projectDir', projectDir)
    if (pluginCapabilityDigest) {
      url.searchParams.set('pluginCapabilityDigest', pluginCapabilityDigest)
    }
    const timeout = new AbortController()
    const timeoutId = setTimeout(() => {
      timeout.abort(new DOMException('Creating the Task Run timed out', 'TimeoutError'))
    }, CREATE_RUN_TIMEOUT_MS)
    const combined = combineAbortSignals([signal, timeout.signal])
    try {
      const response = await this.requestUrl(url, {
        method: 'POST',
        body: JSON.stringify(body),
      }, combined.signal)
      const payload = await this.readJson(response, 'POST /runs response')
      if (!isRecord(payload)
        || !hasExactKeys(payload, ['runId'])
        || payload.runId !== body.runId) {
        throw new TaskRunProtocolError('POST /runs response did not match its RunIntent')
      }
      return { runId: body.runId }
    } finally {
      clearTimeout(timeoutId)
      combined.dispose()
    }
  }

  /** GET /runs/:id with Task ownership required rather than inferred from nodeId. */
  async getTaskRun(
    runId: string,
    projectDir: string,
    signal?: AbortSignal,
  ): Promise<TaskRunSummaryPayload & { taskId: string }> {
    if (!isDaemonIdentifier(runId)) throw new TaskRunClientError('runId is invalid')
    if (!projectDir) throw new TaskRunClientError('projectDir must not be empty')
    const url = new URL(this.endpoint(`/runs/${encodeURIComponent(runId)}`))
    url.searchParams.set('projectDir', projectDir)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    const summary = decodeRunSummary(
      await this.readJson(response, 'GET /runs/:id response'),
      true,
    )
    if (summary.runId !== runId || summary.taskId === undefined) {
      throw new TaskRunProtocolError('GET /runs/:id response had mismatched identity')
    }
    return summary as TaskRunSummaryPayload & { taskId: string }
  }

  /** GET /runs with all Task ownership filters explicit and every summary strict. */
  async listTaskRuns(
    query: TaskRunsQuery,
    signal?: AbortSignal,
  ): Promise<Array<TaskRunSummaryPayload & { taskId: string }>> {
    if (!query.projectDir) throw new TaskRunClientError('projectDir must not be empty')
    if (!isDaemonIdentifier(query.taskId)) throw new TaskRunClientError('taskId is invalid')
    if (!isCanvasBranch(query.branch)) throw new TaskRunClientError('branch is invalid')
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 2_000) {
      throw new TaskRunClientError('limit must be between 1 and 2000')
    }
    const url = new URL(this.endpoint('/runs'))
    url.searchParams.set('projectDir', query.projectDir)
    url.searchParams.set('taskId', query.taskId)
    url.searchParams.set('branch', query.branch)
    url.searchParams.set('limit', String(query.limit))
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    const payload = await this.readJson(response, 'GET /runs response')
    if (!isRecord(payload) || !hasExactKeys(payload, ['runs']) || !Array.isArray(payload.runs)) {
      throw new TaskRunProtocolError('GET /runs response did not contain an exact run list')
    }
    return payload.runs.map((candidate) => {
      const summary = decodeRunSummary(candidate, true)
      if (summary.taskId !== query.taskId || summary.canvasBranch !== query.branch) {
        throw new TaskRunProtocolError('GET /runs response escaped its Task or branch filter')
      }
      if (summary.nodeId !== summary.taskId) {
        throw new TaskRunProtocolError('GET /runs response had an invalid task identity mirror')
      }
      return summary as TaskRunSummaryPayload & { taskId: string }
    })
  }

  /** GET /runs/:id/log, used to rebuild progress before resuming the live stream. */
  async getRunLog(
    runId: string,
    options: { projectDir?: string; afterEventId?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<TaskRunLogPage> {
    if (!runId) throw new TaskRunClientError('runId must not be empty')
    const url = new URL(this.endpoint(`/runs/${encodeURIComponent(runId)}/log`))
    url.searchParams.set('projectDir', options.projectDir ?? '.')
    if (options.afterEventId !== undefined) {
      url.searchParams.set('afterEventId', String(options.afterEventId))
    }
    if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit))
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodeRunLogPage(await this.readJson(response, 'GET /runs/:id/log response'))
  }

  /** GET /runs/:id/events, consumed with fetch so abort and HTTP errors stay observable. */
  async streamRunEvents(
    runId: string,
    options: TaskRunStreamOptions,
  ): Promise<TaskRunStreamResult> {
    if (!runId) throw new TaskRunClientError('runId must not be empty')
    const afterEventId = options.afterEventId ?? 0
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
      throw new TaskRunClientError('afterEventId must be a non-negative safe integer')
    }
    const response = await this.request(
      `/runs/${encodeURIComponent(runId)}/events`,
      {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(afterEventId > 0 ? { 'Last-Event-ID': String(afterEventId) } : {}),
        },
      },
      options.signal,
    )
    const contentType = response.headers.get('content-type')
    if (contentType && !contentType.toLowerCase().includes('text/event-stream')) {
      throw new TaskRunProtocolError(
        `GET /runs/:id/events returned unexpected content type: ${contentType}`,
      )
    }

    let sessionId = options.sessionId ?? null
    let close: TaskRunClosePayload | null = null
    let stopReason: TaskRunStreamResult['stopReason'] = null

    const updateSessionId = (nextSessionId: string): void => {
      sessionId = nextSessionId
      options.onSessionId?.(nextSessionId)
    }

    await consumeSse(response, (message) => {
      const eventId = decodeEventId(message.id)
      const acknowledge = () => {
        if (eventId !== null) options.onEventId?.(eventId)
      }
      if (message.event === 'agent-event' || message.event === 'message') {
        const raw = parseJson(message.data, `SSE ${message.event} event`)

        // A default event stream may encode control messages using a type field.
        if (message.event === 'message' && isRecord(raw) && raw.type === 'session') {
          updateSessionId(decodeSessionId(raw, 'SSE session event'))
          acknowledge()
          return false
        }
        if (message.event === 'message' && isRecord(raw) && raw.type === 'close') {
          close = decodeCloseEvent(raw, runId)
          if (close.sessionId) updateSessionId(close.sessionId)
          acknowledge()
          return true
        }

        const decoded = decodeAgentEvent(raw, `SSE ${message.event} event`)
        if (decoded.sessionId) updateSessionId(decoded.sessionId)
        if (decoded.event.type === 'done') {
          stopReason = decoded.event.stopReason
        }
        options.onEvent(decoded.event)
        options.onEventEnvelope?.({ id: eventId, data: decoded.event })
        acknowledge()
        return false
      }

      if (message.event === 'session') {
        updateSessionId(decodeSessionId(parseJson(message.data, 'SSE session event'), 'SSE session event'))
        acknowledge()
        return false
      }

      if (message.event === 'close') {
        close = decodeCloseEvent(parseJson(message.data, 'SSE close event'), runId)
        if (close.sessionId) updateSessionId(close.sessionId)
        acknowledge()
        return true
      }
      // Heartbeats and future extension events are intentionally ignored.
      return false
    }, (message, cause) => new TaskRunProtocolError(
      message,
      cause === undefined ? undefined : { cause },
    ))

    // `done` describes the Agent turn; only daemon `close` confirms the child exited,
    // persistence finished, and the final status is authoritative.
    if (!close) throw new TaskRunProtocolError(`SSE stream for run ${runId} ended without close`)
    return { sessionId, close, stopReason }
  }

  /** Attach to an existing run. Aborting only detaches this browser subscriber. */
  async attachRun(
    runId: string,
    options: TaskRunStreamOptions,
  ): Promise<TaskRunStreamResult> {
    const active = this.activeRuns.get(runId) ?? {
      runId,
      sessionId: options.sessionId ?? null,
    }
    this.activeRuns.set(runId, active)
    try {
      const streamOptions: TaskRunStreamOptions = {
        ...options,
        sessionId: active.sessionId,
        onSessionId: (sessionId) => {
          active.sessionId = sessionId
          options.onSessionId?.(sessionId)
        },
      }
      try {
        return await this.streamRunEvents(runId, streamOptions)
      } catch (error) {
        if (!(error instanceof TaskRunHttpError) || error.status !== 409) throw error

        // The daemon's bounded in-memory replay window can have a gap. Its
        // durable JSONL log is authoritative, so fill the missing range before
        // reopening the live stream from the newest persisted event id.
        let cursor = options.afterEventId ?? 0
        let close: TaskRunClosePayload | null = null
        let stopReason: TaskRunStreamResult['stopReason'] = null
        while (true) {
          const page = await this.getRunLog(runId, {
            projectDir: options.projectDir ?? '.',
            afterEventId: cursor,
            limit: 2_000,
          }, options.signal)
          for (const rawEntry of page.entries) {
            const entry = decodeTaskRunLogEntry(rawEntry, runId)
            cursor = Math.max(cursor, entry.id)
            if (entry.event === 'agent-event') {
              if (entry.data.type === 'done') stopReason = entry.data.stopReason
              options.onEvent(entry.data)
              options.onEventEnvelope?.({ id: entry.id, data: entry.data })
            } else if (entry.event === 'session') {
              active.sessionId = entry.data.sessionId
              options.onSessionId?.(entry.data.sessionId)
            } else {
              close = entry.data
              if (close.sessionId) active.sessionId = close.sessionId
            }
            options.onEventId?.(entry.id)
          }
          if (page.nextEventId === null) break
          cursor = page.nextEventId
        }
        if (close) return { sessionId: active.sessionId, close, stopReason }
        return await this.streamRunEvents(runId, {
          ...streamOptions,
          afterEventId: cursor,
        })
      }
    } finally {
      this.activeRuns.delete(runId)
    }
  }

  /** POST /runs/:id/cancel */
  async cancelRun(runId: string, signal?: AbortSignal): Promise<void> {
    if (!runId) throw new TaskRunClientError('runId must not be empty')
    await this.request(
      `/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
      signal,
    )
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.requestUrl(new URL(this.endpoint(path)), init, signal)
  }

  private async requestUrl(
    url: URL,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    assertNotAborted(signal)
    const headers = new Headers(this.commonHeaders)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    let response: Response
    try {
      response = await this.fetchImplementation(url, {
        ...init,
        headers,
        signal,
        cache: 'no-store',
      })
    } catch (error) {
      if (isAbort(error, signal)) {
        if (signal?.aborted) throw abortReason(signal)
        throw error
      }
      throw new TaskRunClientError(`Unable to reach daemon at ${this.baseUrl}`, { cause: error })
    }

    if (!response.ok) {
      let body = ''
      try {
        body = errorBodyExcerpt(await response.text())
      } catch (error) {
        if (isAbort(error, signal)) {
          if (signal?.aborted) throw abortReason(signal)
          throw error
        }
      }
      throw new TaskRunHttpError(response.status, response.statusText, body)
    }
    return response
  }

  private async readJson(response: Response, context: string): Promise<unknown> {
    const text = await response.text()
    if (!text.trim()) throw new TaskRunProtocolError(`${context} was empty`)
    return parseJson(text, context)
  }



}
