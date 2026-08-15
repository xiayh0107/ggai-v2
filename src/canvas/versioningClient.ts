import { parseCanvasDocument, type CanvasDocument } from './model'

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

export type CanvasVersioningStatus =
  | { state: 'uninitialized'; initialized: false; gitAvailable: true }
  | { state: 'ready'; initialized: true; gitAvailable: true }
  | {
      state: 'degraded'
      initialized: boolean
      gitAvailable: boolean
      reason: string
    }

export interface CanvasVersioningStatuses {
  versioning: CanvasVersioningStatus
}

export interface CanvasVersionEnvelope {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  lastCheckpoint: string | null
  document: CanvasDocument
}

export interface CanvasWorktree {
  id: string
  path: string
  branch: string | null
  commit: string
  locked: boolean
  lockReason?: string
  prunable: boolean
  managed: boolean
}

export interface CanvasVersionBranch {
  name: string
  commit: string
  worktree: CanvasWorktree | null
}

export interface CanvasHistoryEntry {
  commit: string
  parents: string[]
  committedAt: string
  subject: string
}

export interface CanvasHistoryPage {
  entries: CanvasHistoryEntry[]
  nextCursor: string | null
}

export interface CanvasCheckpointResult {
  branch: string
  commit: string
  changed: boolean
  status: Extract<CanvasVersioningStatus, { state: 'ready' }>
}

export interface CanvasWorkspaceCheckpoint {
  canvas: CanvasVersionEnvelope
  checkpoint: CanvasCheckpointResult
}

export interface CanvasWorkspaceBranch {
  branch: CanvasVersionBranch
  canvas: CanvasVersionEnvelope
}

export type CanvasMergeState = 'ready' | 'conflicts' | 'up-to-date'
export type CanvasMergeConflictKind =
  | 'content'
  | 'add-add'
  | 'modify-delete'
  | 'delete-modify'
  | 'unknown'

export interface CanvasMergeConflict {
  path: string
  kind: CanvasMergeConflictKind
  stages: { base: boolean; ours: boolean; theirs: boolean }
}

export interface CanvasMergeResolutionProposal {
  schemaVersion: 1
  generatedBy: string
  rationale?: string
  resolutions: Array<{
    path: string
    choice: 'ours' | 'theirs' | 'custom'
    content?: string
    rationale?: string
  }>
}

export interface CanvasMergeResolutionState {
  requiresExplicitApproval: true
  proposal?: CanvasMergeResolutionProposal
}

export interface CanvasMergePreviewCanvas {
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
  targetCommit: string
  baseCommit: string | null
  state: CanvasMergeState
  changed: boolean
  paths: string[]
  conflicts: CanvasMergeConflict[]
  resolution?: CanvasMergeResolutionState
}

export interface CanvasMergeExpectation {
  sourceCommit: string
  targetCommit: string
  sourceRevision: number
  targetRevision: number
}

export interface CanvasWorkspaceMergePreview {
  state: CanvasMergeState
  canvas: CanvasMergePreviewCanvas
  expectation: CanvasMergeExpectation
}

export interface CanvasMergeExecutionCanvas extends CanvasMergePreviewCanvas {
  merged: boolean
  commit: string
}

export interface CanvasWorkspaceMergeExecution {
  state: 'merged' | 'conflicts' | 'up-to-date' | 'partial'
  canvas: CanvasMergeExecutionCanvas
  canvasEnvelope?: CanvasVersionEnvelope
}

export interface CanvasOperationError {
  code: string
  message: string
}

export type CanvasWorkspaceOperationResult<Value> =
  | {
      ok: true
      partial: false
      value: Value
      versioning: CanvasVersioningStatus
    }
  | {
      ok: false
      partial: boolean
      error: CanvasOperationError
      value?: Value
      versioning: CanvasVersioningStatus
    }

export interface CanvasVersioningScope {
  projectDir: string
}

export interface CanvasVersioningClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

export class CanvasVersioningClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CanvasVersioningClientError'
  }
}

export class CanvasVersioningProtocolError extends CanvasVersioningClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CanvasVersioningProtocolError'
  }
}

export class CanvasVersioningHttpError extends CanvasVersioningClientError {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CanvasVersioningHttpError'
    this.status = status
    this.code = code
  }
}

