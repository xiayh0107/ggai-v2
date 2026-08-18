import type { CanvasCommand } from './commands'

export interface CanvasPersistenceScope {
  daemonBaseUrl: string
  projectDir: string
  branch: string
}

export interface CanvasCameraState {
  x: number
  y: number
  zoom: number
}

export interface CanvasSelectionTarget {
  kind: 'node' | 'task' | 'collection'
  id: string
}

/** Branch-local presentation state. It is never part of CanvasDocument. */
export interface CanvasViewState {
  camera: CanvasCameraState
  selection: CanvasSelectionTarget[]
  collapsedTaskIds: string[]
  collapsedCollectionIds: string[]
  /** Keyed by an entity key such as `task:<id>` or `node:<id>`. */
  composerDrafts: Record<string, string>
}

export interface CanvasCommandLike {
  type: string
}

export interface CanvasOutboxEntry<Command extends CanvasCommandLike = CanvasCommand> {
  branch: string
  baseRevision: number
  readonly initialBaseRevision: number
  mutationId: string
  command: Command
  createdAt: number
}

export interface CanvasOutboxInput<Command extends CanvasCommandLike> {
  baseRevision: number
  mutationId: string
  command: Command
  createdAt?: number
}

export interface CanvasStoredViewRecord {
  key: string
  scopeKey: string
  state: unknown
  updatedAt: number
}

export interface CanvasStoredOutboxRecord {
  key: string
  scopeKey: string
  entry: unknown
}

/** Storage boundary used by IndexedDB in production and an in-memory adapter in tests. */
export interface CanvasPersistenceAdapter {
  readView(scopeKey: string): Promise<CanvasStoredViewRecord | undefined>
  writeView(record: CanvasStoredViewRecord): Promise<void>
  deleteView(scopeKey: string): Promise<void>
  listOutbox(scopeKey: string): Promise<CanvasStoredOutboxRecord[]>
  writeOutbox(record: CanvasStoredOutboxRecord): Promise<void>
  deleteOutbox(key: string): Promise<void>
  replaceOutbox(scopeKey: string, records: CanvasStoredOutboxRecord[]): Promise<void>
  clearScope(scopeKey: string): Promise<void>
}

export interface CanvasPersistenceOptions<Command extends CanvasCommandLike> {
  adapter?: CanvasPersistenceAdapter
  now?: () => number
  /** Lets the command module install its final runtime decoder without coupling this file to it. */
  decodeCommand?: (value: unknown) => Command | null
}

const DATABASE_NAME = 'ggai-canvas'
const DATABASE_VERSION = 3
const RETIRED_DATABASE_NAME = 'ggai-canvas-v2'
const VIEW_STORE = 'branch-view-state'
const OUTBOX_STORE = 'command-outbox'
const MAX_ID_LENGTH = 256
const MAX_SELECTION = 10_000
const MAX_COLLAPSED_IDS = 10_000
const MAX_COMPOSER_DRAFTS = 10_000
const MAX_DRAFT_LENGTH = 250_000
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u

let databasePromise: Promise<IDBDatabase> | null = null

export function canvasScopeKey(scope: CanvasPersistenceScope): string {
  assertScope(scope)
  return JSON.stringify([scope.daemonBaseUrl, scope.projectDir, scope.branch])
}

export function canvasOutboxKey(scope: CanvasPersistenceScope, mutationId: string): string {
  assertMutationId(mutationId)
  return JSON.stringify([canvasScopeKey(scope), mutationId])
}

/**
 * Rebase a FIFO command stream after a 409. Commands are expected to commit one
 * revision each, so their new bases are consecutive and their identities do not change.
 */
export function rebaseCanvasOutboxEntries<Command extends CanvasCommandLike>(
  entries: CanvasOutboxEntry<Command>[],
  serverRevision: number,
): CanvasOutboxEntry<Command>[] {
  assertRevision(serverRevision)
  return sortOutboxEntries(entries).map((entry, index) => ({
    ...clone(entry),
    baseRevision: serverRevision + index,
  }))
}

