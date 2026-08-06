import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  canonicalizePotentialPath,
  createProjectScope,
  isPathWithin,
  type ProjectScope,
} from './permissions.js'
import {
  parseCanvasBranch,
  parseCanvasDocument,
  ProtocolError,
  type CanvasDocumentV1,
  type CanvasEnvelope,
  type PutCanvasRequest,
} from './protocol.js'
import {
  atomicWriteText,
  findLatestQuarantine,
  isNodeError,
  quarantineFile,
} from './atomic-file.js'
import { ProjectLeaseManager } from './projectLease.js'

const EMPTY_UPDATED_AT = '1970-01-01T00:00:00.000Z'

export interface CanvasRecovery {
  canvasPath: string
  quarantinePath: string
  reason: string
}

export interface CanvasStoreOptions {
  filePath?: string
  now?: () => number
  /** Revalidates daemon-managed path ownership immediately before each I/O. */
  validatePath?: () => Promise<void>
}

export interface CanvasStoreManagerOptions {
  projectRoot: string
  now?: () => number
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
    super(`Canvas mutation id was reused for a different base revision: ${mutationId}`)
    this.name = 'CanvasMutationReuseError'
    this.mutationId = mutationId
  }
}

export class CanvasCorruptionError extends Error {
  readonly recovery: CanvasRecovery

  constructor(recovery: CanvasRecovery, cause?: unknown) {
    super(
      `Invalid canvas snapshot was quarantined at ${recovery.quarantinePath}; `
        + 'recover it explicitly before continuing',
      { cause },
    )
    this.name = 'CanvasCorruptionError'
    this.recovery = recovery
  }
}

/** Opaque branch directory: logical branch names never participate in paths. */
export function canvasBranchStorageId(branch: string): string {
  return createHash('sha256').update(parseCanvasBranch(branch), 'utf8').digest('hex')
}

export function canvasSnapshotPath(projectDir: string, branch: string): string {
  return path.resolve(
    projectDir,
    '.gg',
    'runtime',
    'canvas',
    canvasBranchStorageId(branch),
    'snapshot.json',
  )
}

export function emptyCanvasDocument(): CanvasDocumentV1 {
  return {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    everCreated: false,
    generationByNodeId: {},
    latestRunByNodeId: {},
    runRefsByNodeId: {},
  }
}

/** Durable, serialized state for one canonical project and logical branch. */
export class CanvasStore {
  readonly branch: string
  readonly filePath: string

  readonly #now: () => number
  readonly #validatePath?: () => Promise<void>
  #envelope: CanvasEnvelope | null = null
  #recovery: CanvasRecovery | null = null
  #operationTail: Promise<void> = Promise.resolve()
  #closing = false

  constructor(projectDir: string, branch: string, options: CanvasStoreOptions = {}) {
    this.branch = parseCanvasBranch(branch)
    this.filePath = options.filePath
      ? path.resolve(options.filePath)
      : canvasSnapshotPath(projectDir, this.branch)
    this.#now = options.now ?? Date.now
    this.#validatePath = options.validatePath
  }

  get recovery(): CanvasRecovery | null {
    return this.#recovery ? { ...this.#recovery } : null
  }

