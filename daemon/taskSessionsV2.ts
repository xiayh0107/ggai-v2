import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  atomicWriteText,
  findLatestQuarantine,
  isNodeError,
  quarantineFile,
} from './atomic-file.js'
import { parseCanvasBranch } from './protocol.js'

export const MAX_TASK_SESSION_RECORDS_V2 = 10_000
export const MAX_TASK_SESSIONS_FILE_BYTES_V2 = 8 * 1024 * 1024
export const MAX_TASK_SESSION_ID_LENGTH_V2 = 512

export interface TaskSessionRecordV2 {
  canvasBranch: string
  taskId: string
  agentId: string
  sessionId: string | null
  createdAt: number
  lastActiveAt: number
}

export interface TaskSessionUpsertV2 {
  canvasBranch: string
  taskId: string
  agentId: string
  sessionId: string | null
  createdAt?: number
  lastActiveAt?: number
}

export interface TaskSessionListFilterV2 {
  canvasBranch?: string
  taskId?: string
  agentId?: string
}

export interface TaskSessionRecoveryV2 {
  filePath: string
  quarantinePath: string
  reason: string
}

export interface TaskSessionStoreV2Options {
  now?: () => number
  /** Revalidates daemon-owned parent directories before each read or write. */
  validatePath?: () => Promise<void>
}

/** Raised after invalid persistent data has been quarantined. */
export class TaskSessionsV2CorruptionError extends Error {
  readonly recovery: TaskSessionRecoveryV2

  constructor(recovery: TaskSessionRecoveryV2, cause?: unknown) {
    super(
      `Invalid task sessions file was quarantined at ${recovery.quarantinePath}; `
      + 'operator recovery is required before continuing',
      { cause },
    )
    this.name = 'TaskSessionsV2CorruptionError'
    this.recovery = recovery
  }
}

/** Canonical key for the strict canvasBranch + taskId + agentId identity. */
export function taskSessionKeyV2(
  canvasBranch: string,
  taskId: string,
  agentId: string,
): string {
  const branch = parseCanvasBranch(canvasBranch)
  const task = parseTaskId(taskId)
  const agent = parseAgentId(agentId)
  return `${encodeURIComponent(branch)}:${encodeURIComponent(task)}:${encodeURIComponent(agent)}`
}

/**
 * Independent durable task-session storage.
 *
 * `filePath` is supplied by the owner and is the only persistence location.
 * Operations on one instance are serialized; writes are fsynced and atomically
 * renamed by atomicWriteText.
 */
export class TaskSessionStoreV2 {
  readonly filePath: string