export class CanvasPersistence<Command extends CanvasCommandLike = CanvasCommand> {
  readonly #adapter: CanvasPersistenceAdapter
  readonly #now: () => number
  readonly #decodeCommand: (value: unknown) => Command | null

  constructor(options: CanvasPersistenceOptions<Command> = {}) {
    this.#adapter = options.adapter ?? createDefaultCanvasPersistenceAdapter()
    this.#now = options.now ?? Date.now
    this.#decodeCommand = options.decodeCommand ?? defaultDecodeCommand<Command>
  }

  async readViewState(scope: CanvasPersistenceScope): Promise<CanvasViewState | null> {
    const scopeKey = canvasScopeKey(scope)
    const stored = await this.#adapter.readView(scopeKey)
    if (!stored) return null
    const state = decodeViewState(stored.state)
    if (stored.key !== scopeKey || stored.scopeKey !== scopeKey || !state) {
      await this.#adapter.deleteView(scopeKey)
      return null
    }
    return state
  }

  async writeViewState(
    scope: CanvasPersistenceScope,
    state: CanvasViewState,
  ): Promise<void> {
    const scopeKey = canvasScopeKey(scope)
    const decoded = decodeViewState(state)
    if (!decoded) throw new TypeError('Canvas view state is invalid')
    await this.#adapter.writeView({
      key: scopeKey,
      scopeKey,
      state: decoded,
      updatedAt: finiteTimestamp(this.#now()),
    })
  }

  async enqueue(
    scope: CanvasPersistenceScope,
    input: CanvasOutboxInput<Command>,
  ): Promise<CanvasOutboxEntry<Command>> {
    assertRevision(input.baseRevision)
    assertMutationId(input.mutationId)
    assertJsonValue(input.command, 'command')
    const decodedCommand = this.#decodeCommand(clone(input.command))
    if (!decodedCommand) throw new TypeError('Canvas command is invalid')

    const existing = (await this.list(scope))
      .find((entry) => entry.mutationId === input.mutationId)
    if (existing) {
      if (!jsonEquals(existing.command, decodedCommand)) {
        throw new Error(`Mutation ${input.mutationId} was reused for another command`)
      }
      return existing
    }

    const scopeKey = canvasScopeKey(scope)
    const entry: CanvasOutboxEntry<Command> = {
      branch: scope.branch,
      baseRevision: input.baseRevision,
      initialBaseRevision: input.baseRevision,
      mutationId: input.mutationId,
      command: decodedCommand,
      createdAt: finiteTimestamp(input.createdAt ?? this.#now()),
    }
    await this.#adapter.writeOutbox({
      key: canvasOutboxKey(scope, entry.mutationId),
      scopeKey,
      entry: clone(entry),
    })
    return clone(entry)
  }

  async list(scope: CanvasPersistenceScope): Promise<CanvasOutboxEntry<Command>[]> {
    const scopeKey = canvasScopeKey(scope)
    const records = await this.#adapter.listOutbox(scopeKey)
    const entries: CanvasOutboxEntry<Command>[] = []
    for (const record of records) {
      const entry = decodeOutboxEntry(record.entry, scope.branch, this.#decodeCommand)
      if (record.scopeKey !== scopeKey
        || record.key !== canvasOutboxKey(scope, entry?.mutationId ?? 'invalid')
        || !entry) {
        await this.#adapter.deleteOutbox(record.key)
        continue
      }
      entries.push(entry)
    }
    return sortOutboxEntries(entries)
  }

  async ack(scope: CanvasPersistenceScope, mutationId: string): Promise<void> {
    await this.#adapter.deleteOutbox(canvasOutboxKey(scope, mutationId))
  }

  async rebaseConflict(
    scope: CanvasPersistenceScope,
    serverRevision: number,
  ): Promise<CanvasOutboxEntry<Command>[]> {
    const scopeKey = canvasScopeKey(scope)
    const rebased = rebaseCanvasOutboxEntries(await this.list(scope), serverRevision)
    await this.#adapter.replaceOutbox(scopeKey, rebased.map((entry) => ({
      key: canvasOutboxKey(scope, entry.mutationId),
      scopeKey,
      entry: clone(entry),
    })))
    return rebased
  }

  async replaceOutbox(
    scope: CanvasPersistenceScope,
    entries: readonly CanvasOutboxEntry<Command>[],
  ): Promise<void> {
    const scopeKey = canvasScopeKey(scope)
    const decoded = entries.map((entry) => decodeOutboxEntry(
      clone(entry),
      scope.branch,
      this.#decodeCommand,
    ))
    if (decoded.some((entry) => entry === null)) {
      throw new TypeError('Canvas replacement outbox is invalid')
    }
    await this.#adapter.replaceOutbox(scopeKey, (decoded as CanvasOutboxEntry<Command>[])
      .map((entry) => ({
        key: canvasOutboxKey(scope, entry.mutationId),
        scopeKey,
        entry: clone(entry),
      })))
  }

  async clearBranch(scope: CanvasPersistenceScope): Promise<void> {
    await this.#adapter.clearScope(canvasScopeKey(scope))
  }

  /**
   * Crash-safe dispatch: the callback cannot run until the entry is durable.
   * A failed callback leaves the entry queued; a successful callback is acked.
   */
  async persistThenSend<Result>(
    scope: CanvasPersistenceScope,
    input: CanvasOutboxInput<Command>,
    send: (entry: CanvasOutboxEntry<Command>) => Promise<Result>,
  ): Promise<Result> {
    const entry = await this.enqueue(scope, input)
    const result = await send(clone(entry))
    await this.ack(scope, entry.mutationId)
    return result
  }
}

