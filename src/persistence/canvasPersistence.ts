import type { Camera } from '@/types/canvas'
import {
  decodeDaemonCanvasDocument,
  type DaemonCanvasDocumentV1,
} from '@/agent/daemonClient'

const DATABASE_NAME = 'ggai-canvas'
const DATABASE_VERSION = 2
const JOURNAL_STORE = 'canvas-journals'
const CAMERA_STORE = 'canvas-cameras'
const WRITER_SESSION_KEY = 'ggai.canvas.writer-id'
const MAX_WRITER_ID_LENGTH = 128

export interface CanvasJournalScope {
  daemonBaseUrl: string
  projectDir: string
  branch: string
}

export interface CanvasJournalEntry {
  mutationId: string
  baseRevision: number
  changeKind: 'autosave'
  createdAt: number
  attempted: boolean
  fingerprint: string
  document: DaemonCanvasDocumentV1
}

export interface CanvasJournalCandidate {
  writerId: string
  entries: CanvasJournalEntry[]
  updatedAt: number
  discardedEntries: number
}

export interface ReconciledCanvasJournalCandidate {
  candidate: CanvasJournalCandidate | null
  acknowledged: boolean
}

export interface CanvasJournalSelection {
  ownCandidate: CanvasJournalCandidate | null
  foreignCandidates: CanvasJournalCandidate[]
  conflict: boolean
}

interface StoredCanvasJournal {
  key: string
  scopeKey: string
  writerId: string
  entries: unknown[]
  updatedAt: number
}

interface StoredCamera {
  key: string
  camera: Camera
  updatedAt: number
}

let databasePromise: Promise<IDBDatabase | null> | null = null
let memoryWriterId: string | null = null

export function canvasScopeKey(scope: CanvasJournalScope): string {
  return JSON.stringify([scope.daemonBaseUrl, scope.projectDir, scope.branch])
}

export function canvasJournalKey(scope: CanvasJournalScope, writerId: string): string {
  assertWriterId(writerId)
  return JSON.stringify([canvasScopeKey(scope), writerId])
}

/** Stable across reloads in one tab and isolated from other ordinary tabs. */
export function getCanvasWriterId(): string {
  if (memoryWriterId) return memoryWriterId
  try {
    const stored = globalThis.sessionStorage?.getItem(WRITER_SESSION_KEY)
    if (stored && isWriterId(stored)) {
      memoryWriterId = stored
      return stored
    }
  } catch {
    // sessionStorage can be disabled; the in-memory id still isolates this mount.
  }
  const generated = globalThis.crypto?.randomUUID?.()
    ?? `writer-${Date.now()}-${Math.random().toString(36).slice(2)}`
  memoryWriterId = generated
  try {
    globalThis.sessionStorage?.setItem(WRITER_SESSION_KEY, generated)
  } catch {
    // Private browsing policies may reject storage writes.
  }
  return generated
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

function openDatabase(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return Promise.resolve(null)
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.addEventListener('upgradeneeded', () => {
      const database = request.result
      if (!database.objectStoreNames.contains(JOURNAL_STORE)) {
        database.createObjectStore(JOURNAL_STORE, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(CAMERA_STORE)) {
        database.createObjectStore(CAMERA_STORE, { keyPath: 'key' })
      }
    })
    request.addEventListener('success', () => {
      const database = request.result
      database.addEventListener('versionchange', () => {
        database.close()
        databasePromise = null
      })
      resolve(database)
    }, { once: true })
    request.addEventListener('error', () => {
      databasePromise = null
      reject(request.error)
    }, { once: true })
    request.addEventListener('blocked', () => {
      databasePromise = null
      reject(new Error('Canvas persistence database upgrade was blocked'))
    }, { once: true })
  })
  return databasePromise
}

