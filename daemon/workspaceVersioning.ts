import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  CanvasGitError,
  CanvasGitStore,
  type CanvasGitBranch,
  type CanvasGitCheckpointResult,
  type CanvasGitHistoryOptions,
  type CanvasGitHistoryPage,
  type CanvasGitRestoreInput,
  type CanvasGitSourceMetadata,
  type CanvasGitStatus,
} from './canvasGit.js'
import {
  CanvasCorruptionError,
  CanvasRevisionConflictError,
  CanvasStoreManager,
} from './canvasStore.js'
import { buildCheckpointMetadata } from './checkpointMetadata.js'
import type { GitMergeExecution, GitMergePreview, GitMergeState } from './mergeTypes.js'
import {
  parseCanvasDocument,
  ProtocolError,
  type CanvasEnvelope,
  type PutCanvasRequest,
} from './protocol.js'
import { RunLogStore } from './runLogs.js'
import {
  SourceGitError,
  SourceGitManager,
  type SourceBranchBinding,
  type SourceCheckpointResult,
  type SourceGitStatus,
  type SourceGitStore,
} from './sourceGit.js'

const DEFAULT_CHECKPOINT_DELAY_MS = 3_000

export interface WorkspaceVersionManagerOptions {
  projectRoot: string
  checkpointDelayMs?: number
  canvasStoreManager?: CanvasStoreManager
  sourceGitManager?: SourceGitManager
  canvasGitFactory?: (canonicalProjectDir: string) => CanvasGitStore
}

export interface WorkspaceStatuses {
  versioning: CanvasGitStatus
  source: SourceGitStatus
}

export interface WorkspaceCanvasResult extends WorkspaceStatuses {
  canvas: CanvasEnvelope
}

export interface WorkspaceOperationError {
  code: string
  message: string
}

export type WorkspaceOperationResult<T> =
  | (WorkspaceStatuses & {
      ok: true
      partial: false
      sourceDegraded: false
      value: T
    })
  | (WorkspaceStatuses & {
      ok: false
      partial: boolean
      sourceDegraded: boolean
      error: WorkspaceOperationError
      value?: T
    })

export interface WorkspaceCheckpoint {
  canvas: CanvasEnvelope
  checkpoint: CanvasGitCheckpointResult
}

export interface WorkspaceCreateBranchInput {
  name: string
  fromBranch?: string
}

export interface WorkspaceBranch {
  branch: CanvasGitBranch
  canvas: CanvasEnvelope
  sourceBranch: SourceBranchBinding | null
}

export interface WorkspaceDeleteBranch {
  branch: string
  canvasDeleted: boolean
  sourceDeleted: boolean
  runtimeDeleted: boolean
}

export interface WorkspaceMergeInput {
  sourceBranch: string
  targetBranch: string
}

export interface WorkspaceMergeExpectation {
  canvas: {
    sourceCommit: string
    targetCommit: string
    sourceRevision: number
    targetRevision: number
  }
  /** Null when source Git was not bound when the preview was created. */
  source: {
    sourceCommit: string
    targetCommit: string
  } | null
}

export interface WorkspaceMergePreview {
  state: GitMergeState
  canvas: GitMergePreview
  /** Null when source Git has not been explicitly bound. */
  source: GitMergePreview | null
  /** Must be returned unchanged when explicitly executing this preview. */
  expectation: WorkspaceMergeExpectation
}

export interface WorkspaceMergeExecutionInput extends WorkspaceMergeInput {
  confirmed: boolean
  expected: WorkspaceMergeExpectation
}

export interface WorkspaceMergeExecution {
  state: 'merged' | 'conflicts' | 'up-to-date' | 'partial'
  canvas: GitMergeExecution
  /** Null when source Git has not been explicitly bound. */
  source: GitMergeExecution | null
  canvasEnvelope?: CanvasEnvelope
}

interface ProjectVersionState {
  projectDir: string
  canvasGit: CanvasGitStore
  runLogs: RunLogStore
  sourceGit: SourceGitStore
  versioning: CanvasGitStatus | null
  source: SourceGitStatus | null
}

interface ScheduledCheckpoint {
  timer: ReturnType<typeof setTimeout>
  reason: string
  project: ProjectVersionState
  branch: string
}

interface PreparedWorkspaceMerge {
  preview: WorkspaceMergePreview
  targetCanvas: CanvasEnvelope
}

interface SourceBranchLayers {
  status: SourceGitStatus
  from: SourceBranchBinding | null
  target: SourceBranchBinding | null
}

/**
 * Coordinates authoritative canvas snapshots with best-effort Git history.
 * Canvas saves are durable before any Git work is scheduled and never fail
 * because checkpointing is unavailable.
 */
export class WorkspaceVersionManager {
  readonly canvases: CanvasStoreManager
  readonly sources: SourceGitManager

  readonly #projectRoot: string
  readonly #checkpointDelayMs: number
  readonly #canvasGitFactory: (canonicalProjectDir: string) => CanvasGitStore
  readonly #projects = new Map<string, Promise<ProjectVersionState>>()
  readonly #scheduled = new Map<string, ScheduledCheckpoint>()
  readonly #checkpointTasks = new Set<Promise<void>>()
  readonly #branchTails = new Map<string, Promise<void>>()
  #closing = false
  #closePromise: Promise<void> | null = null