export class CanvasVersioningClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: CanvasVersioningClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    const fetchImplementation = options.fetch
      ?? (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : undefined)
    if (!fetchImplementation) throw new CanvasVersioningClientError('Fetch is unavailable')
    this.#fetch = fetchImplementation
  }

  async status(scope: CanvasVersioningScope): Promise<CanvasVersioningStatuses> {
    return parseStatuses(await this.#request('GET', '/canvas/status', scope))
  }

  async listBranches(
    scope: CanvasVersioningScope,
  ): Promise<CanvasWorkspaceOperationResult<CanvasVersionBranch[]>> {
    return parseOperation(
      await this.#request('GET', '/canvas/branches', scope),
      (value) => parseArray(value, parseBranch, 10_000, 'branch list'),
    )
  }

  async history(
    scope: CanvasVersioningScope,
    input: { branch: string; cursor?: string; limit?: number },
  ): Promise<CanvasWorkspaceOperationResult<CanvasHistoryPage>> {
    const branch = assertBranch(input.branch)
    const search = new URLSearchParams({ branch })
    if (input.cursor !== undefined) search.set('cursor', assertCommit(input.cursor))
    if (input.limit !== undefined) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new CanvasVersioningClientError('History limit must be between 1 and 100')
      }
      search.set('limit', String(input.limit))
    }
    return parseOperation(
      await this.#request('GET', `/canvas/history?${search}`, scope),
      parseHistoryPage,
    )
  }

  async createBranch(
    scope: CanvasVersioningScope,
    input: { name: string; fromBranch?: string },
  ): Promise<CanvasWorkspaceOperationResult<CanvasWorkspaceBranch>> {
    const body = {
      name: assertBranch(input.name),
      ...(input.fromBranch === undefined ? {} : { fromBranch: assertBranch(input.fromBranch) }),
    }
    return parseOperation(
      await this.#request('POST', '/canvas/branches', scope, body),
      parseWorkspaceBranch,
    )
  }

  async checkpoint(
    scope: CanvasVersioningScope,
    input: { branch: string; reason?: string },
  ): Promise<CanvasWorkspaceOperationResult<CanvasWorkspaceCheckpoint>> {
    const reason = input.reason?.trim()
    if (reason !== undefined && reason.length > 500) {
      throw new CanvasVersioningClientError('Checkpoint reason is too long')
    }
    return parseOperation(
      await this.#request('POST', '/canvas/checkpoints', scope, {
        branch: assertBranch(input.branch),
        ...(reason ? { reason } : {}),
      }),
      parseWorkspaceCheckpoint,
    )
  }

  async restoreAsNewBranch(
    scope: CanvasVersioningScope,
    input: { sourceBranch: string; newBranch: string; checkpoint: string },
  ): Promise<CanvasWorkspaceOperationResult<CanvasWorkspaceBranch>> {
    return parseOperation(
      await this.#request('POST', '/canvas/restores', scope, {
        sourceBranch: assertBranch(input.sourceBranch),
        newBranch: assertBranch(input.newBranch),
        checkpoint: assertCommit(input.checkpoint),
      }),
      parseWorkspaceBranch,
    )
  }

  async previewMerge(
    scope: CanvasVersioningScope,
    input: { sourceBranch: string; targetBranch: string },
  ): Promise<CanvasWorkspaceOperationResult<CanvasWorkspaceMergePreview>> {
    return parseOperation(
      await this.#request('POST', '/canvas/merges/preview', scope, {
        sourceBranch: assertBranch(input.sourceBranch),
        targetBranch: assertBranch(input.targetBranch),
      }),
      parseWorkspaceMergePreview,
    )
  }

  async executeMerge(
    scope: CanvasVersioningScope,
    input: {
      sourceBranch: string
      targetBranch: string
      confirmed: true
      expected: CanvasMergeExpectation
    },
  ): Promise<CanvasWorkspaceOperationResult<CanvasWorkspaceMergeExecution>> {
    if (input.confirmed !== true) {
      throw new CanvasVersioningClientError('Merge execution requires explicit confirmation')
    }
    return parseOperation(
      await this.#request('POST', '/canvas/merges', scope, {
        sourceBranch: assertBranch(input.sourceBranch),
        targetBranch: assertBranch(input.targetBranch),
        confirmed: true,
        expected: parseMergeExpectation(input.expected),
      }),
      parseWorkspaceMergeExecution,
    )
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    scope: CanvasVersioningScope,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!scope.projectDir.trim()) {
      throw new CanvasVersioningClientError('Versioning scope requires projectDir')
    }
    const url = new URL(path, `${this.#baseUrl}/`)
    if (method === 'GET') url.searchParams.set('projectDir', scope.projectDir)
    const requestBody = body === undefined ? undefined : { projectDir: scope.projectDir, ...body }
    const response = await this.#fetch(url, {
      method,
      headers: requestBody === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
    })
    if (!response.ok) throw await decodeHttpError(response, `${method} ${url.pathname}`)
    try {
      return await response.json()
    } catch (error) {
      throw new CanvasVersioningProtocolError(
        `${method} ${url.pathname} response is not valid JSON`,
        { cause: error },
      )
    }
  }
}

