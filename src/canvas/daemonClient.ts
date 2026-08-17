import type {
  CanvasCommand,
  TaskProposalEdit,
  TaskProposalEdits,
} from './commands'
import { parseCanvasDocument, type CanvasDocument } from './model'
import type {
  CanvasOutboxEntry,
  CanvasPersistenceScope,
} from './persistence'

export interface CanvasCanvasScope {
  projectDir: string
  branch: string
}

export interface CanvasEnvelope {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  document: CanvasDocument
}

export interface CanvasCommandRequest {
  branch: string
  baseRevision: number
  mutationId: string
  command: CanvasCommandWire
}

export const MAX_CANVAS_CONFLICT_MUTATIONS = 500

export interface CanvasConflictMutationInput {
  mutationId: string
  command: CanvasCommand
}

export interface CanvasSaveConflictBranchInput {
  sourceBranch: string
  newBranch: string
  baseRevision: number
  mutations: readonly CanvasConflictMutationInput[]
}

export interface CanvasSaveConflictBranchResult {
  sourceBranch: string
  newBranch: string
  baseRevision: number
  canvas: CanvasEnvelope
}

export type CanvasTaskProposalEditWire = TaskProposalEdit
export type CanvasTaskProposalEditsWire = TaskProposalEdits

type CanvasTrustedCommandWire =
  | { type: 'MaterializeProjectionPlan'; planId: string }
  | { type: 'MaterializeGraphPlan'; planId: string }
  | { type: 'MaterializeDecompositionPlan'; planId: string }
  | {
      type: 'AcceptTaskProposals'
      planId: string
      proposalKeys: string[]
      edits?: CanvasTaskProposalEditsWire
    }
  | { type: 'DismissPlan'; planId: string }
  | { type: 'DetachInstance'; nodeId: string }

export type CanvasCommandWire =
  | Exclude<CanvasCommand, {
      type: 'MaterializeProjectionPlan' | 'MaterializeGraphPlan' | 'MaterializeDecompositionPlan' | 'AcceptTaskProposals' | 'DismissPlan' | 'CreateInstance' | 'DetachInstance' | 'UpdateInstanceRef'
    }>
  | CanvasTrustedCommandWire

export interface CanvasCommandOutbox {
  list(scope: CanvasPersistenceScope): Promise<CanvasOutboxEntry<CanvasCommand>[]>
  ack(scope: CanvasPersistenceScope, mutationId: string): Promise<void>
  rebaseConflict(
    scope: CanvasPersistenceScope,
    serverRevision: number,
  ): Promise<CanvasOutboxEntry<CanvasCommand>[]>
}

export type CanvasFlushResult =
  | {
      status: 'flushed'
      acknowledged: number
      envelope: CanvasEnvelope | null
    }
  | {
      status: 'conflict'
      reason: 'revision' | 'precondition'
      mutationId: string
      currentRevision?: number
      code: string
      message: string
      envelope?: CanvasEnvelope
    }

export interface CanvasDaemonClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

export interface CanvasDaemonCapabilities {
  canvas: true
  schemaVersion: 3
  initializationRequired: boolean
}

export class CanvasClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CanvasClientError'
  }
}

export class CanvasProtocolError extends CanvasClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CanvasProtocolError'
  }
}

export class CanvasHttpError extends CanvasClientError {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CanvasHttpError'
    this.status = status
    this.code = code
  }
}

export class CanvasRevisionConflictError extends CanvasHttpError {
  readonly currentRevision: number

  constructor(currentRevision: number, code: string, message: string) {
    super(409, code, message)
    this.name = 'CanvasRevisionConflictError'
    this.currentRevision = currentRevision
  }
}

export class CanvasPreconditionConflictError extends CanvasHttpError {
  readonly currentRevision?: number

  constructor(status: number, code: string, message: string, currentRevision?: number) {
    super(status, code, message)
    this.name = 'CanvasPreconditionConflictError'
    this.currentRevision = currentRevision
  }
}