  constructor(options: WorkspaceVersionManagerOptions) {
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#checkpointDelayMs = options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS
    if (!Number.isFinite(this.#checkpointDelayMs) || this.#checkpointDelayMs < 0) {
      throw new TypeError('checkpointDelayMs must be a non-negative finite number')
    }
    this.canvases = options.canvasStoreManager ?? new CanvasStoreManager({
      projectRoot: this.#projectRoot,
    })
    this.sources = options.sourceGitManager ?? new SourceGitManager(this.#projectRoot)
    this.#canvasGitFactory = options.canvasGitFactory
      ?? ((projectDir) => new CanvasGitStore(projectDir))
  }

  async getCanvas(projectDir = '.', branch = 'main'): Promise<WorkspaceCanvasResult> {
    const project = await this.#project(projectDir)
    const [canvas, statuses] = await Promise.all([
      this.canvases.get(project.projectDir, branch),
      this.#refreshStatuses(project),
    ])
    return { canvas, ...statuses }
  }

  async saveCanvas(
    projectDir: string,
    branch: string,
    request: PutCanvasRequest,
  ): Promise<WorkspaceCanvasResult> {
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branch], async () => {
      const canvas = await this.canvases.put(project.projectDir, branch, request)
      this.#scheduleCheckpoint(project, branch, request.changeKind)
      const statuses = await this.#cachedStatuses(project)
      return { canvas, ...statuses }
    })
  }

  async status(projectDir = '.'): Promise<WorkspaceStatuses> {
    return this.#refreshStatuses(await this.#project(projectDir))
  }

