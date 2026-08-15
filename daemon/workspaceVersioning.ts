import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  applyCanvasCommand,
  CanvasCommandError,
  type CanvasCommand,
} from '../src/canvas/commands.js'
import type { CanvasDocument } from '../src/canvas/model.js'
import {
  CanvasMutationReuseError,
  CanvasRevisionConflictError,
  CanvasSnapshotError,
  type CanvasEnvelope,
} from './canvasCommandStore.js'
import {
  CanvasGitStore,
  CanvasGitError,
  type CanvasGitBranch,
  type CanvasGitCheckpointResult,
  type CanvasGitHistoryOptions,
  type CanvasGitHistoryPage,
  type CanvasGitRestoreInput,
  type CanvasGitStatus,
} from './canvasGit.js'
import type { GitMergeExecution, GitMergePreview, GitMergeState } from './mergeTypes.js'
import { createProjectScope } from './permissions.js'
import { parseCanvasBranch, ProtocolError } from './protocol.js'

const DEFAULT_CHECKPOINT_DELAY_MS = 3_000

/** Minimal runtime boundary required by the version coordinator. */
export interface WorkspaceCanvasStoreManager {
  acquireProjectLease(projectDir: string): Promise<string>
  hasSnapshot(projectDir: string, branch: string): Promise<boolean>
  get(projectDir: string, branch: string): Promise<CanvasEnvelope>
  readRevision(
    projectDir: string,
    branch: string,
    revision: number,
  ): Promise<CanvasDocument | null>
  commit(
    projectDir: string,
    branch: string,
    baseRevision: number,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<CanvasEnvelope>
  commitLatest(
    projectDir: string,
    branch: string,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<CanvasEnvelope>
  setLastCheckpoint(
    projectDir: string,
    branch: string,
    expectedRevision: number,
    commit: string,
  ): Promise<CanvasEnvelope>
  materialize(
    projectDir: string,
    branch: string,
    document: CanvasDocument,
    checkpoint: string,
  ): Promise<CanvasEnvelope>
  applyCheckpoint(
    projectDir: string,
    branch: string,
    document: CanvasDocument,
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelope>
}

export interface WorkspaceVersionManagerOptions {
  projectRoot: string
  canvasStoreManager: WorkspaceCanvasStoreManager
  checkpointDelayMs?: number
  canvasGitFactory?: (canonicalProjectDir: string) => CanvasGitStore
}

export interface WorkspaceStatuses {
  versioning: CanvasGitStatus
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
      value: T
    })
  | (WorkspaceStatuses & {
      ok: false
      partial: boolean
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

export interface WorkspaceConflictMutation {
  mutationId: string
  command: CanvasCommand
}

export interface WorkspaceSaveConflictBranchInput {
  sourceBranch: string
  newBranch: string
  baseRevision: number
  mutations: WorkspaceConflictMutation[]
}

export interface WorkspaceConflictBranch extends WorkspaceBranch {
  sourceBranch: string
  baseRevision: number
  mutationIds: string[]
}

export interface WorkspaceBranch {
  branch: CanvasGitBranch
  canvas: CanvasEnvelope
}

export interface WorkspaceMergeInput {
  sourceBranch: string
  targetBranch: string
}

export interface WorkspaceMergeExpectation {
  sourceCommit: string
  targetCommit: string
  sourceRevision: number
  targetRevision: number
}

export interface WorkspaceMergePreview {
  state: GitMergeState
  canvas: GitMergePreview
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
  canvasEnvelope?: CanvasEnvelope
}

interface ProjectVersionState {
  projectDir: string
  canvasGit: CanvasGitStore
  versioning: CanvasGitStatus | null
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

/**
 * Coordinates authoritative Canvas commands with normalized Canvas-only Git
 * history. Source files, Run runtime, logs, sessions, and view state never enter
 * this history layer.
 */
export class WorkspaceVersionManager {
  readonly canvases: WorkspaceCanvasStoreManager

  readonly #projectRoot: string
  readonly #checkpointDelayMs: number
  readonly #canvasGitFactory: (canonicalProjectDir: string) => CanvasGitStore
  readonly #projects = new Map<string, Promise<ProjectVersionState>>()
  readonly #scheduled = new Map<string, ScheduledCheckpoint>()
  readonly #checkpointTasks = new Set<Promise<void>>()
  readonly #branchTails = new Map<string, Promise<void>>()
  readonly #projectDeletionReservations = new Set<string>()
  readonly #deletedProjects = new Set<string>()
  #closing = false
  #closePromise: Promise<void> | null = null

  constructor(options: WorkspaceVersionManagerOptions) {
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#checkpointDelayMs = options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS
    if (!Number.isFinite(this.#checkpointDelayMs) || this.#checkpointDelayMs < 0) {
      throw new TypeError('checkpointDelayMs must be a non-negative finite number')
    }
    this.canvases = options.canvasStoreManager
    this.#canvasGitFactory = options.canvasGitFactory
      ?? ((projectDir) => new CanvasGitStore(projectDir))
  }

  async getCanvas(projectDir = '.', branchRequest = 'main'): Promise<WorkspaceCanvasResult> {
    const branch = parseCanvasBranch(branchRequest)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branch], async () => {
      const canvas = await this.#loadBranchCanvas(project, branch)
      return { canvas, ...await this.#refreshStatuses(project) }
    })
  }

  async commitCanvas(
    projectDir: string,
    branchRequest: string,
    baseRevision: number,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<WorkspaceCanvasResult> {
    const branch = parseCanvasBranch(branchRequest)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branch], async () => {
      const current = await this.#loadBranchCanvas(project, branch)
      if (isDestructiveCanvasCommand(command) && current.revision === baseRevision) {
        // Validate before touching Git, then make the exact pre-delete state
        // recoverable even when the normal debounced checkpoint has not fired.
        applyCanvasCommand(current.document, command)
        this.#cancelScheduled(project, branch)
        await this.#checkpoint(project, branch, `before-${command.type}`)
      }
      const canvas = await this.canvases.commit(
        project.projectDir,
        branch,
        baseRevision,
        mutationId,
        command,
      )
      this.#scheduleCheckpoint(project, branch, `command-${command.type}`)
      return { canvas, ...await this.#cachedStatuses(project) }
    })
  }

  /** Daemon-only command path for trusted projection settlement. */
  async commitLatestCanvas(
    projectDir: string,
    branchRequest: string,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<WorkspaceCanvasResult> {
    const branch = parseCanvasBranch(branchRequest)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branch], async () => {
      await this.#loadBranchCanvas(project, branch)
      const canvas = await this.canvases.commitLatest(
        project.projectDir,
        branch,
        mutationId,
        command,
      )
      this.#scheduleCheckpoint(project, branch, `trusted-${command.type}`)
      return { canvas, ...await this.#cachedStatuses(project) }
    })
  }

  async status(projectDir = '.'): Promise<WorkspaceStatuses> {
    return this.#refreshStatuses(await this.#project(projectDir))
  }

  async manualCheckpoint(
    projectDir: string,
    branchRequest: string,
    reason = 'manual',
  ): Promise<WorkspaceOperationResult<WorkspaceCheckpoint>> {
    const branch = parseCanvasBranch(branchRequest)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branch], async () => {
      this.#cancelScheduled(project, branch)
      try {
        await this.#loadBranchCanvas(project, branch)
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
    const name = parseCanvasBranch(input.name)
    const fromBranch = parseCanvasBranch(input.fromBranch ?? 'main')
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [fromBranch, name], async () => {
      let branch: CanvasGitBranch | null = null
      let canvas: CanvasEnvelope | null = null
      let partial = false
      try {
        if (name === fromBranch) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            'new Canvas branch must differ from its source branch',
          )
        }
        this.#cancelScheduled(project, name)
        await this.#reconcileCommittedCanvasMerge(project, name)
        branch = await this.#canvasBranch(project, name)
        canvas = await this.canvases.get(project.projectDir, name)
        partial = branch !== null || canvas.revision > 0
        this.#assertBranchLayerConsistency(name, branch, canvas)

        if (!branch) {
          this.#cancelScheduled(project, fromBranch)
          await this.#loadBranchCanvas(project, fromBranch)
          const source = await this.#checkpoint(project, fromBranch, 'branch-created')
          branch = await project.canvasGit.createBranch({
            name,
            startPoint: source.checkpoint.commit,
          })
          partial = true
        }
        this.#assertManagedBranch(name, branch)
        if (canvas.revision === 0) {
          const document = await project.canvasGit.readDocument(branch.commit)
          canvas = await this.canvases.materialize(
            project.projectDir,
            name,
            document,
            branch.commit,
          )
          partial = true
        } else {
          canvas = await this.#alignRuntimeAnchor(project, branch, canvas)
        }
        return this.#success({ branch, canvas }, await this.#refreshStatuses(project))
      } catch (error) {
        const value = branch && canvas ? { branch, canvas } : undefined
        return this.#failure(
          error,
          await this.#refreshStatuses(project),
          partial,
          value,
        )
      }
    })
  }

  async switchBranch(
    projectDir: string,
    branchRequest: string,
  ): Promise<WorkspaceOperationResult<WorkspaceBranch>> {
    const branchName = parseCanvasBranch(branchRequest)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branchName], async () => {
      try {
        this.#cancelScheduled(project, branchName)
        const branch = await this.#requireCanvasBranch(project, branchName)
        const canvas = await this.#loadBranchCanvas(project, branchName)
        return this.#success({ branch, canvas }, await this.#refreshStatuses(project))
      } catch (error) {
        return this.#failure(error, await this.#refreshStatuses(project))
      }
    })
  }