export function createCanvasPersistence<Command extends CanvasCommandLike = CanvasCommand>(
  options: CanvasPersistenceOptions<Command> = {},
): CanvasPersistence<Command> {
  return new CanvasPersistence(options)
}

/** Minimal structured-clone adapter for unit tests and non-browser runtimes. */
export class MemoryCanvasPersistenceAdapter implements CanvasPersistenceAdapter {
  readonly #views = new Map<string, CanvasStoredViewRecord>()
  readonly #outbox = new Map<string, CanvasStoredOutboxRecord>()

  async readView(scopeKey: string): Promise<CanvasStoredViewRecord | undefined> {
    const value = this.#views.get(scopeKey)
    return value ? clone(value) : undefined
  }

  async writeView(record: CanvasStoredViewRecord): Promise<void> {
    this.#views.set(record.key, clone(record))
  }

  async deleteView(scopeKey: string): Promise<void> {
    this.#views.delete(scopeKey)
  }

  async listOutbox(scopeKey: string): Promise<CanvasStoredOutboxRecord[]> {
    return [...this.#outbox.values()]
      .filter((record) => record.scopeKey === scopeKey)
      .map(clone)
  }

  async writeOutbox(record: CanvasStoredOutboxRecord): Promise<void> {
    this.#outbox.set(record.key, clone(record))
  }

  async deleteOutbox(key: string): Promise<void> {
    this.#outbox.delete(key)
  }

  async replaceOutbox(
    scopeKey: string,
    records: CanvasStoredOutboxRecord[],
  ): Promise<void> {
    for (const [key, record] of this.#outbox) {
      if (record.scopeKey === scopeKey) this.#outbox.delete(key)
    }
    for (const record of records) this.#outbox.set(record.key, clone(record))
  }

  async clearScope(scopeKey: string): Promise<void> {
    this.#views.delete(scopeKey)
    for (const [key, record] of this.#outbox) {
      if (record.scopeKey === scopeKey) this.#outbox.delete(key)
    }
  }
}

export class IndexedDbCanvasPersistenceAdapter implements CanvasPersistenceAdapter {
  async readView(scopeKey: string): Promise<CanvasStoredViewRecord | undefined> {
    const database = await openDatabase()
    const transaction = database.transaction(VIEW_STORE, 'readonly')
    const done = transactionDone(transaction)
    const value = await requestResult(transaction.objectStore(VIEW_STORE).get(scopeKey))
    await done
    return value as CanvasStoredViewRecord | undefined
  }

  async writeView(record: CanvasStoredViewRecord): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(VIEW_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(VIEW_STORE).put(record)
    await done
  }

