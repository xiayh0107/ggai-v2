import { parseCanvasDocumentV2, type CanvasDocumentV2 } from './model'

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u

export type CanvasV2VersioningStatus =
  | { state: 'uninitialized'; initialized: false; gitAvailable: true }
  | { state: 'ready'; initialized: true; gitAvailable: true }
  | {
      state: 'degraded'
      initialized: boolean
      gitAvailable: boolean
      reason: string
    }

export interface CanvasV2VersioningStatuses {
  versioning: CanvasV2VersioningStatus
}

export interface CanvasV2VersionEnvelope {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  lastCheckpoint: string | null
  document: CanvasDocumentV2
}

export interface CanvasV2Worktree {
  id: string
  path: string
  branch: string | null
  commit: string
  locked: boolean
  lockReason?: string
  prunable: boolean
  managed: boolean
}

export interface CanvasV2VersionBranch {
  name: string
  commit: string
  worktree: CanvasV2Worktree | null
}

export interface CanvasV2HistoryEntry {
  commit: string
  parents: string[]
  committedAt: string
  subject: string
}

export interface CanvasV2HistoryPage {
  entries: CanvasV2HistoryEntry[]
  nextCursor: string | null
}

export interface CanvasV2CheckpointResult {
  branch: string
  commit: string
  changed: boolean
  status: Extract<CanvasV2VersioningStatus, { state: 'ready' }>
}

export interface CanvasV2WorkspaceCheckpoint {
  canvas: CanvasV2VersionEnvelope
  checkpoint: CanvasV2CheckpointResult
}

export interface CanvasV2WorkspaceBranch {
  branch: CanvasV2VersionBranch
  canvas: CanvasV2VersionEnvelope
}

export type CanvasV2MergeState = 'ready' | 'conflicts' | 'up-to-date'
export type CanvasV2MergeConflictKind =
  | 'content'
  | 'add-add'
  | 'modify-delete'
  | 'delete-modify'
  | 'unknown'

export interface CanvasV2MergeConflict {
  path: string
  kind: CanvasV2MergeConflictKind
  stages: { base: boolean; ours: boolean; theirs: boolean }
}

export interface CanvasV2MergeResolutionProposal {
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

export interface CanvasV2MergeResolutionState {
  requiresExplicitApproval: true
  proposal?: CanvasV2MergeResolutionProposal
}

export interface CanvasV2MergePreviewCanvas {
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
  targetCommit: string
  baseCommit: string | null
  state: CanvasV2MergeState
  changed: boolean
  paths: string[]
  conflicts: CanvasV2MergeConflict[]
  resolution?: CanvasV2MergeResolutionState
}

export interface CanvasV2MergeExpectation {
  sourceCommit: string
  targetCommit: string
  sourceRevision: number
  targetRevision: number
}

export interface CanvasV2WorkspaceMergePreview {
  state: CanvasV2MergeState
  canvas: CanvasV2MergePreviewCanvas
  expectation: CanvasV2MergeExpectation
}

export interface CanvasV2MergeExecutionCanvas extends CanvasV2MergePreviewCanvas {
  merged: boolean
  commit: string
}

export interface CanvasV2WorkspaceMergeExecution {
  state: 'merged' | 'conflicts' | 'up-to-date' | 'partial'
  canvas: CanvasV2MergeExecutionCanvas
  canvasEnvelope?: CanvasV2VersionEnvelope
}

export interface CanvasV2OperationError {
  code: string
  message: string
}

export type CanvasV2WorkspaceOperationResult<Value> =
  | {
      ok: true
      partial: false
      value: Value
      versioning: CanvasV2VersioningStatus
    }
  | {
      ok: false
      partial: boolean
      error: CanvasV2OperationError
      value?: Value
      versioning: CanvasV2VersioningStatus
    }

export interface CanvasV2VersioningScope {
  projectDir: string
}

export interface CanvasV2VersioningClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

export class CanvasV2VersioningClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CanvasV2VersioningClientError'
  }
}

export class CanvasV2VersioningProtocolError extends CanvasV2VersioningClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CanvasV2VersioningProtocolError'
  }
}