  async manualCheckpoint(
    projectDir: string,
    branch: string,
    reason = 'manual',
  ): Promise<WorkspaceOperationResult<WorkspaceCheckpoint>> {
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branch], async () => {
      this.#cancelScheduled(project, branch)
      try {
        const value = await this.#checkpoint(project, branch, reason)
        return this.#success(value, await this.#refreshStatuses(project))
      } catch (error) {
        return this.#failure(error, await this.#refreshStatuses(project))
      }
    })
  }

  async listBranches(
    projectDir = '.',
  ): Promise<WorkspaceOperationResult<CanvasGitBranch[]>> {
    const project = await this.#project(projectDir)
    try {
      const status = await this.#refreshStatuses(project)
      if (status.versioning.state === 'uninitialized') return this.#success([], status)
      const value = await project.canvasGit.listBranches()
      return this.#success(value, await this.#refreshStatuses(project))
    } catch (error) {
      return this.#failure(error, await this.#refreshStatuses(project))
    }
  }

  async history(
    projectDir: string,
    options: CanvasGitHistoryOptions,
  ): Promise<WorkspaceOperationResult<CanvasGitHistoryPage>> {
    const project = await this.#project(projectDir)
    try {
      const status = await this.#refreshStatuses(project)
      if (status.versioning.state === 'uninitialized') {
        return this.#success({ entries: [], nextCursor: null }, status)
      }
      const value = await project.canvasGit.history(options)
      return this.#success(value, await this.#refreshStatuses(project))
    } catch (error) {
      return this.#failure(error, await this.#refreshStatuses(project))
    }
  }

  async createBranch(
    projectDir: string,
    input: WorkspaceCreateBranchInput,
  ): Promise<WorkspaceOperationResult<WorkspaceBranch>> {
    const project = await this.#project(projectDir)
    const fromBranch = input.fromBranch ?? 'main'
    return this.#withBranchLocks(project, [fromBranch, input.name], async () => {
      let branch: CanvasGitBranch | null = null
      let canvas: CanvasEnvelope | null = null
      let sourceBranch: SourceBranchBinding | null = null
      let partial = false
      try {
        if (input.name === fromBranch) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            'new canvas branch must differ from its source branch',
          )
        }
        canvas = await this.canvases.get(project.projectDir, input.name)
        branch = await this.#canvasBranch(project, input.name)
        partial = branch !== null || canvas.revision > 0
        const source = await this.#sourceBranchLayers(project, fromBranch, input.name)
        sourceBranch = source.target
        partial ||= sourceBranch !== null
        this.#assertBranchLayerConsistency(input.name, branch, canvas, sourceBranch)

        if (!branch) {
          this.#cancelScheduled(project, fromBranch)
          await this.#checkpoint(project, fromBranch, 'branch-created')
          branch = await project.canvasGit.createBranch({
            name: input.name,
            startPoint: fromBranch,
          })
          partial = true
        }
        this.#assertManagedCanvasBranch(input.name, branch)
        if (canvas.revision === 0) {
          const document = parseCanvasDocument(await project.canvasGit.readDocument(input.name))
          canvas = await this.canvases.materialize(
            project.projectDir,
            input.name,
            document,
            branch.commit,
          )
          partial = true
        } else {
          this.#assertRuntimeMatchesCanvasBranch(input.name, branch, canvas)
        }
        if (source.status.status === 'ready' && !sourceBranch) {
          sourceBranch = await project.sourceGit.createBranch(input.name, fromBranch)
          partial = true
        }
        return this.#success(
          { branch, canvas, sourceBranch },
          await this.#refreshStatuses(project),
        )
      } catch (error) {
        const value = branch && canvas?.revision
          ? { branch, canvas, sourceBranch }
          : undefined
        return this.#failure(
          error,
          await this.#refreshStatuses(project),
          partial,
          value,
          partial && sourceBranch === null,
        )
      }
    })
  }

  async restoreAsNewBranch(
    projectDir: string,
    input: CanvasGitRestoreInput,
  ): Promise<WorkspaceOperationResult<WorkspaceBranch>> {
    const restoreInput = {
      ...input,
      checkpoint: canonicalFullGitCommit(input.checkpoint),
    }
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [input.sourceBranch, input.newBranch], async () => {
      let branch: CanvasGitBranch | null = null
      let canvas: CanvasEnvelope | null = null
      let sourceBranch: SourceBranchBinding | null = null
      let partial = false
      try {
        if (input.newBranch === input.sourceBranch) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            'restored canvas branch must differ from its history branch',
          )
        }
        const sourceMetadata = await project.canvasGit.readSourceMetadata(restoreInput.checkpoint)
        canvas = await this.canvases.get(project.projectDir, input.newBranch)
        branch = await this.#canvasBranch(project, input.newBranch)
        partial = branch !== null || canvas.revision > 0
        const source = await this.#sourceBranchLayers(
          project,
          input.sourceBranch,
          input.newBranch,
          { requireFromWhenTargetMissing: sourceMetadata !== null },
        )
        sourceBranch = source.target
        partial ||= sourceBranch !== null
        this.#assertBranchLayerConsistency(input.newBranch, branch, canvas, sourceBranch)
        if (!sourceMetadata && sourceBranch) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            `legacy canvas checkpoint cannot be paired with an existing source branch: ${input.newBranch}`,
          )
        }
        if (
          sourceMetadata
          && sourceBranch
          && !(await project.sourceGit.containsCommit(input.newBranch, sourceMetadata.commit))
        ) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            `restored source branch is unrelated to its recorded commit: ${input.newBranch}`,
          )
        }
        if (branch && branch.commit !== restoreInput.checkpoint) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            `existing restore branch points at a different checkpoint: ${input.newBranch}`,
          )
        }

        if (!branch) {
          this.#cancelScheduled(project, input.sourceBranch)
          try {
            await this.#checkpoint(project, input.sourceBranch, 'before-restore')
          } catch (error) {
            // A quarantined runtime snapshot must not make its last known-good Git
            // history unrecoverable. Restore remains non-destructive because it
            // always materializes into a different branch.
            if (!(error instanceof CanvasCorruptionError)) throw error
          }
          branch = await project.canvasGit.restoreAsNewBranch(restoreInput)
          partial = true
        }
        this.#assertManagedCanvasBranch(input.newBranch, branch)
        if (canvas.revision === 0) {
          const document = parseCanvasDocument(await project.canvasGit.readDocument(input.newBranch))
          canvas = await this.canvases.materialize(
            project.projectDir,
            input.newBranch,
            document,
            branch.commit,
          )
          partial = true
        } else {
          this.#assertRuntimeMatchesCanvasBranch(input.newBranch, branch, canvas)
        }
        if (sourceMetadata && source.status.status !== 'ready') {
          throw new WorkspaceVersioningError(
            'source_restore_unavailable',
            `canvas was restored, but its recorded source commit is unavailable because source Git is ${source.status.status}`,
          )
        }
        if (sourceMetadata && !sourceBranch) {
          sourceBranch = await project.sourceGit.createBranchAt(
            input.newBranch,
            input.sourceBranch,
            sourceMetadata.commit,
          )
          partial = true
        }
        return this.#success(
          { branch, canvas, sourceBranch },
          await this.#refreshStatuses(project),
        )
      } catch (error) {
        const value = branch && canvas?.revision
          ? { branch, canvas, sourceBranch }
          : undefined
        return this.#failure(
          error,
          await this.#refreshStatuses(project),
          partial,
          value,
          partial && sourceBranch === null,
        )
      }
    })
  }

  async deleteBranch(
    projectDir: string,
    branch: string,
  ): Promise<WorkspaceOperationResult<WorkspaceDeleteBranch>> {
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branch], async () => {
      const value: WorkspaceDeleteBranch = {
        branch,
        canvasDeleted: false,
        sourceDeleted: false,
        runtimeDeleted: false,
      }
      let destructiveStarted = false
      try {
        if (branch === 'main') {
          throw new CanvasGitError('PROTECTED_BRANCH', 'The main canvas branch cannot be deleted')
        }
        this.#cancelScheduled(project, branch)
        const canvas = await this.canvases.get(project.projectDir, branch)
        const canvasBranch = await this.#canvasBranch(project, branch)
        const source = await this.#sourceBranchLayers(project, 'main', branch, {
          requireFromWhenTargetMissing: false,
        })

        // The runtime snapshot is authoritative. Flush it before asking Git
        // whether this branch is safely merged, otherwise a save still inside
        // the debounce window could be deleted without ever reaching history.
        if (canvasBranch && canvas.revision > 0) {
          await this.#checkpoint(project, branch, 'before-delete')
        }
        if (source.target?.dirty) {
          throw new SourceGitError('worktree_dirty', 'dirty source worktree cannot be removed')
        }
        if (source.target) {
          const preview = await project.sourceGit.previewMerge({
            sourceBranch: branch,
            targetBranch: 'main',
          })
          if (preview.state !== 'up-to-date') {
            throw new SourceGitError(
              'branch_not_merged',
              `source branch is not fully merged and was not deleted: ${branch}`,
            )
          }
        }
        if (canvasBranch) {
          const preview = await project.canvasGit.previewMerge({
            sourceBranch: branch,
            targetBranch: 'main',
          })
          if (preview.state !== 'up-to-date') {
            throw new CanvasGitError(
              'BRANCH_NOT_MERGED',
              `Canvas branch is not fully merged and was not deleted: ${branch}`,
            )
          }
        }

        destructiveStarted = true
        if (canvasBranch) await project.canvasGit.deleteBranch(branch)
        value.canvasDeleted = true
        if (source.target) {
          await project.sourceGit.removeBranch(branch)
        }
        value.sourceDeleted = source.status.status === 'ready'
        await this.canvases.removeBranch(project.projectDir, branch)
        value.runtimeDeleted = true
        return this.#success(value, await this.#refreshStatuses(project))
      } catch (error) {
        const partial = destructiveStarted
          || value.canvasDeleted
          || value.sourceDeleted
          || value.runtimeDeleted
        return this.#failure(
          error,
          await this.#refreshStatuses(project),
          partial,
          value,
          value.canvasDeleted && !value.sourceDeleted,
        )
      }
    })
  }

  async previewMerge(
    projectDir: string,
    input: WorkspaceMergeInput,
  ): Promise<WorkspaceOperationResult<WorkspaceMergePreview>> {
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(
      project,
      [input.sourceBranch, input.targetBranch],
      async () => {
        try {
          const prepared = await this.#prepareMerge(project, input)
          return this.#success(prepared.preview, await this.#refreshStatuses(project))
        } catch (error) {
          return this.#failure(error, await this.#refreshStatuses(project))
        }
      },
    )
  }

  async executeMerge(
    projectDir: string,
    input: WorkspaceMergeExecutionInput,
  ): Promise<WorkspaceOperationResult<WorkspaceMergeExecution>> {
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(
      project,
      [input.sourceBranch, input.targetBranch],
      async () => {
        let partialValue: WorkspaceMergeExecution | undefined
        let sourceFailed = false
        try {
          if (!input.confirmed) {
            throw new WorkspaceVersioningError(
              'merge_confirmation_required',
              'merge execution requires explicit confirmation',
            )
          }
          await this.#assertMergeExpectationCurrent(project, input, input.expected)
          const prepared = await this.#prepareMerge(project, input)
          if (!sameMergeExpectation(prepared.preview.expectation, input.expected)) {
            throw staleMergePreview()
          }
          if (prepared.preview.state === 'conflicts') {
            const value: WorkspaceMergeExecution = {
              state: 'conflicts',
              canvas: unexecutedMerge(prepared.preview.canvas),
              source: prepared.preview.source
                ? unexecutedMerge(prepared.preview.source)
                : null,
              canvasEnvelope: prepared.targetCanvas,
            }
            return this.#success(value, await this.#refreshStatuses(project))
          }

          const canvas = await project.canvasGit.merge(input)
          if (canvas.state === 'conflicts') {
            const value: WorkspaceMergeExecution = {
              state: 'conflicts',
              canvas,
              source: prepared.preview.source
                ? unexecutedMerge(prepared.preview.source)
                : null,
              canvasEnvelope: prepared.targetCanvas,
            }
            return this.#success(value, await this.#refreshStatuses(project))
          }

          partialValue = {
            state: canvas.merged ? 'partial' : 'up-to-date',
            canvas,
            source: null,
            canvasEnvelope: prepared.targetCanvas,
          }
          if (canvas.commit !== prepared.targetCanvas.lastCheckpoint) {
            const document = parseCanvasDocument(
              await project.canvasGit.readDocument(input.targetBranch),
            )
            partialValue.canvasEnvelope = await this.canvases.applyCheckpoint(
              project.projectDir,
              input.targetBranch,
              document,
              canvas.commit,
              prepared.targetCanvas.revision,
            )
          }

          if (prepared.preview.source) {
            let source: GitMergeExecution
            try {
              source = await project.sourceGit.merge(input)
            } catch (error) {
              sourceFailed = true
              throw error
            }
            partialValue.source = source
            if (source.state === 'conflicts') {
              if (canvas.merged) {
                sourceFailed = true
                throw new WorkspaceVersioningError(
                  'source_merge_conflict',
                  'canvas merged, but the source merge conflicted and was aborted',
                )
              }
              partialValue.state = 'conflicts'
              return this.#success(partialValue, await this.#refreshStatuses(project))
            }
            partialValue.state = canvas.merged || source.merged ? 'merged' : 'up-to-date'
            const anchored = await this.#checkpoint(
              project,
              input.targetBranch,
              `source-merge-${input.sourceBranch}`,
            )
            partialValue.canvasEnvelope = anchored.canvas
          } else {
            partialValue.state = canvas.merged ? 'merged' : 'up-to-date'
          }
          return this.#success(partialValue, await this.#refreshStatuses(project))
        } catch (error) {
          return this.#failure(
            error,
            await this.#refreshStatuses(project),
            partialValue?.canvas.merged === true || partialValue?.source?.merged === true,
            partialValue,
            sourceFailed,
          )
        }
      },
    )
  }

  async sourceStatus(projectDir = '.'): Promise<SourceGitStatus> {
    const project = await this.#project(projectDir)
    const source = await safeSourceStatus(project.sourceGit)
    project.source = source
    return source
  }

  async bindSource(
    projectDir: string,
    logicalBranch = 'main',
  ): Promise<WorkspaceOperationResult<SourceBranchBinding>> {
    return this.#sourceOperation(
      projectDir,
      (source) => source.bind(logicalBranch),
      [logicalBranch],
    )
  }

  async createSourceBranch(
    projectDir: string,
    logicalBranch: string,
    fromLogicalBranch: string,
  ): Promise<WorkspaceOperationResult<SourceBranchBinding>> {
    return this.#sourceOperation(
      projectDir,
      (source) => source.createBranch(logicalBranch, fromLogicalBranch),
      [logicalBranch, fromLogicalBranch],
    )
  }

  async sourceBranch(
    projectDir: string,
    logicalBranch: string,
  ): Promise<WorkspaceOperationResult<SourceBranchBinding | null>> {
    return this.#sourceOperation(projectDir, (source) => source.branch(logicalBranch))
  }

  /** Returns only a revalidated managed worktree; unbound projects stay read-only. */
  async sourceExecutionProjectDir(
    projectDir: string,
    logicalBranch: string,
  ): Promise<string | null> {
    const project = await this.#project(projectDir)
    const status = await project.sourceGit.status()
    project.source = status
    if (status.status === 'unavailable' || status.status === 'unbound') return null
    if (status.status !== 'ready') {
      throw new WorkspaceVersioningError(
        'source_worktree_unavailable',
        status.reason ?? 'managed source worktree is unavailable',
      )
    }
    const binding = await project.sourceGit.branch(logicalBranch)
    if (!binding) {
      throw new WorkspaceVersioningError(
        'source_branch_not_bound',
        `canvas branch has no managed source worktree: ${logicalBranch}`,
      )
    }
    return binding.projectDir
  }

  async checkpointSource(
    projectDir: string,
    logicalBranch: string,
    options: { runId: string; nodeTitle: string; allowSensitive?: boolean },
  ): Promise<WorkspaceOperationResult<SourceCheckpointResult>> {
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [logicalBranch], async () => {
      let value: SourceCheckpointResult | undefined
      try {
        value = await project.sourceGit.checkpoint(logicalBranch, options)
        // A sensitive preview returns without committing, but the successful
        // second call deliberately keeps `requiresConfirmation: true` so the
        // UI can retain the risk audit. `allowSensitive` therefore also marks
        // a completed checkpoint that must be paired with Canvas history.
        if (!value.requiresConfirmation || options.allowSensitive === true) {
          this.#cancelScheduled(project, logicalBranch)
          await this.#checkpoint(
            project,
            logicalBranch,
            `source-checkpoint-${options.runId}`,
          )
        }
        return this.#success(value, await this.#refreshStatuses(project))
      } catch (error) {
        return this.#failure(
          error,
          await this.#refreshStatuses(project),
          value !== undefined,
          value,
          false,
        )
      }
    })
  }

  close(): Promise<void> {
    this.#closing = true
    if (this.#closePromise) return this.#closePromise
    const pending = [...this.#scheduled.values()]
    for (const scheduled of pending) clearTimeout(scheduled.timer)
    this.#scheduled.clear()
    this.#closePromise = (async () => {
      // A clean shutdown is a durability boundary: debounce coalesces edits
      // during normal work, but must not silently discard the final checkpoint.
      for (const scheduled of pending) {
        const task = this.#withBranchLocks(
          scheduled.project,
          [scheduled.branch],
          () => this.#checkpoint(
            scheduled.project,
            scheduled.branch,
            scheduled.reason,
          ),
        )
          .then(() => this.#refreshStatuses(scheduled.project))
          .catch(() => this.#refreshStatuses(scheduled.project))
          .then(() => undefined)
        this.#checkpointTasks.add(task)
        void task.finally(() => this.#checkpointTasks.delete(task))
      }
      await Promise.allSettled([...this.#checkpointTasks])
      await Promise.allSettled([...this.#branchTails.values()])
      await Promise.allSettled([this.canvases.close(), this.sources.close()])
    })()
    return this.#closePromise
  }

  async #prepareMerge(
    project: ProjectVersionState,
    input: WorkspaceMergeInput,
  ): Promise<PreparedWorkspaceMerge> {
    if (input.sourceBranch === input.targetBranch) {
      throw new WorkspaceVersioningError(
        'invalid_merge',
        'merge source and target branches must be different',
      )
    }
    await this.#reconcileCommittedCanvasMerge(project, input.targetBranch)
    this.#cancelScheduled(project, input.sourceBranch)
    this.#cancelScheduled(project, input.targetBranch)
    const sourceCanvas = await this.#checkpoint(project, input.sourceBranch, 'before-merge')
    const target = await this.#checkpoint(project, input.targetBranch, 'before-merge')
    const canvas = await project.canvasGit.previewMerge(input)

    const sourceStatus = await project.sourceGit.status()
    if (sourceStatus.status === 'degraded') {
      throw new WorkspaceVersioningError(
        'source_degraded',
        sourceStatus.reason ?? 'source Git is degraded',
      )
    }
    const source = sourceStatus.status === 'ready'
      ? await project.sourceGit.previewMerge(input)
      : null
    return {
      targetCanvas: target.canvas,
      preview: {
        state: mergeState(canvas, source),
        canvas,
        source,
        expectation: {
          canvas: {
            sourceCommit: canvas.sourceCommit,
            targetCommit: canvas.targetCommit,
            sourceRevision: sourceCanvas.canvas.revision,
            targetRevision: target.canvas.revision,
          },
          source: source
            ? {
                sourceCommit: source.sourceCommit,
                targetCommit: source.targetCommit,
              }
            : null,
        },
      },
    }
  }

  async #reconcileCommittedCanvasMerge(
    project: ProjectVersionState,
    branch: string,
  ): Promise<void> {
    const runtime = await this.canvases.get(project.projectDir, branch)
    if (runtime.lastCheckpoint === null) return
    const merge = await project.canvasGit.recoverableMergeTip(
      branch,
      runtime.lastCheckpoint,
    )
    if (!merge) return
    const firstParentDocument = parseCanvasDocument(merge.firstParentDocument)
    if (!isDeepStrictEqual(
      mergeRecoveryProjection(runtime.document),
      mergeRecoveryProjection(firstParentDocument),
    )) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `runtime canvas changed after checkpoint and cannot be replaced by recovered merge: ${branch}`,
      )
    }
    const document = parseCanvasDocument(merge.document)
    await this.canvases.applyCheckpoint(
      project.projectDir,
      branch,
      document,
      merge.commit,
      runtime.revision,
    )
  }

  async #assertMergeExpectationCurrent(
    project: ProjectVersionState,
    input: WorkspaceMergeInput,
    expected: WorkspaceMergeExpectation,
  ): Promise<void> {
    assertMergeExpectation(expected)
    const [sourceCanvas, targetCanvas, canvasStatus, sourceStatus] = await Promise.all([
      this.canvases.get(project.projectDir, input.sourceBranch),
      this.canvases.get(project.projectDir, input.targetBranch),
      project.canvasGit.status(),
      project.sourceGit.status(),
    ])
    if (canvasStatus.state !== 'ready') throw staleMergePreview()
    const canvasBranches = await project.canvasGit.listBranches()
    const canvasSource = canvasBranches.find(
      (candidate) => candidate.name === input.sourceBranch,
    )
    const canvasTarget = canvasBranches.find(
      (candidate) => candidate.name === input.targetBranch,
    )
    if (
      sourceCanvas.revision !== expected.canvas.sourceRevision
      || targetCanvas.revision !== expected.canvas.targetRevision
      || sourceCanvas.lastCheckpoint !== expected.canvas.sourceCommit
      || targetCanvas.lastCheckpoint !== expected.canvas.targetCommit
      || canvasSource?.commit !== expected.canvas.sourceCommit
      || canvasTarget?.commit !== expected.canvas.targetCommit
    ) {
      throw staleMergePreview()
    }

    if (expected.source === null) {
      if (sourceStatus.status === 'ready') throw staleMergePreview()
      if (sourceStatus.status === 'degraded') {
        throw new WorkspaceVersioningError(
          'source_degraded',
          sourceStatus.reason ?? 'source Git is degraded',
        )
      }
      return
    }
    if (sourceStatus.status !== 'ready') throw staleMergePreview()
    const sourceBranch = sourceStatus.branches.find(
      (candidate) => candidate.logicalBranch === input.sourceBranch,
    )
    const targetBranch = sourceStatus.branches.find(
      (candidate) => candidate.logicalBranch === input.targetBranch,
    )
    if (
      !sourceBranch
      || !targetBranch
      || sourceBranch.dirty
      || targetBranch.dirty
      || sourceBranch.head !== expected.source.sourceCommit
      || targetBranch.head !== expected.source.targetCommit
    ) {
      throw staleMergePreview()
    }
  }

  async #sourceOperation<T>(
    projectDir: string,
    operation: (source: SourceGitStore) => Promise<T>,
    branches: readonly string[] = [],
  ): Promise<WorkspaceOperationResult<T>> {
    const project = await this.#project(projectDir)
    const execute = async (): Promise<WorkspaceOperationResult<T>> => {
      try {
        const value = await operation(project.sourceGit)
        return this.#success(value, await this.#refreshStatuses(project))
      } catch (error) {
        return this.#failure<T>(error, await this.#refreshStatuses(project), false, undefined, true)
      }
    }
    return branches.length > 0
      ? this.#withBranchLocks(project, branches, execute)
      : execute()
  }

  async #checkpoint(
    project: ProjectVersionState,
    branch: string,
    reason: string,
  ): Promise<WorkspaceCheckpoint> {
    let conflict: CanvasRevisionConflictError | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const canvas = await this.canvases.get(project.projectDir, branch)
      const [source, metadata] = await Promise.all([
        this.#sourceMetadataForCheckpoint(project, branch),
        buildCheckpointMetadata({
          projectDir: project.projectDir,
          branch,
          document: canvas.document,
          loadRunSummary: async ({ projectDir, runId }) => {
            const summary = await project.runLogs.summary(runId)
            return summary ? { projectDir, summary } : null
          },
        }),
      ])
      const checkpoint = await project.canvasGit.checkpoint({
        branch,
        document: canvas.document,
        reason,
        source,
        runs: metadata.runs,
        runIndex: metadata.runIndex,
        artifacts: metadata.artifacts,
        artifactIndex: metadata.artifactIndex,
      })
      try {
        const updated = await this.canvases.setLastCheckpoint(
          project.projectDir,
          branch,
          canvas.revision,
          checkpoint.commit,
        )
        return { canvas: updated, checkpoint }
      } catch (error) {
        if (!(error instanceof CanvasRevisionConflictError)) throw error
        conflict = error
      }
    }
    throw conflict ?? new CanvasRevisionConflictError(-1)
  }

  async #sourceMetadataForCheckpoint(
    project: ProjectVersionState,
    branch: string,
  ): Promise<CanvasGitSourceMetadata | null> {
    const status = await project.sourceGit.status()
    if (status.status === 'degraded') {
      throw new WorkspaceVersioningError(
        'source_degraded',
        status.reason ?? 'source Git is degraded',
      )
    }
    if (status.status !== 'ready') return null
    const binding = status.branches.find((candidate) => candidate.logicalBranch === branch)
    return binding ? { version: 1, commit: binding.head } : null
  }

  #scheduleCheckpoint(project: ProjectVersionState, branch: string, reason: string): void {
    if (this.#closing) return
    const key = branchKey(project.projectDir, branch)
    const prior = this.#scheduled.get(key)
    if (prior) clearTimeout(prior.timer)
    const timer = setTimeout(() => {
      const scheduled = this.#scheduled.get(key)
      if (!scheduled || scheduled.timer !== timer) return
      this.#scheduled.delete(key)
      const task = this.#withBranchLocks(
        project,
        [branch],
        () => this.#checkpoint(project, branch, scheduled.reason),
      )
        .then(() => this.#refreshStatuses(project))
        .catch(() => this.#refreshStatuses(project))
        .then(() => undefined)
      this.#checkpointTasks.add(task)
      void task.finally(() => this.#checkpointTasks.delete(task))
    }, this.#checkpointDelayMs)
    timer.unref?.()
    this.#scheduled.set(key, { timer, reason, project, branch })
  }

  #cancelScheduled(project: ProjectVersionState, branch: string): void {
    const key = branchKey(project.projectDir, branch)
    const scheduled = this.#scheduled.get(key)
    if (!scheduled) return
    clearTimeout(scheduled.timer)
    this.#scheduled.delete(key)
  }

  async #withBranchLocks<T>(
    project: ProjectVersionState,
    branches: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(branches.map((branch) => branchKey(project.projectDir, branch)))]
      .sort()
    const predecessors = keys.map((key) => this.#branchTails.get(key) ?? Promise.resolve())
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = Promise.all(predecessors).then(() => undefined)
    const tail = ready.then(() => gate)
    for (const key of keys) this.#branchTails.set(key, tail)

    await ready
    try {
      return await operation()
    } finally {
      release()
      for (const key of keys) {
        if (this.#branchTails.get(key) === tail) this.#branchTails.delete(key)
      }
    }
  }

  async #canvasBranch(
    project: ProjectVersionState,
    branch: string,
  ): Promise<CanvasGitBranch | null> {
    const status = await project.canvasGit.status()
    if (status.state === 'degraded') {
      throw new WorkspaceVersioningError(
        'canvas_degraded',
        status.reason,
      )
    }
    if (status.state === 'uninitialized') return null
    return (await project.canvasGit.listBranches())
      .find((candidate) => candidate.name === branch) ?? null
  }

  async #sourceBranchLayers(
    project: ProjectVersionState,
    fromBranch: string,
    targetBranch: string,
    options: { requireFromWhenTargetMissing?: boolean } = {},
  ): Promise<SourceBranchLayers> {
    const status = await project.sourceGit.status()
    if (status.status === 'degraded') {
      throw new WorkspaceVersioningError(
        'source_degraded',
        status.reason ?? 'source Git is degraded',
      )
    }
    if (status.status !== 'ready') return { status, from: null, target: null }
    const from = status.branches.find((candidate) => candidate.logicalBranch === fromBranch) ?? null
    const target = status.branches.find(
      (candidate) => candidate.logicalBranch === targetBranch,
    ) ?? null
    if (!target && options.requireFromWhenTargetMissing !== false) {
      if (!from) {
        throw new WorkspaceVersioningError(
          'invariant_conflict',
          `source branch is missing for canvas branch ${fromBranch}`,
        )
      }
      if (from.dirty) {
        throw new SourceGitError(
          'worktree_dirty',
          `source worktree must be clean before branching: ${fromBranch}`,
        )
      }
    }
    return { status, from, target }
  }

  #assertBranchLayerConsistency(
    branchName: string,
    branch: CanvasGitBranch | null,
    canvas: CanvasEnvelope,
    sourceBranch: SourceBranchBinding | null,
  ): void {
    if (!branch && (canvas.revision > 0 || sourceBranch)) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `branch layers disagree because canvas Git branch is missing: ${branchName}`,
      )
    }
    if (branch && canvas.revision > 0 && canvas.lastCheckpoint === null) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `runtime canvas has no checkpoint for existing branch: ${branchName}`,
      )
    }
  }

  #assertManagedCanvasBranch(branchName: string, branch: CanvasGitBranch): void {
    if (
      !branch.worktree
      || !branch.worktree.managed
      || branch.worktree.branch !== branchName
    ) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `canvas branch has no matching managed worktree: ${branchName}`,
      )
    }
  }

  #assertRuntimeMatchesCanvasBranch(
    branchName: string,
    branch: CanvasGitBranch,
    canvas: CanvasEnvelope,
  ): void {
    if (canvas.lastCheckpoint === null) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `runtime canvas has no checkpoint for existing branch: ${branchName}`,
      )
    }
    if (
      canvas.revision === 1
      && canvas.lastMutationId === null
      && canvas.lastCheckpoint !== branch.commit
    ) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `materialized runtime canvas points at another checkpoint: ${branchName}`,
      )
    }
  }

  async #project(requestedProjectDir: string): Promise<ProjectVersionState> {
    if (this.#closing) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
    const projectDir = await this.canvases.acquireProjectLease(requestedProjectDir)
    let project = this.#projects.get(projectDir)
    if (!project) {
      project = (async () => ({
        projectDir,
        canvasGit: this.#canvasGitFactory(projectDir),
        runLogs: new RunLogStore(projectDir),
        sourceGit: await this.sources.store(projectDir),
        versioning: null,
        source: null,
      }))()
      this.#projects.set(projectDir, project)
    }
    return project
  }

  async #cachedStatuses(project: ProjectVersionState): Promise<WorkspaceStatuses> {
    if (project.versioning && project.source) {
      return { versioning: project.versioning, source: project.source }
    }
    return this.#refreshStatuses(project)
  }

  async #refreshStatuses(project: ProjectVersionState): Promise<WorkspaceStatuses> {
    const [versioning, source] = await Promise.all([
      safeCanvasStatus(project.canvasGit),
      safeSourceStatus(project.sourceGit),
    ])
    project.versioning = versioning
    project.source = source
    return { versioning, source }
  }

  #success<T>(value: T, statuses: WorkspaceStatuses): WorkspaceOperationResult<T> {
    return {
      ok: true,
      partial: false,
      sourceDegraded: false,
      value,
      ...statuses,
    }
  }

  #failure<T>(
    error: unknown,
    statuses: WorkspaceStatuses,
    partial = false,
    value?: T,
    sourceDegraded = false,
  ): WorkspaceOperationResult<T> {
    return {
      ok: false,
      partial,
      sourceDegraded: sourceDegraded || statuses.source.status === 'degraded',
      error: workspaceError(error),
      ...(value === undefined ? {} : { value }),
      ...statuses,
    }
  }
}