  async deleteView(scopeKey: string): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(VIEW_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(VIEW_STORE).delete(scopeKey)
    await done
  }

  async listOutbox(scopeKey: string): Promise<CanvasStoredOutboxRecord[]> {
    const database = await openDatabase()
    const transaction = database.transaction(OUTBOX_STORE, 'readonly')
    const done = transactionDone(transaction)
    const values = await requestResult(transaction.objectStore(OUTBOX_STORE).getAll())
    await done
    return (values as CanvasStoredOutboxRecord[])
      .filter((record) => record.scopeKey === scopeKey)
  }

  async writeOutbox(record: CanvasStoredOutboxRecord): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(OUTBOX_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(OUTBOX_STORE).put(record)
    await done
  }

  async deleteOutbox(key: string): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(OUTBOX_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(OUTBOX_STORE).delete(key)
    await done
  }

  async replaceOutbox(
    scopeKey: string,
    records: CanvasStoredOutboxRecord[],
  ): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(OUTBOX_STORE, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(OUTBOX_STORE)
    const existing = await requestResult(store.getAll()) as CanvasStoredOutboxRecord[]
    for (const record of existing) {
      if (record.scopeKey === scopeKey) store.delete(record.key)
    }
    for (const record of records) store.put(record)
    await done
  }

  async clearScope(scopeKey: string): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction([VIEW_STORE, OUTBOX_STORE], 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(VIEW_STORE).delete(scopeKey)
    const outbox = transaction.objectStore(OUTBOX_STORE)
    const existing = await requestResult(outbox.getAll()) as CanvasStoredOutboxRecord[]
    for (const record of existing) {
      if (record.scopeKey === scopeKey) outbox.delete(record.key)
    }
    await done
  }
}

function createDefaultCanvasPersistenceAdapter(): CanvasPersistenceAdapter {
  return globalThis.indexedDB
    ? new IndexedDbCanvasPersistenceAdapter()
    : new MemoryCanvasPersistenceAdapter()
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'))
  databasePromise = openCanvasPersistenceDatabase(globalThis.indexedDB).then(
    (database) => {
      database.addEventListener('versionchange', () => {
        database.close()
        databasePromise = null
      })
      return database
    },
    (error: unknown) => {
      databasePromise = null
      throw error
    },
  )
  return databasePromise
}

/**
 * Canvas v3 deliberately clears pre-v3 browser state. It never replays an old
 * outbox against the destructive daemon cutover.
 */
export function openCanvasPersistenceDatabase(
  indexedDb: IDBFactory,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDb.deleteDatabase === 'function') {
      indexedDb.deleteDatabase(RETIRED_DATABASE_NAME)
    }
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION)
    request.addEventListener('upgradeneeded', () => {
      const database = request.result
      if (request.transaction?.db.version === DATABASE_VERSION) {
        for (const store of [...database.objectStoreNames]) database.deleteObjectStore(store)
      }
      if (!database.objectStoreNames.contains(VIEW_STORE)) {
        database.createObjectStore(VIEW_STORE, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        database.createObjectStore(OUTBOX_STORE, { keyPath: 'key' })
      }
    })
    request.addEventListener('success', () => {
      resolve(request.result)
    }, { once: true })
    request.addEventListener('error', () => {
      reject(request.error)
    }, { once: true })
    request.addEventListener('blocked', () => {
      reject(new Error('Canvas persistence database upgrade was blocked'))
    }, { once: true })
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error), { once: true })
  })
}

function decodeViewState(value: unknown): CanvasViewState | null {
  if (!isExactRecord(value, [
    'camera',
    'selection',
    'collapsedTaskIds',
    'collapsedCollectionIds',
    'composerDrafts',
  ])) return null
  if (!isCamera(value.camera)
    || !isSelection(value.selection)
    || !isIdArray(value.collapsedTaskIds, MAX_COLLAPSED_IDS)
    || !isIdArray(value.collapsedCollectionIds, MAX_COLLAPSED_IDS)
    || !isComposerDrafts(value.composerDrafts)) return null
  return clone(value) as unknown as CanvasViewState
}

