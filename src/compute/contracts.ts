export const COMPUTE_RESULT_SCHEMA_VERSION = 1 as const
export const MAX_COMPUTE_CODE_BYTES = 256 * 1024
export const MAX_COMPUTE_OUTPUT_BYTES = 256 * 1024 * 1024
export const MAX_COMPUTE_RESULT_BYTES = 256 * 1024

export type ComputeRuntimePresetId = 'python-3.13' | 'node-24'

export interface ComputeNodePayload {
  runtime: ComputeRuntimePresetId
  code: string
  timeoutMs: number
  memoryMb: number
  cpus: number
  pids: number
}

export interface ComputeResultSidecar {
  schemaVersion: typeof COMPUTE_RESULT_SCHEMA_VERSION
  outputs: Record<string, Array<{ path: string }>>
}

export function parseComputeNodePayload(value: unknown): ComputeNodePayload {
  if (!isRecord(value)
    || !exactKeys(value, ['code', 'cpus', 'memoryMb', 'pids', 'runtime', 'timeoutMs'])
    || (value.runtime !== 'python-3.13' && value.runtime !== 'node-24')
    || typeof value.code !== 'string'
    || new TextEncoder().encode(value.code).byteLength < 1
    || new TextEncoder().encode(value.code).byteLength > MAX_COMPUTE_CODE_BYTES
    || !integerInRange(value.timeoutMs, 1_000, 300_000)
    || !integerInRange(value.memoryMb, 64, 4_096)
    || !finiteInRange(value.cpus, 0.1, 4)
    || !integerInRange(value.pids, 8, 256)) {
    throw new TypeError('compute node payload is invalid')
  }
  return structuredClone(value) as unknown as ComputeNodePayload
}

export function parseComputeResultSidecar(value: unknown): ComputeResultSidecar {
  if (!isRecord(value) || !exactKeys(value, ['outputs', 'schemaVersion'])
    || value.schemaVersion !== COMPUTE_RESULT_SCHEMA_VERSION
    || !isRecord(value.outputs)) throw new TypeError('execution-result sidecar is invalid')
  const ports = Object.keys(value.outputs)
  if (ports.length > 128 || ports.some((port) => !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(port))) {
    throw new TypeError('execution-result sidecar ports are invalid')
  }
  let itemCount = 0
  const seen = new Set<string>()
  for (const port of ports) {
    const items = value.outputs[port]
    if (!Array.isArray(items)) throw new TypeError('execution-result sidecar items are invalid')
    for (const item of items) {
      itemCount += 1
      if (!isRecord(item) || !exactKeys(item, ['path']) || !validRelativePath(item.path)) {
        throw new TypeError('execution-result sidecar output path is invalid')
      }
      if (seen.has(item.path)) throw new TypeError('execution-result sidecar output path is duplicated')
      seen.add(item.path)
    }
  }
  if (itemCount > 1_024) throw new TypeError('execution-result sidecar has too many outputs')
  return structuredClone(value) as unknown as ComputeResultSidecar
}

function validRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 500
    && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && value !== 'execution-result.json'
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join('\0') === expected.sort().join('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
