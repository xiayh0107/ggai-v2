import { randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { inspectRunOutcome } from '../src/agent/outcome.js'
import { inspectLegacyRunOutcome } from './legacyOutcome.js'
import { inspectArtifactManifest } from './artifactManifest.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'
import { inspectProjectionPlan } from './projectionPlan.js'
import {
  parseCanvasBranch,
  type RunClosePayload,
  type RunStreamMessage,
  type RunSummary,
} from './protocol.js'

export type PersistedRunMessage = RunStreamMessage & {
  id: number
  recordedAt: number
}

export interface RunLogPage {
  entries: PersistedRunMessage[]
  nextEventId: number | null
  /** True when a crash left only the final JSONL record incomplete. */
  truncated?: boolean
}

export interface InterruptedRunRecoveryCandidate {
  summary: RunSummary & { taskId: string }
}

export interface RunHistoryCursor {
  startedAt: number
  runId: string
}

export interface RunHistoryFilter {
  nodeId?: string
  taskId?: string
  taskOwned?: boolean
  canvasBranch?: string
  limit?: number
  /** Stable history boundary in `(startedAt desc, runId asc)` order. */
  before?: RunHistoryCursor
  includeBefore?: boolean
}

const DEFAULT_PAGE_SIZE = 500
const MAX_PAGE_SIZE = 2_000
const SUMMARY_READ_CONCURRENCY = 16
const INDEX_VALIDATION_BYTES = 1024 * 1024
const MAX_TERMINAL_CLOSE_BYTES = 8 * 1024 * 1024
const MAX_RUN_PROMPT_LENGTH = 250_000
const TERMINAL_STATUSES = new Set<RunSummary['status']>([
  'done',
  'error',
  'cancelled',
  'interrupted',
])

export class RunLogExistsError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(`durable run id already exists: ${runId}`)
    this.name = 'RunLogExistsError'
    this.runId = runId
  }
}

/**
 * Durable, append-only run history. Raw events deliberately live outside the
 * canvas Git repository: they can be large and may contain sensitive tool
 * input. A tail per run preserves event order without blocking transport
 * callbacks on disk I/O.
 */
