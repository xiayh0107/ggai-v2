export const RUN_INTENT_SCHEMA_VERSION = 2
export const MAX_RUN_INTENT_PROMPT_LENGTH = 250_000
export const MAX_RUN_INTENT_ATTACHMENTS = 100
export const MAX_RUN_INTENT_ID_LENGTH = 160
export const MAX_RUN_INTENT_BRANCH_LENGTH = 120

export interface ArtifactAttachmentRef {
  kind: 'artifact'
  runId: string
  artifactId: string
}

/** A semantic node reference; it never carries node content or a filesystem path. */
export interface NodeAttachmentRef {
  kind: 'node'
  nodeId: string
}

export type AttachmentRef = ArtifactAttachmentRef | NodeAttachmentRef

export interface RunIntent {
  schemaVersion: 2
  runId: string
  taskId: string
  agentId: string
  canvasBranch: string
  baseRevision: number
  prompt: string
  attachments: AttachmentRef[]
  materializationPolicy: 'auto'
}

export class TaskRunProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskRunProtocolError'
  }
}

const RUN_INTENT_KEYS = [
  'schemaVersion',
  'runId',
  'taskId',
  'agentId',
  'canvasBranch',
  'baseRevision',
  'prompt',
  'attachments',
  'materializationPolicy',
] as const

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u
const ARTIFACT_ID_PATTERN = /^artifact_[0-9a-f]{64}$/u

/** Strict trust-boundary parser. Unknown or missing fields fail closed. */
export function parseRunIntent(value: unknown): RunIntent {
  if (!isExactRecord(value, RUN_INTENT_KEYS)) {
    throw new TaskRunProtocolError('RunIntent must have the exact supported fields')
  }
  if (value.schemaVersion !== RUN_INTENT_SCHEMA_VERSION) {
    throw new TaskRunProtocolError('RunIntent.schemaVersion must be 2')
  }
  const runId = parseId(value.runId, 'RunIntent.runId')
  const taskId = parseId(value.taskId, 'RunIntent.taskId')
  const agentId = parseId(value.agentId, 'RunIntent.agentId')
  const canvasBranch = parseBranch(value.canvasBranch)
  if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) {
    throw new TaskRunProtocolError(
      'RunIntent.baseRevision must be a non-negative safe integer',
    )
  }
  if (typeof value.prompt !== 'string'
    || value.prompt.length > MAX_RUN_INTENT_PROMPT_LENGTH) {
    throw new TaskRunProtocolError('RunIntent.prompt is invalid')
  }
  if (!Array.isArray(value.attachments)
    || value.attachments.length > MAX_RUN_INTENT_ATTACHMENTS) {
    throw new TaskRunProtocolError('RunIntent.attachments is invalid')
  }
  const attachments = value.attachments.map(parseAttachmentRef)
  const attachmentKeys = attachments.map(attachmentKey)
  if (new Set(attachmentKeys).size !== attachmentKeys.length) {
    throw new TaskRunProtocolError('RunIntent.attachments contains duplicates')
  }
  if (value.materializationPolicy !== 'auto') {
    throw new TaskRunProtocolError('RunIntent.materializationPolicy must be auto')
  }

  return {
    schemaVersion: RUN_INTENT_SCHEMA_VERSION,
    runId,
    taskId,
    agentId,
    canvasBranch,
    baseRevision: value.baseRevision as number,
    prompt: value.prompt,
    attachments,
    materializationPolicy: 'auto',
  }
}

export function parseTaskId(value: unknown): string {
  return parseId(value, 'taskId')
}

export function parseAttachmentRef(value: unknown, index?: number): AttachmentRef {
  const label = index === undefined
    ? 'AttachmentRef'
    : `RunIntent.attachments[${index}]`
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TaskRunProtocolError(`${label} is invalid`)
  }
  if (value.kind === 'artifact') {
    if (!isExactRecord(value, ['kind', 'runId', 'artifactId'])) {
      throw new TaskRunProtocolError(`${label} artifact reference has unsupported fields`)
    }
    const runId = parseId(value.runId, `${label}.runId`)
    if (typeof value.artifactId !== 'string'
      || !ARTIFACT_ID_PATTERN.test(value.artifactId)) {
      throw new TaskRunProtocolError(`${label}.artifactId is invalid`)
    }
    return { kind: 'artifact', runId, artifactId: value.artifactId }
  }
  if (value.kind === 'node') {
    if (!isExactRecord(value, ['kind', 'nodeId'])) {
      throw new TaskRunProtocolError(`${label} node reference has unsupported fields`)
    }
    return { kind: 'node', nodeId: parseId(value.nodeId, `${label}.nodeId`) }
  }
  throw new TaskRunProtocolError(`${label}.kind is unsupported`)
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_RUN_INTENT_ID_LENGTH
    || !ID_PATTERN.test(value)
    || value.includes('..')) {
    throw new TaskRunProtocolError(`${label} is invalid`)
  }
  return value
}

function parseBranch(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_RUN_INTENT_BRANCH_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.endsWith('.lock')
    || value.split('/').some((part) => part === '.' || part.endsWith('.'))) {
    throw new TaskRunProtocolError('RunIntent.canvasBranch is invalid')
  }
  return value
}

function attachmentKey(value: AttachmentRef): string {
  return value.kind === 'artifact'
    ? `artifact:${value.runId}:${value.artifactId}`
    : `node:${value.nodeId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
