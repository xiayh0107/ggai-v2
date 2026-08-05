import type { DaemonCanvasEnvelope } from './daemonClient'

export type CanvasAutomationMode = 'auto' | 'confirm'

export type CanvasGitStatus =
  | { state: 'uninitialized'; initialized: false; gitAvailable: true }
  | { state: 'ready'; initialized: true; gitAvailable: true }
  | { state: 'degraded'; initialized: boolean; gitAvailable: boolean; reason: string }

export interface SourceBranchBinding {
  logicalBranch: string
  gitBranch: string
  worktreeId: string
  worktreePath: string
  projectDir: string
  head: string
  dirty: boolean
}

export interface SourceGitStatus {
  status: 'unavailable' | 'unbound' | 'ready' | 'degraded'
  repoRoot?: string
  projectRelativeDir?: string
  reason?: string
  branches: SourceBranchBinding[]
}

export interface CanvasVersionStatuses {
  versioning: CanvasGitStatus
  source: SourceGitStatus
}

export interface CanvasGitWorktree {
  id: string
  path: string
  branch: string | null
  commit: string
  locked: boolean
  lockReason?: string
  prunable: boolean
  managed: boolean
}

export interface CanvasGitBranch {
  name: string
  commit: string
  worktree: CanvasGitWorktree | null
}

export interface CanvasGitHistoryEntry {
  commit: string
  parents: string[]
  committedAt: string
  subject: string
}

export interface CanvasGitHistoryPage {
  entries: CanvasGitHistoryEntry[]
  nextCursor: string | null
}

export interface CanvasGitCheckpoint {
  branch: string
  commit: string
  changed: boolean
  status: Extract<CanvasGitStatus, { state: 'ready' }>
}

export interface WorkspaceCheckpoint {
  canvas: DaemonCanvasEnvelope
  checkpoint: CanvasGitCheckpoint
}

export interface WorkspaceBranch {
  branch: CanvasGitBranch
  canvas: DaemonCanvasEnvelope
  sourceBranch: SourceBranchBinding | null
}