export class RunLogStore {
  readonly projectDir: string
  readonly rootDir: string
  readonly #tails = new Map<string, Promise<void>>()

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.rootDir = path.join(this.projectDir, '.gg', 'runtime', 'runs')
  }

  async start(summary: RunSummary): Promise<void> {
    await this.#enqueue(summary.runId, async () => {
      await this.#assertSafeRunDir(summary.runId, true)
      try {
        await atomicCreateJson(this.#summaryPath(summary.runId), summary)
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) throw new RunLogExistsError(summary.runId)
        throw error
      }
    })
  }

  append(runId: string, message: RunStreamMessage & { id: number }): Promise<void> {
    return this.#enqueue(runId, async () => {
      await this.#assertSafeRunDir(runId, true)
      await this.#appendRecord(runId, message)
    })
  }

  async finish(summary: RunSummary): Promise<void> {
    await this.#enqueue(summary.runId, async () => {
      await this.#assertSafeRunDir(summary.runId, true)
      await syncFileIfPresent(this.#eventsPath(summary.runId))
      await atomicWriteJson(this.#summaryPath(summary.runId), summary)
    })
  }

  async summary(runId: string): Promise<RunSummary | null> {
    await this.flush(runId)
    if (!await this.#assertSafeRunDir(runId, false)) return null
    try {
      return decodeSummary(await readTextNoFollow(this.#summaryPath(runId)), runId)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  async list(
    filter: RunHistoryFilter = {},
  ): Promise<RunSummary[]> {
    if (filter.includeBefore !== undefined && filter.before === undefined) {
      throw new TypeError('includeBefore requires a Run history cursor')
    }
    if (filter.before !== undefined) validateRunHistoryCursor(filter.before)
    const summaries = await this.#readAllSummaries()
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 2_000))
    return summaries
      .filter((entry) => !filter.nodeId || entry.nodeId === filter.nodeId)
      .filter((entry) => !filter.taskId || entry.taskId === filter.taskId)
      .filter((entry) => filter.taskOwned === undefined
        || (entry.taskId !== undefined) === filter.taskOwned)
      .filter((entry) => !filter.canvasBranch || entry.canvasBranch === filter.canvasBranch)
      .filter((entry) => !filter.before
        || (filter.includeBefore
          ? compareRunHistoryEntry(entry, filter.before) >= 0
          : compareRunHistoryEntry(entry, filter.before) > 0))
      .sort(compareRunHistoryEntry)
      .slice(0, limit)
  }

  async page(
    runId: string,
    options: { afterEventId?: number; limit?: number } = {},
  ): Promise<RunLogPage | null> {
    await this.flush(runId)
    if (!await this.#assertSafeRunDir(runId, false)) return null
    let eventFile: Awaited<ReturnType<typeof open>>
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      eventFile = await openNoFollow(this.#eventsPath(runId), constants.O_RDONLY)
      info = await eventFile.stat()
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        const summary = await this.summary(runId)
        return summary ? { entries: [], nextEventId: null } : null
      }
      throw error
    }
    const afterEventId = Math.max(0, Math.trunc(options.afterEventId ?? 0))
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE))
    const indexedStart = afterEventId > 0
      ? await validatedEventOffset(
        this.#indexPath(runId),
        afterEventId + 1,
        eventFile,
        info.size,
      )
      : 0
    const input = eventFile.createReadStream({
      encoding: 'utf8',
      start: indexedStart ?? 0,
      autoClose: false,
    })
    const lines = createInterface({ input, crlfDelay: Infinity })
    const matching: PersistedRunMessage[] = []
    let invalidTail: unknown = null
    let truncated = false
    try {
      for await (const line of lines) {
        if (!line) continue
        if (invalidTail) throw invalidTail
        let decoded: PersistedRunMessage
        try {
          decoded = decodeMessage(line)
        } catch (error) {
          invalidTail = error
          continue
        }
        if (decoded.id <= afterEventId) continue
        matching.push(decoded)
        if (matching.length > limit) break
      }
      if (invalidTail) {
        if (await fileEndsWithNewline(eventFile, info.size)) throw invalidTail
        truncated = true
      }
    } finally {
      lines.close()
      input.destroy()
      await eventFile.close()
    }
    const hasMore = matching.length > limit
    const entries = hasMore ? matching.slice(0, limit) : matching
    return {
      entries,
      nextEventId: hasMore ? entries.at(-1)?.id ?? null : null,
      ...(truncated ? { truncated: true } : {}),
    }
  }

  /**
   * Reads the final indexed event without scanning the unbounded JSONL body.
   * The index and event tail must describe the exact same complete record;
   * crash-truncated or stale/malformed tails fail explicitly.
   */
  async terminalClose(runId: string): Promise<RunClosePayload | null> {
    await this.flush(runId)
    if (!await this.#assertSafeRunDir(runId, false)) return null
    return readIndexedTerminalClose(
      this.#eventsPath(runId),
      this.#indexPath(runId),
      runId,
    )
  }

  async deleteLog(runId: string): Promise<boolean> {
    await this.flush(runId)
    if (!await this.#assertSafeRunDir(runId, false)) return false
    try {
      await lstat(this.#runDir(runId))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false
      throw error
    }
    await Promise.all([
      rm(this.#eventsPath(runId), { force: true }),
      rm(this.#indexPath(runId), { force: true }),
    ])
    const summary = await this.summary(runId)
    if (summary) {
      await atomicWriteJson(this.#summaryPath(runId), { ...summary, logAvailable: false })
    }
    return true
  }

  async markInterrupted(): Promise<number> {
    // Startup recovery must inspect every durable summary. Applying the public
    // history page cap here used to leave older active runs permanently marked
    // as running once a project accumulated more than 2,000 runs.
    return (await this.#interruptActiveSummaries()).changed
  }

  /**
   * Marks every unfinished summary interrupted and returns Task-owned runs
   * that may need their terminal artifacts and close record reconstructed.
   *
   * Already-interrupted Task runs remain candidates. This intentionally
   * closes the crash window between rewriting summary.json and appending the
   * recovery close event; the idempotent append below decides whether any
   * durable event is still missing.
   */
  async prepareInterruptedRecovery(): Promise<InterruptedRunRecoveryCandidate[]> {
    const { summaries } = await this.#interruptActiveSummaries()
    return summaries.flatMap((summary) =>
      summary.status === 'interrupted'
        && typeof summary.taskId === 'string'
        && summary.logAvailable !== false
        ? [{ summary: summary as RunSummary & { taskId: string } }]
        : [])
  }

  /**
   * Appends one replayable interrupted close after the current durable tail.
   * Existing interrupted closes win, so repeated daemon startups are a no-op.
   * A malformed/truncated event log is never repaired in place; callers can
   * isolate that run without risking its audit trail.
   */
  async appendInterruptedCloseIfMissing(
    runId: string,
    close: RunClosePayload & { status: 'interrupted' },
  ): Promise<boolean> {
    if (close.runId !== runId) throw new TypeError('recovery close belongs to a foreign run')
    let appended = false
    await this.#enqueue(runId, async () => {
      await this.#assertSafeRunDir(runId, true)
      const tail = await inspectEventLogTail(this.#eventsPath(runId))
      if (tail.hasInterruptedClose) return
      await this.#appendRecord(runId, {
        id: tail.lastEventId + 1,
        event: 'close',
        data: close,
      })
      appended = true
    })
    return appended
  }

  async flush(runId?: string): Promise<void> {
    if (runId) {
      await this.#tails.get(runId)
      return
    }
    await Promise.allSettled(this.#tails.values())
  }

  #enqueue(runId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#tails.get(runId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.#tails.set(runId, next)
    void next.finally(() => {
      if (this.#tails.get(runId) === next) this.#tails.delete(runId)
    }).catch(() => undefined)
    return next
  }

  async #appendRecord(
    runId: string,
    message: RunStreamMessage & { id: number },
  ): Promise<void> {
    const record: PersistedRunMessage = {
      ...message,
      recordedAt: Date.now(),
    }
    const eventPath = this.#eventsPath(runId)
    const eventFile = await openNoFollow(
      eventPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    )
    let offset: number
    try {
      offset = (await eventFile.stat()).size
      await eventFile.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    } finally {
      await eventFile.close()
    }
    await writeEventOffset(this.#indexPath(runId), message.id, offset)
  }

  async #interruptActiveSummaries(): Promise<{
    summaries: RunSummary[]
    changed: number
  }> {
    const summaries = await this.#readAllSummaries()
    let changed = 0
    for (let index = 0; index < summaries.length; index += 1) {
      const summary = summaries[index]!
      if (TERMINAL_STATUSES.has(summary.status)) continue
      const interrupted: RunSummary = {
        ...summary,
        status: 'interrupted',
        finishedAt: Date.now(),
        error: summary.error ?? 'daemon restarted before the run completed',
      }
      await this.finish(interrupted)
      summaries[index] = interrupted
      changed += 1
    }
    return { summaries, changed }
  }

  async #readAllSummaries(): Promise<RunSummary[]> {
    await this.flush()
    if (!await this.#assertSafeRoot(false)) return []
    let entries: Dirent[]
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }
    const runIds = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter(isRunId)
    return mapConcurrent(runIds, SUMMARY_READ_CONCURRENCY, async (runId) => {
      try {
        return await this.summary(runId)
      } catch (error) {
        // One damaged summary must not brick history or prevent recovery of
        // every other run. Keep the bad file in place so its run id remains
        // reserved and an explicit read still surfaces the corruption.
        if (error instanceof RunSummaryCorruptionError) return null
        throw error
      }
    }).then((summaries) => summaries.filter((entry): entry is RunSummary => entry !== null))
  }

  #runDir(runId: string): string {
    assertRunId(runId)
    return path.join(this.rootDir, runId)
  }

  #summaryPath(runId: string): string {
    return path.join(this.#runDir(runId), 'summary.json')
  }

  #eventsPath(runId: string): string {
    return path.join(this.#runDir(runId), 'events.jsonl')
  }

  #indexPath(runId: string): string {
    return path.join(this.#runDir(runId), 'events.idx')
  }

  async #assertSafeRoot(create: boolean): Promise<string | null> {
    const canonicalProject = await canonicalizePotentialPath(this.projectDir)
    const expectedRoot = path.join(canonicalProject, '.gg', 'runtime', 'runs')
    const canonical = await canonicalizePotentialPath(this.rootDir)
    if (canonical !== expectedRoot) {
      throw new Error('unsafe run log root: path resolves through a symlink')
    }
    if (create) await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(this.rootDir)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('unsafe run log root: expected a real directory')
      }
      return canonical
    } catch (error) {
      if (!create && isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  async #assertSafeRunDir(runId: string, create: boolean): Promise<boolean> {
    const runDir = this.#runDir(runId)
    const canonicalRoot = await this.#assertSafeRoot(create)
    if (!canonicalRoot) return false
    const canonical = await canonicalizePotentialPath(runDir)
    const expectedRunDir = path.join(canonicalRoot, runId)
    if (canonical !== expectedRunDir || !isPathWithin(canonicalRoot, canonical)) {
      throw new Error('unsafe run log directory: path resolves outside the run log root')
    }
    if (create) await mkdir(runDir, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
      if (!isNodeError(error, 'EEXIST')) throw error
    })
    try {
      const info = await lstat(runDir)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('unsafe run log directory: expected a real directory')
      }
      return true
    } catch (error) {
      if (!create && isNodeError(error, 'ENOENT')) return false
      throw error
    }
  }
}

