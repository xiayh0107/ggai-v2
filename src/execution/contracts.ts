import type { CanvasNodeTypeRef } from '../canvas/model.js'

export const MAX_EXECUTION_OUTPUT_ITEMS = 1_024
export const MAX_INLINE_EXECUTION_JSON_BYTES = 256 * 1024

export type NodeExecutionStatus =
  | 'queued'
  | 'awaiting-approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out'

export type ValueRef =
  | { kind: 'json'; value: unknown }
  | { kind: 'artifact'; runId: string; artifactId: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'execution-output'; executionId: string; port: string; itemKey?: string }

export interface NodeExecution {
  executionId: string
  projectId: string
  canvasBranch: string
  nodeId: string
  nodeTypeRef: CanvasNodeTypeRef
  executorId: string
  artifactRunId: string
  inputsDigest: string
  codeDigest?: string
  environmentDigest: string
  cacheKey: string
  status: NodeExecutionStatus
  outputs: Record<string, ValueRef[]>
  startedAt: string
  finishedAt?: string
  error?: { code: string; message: string }
}

export interface ExecutionOutputItem {
  portKey: string
  itemKey: string
  itemOrder: number
  value: ValueRef
}

export function validateExecutionOutputs(outputs: Record<string, ValueRef[]>): ExecutionOutputItem[] {
  if (!isRecord(outputs)) throw new TypeError('execution outputs must be an object')
  const items: ExecutionOutputItem[] = []
  for (const portKey of Object.keys(outputs).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(portKey)) {
      throw new TypeError(`execution output port is invalid: ${portKey}`)
    }
    const values = outputs[portKey]
    if (!Array.isArray(values)) throw new TypeError(`execution output ${portKey} must be an array`)
    values.forEach((value, itemOrder) => {
      validateValueRef(value, `${portKey}[${itemOrder}]`)
      items.push({ portKey, itemKey: String(itemOrder), itemOrder, value: structuredClone(value) })
    })
  }
  if (items.length > MAX_EXECUTION_OUTPUT_ITEMS) {
    throw new TypeError(`execution outputs exceed ${MAX_EXECUTION_OUTPUT_ITEMS} items`)
  }
  return items
}

function validateValueRef(value: unknown, label: string): asserts value is ValueRef {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new TypeError(`${label} is invalid`)
  if (value.kind === 'json') {
    if (!hasExactKeys(value, ['kind', 'value'])) throw new TypeError(`${label} is invalid`)
    const encoded = JSON.stringify(value.value)
    if (encoded === undefined
      || new TextEncoder().encode(encoded).byteLength > MAX_INLINE_EXECUTION_JSON_BYTES) {
      throw new TypeError(`${label} inline JSON is too large or invalid`)
    }
    return
  }
  if (value.kind === 'artifact'
    && hasExactKeys(value, ['kind', 'runId', 'artifactId'])
    && validId(value.runId)
    && typeof value.artifactId === 'string'
    && /^artifact_[0-9a-f]{64}$/u.test(value.artifactId)) return
  if (value.kind === 'node'
    && hasExactKeys(value, ['kind', 'nodeId'])
    && validId(value.nodeId)) return
  if (value.kind === 'execution-output'
    && hasExactKeys(value, value.itemKey === undefined
      ? ['kind', 'executionId', 'port']
      : ['kind', 'executionId', 'port', 'itemKey'])
    && validId(value.executionId)
    && typeof value.port === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.port)
    && (value.itemKey === undefined || validId(value.itemKey))) return
  throw new TypeError(`${label} is invalid`)
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    && !value.includes('..')
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