function parseStatuses(value: unknown): CanvasVersioningStatuses {
  assertExact(value, ['versioning'], 'versioning status response')
  return { versioning: parseStatus(value.versioning) }
}

function parseOperation<Value>(
  value: unknown,
  parseValue: (value: unknown) => Value,
): CanvasWorkspaceOperationResult<Value> {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || typeof value.partial !== 'boolean') {
    throw protocol('workspace operation response')
  }
  if (value.ok) {
    assertExact(value, ['ok', 'partial', 'value', 'versioning'], 'workspace operation response')
    if (value.partial !== false) throw protocol('successful workspace operation')
    return {
      ok: true,
      partial: false,
      value: parseValue(value.value),
      versioning: parseStatus(value.versioning),
    }
  }
  assertExactOptional(
    value,
    ['ok', 'partial', 'error', 'versioning'],
    ['value'],
    'workspace operation response',
  )
  assertExact(value.error, ['code', 'message'], 'workspace operation error')
  const error = {
    code: nonEmptyString(value.error.code, 'workspace operation error code', 200),
    message: nonEmptyString(value.error.message, 'workspace operation error message', 20_000),
  }
  return {
    ok: false,
    partial: value.partial,
    error,
    ...(Object.hasOwn(value, 'value') ? { value: parseValue(value.value) } : {}),
    versioning: parseStatus(value.versioning),
  }
}

function parseStatus(value: unknown): CanvasVersioningStatus {
  if (!isRecord(value) || typeof value.state !== 'string') throw protocol('versioning status')
  if (value.state === 'uninitialized') {
    assertExact(value, ['state', 'initialized', 'gitAvailable'], 'versioning status')
    if (value.initialized !== false || value.gitAvailable !== true) throw protocol('versioning status')
    return { state: 'uninitialized', initialized: false, gitAvailable: true }
  }
  if (value.state === 'ready') {
    assertExact(value, ['state', 'initialized', 'gitAvailable'], 'versioning status')
    if (value.initialized !== true || value.gitAvailable !== true) throw protocol('versioning status')
    return { state: 'ready', initialized: true, gitAvailable: true }
  }
  if (value.state === 'degraded') {
    assertExact(value, ['state', 'initialized', 'gitAvailable', 'reason'], 'versioning status')
    if (typeof value.initialized !== 'boolean' || typeof value.gitAvailable !== 'boolean') {
      throw protocol('versioning status')
    }
    return {
      state: 'degraded',
      initialized: value.initialized,
      gitAvailable: value.gitAvailable,
      reason: nonEmptyString(value.reason, 'versioning degradation reason', 20_000),
    }
  }
  throw protocol('versioning status')
}

function parseVersionEnvelope(value: unknown): CanvasVersionEnvelope {
  assertExact(value, [
    'branch', 'revision', 'updatedAt', 'lastMutationId', 'lastCheckpoint', 'document',
  ], 'Canvas version envelope')
  const lastMutationId = nullableString(value.lastMutationId, 'last mutation id', 500)
  const lastCheckpoint = nullableCommit(value.lastCheckpoint, 'last checkpoint')
  return {
    branch: assertBranch(value.branch),
    revision: revision(value.revision, 'canvas revision'),
    updatedAt: dateString(value.updatedAt, 'canvas updatedAt'),
    lastMutationId,
    lastCheckpoint,
    document: parseDocument(value.document),
  }
}