function decodeOutboxEntry<Command extends CanvasCommandLike>(
  value: unknown,
  branch: string,
  decodeCommand: (value: unknown) => Command | null,
): CanvasOutboxEntry<Command> | null {
  if (!isRecord(value)) return null
  const current = hasExactKeys(
    value,
    ['branch', 'baseRevision', 'initialBaseRevision', 'mutationId', 'command', 'createdAt'],
  )
  if (!current) return null
  const baseRevision = value.baseRevision
  const initialBaseRevision = value.initialBaseRevision
  if (value.branch !== branch
    || !isRevision(baseRevision)
    || !isRevision(initialBaseRevision)
    || !isMutationId(value.mutationId)
    || !isTimestamp(value.createdAt)) return null
  const command = decodeCommand(value.command)
  if (!command) return null
  return {
    branch,
    baseRevision,
    initialBaseRevision,
    mutationId: value.mutationId,
    command: clone(command),
    createdAt: value.createdAt,
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function defaultDecodeCommand<Command extends CanvasCommandLike>(value: unknown): Command | null {
  if (!isRecord(value)
    || typeof value.type !== 'string'
    || value.type.length === 0
    || value.type.length > 128) return null
  try {
    assertJsonValue(value, 'command')
    return clone(value) as Command
  } catch {
    return null
  }
}

function sortOutboxEntries<Command extends CanvasCommandLike>(
  entries: CanvasOutboxEntry<Command>[],
): CanvasOutboxEntry<Command>[] {
  return [...entries].sort((left, right) =>
    left.createdAt - right.createdAt || left.mutationId.localeCompare(right.mutationId))
}

function isCamera(value: unknown): value is CanvasCameraState {
  return isRecord(value)
    && Object.keys(value).length === 3
    && finite(value.x)
    && finite(value.y)
    && finite(value.zoom)
    && value.zoom > 0
}

function isSelection(value: unknown): value is CanvasSelectionTarget[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTION) return false
  const keys = new Set<string>()
  for (const target of value) {
    if (!isExactRecord(target, ['kind', 'id'])
      || (target.kind !== 'node' && target.kind !== 'task' && target.kind !== 'collection')
      || !isBoundedId(target.id)) return false
    const key = `${target.kind}:${target.id}`
    if (keys.has(key)) return false
    keys.add(key)
  }
  return true
}

function isIdArray(value: unknown, limit: number): value is string[] {
  return Array.isArray(value)
    && value.length <= limit
    && value.every(isBoundedId)
    && new Set(value).size === value.length
}

function isComposerDrafts(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length <= MAX_COMPOSER_DRAFTS
    && entries.every(([key, draft]) =>
      key.length > 0
      && key.length <= MAX_ID_LENGTH * 2
      && typeof draft === 'string'
      && draft.length <= MAX_DRAFT_LENGTH)
}

function assertScope(scope: CanvasPersistenceScope): void {
  for (const [key, value] of Object.entries(scope)) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
      throw new TypeError(`Canvas scope ${key} is invalid`)
    }
  }
}

function assertRevision(value: number): void {
  if (!isRevision(value)) throw new TypeError('base revision must be a non-negative safe integer')
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function assertMutationId(value: string): void {
  if (!isMutationId(value)) throw new TypeError('mutation id is invalid')
}

function isMutationId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && ID_PATTERN.test(value)
    && !value.includes('..')
    && !value.includes('//')
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && ID_PATTERN.test(value)
}

function finiteTimestamp(value: number): number {
  if (!isTimestamp(value)) throw new TypeError('createdAt must be a finite non-negative number')
  return value
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function assertJsonValue(value: unknown, path: string, depth = 0, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return
  }
  if (depth > 64 || typeof value !== 'object') {
    throw new TypeError(`${path} is not bounded JSON`)
  }
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`)
  seen.add(value)
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertJsonValue(entry, `${path}[${index}]`, depth + 1, seen)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain objects`)
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`, depth + 1, seen)
    }
  }
  seen.delete(value)
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => jsonEquals(entry, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && jsonEquals(left[key], right[key]))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
