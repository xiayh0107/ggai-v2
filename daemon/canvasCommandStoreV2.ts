import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  applyCanvasCommandV2,
  type CanvasCommandV2,
} from '../src/canvas-v2/commands.js'
import {
  emptyCanvasDocumentV2,
  parseCanvasDocumentV2,
  type CanvasDocumentV2,
} from '../src/canvas-v2/model.js'
import { atomicWriteText, isNodeError } from './atomic-file.js'
import { parseCanvasBranch } from './protocol.js'

const EMPTY_UPDATED_AT = '1970-01-01T00:00:00.000Z'

export interface CanvasEnvelopeV2 {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  lastCheckpoint: string | null
  document: CanvasDocumentV2
}

export interface CanvasCommandStoreV2Options {
  filePath: string
  now?: () => number
}

interface CanvasMutationReceiptV2 {
  mutationId: string
  commandDigest: string
  committedRevision: number
}

interface StoredCanvasEnvelopeV2 extends CanvasEnvelopeV2 {
  /** Runtime-only exactly-once ledger. It never enters CanvasDocument or Canvas Git. */
  mutationReceipts: CanvasMutationReceiptV2[]
}

export class CanvasRevisionConflictV2Error extends Error {
  readonly currentRevision: number

  constructor(currentRevision: number) {
    super(`Canvas V2 revision changed; current revision is ${currentRevision}`)
    this.name = 'CanvasRevisionConflictV2Error'
    this.currentRevision = currentRevision
  }
}

export class CanvasMutationReuseV2Error extends Error {
  readonly mutationId: string

  constructor(mutationId: string) {
    super(`Canvas V2 mutation id was reused with another base revision: ${mutationId}`)
    this.name = 'CanvasMutationReuseV2Error'
    this.mutationId = mutationId
  }
}

export class CanvasSnapshotV2Error extends Error {
  readonly filePath: string

  constructor(filePath: string, cause: unknown) {
    super(`Invalid Canvas V2 snapshot at ${filePath}`, { cause })
    this.name = 'CanvasSnapshotV2Error'
    this.filePath = filePath
  }
}

/** Durable, serialized command/CAS boundary for one logical canvas branch. */
export class CanvasCommandStoreV2 {
  readonly branch: string
  readonly filePath: string

  readonly #now: () => number
  #envelope: StoredCanvasEnvelopeV2 | null = null
  #operationTail: Promise<void> = Promise.resolve()

  constructor(branch: string, options: CanvasCommandStoreV2Options) {
    this.branch = parseCanvasBranch(branch)
    this.filePath = path.resolve(options.filePath)
    this.#now = options.now ?? Date.now
  }