  /**
   * Replays a browser command journal from its daemon-owned historical base
   * into a new branch. The browser never supplies a Canvas snapshot.
   */
  async saveConflictBranch(
    projectDir: string,
    input: WorkspaceSaveConflictBranchInput,
  ): Promise<WorkspaceOperationResult<WorkspaceConflictBranch>> {
    const sourceBranch = parseCanvasBranch(input.sourceBranch)
    const newBranch = parseCanvasBranch(input.newBranch)
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
      throw new TypeError('conflict baseRevision must be a non-negative safe integer')
    }
    if (!Array.isArray(input.mutations)
      || input.mutations.length === 0
      || input.mutations.length > 500) {
      throw new TypeError('conflict recovery requires 1 to 500 mutations')
    }
    const mutationIds = input.mutations.map((mutation) => mutation.mutationId)
    if (new Set(mutationIds).size !== mutationIds.length) {
      throw new TypeError('conflict recovery mutation ids must be unique')
    }
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [sourceBranch, newBranch], async () => {
      let branch: CanvasGitBranch | null = null
      let canvas: CanvasEnvelope | null = null
      let partial = false
      try {
        if (newBranch === sourceBranch) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            'conflict recovery branch must differ from its source branch',
          )
        }
        const baseDocument = await this.canvases.readRevision(
          project.projectDir,
          sourceBranch,
          input.baseRevision,
        )
        if (!baseDocument) {
          throw new WorkspaceVersioningError(
            'conflict_base_unavailable',
            `Canvas revision ${input.baseRevision} is unavailable on ${sourceBranch}`,
          )
        }
        let recoveredDocument = baseDocument
        for (const mutation of input.mutations) {
          recoveredDocument = applyCanvasCommand(recoveredDocument, mutation.command)
        }