export interface WorkspaceDeleteBranch {
  branch: string
  canvasDeleted: boolean
  sourceDeleted: boolean
  runtimeDeleted: boolean
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
  stages: {
    base: boolean
    ours: boolean
    theirs: boolean
  }
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

export interface CanvasMergeResolution {
  requiresExplicitApproval: true
  /** Advisory only. The merge API never applies this proposal automatically. */
  proposal?: CanvasMergeResolutionProposal
}

export interface CanvasMergePreview {
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
  targetCommit: string
  baseCommit: string | null
  state: CanvasMergeState
  changed: boolean
  paths: string[]
  conflicts: CanvasMergeConflict[]
  resolution?: CanvasMergeResolution
}

export interface CanvasMergeExecution extends CanvasMergePreview {
  merged: boolean
  commit: string
}

export interface WorkspaceMergeExpectation {
  canvas: {
    sourceCommit: string
    targetCommit: string
    sourceRevision: number
    targetRevision: number
  }
  source: {
    sourceCommit: string
    targetCommit: string
  } | null
}

export interface WorkspaceMergePreview {
  state: CanvasMergeState
  canvas: CanvasMergePreview
  source: CanvasMergePreview | null
  /** Freshness fence returned unchanged with the confirmed execution. */
  expectation: WorkspaceMergeExpectation
}

export interface WorkspaceMergeExecution {
  state: 'merged' | 'conflicts' | 'up-to-date' | 'partial'
  canvas: CanvasMergeExecution
  source: CanvasMergeExecution | null
  canvasEnvelope?: DaemonCanvasEnvelope
}

export interface SourceCheckpoint {
  changed: boolean
  commit: string
  requiresConfirmation: boolean
  warnings: string[]
  paths: string[]
}

export interface CanvasVersioningError {
  code: string
  message: string
}

export type CanvasVersionOperation<T> =
  | (CanvasVersionStatuses & {
      ok: true
      partial: false
      sourceDegraded: false
      value: T
    })
  | (CanvasVersionStatuses & {
      ok: false
      partial: boolean
      sourceDegraded: boolean
      error: CanvasVersioningError
      value?: T
    })

export interface CanvasPreferences {
  schemaVersion: 1
  automationMode: CanvasAutomationMode
}

export interface CanvasVersionQuery {
  projectDir?: string
}

export interface CanvasHistoryQuery extends CanvasVersionQuery {
  branch: string
  cursor?: string
  limit?: number
}

export interface CreateCanvasBranchRequest extends CanvasVersionQuery {
  name: string
  fromBranch?: string
}

export interface DeleteCanvasBranchRequest extends CanvasVersionQuery {
  branch: string
}

export interface CreateCanvasCheckpointRequest extends CanvasVersionQuery {
  branch: string
  reason?: string
}

export interface RestoreCanvasCheckpointRequest extends CanvasVersionQuery {
  sourceBranch: string
  checkpoint: string
  newBranch: string
}

export interface PreviewCanvasMergeRequest extends CanvasVersionQuery {
  sourceBranch: string
  targetBranch: string
}

export interface ExecuteCanvasMergeRequest extends PreviewCanvasMergeRequest {
  /** A merge is never executed without a fresh, explicit user confirmation. */
  confirmed: true
  /** Exact branch tips/revisions reviewed in the preceding preview. */
  expected: WorkspaceMergeExpectation
}

export interface BindCanvasSourceRequest extends CanvasVersionQuery {
  branch?: string
}

export interface CreateCanvasSourceCheckpointRequest extends CanvasVersionQuery {
  branch: string
  runId: string
  nodeTitle: string
  allowSensitive?: boolean
}

export interface PutCanvasPreferencesRequest extends CanvasVersionQuery {
  automationMode: CanvasAutomationMode
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown, context: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${context} was not a valid string`)
  }
  return value
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${context} was not a boolean`)
  return value
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${context} was not a string array`)
  }
  return value
}

export function decodeCanvasGitStatus(value: unknown, context: string): CanvasGitStatus {
  if (!isRecord(value)) throw new Error(`${context} was not a versioning status`)
  if (value.state === 'uninitialized'
    && value.initialized === false
    && value.gitAvailable === true) {
    return { state: 'uninitialized', initialized: false, gitAvailable: true }
  }
  if (value.state === 'ready'
    && value.initialized === true
    && value.gitAvailable === true) {
    return { state: 'ready', initialized: true, gitAvailable: true }
  }
  if (value.state === 'degraded') {
    return {
      state: 'degraded',
      initialized: boolean(value.initialized, `${context}.initialized`),
      gitAvailable: boolean(value.gitAvailable, `${context}.gitAvailable`),
      reason: string(value.reason, `${context}.reason`, true),
    }
  }
  throw new Error(`${context} was not a recognized versioning status`)
}

export function decodeSourceBranchBinding(value: unknown, context: string): SourceBranchBinding {
  if (!isRecord(value)) throw new Error(`${context} was not a source branch binding`)
  return {
    logicalBranch: string(value.logicalBranch, `${context}.logicalBranch`),
    gitBranch: string(value.gitBranch, `${context}.gitBranch`),
    worktreeId: string(value.worktreeId, `${context}.worktreeId`),
    worktreePath: string(value.worktreePath, `${context}.worktreePath`),
    projectDir: string(value.projectDir, `${context}.projectDir`),
    head: string(value.head, `${context}.head`),
    dirty: boolean(value.dirty, `${context}.dirty`),
  }
}

export function decodeSourceGitStatus(value: unknown, context: string): SourceGitStatus {
  if (!isRecord(value)
    || (value.status !== 'unavailable'
      && value.status !== 'unbound'
      && value.status !== 'ready'
      && value.status !== 'degraded')
    || !Array.isArray(value.branches)) {
    throw new Error(`${context} was not a source Git status`)
  }
  return {
    status: value.status,
    ...(value.repoRoot === undefined
      ? {}
      : { repoRoot: string(value.repoRoot, `${context}.repoRoot`) }),
    ...(value.projectRelativeDir === undefined
      ? {}
      : { projectRelativeDir: string(value.projectRelativeDir, `${context}.projectRelativeDir`, true) }),
    ...(value.reason === undefined
      ? {}
      : { reason: string(value.reason, `${context}.reason`, true) }),
    branches: value.branches.map((branch, index) =>
      decodeSourceBranchBinding(branch, `${context}.branches[${index}]`)),
  }
}

export function decodeCanvasVersionStatuses(
  value: unknown,
  context: string,
): CanvasVersionStatuses {
  if (!isRecord(value)) throw new Error(`${context} was not a workspace status`)
  return {
    versioning: decodeCanvasGitStatus(value.versioning, `${context}.versioning`),
    source: decodeSourceGitStatus(value.source, `${context}.source`),
  }
}

export function decodeCanvasGitBranch(value: unknown, context: string): CanvasGitBranch {
  if (!isRecord(value)) throw new Error(`${context} was not a canvas branch`)
  return {
    name: string(value.name, `${context}.name`),
    commit: string(value.commit, `${context}.commit`),
    worktree: value.worktree === null
      ? null
      : decodeCanvasGitWorktree(value.worktree, `${context}.worktree`),
  }
}

function decodeCanvasGitWorktree(value: unknown, context: string): CanvasGitWorktree {
  if (!isRecord(value)) throw new Error(`${context} was not a canvas worktree`)
  return {
    id: string(value.id, `${context}.id`),
    path: string(value.path, `${context}.path`),
    branch: value.branch === null ? null : string(value.branch, `${context}.branch`),
    commit: string(value.commit, `${context}.commit`),
    locked: boolean(value.locked, `${context}.locked`),
    ...(value.lockReason === undefined
      ? {}
      : { lockReason: string(value.lockReason, `${context}.lockReason`, true) }),
    prunable: boolean(value.prunable, `${context}.prunable`),
    managed: boolean(value.managed, `${context}.managed`),
  }
}

export function decodeCanvasHistoryPage(value: unknown, context: string): CanvasGitHistoryPage {
  if (!isRecord(value)
    || !Array.isArray(value.entries)
    || !(value.nextCursor === null || typeof value.nextCursor === 'string')) {
    throw new Error(`${context} was not a canvas history page`)
  }
  return {
    entries: value.entries.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`${context}.entries[${index}] was invalid`)
      return {
        commit: string(entry.commit, `${context}.entries[${index}].commit`),
        parents: stringArray(entry.parents, `${context}.entries[${index}].parents`),
        committedAt: string(entry.committedAt, `${context}.entries[${index}].committedAt`),
        subject: string(entry.subject, `${context}.entries[${index}].subject`, true),
      }
    }),
    nextCursor: value.nextCursor,
  }
}

export function decodeCanvasPreferences(value: unknown, context: string): CanvasPreferences {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || (value.automationMode !== 'auto' && value.automationMode !== 'confirm')) {
    throw new Error(`${context} was not a canvas preferences document`)
  }
  return { schemaVersion: 1, automationMode: value.automationMode }
}

export function decodeCanvasVersionOperation<T>(
  value: unknown,
  context: string,
  decodeValue: (value: unknown, context: string) => T,
): CanvasVersionOperation<T> {
  if (!isRecord(value)
    || typeof value.ok !== 'boolean'
    || typeof value.partial !== 'boolean'
    || typeof value.sourceDegraded !== 'boolean') {
    throw new Error(`${context} was not a versioning operation result`)
  }
  const statuses = decodeCanvasVersionStatuses(value, context)
  if (value.ok) {
    if (value.partial !== false || value.sourceDegraded !== false || !('value' in value)) {
      throw new Error(`${context} contained an invalid successful result`)
    }
    return {
      ok: true,
      partial: false,
      sourceDegraded: false,
      value: decodeValue(value.value, `${context}.value`),
      ...statuses,
    }
  }
  if (!isRecord(value.error)) throw new Error(`${context} did not contain an operation error`)
  const result: CanvasVersionOperation<T> = {
    ok: false,
    partial: value.partial,
    sourceDegraded: value.sourceDegraded,
    error: {
      code: string(value.error.code, `${context}.error.code`),
      message: string(value.error.message, `${context}.error.message`, true),
    },
    ...statuses,
  }
  if ('value' in value) result.value = decodeValue(value.value, `${context}.value`)
  return result
}

export function decodeCanvasBranchList(value: unknown, context: string): CanvasGitBranch[] {
  if (!Array.isArray(value)) throw new Error(`${context} was not a branch list`)
  return value.map((branch, index) => decodeCanvasGitBranch(branch, `${context}[${index}]`))
}

type CanvasEnvelopeDecoder = (value: unknown, context: string) => DaemonCanvasEnvelope

export function decodeWorkspaceCheckpoint(
  value: unknown,
  context: string,
  decodeEnvelope: CanvasEnvelopeDecoder,
): WorkspaceCheckpoint {
  if (!isRecord(value) || !isRecord(value.canvas) || !isRecord(value.checkpoint)) {
    throw new Error(`${context} was not a workspace checkpoint`)
  }
  const checkpoint = value.checkpoint
  const checkpointStatus = decodeCanvasGitStatus(
    checkpoint.status,
    `${context}.checkpoint.status`,
  )
  if (checkpointStatus.state !== 'ready') {
    throw new Error(`${context}.checkpoint.status was not ready`)
  }
  return {
    canvas: decodeEnvelope(value.canvas, `${context}.canvas`),
    checkpoint: {
      branch: string(checkpoint.branch, `${context}.checkpoint.branch`),
      commit: string(checkpoint.commit, `${context}.checkpoint.commit`),
      changed: boolean(checkpoint.changed, `${context}.checkpoint.changed`),
      status: checkpointStatus,
    },
  }
}

export function decodeWorkspaceBranch(
  value: unknown,
  context: string,
  decodeEnvelope: CanvasEnvelopeDecoder,
): WorkspaceBranch {
  if (!isRecord(value) || !isRecord(value.canvas)) {
    throw new Error(`${context} was not a workspace branch`)
  }
  return {
    branch: decodeCanvasGitBranch(value.branch, `${context}.branch`),
    canvas: decodeEnvelope(value.canvas, `${context}.canvas`),
    sourceBranch: value.sourceBranch === null
      ? null
      : decodeSourceBranchBinding(value.sourceBranch, `${context}.sourceBranch`),
  }
}

export function decodeWorkspaceDeleteBranch(
  value: unknown,
  context: string,
): WorkspaceDeleteBranch {
  if (!isRecord(value)) throw new Error(`${context} was not a deleted branch result`)
  return {
    branch: string(value.branch, `${context}.branch`),
    canvasDeleted: boolean(value.canvasDeleted, `${context}.canvasDeleted`),
    sourceDeleted: boolean(value.sourceDeleted, `${context}.sourceDeleted`),
    runtimeDeleted: boolean(value.runtimeDeleted, `${context}.runtimeDeleted`),
  }
}

export function decodeWorkspaceMergePreview(
  value: unknown,
  context: string,
): WorkspaceMergePreview {
  if (!isRecord(value)
    || (value.state !== 'ready'
      && value.state !== 'conflicts'
      && value.state !== 'up-to-date')) {
    throw new Error(`${context} was not a workspace merge preview`)
  }
  return {
    state: value.state,
    canvas: decodeMergePreview(value.canvas, `${context}.canvas`),
    source: value.source === null
      ? null
      : decodeMergePreview(value.source, `${context}.source`),
    expectation: decodeWorkspaceMergeExpectation(
      value.expectation,
      `${context}.expectation`,
    ),
  }
}

export function decodeWorkspaceMergeExpectation(
  value: unknown,
  context: string,
): WorkspaceMergeExpectation {
  if (!isRecord(value) || !isRecord(value.canvas)) {
    throw new Error(`${context} was not a workspace merge expectation`)
  }
  const canvas = value.canvas
  if (!Number.isSafeInteger(canvas.sourceRevision)
    || (canvas.sourceRevision as number) < 0
    || !Number.isSafeInteger(canvas.targetRevision)
    || (canvas.targetRevision as number) < 0) {
    throw new Error(`${context}.canvas revisions were invalid`)
  }
  return {
    canvas: {
      sourceCommit: string(canvas.sourceCommit, `${context}.canvas.sourceCommit`),
      targetCommit: string(canvas.targetCommit, `${context}.canvas.targetCommit`),
      sourceRevision: canvas.sourceRevision as number,
      targetRevision: canvas.targetRevision as number,
    },
    source: value.source === null
      ? null
      : decodeMergeExpectationSource(value.source, `${context}.source`),
  }
}

function decodeMergeExpectationSource(
  value: unknown,
  context: string,
): NonNullable<WorkspaceMergeExpectation['source']> {
  if (!isRecord(value)) throw new Error(`${context} was not a source merge expectation`)
  return {
    sourceCommit: string(value.sourceCommit, `${context}.sourceCommit`),
    targetCommit: string(value.targetCommit, `${context}.targetCommit`),
  }
}

export function decodeWorkspaceMergeExecution(
  value: unknown,
  context: string,
  decodeEnvelope: CanvasEnvelopeDecoder,
): WorkspaceMergeExecution {
  if (!isRecord(value)
    || (value.state !== 'merged'
      && value.state !== 'conflicts'
      && value.state !== 'up-to-date'
      && value.state !== 'partial')) {
    throw new Error(`${context} was not a workspace merge execution`)
  }
  return {
    state: value.state,
    canvas: decodeMergeExecution(value.canvas, `${context}.canvas`),
    source: value.source === null
      ? null
      : decodeMergeExecution(value.source, `${context}.source`),
    ...(value.canvasEnvelope === undefined
      ? {}
      : { canvasEnvelope: decodeEnvelope(value.canvasEnvelope, `${context}.canvasEnvelope`) }),
  }
}

function decodeMergePreview(value: unknown, context: string): CanvasMergePreview {
  if (!isRecord(value)
    || (value.state !== 'ready'
      && value.state !== 'conflicts'
      && value.state !== 'up-to-date')
    || !(value.baseCommit === null || typeof value.baseCommit === 'string')
    || !Array.isArray(value.conflicts)) {
    throw new Error(`${context} was not a merge preview`)
  }
  const resolution = value.resolution === undefined
    ? undefined
    : decodeMergeResolution(value.resolution, `${context}.resolution`)
  if (value.conflicts.length > 0 && resolution?.requiresExplicitApproval !== true) {
    throw new Error(`${context} conflicts did not require explicit approval`)
  }
  return {
    sourceBranch: string(value.sourceBranch, `${context}.sourceBranch`),
    targetBranch: string(value.targetBranch, `${context}.targetBranch`),
    sourceCommit: string(value.sourceCommit, `${context}.sourceCommit`),
    targetCommit: string(value.targetCommit, `${context}.targetCommit`),
    baseCommit: value.baseCommit,
    state: value.state,
    changed: boolean(value.changed, `${context}.changed`),
    paths: stringArray(value.paths, `${context}.paths`),
    conflicts: value.conflicts.map((conflict, index) =>
      decodeMergeConflict(conflict, `${context}.conflicts[${index}]`)),
    ...(resolution === undefined ? {} : { resolution }),
  }
}

function decodeMergeExecution(value: unknown, context: string): CanvasMergeExecution {
  const preview = decodeMergePreview(value, context)
  if (!isRecord(value)) throw new Error(`${context} was not a merge execution`)
  return {
    ...preview,
    merged: boolean(value.merged, `${context}.merged`),
    commit: string(value.commit, `${context}.commit`),
  }
}

function decodeMergeConflict(value: unknown, context: string): CanvasMergeConflict {
  if (!isRecord(value)
    || (value.kind !== 'content'
      && value.kind !== 'add-add'
      && value.kind !== 'modify-delete'
      && value.kind !== 'delete-modify'
      && value.kind !== 'unknown')
    || !isRecord(value.stages)) {
    throw new Error(`${context} was not a merge conflict`)
  }
  return {
    path: string(value.path, `${context}.path`),
    kind: value.kind,
    stages: {
      base: boolean(value.stages.base, `${context}.stages.base`),
      ours: boolean(value.stages.ours, `${context}.stages.ours`),
      theirs: boolean(value.stages.theirs, `${context}.stages.theirs`),
    },
  }
}

function decodeMergeResolution(value: unknown, context: string): CanvasMergeResolution {
  if (!isRecord(value) || value.requiresExplicitApproval !== true) {
    throw new Error(`${context} did not require explicit approval`)
  }
  return {
    requiresExplicitApproval: true,
    ...(value.proposal === undefined
      ? {}
      : { proposal: decodeMergeProposal(value.proposal, `${context}.proposal`) }),
  }
}

function decodeMergeProposal(value: unknown, context: string): CanvasMergeResolutionProposal {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.resolutions)) {
    throw new Error(`${context} was not a merge resolution proposal`)
  }
  return {
    schemaVersion: 1,
    generatedBy: string(value.generatedBy, `${context}.generatedBy`),
    ...(value.rationale === undefined
      ? {}
      : { rationale: string(value.rationale, `${context}.rationale`, true) }),
    resolutions: value.resolutions.map((resolution, index) => {
      if (!isRecord(resolution)
        || (resolution.choice !== 'ours'
          && resolution.choice !== 'theirs'
          && resolution.choice !== 'custom')) {
        throw new Error(`${context}.resolutions[${index}] was invalid`)
      }
      return {
        path: string(resolution.path, `${context}.resolutions[${index}].path`),
        choice: resolution.choice,
        ...(resolution.content === undefined
          ? {}
          : { content: string(resolution.content, `${context}.resolutions[${index}].content`, true) }),
        ...(resolution.rationale === undefined
          ? {}
          : { rationale: string(resolution.rationale, `${context}.resolutions[${index}].rationale`, true) }),
      }
    }),
  }
}

export function decodeSourceCheckpoint(value: unknown, context: string): SourceCheckpoint {
  if (!isRecord(value)) throw new Error(`${context} was not a source checkpoint`)
  return {
    changed: boolean(value.changed, `${context}.changed`),
    commit: string(value.commit, `${context}.commit`),
    requiresConfirmation: boolean(
      value.requiresConfirmation,
      `${context}.requiresConfirmation`,
    ),
    warnings: stringArray(value.warnings, `${context}.warnings`),
    paths: stringArray(value.paths, `${context}.paths`),
  }
}
