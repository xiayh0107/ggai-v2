import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  atomicWriteText,
  findLatestQuarantine,
  isNodeError,
  quarantineFile,
} from './atomic-file.js'
import { parseCanvasBranch } from './protocol.js'

/** The in-memory form of a persisted node/agent session. */
export interface SessionRecord {
  canvasBranch: string
  nodeId: string
  agentId: string
  sessionId: string | null
  createdAt: number
  lastActiveAt: number
}

/** Fields accepted by {@link SessionStore.upsert}. */
export interface SessionUpsert {
  canvasBranch?: string
  nodeId: string
  agentId: string
  sessionId: string | null
  createdAt?: number
  lastActiveAt?: number
}

export interface SessionListFilter {
  canvasBranch?: string
  nodeId?: string
  agentId?: string
}

export interface SessionRecovery {
  sessionsPath: string
  quarantinePath: string
  reason: string
}

export interface SessionStoreOptions {
  /** Override the default `<projectDir>/.gg/sessions.json` location. */
  filePath?: string
  /** Injectable clock, primarily for deterministic callers and tests. */
  now?: () => number
  /** Revalidates daemon-owned parent paths before every cached read or write. */
  validatePath?: () => Promise<void>
}

interface StoredSessionRecord {
  sessionId: string | null
  createdAt: number
  lastActiveAt: number
}

/**
 * Raised after a damaged sessions file has been moved out of the way.
 *
 * The store remains blocked until `recover()` is called. The quarantined file
 * is never deleted by the store, so a caller can inspect or salvage it first.
 */
export class SessionsCorruptionError extends Error {
  readonly recovery: SessionRecovery

  constructor(recovery: SessionRecovery, cause?: unknown) {
    super(
      `Invalid sessions file was quarantined at ${recovery.quarantinePath}; ` +
        'call recover() explicitly before continuing',
      { cause },
    )
    this.name = 'SessionsCorruptionError'
    this.recovery = recovery
  }
}

/**
 * Produces a stable, unambiguous key while preserving the documented
 * `canvasBranch:nodeId:agentId` shape for ordinary identifiers.
 */
export function sessionKey(nodeId: string, agentId: string, canvasBranch = 'main'): string {
  const branch = parseCanvasBranch(canvasBranch)
  assertIdentifier(nodeId, 'nodeId')
  assertIdentifier(agentId, 'agentId')
  return `${encodeURIComponent(branch)}:${encodeURIComponent(nodeId)}:${encodeURIComponent(agentId)}`
}

export function sessionsFilePath(projectDir: string): string {
  if (typeof projectDir !== 'string' || projectDir.trim().length === 0) {
    throw new TypeError('projectDir must be a non-empty string')
  }
  return resolve(projectDir, '.gg', 'sessions.json')
}

/**
 * Durable node/agent session storage.
 *
 * All operations are serialized within a store instance. Writes use a unique
 * temporary file in the destination directory, fsync it, and atomically rename
 * it over `sessions.json`.
 */
export class SessionStore {
  readonly filePath: string

  readonly #now: () => number
  readonly #validatePath?: () => Promise<void>
  #records: Map<string, SessionRecord> | null = null
  #recovery: SessionRecovery | null = null
  #operationTail: Promise<void> = Promise.resolve()

  constructor(projectDir: string, options: SessionStoreOptions = {}) {
    this.filePath = options.filePath
      ? resolve(options.filePath)
      : sessionsFilePath(projectDir)
    this.#now = options.now ?? Date.now
    this.#validatePath = options.validatePath
  }