export class CanvasDaemonClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: CanvasDaemonClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    const fetchImplementation = options.fetch
      ?? (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : undefined)
    if (!fetchImplementation) throw new CanvasClientError('Fetch is unavailable')
    this.#fetch = fetchImplementation
  }

  async getCapabilities(): Promise<CanvasDaemonCapabilities> {
    const response = await this.#fetch(new URL('/health', `${this.#baseUrl}/`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw await decodeHttpError(response, 'GET /health')
    const value = await readJson(response, 'GET /health response')
    if (!isRecord(value) || !isRecord(value.capabilities) || !isRecord(value.canvas)) {
      throw new CanvasProtocolError('Daemon capabilities are invalid')
    }
    const canvas = value.capabilities.canvas
    const schemaVersion = value.canvas.schemaVersion
    const initializationRequired = value.canvas.initializationRequired
    if (
      canvas !== true
      || schemaVersion !== 3
      || typeof initializationRequired !== 'boolean'
    ) {
      throw new CanvasProtocolError('Daemon Canvas capabilities are inconsistent')
    }
    return { canvas, schemaVersion, initializationRequired }
  }

  async getCanvas(scope: CanvasCanvasScope): Promise<CanvasEnvelope> {
    const response = await this.#fetch(this.#canvasUrl('/canvas', scope), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw await decodeHttpError(response, 'GET /canvas')
    return parseCanvasEnvelope(
      await readJson(response, 'GET /canvas response'),
      scope.branch,
    )
  }

  async executeCommand(
    scope: CanvasCanvasScope,
    entry: CanvasOutboxEntry<CanvasCommand>,
  ): Promise<CanvasEnvelope> {
    if (entry.branch !== scope.branch) {
      throw new CanvasProtocolError(
        `Outbox branch ${entry.branch} does not match request branch ${scope.branch}`,
      )
    }
    const body: CanvasCommandRequest = {
      branch: scope.branch,
      baseRevision: entry.baseRevision,
      mutationId: entry.mutationId,
      command: serializeCanvasCommand(entry.command),
    }
    const response = await this.#fetch(this.#canvasUrl('/canvas/commands', scope), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await decodeHttpError(response, 'POST /canvas/commands')
    return parseCanvasEnvelope(
      await readJson(response, 'POST /canvas/commands response'),
      scope.branch,
    )
  }

  async saveConflictBranch(
    scope: CanvasCanvasScope,
    input: CanvasSaveConflictBranchInput,
  ): Promise<CanvasSaveConflictBranchResult> {
    if (!scope.projectDir.trim()) {
      throw new CanvasProtocolError('Conflict branch scope requires projectDir')
    }
    const sourceBranch = assertCanvasBranch(input.sourceBranch)
    const newBranch = assertCanvasBranch(input.newBranch)
    if (sourceBranch !== scope.branch) {
      throw new CanvasProtocolError('Conflict source branch does not match Canvas scope')
    }
    if (sourceBranch === newBranch) {
      throw new CanvasProtocolError('Conflict branch must differ from its source branch')
    }
    if (!isRevision(input.baseRevision)) {
      throw new CanvasProtocolError('Conflict base revision is invalid')
    }
    if (input.mutations.length === 0
      || input.mutations.length > MAX_CANVAS_CONFLICT_MUTATIONS) {
      throw new CanvasProtocolError(
        `Conflict branch requires 1-${MAX_CANVAS_CONFLICT_MUTATIONS} mutations`,
      )
    }
    const mutationIds = new Set<string>()
    const mutations = input.mutations.map((mutation) => {
      if (!isMutationId(mutation.mutationId) || mutationIds.has(mutation.mutationId)) {
        throw new CanvasProtocolError('Conflict mutation id is invalid or duplicated')
      }
      mutationIds.add(mutation.mutationId)
      return {
        mutationId: mutation.mutationId,
        command: serializeCanvasCommand(mutation.command),
      }
    })
    const url = new URL('/canvas/conflicts', `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', scope.projectDir)
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceBranch,
        newBranch,
        baseRevision: input.baseRevision,
        mutations,
      }),
    })
    if (!response.ok) throw await decodeHttpError(response, 'POST /canvas/conflicts')
    if (response.status !== 201) {
      throw new CanvasProtocolError('POST /canvas/conflicts must return HTTP 201')
    }
    const value = await readJson(response, 'POST /canvas/conflicts response')
    if (!isExactRecord(value, [
      'sourceBranch', 'newBranch', 'baseRevision', 'canvas',
    ])
      || value.sourceBranch !== sourceBranch
      || value.newBranch !== newBranch
      || value.baseRevision !== input.baseRevision) {
      throw new CanvasProtocolError('Conflict branch response is invalid')
    }
    return {
      sourceBranch,
      newBranch,
      baseRevision: input.baseRevision,
      canvas: parseCanvasEnvelope(value.canvas, newBranch),
    }
  }

  /**
   * Flushes one command at a time. One revision conflict may trigger a fresh
   * envelope read and one FIFO replay; no later conflict is auto-resolved.
   */
  async flushOutbox(
    scope: CanvasCanvasScope,
    outbox: CanvasCommandOutbox,
  ): Promise<CanvasFlushResult> {
    const persistenceScope: CanvasPersistenceScope = {
      daemonBaseUrl: this.#baseUrl,
      projectDir: scope.projectDir,
      branch: scope.branch,
    }
    let acknowledged = 0
    let replayedAfterConflict = false
    let latestEnvelope: CanvasEnvelope | null = null

    while (true) {
      const entries = await outbox.list(persistenceScope)
      const head = entries[0]
      if (!head) return { status: 'flushed', acknowledged, envelope: latestEnvelope }

      try {
        latestEnvelope = await this.executeCommand(scope, head)
        await outbox.ack(persistenceScope, head.mutationId)
        acknowledged += 1
      } catch (error) {
        if (error instanceof CanvasPreconditionConflictError) {
          return {
            status: 'conflict',
            reason: 'precondition',
            mutationId: head.mutationId,
            ...(error.currentRevision === undefined
              ? {}
              : { currentRevision: error.currentRevision }),
            code: error.code,
            message: error.message,
            ...(latestEnvelope ? { envelope: latestEnvelope } : {}),
          }
        }
        if (!(error instanceof CanvasRevisionConflictError)) throw error
        if (replayedAfterConflict) {
          return {
            status: 'conflict',
            reason: 'revision',
            mutationId: head.mutationId,
            currentRevision: error.currentRevision,
            code: error.code,
            message: error.message,
            ...(latestEnvelope ? { envelope: latestEnvelope } : {}),
          }
        }

        latestEnvelope = await this.getCanvas(scope)
        await outbox.rebaseConflict(persistenceScope, latestEnvelope.revision)
        replayedAfterConflict = true
      }
    }
  }

  #canvasUrl(path: string, scope: CanvasCanvasScope): string {
    if (!scope.projectDir || !scope.branch) {
      throw new CanvasProtocolError('Canvas scope requires projectDir and branch')
    }
    const url = new URL(path, `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', scope.projectDir)
    url.searchParams.set('branch', scope.branch)
    return url.toString()
  }
}

