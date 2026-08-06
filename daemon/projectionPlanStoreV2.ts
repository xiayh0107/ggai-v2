import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { inspectRunOutcomeV2 } from '../src/agent/outcomeV2.js'
import type { SuggestedAction } from '../src/agent/outcome.js'
import { atomicWriteText, isNodeError } from './atomic-file.js'
import { parseTaskIdV2 } from './taskRunProtocolV2.js'
import {
  buildProjectionPlanV2,
  inspectProjectionPlanV2,
  type BuildProjectionPlanV2Input,
  type BuildProjectionPlanV2Result,
  type ProjectionPlanV2,
} from './projectionPlanV2.js'

export const PROJECTION_PLAN_STORE_V2_SCHEMA_VERSION = 2
export const MAX_STORED_PROJECTION_PLANS_V2 = 1_000
export const RETAINED_SETTLED_PROJECTION_PLANS_V2 = 900
export const MAX_PROJECTION_PLAN_STORE_BYTES_V2 = 64 * 1024 * 1024

export type ProjectionPlanLifecycleV2 = 'pending' | 'dismissed'

export interface ProjectionPlanRecordV2 {
  state: ProjectionPlanLifecycleV2
  createdAt: number
  updatedAt: number
  plan: ProjectionPlanV2
  suggestedActions: SuggestedAction[]
}

export interface CreatedProjectionPlanV2 extends BuildProjectionPlanV2Result {
  record: ProjectionPlanRecordV2
}

export type RecoverInterruptedProjectionPlanV2Input = Pick<
  BuildProjectionPlanV2Input,
  'taskId' | 'runId' | 'manifest' | 'plugins'
>

export interface RecoveredInterruptedProjectionPlanV2 {
  record: ProjectionPlanRecordV2
  disposition: 'created' | 'replaced-pending' | 'closed'
}

export interface ProjectionPlanStoreV2Options {
  now?: () => number
  /** Revalidates daemon-owned parent directories before each read or write. */
  validatePath?: () => Promise<void>
}

export interface ProjectionPlanReconciliationV2 {
  dismissedPlanIds: string[]
}

export class ProjectionPlanConflictV2Error extends Error {
  readonly planId: string

  constructor(planId: string) {
    super(`Projection plan identity was reused with different trusted content: ${planId}`)
    this.name = 'ProjectionPlanConflictV2Error'
    this.planId = planId
  }
}

export class ProjectionPlanNotFoundV2Error extends Error {
  readonly planId: string

  constructor(planId: string) {
    super(`Projection plan was not found: ${planId}`)
    this.name = 'ProjectionPlanNotFoundV2Error'
    this.planId = planId
  }
}

export class ProjectionPlanNotPendingV2Error extends Error {
  readonly planId: string
  readonly state: ProjectionPlanLifecycleV2

  constructor(planId: string, state: ProjectionPlanLifecycleV2) {
    super(`Projection plan is ${state}, not pending: ${planId}`)
    this.name = 'ProjectionPlanNotPendingV2Error'
    this.planId = planId
    this.state = state
  }
}

export class ProjectionPlanStoreSnapshotV2Error extends Error {
  readonly filePath: string

  constructor(filePath: string, cause: unknown) {
    super(`Invalid ProjectionPlan V2 store at ${filePath}`, { cause })
    this.name = 'ProjectionPlanStoreSnapshotV2Error'
    this.filePath = filePath
  }
}

/**
 * Durable daemon-owned ProjectionPlan registry.
 *
 * Callers provide raw run settlement inputs, never a client-authored plan. The
 * store builds the trusted plan itself, persists it as pending, and later
 * resolves HTTP commands by planId. Dismissal changes lifecycle only; it never
 * accepts canvas ids, coordinates, payload patches, or a replacement plan.
 */
export class ProjectionPlanStoreV2 {
  readonly filePath: string