export class CanvasV2VersioningHttpError extends CanvasV2VersioningClientError {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CanvasV2VersioningHttpError'
    this.status = status
    this.code = code
  }
}

export class CanvasV2VersioningClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: CanvasV2VersioningClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    const fetchImplementation = options.fetch ?? globalThis.fetch
    if (!fetchImplementation) throw new CanvasV2VersioningClientError('Fetch is unavailable')
    this.#fetch = fetchImplementation
  }

  async status(scope: CanvasV2VersioningScope): Promise<CanvasV2VersioningStatuses> {
    return parseStatuses(await this.#request('GET', '/canvas/status', scope))
  }

  async listBranches(
    scope: CanvasV2VersioningScope,
  ): Promise<CanvasV2WorkspaceOperationResult<CanvasV2VersionBranch[]>> {
    return parseOperation(
      await this.#request('GET', '/canvas/branches', scope),
      (value) => parseArray(value, parseBranch, 10_000, 'branch list'),
    )
  }

  async history(
    scope: CanvasV2VersioningScope,
    input: { branch: string; cursor?: string; limit?: number },
  ): Promise<CanvasV2WorkspaceOperationResult<CanvasV2HistoryPage>> {
    const branch = assertBranch(input.branch)
    const search = new URLSearchParams({ branch })
    if (input.cursor !== undefined) search.set('cursor', assertCommit(input.cursor))
    if (input.limit !== undefined) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new CanvasV2VersioningClientError('History limit must be between 1 and 100')
      }
      search.set('limit', String(input.limit))
    }
    return parseOperation(
      await this.#request('GET', `/canvas/history?${search}`, scope),
      parseHistoryPage,
    )
  }

  async createBranch(
    scope: CanvasV2VersioningScope,
    input: { name: string; fromBranch?: string },
  ): Promise<CanvasV2WorkspaceOperationResult<CanvasV2WorkspaceBranch>> {
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
    scope: CanvasV2VersioningScope,
    input: { branch: string; reason?: string },
  ): Promise<CanvasV2WorkspaceOperationResult<CanvasV2WorkspaceCheckpoint>> {
    const reason = input.reason?.trim()
    if (reason !== undefined && reason.length > 500) {
      throw new CanvasV2VersioningClientError('Checkpoint reason is too long')
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
    scope: CanvasV2VersioningScope,
    input: { sourceBranch: string; newBranch: string; checkpoint: string },
  ): Promise<CanvasV2WorkspaceOperationResult<CanvasV2WorkspaceBranch>> {
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
    scope: CanvasV2VersioningScope,
    input: { sourceBranch: string; targetBranch: string },
  ): Promise<CanvasV2WorkspaceOperationResult<CanvasV2WorkspaceMergePreview>> {
    return parseOperation(
      await this.#request('POST', '/canvas/merges/preview', scope, {
        sourceBranch: assertBranch(input.sourceBranch),
        targetBranch: assertBranch(input.targetBranch),
      }),
      parseWorkspaceMergePreview,
    )
  }

  async executeMerge(
    scope: CanvasV2VersioningScope,
    input: {
      sourceBranch: string
      targetBranch: string
      confirmed: true
      expected: CanvasV2MergeExpectation
    },
  ): Promise<CanvasV2WorkspaceOperationResult<CanvasV2WorkspaceMergeExecution>> {
    if (input.confirmed !== true) {
      throw new CanvasV2VersioningClientError('Merge execution requires explicit confirmation')
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
    scope: CanvasV2VersioningScope,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!scope.projectDir.trim()) {
      throw new CanvasV2VersioningClientError('Versioning scope requires projectDir')
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
      throw new CanvasV2VersioningProtocolError(
        `${method} ${url.pathname} response is not valid JSON`,
        { cause: error },
      )
    }
  }
}

function parseStatuses(value: unknown): CanvasV2VersioningStatuses {
  assertExact(value, ['versioning'], 'versioning status response')
  return { versioning: parseStatus(value.versioning) }
}

