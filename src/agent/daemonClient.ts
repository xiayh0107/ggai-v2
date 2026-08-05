import type { AgentTransport } from './runtime'
import type { CanvasNode, Edge } from '@/types/canvas'
import type { AgentSession, CanvasAgentEvent } from './types'
import { inspectRunOutcome, type RunOutcome } from './outcome'
import type { GenerationPanelState } from './generationProgress'
import { consumeSse } from './sse'
import {
  decodeCanvasBranchList,
  decodeCanvasHistoryPage,
  decodeCanvasPreferences,
  decodeCanvasVersionOperation,
  decodeCanvasVersionStatuses,
  decodeSourceBranchBinding,
  decodeSourceCheckpoint,
  decodeSourceGitStatus,
  decodeWorkspaceBranch,
  decodeWorkspaceCheckpoint,
  decodeWorkspaceDeleteBranch,
  decodeWorkspaceMergeExecution,
  decodeWorkspaceMergePreview,
  type BindCanvasSourceRequest,
  type CanvasGitBranch,
  type CanvasGitHistoryPage,
  type CanvasHistoryQuery,
  type CanvasPreferences,
  type CanvasVersionOperation,
  type CanvasVersionQuery,
  type CanvasVersionStatuses,
  type CreateCanvasBranchRequest,
  type CreateCanvasCheckpointRequest,
  type CreateCanvasSourceCheckpointRequest,
  type DeleteCanvasBranchRequest,
  type ExecuteCanvasMergeRequest,
  type PreviewCanvasMergeRequest,
  type PutCanvasPreferencesRequest,
  type RestoreCanvasCheckpointRequest,
  type SourceBranchBinding,
  type SourceCheckpoint,
  type SourceGitStatus,
  type WorkspaceBranch,
  type WorkspaceCheckpoint,
  type WorkspaceDeleteBranch,
  type WorkspaceMergeExecution,
  type WorkspaceMergePreview,
} from './canvasVersioning'

export type {
  BindCanvasSourceRequest,
  CanvasAutomationMode,
  CanvasGitBranch,
  CanvasGitHistoryEntry,
  CanvasGitHistoryPage,
  CanvasGitStatus,
  CanvasMergeConflict,
  CanvasMergeConflictKind,
  CanvasMergeExecution,
  CanvasMergePreview,
  CanvasMergeResolution,
  CanvasMergeResolutionProposal,
  CanvasMergeState,
  CanvasHistoryQuery,
  CanvasPreferences,
  CanvasVersionOperation,
  CanvasVersionQuery,
  CanvasVersionStatuses,
  CreateCanvasBranchRequest,
  CreateCanvasCheckpointRequest,
  CreateCanvasSourceCheckpointRequest,
  DeleteCanvasBranchRequest,
  ExecuteCanvasMergeRequest,
  PutCanvasPreferencesRequest,
  PreviewCanvasMergeRequest,
  RestoreCanvasCheckpointRequest,
  SourceBranchBinding,
  SourceCheckpoint,
  SourceGitStatus,
  WorkspaceBranch,
  WorkspaceCheckpoint,
  WorkspaceDeleteBranch,
  WorkspaceMergeExecution,
  WorkspaceMergeExpectation,
  WorkspaceMergePreview,
} from './canvasVersioning'

export const DEFAULT_DAEMON_BASE_URL = 'http://127.0.0.1:7380'
const CREATE_RUN_TIMEOUT_MS = 15_000
const MAX_TEXT_ARTIFACT_BYTES = 1 * 1024 * 1024

type FetchImplementation = typeof globalThis.fetch
type TransportRunOptions = Parameters<AgentTransport['run']>[0]

export interface DaemonClientOptions {
  /** HTTP origin (and optional path prefix) of the local daemon. */
  baseUrl?: string
  /** Primarily useful for tests or an Electron IPC-to-fetch bridge. */
  fetch?: FetchImplementation
  /** Headers sent with every request (for example a per-launch daemon token). */
  headers?: HeadersInit
  /** Temporary compatibility hook until nodeId is present on AgentTransport.run. */
  defaultNodeId?: string
}

export interface DaemonAgent {
  id: string
  label: string
  transport: 'acpx' | 'codex'
  available: boolean
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown' | 'not-applicable'
  version?: string
  binaryPath?: string
  detail?: string
  models: string[]
}

export interface DaemonSession extends AgentSession {
  runId?: string
  status?: DaemonRunStatus
}

export type DaemonRunStatus =
  | 'preparing'
  | 'running'
  | 'awaiting-permission'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export type DaemonCloseStatus = Extract<DaemonRunStatus, 'done' | 'error' | 'cancelled'>

export interface DaemonSessionsQuery {
  canvasBranch?: string
  nodeId?: string
  agentId?: string
  /** Project-relative directory whose daemon-owned sessions.json should be queried. */
  projectDir?: string
}

export type PermissionDecision = 'allow' | 'deny'

export interface PermissionResolution {
  decision: PermissionDecision
  /** Whether the same decision may be reused for this run. */
  remember?: boolean
  reason?: string
}

export interface DaemonCreateRunRequest {
  /** Client-generated idempotency and cancellation handle. */
  runId?: string
  nodeId: string
  agentId: string
  prompt: string
  projectDir: string
  canvasBranch?: string
  automationMode?: 'auto' | 'confirm'
  /** A non-null value asks the daemon/underlying Agent to resume this session. */
  sessionId?: string | null
  canvasSnapshot?: DaemonCanvasSnapshot
}

export interface DaemonPluginContract {
  id: string
  label: string
  description: string
  instruction?: {
    placeholder: string
    actions: string[]
  }
  initialPayload?: Record<string, unknown>
}

export interface DaemonCanvasSnapshot {
  nodes: CanvasNode[]
  edges: Edge[]
  plugins?: DaemonPluginContract[]
}

/** Durable canvas payload owned by the daemon. Ephemeral UI state stays out. */
export interface DaemonCanvasDocumentV1 {
  schemaVersion: 1
  nodes: CanvasNode[]
  edges: Edge[]
  everCreated: boolean
  /** Compatibility snapshot until durable run logs become the only source. */
  generationByNodeId: Record<string, GenerationPanelState>
  latestRunByNodeId: Record<string, string>
  runRefsByNodeId: Record<string, DaemonCanvasRunRef>
}

export interface DaemonCanvasRunRef {
  runId: string
  lastEventId: number
  previousPhase: 'idle' | 'done'
}

export interface DaemonCanvasEnvelope {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  lastCheckpoint: string | null
  document: DaemonCanvasDocumentV1
}

export interface DaemonCanvasQuery {
  projectDir?: string
  branch?: string
}

export interface DaemonSaveCanvasRequest {
  baseRevision: number
  mutationId: string
  changeKind: string
  document: DaemonCanvasDocumentV1
}