  readonly #now: () => number
  readonly #validatePath?: () => Promise<void>
  #records: Map<string, TaskSessionRecordV2> | null = null
  #recovery: TaskSessionRecoveryV2 | null = null
  #operationTail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: TaskSessionStoreV2Options = {}) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TypeError('filePath must be a non-empty string')
    }
    this.filePath = resolve(filePath)
    this.#now = options.now ?? Date.now
    this.#validatePath = options.validatePath
  }

  async get(
    canvasBranch: string,
    taskId: string,
    agentId: string,
  ): Promise<TaskSessionRecordV2 | undefined> {
    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const record = this.#records?.get(taskSessionKeyV2(canvasBranch, taskId, agentId))
      return record ? { ...record } : undefined
    })
  }

  async list(filter: TaskSessionListFilterV2 = {}): Promise<TaskSessionRecordV2[]> {
    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const canvasBranch = filter.canvasBranch === undefined
        ? undefined
        : parseCanvasBranch(filter.canvasBranch)
      const taskId = filter.taskId === undefined ? undefined : parseTaskId(filter.taskId)
      const agentId = filter.agentId === undefined ? undefined : parseAgentId(filter.agentId)
      return [...(this.#records?.values() ?? [])]
        .filter((record) =>
          (canvasBranch === undefined || record.canvasBranch === canvasBranch)
          && (taskId === undefined || record.taskId === taskId)
          && (agentId === undefined || record.agentId === agentId))
        .sort(compareRecords)
        .map((record) => ({ ...record }))
    })
  }

  async upsert(input: TaskSessionUpsertV2): Promise<TaskSessionRecordV2> {
    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const canvasBranch = parseCanvasBranch(input.canvasBranch)
      const taskId = parseTaskId(input.taskId)
      const agentId = parseAgentId(input.agentId)
      const sessionId = parseSessionId(input.sessionId)
      const key = taskSessionKeyV2(canvasBranch, taskId, agentId)
      const existing = this.#records?.get(key)
      const now = this.#now()
      assertTimestamp(now, 'now')

      const record: TaskSessionRecordV2 = {
        canvasBranch,
        taskId,
        agentId,
        sessionId,
        createdAt: existing?.createdAt ?? input.createdAt ?? now,
        lastActiveAt: input.lastActiveAt ?? now,
      }
      assertTaskSessionRecord(record)
      const next = new Map(this.#records ?? [])
      next.set(key, record)

      await this.#preparePath()
      await atomicWriteText(this.filePath, serializeRecords(next))
      this.#records = next
      return { ...record }
    })
  }

  get recovery(): TaskSessionRecoveryV2 | null {
    return this.#recovery ? { ...this.#recovery } : null
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#recovery) throw new TaskSessionsV2CorruptionError(this.#recovery)
    if (this.#records) return

    let source: string
    try {
      source = await readTextNoFollow(this.filePath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      const priorQuarantine = await findLatestQuarantine(this.filePath)
      if (priorQuarantine) {
        const recovery: TaskSessionRecoveryV2 = {
          filePath: this.filePath,
          quarantinePath: priorQuarantine,
          reason: 'A quarantined task sessions file is awaiting operator recovery',
        }
        this.#recovery = recovery
        throw new TaskSessionsV2CorruptionError(recovery)
      }
      this.#records = new Map()
      return
    }

    try {
      this.#records = parseRecords(source)
    } catch (error) {
      const quarantine = await quarantineFile(this.filePath, error)
      const recovery: TaskSessionRecoveryV2 = {
        filePath: quarantine.filePath,
        quarantinePath: quarantine.quarantinePath,
        reason: quarantine.reason,
      }
      this.#recovery = recovery
      throw new TaskSessionsV2CorruptionError(recovery, error)
    }
  }

  async #preparePath(): Promise<void> {
    await this.#validatePath?.()
    try {
      const status = await lstat(this.filePath)
      if (status.isSymbolicLink()) throw new TypeError('task sessions file must not be a symlink')
      if (!status.isFile()) throw new TypeError('task sessions path must be a regular file')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function parseRecords(source: string): Map<string, TaskSessionRecordV2> {
  if (Buffer.byteLength(source, 'utf8') > MAX_TASK_SESSIONS_FILE_BYTES_V2) {
    throw new TypeError('task sessions file exceeds the supported size')
  }
  const document: unknown = JSON.parse(source)
  if (!isPlainObject(document)) {
    throw new TypeError('task sessions file must contain a keyed object')
  }
  const entries = Object.entries(document)
  if (entries.length > MAX_TASK_SESSION_RECORDS_V2) {
    throw new TypeError('task sessions file has too many records')
  }

  const records = new Map<string, TaskSessionRecordV2>()
  for (const [storedKey, value] of entries) {
    if (!isExactRecord(value, [
      'canvasBranch',
      'taskId',
      'agentId',
      'sessionId',
      'createdAt',
      'lastActiveAt',
    ])) throw new TypeError(`Task session ${storedKey} has an invalid record shape`)
    const record: TaskSessionRecordV2 = {
      canvasBranch: value.canvasBranch as string,
      taskId: value.taskId as string,
      agentId: value.agentId as string,
      sessionId: value.sessionId as string | null,
      createdAt: value.createdAt as number,
      lastActiveAt: value.lastActiveAt as number,
    }
    assertTaskSessionRecord(record)
    const canonicalKey = taskSessionKeyV2(record.canvasBranch, record.taskId, record.agentId)
    if (storedKey !== canonicalKey) {
      throw new TypeError(`Task session key does not match record identity: ${storedKey}`)
    }
    if (records.has(canonicalKey)) {
      throw new TypeError(`Duplicate task session key: ${canonicalKey}`)
    }
    records.set(canonicalKey, record)
  }
  return records
}

function serializeRecords(records: ReadonlyMap<string, TaskSessionRecordV2>): string {
  if (records.size > MAX_TASK_SESSION_RECORDS_V2) {
    throw new TypeError('task session store has too many records')
  }
  const document: Record<string, TaskSessionRecordV2> = Object.create(null) as Record<
    string,
    TaskSessionRecordV2
  >
  for (const [key, record] of [...records.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    assertTaskSessionRecord(record)
    if (key !== taskSessionKeyV2(record.canvasBranch, record.taskId, record.agentId)) {
      throw new TypeError(`Task session key does not match record identity: ${key}`)
    }
    document[key] = { ...record }
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function assertTaskSessionRecord(record: TaskSessionRecordV2): void {
  parseCanvasBranch(record.canvasBranch)
  parseTaskId(record.taskId)
  parseAgentId(record.agentId)
  parseSessionId(record.sessionId)
  assertTimestamp(record.createdAt, 'createdAt')
  assertTimestamp(record.lastActiveAt, 'lastActiveAt')
  if (record.lastActiveAt < record.createdAt) {
    throw new TypeError('lastActiveAt cannot be earlier than createdAt')
  }
}

function parseTaskId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    || value.includes('..')) throw new TypeError('taskId is invalid')
  return value
}

function parseAgentId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !/^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
    || value.includes('..')
    || value.includes('//')) throw new TypeError('agentId is invalid')
  return value
}

function parseSessionId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_TASK_SESSION_ID_LENGTH_V2
    || value !== value.trim()
    || value.startsWith('-')) {
    throw new TypeError('sessionId is not a safe CLI session identifier')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError('sessionId is not a safe CLI session identifier')
    }
  }
  return value
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite, non-negative number`)
  }
}

function compareRecords(left: TaskSessionRecordV2, right: TaskSessionRecordV2): number {
  return left.canvasBranch.localeCompare(right.canvasBranch)
    || left.taskId.localeCompare(right.taskId)
    || left.agentId.localeCompare(right.agentId)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

async function readTextNoFollow(filePath: string): Promise<string> {
  const noFollowFlag = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(filePath, constants.O_RDONLY | noFollowFlag)
  try {
    const status = await handle.stat()
    if (!status.isFile()) throw new TypeError('task sessions path must be a regular file')
    if (status.size > MAX_TASK_SESSIONS_FILE_BYTES_V2) {
      throw new TypeError('task sessions file exceeds the supported size')
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}