class WorkspaceVersioningError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceVersioningError'
    this.code = code
  }
}

function branchKey(projectDir: string, branch: string): string {
  return `${projectDir}\0${branch}`
}

function canonicalFullGitCommit(value: string): string {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)
    ? value.toLowerCase()
    : value
}

function mergeRecoveryProjection(document: ReturnType<typeof parseCanvasDocument>): unknown {
  return JSON.parse(JSON.stringify({
    ...document,
    generationByNodeId: {},
  })) as unknown
}

function mergeState(canvas: GitMergePreview, source: GitMergePreview | null): GitMergeState {
  if (canvas.state === 'conflicts' || source?.state === 'conflicts') return 'conflicts'
  if (canvas.state === 'ready' || source?.state === 'ready') return 'ready'
  return 'up-to-date'
}

function unexecutedMerge(preview: GitMergePreview): GitMergeExecution {
  return {
    ...preview,
    merged: false,
    commit: preview.targetCommit,
  }
}

function assertMergeExpectation(expected: WorkspaceMergeExpectation): void {
  if (!isRecord(expected) || !isRecord(expected.canvas)) {
    throw invalidMergeExpectation()
  }
  const canvas = expected.canvas
  if (
    !isFullGitCommit(canvas.sourceCommit)
    || !isFullGitCommit(canvas.targetCommit)
    || !isRevision(canvas.sourceRevision)
    || !isRevision(canvas.targetRevision)
  ) {
    throw invalidMergeExpectation()
  }
  if (
    expected.source !== null
    && (
      !isRecord(expected.source)
      || !isFullGitCommit(expected.source.sourceCommit)
      || !isFullGitCommit(expected.source.targetCommit)
    )
  ) {
    throw invalidMergeExpectation()
  }
}