export interface DaemonCreateRunResponse {
  runId: string
  /** Some daemon implementations can resolve this before opening the stream. */
  sessionId?: string
}

export interface DaemonCloseEvent {
  runId: string
  status: DaemonCloseStatus
  sessionId: string | null
  artifacts: string[]
  artifactsComplete: boolean
  artifactManifest?: DaemonArtifactManifestV1
  outcome?: RunOutcome
}

export interface DaemonArtifactManifestEntryV1 {
  artifactId: string
  relativePath: string
  mediaType: string
  size: number
  contentDigest: string
}

export interface DaemonArtifactManifestV1 {
  version: 1
  runId: string
  complete: boolean
  entries: DaemonArtifactManifestEntryV1[]
}

export interface DaemonRunStreamOptions {
  onEvent: (event: CanvasAgentEvent) => void
  signal?: AbortSignal
  projectDir?: string
  afterEventId?: number
  onEventId?: (eventId: number) => void
  /** A resumed session can be used if the daemon does not repeat its id. */
  sessionId?: string | null
  onSessionId?: (sessionId: string) => void
}

export interface DaemonRunStreamResult {
  sessionId: string | null
  close: DaemonCloseEvent
  stopReason: Extract<CanvasAgentEvent, { type: 'done' }>['stopReason'] | null
}

export interface DaemonRunSummary {
  runId: string
  nodeId: string
  agentId: string
  /** Legacy summaries without this field are normalized to `main` at decode time. */
  canvasBranch: string
  status: DaemonRunStatus
  startedAt: number
  finishedAt?: number
  sessionId: string | null
  error?: string
  logAvailable?: boolean
}

export interface DaemonRunsQuery {
  projectDir?: string
  nodeId?: string
  branch?: string
  limit?: number
}

export interface DaemonRunLogEntry {
  id: number
  recordedAt: number
  event: 'agent-event' | 'session' | 'close'
  data: unknown
}

export interface DaemonRunLogPage {
  entries: DaemonRunLogEntry[]
  nextEventId: number | null
}

export type DecodedDaemonRunLogEntry =
  | { id: number; event: 'agent-event'; data: CanvasAgentEvent }
  | { id: number; event: 'session'; data: { sessionId: string } }
  | { id: number; event: 'close'; data: DaemonCloseEvent }

/**
 * Additional fields accepted by DaemonClient.run. They remain optional so this
 * class is structurally compatible with the current AgentTransport interface;
 * runtime integration should always pass nodeId.
 */
export type DaemonTransportRunOptions = TransportRunOptions & {
  runId?: string
  nodeId?: string
  canvasBranch?: string
  automationMode?: 'auto' | 'confirm'
  canvasSnapshot?: DaemonCanvasSnapshot
  plugins?: DaemonPluginContract[]
}

export class DaemonClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DaemonClientError'
  }
}

export class DaemonHttpError extends DaemonClientError {
  readonly status: number
  readonly statusText: string
  readonly responseBody: string

  constructor(status: number, statusText: string, responseBody: string) {
    const detail = responseBody ? `: ${responseBody}` : ''
    super(`Daemon request failed with HTTP ${status} ${statusText}${detail}`)
    this.name = 'DaemonHttpError'
    this.status = status
    this.statusText = statusText
    this.responseBody = responseBody
  }
}

export class DaemonProtocolError extends DaemonClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DaemonProtocolError'
  }
}

export class DaemonRunError extends DaemonClientError {
  readonly runId: string
  readonly status: DaemonCloseStatus | null
  readonly artifacts: string[]
  readonly artifactsComplete: boolean

  constructor(
    runId: string,
    message: string,
    status: DaemonCloseStatus | null = null,
    artifacts: string[] = [],
    artifactsComplete = false,
  ) {
    super(message)
    this.name = 'DaemonRunError'
    this.runId = runId
    this.status = status
    this.artifacts = artifacts
    this.artifactsComplete = artifactsComplete
  }
}

export class DaemonRunStartUncertainError extends DaemonClientError {
  readonly runId: string

  constructor(runId: string, options?: ErrorOptions) {
    super(`Run ${runId} may have been accepted; recovery will verify it`, options)
    this.name = 'DaemonRunStartUncertainError'
    this.runId = runId
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
  return value === 'done' || value === 'error' || value === 'cancelled'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function decodeRunOutcome(value: unknown, context: string): RunOutcome | undefined {
  const inspection = inspectRunOutcome(value)
  // A future semantic-result schema must not make an otherwise valid terminal
  // close unreadable. Unsupported versions simply have no materialized view.
  if (inspection.status === 'unsupported') return undefined
  if (inspection.status === 'valid') return inspection.outcome
  throw new DaemonProtocolError(`${context} was not a valid RunOutcome`)
}

function isSuggestedActionsCache(value: unknown): boolean {
  if (!isRecord(value)
    || Object.keys(value).length !== 4
    || Object.keys(value).length !== 2
    || !isNonEmptyString(value.runId)
    || value.runId.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value.runId)) return false
  return inspectRunOutcome({
    schemaVersion: 1,
    suggestedActions: value.actions,
  }).status === 'valid'
}

function isCanvasNode(value: unknown): value is CanvasNode {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.type)
    || !isFiniteNumber(value.x)
    || !isFiniteNumber(value.y)
    || !isFiniteNumber(value.w)
    || !isFiniteNumber(value.h)
    || typeof value.title !== 'string'
    || !isRecord(value.instruction)
    || (value.instruction.phase !== 'idle'
      && value.instruction.phase !== 'generating'
      && value.instruction.phase !== 'done')
    || typeof value.instruction.prompt !== 'string'
    || !isStringArray(value.instruction.attachments)
    || !isStringArray(value.instruction.sources)
    || (value.instruction.suggestedActions !== undefined
      && !isSuggestedActionsCache(value.instruction.suggestedActions))
    || typeof value.instruction.open !== 'boolean') {
    return false
  }
  if (value.text !== undefined && typeof value.text !== 'string') return false
  if (value.meta !== undefined && !isStringArray(value.meta)) return false
  if (value.bold !== undefined && typeof value.bold !== 'boolean') return false
  if (value.italic !== undefined && typeof value.italic !== 'boolean') return false
  if (value.heading !== undefined
    && value.heading !== 0
    && value.heading !== 1
    && value.heading !== 2) return false
  if (value.payload !== undefined && !isRecord(value.payload)) return false
  if (value.smart !== undefined) {
    if (!isRecord(value.smart)
      || (value.smart.chartType !== '柱状图'
        && value.smart.chartType !== '折线图'
        && value.smart.chartType !== '面积图')
      || (value.smart.style !== '简洁'
        && value.smart.style !== '学术'
        && value.smart.style !== '信息图')
      || !isFiniteNumber(value.smart.count)
      || !isFiniteNumber(value.smart.seed)) return false
  }
  return true
}