  readonly #now: () => number
  readonly #validatePath?: () => Promise<void>
  #records: Map<string, ProjectionPlanRecordV2> | null = null
  #operationTail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: ProjectionPlanStoreV2Options = {}) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TypeError('filePath must be a non-empty string')
    }
    this.filePath = path.resolve(filePath)
    this.#now = options.now ?? Date.now
    this.#validatePath = options.validatePath
  }

  /** Builds and persists a daemon-authoritative plan as pending. */
  async createPending(input: BuildProjectionPlanV2Input): Promise<CreatedProjectionPlanV2> {
    const built = buildProjectionPlanV2(input)
    const inspection = inspectProjectionPlanV2(built.plan)
    if (inspection.status !== 'valid') {
      throw new TypeError(`generated projection plan is invalid: ${inspection.reason}`)
    }

    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const existing = this.#records?.get(inspection.plan.planId)
      if (existing) {
        if (existing.plan.digest !== inspection.plan.digest
          || JSON.stringify(existing.suggestedActions) !== JSON.stringify(built.suggestedActions)) {
          throw new ProjectionPlanConflictV2Error(inspection.plan.planId)
        }
        if (existing.state !== 'pending') {
          throw new ProjectionPlanNotPendingV2Error(inspection.plan.planId, existing.state)
        }
        return cloneCreatedResult(built, existing)
      }
      const now = this.#now()
      assertTimestamp(now, 'now')
      const next = new Map(this.#records ?? [])
      for (const [planId, record] of next) {
        if (record.state !== 'pending' || record.plan.taskId !== inspection.plan.taskId) continue
        if (now < record.updatedAt) throw new TypeError('now cannot move backwards')
        next.set(planId, { ...record, state: 'dismissed', updatedAt: now })
      }
      pruneSettledRecords(next)
      if (next.size >= MAX_STORED_PROJECTION_PLANS_V2) {
        throw new TypeError('projection plan store has too many pending records')
      }
      const record: ProjectionPlanRecordV2 = {
        state: 'pending',
        createdAt: now,
        updatedAt: now,
        plan: inspection.plan,
        suggestedActions: built.suggestedActions.map((action) => ({ ...action })),
      }
      next.set(record.plan.planId, record)
      await this.#persist(next)
      this.#records = next
      return cloneCreatedResult(built, record)
    })
  }

  /**
   * Rebuilds the trusted partial plan for a run interrupted by daemon restart.
   * Only an existing pending record may be replaced. Any settled record is an
   * immutable fact and is returned as closed without modification.
   */
  async recoverInterrupted(
    input: RecoverInterruptedProjectionPlanV2Input,
  ): Promise<RecoveredInterruptedProjectionPlanV2> {
    const built = buildProjectionPlanV2({
      ...input,
      runStatus: 'interrupted',
    })
    const inspection = inspectProjectionPlanV2(built.plan)
    if (inspection.status !== 'valid'
      || inspection.plan.status !== 'partial'
      || inspection.plan.taskProposals.length > 0
      || built.suggestedActions.length > 0) {
      throw new TypeError('generated interrupted projection plan is invalid')
    }

    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const existing = this.#records?.get(inspection.plan.planId)
      if (existing && existing.state !== 'pending') {
        return { record: cloneRecord(existing), disposition: 'closed' }
      }
      if (existing
        && (existing.plan.taskId !== inspection.plan.taskId
          || existing.plan.runId !== inspection.plan.runId)) {
        throw new ProjectionPlanConflictV2Error(inspection.plan.planId)
      }
      if (existing
        && existing.plan.digest === inspection.plan.digest
        && JSON.stringify(existing.suggestedActions) === JSON.stringify(built.suggestedActions)) {
        return { record: cloneRecord(existing), disposition: 'replaced-pending' }
      }
      if (!existing && (this.#records?.size ?? 0) >= MAX_STORED_PROJECTION_PLANS_V2) {
        throw new TypeError('projection plan store has too many records')
      }

      const now = this.#now()
      assertTimestamp(now, 'now')
      if (existing && now < existing.updatedAt) throw new TypeError('now cannot move backwards')
      const record: ProjectionPlanRecordV2 = {
        state: 'pending',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        plan: inspection.plan,
        suggestedActions: [],
      }
      const next = new Map(this.#records ?? [])
      next.set(record.plan.planId, record)
      await this.#persist(next)
      this.#records = next
      return {
        record: cloneRecord(record),
        disposition: existing ? 'replaced-pending' : 'created',
      }
    })
  }

  async get(planId: string): Promise<ProjectionPlanRecordV2 | undefined> {
    const parsedPlanId = parseProjectionPlanId(planId)
    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const record = this.#records?.get(parsedPlanId)
      return record ? cloneRecord(record) : undefined
    })
  }

  /** Resolves only live plans; this is the command endpoint's trusted lookup. */
  async requirePending(planId: string): Promise<ProjectionPlanV2> {
    const parsedPlanId = parseProjectionPlanId(planId)
    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const record = this.#records?.get(parsedPlanId)
      if (!record) throw new ProjectionPlanNotFoundV2Error(parsedPlanId)
      if (record.state !== 'pending') {
        throw new ProjectionPlanNotPendingV2Error(parsedPlanId, record.state)
      }
      return structuredClone(record.plan)
    })
  }

  /** Idempotently closes a pending plan while retaining its audit record. */
  async dismiss(planId: string): Promise<ProjectionPlanRecordV2> {
    const parsedPlanId = parseProjectionPlanId(planId)
    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const existing = this.#records?.get(parsedPlanId)
      if (!existing) throw new ProjectionPlanNotFoundV2Error(parsedPlanId)
      if (existing.state === 'dismissed') return cloneRecord(existing)

      const now = this.#now()
      assertTimestamp(now, 'now')
      if (now < existing.updatedAt) throw new TypeError('now cannot move backwards')
      const record: ProjectionPlanRecordV2 = {
        ...existing,
        state: 'dismissed',
        updatedAt: now,
      }
      const next = new Map(this.#records ?? [])
      next.set(parsedPlanId, record)
      await this.#persist(next)
      this.#records = next
      return cloneRecord(record)
    })
  }

  /**
   * Closes every pending plan whose parent Task no longer exists in the
   * authoritative durable Canvas document. The Canvas deletion is committed
   * before this method is called, so retries and restart recovery may safely
   * repeat the reconciliation without resurrecting or losing Run close data.
   */
  async dismissPendingForMissingTasks(
    liveTaskIds: ReadonlySet<string>,
  ): Promise<ProjectionPlanReconciliationV2> {
    for (const taskId of liveTaskIds) parseTaskIdV2(taskId)
    return this.#runExclusive(async () => {
      await this.#preparePath()
      await this.#ensureLoaded()
      const pending = [...(this.#records?.values() ?? [])]
        .filter((record) => record.state === 'pending' && !liveTaskIds.has(record.plan.taskId))
        .sort((left, right) => left.plan.planId.localeCompare(right.plan.planId))
      if (pending.length === 0) return { dismissedPlanIds: [] }

      const now = this.#now()
      assertTimestamp(now, 'now')
      const next = new Map(this.#records ?? [])
      for (const existing of pending) {
        if (now < existing.updatedAt) throw new TypeError('now cannot move backwards')
        next.set(existing.plan.planId, {
          ...existing,
          state: 'dismissed',
          updatedAt: now,
        })
      }
      await this.#persist(next)
      this.#records = next
      return { dismissedPlanIds: pending.map((record) => record.plan.planId) }
    })
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#records) return
    let source: string
    try {
      source = await readTextNoFollow(this.filePath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      this.#records = new Map()
      return
    }
    try {
      this.#records = parseStore(source)
    } catch (error) {
      throw new ProjectionPlanStoreSnapshotV2Error(this.filePath, error)
    }
  }

  async #preparePath(): Promise<void> {
    await this.#validatePath?.()
    try {
      const status = await lstat(this.filePath)
      if (status.isSymbolicLink()) throw new TypeError('projection plan store must not be a symlink')
      if (!status.isFile()) throw new TypeError('projection plan store must be a regular file')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
  }

  async #persist(records: ReadonlyMap<string, ProjectionPlanRecordV2>): Promise<void> {
    await this.#preparePath()
    await atomicWriteText(this.filePath, serializeStore(records))
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

function pruneSettledRecords(records: Map<string, ProjectionPlanRecordV2>): void {
  if (records.size < MAX_STORED_PROJECTION_PLANS_V2) return
  const removable = [...records.values()]
    .filter((record) => record.state !== 'pending')
    .sort((left, right) => left.updatedAt - right.updatedAt
      || left.plan.planId.localeCompare(right.plan.planId))
  const removeCount = Math.max(
    0,
    records.size - RETAINED_SETTLED_PROJECTION_PLANS_V2,
  )
  for (const record of removable.slice(0, removeCount)) records.delete(record.plan.planId)
}

function parseStore(source: string): Map<string, ProjectionPlanRecordV2> {
  if (Buffer.byteLength(source, 'utf8') > MAX_PROJECTION_PLAN_STORE_BYTES_V2) {
    throw new TypeError('projection plan store exceeds the supported size')
  }
  const value: unknown = JSON.parse(source)
  if (!isExactRecord(value, ['schemaVersion', 'records'])
    || value.schemaVersion !== PROJECTION_PLAN_STORE_V2_SCHEMA_VERSION
    || !isPlainObject(value.records)) {
    throw new TypeError('projection plan store has an invalid envelope')
  }
  const entries = Object.entries(value.records)
  if (entries.length > MAX_STORED_PROJECTION_PLANS_V2) {
    throw new TypeError('projection plan store has too many records')
  }

  const records = new Map<string, ProjectionPlanRecordV2>()
  for (const [storedPlanId, candidate] of entries) {
    const planId = parseProjectionPlanId(storedPlanId)
    const record = inspectRecord(candidate)
    if (record.plan.planId !== planId) {
      throw new TypeError(`projection plan record key does not match plan: ${planId}`)
    }
    records.set(planId, record)
  }
  return records
}

function inspectRecord(value: unknown): ProjectionPlanRecordV2 {
  if (!isExactRecord(value, ['state', 'createdAt', 'updatedAt', 'plan', 'suggestedActions'])
    || (value.state !== 'pending' && value.state !== 'dismissed')) {
    throw new TypeError('projection plan record has an invalid envelope')
  }
  assertTimestamp(value.createdAt, 'createdAt')
  assertTimestamp(value.updatedAt, 'updatedAt')
  if (value.updatedAt < value.createdAt) {
    throw new TypeError('updatedAt cannot be earlier than createdAt')
  }
  const inspection = inspectProjectionPlanV2(value.plan)
  if (inspection.status !== 'valid') {
    throw new TypeError(`stored projection plan is invalid: ${inspection.reason}`)
  }
  const actionInspection = inspectRunOutcomeV2({
    schemaVersion: 2,
    suggestedActions: value.suggestedActions,
    outputs: [],
    taskProposals: [],
  })
  if (actionInspection.status !== 'valid') {
    throw new TypeError('stored projection plan suggestedActions are invalid')
  }
  if (inspection.plan.status === 'partial'
    && actionInspection.outcome.suggestedActions.length > 0) {
    throw new TypeError('partial projection plan retains suggestedActions')
  }
  return {
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    plan: inspection.plan,
    suggestedActions: actionInspection.outcome.suggestedActions,
  }
}

function serializeStore(records: ReadonlyMap<string, ProjectionPlanRecordV2>): string {
  if (records.size > MAX_STORED_PROJECTION_PLANS_V2) {
    throw new TypeError('projection plan store has too many records')
  }
  const stored: Record<string, ProjectionPlanRecordV2> = Object.create(null) as Record<
    string,
    ProjectionPlanRecordV2
  >
  for (const [planId, record] of [...records.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    const parsedPlanId = parseProjectionPlanId(planId)
    const inspected = inspectRecord(record)
    if (inspected.plan.planId !== parsedPlanId) {
      throw new TypeError(`projection plan record key does not match plan: ${planId}`)
    }
    stored[parsedPlanId] = inspected
  }
  const source = `${JSON.stringify({
    schemaVersion: PROJECTION_PLAN_STORE_V2_SCHEMA_VERSION,
    records: stored,
  }, null, 2)}\n`
  if (Buffer.byteLength(source, 'utf8') > MAX_PROJECTION_PLAN_STORE_BYTES_V2) {
    throw new TypeError('projection plan store exceeds the supported size')
  }
  return source
}

function parseProjectionPlanId(value: unknown): string {
  if (typeof value !== 'string' || !/^plan_[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('planId is invalid')
  }
  return value
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
}

function cloneCreatedResult(
  built: BuildProjectionPlanV2Result,
  record: ProjectionPlanRecordV2,
): CreatedProjectionPlanV2 {
  return structuredClone({ ...built, record })
}

function cloneRecord(record: ProjectionPlanRecordV2): ProjectionPlanRecordV2 {
  return structuredClone(record)
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
    if (!status.isFile()) throw new TypeError('projection plan store must be a regular file')
    if (status.size > MAX_PROJECTION_PLAN_STORE_BYTES_V2) {
      throw new TypeError('projection plan store exceeds the supported size')
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}