function parseWorktree(value: unknown): CanvasWorktree {
  assertExactOptional(
    value,
    ['id', 'path', 'branch', 'commit', 'locked', 'prunable', 'managed'],
    ['lockReason'],
    'Canvas worktree',
  )
  return {
    id: nonEmptyString(value.id, 'worktree id', 1_000),
    path: nonEmptyString(value.path, 'worktree path', 20_000),
    branch: value.branch === null ? null : assertBranch(value.branch),
    commit: assertCommit(value.commit),
    locked: boolean(value.locked, 'worktree locked'),
    ...(Object.hasOwn(value, 'lockReason')
      ? { lockReason: nonEmptyString(value.lockReason, 'worktree lock reason', 20_000) }
      : {}),
    prunable: boolean(value.prunable, 'worktree prunable'),
    managed: boolean(value.managed, 'worktree managed'),
  }
}

function parseBranch(value: unknown): CanvasVersionBranch {
  assertExact(value, ['name', 'commit', 'worktree'], 'Canvas branch')
  return {
    name: assertBranch(value.name),
    commit: assertCommit(value.commit),
    worktree: value.worktree === null ? null : parseWorktree(value.worktree),
  }
}

function parseHistoryPage(value: unknown): CanvasHistoryPage {
  assertExact(value, ['entries', 'nextCursor'], 'Canvas history page')
  return {
    entries: parseArray(value.entries, parseHistoryEntry, 200, 'history entries'),
    nextCursor: nullableCommit(value.nextCursor, 'history cursor'),
  }
}

function parseHistoryEntry(value: unknown): CanvasHistoryEntry {
  assertExact(value, ['commit', 'parents', 'committedAt', 'subject'], 'Canvas history entry')
  return {
    commit: assertCommit(value.commit),
    parents: parseArray(value.parents, assertCommit, 16, 'history parents'),
    committedAt: dateString(value.committedAt, 'history committedAt'),
    subject: nonEmptyString(value.subject, 'history subject', 10_000),
  }
}

function parseCheckpoint(value: unknown): CanvasCheckpointResult {
  assertExact(value, ['branch', 'commit', 'changed', 'status'], 'Canvas checkpoint')
  const status = parseStatus(value.status)
  if (status.state !== 'ready') throw protocol('checkpoint status')
  return {
    branch: assertBranch(value.branch),
    commit: assertCommit(value.commit),
    changed: boolean(value.changed, 'checkpoint changed'),
    status,
  }
}

function parseWorkspaceCheckpoint(value: unknown): CanvasWorkspaceCheckpoint {
  assertExact(value, ['canvas', 'checkpoint'], 'Canvas workspace checkpoint')
  return { canvas: parseVersionEnvelope(value.canvas), checkpoint: parseCheckpoint(value.checkpoint) }
}

function parseWorkspaceBranch(value: unknown): CanvasWorkspaceBranch {
  assertExact(value, ['branch', 'canvas'], 'Canvas workspace branch')
  return { branch: parseBranch(value.branch), canvas: parseVersionEnvelope(value.canvas) }
}

function parseMergeExpectation(value: unknown): CanvasMergeExpectation {
  assertExact(
    value,
    ['sourceCommit', 'targetCommit', 'sourceRevision', 'targetRevision'],
    'Canvas merge expectation',
  )
  return {
    sourceCommit: assertCommit(value.sourceCommit),
    targetCommit: assertCommit(value.targetCommit),
    sourceRevision: revision(value.sourceRevision, 'source revision'),
    targetRevision: revision(value.targetRevision, 'target revision'),
  }
}

function parseMergeConflict(value: unknown): CanvasMergeConflict {
  assertExact(value, ['path', 'kind', 'stages'], 'Canvas merge conflict')
  const kinds: CanvasMergeConflictKind[] = [
    'content', 'add-add', 'modify-delete', 'delete-modify', 'unknown',
  ]
  if (!kinds.includes(value.kind as CanvasMergeConflictKind)) throw protocol('merge conflict kind')
  assertExact(value.stages, ['base', 'ours', 'theirs'], 'Canvas merge conflict stages')
  return {
    path: nonEmptyString(value.path, 'merge conflict path', 20_000),
    kind: value.kind as CanvasMergeConflictKind,
    stages: {
      base: boolean(value.stages.base, 'merge conflict base stage'),
      ours: boolean(value.stages.ours, 'merge conflict ours stage'),
      theirs: boolean(value.stages.theirs, 'merge conflict theirs stage'),
    },
  }
}

