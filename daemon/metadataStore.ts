import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  METADATA_SCHEMA_VERSION,
  type MetadataDiagnostics,
  type MetadataWorkerOperation,
  type MetadataWorkerRequest,
  type MetadataWorkerResponse,
  type MetadataWorkerResult,
} from './metadataProtocol.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'

export class MetadataStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'MetadataStoreError'
  }
}

interface PendingOperation {
  resolve: (value: MetadataWorkerResult) => void
  reject: (error: Error) => void
}

export class MetadataStore {
  readonly projectRoot: string
  readonly runtimeDir: string
  readonly databasePath: string
  readonly backupsDir: string

  #worker: Worker | null = null
  #opening: Promise<MetadataDiagnostics> | null = null
  #closing: Promise<void> | null = null
  #nextOperationId = 1
  #pending = new Map<number, PendingOperation>()

  constructor(projectRoot: string) {
    if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
      throw new TypeError('projectRoot must be a non-empty string')
    }
    this.projectRoot = path.resolve(projectRoot)
    this.runtimeDir = path.join(this.projectRoot, '.gg', 'runtime')
    this.databasePath = path.join(this.runtimeDir, 'index.sqlite')
    this.backupsDir = path.join(this.runtimeDir, 'backups')
  }

  open(): Promise<MetadataDiagnostics> {
    if (this.#closing) return Promise.reject(new MetadataStoreError('Metadata store is closing'))
    this.#opening ??= this.#open()
    return this.#opening
  }

  async diagnostics(): Promise<MetadataDiagnostics> {
    await this.open()
    return await this.#request({ operation: 'diagnostics' }) as MetadataDiagnostics
  }

  async backup(now = new Date()): Promise<string> {
    await this.open()
    if (!Number.isFinite(now.getTime())) throw new TypeError('backup date is invalid')
    await mkdir(this.backupsDir, { recursive: true, mode: 0o700 })
    await assertRealDirectory(this.backupsDir)
    const stamp = now.toISOString().replaceAll(/[-:.TZ]/gu, '')
    const destination = path.join(this.backupsDir, `index-${stamp}-${randomUUID()}.sqlite`)
    const result = await this.#request({ operation: 'backup', destination })
    if (!isBackupResult(result) || result.destination !== destination) {
      throw new MetadataStoreError('Metadata worker returned an invalid backup result')
    }
    await chmod(destination, 0o600)
    return destination
  }

  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #open(): Promise<MetadataDiagnostics> {
    await this.#preparePaths()
    const worker = new Worker(new URL('./metadataWorker.js', import.meta.url), {
      workerData: { databasePath: this.databasePath },
    })
    this.#worker = worker
    worker.on('message', (response: MetadataWorkerResponse) => this.#receive(response))
    worker.on('error', (error) => this.#failAll(error))
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#worker = null
      if (code !== 0) this.#failAll(new MetadataStoreError(`Metadata worker exited with code ${code}`))
    })
    try {
      const result = await this.#request({ operation: 'initialize' })
      if (!isDiagnostics(result)) {
        throw new MetadataStoreError('Metadata worker returned invalid diagnostics')
      }
      await chmod(this.databasePath, 0o600)
      return result
    } catch (error) {
      await worker.terminate().catch(() => undefined)
      if (this.#worker === worker) this.#worker = null
      throw new MetadataStoreError('Metadata store initialization failed', error)
    }
  }

  async #close(): Promise<void> {
    const worker = this.#worker
    if (!worker) return
    try {
      if (this.#opening) await this.#opening.catch(() => undefined)
      if (this.#worker === worker) await this.#request({ operation: 'close' })
    } finally {
      await worker.terminate().catch(() => undefined)
      if (this.#worker === worker) this.#worker = null
      this.#failAll(new MetadataStoreError('Metadata store closed'))
    }
  }

  async #preparePaths(): Promise<void> {
    const canonicalRoot = await realpath(this.projectRoot)
    if (canonicalRoot !== this.projectRoot) {
      throw new MetadataStoreError('Metadata project root must not contain symlink components')
    }
    const expectedRuntime = path.join(canonicalRoot, '.gg', 'runtime')
    const expectedDatabase = path.join(expectedRuntime, 'index.sqlite')
    const resolvedRuntime = await canonicalizePotentialPath(this.runtimeDir)
    const resolvedDatabase = await canonicalizePotentialPath(this.databasePath)
    if (resolvedRuntime !== expectedRuntime
      || resolvedDatabase !== expectedDatabase
      || !isPathWithin(canonicalRoot, resolvedRuntime)
      || !isPathWithin(resolvedRuntime, resolvedDatabase)) {
      throw new MetadataStoreError('Metadata paths resolve outside the daemon runtime root')
    }
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 })
    await assertRealDirectory(path.join(canonicalRoot, '.gg'))
    await assertRealDirectory(this.runtimeDir)
    try {
      const databaseInfo = await lstat(this.databasePath)
      if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) {
        throw new MetadataStoreError('Metadata database must be a regular file')
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  #request(request: MetadataWorkerOperation): Promise<MetadataWorkerResult> {
    const worker = this.#worker
    if (!worker) return Promise.reject(new MetadataStoreError('Metadata worker is unavailable'))
    const id = this.#nextOperationId
    this.#nextOperationId += 1
    return new Promise<MetadataWorkerResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      worker.postMessage({ id, ...request } satisfies MetadataWorkerRequest)
    })
  }

  #receive(response: MetadataWorkerResponse): void {
    const pending = this.#pending.get(response.id)
    if (!pending) return
    this.#pending.delete(response.id)
    if (response.ok) {
      pending.resolve(response.result)
      return
    }
    const error = new MetadataStoreError(response.error.message)
    error.name = response.error.name
    if (response.error.stack) error.stack = response.error.stack
    pending.reject(error)
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

async function assertRealDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new MetadataStoreError(`Metadata path must be a real directory: ${directory}`)
  }
}

function isDiagnostics(value: MetadataWorkerResult): value is MetadataDiagnostics {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'schemaVersion' in value
    && value.schemaVersion === METADATA_SCHEMA_VERSION
    && typeof value.sqliteVersion === 'string'
    && value.journalMode === 'wal'
    && value.integrity === 'ok'
}

function isBackupResult(
  value: MetadataWorkerResult,
): value is { destination: string; pages: number } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'destination' in value
    && typeof value.destination === 'string'
    && 'pages' in value
    && typeof value.pages === 'number'
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
