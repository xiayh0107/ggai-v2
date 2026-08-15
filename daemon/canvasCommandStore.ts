import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  applyCanvasCommand,
  type CanvasCommand,
} from '../src/canvas/commands.js'
import {
  emptyCanvasDocument,
  parseCanvasDocument,
  type CanvasDocument,
} from '../src/canvas/model.js'
import { atomicWriteText, isNodeError } from './atomic-file.js'
import { parseCanvasBranch } from './protocol.js'

const EMPTY_UPDATED_AT = '1970-01-01T00:00:00.000Z'

export interface CanvasEnvelope {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  lastCheckpoint: string | null
  document: CanvasDocument
}

export interface CanvasCommandStoreOptions {
  filePath: string
  revisionDirectory?: string
  now?: () => number
}

interface CanvasMutationReceipt {
  mutationId: string
  commandDigest: string
  committedRevision: number
}

interface StoredCanvasEnvelope extends CanvasEnvelope {
  /** Runtime-only exactly-once ledger. It never enters CanvasDocument or Canvas Git. */
  mutationReceipts: CanvasMutationReceipt[]
}

export class CanvasRevisionConflictError extends Error {
  readonly currentRevision: number

  constructor(currentRevision: number) {
    super(`Canvas revision changed; current revision is ${currentRevision}`)
    this.name = 'CanvasRevisionConflictError'
    this.currentRevision = currentRevision
  }
}

export class CanvasMutationReuseError extends Error {
  readonly mutationId: string

  constructor(mutationId: string) {
    super(`Canvas mutation id was reused with another base revision: ${mutationId}`)
    this.name = 'CanvasMutationReuseError'
    this.mutationId = mutationId
  }
}

export class CanvasSnapshotError extends Error {
  readonly filePath: string

  constructor(filePath: string, cause: unknown) {
    super(`Invalid Canvas snapshot at ${filePath}`, { cause })
    this.name = 'CanvasSnapshotError'
    this.filePath = filePath
  }
}

/** Durable, serialized command/CAS boundary for one logical canvas branch. */
export class CanvasCommandStore {
  readonly branch: string
  readonly filePath: string
  readonly revisionDirectory: string

  readonly #now: () => number
  #envelope: StoredCanvasEnvelope | null = null
  #operationTail: Promise<void> = Promise.resolve()

  constructor(branch: string, options: CanvasCommandStoreOptions) {
    this.branch = parseCanvasBranch(branch)
    this.filePath = path.resolve(options.filePath)
    this.revisionDirectory = path.resolve(
      options.revisionDirectory ?? path.join(path.dirname(this.filePath), 'revisions'),
    )
    this.#now = options.now ?? Date.now
  }