function parseMergeResolution(value: unknown): CanvasMergeResolutionState {
  assertExactOptional(value, ['requiresExplicitApproval'], ['proposal'], 'merge resolution state')
  if (value.requiresExplicitApproval !== true) throw protocol('merge resolution state')
  return {
    requiresExplicitApproval: true,
    ...(Object.hasOwn(value, 'proposal') ? { proposal: parseMergeProposal(value.proposal) } : {}),
  }
}

function parseMergeProposal(value: unknown): CanvasMergeResolutionProposal {
  assertExactOptional(
    value,
    ['schemaVersion', 'generatedBy', 'resolutions'],
    ['rationale'],
    'merge resolution proposal',
  )
  if (value.schemaVersion !== 1) throw protocol('merge resolution proposal schema')
  return {
    schemaVersion: 1,
    generatedBy: nonEmptyString(value.generatedBy, 'proposal generator', 1_000),
    ...(Object.hasOwn(value, 'rationale')
      ? { rationale: nonEmptyString(value.rationale, 'proposal rationale', 20_000) }
      : {}),
    resolutions: parseArray(value.resolutions, parseMergeResolutionItem, 20_000, 'resolutions'),
  }
}

function parseMergeResolutionItem(value: unknown): CanvasMergeResolutionProposal['resolutions'][number] {
  assertExactOptional(value, ['path', 'choice'], ['content', 'rationale'], 'merge resolution item')
  if (value.choice !== 'ours' && value.choice !== 'theirs' && value.choice !== 'custom') {
    throw protocol('merge resolution choice')
  }
  if (value.choice === 'custom' && typeof value.content !== 'string') {
    throw protocol('custom merge resolution content')
  }
  if (value.choice !== 'custom' && Object.hasOwn(value, 'content')) {
    throw protocol('non-custom merge resolution content')
  }
  return {
    path: nonEmptyString(value.path, 'merge resolution path', 20_000),
    choice: value.choice,
    ...(Object.hasOwn(value, 'content')
      ? { content: string(value.content, 'merge resolution content', 2_000_000) }
      : {}),
    ...(Object.hasOwn(value, 'rationale')
      ? { rationale: nonEmptyString(value.rationale, 'merge resolution rationale', 20_000) }
      : {}),
  }
}

function parseMergePreviewCanvas(value: unknown): CanvasMergePreviewCanvas {
  assertExactOptional(
    value,
    [
      'sourceBranch', 'targetBranch', 'sourceCommit', 'targetCommit', 'baseCommit',
      'state', 'changed', 'paths', 'conflicts',
    ],
    ['resolution'],
    'Canvas merge preview',
  )
  if (value.state !== 'ready' && value.state !== 'conflicts' && value.state !== 'up-to-date') {
    throw protocol('merge state')
  }
  return {
    sourceBranch: assertBranch(value.sourceBranch),
    targetBranch: assertBranch(value.targetBranch),
    sourceCommit: assertCommit(value.sourceCommit),
    targetCommit: assertCommit(value.targetCommit),
    baseCommit: nullableCommit(value.baseCommit, 'merge base commit'),
    state: value.state,
    changed: boolean(value.changed, 'merge changed'),
    paths: parseArray(
      value.paths,
      (entry) => nonEmptyString(entry, 'merge path', 20_000),
      50_000,
      'merge paths',
    ),
    conflicts: parseArray(value.conflicts, parseMergeConflict, 50_000, 'merge conflicts'),
    ...(Object.hasOwn(value, 'resolution')
      ? { resolution: parseMergeResolution(value.resolution) }
      : {}),
  }
}

function parseWorkspaceMergePreview(value: unknown): CanvasWorkspaceMergePreview {
  assertExact(value, ['state', 'canvas', 'expectation'], 'Canvas workspace merge preview')
  const canvas = parseMergePreviewCanvas(value.canvas)
  if (value.state !== canvas.state) throw protocol('workspace merge preview state')
  return { state: canvas.state, canvas, expectation: parseMergeExpectation(value.expectation) }
}

