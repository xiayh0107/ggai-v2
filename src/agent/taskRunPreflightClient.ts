import type { CanvasAttachmentRef } from '@/canvas/runController'

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

export type TaskRunPreflightResult =
  | { status: 'ready'; issues: [] }
  | { status: 'blocked'; issues: TaskRunPreflightIssue[] }

export interface TaskRunPreflightInput {
  projectDir: string
  taskId: string
  agentId: string
  canvasBranch: string
  baseRevision: number
  attachments?: readonly CanvasAttachmentRef[]
  signal?: AbortSignal
}

export interface TaskRunPreflightApi {
  check(input: TaskRunPreflightInput): Promise<TaskRunPreflightResult>
}

interface TaskRunPreflightClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

const ISSUE_CODES = new Set<TaskRunPreflightIssueCode>([
  'generation_service_unavailable',
  'generation_service_unauthenticated',
  'task_agent_mismatch',
  'attachment_unavailable',
  'skill_unavailable',
  'canvas_revision_changed',
])

/** Strict browser client for the advisory, side-effect-free Task Run preflight. */
export class TaskRunPreflightClient implements TaskRunPreflightApi {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: TaskRunPreflightClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async check(input: TaskRunPreflightInput): Promise<TaskRunPreflightResult> {
    const request = canonicalRequest(input)
    const url = new URL('/task-runs/preflight', this.#baseUrl)
    url.searchParams.set('projectDir', input.projectDir)
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: input.signal,
    })
    if (!response.ok) {
      throw new Error(await responseMessage(response))
    }
    return decodeResult(await response.json())
  }
}

function canonicalRequest(input: TaskRunPreflightInput) {
  if (!input.projectDir.trim()) throw new TypeError('projectDir must not be empty')
  const taskId = identifier(input.taskId, 'taskId')
  const agentId = identifier(input.agentId, 'agentId')
  const canvasBranch = branch(input.canvasBranch)
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new TypeError('baseRevision must be a non-negative safe integer')
  }
  const attachments = (input.attachments ?? []).map((attachment) => {
    if (attachment.kind === 'node') {
      return { kind: 'node' as const, nodeId: identifier(attachment.nodeId, 'nodeId') }
    }
    if (!/^artifact_[0-9a-f]{64}$/u.test(attachment.artifactId)) {
      throw new TypeError('artifactId is invalid')
    }
    return {
      kind: 'artifact' as const,
      runId: identifier(attachment.runId, 'runId'),
      artifactId: attachment.artifactId,
    }
  })
  if (attachments.length > 100) throw new TypeError('attachments has too many entries')
  const keys = attachments.map((attachment) => attachment.kind === 'node'
    ? `node:${attachment.nodeId}`
    : `artifact:${attachment.runId}:${attachment.artifactId}`)
  if (new Set(keys).size !== keys.length) throw new TypeError('attachments contains duplicates')
  return { taskId, agentId, canvasBranch, baseRevision: input.baseRevision, attachments }
}

function decodeResult(value: unknown): TaskRunPreflightResult {
  if (!isExactRecord(value, ['status', 'issues'])
    || (value.status !== 'ready' && value.status !== 'blocked')
    || !Array.isArray(value.issues)
    || value.issues.length > 6) {
    throw new TypeError('Task Run preflight response was malformed')
  }
  const issues = value.issues.map((issue): TaskRunPreflightIssue => {
    if (!isExactRecord(issue, ['code', 'message', 'retryable'])
      || typeof issue.code !== 'string'
      || !ISSUE_CODES.has(issue.code as TaskRunPreflightIssueCode)
      || typeof issue.message !== 'string'
      || issue.message.trim().length === 0
      || issue.message.length > 1_000
      || typeof issue.retryable !== 'boolean') {
      throw new TypeError('Task Run preflight issue was malformed')
    }
    return {
      code: issue.code as TaskRunPreflightIssueCode,
      message: issue.message,
      retryable: issue.retryable,
    }
  })
  if (value.status === 'ready' && issues.length === 0) return { status: 'ready', issues: [] }
  if (value.status === 'blocked' && issues.length > 0) return { status: 'blocked', issues }
  throw new TypeError('Task Run preflight status did not match its issues')
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as unknown
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
      return payload.error.message
    }
  } catch {
    // Fall back to a stable user-facing failure below.
  }
  return `生成服务检测失败（HTTP ${response.status}）`
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u.test(value) || value.includes('..')) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function branch(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.endsWith('.lock')
    || value.split('/').some((part) => part === '.' || part.endsWith('.'))) {
    throw new TypeError('canvasBranch is invalid')
  }
  return value
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/'
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