function decodeJournalEntry(value: unknown): CanvasJournalEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (typeof entry.mutationId !== 'string'
    || entry.mutationId.length === 0
    || !Number.isSafeInteger(entry.baseRevision)
    || (entry.baseRevision as number) < 0
    || entry.changeKind !== 'autosave'
    || typeof entry.createdAt !== 'number'
    || !Number.isFinite(entry.createdAt)
    || typeof entry.attempted !== 'boolean'
    || typeof entry.fingerprint !== 'string') return null
  try {
    return {
      mutationId: entry.mutationId,
      baseRevision: entry.baseRevision as number,
      changeKind: 'autosave',
      createdAt: entry.createdAt,
      attempted: entry.attempted,
      fingerprint: entry.fingerprint,
      document: decodeDaemonCanvasDocument(entry.document, 'IndexedDB journal document'),
    }
  } catch {
    return null
  }
}

/** Exported for focused corruption tests; invalid entries are isolated individually. */
export function decodeCanvasJournalEntries(values: unknown): {
  entries: CanvasJournalEntry[]
  discardedEntries: number
} {
  if (!Array.isArray(values)) return { entries: [], discardedEntries: 1 }
  const entries: CanvasJournalEntry[] = []
  let discardedEntries = 0
  for (const value of values) {
    const entry = decodeJournalEntry(value)
    if (entry) entries.push(entry)
    else discardedEntries += 1
  }
  return { entries, discardedEntries }
}

/**
 * Removes an acknowledged head and rebases every unsent tail entry. This is
 * the crash-safe path for "daemon committed, IndexedDB cleanup did not".
 */
export function reconcileCanvasJournalCandidate(
  candidate: CanvasJournalCandidate,
  server: { revision: number; lastMutationId: string | null },
): ReconciledCanvasJournalCandidate {
  const head = candidate.entries[0]
  if (!head
    || server.lastMutationId !== head.mutationId
    || server.revision <= head.baseRevision) {
    return { candidate, acknowledged: false }
  }
  const tail = candidate.entries.slice(1).map((entry) => ({
    ...entry,
    baseRevision: server.revision,
    attempted: false,
  }))
  return {
    candidate: tail.length === 0 ? null : { ...candidate, entries: tail },
    acknowledged: true,
  }
}

/** Selects only this tab's partition; other candidates remain isolated. */
export function selectCanvasJournalCandidates(
  candidates: CanvasJournalCandidate[],
  writerId: string,
  serverRevision: number,
): CanvasJournalSelection {
  assertWriterId(writerId)
  const ownCandidate = candidates.find((candidate) => candidate.writerId === writerId) ?? null
  const foreignCandidates = candidates.filter((candidate) => candidate.writerId !== writerId)
  const ownRevisionConflict = ownCandidate?.entries[0]?.baseRevision !== undefined
    && ownCandidate.entries[0].baseRevision !== serverRevision
  return {
    ownCandidate,
    foreignCandidates,
    conflict: foreignCandidates.length > 0 || ownRevisionConflict,
  }
}

function isCamera(value: unknown): value is Camera {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const camera = value as Partial<Camera>
  return typeof camera.x === 'number'
    && Number.isFinite(camera.x)
    && typeof camera.y === 'number'
    && Number.isFinite(camera.y)
    && typeof camera.zoom === 'number'
    && Number.isFinite(camera.zoom)
    && camera.zoom > 0
}

function isWriterId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_WRITER_ID_LENGTH
}

function assertWriterId(writerId: string): void {
  if (!isWriterId(writerId)) throw new TypeError('writerId must be a non-empty bounded string')
}