function parseWorkspaceMergeExecution(value: unknown): CanvasWorkspaceMergeExecution {
  assertExactOptional(value, ['state', 'canvas'], ['canvasEnvelope'], 'Canvas merge execution')
  const states = ['merged', 'conflicts', 'up-to-date', 'partial'] as const
  if (!states.includes(value.state as typeof states[number])) throw protocol('merge execution state')
  assertExactOptional(
    value.canvas,
    [
      'sourceBranch', 'targetBranch', 'sourceCommit', 'targetCommit', 'baseCommit',
      'state', 'changed', 'paths', 'conflicts', 'merged', 'commit',
    ],
    ['resolution'],
    'Canvas merge execution canvas',
  )
  const { merged, commit, ...previewValue } = value.canvas
  const preview = parseMergePreviewCanvas(previewValue)
  return {
    state: value.state as typeof states[number],
    canvas: {
      ...preview,
      merged: boolean(merged, 'merge execution merged'),
      commit: assertCommit(commit),
    },
    ...(Object.hasOwn(value, 'canvasEnvelope')
      ? { canvasEnvelope: parseVersionEnvelope(value.canvasEnvelope) }
      : {}),
  }
}

function parseDocument(value: unknown): CanvasDocument {
  try {
    return parseCanvasDocument(value)
  } catch (error) {
    throw new CanvasVersioningProtocolError('Canvas version document is invalid', { cause: error })
  }
}

function parseArray<Value>(
  value: unknown,
  parse: (value: unknown) => Value,
  maximum: number,
  context: string,
): Value[] {
  if (!Array.isArray(value) || value.length > maximum) throw protocol(context)
  return value.map(parse)
}

function assertBranch(value: unknown): string {
  const branch = nonEmptyString(value, 'Canvas branch', 120)
  const segments = branch.split('/')
  if (!BRANCH_PATTERN.test(branch)
    || branch.includes('..')
    || branch.includes('//')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.endsWith('.lock')
    || segments.some((segment) => segment === '.' || segment.endsWith('.'))) {
    throw new CanvasVersioningClientError('Canvas branch is invalid')
  }
  return branch
}

function assertCommit(value: unknown): string {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw protocol('Canvas commit')
  }
  return value
}

function nullableCommit(value: unknown, context: string): string | null {
  if (value === null) return null
  try {
    return assertCommit(value)
  } catch (error) {
    throw new CanvasVersioningProtocolError(`${context} is invalid`, { cause: error })
  }
}

function revision(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocol(context)
  return value as number
}

function dateString(value: unknown, context: string): string {
  const result = nonEmptyString(value, context, 100)
  if (!Number.isFinite(Date.parse(result))) throw protocol(context)
  return result
}

function nullableString(value: unknown, context: string, maximum: number): string | null {
  return value === null ? null : string(value, context, maximum)
}

function nonEmptyString(value: unknown, context: string, maximum: number): string {
  const result = string(value, context, maximum)
  if (!result) throw protocol(context)
  return result
}

function string(value: unknown, context: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) throw protocol(context)
  return value
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw protocol(context)
  return value
}

function assertExact(
  value: unknown,
  keys: readonly string[],
  context: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) throw protocol(context)
}

function assertExactOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  context: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw protocol(context)
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) throw protocol(context)
}

function protocol(context: string): CanvasVersioningProtocolError {
  return new CanvasVersioningProtocolError(`${context} is invalid`)
}

async function decodeHttpError(
  response: Response,
  operation: string,
): Promise<CanvasVersioningHttpError> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    value = null
  }
  const error = isRecord(value) && isRecord(value.error) ? value.error : null
  return new CanvasVersioningHttpError(
    response.status,
    error && typeof error.code === 'string' ? error.code : `http_${response.status}`,
    error && typeof error.message === 'string'
      ? error.message
      : `${operation} failed with HTTP ${response.status}`,
  )
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '')
  if (!normalized) throw new CanvasVersioningClientError('baseUrl is required')
  try {
    return new URL(normalized).toString().replace(/\/$/u, '')
  } catch (error) {
    throw new CanvasVersioningClientError('baseUrl is invalid', { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