export function serializeCanvasCommand(command: CanvasCommand): CanvasCommandWire {
  switch (command.type) {
    case 'MaterializeProjectionPlan':
    case 'MaterializeGraphPlan':
    case 'MaterializeDecompositionPlan':
      return { type: command.type, planId: command.plan.planId }
    case 'AcceptTaskProposals': {
      return {
        type: command.type,
        planId: command.plan.planId,
        proposalKeys: [...command.proposalKeys],
        ...(command.edits === undefined ? {} : { edits: structuredClone(command.edits) }),
      }
    }
    case 'DismissPlan':
      return { type: command.type, planId: command.plan.planId }
    case 'DetachInstance':
      return { type: command.type, nodeId: command.nodeId }
    case 'CreateTask':
    case 'UpdateTaskGoal':
    case 'CreateNode':
    case 'UpdateNodeContent':
    case 'UpdateNodeSkillBindings':
    case 'ResizeNode':
    case 'SetNodeBounds':
    case 'SetNodeTransform':
    case 'ReparentNodes':
    case 'ReorderChildren':
    case 'DeleteNode':
    case 'DuplicateNode':
    case 'CreateEdge':
    case 'CreatePortEdge':
    case 'CreateEdges':
    case 'UpdateEdge':
    case 'DeleteEdge':
    case 'DeleteEdges':
    case 'SelectNodeExecution':
    case 'BindNodeToFilesystem':
    case 'DetachNodeFromTask':
    case 'AssignNodeToTask':
    case 'CreateTaskForOutputSlot':
    case 'CreateDerivedTaskFromSelection':
    case 'MoveEntities':
    case 'CreateCollectionFromSelection':
    case 'AssignToCollection':
    case 'RemoveFromCollection':
    case 'DissolveCollection':
    case 'DeleteTask':
    case 'DeleteTaskAndViews':
    case 'DeleteCollection':
    case 'DeleteCollectionAndContents':
    case 'DuplicateCollection':
    case 'DuplicateTaskAsDraft':
      return structuredClone(command)
    case 'CreateInstance':
    case 'UpdateInstanceRef':
      throw new CanvasProtocolError('Internal instance command cannot be serialized')
    default:
      command satisfies never
      throw new CanvasProtocolError('Unsupported Canvas command')
  }
}

