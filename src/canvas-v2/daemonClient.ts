import type { CanvasCommandV2 } from './commands'
import { parseCanvasDocumentV2, type CanvasDocumentV2 } from './model'
import type {
  CanvasV2OutboxEntry,
  CanvasV2PersistenceScope,
} from './persistence'

export interface CanvasV2CanvasScope {
  projectDir: string
  branch: string
}

export interface CanvasV2Envelope {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  document: CanvasDocumentV2
}

export interface CanvasV2CommandRequest {
  branch: string
  baseRevision: number
  mutationId: string
  command: CanvasCommandWireV2
}

export interface CanvasV2TaskProposalEditWire {
  title?: string
  prompt?: string
}

export type CanvasV2TaskProposalEditsWire = Record<string, CanvasV2TaskProposalEditWire>

type CanvasTrustedCommandWireV2 =
  | { type: 'MaterializeProjectionPlan'; planId: string }
  | {
      type: 'AcceptTaskProposals'
      planId: string
      proposalKeys: string[]
      edits?: CanvasV2TaskProposalEditsWire
    }
  | { type: 'DismissPlan'; planId: string }

export type CanvasCommandWireV2 =
  | Exclude<CanvasCommandV2, {
      type: 'MaterializeProjectionPlan' | 'AcceptTaskProposals' | 'DismissPlan'
    }>
  | CanvasTrustedCommandWireV2

export interface CanvasV2CommandOutbox {
  list(scope: CanvasV2PersistenceScope): Promise<CanvasV2OutboxEntry<CanvasCommandV2>[]>
  ack(scope: CanvasV2PersistenceScope, mutationId: string): Promise<void>
  rebaseConflict(
    scope: CanvasV2PersistenceScope,
    serverRevision: number,
  ): Promise<CanvasV2OutboxEntry<CanvasCommandV2>[]>
}

export type CanvasV2FlushResult =
  | {
      status: 'flushed'
      acknowledged: number
      envelope: CanvasV2Envelope | null
    }
  | {
      status: 'conflict'
      reason: 'revision' | 'precondition'
      mutationId: string
      currentRevision?: number
      code: string
      message: string
      envelope?: CanvasV2Envelope
    }

export interface CanvasV2DaemonClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

export class CanvasV2ClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CanvasV2ClientError'
  }
}

export class CanvasV2ProtocolError extends CanvasV2ClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CanvasV2ProtocolError'
  }
}

export class CanvasV2HttpError extends CanvasV2ClientError {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CanvasV2HttpError'
    this.status = status
    this.code = code
  }
}

export class CanvasV2RevisionConflictError extends CanvasV2HttpError {
  readonly currentRevision: number

  constructor(currentRevision: number, code: string, message: string) {
    super(409, code, message)
    this.name = 'CanvasV2RevisionConflictError'
    this.currentRevision = currentRevision
  }
}

export class CanvasV2PreconditionConflictError extends CanvasV2HttpError {
  readonly currentRevision?: number

  constructor(status: number, code: string, message: string, currentRevision?: number) {
    super(status, code, message)
    this.name = 'CanvasV2PreconditionConflictError'
    this.currentRevision = currentRevision
  }
}