async function writeEventOffset(filePath: string, eventId: number, offset: number): Promise<void> {
  const handle = await openNoFollow(
    filePath,
    constants.O_RDWR | constants.O_CREAT,
  )
  try {
    const buffer = Buffer.allocUnsafe(8)
    buffer.writeBigUInt64LE(BigInt(offset))
    await handle.write(buffer, 0, buffer.length, (eventId - 1) * 8)
  } finally {
    await handle.close()
  }
}

async function readEventOffset(filePath: string, eventId: number): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await openNoFollow(filePath, constants.O_RDONLY)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
  try {
    const buffer = Buffer.alloc(8)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, (eventId - 1) * 8)
    if (bytesRead !== buffer.length) return null
    const offset = buffer.readBigUInt64LE()
    return offset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offset) : null
  } finally {
    await handle.close()
  }
}

async function validatedEventOffset(
  indexPath: string,
  eventId: number,
  eventFile: Awaited<ReturnType<typeof open>>,
  eventFileSize: number,
): Promise<number> {
  const offset = await readEventOffset(indexPath, eventId)
  if (offset === null || offset < 0 || offset >= eventFileSize) return 0
  const available = Math.min(eventFileSize - offset, INDEX_VALIDATION_BYTES + 1)
  const buffer = Buffer.alloc(available)
  const { bytesRead } = await eventFile.read(buffer, 0, available, offset)
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
  if (newline < 0 || newline > INDEX_VALIDATION_BYTES) return 0
  try {
    return decodeMessage(buffer.subarray(0, newline).toString('utf8')).id === eventId
      ? offset
      : 0
  } catch {
    return 0
  }
}