function parseOperation<Value>(
  value: unknown,
  parseValue: (value: unknown) => Value,
): CanvasV2WorkspaceOperationResult<Value> {
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

function parseStatus(value: unknown): CanvasV2VersioningStatus {
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

function parseVersionEnvelope(value: unknown): CanvasV2VersionEnvelope {
  assertExact(value, [
    'branch', 'revision', 'updatedAt', 'lastMutationId', 'lastCheckpoint', 'document',
  ], 'Canvas V2 version envelope')
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

function parseWorktree(value: unknown): CanvasV2Worktree {
  assertExactOptional(
    value,
    ['id', 'path', 'branch', 'commit', 'locked', 'prunable', 'managed'],
    ['lockReason'],
    'Canvas V2 worktree',
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

function parseBranch(value: unknown): CanvasV2VersionBranch {
  assertExact(value, ['name', 'commit', 'worktree'], 'Canvas V2 branch')
  return {
    name: assertBranch(value.name),
    commit: assertCommit(value.commit),
    worktree: value.worktree === null ? null : parseWorktree(value.worktree),
  }
}

function parseHistoryPage(value: unknown): CanvasV2HistoryPage {
  assertExact(value, ['entries', 'nextCursor'], 'Canvas V2 history page')
  return {
    entries: parseArray(value.entries, parseHistoryEntry, 200, 'history entries'),
    nextCursor: nullableCommit(value.nextCursor, 'history cursor'),
  }
}

function parseHistoryEntry(value: unknown): CanvasV2HistoryEntry {
  assertExact(value, ['commit', 'parents', 'committedAt', 'subject'], 'Canvas V2 history entry')
  return {
    commit: assertCommit(value.commit),
    parents: parseArray(value.parents, assertCommit, 16, 'history parents'),
    committedAt: dateString(value.committedAt, 'history committedAt'),
    subject: nonEmptyString(value.subject, 'history subject', 10_000),
  }
}

function parseCheckpoint(value: unknown): CanvasV2CheckpointResult {
  assertExact(value, ['branch', 'commit', 'changed', 'status'], 'Canvas V2 checkpoint')
  const status = parseStatus(value.status)
  if (status.state !== 'ready') throw protocol('checkpoint status')
  return {
    branch: assertBranch(value.branch),
    commit: assertCommit(value.commit),
    changed: boolean(value.changed, 'checkpoint changed'),
    status,
  }
}

function parseWorkspaceCheckpoint(value: unknown): CanvasV2WorkspaceCheckpoint {
  assertExact(value, ['canvas', 'checkpoint'], 'Canvas V2 workspace checkpoint')
  return { canvas: parseVersionEnvelope(value.canvas), checkpoint: parseCheckpoint(value.checkpoint) }
}

function parseWorkspaceBranch(value: unknown): CanvasV2WorkspaceBranch {
  assertExact(value, ['branch', 'canvas'], 'Canvas V2 workspace branch')
  return { branch: parseBranch(value.branch), canvas: parseVersionEnvelope(value.canvas) }
}

function parseMergeExpectation(value: unknown): CanvasV2MergeExpectation {
  assertExact(
    value,
    ['sourceCommit', 'targetCommit', 'sourceRevision', 'targetRevision'],
    'Canvas V2 merge expectation',
  )
  return {
    sourceCommit: assertCommit(value.sourceCommit),
    targetCommit: assertCommit(value.targetCommit),
    sourceRevision: revision(value.sourceRevision, 'source revision'),
    targetRevision: revision(value.targetRevision, 'target revision'),
  }
}

function parseMergeConflict(value: unknown): CanvasV2MergeConflict {
  assertExact(value, ['path', 'kind', 'stages'], 'Canvas V2 merge conflict')
  const kinds: CanvasV2MergeConflictKind[] = [
    'content', 'add-add', 'modify-delete', 'delete-modify', 'unknown',
  ]
  if (!kinds.includes(value.kind as CanvasV2MergeConflictKind)) throw protocol('merge conflict kind')
  assertExact(value.stages, ['base', 'ours', 'theirs'], 'Canvas V2 merge conflict stages')
  return {
    path: nonEmptyString(value.path, 'merge conflict path', 20_000),
    kind: value.kind as CanvasV2MergeConflictKind,
    stages: {
      base: boolean(value.stages.base, 'merge conflict base stage'),
      ours: boolean(value.stages.ours, 'merge conflict ours stage'),
      theirs: boolean(value.stages.theirs, 'merge conflict theirs stage'),
    },
  }
}

function parseMergeResolution(value: unknown): CanvasV2MergeResolutionState {
  assertExactOptional(value, ['requiresExplicitApproval'], ['proposal'], 'merge resolution state')
  if (value.requiresExplicitApproval !== true) throw protocol('merge resolution state')
  return {
    requiresExplicitApproval: true,
    ...(Object.hasOwn(value, 'proposal') ? { proposal: parseMergeProposal(value.proposal) } : {}),
  }
}

function parseMergeProposal(value: unknown): CanvasV2MergeResolutionProposal {
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

function parseMergeResolutionItem(value: unknown): CanvasV2MergeResolutionProposal['resolutions'][number] {
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

function parseMergePreviewCanvas(value: unknown): CanvasV2MergePreviewCanvas {
  assertExactOptional(
    value,
    [
      'sourceBranch', 'targetBranch', 'sourceCommit', 'targetCommit', 'baseCommit',
      'state', 'changed', 'paths', 'conflicts',
    ],
    ['resolution'],
    'Canvas V2 merge preview',
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

function parseWorkspaceMergePreview(value: unknown): CanvasV2WorkspaceMergePreview {
  assertExact(value, ['state', 'canvas', 'expectation'], 'Canvas V2 workspace merge preview')
  const canvas = parseMergePreviewCanvas(value.canvas)
  if (value.state !== canvas.state) throw protocol('workspace merge preview state')
  return { state: canvas.state, canvas, expectation: parseMergeExpectation(value.expectation) }
}

function parseWorkspaceMergeExecution(value: unknown): CanvasV2WorkspaceMergeExecution {
  assertExactOptional(value, ['state', 'canvas'], ['canvasEnvelope'], 'Canvas V2 merge execution')
  const states = ['merged', 'conflicts', 'up-to-date', 'partial'] as const
  if (!states.includes(value.state as typeof states[number])) throw protocol('merge execution state')
  assertExactOptional(
    value.canvas,
    [
      'sourceBranch', 'targetBranch', 'sourceCommit', 'targetCommit', 'baseCommit',
      'state', 'changed', 'paths', 'conflicts', 'merged', 'commit',
    ],
    ['resolution'],
    'Canvas V2 merge execution canvas',
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

function parseDocument(value: unknown): CanvasDocumentV2 {
  try {
    return parseCanvasDocumentV2(value)
  } catch (error) {
    throw new CanvasV2VersioningProtocolError('Canvas V2 version document is invalid', { cause: error })
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
  const branch = nonEmptyString(value, 'Canvas V2 branch', 120)
  const segments = branch.split('/')
  if (!BRANCH_PATTERN.test(branch)
    || branch.includes('..')
    || branch.includes('//')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.endsWith('.lock')
    || segments.some((segment) => segment === '.' || segment.endsWith('.'))) {
    throw new CanvasV2VersioningClientError('Canvas V2 branch is invalid')
  }
  return branch
}

function assertCommit(value: unknown): string {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw protocol('Canvas V2 commit')
  }
  return value
}

function nullableCommit(value: unknown, context: string): string | null {
  if (value === null) return null
  try {
    return assertCommit(value)
  } catch (error) {
    throw new CanvasV2VersioningProtocolError(`${context} is invalid`, { cause: error })
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

function protocol(context: string): CanvasV2VersioningProtocolError {
  return new CanvasV2VersioningProtocolError(`${context} is invalid`)
}

async function decodeHttpError(
  response: Response,
  operation: string,
): Promise<CanvasV2VersioningHttpError> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    value = null
  }
  const error = isRecord(value) && isRecord(value.error) ? value.error : null
  return new CanvasV2VersioningHttpError(
    response.status,
    error && typeof error.code === 'string' ? error.code : `http_${response.status}`,
    error && typeof error.message === 'string'
      ? error.message
      : `${operation} failed with HTTP ${response.status}`,
  )
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '')
  if (!normalized) throw new CanvasV2VersioningClientError('baseUrl is required')
  try {
    return new URL(normalized).toString().replace(/\/$/u, '')
  } catch (error) {
    throw new CanvasV2VersioningClientError('baseUrl is invalid', { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