export class CanvasV2DaemonClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: CanvasV2DaemonClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    const fetchImplementation = options.fetch ?? globalThis.fetch
    if (!fetchImplementation) throw new CanvasV2ClientError('Fetch is unavailable')
    this.#fetch = fetchImplementation
  }

  async getCanvas(scope: CanvasV2CanvasScope): Promise<CanvasV2Envelope> {
    const response = await this.#fetch(this.#canvasUrl('/canvas/v2', scope), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw await decodeHttpError(response, 'GET /canvas/v2')
    return parseCanvasV2Envelope(
      await readJson(response, 'GET /canvas/v2 response'),
      scope.branch,
    )
  }

  async executeCommand(
    scope: CanvasV2CanvasScope,
    entry: CanvasV2OutboxEntry<CanvasCommandV2>,
  ): Promise<CanvasV2Envelope> {
    if (entry.branch !== scope.branch) {
      throw new CanvasV2ProtocolError(
        `Outbox branch ${entry.branch} does not match request branch ${scope.branch}`,
      )
    }
    const body: CanvasV2CommandRequest = {
      branch: scope.branch,
      baseRevision: entry.baseRevision,
      mutationId: entry.mutationId,
      command: serializeCanvasCommandV2(entry.command),
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
    return parseCanvasV2Envelope(
      await readJson(response, 'POST /canvas/commands response'),
      scope.branch,
    )
  }

  /**
   * Flushes one command at a time. One revision conflict may trigger a fresh
   * envelope read and one FIFO replay; no later conflict is auto-resolved.
   */
  async flushOutbox(
    scope: CanvasV2CanvasScope,
    outbox: CanvasV2CommandOutbox,
  ): Promise<CanvasV2FlushResult> {
    const persistenceScope: CanvasV2PersistenceScope = {
      daemonBaseUrl: this.#baseUrl,
      projectDir: scope.projectDir,
      branch: scope.branch,
    }
    let acknowledged = 0
    let replayedAfterConflict = false
    let latestEnvelope: CanvasV2Envelope | null = null

    while (true) {
      const entries = await outbox.list(persistenceScope)
      const head = entries[0]
      if (!head) return { status: 'flushed', acknowledged, envelope: latestEnvelope }

      try {
        latestEnvelope = await this.executeCommand(scope, head)
        await outbox.ack(persistenceScope, head.mutationId)
        acknowledged += 1
      } catch (error) {
        if (error instanceof CanvasV2PreconditionConflictError) {
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
        if (!(error instanceof CanvasV2RevisionConflictError)) throw error
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

  #canvasUrl(path: string, scope: CanvasV2CanvasScope): string {
    if (!scope.projectDir || !scope.branch) {
      throw new CanvasV2ProtocolError('Canvas scope requires projectDir and branch')
    }
    const url = new URL(path, `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', scope.projectDir)
    url.searchParams.set('branch', scope.branch)
    return url.toString()
  }
}

export function serializeCanvasCommandV2(command: CanvasCommandV2): CanvasCommandWireV2 {
  switch (command.type) {
    case 'MaterializeProjectionPlan':
      return { type: command.type, planId: command.plan.planId }
    case 'AcceptTaskProposals': {
      const edits = readProposalEdits(command)
      return {
        type: command.type,
        planId: command.plan.planId,
        proposalKeys: [...command.proposalKeys],
        ...(edits ? { edits } : {}),
      }
    }
    case 'DismissPlan':
      return { type: command.type, planId: command.plan.planId }
    case 'CreateTask':
    case 'UpdateTaskGoal':
    case 'MoveEntities':
    case 'CreateCollectionFromSelection':
    case 'AssignToCollection':
    case 'DissolveCollection':
    case 'DeleteTask':
    case 'DeleteCollection':
    case 'DuplicateTaskAsDraft':
      return structuredClone(command)
    default:
      command satisfies never
      throw new CanvasV2ProtocolError('Unsupported Canvas V2 command')
  }
}

export function parseCanvasV2Envelope(value: unknown, expectedBranch?: string): CanvasV2Envelope {
  if (!isRecord(value)
    || typeof value.branch !== 'string'
    || (expectedBranch !== undefined && value.branch !== expectedBranch)
    || !isRevision(value.revision)
    || typeof value.updatedAt !== 'string'
    || (value.lastMutationId !== null && typeof value.lastMutationId !== 'string')) {
    throw new CanvasV2ProtocolError('Canvas V2 envelope is invalid')
  }
  try {
    return {
      branch: value.branch,
      revision: value.revision,
      updatedAt: value.updatedAt,
      lastMutationId: value.lastMutationId,
      document: parseCanvasDocumentV2(value.document),
    }
  } catch (error) {
    if (error instanceof CanvasV2ProtocolError) throw error
    throw new CanvasV2ProtocolError('Canvas V2 document is invalid', { cause: error })
  }
}

async function decodeHttpError(response: Response, operation: string): Promise<CanvasV2HttpError> {
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
    return new CanvasV2PreconditionConflictError(
      response.status,
      code,
      message,
      currentRevision,
    )
  }
  if (response.status === 409 && currentRevision !== undefined) {
    return new CanvasV2RevisionConflictError(currentRevision, code, message)
  }
  return new CanvasV2HttpError(response.status, code, message)
}

async function readJson(response: Response, context: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new CanvasV2ProtocolError(`${context} is not valid JSON`, { cause: error })
  }
}

function readProposalEdits(command: Extract<CanvasCommandV2, { type: 'AcceptTaskProposals' }>):
CanvasV2TaskProposalEditsWire | null {
  const candidate = (command as typeof command & { edits?: unknown }).edits
  if (candidate === undefined) return null
  if (!isRecord(candidate) || Object.keys(candidate).length > 64) {
    throw new CanvasV2ProtocolError('Task proposal edits are invalid')
  }
  const edits: CanvasV2TaskProposalEditsWire = {}
  for (const [proposalKey, value] of Object.entries(candidate)) {
    if (proposalKey.length === 0
      || proposalKey.length > 160
      || !isRecord(value)
      || Object.keys(value).some((key) => key !== 'title' && key !== 'prompt')
      || (value.title !== undefined
        && (typeof value.title !== 'string' || value.title.length > 1_000))
      || (value.prompt !== undefined
        && (typeof value.prompt !== 'string' || value.prompt.length > 250_000))) {
      throw new CanvasV2ProtocolError('Task proposal edits are invalid')
    }
    edits[proposalKey] = {
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
      ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    }
  }
  return edits
}

function isPreconditionCode(code: string): boolean {
  return code === 'precondition_failed'
    || code === 'command_precondition_failed'
    || code === 'canvas_command_precondition_failed'
    || code === 'trusted_plan_precondition_failed'
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '')
  if (!normalized) throw new CanvasV2ClientError('baseUrl is required')
  try {
    return new URL(normalized).toString().replace(/\/$/u, '')
  } catch (error) {
    throw new CanvasV2ClientError('baseUrl is invalid', { cause: error })
  }
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