  async get(): Promise<CanvasEnvelopeV2> {
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      return cloneEnvelope(this.#current())
    })
  }

  /** Checks durable branch existence without constructing or persisting an empty envelope. */
  async hasSnapshot(): Promise<boolean> {
    return this.#runExclusive(async () => {
      try {
        const info = await lstat(this.filePath)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new TypeError('Canvas V2 snapshot path is not a regular file')
        }
        return true
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return false
        if (error instanceof CanvasSnapshotV2Error) throw error
        throw new CanvasSnapshotV2Error(this.filePath, error)
      }
    })
  }

  async commit(
    baseRevision: number,
    mutationId: string,
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2> {
    validateRevision(baseRevision)
    validateMutationId(mutationId)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      const digest = canvasCommandDigestV2(command)
      const receipt = findMutationReceipt(current, mutationId)
      if (receipt) {
        if (receipt.commandDigest === digest) return cloneEnvelope(current)
        throw new CanvasMutationReuseV2Error(mutationId)
      }
      if (baseRevision !== current.revision) {
        throw new CanvasRevisionConflictV2Error(current.revision)
      }

      const document = applyCanvasCommandV2(current.document, command)
      const updatedAt = new Date(this.#now()).toISOString()
      const next: StoredCanvasEnvelopeV2 = {
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
      await atomicWriteText(this.filePath, serializeEnvelope(next))
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
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2> {
    validateMutationId(mutationId)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      const digest = canvasCommandDigestV2(command)
      const receipt = findMutationReceipt(current, mutationId)
      if (receipt) {
        if (receipt.commandDigest === digest) return cloneEnvelope(current)
        throw new CanvasMutationReuseV2Error(mutationId)
      }
      const document = applyCanvasCommandV2(current.document, command)
      if (document === current.document) {
        const next: StoredCanvasEnvelopeV2 = {
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
      const next: StoredCanvasEnvelopeV2 = {
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
      await atomicWriteText(this.filePath, serializeEnvelope(next))
      this.#envelope = next
      return cloneEnvelope(next)
    })
  }

  /** Persists a Git anchor without manufacturing a semantic Canvas revision. */
  async setLastCheckpoint(
    expectedRevision: number,
    commit: string,
  ): Promise<CanvasEnvelopeV2> {
    validateRevision(expectedRevision)
    validateCheckpoint(commit)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== expectedRevision) {
        throw new CanvasRevisionConflictV2Error(current.revision)
      }
      if (current.lastCheckpoint === commit) return cloneEnvelope(current)

      const next: StoredCanvasEnvelopeV2 = { ...current, lastCheckpoint: commit }
      await atomicWriteText(this.filePath, serializeEnvelope(next))
      this.#envelope = next
      return cloneEnvelope(next)
    })
  }

  /** Materializes a Git-only branch while refusing to overwrite runtime state. */
  async materialize(
    document: CanvasDocumentV2,
    checkpoint: string,
  ): Promise<CanvasEnvelopeV2> {
    validateCheckpoint(checkpoint)
    const parsed = parseCanvasDocumentV2(document)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== 0) {
        throw new CanvasRevisionConflictV2Error(current.revision)
      }
      const materialized: StoredCanvasEnvelopeV2 = {
        branch: this.branch,
        revision: 1,
        updatedAt: new Date(this.#now()).toISOString(),
        lastMutationId: null,
        lastCheckpoint: checkpoint,
        document: parsed,
        mutationReceipts: [],
      }
      await atomicWriteText(this.filePath, serializeEnvelope(materialized))
      this.#envelope = materialized
      return cloneEnvelope(materialized)
    })
  }

  /** Applies an explicit restore or merge result behind revision CAS. */
  async applyCheckpoint(
    document: CanvasDocumentV2,
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelopeV2> {
    validateCheckpoint(checkpoint)
    validateRevision(expectedRevision)
    const parsed = parseCanvasDocumentV2(document)
    return this.#runExclusive(async () => {
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== expectedRevision) {
        throw new CanvasRevisionConflictV2Error(current.revision)
      }
      const applied: StoredCanvasEnvelopeV2 = {
        branch: this.branch,
        revision: current.revision + 1,
        updatedAt: new Date(this.#now()).toISOString(),
        lastMutationId: null,
        lastCheckpoint: checkpoint,
        document: parsed,
        mutationReceipts: current.mutationReceipts,
      }
      await atomicWriteText(this.filePath, serializeEnvelope(applied))
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
      throw new CanvasSnapshotV2Error(this.filePath, error)
    }
  }

  #current(): StoredCanvasEnvelopeV2 {
    if (!this.#envelope) throw new Error('Canvas V2 command store was not loaded')
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

function emptyEnvelope(branch: string): StoredCanvasEnvelopeV2 {
  return {
    branch,
    revision: 0,
    updatedAt: EMPTY_UPDATED_AT,
    lastMutationId: null,
    lastCheckpoint: null,
    document: emptyCanvasDocumentV2(),
    mutationReceipts: [],
  }
}

function parseStoredEnvelope(source: string, expectedBranch: string): StoredCanvasEnvelopeV2 {
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
    throw new TypeError('Canvas V2 snapshot has an invalid envelope')
  }
  const branch = parseCanvasBranch(value.branch)
  if (branch !== expectedBranch) throw new TypeError('Canvas V2 snapshot branch does not match')
  validateRevision(value.revision)
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new TypeError('Canvas V2 snapshot updatedAt is invalid')
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
    document: parseCanvasDocumentV2(value.document),
    mutationReceipts,
  }
}

function validateRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('Canvas V2 revision must be a non-negative safe integer')
  }
}

function validateMutationId(value: unknown): asserts value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    || value.includes('..')) throw new TypeError('Canvas V2 mutationId is invalid')
}

function validateCheckpoint(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new TypeError('Canvas V2 checkpoint must be a full hexadecimal Git object id')
  }
}

function serializeEnvelope(envelope: StoredCanvasEnvelopeV2): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

function cloneEnvelope(envelope: StoredCanvasEnvelopeV2): CanvasEnvelopeV2 {
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
  envelope: StoredCanvasEnvelopeV2,
  mutationId: string,
): CanvasMutationReceiptV2 | undefined {
  return envelope.mutationReceipts.find((receipt) => receipt.mutationId === mutationId)
}

function parseMutationReceipts(value: unknown, currentRevision: number): CanvasMutationReceiptV2[] {
  if (!Array.isArray(value)) throw new TypeError('Canvas V2 mutation receipts must be an array')
  const seen = new Set<string>()
  return value.map((candidate) => {
    if (!isExactRecord(candidate, ['mutationId', 'commandDigest', 'committedRevision'])) {
      throw new TypeError('Canvas V2 mutation receipt has an invalid shape')
    }
    validateMutationId(candidate.mutationId)
    if (seen.has(candidate.mutationId)) {
      throw new TypeError('Canvas V2 mutation receipts contain a duplicate mutationId')
    }
    seen.add(candidate.mutationId)
    if (typeof candidate.commandDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(candidate.commandDigest)) {
      throw new TypeError('Canvas V2 mutation receipt digest is invalid')
    }
    validateRevision(candidate.committedRevision)
    if (candidate.committedRevision > currentRevision) {
      throw new TypeError('Canvas V2 mutation receipt revision is invalid')
    }
    return {
      mutationId: candidate.mutationId,
      commandDigest: candidate.commandDigest,
      committedRevision: candidate.committedRevision,
    }
  })
}

function canvasCommandDigestV2(command: CanvasCommandV2): string {
  return createHash('sha256').update(canonicalValue(command)).digest('hex')
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