/** Enumerates every tab-owned candidate for a canvas scope without merging them. */
export async function readCanvasJournals(
  scope: CanvasJournalScope,
): Promise<CanvasJournalCandidate[]> {
  const database = await openDatabase()
  if (!database) return []
  const scopeKey = canvasScopeKey(scope)
  const transaction = database.transaction(JOURNAL_STORE, 'readonly')
  const done = transactionDone(transaction)
  const storedValues = await requestResult(transaction.objectStore(JOURNAL_STORE).getAll())
  await done

  const candidates: CanvasJournalCandidate[] = []
  const sanitizations: StoredCanvasJournal[] = []
  const deletions: string[] = []
  for (const raw of storedValues as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const stored = raw as Record<string, unknown>
    const legacy = stored.key === scopeKey && stored.scopeKey === undefined
    if (!legacy && stored.scopeKey !== scopeKey) continue
    const writerId = legacy ? 'legacy' : stored.writerId
    if (!isWriterId(writerId) || typeof stored.key !== 'string') continue
    const decoded = decodeCanvasJournalEntries(stored.entries)
    const updatedAt = typeof stored.updatedAt === 'number' && Number.isFinite(stored.updatedAt)
      ? stored.updatedAt
      : 0
    if (decoded.entries.length > 0) {
      candidates.push({ writerId, updatedAt, ...decoded })
    }
    if (decoded.discardedEntries > 0 || legacy) {
      deletions.push(stored.key)
      if (decoded.entries.length > 0) {
        sanitizations.push({
          key: canvasJournalKey(scope, writerId),
          scopeKey,
          writerId,
          entries: decoded.entries,
          updatedAt,
        })
      }
    }
  }

  // Corrupt entries are dropped after all valid candidates are safely in memory.
  if (deletions.length > 0 || sanitizations.length > 0) {
    try {
      const cleanup = database.transaction(JOURNAL_STORE, 'readwrite')
      const cleanupDone = transactionDone(cleanup)
      const store = cleanup.objectStore(JOURNAL_STORE)
      for (const key of deletions) store.delete(key)
      for (const value of sanitizations) store.put(value)
      await cleanupDone
    } catch {
      // Cleanup is best effort; valid daemon state and decoded candidates remain usable.
    }
  }
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function writeCanvasJournal(
  scope: CanvasJournalScope,
  writerId: string,
  entries: CanvasJournalEntry[],
): Promise<void> {
  assertWriterId(writerId)
  for (const entry of entries) {
    if (!decodeJournalEntry(entry)) throw new TypeError('Refusing to persist an invalid canvas journal entry')
  }
  const database = await openDatabase()
  if (!database) return
  const transaction = database.transaction(JOURNAL_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(JOURNAL_STORE)
  const key = canvasJournalKey(scope, writerId)
  if (entries.length === 0) {
    store.delete(key)
  } else {
    store.put({
      key,
      scopeKey: canvasScopeKey(scope),
      writerId,
      entries,
      updatedAt: Date.now(),
    } satisfies StoredCanvasJournal)
  }
  await done
}

export async function deleteCanvasJournal(
  scope: CanvasJournalScope,
  writerId: string,
): Promise<void> {
  assertWriterId(writerId)
  const database = await openDatabase()
  if (!database) return
  const transaction = database.transaction(JOURNAL_STORE, 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore(JOURNAL_STORE).delete(canvasJournalKey(scope, writerId))
  await done
}

export async function readCanvasCamera(
  scope: CanvasJournalScope,
): Promise<Camera | null> {
  const database = await openDatabase()
  if (!database) return null
  const transaction = database.transaction(CAMERA_STORE, 'readonly')
  const done = transactionDone(transaction)
  const stored = await requestResult(
    transaction.objectStore(CAMERA_STORE).get(canvasScopeKey(scope)),
  ) as StoredCamera | undefined
  await done
  return stored && isCamera(stored.camera) ? stored.camera : null
}

export async function writeCanvasCamera(
  scope: CanvasJournalScope,
  camera: Camera,
): Promise<void> {
  if (!isCamera(camera)) return
  const database = await openDatabase()
  if (!database) return
  const transaction = database.transaction(CAMERA_STORE, 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore(CAMERA_STORE).put({
    key: canvasScopeKey(scope),
    camera,
    updatedAt: Date.now(),
  } satisfies StoredCamera)
  await done
}