function sameMergeExpectation(
  current: WorkspaceMergeExpectation,
  expected: WorkspaceMergeExpectation,
): boolean {
  return current.canvas.sourceCommit === expected.canvas.sourceCommit
    && current.canvas.targetCommit === expected.canvas.targetCommit
    && current.canvas.sourceRevision === expected.canvas.sourceRevision
    && current.canvas.targetRevision === expected.canvas.targetRevision
    && (
      current.source === null && expected.source === null
      || current.source !== null
        && expected.source !== null
        && current.source.sourceCommit === expected.source.sourceCommit
        && current.source.targetCommit === expected.source.targetCommit
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFullGitCommit(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function invalidMergeExpectation(): WorkspaceVersioningError {
  return new WorkspaceVersioningError(
    'invalid_merge_expectation',
    'merge execution requires the exact expectation returned by preview',
  )
}

function staleMergePreview(): WorkspaceVersioningError {
  return new WorkspaceVersioningError(
    'merge_preview_stale',
    'canvas or source state changed after merge preview; preview the merge again',
  )
}

async function safeCanvasStatus(store: CanvasGitStore): Promise<CanvasGitStatus> {
  try {
    return await store.status()
  } catch (error) {
    return {
      state: 'degraded',
      initialized: false,
      gitAvailable: !(error instanceof CanvasGitError && error.code === 'GIT_UNAVAILABLE'),
      reason: errorMessage(error),
    }
  }
}

async function safeSourceStatus(store: SourceGitStore): Promise<SourceGitStatus> {
  try {
    return await store.status()
  } catch (error) {
    return { status: 'degraded', reason: errorMessage(error), branches: [] }
  }
}

function workspaceError(error: unknown): WorkspaceOperationError {
  const code = error instanceof CanvasGitError
    || error instanceof SourceGitError
    || error instanceof WorkspaceVersioningError
    || error instanceof ProtocolError
    ? error.code
    : error instanceof CanvasRevisionConflictError
      ? 'canvas_revision_conflict'
      : 'versioning_failed'
  return { code, message: errorMessage(error) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