  async get(): Promise<CanvasEnvelope> {
    this.#assertOpen()
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      await this.#ensureLoaded()
      return cloneEnvelope(this.#current())
    })
  }

  async put(request: PutCanvasRequest): Promise<CanvasEnvelope> {
    this.#assertOpen()
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.lastMutationId === request.mutationId) {
        if (request.baseRevision === current.revision - 1) return cloneEnvelope(current)
        throw new CanvasMutationReuseError(request.mutationId)
      }
      if (request.baseRevision !== current.revision) {
        throw new CanvasRevisionConflictError(current.revision)
      }

      const next: CanvasEnvelope = {
        branch: this.branch,
        revision: current.revision + 1,
        updatedAt: new Date(this.#now()).toISOString(),
        lastMutationId: request.mutationId,
        lastCheckpoint: current.lastCheckpoint,
        document: parseCanvasDocument(request.document),
      }
      await atomicWriteText(this.filePath, serializeEnvelope(next))
      this.#envelope = next
      return cloneEnvelope(next)
    })
  }

  /** Persists a checkpoint pointer without creating a semantic canvas revision. */
  async setLastCheckpoint(expectedRevision: number, commit: string): Promise<CanvasEnvelope> {
    this.#assertOpen()
    if (!/^[0-9a-f]{7,64}$/u.test(commit)) {
      throw new TypeError('checkpoint commit must be a hexadecimal Git object id')
    }
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== expectedRevision) {
        throw new CanvasRevisionConflictError(current.revision)
      }
      if (current.lastCheckpoint === commit) return cloneEnvelope(current)
      const next = { ...current, lastCheckpoint: commit }
      await atomicWriteText(this.filePath, serializeEnvelope(next))
      this.#envelope = next
      return cloneEnvelope(next)
    })
  }

  async recover(document: CanvasDocumentV1 = emptyCanvasDocument()): Promise<CanvasEnvelope> {
    this.#assertOpen()
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      const recovered: CanvasEnvelope = {
        branch: this.branch,
        revision: 1,
        updatedAt: new Date(this.#now()).toISOString(),
        lastMutationId: null,
        lastCheckpoint: null,
        document: parseCanvasDocument(document),
      }
      await atomicWriteText(this.filePath, serializeEnvelope(recovered))
      this.#envelope = recovered
      this.#recovery = null
      return cloneEnvelope(recovered)
    })
  }

  /** Materializes a newly-created Git branch without overwriting runtime state. */
  async materialize(document: CanvasDocumentV1, checkpoint: string): Promise<CanvasEnvelope> {
    this.#assertOpen()
    if (!/^[0-9a-f]{7,64}$/u.test(checkpoint)) {
      throw new TypeError('checkpoint commit must be a hexadecimal Git object id')
    }
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== 0) throw new CanvasRevisionConflictError(current.revision)
      const materialized: CanvasEnvelope = {
        branch: this.branch,
        revision: 1,
        updatedAt: new Date(this.#now()).toISOString(),
        lastMutationId: null,
        lastCheckpoint: checkpoint,
        document: parseCanvasDocument(document),
      }
      await atomicWriteText(this.filePath, serializeEnvelope(materialized))
      this.#envelope = materialized
      return cloneEnvelope(materialized)
    })
  }

  /** Replaces an existing branch after an explicit Git operation, with CAS protection. */
  async applyCheckpoint(
    document: CanvasDocumentV1,
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelope> {
    this.#assertOpen()
    if (!/^[0-9a-f]{7,64}$/u.test(checkpoint)) {
      throw new TypeError('checkpoint commit must be a hexadecimal Git object id')
    }
    return this.#runExclusive(async () => {
      await this.#validatePath?.()
      await this.#ensureLoaded()
      const current = this.#current()
      if (current.revision !== expectedRevision) {
        throw new CanvasRevisionConflictError(current.revision)
      }
      const applied: CanvasEnvelope = {
        branch: this.branch,
        revision: current.revision + 1,
        updatedAt: new Date(this.#now()).toISOString(),
        lastMutationId: null,
        lastCheckpoint: checkpoint,
        document: parseCanvasDocument(document),
      }
      await atomicWriteText(this.filePath, serializeEnvelope(applied))
      this.#envelope = applied
      return cloneEnvelope(applied)
    })
  }

  async close(): Promise<void> {
    this.#closing = true
    await this.#operationTail
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#recovery) throw new CanvasCorruptionError(this.#recovery)
    if (this.#envelope) return

    let source: string
    try {
      source = await readTextNoFollow(this.filePath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      const priorQuarantine = await findLatestQuarantine(this.filePath)
      if (priorQuarantine) {
        const recovery: CanvasRecovery = {
          canvasPath: this.filePath,
          quarantinePath: priorQuarantine,
          reason: 'A quarantined canvas snapshot is awaiting explicit recovery',
        }
        this.#recovery = recovery
        throw new CanvasCorruptionError(recovery)
      }
      this.#envelope = emptyEnvelope(this.branch)
      return
    }

    try {
      this.#envelope = parseStoredEnvelope(source, this.branch)
    } catch (error) {
      const quarantine = await quarantineFile(this.filePath, error)
      const recovery: CanvasRecovery = {
        canvasPath: quarantine.filePath,
        quarantinePath: quarantine.quarantinePath,
        reason: quarantine.reason,
      }
      this.#recovery = recovery
      throw new CanvasCorruptionError(recovery, error)
    }
  }

  #current(): CanvasEnvelope {
    if (!this.#envelope) throw new Error('Canvas store was not loaded')
    return this.#envelope
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
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

/** Resolves project scope and owns one CanvasStore per project/branch pair. */
export class CanvasStoreManager {
  readonly #projectRoot: string
  readonly #now: () => number
  readonly #stores = new Map<string, CanvasStore>()
  readonly #projectLeases: ProjectLeaseManager
  #closing = false
  #closePromise: Promise<void> | null = null

  constructor(options: CanvasStoreManagerOptions) {
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#now = options.now ?? Date.now
    this.#projectLeases = new ProjectLeaseManager({ projectRoot: this.#projectRoot })
  }

  async get(projectDir: string, branch: string): Promise<CanvasEnvelope> {
    return (await this.#resolveStore(projectDir, branch)).get()
  }

  async put(
    projectDir: string,
    branch: string,
    request: PutCanvasRequest,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolveStore(projectDir, branch)).put(request)
  }

  async setLastCheckpoint(
    projectDir: string,
    branch: string,
    expectedRevision: number,
    commit: string,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolveStore(projectDir, branch))
      .setLastCheckpoint(expectedRevision, commit)
  }

  async canonicalProjectDir(projectDir: string): Promise<string> {
    this.#assertOpen()
    return (await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir,
    })).projectDir
  }

  /** Acquires the process-wide project lease before any daemon-owned subsystem writes. */
  async acquireProjectLease(projectDir: string): Promise<string> {
    this.#assertOpen()
    const canonicalProjectDir = await this.#projectLeases.acquire(projectDir)
    this.#assertOpen()
    return canonicalProjectDir
  }

  async materialize(
    projectDir: string,
    branch: string,
    document: CanvasDocumentV1,
    checkpoint: string,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolveStore(projectDir, branch)).materialize(document, checkpoint)
  }

  async applyCheckpoint(
    projectDir: string,
    branch: string,
    document: CanvasDocumentV1,
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolveStore(projectDir, branch))
      .applyCheckpoint(document, checkpoint, expectedRevision)
  }

  /** Removes only the opaque runtime snapshot for a branch already deleted elsewhere. */
  async removeBranch(projectDir: string, branch: string): Promise<void> {
    const store = await this.#resolveStore(projectDir, branch)
    await store.close()
    await rm(path.dirname(store.filePath), { recursive: true, force: true })
    const scope = await createProjectScope({ projectRoot: this.#projectRoot, projectDir })
    this.#stores.delete(`${scope.projectDir}\0${parseCanvasBranch(branch)}`)
  }

  close(): Promise<void> {
    this.#closing = true
    this.#closePromise ??= (async () => {
      await Promise.all([...this.#stores.values()].map((store) => store.close()))
      await this.#projectLeases.close()
    })()
    return this.#closePromise
  }

  async #resolveStore(requestedProjectDir: string, requestedBranch: string): Promise<CanvasStore> {
    this.#assertOpen()
    const branch = parseCanvasBranch(requestedBranch)
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: requestedProjectDir,
    })
    this.#assertOpen()
    const storageId = canvasBranchStorageId(branch)
    const relativePath = `.gg/runtime/canvas/${storageId}/snapshot.json`
    await assertCanvasManagedPath(scope, relativePath)
    await this.#projectLeases.acquire(scope.projectDir)
    this.#assertOpen()

    const key = `${scope.projectDir}\0${branch}`
    let store = this.#stores.get(key)
    if (!store) {
      store = new CanvasStore(scope.projectDir, branch, {
        now: this.#now,
        validatePath: () => assertCanvasManagedPath(scope, relativePath),
      })
      this.#stores.set(key, store)
    }
    return store
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
  }
}