function isCanvasEdge(value: unknown): value is Edge {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.from)
    && isNonEmptyString(value.to)
    && typeof value.label === 'string'
}

function isGenerationActivity(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.key)
    && typeof value.kind === 'string'
    && GENERATION_ACTIVITY_KINDS.has(value.kind)
    && typeof value.label === 'string'
}

function isGenerationPanel(value: unknown): value is GenerationPanelState {
  return isRecord(value)
    && Number.isSafeInteger(value.epoch)
    && (value.epoch as number) >= 0
    && isGenerationActivity(value.current)
    && Array.isArray(value.recent)
    && value.recent.every(isGenerationActivity)
    && Array.isArray(value.log)
    && value.log.every((entry) => isRecord(entry)
      && typeof entry.kind === 'string'
      && GENERATION_LOG_KINDS.has(entry.kind)
      && typeof entry.text === 'string')
}

function decodeStringRecord(value: unknown, context: string): Record<string, string> {
  if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === 'string')) {
    throw new DaemonProtocolError(`${context} was not a string record`)
  }
  return value as Record<string, string>
}

function decodeGenerationRecord(
  value: unknown,
  context: string,
): Record<string, GenerationPanelState> {
  if (!isRecord(value) || !Object.values(value).every(isGenerationPanel)) {
    throw new DaemonProtocolError(`${context} was not a generation panel record`)
  }
  return value as Record<string, GenerationPanelState>
}

function decodeRunRefRecord(
  value: unknown,
  context: string,
): Record<string, DaemonCanvasRunRef> {
  if (!isRecord(value)) throw new DaemonProtocolError(`${context} was not a run reference record`)
  const refs: Record<string, DaemonCanvasRunRef> = {}
  for (const [nodeId, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)
      || !isNonEmptyString(candidate.runId)
      || !Number.isSafeInteger(candidate.lastEventId)
      || (candidate.lastEventId as number) < 0
      || (candidate.previousPhase !== 'idle' && candidate.previousPhase !== 'done')) {
      throw new DaemonProtocolError(`${context}.${nodeId} was not a valid run reference`)
    }
    refs[nodeId] = {
      runId: candidate.runId,
      lastEventId: candidate.lastEventId as number,
      previousPhase: candidate.previousPhase,
    }
  }
  return refs
}

function decodeCanvasDocument(value: unknown, context: string): DaemonCanvasDocumentV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.nodes)
    || !value.nodes.every(isCanvasNode)
    || !Array.isArray(value.edges)
    || !value.edges.every(isCanvasEdge)
    || typeof value.everCreated !== 'boolean') {
    throw new DaemonProtocolError(`${context} did not contain a valid canvas document`)
  }
  return {
    schemaVersion: 1,
    nodes: value.nodes,
    edges: value.edges,
    everCreated: value.everCreated,
    generationByNodeId: decodeGenerationRecord(
      value.generationByNodeId ?? {},
      `${context} generationByNodeId`,
    ),
    latestRunByNodeId: decodeStringRecord(
      value.latestRunByNodeId ?? {},
      `${context} latestRunByNodeId`,
    ),
    runRefsByNodeId: decodeRunRefRecord(
      value.runRefsByNodeId ?? {},
      `${context} runRefsByNodeId`,
    ),
  }
}

/** Strict decoder shared with the IndexedDB recovery layer. */
export function decodeDaemonCanvasDocument(
  value: unknown,
  context = 'canvas document',
): DaemonCanvasDocumentV1 {
  return decodeCanvasDocument(value, context)
}

function decodeCanvasEnvelope(value: unknown, context: string): DaemonCanvasEnvelope {
  if (!isRecord(value)
    || !isNonEmptyString(value.branch)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || typeof value.updatedAt !== 'string'
    || !(value.lastMutationId === null || isNonEmptyString(value.lastMutationId))
    || !(value.lastCheckpoint === null || isNonEmptyString(value.lastCheckpoint))) {
    throw new DaemonProtocolError(`${context} did not contain a valid canvas envelope`)
  }
  return {
    branch: value.branch,
    revision: value.revision as number,
    updatedAt: value.updatedAt,
    lastMutationId: value.lastMutationId,
    lastCheckpoint: value.lastCheckpoint,
    document: decodeCanvasDocument(value.document, `${context} document`),
  }
}

/** Strict envelope decoder for adjacent versioning protocol decoders. */
export function decodeDaemonCanvasEnvelope(
  value: unknown,
  context = 'canvas envelope',
): DaemonCanvasEnvelope {
  return decodeCanvasEnvelope(value, context)
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
    throw new DaemonClientError(`Invalid daemon base URL: ${input}`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DaemonClientError('Daemon base URL must use http: or https:')
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
    throw new DaemonProtocolError(`${context} contained invalid JSON: ${excerpt}`, { cause: error })
  }
}