        this.#cancelScheduled(project, newBranch)
        await this.#reconcileCommittedCanvasMerge(project, newBranch)
        branch = await this.#canvasBranch(project, newBranch)
        canvas = await this.canvases.get(project.projectDir, newBranch)
        partial = branch !== null || canvas.revision > 0
        this.#assertBranchLayerConsistency(newBranch, branch, canvas)

        if (!branch) {
          this.#cancelScheduled(project, sourceBranch)
          await this.#loadBranchCanvas(project, sourceBranch)
          const source = await this.#checkpoint(project, sourceBranch, 'before-conflict-recovery')
          branch = await project.canvasGit.createBranch({
            name: newBranch,
            startPoint: source.checkpoint.commit,
          })
          partial = true
        }
        this.#assertManagedBranch(newBranch, branch)

        const gitDocument = await project.canvasGit.readDocument(branch.commit)
        if (!isDeepStrictEqual(gitDocument, recoveredDocument)) {
          if (canvas.revision > 0 && !isDeepStrictEqual(canvas.document, recoveredDocument)) {
            throw new WorkspaceVersioningError(
              'invariant_conflict',
              `existing conflict branch contains another recovery: ${newBranch}`,
            )
          }
          await project.canvasGit.checkpoint({
            branch: newBranch,
            document: recoveredDocument,
            reason: `conflict-recovery-${input.baseRevision}`,
          })
          branch = await this.#requireCanvasBranch(project, newBranch)
        }

        if (canvas.revision === 0) {
          canvas = await this.canvases.materialize(
            project.projectDir,
            newBranch,
            recoveredDocument,
            branch.commit,
          )
          partial = true
        } else {
          if (!isDeepStrictEqual(canvas.document, recoveredDocument)) {
            throw new WorkspaceVersioningError(
              'invariant_conflict',
              `existing conflict branch contains another recovery: ${newBranch}`,
            )
          }
          canvas = await this.#alignRuntimeAnchor(project, branch, canvas)
        }