  async get(): Promise<CanvasEnvelope> {
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      return cloneEnvelope(this.#current())
    })
  }

  /** Reads an immutable semantic revision used only for explicit conflict recovery. */
  async readRevision(revision: number): Promise<CanvasDocument | null> {
    validateRevision(revision)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      if (revision > current.revision) return null
      if (revision === current.revision) return structuredClone(current.document)
      const record = await this.#readRevisionRecord(revision)
      return record ? structuredClone(record.document) : null
    })
  }

  /** Checks durable branch existence without constructing or persisting an empty envelope. */
  async hasSnapshot(): Promise<boolean> {
    return this.#runExclusive(async () => {
      try {
        const info = await lstat(this.filePath)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new TypeError('Canvas snapshot path is not a regular file')
        }
        return true
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return false
        if (error instanceof CanvasSnapshotError) throw error
        throw new CanvasSnapshotError(this.filePath, error)
      }
    })
  }

  async commit(
    baseRevision: number,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<CanvasEnvelope> {
    validateRevision(baseRevision)
    validateMutationId(mutationId)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      const digest = canvasCommandDigest(command)
      const receipt = findMutationReceipt(current, mutationId)
      if (receipt) {
        if (receipt.commandDigest === digest) return cloneEnvelope(current)
        throw new CanvasMutationReuseError(mutationId)
      }
      if (baseRevision !== current.revision) {
        throw new CanvasRevisionConflictError(current.revision)
      }

      const document = applyCanvasCommand(current.document, command)
      const updatedAt = new Date(this.#now()).toISOString()
      const next: StoredCanvasEnvelope = {
        branch: this.branch,
        revision: current.revision + 1,
        updatedAt,
        lastMutationId: mutationId,
        lastCheckpoint: current.lastCheckpoint,
        document,
        mutationReceipts: [...current.mutationReceipts, {
          mutationId,
          commandDigest: digest,
          committedRevision: current.revision + 1,
        }],
      }
      await this.#persistSemanticEnvelope(current, next)
      this.#envelope = next
      return cloneEnvelope(next)
    })
  }

  /**
   * Applies a daemon-authoritative command to the latest durable revision.
   *
   * This boundary is intentionally not exposed to browser requests. It lets a
   * durable run settlement materialize its trusted plan without opening a
   * read/CAS race with ordinary canvas commands. Trusted receipt replays return
   * the existing envelope without manufacturing an empty revision.
   */
  async commitLatest(
    mutationId: string,
    command: CanvasCommand,
  ): Promise<CanvasEnvelope> {
    validateMutationId(mutationId)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      const digest = canvasCommandDigest(command)
      const receipt = findMutationReceipt(current, mutationId)
      if (receipt) {
        if (receipt.commandDigest === digest) return cloneEnvelope(current)
        throw new CanvasMutationReuseError(mutationId)
      }
      const document = applyCanvasCommand(current.document, command)
      if (document === current.document) {
        const next: StoredCanvasEnvelope = {
          ...current,
          mutationReceipts: [...current.mutationReceipts, {
            mutationId,
            commandDigest: digest,
            committedRevision: current.revision,
          }],
        }
        await atomicWriteText(this.filePath, serializeEnvelope(next))
        this.#envelope = next
        return cloneEnvelope(next)
      }

      const updatedAt = new Date(this.#now()).toISOString()
      const next: StoredCanvasEnvelope = {
        branch: this.branch,
        revision: current.revision + 1,
        updatedAt,
        lastMutationId: mutationId,
        lastCheckpoint: current.lastCheckpoint,
        document,
        mutationReceipts: [...current.mutationReceipts, {
          mutationId,
          commandDigest: digest,
          committedRevision: current.revision + 1,
        }],
      }
      await this.#persistSemanticEnvelope(current, next)
      this.#envelope = next
      return cloneEnvelope(next)
    })
  }

  /** Persists a Git anchor without manufacturing a semantic Canvas revision. */
  async setLastCheckpoint(
    expectedRevision: number,
    commit: string,
  ): Promise<CanvasEnvelope> {
    validateRevision(expectedRevision)
    validateCheckpoint(commit)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== expectedRevision) {
        throw new CanvasRevisionConflictError(current.revision)
      }
      if (current.lastCheckpoint === commit) return cloneEnvelope(current)

      const next: StoredCanvasEnvelope = { ...current, lastCheckpoint: commit }
      await atomicWriteText(this.filePath, serializeEnvelope(next))
      this.#envelope = next
      return cloneEnvelope(next)
    })
  }

  /** Materializes a Git-only branch while refusing to overwrite runtime state. */
  async materialize(
    document: CanvasDocument,
    checkpoint: string,
  ): Promise<CanvasEnvelope> {
    validateCheckpoint(checkpoint)
    const parsed = parseCanvasDocument(document)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== 0) {
        throw new CanvasRevisionConflictError(current.revision)
      }
      const materialized: StoredCanvasEnvelope = {
        branch: this.branch,
        revision: 1,
        updatedAt: new Date(this.#now()).toISOString(),
        lastMutationId: null,
        lastCheckpoint: checkpoint,
        document: parsed,
        mutationReceipts: [],
      }
      await this.#persistSemanticEnvelope(current, materialized)
      this.#envelope = materialized
      return cloneEnvelope(materialized)
    })
  }

  /** Applies an explicit restore or merge result behind revision CAS. */
  async applyCheckpoint(
    document: CanvasDocument,
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelope> {
    validateCheckpoint(checkpoint)
    validateRevision(expectedRevision)
    const parsed = parseCanvasDocument(document)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== expectedRevision) {
        throw new CanvasRevisionConflictError(current.revision)
      }
      const applied: StoredCanvasEnvelope = {
        branch: this.branch,
        revision: current.revision + 1,
        updatedAt: new Date(this.#now()).toISOString(),
        lastMutationId: null,
        lastCheckpoint: checkpoint,
        document: parsed,
        mutationReceipts: current.mutationReceipts,
      }
      await this.#persistSemanticEnvelope(current, applied)
      this.#envelope = applied
      return cloneEnvelope(applied)
    })
  }

  /** Waits until all operations already queued for this branch have settled. */
  async drain(): Promise<void> {
    await this.#operationTail
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#envelope) return
    let source: string
    try {
      source = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      this.#envelope = emptyEnvelope(this.branch)
      return
    }
    try {
      this.#envelope = parseStoredEnvelope(source, this.branch)
    } catch (error) {
      throw new CanvasSnapshotError(this.filePath, error)
    }
  }

  async #persistSemanticEnvelope(
    current: StoredCanvasEnvelope,
    next: StoredCanvasEnvelope,
  ): Promise<void> {
    if (next.revision !== current.revision + 1) {
      throw new TypeError('Canvas semantic revisions must advance by exactly one')
    }
    await this.#ensureRevisionRecord(current.revision, current.document)
    await atomicWriteText(
      this.#revisionPath(next.revision),
      serializeRevisionRecord(this.branch, next.revision, next.document),
    )
    await atomicWriteText(this.filePath, serializeEnvelope(next))
  }

  async #ensureRevisionRecord(revision: number, document: CanvasDocument): Promise<void> {
    const existing = await this.#readRevisionRecord(revision)
    if (existing) {
      if (canvasDocumentDigest(existing.document) !== canvasDocumentDigest(document)) {
        throw new CanvasSnapshotError(
          this.#revisionPath(revision),
          new TypeError('Canvas revision archive disagrees with the durable snapshot'),
        )
      }
      return
    }
    await atomicWriteText(
      this.#revisionPath(revision),
      serializeRevisionRecord(this.branch, revision, document),
    )
  }

  async #readRevisionRecord(revision: number): Promise<CanvasRevisionRecord | null> {
    const filePath = this.#revisionPath(revision)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new TypeError('Canvas revision path is not a regular file')
      }
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const source = await handle.readFile('utf8')
      return parseRevisionRecord(source, this.branch, revision)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      if (error instanceof CanvasSnapshotError) throw error
      throw new CanvasSnapshotError(filePath, error)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  #revisionPath(revision: number): string {
    validateRevision(revision)
    return path.join(this.revisionDirectory, `${revision}.json`)
  }

  #current(): StoredCanvasEnvelope {
    if (!this.#envelope) throw new Error('Canvas command store was not loaded')
    return this.#envelope
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

interface CanvasRevisionRecord {
  version: 1
  branch: string
  revision: number
  documentDigest: string
  document: CanvasDocument
}

function emptyEnvelope(branch: string): StoredCanvasEnvelope {
  return {
    branch,
    revision: 0,
    updatedAt: EMPTY_UPDATED_AT,
    lastMutationId: null,
    lastCheckpoint: null,
    document: emptyCanvasDocument(),
    mutationReceipts: [],
  }
}

function parseStoredEnvelope(source: string, expectedBranch: string): StoredCanvasEnvelope {
  const value: unknown = JSON.parse(source)
  const legacyKeys = [
    'branch',
    'revision',
    'updatedAt',
    'lastMutationId',
    'lastCheckpoint',
    'document',
  ]
  const currentKeys = [...legacyKeys, 'mutationReceipts']
  if (!isExactRecord(value, legacyKeys) && !isExactRecord(value, currentKeys)) {
    throw new TypeError('Canvas snapshot has an invalid envelope')
  }
  const branch = parseCanvasBranch(value.branch)
  if (branch !== expectedBranch) throw new TypeError('Canvas snapshot branch does not match')
  validateRevision(value.revision)
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new TypeError('Canvas snapshot updatedAt is invalid')
  }
  if (value.lastMutationId !== null) validateMutationId(value.lastMutationId)
  if (value.lastCheckpoint !== null) validateCheckpoint(value.lastCheckpoint)
  const mutationReceipts = Object.prototype.hasOwnProperty.call(value, 'mutationReceipts')
    ? parseMutationReceipts(value.mutationReceipts, value.revision)
    : []
  return {
    branch,
    revision: value.revision,
    updatedAt: value.updatedAt,
    lastMutationId: value.lastMutationId,
    lastCheckpoint: value.lastCheckpoint,
    document: parseCanvasDocument(value.document),
    mutationReceipts,
  }
}