function decodeVersioningPayload<T>(
  value: unknown,
  context: string,
  decoder: (value: unknown, context: string) => T,
): T {
  try {
    return decoder(value, context)
  } catch (error) {
    if (error instanceof DaemonProtocolError) throw error
    throw new DaemonProtocolError(
      error instanceof Error ? error.message : `${context} was malformed`,
      { cause: error },
    )
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

function shortDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function decodeAgentEvent(value: unknown, context: string): AgentEventEnvelope {
  let candidate = value
  let sessionId: string | undefined

  if (isRecord(value)) {
    if (isNonEmptyString(value.sessionId)) sessionId = value.sessionId
    if (hasOwn(value, 'event')) candidate = value.event
  }
  if (!isCanvasAgentEvent(candidate)) {
    throw new DaemonProtocolError(`${context} was not a valid CanvasAgentEvent`)
  }
  return { event: candidate, sessionId }
}

function decodeSessionId(value: unknown, context: string): string {
  if (isNonEmptyString(value)) return value
  if (isRecord(value) && isNonEmptyString(value.sessionId)) return value.sessionId
  throw new DaemonProtocolError(`${context} did not contain a non-empty sessionId`)
}

function decodeCloseEvent(value: unknown, expectedRunId: string): DaemonCloseEvent {
  if (!isRecord(value)
    || !isNonEmptyString(value.runId)
    || !isCloseStatus(value.status)
    || !Array.isArray(value.artifacts)
    || !value.artifacts.every((artifact) => isNonEmptyString(artifact))
    || typeof value.artifactsComplete !== 'boolean') {
    throw new DaemonProtocolError('SSE close event was malformed')
  }
  if (value.runId !== expectedRunId) {
    throw new DaemonProtocolError(
      `SSE close event runId mismatch (expected ${expectedRunId}, received ${value.runId})`,
    )
  }
  if (value.sessionId !== undefined
    && value.sessionId !== null
    && !isNonEmptyString(value.sessionId)) {
    throw new DaemonProtocolError('SSE close event had an invalid sessionId')
  }
  const outcome = value.outcome !== undefined
    ? decodeRunOutcome(value.outcome, 'SSE close event outcome')
    : undefined
  const artifactManifest = value.artifactManifest === undefined
    ? undefined
    : decodeArtifactManifestV1(value.artifactManifest, expectedRunId)
  return {
    runId: value.runId,
    status: value.status,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    artifacts: value.artifacts as string[],
    artifactsComplete: value.artifactsComplete,
    ...(artifactManifest ? { artifactManifest } : {}),
    ...(outcome ? { outcome } : {}),
  }
}

function decodeArtifactManifestV1(
  value: unknown,
  expectedRunId: string,
): DaemonArtifactManifestV1 {
  if (!isRecord(value)
    || value.version !== 1
    || value.runId !== expectedRunId
    || typeof value.complete !== 'boolean'
    || !Array.isArray(value.entries)) {
    throw new DaemonProtocolError('SSE close event artifact manifest was malformed')
  }
  const paths = new Set<string>()
  const artifactIds = new Set<string>()
  const entries = value.entries.map((entry, index): DaemonArtifactManifestEntryV1 => {
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
      throw new DaemonProtocolError(
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
    throw new DaemonProtocolError('SSE event contained an invalid id')
  }
  return parsed
}

function decodeRunSummary(value: unknown): DaemonRunSummary {
  if (!isRecord(value)
    || !isNonEmptyString(value.runId)
    || !isNonEmptyString(value.nodeId)
    || !isNonEmptyString(value.agentId)
    || !isRunStatus(value.status)
    || !isFiniteNumber(value.startedAt)
    || !(value.sessionId === null || isNonEmptyString(value.sessionId))) {
    throw new DaemonProtocolError('GET /runs/:id response was malformed')
  }
  if (value.finishedAt !== undefined && !isFiniteNumber(value.finishedAt)) {
    throw new DaemonProtocolError('GET /runs/:id response had an invalid finishedAt')
  }
  if (value.canvasBranch !== undefined && !isNonEmptyString(value.canvasBranch)) {
    throw new DaemonProtocolError('GET /runs/:id response had an invalid canvasBranch')
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new DaemonProtocolError('GET /runs/:id response had an invalid error')
  }
  if (value.logAvailable !== undefined && typeof value.logAvailable !== 'boolean') {
    throw new DaemonProtocolError('GET /runs/:id response had an invalid logAvailable')
  }
  return {
    runId: value.runId,
    nodeId: value.nodeId,
    agentId: value.agentId,
    canvasBranch: typeof value.canvasBranch === 'string' ? value.canvasBranch : 'main',
    status: value.status,
    startedAt: value.startedAt,
    sessionId: value.sessionId,
    ...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.logAvailable === 'boolean' ? { logAvailable: value.logAvailable } : {}),
  }
}

function decodeRunLogPage(value: unknown): DaemonRunLogPage {
  if (!isRecord(value)
    || !Array.isArray(value.entries)
    || !(value.nextEventId === null
      || (Number.isSafeInteger(value.nextEventId) && (value.nextEventId as number) > 0))) {
    throw new DaemonProtocolError('GET /runs/:id/log response was malformed')
  }
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry)
      || !Number.isSafeInteger(entry.id)
      || (entry.id as number) < 1
      || !isFiniteNumber(entry.recordedAt)
      || (entry.event !== 'agent-event' && entry.event !== 'session' && entry.event !== 'close')) {
      throw new DaemonProtocolError('GET /runs/:id/log response contained an invalid entry')
    }
    return entry as unknown as DaemonRunLogEntry
  })
  return { entries, nextEventId: value.nextEventId as number | null }
}