        return this.#success({
          sourceBranch,
          baseRevision: input.baseRevision,
          mutationIds,
          branch,
          canvas,
        }, await this.#refreshStatuses(project))
      } catch (error) {
        const value = branch && canvas ? {
          sourceBranch,
          baseRevision: input.baseRevision,
          mutationIds,
          branch,
          canvas,
        } : undefined
        return this.#failure(
          error,
          await this.#refreshStatuses(project),
          partial,
          value,
        )
      }
    })
  }

  async restoreAsNewBranch(
    projectDir: string,
    input: CanvasGitRestoreInput,
  ): Promise<WorkspaceOperationResult<WorkspaceBranch>> {
    const sourceBranch = parseCanvasBranch(input.sourceBranch)
    const newBranch = parseCanvasBranch(input.newBranch)
    const checkpoint = canonicalFullGitCommit(input.checkpoint)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [sourceBranch, newBranch], async () => {
      let branch: CanvasGitBranch | null = null
      let canvas: CanvasEnvelope | null = null
      let partial = false
      try {
        if (newBranch === sourceBranch) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            'restored Canvas branch must differ from its history branch',
          )
        }
        this.#cancelScheduled(project, newBranch)
        await this.#reconcileCommittedCanvasMerge(project, newBranch)
        branch = await this.#canvasBranch(project, newBranch)
        canvas = await this.canvases.get(project.projectDir, newBranch)
        partial = branch !== null || canvas.revision > 0
        this.#assertBranchLayerConsistency(newBranch, branch, canvas)
        if (branch && branch.commit !== checkpoint) {
          throw new WorkspaceVersioningError(
            'invariant_conflict',
            `existing restore branch points at another checkpoint: ${newBranch}`,
          )
        }

        if (!branch) {
          this.#cancelScheduled(project, sourceBranch)
          await this.#loadBranchCanvas(project, sourceBranch)
          await this.#checkpoint(project, sourceBranch, 'before-restore')
          branch = await project.canvasGit.restoreAsNewBranch({
            sourceBranch,
            checkpoint,
            newBranch,
          })
          partial = true
        }
        this.#assertManagedBranch(newBranch, branch)
        if (canvas.revision === 0) {
          const document = await project.canvasGit.readDocument(branch.commit)
          canvas = await this.canvases.materialize(
            project.projectDir,
            newBranch,
            document,
            branch.commit,
          )
          partial = true
        } else {
          canvas = await this.#alignRuntimeAnchor(project, branch, canvas)
        }
        return this.#success({ branch, canvas }, await this.#refreshStatuses(project))
      } catch (error) {
        const value = branch && canvas ? { branch, canvas } : undefined
        return this.#failure(
          error,
          await this.#refreshStatuses(project),
          partial,
          value,
        )
      }
    })
  }

  async previewMerge(
    projectDir: string,
    input: WorkspaceMergeInput,
  ): Promise<WorkspaceOperationResult<WorkspaceMergePreview>> {
    const parsed = parseMergeInput(input)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(
      project,
      [parsed.sourceBranch, parsed.targetBranch],
      async () => {
        try {
          const prepared = await this.#prepareMerge(project, parsed)
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
    const parsed = parseMergeInput(input)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(
      project,
      [parsed.sourceBranch, parsed.targetBranch],
      async () => {
        let partialValue: WorkspaceMergeExecution | undefined
        try {
          if (!input.confirmed) {
            throw new WorkspaceVersioningError(
              'merge_confirmation_required',
              'Canvas merge execution requires explicit confirmation',
            )
          }
          await this.#assertMergeExpectationCurrent(project, parsed, input.expected)
          const prepared = await this.#prepareMerge(project, parsed)
          if (!sameMergeExpectation(prepared.preview.expectation, input.expected)) {
            throw staleMergePreview()
          }
          if (prepared.preview.state === 'conflicts') {
            const value: WorkspaceMergeExecution = {
              state: 'conflicts',
              canvas: unexecutedMerge(prepared.preview.canvas),
              canvasEnvelope: prepared.targetCanvas,
            }
            return this.#success(value, await this.#refreshStatuses(project))
          }

          const canvas = await project.canvasGit.merge(parsed)
          if (canvas.state === 'conflicts') {
            const value: WorkspaceMergeExecution = {
              state: 'conflicts',
              canvas,
              canvasEnvelope: prepared.targetCanvas,
            }
            return this.#success(value, await this.#refreshStatuses(project))
          }

          partialValue = {
            state: canvas.merged ? 'partial' : 'up-to-date',
            canvas,
            canvasEnvelope: prepared.targetCanvas,
          }
          if (canvas.commit !== prepared.targetCanvas.lastCheckpoint) {
            const document = await project.canvasGit.readDocument(canvas.commit)
            partialValue.canvasEnvelope = await this.canvases.applyCheckpoint(
              project.projectDir,
              parsed.targetBranch,
              document,
              canvas.commit,
              prepared.targetCanvas.revision,
            )
          }
          partialValue.state = canvas.merged ? 'merged' : 'up-to-date'
          return this.#success(partialValue, await this.#refreshStatuses(project))
        } catch (error) {
          return this.#failure(
            error,
            await this.#refreshStatuses(project),
            partialValue?.canvas.merged === true,
            partialValue,
          )
        }
      },
    )
  }

  /**
   * Task runs do not require a compatibility source-branch binding. The returned project
   * root has passed the same project lease/scope checks as Canvas persistence.
   * A non-default branch must already exist in runtime or managed Git metadata;
   * the check never constructs an empty runtime envelope.
   */
  async sourceExecutionProjectDir(
    projectDir: string,
    branchRequest = 'main',
  ): Promise<string> {
    const branch = parseCanvasBranch(branchRequest)
    const project = await this.#project(projectDir)
    // The default branch remains runnable when optional Canvas Git history is
    // unavailable; authoritative Run and Canvas durability do not depend on Git.
    if (branch === 'main'
      || await this.canvases.hasSnapshot(project.projectDir, branch)) {
      return project.projectDir
    }
    await this.#queryableBranch(project, branch)
    return project.projectDir
  }

  /** Blocks new versioning work and drains every queued branch operation. */
  async beginProjectDeletion(projectDirRequest: string): Promise<string> {
    const project = await this.#project(projectDirRequest)
    if (
      this.#projectDeletionReservations.has(project.projectDir)
      || this.#deletedProjects.has(project.projectDir)
    ) {
      throw new ProtocolError('workspace project is busy', 'project_busy', 409)
    }
    this.#projectDeletionReservations.add(project.projectDir)
    try {
      for (const [key, scheduled] of this.#scheduled) {
        if (scheduled.project.projectDir !== project.projectDir) continue
        clearTimeout(scheduled.timer)
        this.#scheduled.delete(key)
      }
      const prefix = `${project.projectDir}\0`
      await Promise.allSettled(
        [...this.#branchTails.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, tail]) => tail),
      )
      return project.projectDir
    } catch (error) {
      this.#projectDeletionReservations.delete(project.projectDir)
      throw error
    }
  }

  finishProjectDeletion(projectDir: string, deleted: boolean): void {
    this.#projectDeletionReservations.delete(projectDir)
    if (!deleted) return
    this.#projects.delete(projectDir)
    this.#deletedProjects.add(projectDir)
  }

  /** Flushes debounced history but leaves the injected Canvas manager owned by its caller. */
  close(): Promise<void> {
    this.#closing = true
    if (this.#closePromise) return this.#closePromise
    const pending = [...this.#scheduled.values()]
    for (const scheduled of pending) clearTimeout(scheduled.timer)
    this.#scheduled.clear()
    this.#closePromise = (async () => {
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
        this.#trackCheckpointTask(task)
      }
      await Promise.allSettled([...this.#checkpointTasks])
      await Promise.allSettled([...this.#branchTails.values()])
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
        'Canvas merge source and target branches must be different',
      )
    }
    await Promise.all([
      this.#queryableBranch(project, input.sourceBranch),
      this.#queryableBranch(project, input.targetBranch),
    ])
    await this.#reconcileCommittedCanvasMerge(project, input.sourceBranch)
    await this.#reconcileCommittedCanvasMerge(project, input.targetBranch)
    this.#cancelScheduled(project, input.sourceBranch)
    this.#cancelScheduled(project, input.targetBranch)
    const source = await this.#checkpoint(project, input.sourceBranch, 'before-merge')
    const target = await this.#checkpoint(project, input.targetBranch, 'before-merge')
    const canvas = await project.canvasGit.previewMerge(input)
    return {
      targetCanvas: target.canvas,
      preview: {
        state: canvas.state,
        canvas,
        expectation: {
          sourceCommit: canvas.sourceCommit,
          targetCommit: canvas.targetCommit,
          sourceRevision: source.canvas.revision,
          targetRevision: target.canvas.revision,
        },
      },
    }
  }

  async #assertMergeExpectationCurrent(
    project: ProjectVersionState,
    input: WorkspaceMergeInput,
    expected: WorkspaceMergeExpectation,
  ): Promise<void> {
    assertMergeExpectation(expected)
    await Promise.all([
      this.#queryableBranch(project, input.sourceBranch),
      this.#queryableBranch(project, input.targetBranch),
    ])
    const [sourceCanvas, targetCanvas, status] = await Promise.all([
      this.canvases.get(project.projectDir, input.sourceBranch),
      this.canvases.get(project.projectDir, input.targetBranch),
      project.canvasGit.status(),
    ])
    if (status.state !== 'ready') throw staleMergePreview()
    const branches = await project.canvasGit.listBranches()
    const sourceBranch = branches.find((candidate) => candidate.name === input.sourceBranch)
    const targetBranch = branches.find((candidate) => candidate.name === input.targetBranch)
    if (
      sourceCanvas.revision !== expected.sourceRevision
      || targetCanvas.revision !== expected.targetRevision
      || sourceCanvas.lastCheckpoint !== expected.sourceCommit
      || targetCanvas.lastCheckpoint !== expected.targetCommit
      || sourceBranch?.commit !== expected.sourceCommit
      || targetBranch?.commit !== expected.targetCommit
    ) {
      throw staleMergePreview()
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
    if (!isDeepStrictEqual(runtime.document, merge.firstParentDocument)) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `runtime Canvas changed after checkpoint and cannot be replaced: ${branch}`,
      )
    }
    await this.canvases.applyCheckpoint(
      project.projectDir,
      branch,
      merge.document,
      merge.commit,
      runtime.revision,
    )
  }

  async #loadBranchCanvas(
    project: ProjectVersionState,
    branchName: string,
  ): Promise<CanvasEnvelope> {
    const [status, hasSnapshot] = await Promise.all([
      project.canvasGit.status(),
      this.canvases.hasSnapshot(project.projectDir, branchName),
    ])
    project.versioning = status
    if (status.state === 'degraded') {
      if (branchName === 'main' || hasSnapshot) {
        return this.canvases.get(project.projectDir, branchName)
      }
      throw new WorkspaceVersioningError('canvas_degraded', status.reason)
    }
    if (status.state === 'uninitialized') {
      if (branchName === 'main') return this.canvases.get(project.projectDir, branchName)
      if (hasSnapshot) {
        throw new WorkspaceVersioningError(
          'invariant_conflict',
          `runtime Canvas has no matching Git branch: ${branchName}`,
        )
      }
      throw new CanvasGitError(
        'BRANCH_NOT_FOUND',
        `Canvas branch does not exist: ${branchName}`,
      )
    }
    const branch = (await project.canvasGit.listBranches())
      .find((candidate) => candidate.name === branchName)
    if (!branch) {
      if (hasSnapshot) {
        throw new WorkspaceVersioningError(
          'invariant_conflict',
          `runtime Canvas has no matching Git branch: ${branchName}`,
        )
      }
      throw new CanvasGitError(
        'BRANCH_NOT_FOUND',
        `Canvas branch does not exist: ${branchName}`,
      )
    }
    this.#assertManagedBranch(branchName, branch)
    await this.#reconcileCommittedCanvasMerge(project, branchName)
    let runtime = await this.canvases.get(project.projectDir, branchName)
    const currentBranch = await this.#requireCanvasBranch(project, branchName)
    if (runtime.revision === 0) {
      const document = await project.canvasGit.readDocument(currentBranch.commit)
      return this.canvases.materialize(
        project.projectDir,
        branchName,
        document,
        currentBranch.commit,
      )
    }
    runtime = await this.#alignRuntimeAnchor(project, currentBranch, runtime)
    return runtime
  }

  async #alignRuntimeAnchor(
    project: ProjectVersionState,
    branch: CanvasGitBranch,
    runtime: CanvasEnvelope,
  ): Promise<CanvasEnvelope> {
    this.#assertManagedBranch(branch.name, branch)
    if (runtime.lastCheckpoint === branch.commit) return runtime
    const branchDocument = await project.canvasGit.readDocument(branch.commit)
    if (!isDeepStrictEqual(runtime.document, branchDocument)) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `runtime Canvas and Git history disagree for branch: ${branch.name}`,
      )
    }
    return this.canvases.setLastCheckpoint(
      project.projectDir,
      branch.name,
      runtime.revision,
      branch.commit,
    )
  }

  async #checkpoint(
    project: ProjectVersionState,
    branch: string,
    reason: string,
  ): Promise<WorkspaceCheckpoint> {
    let conflict: CanvasRevisionConflictError | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const canvas = await this.canvases.get(project.projectDir, branch)
      const checkpoint = await project.canvasGit.checkpoint({
        branch,
        document: canvas.document,
        reason,
      })
      try {
        const updated = await this.canvases.setLastCheckpoint(
          project.projectDir,
          branch,
          canvas.revision,
          checkpoint.commit,
        )
        project.versioning = checkpoint.status
        return { canvas: updated, checkpoint }
      } catch (error) {
        if (!(error instanceof CanvasRevisionConflictError)) throw error
        conflict = error
      }
    }
    throw conflict ?? new CanvasRevisionConflictError(-1)
  }

  #scheduleCheckpoint(project: ProjectVersionState, branch: string, reason: string): void {
    if (this.#closing || this.#projectDeletionReservations.has(project.projectDir)) return
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
      this.#trackCheckpointTask(task)
    }, this.#checkpointDelayMs)
    timer.unref?.()
    this.#scheduled.set(key, { timer, reason, project, branch })
  }

  #trackCheckpointTask(task: Promise<void>): void {
    this.#checkpointTasks.add(task)
    void task.finally(() => this.#checkpointTasks.delete(task))
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
    if (
      this.#projectDeletionReservations.has(project.projectDir)
      || this.#deletedProjects.has(project.projectDir)
    ) {
      throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
    }
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

  async #queryableBranch(
    project: ProjectVersionState,
    branch: string,
  ): Promise<CanvasGitBranch | null> {
    const status = await project.canvasGit.status()
    project.versioning = status
    if (status.state === 'degraded') {
      throw new WorkspaceVersioningError('canvas_degraded', status.reason)
    }
    if (status.state === 'uninitialized') {
      if (branch === 'main') return null
      throw new CanvasGitError(
        'BRANCH_NOT_FOUND',
        `Canvas branch does not exist: ${branch}`,
      )
    }
    const candidate = (await project.canvasGit.listBranches())
      .find((entry) => entry.name === branch)
    if (!candidate) {
      throw new CanvasGitError(
        'BRANCH_NOT_FOUND',
        `Canvas branch does not exist: ${branch}`,
      )
    }
    this.#assertManagedBranch(branch, candidate)
    return candidate
  }

  async #canvasBranch(
    project: ProjectVersionState,
    branch: string,
  ): Promise<CanvasGitBranch | null> {
    const status = await project.canvasGit.status()
    project.versioning = status
    if (status.state === 'degraded') {
      throw new WorkspaceVersioningError('canvas_degraded', status.reason)
    }
    if (status.state === 'uninitialized') return null
    return (await project.canvasGit.listBranches())
      .find((candidate) => candidate.name === branch) ?? null
  }

  async #requireCanvasBranch(
    project: ProjectVersionState,
    branch: string,
  ): Promise<CanvasGitBranch> {
    const candidate = await this.#canvasBranch(project, branch)
    if (!candidate) {
      throw new CanvasGitError(
        'BRANCH_NOT_FOUND',
        `Canvas branch does not exist: ${branch}`,
      )
    }
    this.#assertManagedBranch(branch, candidate)
    return candidate
  }

  #assertManagedBranch(branchName: string, branch: CanvasGitBranch): void {
    if (!branch.worktree
      || !branch.worktree.managed
      || branch.worktree.branch !== branchName) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `Canvas branch has no matching managed worktree: ${branchName}`,
      )
    }
  }

  #assertBranchLayerConsistency(
    branchName: string,
    branch: CanvasGitBranch | null,
    canvas: CanvasEnvelope,
  ): void {
    if (!branch && canvas.revision > 0) {
      throw new WorkspaceVersioningError(
        'invariant_conflict',
        `Canvas branch layers disagree because Git history is missing: ${branchName}`,
      )
    }
  }

  async #project(requestedProjectDir: string): Promise<ProjectVersionState> {
    if (this.#closing) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
    const leasedProjectDir = await this.canvases.acquireProjectLease(requestedProjectDir)
    const projectDir = (await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: leasedProjectDir,
    })).projectDir
    if (
      this.#projectDeletionReservations.has(projectDir)
      || this.#deletedProjects.has(projectDir)
    ) {
      throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
    }
    let project = this.#projects.get(projectDir)
    if (!project) {
      project = Promise.resolve({
        projectDir,
        canvasGit: this.#canvasGitFactory(projectDir),
        versioning: null,
      })
      this.#projects.set(projectDir, project)
    }
    return project
  }

  async #cachedStatuses(project: ProjectVersionState): Promise<WorkspaceStatuses> {
    return project.versioning
      ? { versioning: project.versioning }
      : this.#refreshStatuses(project)
  }

  async #refreshStatuses(project: ProjectVersionState): Promise<WorkspaceStatuses> {
    const versioning = await safeCanvasStatus(project.canvasGit)
    project.versioning = versioning
    return { versioning }
  }

  #success<T>(
    value: T,
    statuses: WorkspaceStatuses,
  ): WorkspaceOperationResult<T> {
    return { ok: true, partial: false, value, ...statuses }
  }

  #failure<T>(
    error: unknown,
    statuses: WorkspaceStatuses,
    partial = false,
    value?: T,
  ): WorkspaceOperationResult<T> {
    return {
      ok: false,
      partial,
      error: workspaceError(error),
      ...(value === undefined ? {} : { value }),
      ...statuses,
    }
  }
}