async function fileEndsWithNewline(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<boolean> {
  if (size === 0) return true
  const buffer = Buffer.alloc(1)
  const { bytesRead } = await handle.read(buffer, 0, 1, size - 1)
  return bytesRead === 1 && buffer[0] === 0x0a
}

async function readIndexedTerminalClose(
  eventPath: string,
  indexPath: string,
  expectedRunId: string,
): Promise<RunClosePayload | null> {
  let eventFile: Awaited<ReturnType<typeof open>>
  try {
    eventFile = await openNoFollow(eventPath, constants.O_RDONLY)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
  try {
    const eventInfo = await eventFile.stat()
    if (!eventInfo.isFile()) throw new Error('run event log must be a regular file')
    if (eventInfo.size === 0) {
      const indexSize = await indexedEventCount(indexPath)
      if (indexSize !== 0) throw new Error('run event index extends beyond an empty log')
      return null
    }
    if (!await fileEndsWithNewline(eventFile, eventInfo.size)) {
      throw new Error('run event log has an incomplete terminal record')
    }

    const terminalEventId = await indexedEventCount(indexPath)
    if (terminalEventId < 1) throw new Error('run event log is missing its terminal index')
    const offset = await readEventOffset(indexPath, terminalEventId)
    if (offset === null || offset < 0 || offset >= eventInfo.size) {
      throw new Error('run event index has an invalid terminal offset')
    }
    const recordBytes = eventInfo.size - offset
    if (recordBytes > MAX_TERMINAL_CLOSE_BYTES) {
      throw new Error('run terminal event exceeds the supported size')
    }
    const buffer = Buffer.alloc(recordBytes)
    const { bytesRead } = await eventFile.read(buffer, 0, recordBytes, offset)
    if (bytesRead !== recordBytes) throw new Error('run terminal event could not be read completely')
    const source = buffer.toString('utf8')
    if (!source.endsWith('\n') || source.slice(0, -1).includes('\n')) {
      throw new Error('run event index does not point at the terminal record')
    }
    let message: PersistedRunMessage
    try {
      message = decodeMessage(source.slice(0, -1))
    } catch (error) {
      throw new Error('run log contains an invalid terminal event', { cause: error })
    }
    if (message.id !== terminalEventId) {
      throw new Error('run terminal event id does not match its index')
    }
    if (message.event !== 'close') return null
    return decodeTerminalClose(message.data, expectedRunId)
  } finally {
    await eventFile.close()
  }
}

async function indexedEventCount(indexPath: string): Promise<number> {
  let indexFile: Awaited<ReturnType<typeof open>>
  try {
    indexFile = await openNoFollow(indexPath, constants.O_RDONLY)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 0
    throw error
  }
  try {
    const info = await indexFile.stat()
    if (!info.isFile()) throw new Error('run event index must be a regular file')
    if (info.size % 8 !== 0) throw new Error('run event index has a partial terminal entry')
    const count = info.size / 8
    if (!Number.isSafeInteger(count)) throw new Error('run event index is too large')
    return count
  } finally {
    await indexFile.close()
  }
}

function decodeTerminalClose(value: unknown, expectedRunId: string): RunClosePayload {
  if (!isRecord(value)
    || value.runId !== expectedRunId
    || !isTerminalCloseStatus(value.status)
    || (value.sessionId !== null && typeof value.sessionId !== 'string')
    || !Array.isArray(value.artifacts)
    || !value.artifacts.every((artifact) => typeof artifact === 'string')
    || typeof value.artifactsComplete !== 'boolean') {
    throw new Error('run log contains an invalid terminal close')
  }
  const artifactManifest = value.artifactManifest === undefined
    ? undefined
    : inspectArtifactManifest(value.artifactManifest)
  if (artifactManifest?.status === 'invalid'
    || (artifactManifest?.status === 'valid'
      && artifactManifest.manifest.runId !== expectedRunId)) {
    throw new Error('run log contains an invalid terminal artifact manifest')
  }
  const outcome = value.outcome === undefined
    ? undefined
    : inspectLegacyRunOutcome(value.outcome)
  if (outcome?.status !== undefined && outcome.status !== 'valid') {
    throw new Error('run log contains an invalid terminal outcome')
  }
  const projectionPlan = value.projectionPlan === undefined
    ? undefined
    : inspectProjectionPlan(value.projectionPlan)
  if (projectionPlan?.status === 'invalid'
    || (projectionPlan?.status === 'valid'
      && projectionPlan.plan.runId !== expectedRunId)) {
    throw new Error('run log contains an invalid terminal projection plan')
  }
  let suggestedActions
  if (value.suggestedActions !== undefined) {
    if (projectionPlan?.status !== 'valid') {
      throw new Error('run log terminal close has actions without a projection plan')
    }
    const inspection = inspectRunOutcome({
      schemaVersion: 2,
      suggestedActions: value.suggestedActions,
      outputs: [],
      taskProposals: [],
    })
    if (inspection.status !== 'valid'
      || (projectionPlan.plan.status === 'partial'
        && inspection.outcome.suggestedActions.length > 0)) {
      throw new Error('run log contains invalid terminal suggested actions')
    }
    suggestedActions = inspection.outcome.suggestedActions
  }
  return {
    runId: expectedRunId,
    status: value.status,
    sessionId: value.sessionId,
    artifacts: [...value.artifacts],
    artifactsComplete: value.artifactsComplete,
    ...(artifactManifest?.status === 'valid'
      ? { artifactManifest: artifactManifest.manifest }
      : {}),
    ...(outcome?.status === 'valid' ? { outcome: outcome.outcome } : {}),
    ...(projectionPlan?.status === 'valid'
      ? { projectionPlan: projectionPlan.plan }
      : {}),
    ...(suggestedActions ? { suggestedActions } : {}),
  }
}

function isTerminalCloseStatus(value: unknown): value is RunClosePayload['status'] {
  return value === 'done'
    || value === 'error'
    || value === 'cancelled'
    || value === 'interrupted'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function inspectEventLogTail(filePath: string): Promise<{
  lastEventId: number
  hasInterruptedClose: boolean
}> {
  let eventFile: Awaited<ReturnType<typeof open>>
  try {
    eventFile = await openNoFollow(filePath, constants.O_RDONLY)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return { lastEventId: 0, hasInterruptedClose: false }
    }
    throw error
  }
  const info = await eventFile.stat()
  const input = eventFile.createReadStream({
    encoding: 'utf8',
    autoClose: false,
  })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lastEventId = 0
  let hasInterruptedClose = false
  try {
    for await (const line of lines) {
      if (!line) continue
      let decoded: PersistedRunMessage
      try {
        decoded = decodeMessage(line)
      } catch (error) {
        throw new Error('run log contains an invalid recovery event', { cause: error })
      }
      if (decoded.id <= lastEventId) {
        throw new Error('run log event ids are not strictly increasing')
      }
      lastEventId = decoded.id
      if (decoded.event === 'close'
        && typeof decoded.data === 'object'
        && decoded.data !== null
        && !Array.isArray(decoded.data)
        && (decoded.data as { status?: unknown }).status === 'interrupted') {
        hasInterruptedClose = true
      }
    }
    if (info.size > 0 && !await fileEndsWithNewline(eventFile, info.size)) {
      throw new Error('run log has an incomplete final event')
    }
    return { lastEventId, hasInterruptedClose }
  } finally {
    lines.close()
    input.destroy()
    await eventFile.close()
  }
}

function compareRunHistoryEntry(
  left: Pick<RunSummary, 'startedAt' | 'runId'>,
  right: RunHistoryCursor,
): number {
  if (left.startedAt !== right.startedAt) return left.startedAt > right.startedAt ? -1 : 1
  return left.runId.localeCompare(right.runId)
}

function validateRunHistoryCursor(cursor: RunHistoryCursor): void {
  if (!Number.isFinite(cursor.startedAt)
    || cursor.startedAt < 0
    || !isRunId(cursor.runId)) {
    throw new TypeError('Run history cursor is invalid')
  }
}

function assertRunId(runId: string): void {
  if (!isRunId(runId)) {
    throw new Error('runId contains unsupported characters')
  }
}

function isRunId(runId: unknown): runId is string {
  return typeof runId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u.test(runId)
}

class RunSummaryCorruptionError extends Error {
  constructor(runId: string, message: string, cause?: unknown) {
    super(`run ${runId} has an invalid durable summary: ${message}`, { cause })
    this.name = 'RunSummaryCorruptionError'
  }
}

function decodeSummary(source: string, expectedRunId: string): RunSummary {
  let decoded: unknown
  try {
    decoded = JSON.parse(source) as unknown
  } catch (error) {
    throw new RunSummaryCorruptionError(expectedRunId, 'invalid JSON', error)
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new RunSummaryCorruptionError(expectedRunId, 'expected an object')
  }
  const record = decoded as Record<string, unknown>
  const hasBaseRevision = record.baseRevision !== undefined
  const hasPrompt = record.prompt !== undefined
  const nodeStudioOwned = record.runKind === 'node-studio'
  if (
    record.runId !== expectedRunId
    || typeof record.nodeId !== 'string'
    || typeof record.agentId !== 'string'
    || !isRunId(record.runId)
    || !isRunId(record.nodeId)
    || (record.taskId !== undefined
      && (typeof record.taskId !== 'string' || !isRunId(record.taskId)))
    || hasBaseRevision !== hasPrompt
    || ((hasBaseRevision || hasPrompt) && record.taskId === undefined)
    || (hasBaseRevision
      && (!Number.isSafeInteger(record.baseRevision) || (record.baseRevision as number) < 0))
    || (hasPrompt
      && (typeof record.prompt !== 'string' || record.prompt.length > MAX_RUN_PROMPT_LENGTH))
    || (record.pluginCapabilityDigest !== undefined
      && (typeof record.pluginCapabilityDigest !== 'string'
        || !/^[0-9a-f]{64}$/u.test(record.pluginCapabilityDigest)))
    || (record.skillCapabilityDigest !== undefined
      && (typeof record.skillCapabilityDigest !== 'string'
        || !/^[0-9a-f]{64}$/u.test(record.skillCapabilityDigest)))
    || (record.runKind !== undefined && record.runKind !== 'node-studio')
    || (nodeStudioOwned
      ? record.taskId !== undefined
        || typeof record.baseDefinitionId !== 'string'
        || !/^@local\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.baseDefinitionId)
        || !Number.isSafeInteger(record.baseDefinitionRevision)
        || Number(record.baseDefinitionRevision) < 0
      : record.baseDefinitionId !== undefined || record.baseDefinitionRevision !== undefined)
    || !isRunId(record.agentId)
    || !isRunStatus(record.status)
    || typeof record.startedAt !== 'number'
    || !Number.isFinite(record.startedAt)
    || record.startedAt < 0
    || (record.finishedAt !== undefined
      && (typeof record.finishedAt !== 'number'
        || !Number.isFinite(record.finishedAt)
        || record.finishedAt < 0))
    || (record.sessionId !== null && typeof record.sessionId !== 'string')
    || (record.error !== undefined && typeof record.error !== 'string')
    || (record.logAvailable !== undefined && typeof record.logAvailable !== 'boolean')
  ) {
    throw new RunSummaryCorruptionError(expectedRunId, 'schema validation failed')
  }
  let canvasBranch: string
  try {
    canvasBranch = parseCanvasBranch(record.canvasBranch ?? 'main')
  } catch (error) {
    throw new RunSummaryCorruptionError(expectedRunId, 'invalid canvas branch', error)
  }
  return {
    runId: record.runId,
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    ...(record.baseRevision === undefined ? {} : { baseRevision: record.baseRevision }),
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
    nodeId: record.nodeId,
    agentId: record.agentId,
    canvasBranch,
    ...(record.pluginCapabilityDigest === undefined
      ? {}
      : { pluginCapabilityDigest: record.pluginCapabilityDigest }),
    ...(record.skillCapabilityDigest === undefined
      ? {}
      : { skillCapabilityDigest: record.skillCapabilityDigest }),
    ...(nodeStudioOwned ? {
      runKind: 'node-studio' as const,
      baseDefinitionId: record.baseDefinitionId,
      baseDefinitionRevision: record.baseDefinitionRevision,
    } : {}),
    status: record.status,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    sessionId: record.sessionId,
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.logAvailable === undefined ? {} : { logAvailable: record.logAvailable }),
  } as RunSummary
}