export function decodeDaemonRunLogEntry(
  entry: DaemonRunLogEntry,
  expectedRunId: string,
): DecodedDaemonRunLogEntry {
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

/** Browser-side HTTP/SSE implementation of AgentTransport. */
export class DaemonClient implements AgentTransport {
  readonly baseUrl: string
  private readonly fetchImplementation: FetchImplementation
  private readonly commonHeaders: Headers
  private readonly defaultNodeId?: string
  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_DAEMON_BASE_URL)
    this.fetchImplementation = options.fetch
      ?? ((input, init) => globalThis.fetch(input, init))
    this.commonHeaders = new Headers(options.headers)
    this.defaultNodeId = options.defaultNodeId
  }

  /** Snapshot of active run ids, useful for wiring a Cancel button. */
  get activeRunIds(): readonly string[] {
    return [...this.activeRuns.keys()]
  }

  /** GET /agents */
  async agents(signal?: AbortSignal): Promise<DaemonAgent[]> {
    const response = await this.request('/agents', { method: 'GET' }, signal)
    const payload = await this.readJson(response, 'GET /agents response')
    const candidates = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.agents) ? payload.agents : null

    if (!candidates) throw new DaemonProtocolError('GET /agents response did not contain an agent list')
    return candidates.map((candidate, index) => this.decodeAgent(candidate, index))
  }

  async listAgents(signal?: AbortSignal): Promise<DaemonAgent[]> {
    return this.agents(signal)
  }

  /** Read a generated text artifact through the daemon's project boundary. */
  async artifactText(
    artifactPath: string,
    projectDir = '.',
    signal?: AbortSignal,
  ): Promise<string> {
    if (!artifactPath) throw new DaemonClientError('artifactPath must not be empty')
    const url = new URL(this.endpoint('/artifacts'))
    url.searchParams.set('projectDir', projectDir)
    url.searchParams.set('path', artifactPath)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > MAX_TEXT_ARTIFACT_BYTES) {
      throw new DaemonProtocolError('Text artifact is too large to preview')
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_TEXT_ARTIFACT_BYTES) {
      throw new DaemonProtocolError('Text artifact is too large to preview')
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new DaemonProtocolError('Text artifact was not valid UTF-8', { cause: error })
    }
  }

  /** Read one immutable V2 artifact by its daemon-authored manifest identity. */
  async runArtifactText(
    runId: string,
    artifactId: string,
    projectDir = '.',
    signal?: AbortSignal,
  ): Promise<string> {
    if (!isNonEmptyString(runId)) throw new DaemonClientError('runId must not be empty')
    if (!/^artifact_[0-9a-f]{64}$/u.test(artifactId)) {
      throw new DaemonClientError('artifactId is invalid')
    }
    const url = new URL(this.endpoint(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    ))
    url.searchParams.set('projectDir', projectDir)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > MAX_TEXT_ARTIFACT_BYTES) {
      throw new DaemonProtocolError('Text artifact is too large to preview')
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_TEXT_ARTIFACT_BYTES) {
      throw new DaemonProtocolError('Text artifact is too large to preview')
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new DaemonProtocolError('Text artifact was not valid UTF-8', { cause: error })
    }
  }

  /** GET /sessions?nodeId=... */
  async sessions(
    query: DaemonSessionsQuery = {},
    signal?: AbortSignal,
  ): Promise<DaemonSession[]> {
    const url = new URL(this.endpoint('/sessions'))
    if (query.canvasBranch !== undefined) url.searchParams.set('branch', query.canvasBranch)
    if (query.nodeId !== undefined) url.searchParams.set('nodeId', query.nodeId)
    if (query.agentId !== undefined) url.searchParams.set('agentId', query.agentId)
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)

    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    const payload = await this.readJson(response, 'GET /sessions response')
    let candidates: unknown[] | null = null
    if (Array.isArray(payload)) candidates = payload
    else if (isRecord(payload) && Array.isArray(payload.sessions)) candidates = payload.sessions
    else if (isRecord(payload)) candidates = Object.values(payload)

    if (!candidates) {
      throw new DaemonProtocolError('GET /sessions response did not contain a session list')
    }
    return candidates.map((candidate, index) => this.decodeSession(candidate, index))
  }

  async listSessions(
    query: DaemonSessionsQuery = {},
    signal?: AbortSignal,
  ): Promise<DaemonSession[]> {
    return this.sessions(query, signal)
  }

  /** GET /canvas?projectDir=...&branch=... */
  async getCanvas(
    query: DaemonCanvasQuery = {},
    signal?: AbortSignal,
  ): Promise<DaemonCanvasEnvelope> {
    const url = new URL(this.endpoint('/canvas'))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    if (query.branch !== undefined) url.searchParams.set('branch', query.branch)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodeCanvasEnvelope(
      await this.readJson(response, 'GET /canvas response'),
      'GET /canvas response',
    )
  }

  /** PUT /canvas?projectDir=...&branch=... */
  async putCanvas(
    request: DaemonSaveCanvasRequest,
    query: DaemonCanvasQuery = {},
    signal?: AbortSignal,
  ): Promise<DaemonCanvasEnvelope> {
    if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) {
      throw new DaemonClientError('baseRevision must be a non-negative safe integer')
    }
    if (!request.mutationId) throw new DaemonClientError('mutationId must not be empty')
    if (!request.changeKind) throw new DaemonClientError('changeKind must not be empty')
    const url = new URL(this.endpoint('/canvas'))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    if (query.branch !== undefined) url.searchParams.set('branch', query.branch)
    const response = await this.requestUrl(
      url,
      { method: 'PUT', body: JSON.stringify(request) },
      signal,
    )
    return decodeCanvasEnvelope(
      await this.readJson(response, 'PUT /canvas response'),
      'PUT /canvas response',
    )
  }

  /** GET /canvas/status */
  async getCanvasStatus(
    query: CanvasVersionQuery = {},
    signal?: AbortSignal,
  ): Promise<CanvasVersionStatuses> {
    const url = new URL(this.endpoint('/canvas/status'))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodeVersioningPayload(
      await this.readJson(response, 'GET /canvas/status response'),
      'GET /canvas/status response',
      decodeCanvasVersionStatuses,
    )
  }

  /** GET /canvas/branches */
  async listCanvasBranches(
    query: CanvasVersionQuery = {},
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<CanvasGitBranch[]>> {
    const url = new URL(this.endpoint('/canvas/branches'))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodeVersioningPayload(
      await this.readJson(response, 'GET /canvas/branches response'),
      'GET /canvas/branches response',
      (payload, context) => decodeCanvasVersionOperation(
        payload,
        context,
        decodeCanvasBranchList,
      ),
    )
  }

  /** POST /canvas/branches */
  async createCanvasBranch(
    request: CreateCanvasBranchRequest,
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<WorkspaceBranch>> {
    if (!request.name.trim()) throw new DaemonClientError('branch name must not be empty')
    const response = await this.request(
      '/canvas/branches',
      { method: 'POST', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'POST /canvas/branches response'),
      'POST /canvas/branches response',
      (payload, context) => decodeCanvasVersionOperation(
        payload,
        context,
        (candidate, candidateContext) => decodeWorkspaceBranch(
          candidate,
          candidateContext,
          decodeCanvasEnvelope,
        ),
      ),
    )
  }

  /** DELETE /canvas/branches */
  async deleteCanvasBranch(
    request: DeleteCanvasBranchRequest,
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<WorkspaceDeleteBranch>> {
    if (!request.branch.trim()) throw new DaemonClientError('branch must not be empty')
    const response = await this.request(
      '/canvas/branches',
      { method: 'DELETE', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'DELETE /canvas/branches response'),
      'DELETE /canvas/branches response',
      (payload, context) => decodeCanvasVersionOperation(
        payload,
        context,
        decodeWorkspaceDeleteBranch,
      ),
    )
  }

  /** GET /canvas/history */
  async getCanvasHistory(
    query: CanvasHistoryQuery,
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<CanvasGitHistoryPage>> {
    if (!query.branch.trim()) throw new DaemonClientError('branch must not be empty')
    const url = new URL(this.endpoint('/canvas/history'))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    url.searchParams.set('branch', query.branch)
    if (query.cursor !== undefined) url.searchParams.set('cursor', query.cursor)
    if (query.limit !== undefined) url.searchParams.set('limit', String(query.limit))
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodeVersioningPayload(
      await this.readJson(response, 'GET /canvas/history response'),
      'GET /canvas/history response',
      (payload, context) => decodeCanvasVersionOperation(payload, context, decodeCanvasHistoryPage),
    )
  }

  /** POST /canvas/checkpoints */
  async createCanvasCheckpoint(
    request: CreateCanvasCheckpointRequest,
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<WorkspaceCheckpoint>> {
    if (!request.branch.trim()) throw new DaemonClientError('branch must not be empty')
    const response = await this.request(
      '/canvas/checkpoints',
      { method: 'POST', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'POST /canvas/checkpoints response'),
      'POST /canvas/checkpoints response',
      (payload, context) => decodeCanvasVersionOperation(
        payload,
        context,
        (candidate, candidateContext) => decodeWorkspaceCheckpoint(
          candidate,
          candidateContext,
          decodeCanvasEnvelope,
        ),
      ),
    )
  }

  /** POST /canvas/restores; restores always materialize into a new branch. */
  async restoreCanvasCheckpoint(
    request: RestoreCanvasCheckpointRequest,
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<WorkspaceBranch>> {
    if (!request.sourceBranch.trim()) throw new DaemonClientError('sourceBranch must not be empty')
    if (!request.newBranch.trim()) throw new DaemonClientError('newBranch must not be empty')
    if (!request.checkpoint.trim()) throw new DaemonClientError('checkpoint must not be empty')
    const response = await this.request(
      '/canvas/restores',
      { method: 'POST', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'POST /canvas/restores response'),
      'POST /canvas/restores response',
      (payload, context) => decodeCanvasVersionOperation(
        payload,
        context,
        (candidate, candidateContext) => decodeWorkspaceBranch(
          candidate,
          candidateContext,
          decodeCanvasEnvelope,
        ),
      ),
    )
  }

  /** POST /canvas/merges/preview; this never mutates either branch. */
  async previewCanvasMerge(
    request: PreviewCanvasMergeRequest,
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<WorkspaceMergePreview>> {
    if (!request.sourceBranch.trim()) throw new DaemonClientError('sourceBranch must not be empty')
    if (!request.targetBranch.trim()) throw new DaemonClientError('targetBranch must not be empty')
    if (request.sourceBranch === request.targetBranch) {
      throw new DaemonClientError('merge source and target branches must be different')
    }
    const response = await this.request(
      '/canvas/merges/preview',
      { method: 'POST', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'POST /canvas/merges/preview response'),
      'POST /canvas/merges/preview response',
      (payload, context) => decodeCanvasVersionOperation(
        payload,
        context,
        decodeWorkspaceMergePreview,
      ),
    )
  }

  /** POST /canvas/merges; the literal `confirmed: true` is mandatory. */
  async executeCanvasMerge(
    request: ExecuteCanvasMergeRequest,
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<WorkspaceMergeExecution>> {
    if (!request.sourceBranch.trim()) throw new DaemonClientError('sourceBranch must not be empty')
    if (!request.targetBranch.trim()) throw new DaemonClientError('targetBranch must not be empty')
    if (request.sourceBranch === request.targetBranch) {
      throw new DaemonClientError('merge source and target branches must be different')
    }
    if (request.confirmed !== true) {
      throw new DaemonClientError('merge execution requires explicit confirmation')
    }
    const response = await this.request(
      '/canvas/merges',
      { method: 'POST', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'POST /canvas/merges response'),
      'POST /canvas/merges response',
      (payload, context) => decodeCanvasVersionOperation(
        payload,
        context,
        (candidate, candidateContext) => decodeWorkspaceMergeExecution(
          candidate,
          candidateContext,
          decodeCanvasEnvelope,
        ),
      ),
    )
  }

  /** GET /canvas/source */
  async getCanvasSourceStatus(
    query: CanvasVersionQuery = {},
    signal?: AbortSignal,
  ): Promise<SourceGitStatus> {
    const url = new URL(this.endpoint('/canvas/source'))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodeVersioningPayload(
      await this.readJson(response, 'GET /canvas/source response'),
      'GET /canvas/source response',
      decodeSourceGitStatus,
    )
  }

  /** POST /canvas/source/bind */
  async bindCanvasSource(
    request: BindCanvasSourceRequest = {},
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<SourceBranchBinding>> {
    const response = await this.request(
      '/canvas/source/bind',
      { method: 'POST', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'POST /canvas/source/bind response'),
      'POST /canvas/source/bind response',
      (payload, context) => decodeCanvasVersionOperation(
        payload,
        context,
        decodeSourceBranchBinding,
      ),
    )
  }

  /** POST /canvas/source/checkpoints */
  async createCanvasSourceCheckpoint(
    request: CreateCanvasSourceCheckpointRequest,
    signal?: AbortSignal,
  ): Promise<CanvasVersionOperation<SourceCheckpoint>> {
    if (!request.branch.trim()) throw new DaemonClientError('branch must not be empty')
    if (!request.runId.trim()) throw new DaemonClientError('runId must not be empty')
    if (!request.nodeTitle.trim()) throw new DaemonClientError('nodeTitle must not be empty')
    const response = await this.request(
      '/canvas/source/checkpoints',
      { method: 'POST', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'POST /canvas/source/checkpoints response'),
      'POST /canvas/source/checkpoints response',
      (payload, context) => decodeCanvasVersionOperation(payload, context, decodeSourceCheckpoint),
    )
  }

  /** GET /canvas/preferences */
  async getCanvasPreferences(
    query: CanvasVersionQuery = {},
    signal?: AbortSignal,
  ): Promise<CanvasPreferences> {
    const url = new URL(this.endpoint('/canvas/preferences'))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodeVersioningPayload(
      await this.readJson(response, 'GET /canvas/preferences response'),
      'GET /canvas/preferences response',
      decodeCanvasPreferences,
    )
  }

  /** PUT /canvas/preferences */
  async putCanvasPreferences(
    request: PutCanvasPreferencesRequest,
    signal?: AbortSignal,
  ): Promise<CanvasPreferences> {
    if (request.automationMode !== 'auto' && request.automationMode !== 'confirm') {
      throw new DaemonClientError('automationMode must be "auto" or "confirm"')
    }
    const response = await this.request(
      '/canvas/preferences',
      { method: 'PUT', body: JSON.stringify(request) },
      signal,
    )
    return decodeVersioningPayload(
      await this.readJson(response, 'PUT /canvas/preferences response'),
      'PUT /canvas/preferences response',
      decodeCanvasPreferences,
    )
  }

  /** POST /permissions/:id */
  async permissions(
    permissionId: string,
    resolution: PermissionDecision | PermissionResolution,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!permissionId) throw new DaemonClientError('permissionId must not be empty')
    const body: PermissionResolution = typeof resolution === 'string'
      ? { decision: resolution }
      : resolution
    if (body.decision !== 'allow' && body.decision !== 'deny') {
      throw new DaemonClientError('permission decision must be "allow" or "deny"')
    }
    if (body.remember !== undefined && typeof body.remember !== 'boolean') {
      throw new DaemonClientError('permission remember flag must be a boolean')
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      throw new DaemonClientError('permission reason must be a string')
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

  /** POST /runs */
  async createRun(
    request: DaemonCreateRunRequest,
    signal?: AbortSignal,
  ): Promise<DaemonCreateRunResponse> {
    if (!request.nodeId) throw new DaemonClientError('nodeId must not be empty')
    if (!request.agentId) throw new DaemonClientError('agentId must not be empty')
    if (!request.projectDir) throw new DaemonClientError('projectDir must not be empty')
    if (!request.canvasSnapshot) {
      throw new DaemonClientError('canvasSnapshot is required by POST /runs')
    }

    const response = await this.request(
      '/runs',
      { method: 'POST', body: JSON.stringify(request) },
      signal,
    )
    const payload = await this.readJson(response, 'POST /runs response')
    if (!isRecord(payload) || !isNonEmptyString(payload.runId)) {
      throw new DaemonProtocolError('POST /runs response did not contain a non-empty runId')
    }
    if (payload.sessionId !== undefined && !isNonEmptyString(payload.sessionId)) {
      throw new DaemonProtocolError('POST /runs response contained an invalid sessionId')
    }
    return {
      runId: payload.runId,
      ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
    }
  }

  /** Allocate and start a daemon run without coupling it to an SSE subscription. */
  async startRun(options: DaemonTransportRunOptions): Promise<DaemonCreateRunResponse> {
    assertNotAborted(options.signal)
    const nodeId = options.nodeId ?? this.defaultNodeId
    if (!nodeId) throw new DaemonClientError('DaemonClient.startRun requires nodeId')
    if (!options.canvasSnapshot) {
      throw new DaemonClientError('DaemonClient.startRun requires canvasSnapshot')
    }
    const canvasSnapshot: DaemonCanvasSnapshot = options.plugins === undefined
      ? options.canvasSnapshot
      : { ...options.canvasSnapshot, plugins: options.plugins }
    const requestedRunId = options.runId ?? globalThis.crypto.randomUUID()
    const createController = new AbortController()
    const createTimeout = setTimeout(() => {
      createController.abort(new DOMException('Creating the Agent run timed out', 'TimeoutError'))
    }, CREATE_RUN_TIMEOUT_MS)
    const combined = combineAbortSignals([options.signal, createController.signal])
    try {
      let created: DaemonCreateRunResponse
      try {
        created = await this.createRun({
          runId: requestedRunId,
          nodeId,
          agentId: options.agentId,
          prompt: options.prompt,
          projectDir: options.projectDir,
          canvasBranch: options.canvasBranch,
          automationMode: options.automationMode,
          sessionId: options.sessionId,
          canvasSnapshot,
        }, combined.signal)
      } catch (error) {
        if (!combined.signal.aborted) throw error
        let recovered: DaemonRunSummary | null
        try {
          recovered = await this.reconcileAbortedCreate(
            requestedRunId,
            nodeId,
            options.projectDir,
            options.canvasBranch,
          )
        } catch (reconcileError) {
          throw new DaemonRunStartUncertainError(requestedRunId, { cause: reconcileError })
        }
        if (!recovered) throw error
        created = {
          runId: recovered.runId,
          ...(recovered.sessionId ? { sessionId: recovered.sessionId } : {}),
        }
      }
      if (created.runId !== requestedRunId) {
        throw new DaemonProtocolError(
          `POST /runs returned an unexpected runId (expected ${requestedRunId}, received ${created.runId})`,
        )
      }
      this.activeRuns.set(created.runId, {
        runId: created.runId,
        sessionId: created.sessionId ?? options.sessionId,
      })
      return created
    } finally {
      clearTimeout(createTimeout)
      combined.dispose()
    }
  }

  private async reconcileAbortedCreate(
    runId: string,
    nodeId: string,
    projectDir: string,
    canvasBranch?: string,
  ): Promise<DaemonRunSummary | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const summary = await this.getRun(runId, projectDir)
        if (summary.nodeId !== nodeId
          || (canvasBranch !== undefined && summary.canvasBranch !== canvasBranch)) {
          throw new DaemonProtocolError(`Recovered run ${runId} did not match its request`)
        }
        return summary
      } catch (error) {
        if (!(error instanceof DaemonHttpError) || error.status !== 404) throw error
        if (attempt < 2) await shortDelay(50 * (attempt + 1))
      }
    }
    // A known client-generated id makes a final cancellation safe and keeps an
    // accepted-after-abort request from becoming an untracked background run.
    try {
      await this.cancelRun(runId)
    } catch (error) {
      if (!(error instanceof DaemonHttpError) || error.status !== 404) throw error
    }
    return null
  }

  /** GET /runs/:id, including summaries recovered after a daemon restart. */
  async getRun(
    runId: string,
    projectDir = '.',
    signal?: AbortSignal,
  ): Promise<DaemonRunSummary> {
    if (!runId) throw new DaemonClientError('runId must not be empty')
    const url = new URL(this.endpoint(`/runs/${encodeURIComponent(runId)}`))
    url.searchParams.set('projectDir', projectDir)
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    return decodeRunSummary(await this.readJson(response, 'GET /runs/:id response'))
  }

  /** GET /runs, used to recover an accepted run whose local ref was not flushed. */
  async listRuns(
    query: DaemonRunsQuery = {},
    signal?: AbortSignal,
  ): Promise<DaemonRunSummary[]> {
    const url = new URL(this.endpoint('/runs'))
    if (query.projectDir !== undefined) url.searchParams.set('projectDir', query.projectDir)
    if (query.nodeId !== undefined) url.searchParams.set('nodeId', query.nodeId)
    if (query.branch !== undefined) url.searchParams.set('branch', query.branch)
    if (query.limit !== undefined) url.searchParams.set('limit', String(query.limit))
    const response = await this.requestUrl(url, { method: 'GET' }, signal)
    const payload = await this.readJson(response, 'GET /runs response')
    if (!isRecord(payload) || !Array.isArray(payload.runs)) {
      throw new DaemonProtocolError('GET /runs response did not contain a run list')
    }
    return payload.runs.map(decodeRunSummary)
  }

  /** GET /runs/:id/log, used to rebuild progress before resuming the live stream. */
  async getRunLog(
    runId: string,
    options: { projectDir?: string; afterEventId?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<DaemonRunLogPage> {
    if (!runId) throw new DaemonClientError('runId must not be empty')
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
    options: DaemonRunStreamOptions,
  ): Promise<DaemonRunStreamResult> {
    if (!runId) throw new DaemonClientError('runId must not be empty')
    const afterEventId = options.afterEventId ?? 0
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
      throw new DaemonClientError('afterEventId must be a non-negative safe integer')
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
      throw new DaemonProtocolError(
        `GET /runs/:id/events returned unexpected content type: ${contentType}`,
      )
    }

    let sessionId = options.sessionId ?? null
    let close: DaemonCloseEvent | null = null
    let stopReason: DaemonRunStreamResult['stopReason'] = null

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
    }, (message, cause) => new DaemonProtocolError(
      message,
      cause === undefined ? undefined : { cause },
    ))

    // `done` describes the Agent turn; only daemon `close` confirms the child exited,
    // persistence finished, and the final status is authoritative.
    if (!close) throw new DaemonProtocolError(`SSE stream for run ${runId} ended without close`)
    return { sessionId, close, stopReason }
  }

  /** Attach to an existing run. Aborting only detaches this browser subscriber. */
  async attachRun(
    runId: string,
    options: DaemonRunStreamOptions,
  ): Promise<DaemonRunStreamResult> {
    const active = this.activeRuns.get(runId) ?? {
      runId,
      sessionId: options.sessionId ?? null,
    }
    this.activeRuns.set(runId, active)
    try {
      const streamOptions: DaemonRunStreamOptions = {
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
        if (!(error instanceof DaemonHttpError) || error.status !== 409) throw error

        // The daemon's bounded in-memory replay window can have a gap. Its
        // durable JSONL log is authoritative, so fill the missing range before
        // reopening the live stream from the newest persisted event id.
        let cursor = options.afterEventId ?? 0
        let close: DaemonCloseEvent | null = null
        let stopReason: DaemonRunStreamResult['stopReason'] = null
        while (true) {
          const page = await this.getRunLog(runId, {
            projectDir: options.projectDir ?? '.',
            afterEventId: cursor,
            limit: 2_000,
          }, options.signal)
          for (const rawEntry of page.entries) {
            const entry = decodeDaemonRunLogEntry(rawEntry, runId)
            cursor = Math.max(cursor, entry.id)
            if (entry.event === 'agent-event') {
              if (entry.data.type === 'done') stopReason = entry.data.stopReason
              options.onEvent(entry.data)
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
    if (!runId) throw new DaemonClientError('runId must not be empty')
    await this.request(
      `/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
      signal,
    )
  }

  async run(options: DaemonTransportRunOptions): Promise<{
    sessionId: string | null
    artifacts: string[]
    artifactsComplete: boolean
    outcome?: RunOutcome
  }> {
    const created = await this.startRun(options)
    const result = await this.attachRun(created.runId, {
      onEvent: options.onEvent,
      signal: options.signal,
      projectDir: options.projectDir,
      sessionId: created.sessionId ?? options.sessionId,
    })
    if (result.close.status === 'cancelled' || result.stopReason === 'cancelled') {
      throw new DaemonRunError(
        created.runId,
        `Run ${created.runId} was cancelled`,
        'cancelled',
        result.close.artifacts,
        result.close.artifactsComplete,
      )
    }
    if (result.close.status === 'error' || result.stopReason === 'error') {
      throw new DaemonRunError(
        created.runId,
        `Run ${created.runId} failed`,
        'error',
        result.close.artifacts,
        result.close.artifactsComplete,
      )
    }
    return {
      sessionId: result.sessionId,
      artifacts: result.close.artifacts,
      artifactsComplete: result.close.artifactsComplete,
      ...(result.close.outcome ? { outcome: result.close.outcome } : {}),
    }
  }

  async probe(agentId: string): Promise<{ available: boolean; authStatus?: string }> {
    const agent = (await this.agents()).find((candidate) => candidate.id === agentId)
    if (!agent) return { available: false }
    return {
      available: agent.available,
      ...(agent.authStatus === undefined ? {} : { authStatus: agent.authStatus }),
    }
  }

  /**
   * AgentTransport calls this argument sessionId, while the daemon cancels by
   * runId. Accept either; with a single active run, fall back to that current run.
   */
  async cancel(runOrSessionId: string): Promise<void> {
    let run = this.activeRuns.get(runOrSessionId)
    if (!run) {
      run = [...this.activeRuns.values()]
        .reverse()
        .find((candidate) => candidate.sessionId === runOrSessionId)
    }
    if (!run && this.activeRuns.size === 1) {
      run = this.activeRuns.values().next().value as ActiveRun | undefined
    }
    if (!run) {
      throw new DaemonClientError(`No active run matched ${runOrSessionId}`)
    }
    await this.cancelRun(run.runId)
  }

  async cancelCurrentRun(signal?: AbortSignal): Promise<void> {
    const run = [...this.activeRuns.values()].at(-1)
    if (!run) throw new DaemonClientError('There is no active run to cancel')
    await this.cancelRun(run.runId, signal)
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
      throw new DaemonClientError(`Unable to reach daemon at ${this.baseUrl}`, { cause: error })
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
      throw new DaemonHttpError(response.status, response.statusText, body)
    }
    return response
  }

  private async readJson(response: Response, context: string): Promise<unknown> {
    const text = await response.text()
    if (!text.trim()) throw new DaemonProtocolError(`${context} was empty`)
    return parseJson(text, context)
  }

  private decodeAgent(value: unknown, index: number): DaemonAgent {
    if (!isRecord(value)
      || !isNonEmptyString(value.id)
      || !isNonEmptyString(value.label)
      || (value.transport !== 'acpx' && value.transport !== 'codex')
      || typeof value.available !== 'boolean'
      || (value.authStatus !== 'authenticated'
        && value.authStatus !== 'unauthenticated'
        && value.authStatus !== 'unknown'
        && value.authStatus !== 'not-applicable')
      || !Array.isArray(value.models)
      || !value.models.every((model) => typeof model === 'string')) {
      throw new DaemonProtocolError(`GET /agents response had an invalid agent at index ${index}`)
    }
    if (value.version !== undefined && typeof value.version !== 'string') {
      throw new DaemonProtocolError(`Agent ${value.id} had an invalid version`)
    }
    if (value.binaryPath !== undefined && typeof value.binaryPath !== 'string') {
      throw new DaemonProtocolError(`Agent ${value.id} had an invalid binary path`)
    }
    if (value.detail !== undefined && typeof value.detail !== 'string') {
      throw new DaemonProtocolError(`Agent ${value.id} had an invalid detail`)
    }
    return {
      id: value.id,
      label: value.label,
      transport: value.transport,
      available: value.available,
      authStatus: value.authStatus,
      models: value.models as string[],
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
      ...(typeof value.binaryPath === 'string' ? { binaryPath: value.binaryPath } : {}),
      ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    }
  }

  private decodeSession(value: unknown, index: number): DaemonSession {
    if (!isRecord(value)
      || !isNonEmptyString(value.canvasBranch)
      || !isNonEmptyString(value.nodeId)
      || !isNonEmptyString(value.agentId)
      || !(value.sessionId === null || isNonEmptyString(value.sessionId))
      || !isFiniteNumber(value.createdAt)
      || !isFiniteNumber(value.lastActiveAt)) {
      throw new DaemonProtocolError(`GET /sessions response had an invalid session at index ${index}`)
    }
    if (value.runId !== undefined && !isNonEmptyString(value.runId)) {
      throw new DaemonProtocolError(`Session at index ${index} had an invalid runId`)
    }
    if (value.status !== undefined && !isRunStatus(value.status)) {
      throw new DaemonProtocolError(`Session at index ${index} had an invalid status`)
    }
    return {
      canvasBranch: value.canvasBranch,
      nodeId: value.nodeId,
      agentId: value.agentId,
      sessionId: value.sessionId,
      createdAt: value.createdAt,
      lastActiveAt: value.lastActiveAt,
      ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
      ...(isRunStatus(value.status) ? { status: value.status } : {}),
    }
  }
}