export function parseCanvasEnvelope(value: unknown, expectedBranch?: string): CanvasEnvelope {
  if (!isRecord(value)
    || typeof value.branch !== 'string'
    || (expectedBranch !== undefined && value.branch !== expectedBranch)
    || !isRevision(value.revision)
    || typeof value.updatedAt !== 'string'
    || (value.lastMutationId !== null && typeof value.lastMutationId !== 'string')) {
    throw new CanvasProtocolError('Canvas envelope is invalid')
  }
  try {
    return {
      branch: value.branch,
      revision: value.revision,
      updatedAt: value.updatedAt,
      lastMutationId: value.lastMutationId,
      document: parseCanvasDocument(value.document),
    }
  } catch (error) {
    if (error instanceof CanvasProtocolError) throw error
    throw new CanvasProtocolError('Canvas document is invalid', { cause: error })
  }
}

async function decodeHttpError(response: Response, operation: string): Promise<CanvasHttpError> {
  let value: unknown = null
  try {
    value = await response.json()
  } catch {
    // A non-JSON error remains an explicit HTTP error.
  }
  const error = isRecord(value) && isRecord(value.error) ? value.error : null
  const code = error && typeof error.code === 'string'
    ? error.code
    : `http_${response.status}`
  const message = error && typeof error.message === 'string'
    ? error.message
    : `${operation} failed with HTTP ${response.status}`
  const currentRevision = error && isRevision(error.currentRevision)
    ? error.currentRevision
    : undefined

  if (response.status === 412 || isPreconditionCode(code)) {
    return new CanvasPreconditionConflictError(
      response.status,
      code,
      message,
      currentRevision,
    )
  }
  if (response.status === 409 && currentRevision !== undefined) {
    return new CanvasRevisionConflictError(currentRevision, code, message)
  }
  return new CanvasHttpError(response.status, code, message)
}

async function readJson(response: Response, context: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new CanvasProtocolError(`${context} is not valid JSON`, { cause: error })
  }
}

function isPreconditionCode(code: string): boolean {
  return code === 'precondition_failed'
    || code === 'command_precondition_failed'
    || code === 'canvas_command_precondition_failed'
    || code === 'trusted_plan_precondition_failed'
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '')
  if (!normalized) throw new CanvasClientError('baseUrl is required')
  try {
    return new URL(normalized).toString().replace(/\/$/u, '')
  } catch (error) {
    throw new CanvasClientError('baseUrl is invalid', { cause: error })
  }
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function assertCanvasBranch(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 120
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.endsWith('.lock')
    || value.split('/').some((segment) => segment === '.' || segment.endsWith('.'))) {
    throw new CanvasProtocolError('Canvas branch is invalid')
  }
  return value
}

function isMutationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
