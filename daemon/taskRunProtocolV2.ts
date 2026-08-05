export const RUN_INTENT_V2_SCHEMA_VERSION = 2
export const MAX_RUN_INTENT_V2_PROMPT_LENGTH = 250_000
export const MAX_RUN_INTENT_V2_ATTACHMENTS = 100
export const MAX_RUN_INTENT_V2_ID_LENGTH = 160
export const MAX_RUN_INTENT_V2_BRANCH_LENGTH = 120

export interface ArtifactAttachmentRefV2 {
  kind: 'artifact'
  runId: string
  artifactId: string
}

/** A semantic node reference; it never carries node content or a filesystem path. */
export interface NodeAttachmentRefV2 {
  kind: 'node'
  nodeId: string
}

export type AttachmentRefV2 = ArtifactAttachmentRefV2 | NodeAttachmentRefV2

export interface RunIntentV2 {
  schemaVersion: 2
  runId: string
  taskId: string
  agentId: string
  canvasBranch: string
  baseRevision: number
  prompt: string
  attachments: AttachmentRefV2[]
  materializationPolicy: 'auto'
}

export class TaskRunProtocolV2Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskRunProtocolV2Error'
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

/** Strict trust-boundary parser. Unknown, missing, or V1 compatibility fields fail closed. */
export function parseRunIntentV2(value: unknown): RunIntentV2 {
  if (!isExactRecord(value, RUN_INTENT_KEYS)) {
    throw new TaskRunProtocolV2Error('RunIntentV2 must have the exact V2 fields')
  }
  if (value.schemaVersion !== RUN_INTENT_V2_SCHEMA_VERSION) {
    throw new TaskRunProtocolV2Error('RunIntentV2.schemaVersion must be 2')
  }
  const runId = parseId(value.runId, 'RunIntentV2.runId')
  const taskId = parseId(value.taskId, 'RunIntentV2.taskId')
  const agentId = parseId(value.agentId, 'RunIntentV2.agentId')
  const canvasBranch = parseBranch(value.canvasBranch)
  if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) {
    throw new TaskRunProtocolV2Error(
      'RunIntentV2.baseRevision must be a non-negative safe integer',
    )
  }
  if (typeof value.prompt !== 'string'
    || value.prompt.length > MAX_RUN_INTENT_V2_PROMPT_LENGTH) {
    throw new TaskRunProtocolV2Error('RunIntentV2.prompt is invalid')
  }
  if (!Array.isArray(value.attachments)
    || value.attachments.length > MAX_RUN_INTENT_V2_ATTACHMENTS) {
    throw new TaskRunProtocolV2Error('RunIntentV2.attachments is invalid')
  }
  const attachments = value.attachments.map(parseAttachmentRefV2)
  const attachmentKeys = attachments.map(attachmentKey)
  if (new Set(attachmentKeys).size !== attachmentKeys.length) {
    throw new TaskRunProtocolV2Error('RunIntentV2.attachments contains duplicates')
  }
  if (value.materializationPolicy !== 'auto') {
    throw new TaskRunProtocolV2Error('RunIntentV2.materializationPolicy must be auto')
  }

  return {
    schemaVersion: RUN_INTENT_V2_SCHEMA_VERSION,
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

export function parseTaskIdV2(value: unknown): string {
  return parseId(value, 'taskId')
}

export function parseAttachmentRefV2(value: unknown, index?: number): AttachmentRefV2 {
  const label = index === undefined
    ? 'AttachmentRefV2'
    : `RunIntentV2.attachments[${index}]`
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TaskRunProtocolV2Error(`${label} is invalid`)
  }
  if (value.kind === 'artifact') {
    if (!isExactRecord(value, ['kind', 'runId', 'artifactId'])) {
      throw new TaskRunProtocolV2Error(`${label} artifact reference has unsupported fields`)
    }
    const runId = parseId(value.runId, `${label}.runId`)
    if (typeof value.artifactId !== 'string'
      || !ARTIFACT_ID_PATTERN.test(value.artifactId)) {
      throw new TaskRunProtocolV2Error(`${label}.artifactId is invalid`)
    }
    return { kind: 'artifact', runId, artifactId: value.artifactId }
  }
  if (value.kind === 'node') {
    if (!isExactRecord(value, ['kind', 'nodeId'])) {
      throw new TaskRunProtocolV2Error(`${label} node reference has unsupported fields`)
    }
    return { kind: 'node', nodeId: parseId(value.nodeId, `${label}.nodeId`) }
  }
  throw new TaskRunProtocolV2Error(`${label}.kind is unsupported`)
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_RUN_INTENT_V2_ID_LENGTH
    || !ID_PATTERN.test(value)
    || value.includes('..')) {
    throw new TaskRunProtocolV2Error(`${label} is invalid`)
  }
  return value
}

function parseBranch(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_RUN_INTENT_V2_BRANCH_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.endsWith('.lock')
    || value.split('/').some((part) => part === '.' || part.endsWith('.'))) {
    throw new TaskRunProtocolV2Error('RunIntentV2.canvasBranch is invalid')
  }
  return value
}

function attachmentKey(value: AttachmentRefV2): string {
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