/** Strict read-only decoder for workspace summaries; it performs no persistence or recovery. */
export function parseCanvasEnvelopeSnapshot(
  source: string,
  expectedBranch: string,
): CanvasEnvelope {
  return cloneEnvelope(parseStoredEnvelope(source, expectedBranch))
}

function validateRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('Canvas revision must be a non-negative safe integer')
  }
}

function validateMutationId(value: unknown): asserts value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    || value.includes('..')) throw new TypeError('Canvas mutationId is invalid')
}

function validateCheckpoint(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new TypeError('Canvas checkpoint must be a full hexadecimal Git object id')
  }
}

function serializeEnvelope(envelope: StoredCanvasEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

function cloneEnvelope(envelope: StoredCanvasEnvelope): CanvasEnvelope {
  return structuredClone({
    branch: envelope.branch,
    revision: envelope.revision,
    updatedAt: envelope.updatedAt,
    lastMutationId: envelope.lastMutationId,
    lastCheckpoint: envelope.lastCheckpoint,
    document: envelope.document,
  })
}

function findMutationReceipt(
  envelope: StoredCanvasEnvelope,
  mutationId: string,
): CanvasMutationReceipt | undefined {
  return envelope.mutationReceipts.find((receipt) => receipt.mutationId === mutationId)
}

function parseMutationReceipts(value: unknown, currentRevision: number): CanvasMutationReceipt[] {
  if (!Array.isArray(value)) throw new TypeError('Canvas mutation receipts must be an array')
  const seen = new Set<string>()
  return value.map((candidate) => {
    if (!isExactRecord(candidate, ['mutationId', 'commandDigest', 'committedRevision'])) {
      throw new TypeError('Canvas mutation receipt has an invalid shape')
    }
    validateMutationId(candidate.mutationId)
    if (seen.has(candidate.mutationId)) {
      throw new TypeError('Canvas mutation receipts contain a duplicate mutationId')
    }
    seen.add(candidate.mutationId)
    if (typeof candidate.commandDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(candidate.commandDigest)) {
      throw new TypeError('Canvas mutation receipt digest is invalid')
    }
    validateRevision(candidate.committedRevision)
    if (candidate.committedRevision > currentRevision) {
      throw new TypeError('Canvas mutation receipt revision is invalid')
    }
    return {
      mutationId: candidate.mutationId,
      commandDigest: candidate.commandDigest,
      committedRevision: candidate.committedRevision,
    }
  })
}

function canvasCommandDigest(command: CanvasCommand): string {
  return createHash('sha256').update(canonicalValue(command)).digest('hex')
}

function canvasDocumentDigest(document: CanvasDocument): string {
  return createHash('sha256').update(canonicalValue(document)).digest('hex')
}

function serializeRevisionRecord(
  branch: string,
  revision: number,
  document: CanvasDocument,
): string {
  const record: CanvasRevisionRecord = {
    version: 1,
    branch,
    revision,
    documentDigest: canvasDocumentDigest(document),
    document,
  }
  return `${JSON.stringify(record, null, 2)}\n`
}

function parseRevisionRecord(
  source: string,
  expectedBranch: string,
  expectedRevision: number,
): CanvasRevisionRecord {
  const value: unknown = JSON.parse(source)
  if (!isExactRecord(value, [
    'version',
    'branch',
    'revision',
    'documentDigest',
    'document',
  ])
    || value.version !== 1
    || value.branch !== expectedBranch
    || value.revision !== expectedRevision
    || typeof value.documentDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.documentDigest)) {
    throw new TypeError('Canvas revision record has an invalid envelope')
  }
  const document = parseCanvasDocument(value.document)
  if (canvasDocumentDigest(document) !== value.documentDigest) {
    throw new TypeError('Canvas revision record digest does not match its document')
  }
  return {
    version: 1,
    branch: expectedBranch,
    revision: expectedRevision,
    documentDigest: value.documentDigest,
    document,
  }
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`
  if (typeof value === 'boolean') return value ? 'boolean:true' : 'boolean:false'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN'
    if (value === Number.POSITIVE_INFINITY) return 'number:+Infinity'
    if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity'
    if (Object.is(value, -0)) return 'number:-0'
    return `number:${String(value)}`
  }
  if (Array.isArray(value)) return `array:[${value.map(canonicalValue).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `object:{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}=${canonicalValue(object[key])}`).join(',')}}`
  }
  return `${typeof value}:${String(value)}`
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