function isRunStatus(value: unknown): value is RunSummary['status'] {
  return value === 'preparing'
    || value === 'running'
    || value === 'awaiting-permission'
    || TERMINAL_STATUSES.has(value as RunSummary['status'])
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await mapper(values[index] as T)
      }
    },
  )
  await Promise.all(workers)
  return results
}

function decodeMessage(line: string): PersistedRunMessage {
  const decoded: unknown = JSON.parse(line)
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('run log contains an invalid event')
  }
  const record = decoded as Record<string, unknown>
  if (!Number.isSafeInteger(record.id) || (record.id as number) < 1) {
    throw new Error('run log contains an invalid event id')
  }
  if (typeof record.event !== 'string'
    || typeof record.recordedAt !== 'number'
    || !Number.isFinite(record.recordedAt)) {
    throw new Error('run log contains an invalid event')
  }
  return record as unknown as PersistedRunMessage
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, filePath)
    const directory = await open(path.dirname(filePath), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function atomicCreateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    // link is an atomic create-if-absent operation; unlike rename it cannot
    // replace a prior run owned by another daemon process.
    await link(temporary, filePath)
    const directory = await open(path.dirname(filePath), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function syncFileIfPresent(filePath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await openNoFollow(filePath, constants.O_RDONLY)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readTextNoFollow(filePath: string): Promise<string> {
  const handle = await openNoFollow(filePath, constants.O_RDONLY)
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function openNoFollow(
  filePath: string,
  flags: number,
  mode = 0o600,
): ReturnType<typeof open> {
  return open(filePath, flags | constants.O_NOFOLLOW, mode)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