async function assertCanvasManagedPath(scope: ProjectScope, relativePath: string): Promise<void> {
  const lexicalTarget = path.resolve(scope.projectDir, relativePath)
  const canonicalGgDir = await canonicalizePotentialPath(scope.ggDir)
  const canonicalTarget = await canonicalizePotentialPath(lexicalTarget)
  if (
    canonicalGgDir !== scope.ggDir
    || canonicalTarget !== lexicalTarget
    || !isPathWithin(scope.ggDir, lexicalTarget)
    || !isPathWithin(canonicalGgDir, canonicalTarget)
  ) {
    throw new ProtocolError(
      `unsafe managed path ${relativePath}: path escapes the project .gg directory`,
      'unsafe_managed_path',
      403,
    )
  }
}

async function readTextNoFollow(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function emptyEnvelope(branch: string): CanvasEnvelope {
  return {
    branch,
    revision: 0,
    updatedAt: EMPTY_UPDATED_AT,
    lastMutationId: null,
    lastCheckpoint: null,
    document: emptyCanvasDocument(),
  }
}

function parseStoredEnvelope(source: string, expectedBranch: string): CanvasEnvelope {
  const value: unknown = JSON.parse(source)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('canvas snapshot must contain an object')
  }
  const record = value as Record<string, unknown>
  const branch = parseCanvasBranch(record.branch)
  if (branch !== expectedBranch) throw new TypeError('canvas snapshot branch does not match its path')
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
    throw new TypeError('canvas snapshot revision must be a non-negative safe integer')
  }
  if (typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new TypeError('canvas snapshot updatedAt must be an ISO timestamp')
  }
  if (record.lastMutationId !== null && !isSafeMutationId(record.lastMutationId)) {
    throw new TypeError('canvas snapshot lastMutationId is invalid')
  }
  if (
    record.lastCheckpoint !== null
    && (typeof record.lastCheckpoint !== 'string'
      || !/^[0-9a-f]{7,64}$/u.test(record.lastCheckpoint))
  ) {
    throw new TypeError('canvas snapshot lastCheckpoint is invalid')
  }
  return {
    branch,
    revision: record.revision as number,
    updatedAt: record.updatedAt,
    lastMutationId: record.lastMutationId as string | null,
    lastCheckpoint: record.lastCheckpoint as string | null,
    document: parseCanvasDocument(record.document),
  }
}

function isSafeMutationId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    && !value.includes('..')
}

function serializeEnvelope(envelope: CanvasEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

function cloneEnvelope(envelope: CanvasEnvelope): CanvasEnvelope {
  return structuredClone(envelope)
}
