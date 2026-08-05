import { readFile } from 'node:fs/promises'
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
  document: CanvasDocumentV2
}

export interface CanvasCommandStoreV2Options {
  filePath: string
  now?: () => number
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
  #envelope: CanvasEnvelopeV2 | null = null
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
      if (current.lastMutationId === mutationId) {
        if (baseRevision === current.revision - 1) return cloneEnvelope(current)
        throw new CanvasMutationReuseV2Error(mutationId)
      }
      if (baseRevision !== current.revision) {
        throw new CanvasRevisionConflictV2Error(current.revision)
      }

      const document = applyCanvasCommandV2(current.document, command)
      const updatedAt = new Date(this.#now()).toISOString()
      const next: CanvasEnvelopeV2 = {
        branch: this.branch,
        revision: current.revision + 1,
        updatedAt,
        lastMutationId: mutationId,
        document,
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
      const document = applyCanvasCommandV2(current.document, command)
      if (document === current.document) return cloneEnvelope(current)

      const updatedAt = new Date(this.#now()).toISOString()
      const next: CanvasEnvelopeV2 = {
        branch: this.branch,
        revision: current.revision + 1,
        updatedAt,
        lastMutationId: mutationId,
        document,
      }
      await atomicWriteText(this.filePath, serializeEnvelope(next))
      this.#envelope = next
      return cloneEnvelope(next)
    })
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

  #current(): CanvasEnvelopeV2 {
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

function emptyEnvelope(branch: string): CanvasEnvelopeV2 {
  return {
    branch,
    revision: 0,
    updatedAt: EMPTY_UPDATED_AT,
    lastMutationId: null,
    document: emptyCanvasDocumentV2(),
  }
}

function parseStoredEnvelope(source: string, expectedBranch: string): CanvasEnvelopeV2 {
  const value: unknown = JSON.parse(source)
  if (!isExactRecord(value, [
    'branch',
    'revision',
    'updatedAt',
    'lastMutationId',
    'document',
  ])) throw new TypeError('Canvas V2 snapshot has an invalid envelope')
  const branch = parseCanvasBranch(value.branch)
  if (branch !== expectedBranch) throw new TypeError('Canvas V2 snapshot branch does not match')
  validateRevision(value.revision)
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new TypeError('Canvas V2 snapshot updatedAt is invalid')
  }
  if (value.lastMutationId !== null) validateMutationId(value.lastMutationId)
  return {
    branch,
    revision: value.revision,
    updatedAt: value.updatedAt,
    lastMutationId: value.lastMutationId,
    document: parseCanvasDocumentV2(value.document),
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

function serializeEnvelope(envelope: CanvasEnvelopeV2): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

function cloneEnvelope(envelope: CanvasEnvelopeV2): CanvasEnvelopeV2 {
  return structuredClone(envelope)
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