export class WorkspaceVersioningError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceVersioningError'
    this.code = code
  }
}

function parseMergeInput(input: WorkspaceMergeInput): WorkspaceMergeInput {
  return {
    sourceBranch: parseCanvasBranch(input.sourceBranch),
    targetBranch: parseCanvasBranch(input.targetBranch),
  }
}

function branchKey(projectDir: string, branch: string): string {
  return `${projectDir}\0${branch}`
}

function canonicalFullGitCommit(value: string): string {
  if (!isFullGitCommit(value)) {
    throw new WorkspaceVersioningError(
      'invalid_checkpoint',
      'Canvas restore requires a full Git checkpoint identifier',
    )
  }
  return value.toLowerCase()
}

function unexecutedMerge(preview: GitMergePreview): GitMergeExecution {
  return { ...preview, merged: false, commit: preview.targetCommit }
}

function assertMergeExpectation(expected: WorkspaceMergeExpectation): void {
  if (!isRecord(expected)
    || !isFullGitCommit(expected.sourceCommit)
    || !isFullGitCommit(expected.targetCommit)
    || !isRevision(expected.sourceRevision)
    || !isRevision(expected.targetRevision)) {
    throw invalidMergeExpectation()
  }
}

function sameMergeExpectation(
  current: WorkspaceMergeExpectation,
  expected: WorkspaceMergeExpectation,
): boolean {
  return current.sourceCommit === expected.sourceCommit
    && current.targetCommit === expected.targetCommit
    && current.sourceRevision === expected.sourceRevision
    && current.targetRevision === expected.targetRevision
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFullGitCommit(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function invalidMergeExpectation(): WorkspaceVersioningError {
  return new WorkspaceVersioningError(
    'invalid_merge_expectation',
    'Canvas merge requires the exact expectation returned by preview',
  )
}

function staleMergePreview(): WorkspaceVersioningError {
  return new WorkspaceVersioningError(
    'merge_preview_stale',
    'Canvas state changed after merge preview; preview the merge again',
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

function workspaceError(error: unknown): WorkspaceOperationError {
  const code = error instanceof CanvasGitError
    || error instanceof WorkspaceVersioningError
    || error instanceof ProtocolError
    ? error.code
    : error instanceof CanvasCommandError
      ? `canvas_command_${error.code}`
    : error instanceof CanvasRevisionConflictError
      ? 'canvas_revision_conflict'
      : error instanceof CanvasMutationReuseError
        ? 'canvas_mutation_reuse'
        : error instanceof CanvasSnapshotError
          ? 'canvas_snapshot_invalid'
          : 'versioning_failed'
  return { code, message: errorMessage(error) }
}

function isDestructiveCanvasCommand(command: CanvasCommand): boolean {
  return command.type === 'DeleteNode'
    || command.type === 'DeleteEdge'
    || command.type === 'DeleteEdges'
    || command.type === 'DissolveCollection'
    || command.type === 'DeleteTask'
    || command.type === 'DeleteTaskAndViews'
    || command.type === 'DeleteCollection'
    || command.type === 'DeleteCollectionAndContents'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