  async get(
    nodeId: string,
    agentId: string,
    canvasBranch = 'main',
  ): Promise<SessionRecord | undefined> {
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      await this.#ensureLoaded()
      const record = this.#records?.get(sessionKey(nodeId, agentId, canvasBranch))
      return record ? { ...record } : undefined
    })
  }

  async list(filter: SessionListFilter = {}): Promise<SessionRecord[]> {
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      await this.#ensureLoaded()
      return [...(this.#records?.values() ?? [])]
        .filter(
          (record) =>
            (filter.canvasBranch === undefined || record.canvasBranch === filter.canvasBranch) &&
            (filter.nodeId === undefined || record.nodeId === filter.nodeId) &&
            (filter.agentId === undefined || record.agentId === filter.agentId),
        )
        .sort(compareRecords)
        .map((record) => ({ ...record }))
    })
  }

  async upsert(input: SessionUpsert): Promise<SessionRecord> {
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      await this.#ensureLoaded()
      assertIdentifier(input.nodeId, 'nodeId')
      assertIdentifier(input.agentId, 'agentId')
      assertSessionId(input.sessionId)

      const canvasBranch = parseCanvasBranch(input.canvasBranch ?? 'main')
      const key = sessionKey(input.nodeId, input.agentId, canvasBranch)
      const existing = this.#records?.get(key)
      const now = this.#now()
      const record: SessionRecord = {
        canvasBranch,
        nodeId: input.nodeId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        createdAt: input.createdAt ?? existing?.createdAt ?? now,
        lastActiveAt: input.lastActiveAt ?? now,
      }
      assertSessionRecord(record)

      const next = new Map(this.#records ?? [])
      next.set(key, record)
      await atomicWriteText(this.filePath, serializeRecords(next))
      this.#records = next
      return { ...record }
    })
  }

  /**
   * Explicitly rebuilds `sessions.json` after corruption (or for a deliberate
   * administrative replacement). Existing quarantine files are retained.
   */
  async recover(records: readonly SessionRecord[] = []): Promise<SessionRecord[]> {
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      const recovered = new Map<string, SessionRecord>()
      for (const source of records) {
        const record = { ...source }
        assertSessionRecord(record)
        const key = sessionKey(record.nodeId, record.agentId, record.canvasBranch)
        if (recovered.has(key)) {
          throw new TypeError(`Duplicate recovered session key: ${key}`)
        }
        recovered.set(key, record)
      }

      await atomicWriteText(this.filePath, serializeRecords(recovered))
      this.#records = recovered
      this.#recovery = null
      return [...recovered.values()].sort(compareRecords).map((record) => ({ ...record }))
    })
  }

  /** Returns corruption details after a failed load without clearing them. */
  get recovery(): SessionRecovery | null {
    return this.#recovery ? { ...this.#recovery } : null
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#recovery) {
      throw new SessionsCorruptionError(this.#recovery)
    }
    if (this.#records) return

    let source: string
    try {
      source = await readTextNoFollow(this.filePath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      const priorQuarantine = await findLatestQuarantine(this.filePath)
      if (priorQuarantine) {
        const recovery: SessionRecovery = {
          sessionsPath: this.filePath,
          quarantinePath: priorQuarantine,
          reason: 'A quarantined sessions file is awaiting explicit recovery',
        }
        this.#recovery = recovery
        throw new SessionsCorruptionError(recovery)
      }
      this.#records = new Map()
      return
    }

    try {
      this.#records = parseRecords(source)
    } catch (error) {
      const quarantine = await quarantineFile(this.filePath, error)
      const recovery: SessionRecovery = {
        sessionsPath: quarantine.filePath,
        quarantinePath: quarantine.quarantinePath,
        reason: quarantine.reason,
      }
      this.#recovery = recovery
      throw new SessionsCorruptionError(recovery, error)
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

function parseRecords(source: string): Map<string, SessionRecord> {
  const document: unknown = JSON.parse(source)
  if (!isPlainObject(document)) {
    throw new TypeError('sessions.json must contain an object keyed by node and agent')
  }

  const records = new Map<string, SessionRecord>()
  for (const [key, value] of Object.entries(document)) {
    const [canvasBranch, nodeId, agentId] = decodeSessionKey(key)
    if (!isPlainObject(value)) {
      throw new TypeError(`Session ${key} must be an object`)
    }

    const sessionId = value.sessionId
    const lastActiveAt = value.lastActiveAt
    const createdAt = value.createdAt ?? lastActiveAt
    const record: SessionRecord = {
      canvasBranch,
      nodeId,
      agentId,
      sessionId: sessionId as string | null,
      createdAt: createdAt as number,
      lastActiveAt: lastActiveAt as number,
    }
    assertSessionRecord(record)
    const canonicalKey = sessionKey(nodeId, agentId, canvasBranch)
    if (records.has(canonicalKey)) {
      throw new TypeError(`Duplicate canonical session key: ${canonicalKey}`)
    }
    records.set(canonicalKey, record)
  }
  return records
}

function serializeRecords(records: ReadonlyMap<string, SessionRecord>): string {
  const document: Record<string, StoredSessionRecord> = Object.create(null) as Record<
    string,
    StoredSessionRecord
  >
  for (const [key, record] of [...records.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    document[key] = {
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
    }
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function decodeSessionKey(key: string): [string, string, string] {
  const parts = key.split(':')
  if (parts.length !== 2 && parts.length !== 3) {
    throw new TypeError(`Invalid session key: ${key}`)
  }
  try {
    // Version-one session files used nodeId:agentId keys. They remain readable
    // as main-branch records and are rewritten in the branch-aware format on
    // the next mutation.
    const [encodedBranch, encodedNodeId, encodedAgentId] = parts.length === 3
      ? parts
      : ['main', parts[0], parts[1]]
    const canvasBranch = parseCanvasBranch(decodeURIComponent(encodedBranch ?? ''))
    const nodeId = decodeURIComponent(encodedNodeId ?? '')
    const agentId = decodeURIComponent(encodedAgentId ?? '')
    assertIdentifier(nodeId, 'nodeId')
    assertIdentifier(agentId, 'agentId')
    return [canvasBranch, nodeId, agentId]
  } catch (error) {
    throw new TypeError(`Invalid encoded session key: ${key}`, { cause: error })
  }
}

function assertSessionRecord(record: SessionRecord): void {
  parseCanvasBranch(record.canvasBranch)
  assertIdentifier(record.nodeId, 'nodeId')
  assertIdentifier(record.agentId, 'agentId')
  assertSessionId(record.sessionId)
  assertTimestamp(record.createdAt, 'createdAt')
  assertTimestamp(record.lastActiveAt, 'lastActiveAt')
  if (record.lastActiveAt < record.createdAt) {
    throw new TypeError('lastActiveAt cannot be earlier than createdAt')
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertSessionId(value: unknown): asserts value is string | null {
  if (value === null) return
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || value.startsWith('-')
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError('sessionId is not a safe non-empty CLI session identifier')
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite, non-negative number`)
  }
}

function compareRecords(left: SessionRecord, right: SessionRecord): number {
  return left.canvasBranch.localeCompare(right.canvasBranch)
    || left.nodeId.localeCompare(right.nodeId)
    || left.agentId.localeCompare(right.agentId)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readTextNoFollow(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}
