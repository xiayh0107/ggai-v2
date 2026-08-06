import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  applyCanvasCommandV2,
  CanvasCommandError,
  type CanvasCommandV2,
} from '../src/canvas-v2/commands.js'
import type { CanvasDocumentV2 } from '../src/canvas-v2/model.js'
import {
  CanvasMutationReuseV2Error,
  CanvasRevisionConflictV2Error,
  CanvasSnapshotV2Error,
  type CanvasEnvelopeV2,
} from './canvasCommandStoreV2.js'
import {
  CanvasGitStoreV2,
  CanvasGitV2Error,
  type CanvasGitV2Branch,
  type CanvasGitV2CheckpointResult,
  type CanvasGitV2HistoryOptions,
  type CanvasGitV2HistoryPage,
  type CanvasGitV2RestoreInput,
  type CanvasGitV2Status,
} from './canvasGitV2.js'
import type { GitMergeExecution, GitMergePreview, GitMergeState } from './mergeTypes.js'
import { createProjectScope } from './permissions.js'
import { parseCanvasBranch, ProtocolError } from './protocol.js'

const DEFAULT_CHECKPOINT_DELAY_MS = 3_000

/** Minimal runtime boundary required by the V2 version coordinator. */
export interface WorkspaceCanvasStoreManagerV2 {
  acquireProjectLease(projectDir: string): Promise<string>
  hasSnapshot(projectDir: string, branch: string): Promise<boolean>
  get(projectDir: string, branch: string): Promise<CanvasEnvelopeV2>
  readRevision(
    projectDir: string,
    branch: string,
    revision: number,
  ): Promise<CanvasDocumentV2 | null>
  commit(
    projectDir: string,
    branch: string,
    baseRevision: number,
    mutationId: string,
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2>
  commitLatest(
    projectDir: string,
    branch: string,
    mutationId: string,
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2>
  setLastCheckpoint(
    projectDir: string,
    branch: string,
    expectedRevision: number,
    commit: string,
  ): Promise<CanvasEnvelopeV2>
  materialize(
    projectDir: string,
    branch: string,
    document: CanvasDocumentV2,
    checkpoint: string,
  ): Promise<CanvasEnvelopeV2>
  applyCheckpoint(
    projectDir: string,
    branch: string,
    document: CanvasDocumentV2,
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelopeV2>
}

export interface WorkspaceVersionManagerV2Options {
  projectRoot: string
  canvasStoreManager: WorkspaceCanvasStoreManagerV2
  checkpointDelayMs?: number
  canvasGitFactory?: (canonicalProjectDir: string) => CanvasGitStoreV2
}

export interface WorkspaceStatusesV2 {
  versioning: CanvasGitV2Status
}

export interface WorkspaceCanvasResultV2 extends WorkspaceStatusesV2 {
  canvas: CanvasEnvelopeV2
}

export interface WorkspaceOperationErrorV2 {
  code: string
  message: string
}

export type WorkspaceOperationResultV2<T> =
  | (WorkspaceStatusesV2 & {
      ok: true
      partial: false
      value: T
    })
  | (WorkspaceStatusesV2 & {
      ok: false
      partial: boolean
      error: WorkspaceOperationErrorV2
      value?: T
    })

export interface WorkspaceCheckpointV2 {
  canvas: CanvasEnvelopeV2
  checkpoint: CanvasGitV2CheckpointResult
}

export interface WorkspaceCreateBranchInputV2 {
  name: string
  fromBranch?: string
}

export interface WorkspaceConflictMutationV2 {
  mutationId: string
  command: CanvasCommandV2
}

export interface WorkspaceSaveConflictBranchInputV2 {
  sourceBranch: string
  newBranch: string
  baseRevision: number
  mutations: WorkspaceConflictMutationV2[]
}

export interface WorkspaceConflictBranchV2 extends WorkspaceBranchV2 {
  sourceBranch: string
  baseRevision: number
  mutationIds: string[]
}

export interface WorkspaceBranchV2 {
  branch: CanvasGitV2Branch
  canvas: CanvasEnvelopeV2
}

export interface WorkspaceMergeInputV2 {
  sourceBranch: string
  targetBranch: string
}

export interface WorkspaceMergeExpectationV2 {
  sourceCommit: string
  targetCommit: string
  sourceRevision: number
  targetRevision: number
}

export interface WorkspaceMergePreviewV2 {
  state: GitMergeState
  canvas: GitMergePreview
  /** Must be returned unchanged when explicitly executing this preview. */
  expectation: WorkspaceMergeExpectationV2
}

export interface WorkspaceMergeExecutionInputV2 extends WorkspaceMergeInputV2 {
  confirmed: boolean
  expected: WorkspaceMergeExpectationV2
}

export interface WorkspaceMergeExecutionV2 {
  state: 'merged' | 'conflicts' | 'up-to-date' | 'partial'
  canvas: GitMergeExecution
  canvasEnvelope?: CanvasEnvelopeV2
}

interface ProjectVersionStateV2 {
  projectDir: string
  canvasGit: CanvasGitStoreV2
  versioning: CanvasGitV2Status | null
}

interface ScheduledCheckpointV2 {
  timer: ReturnType<typeof setTimeout>
  reason: string
  project: ProjectVersionStateV2
  branch: string
}

interface PreparedWorkspaceMergeV2 {
  preview: WorkspaceMergePreviewV2
  targetCanvas: CanvasEnvelopeV2
}

/**
 * Coordinates authoritative Canvas V2 commands with normalized Canvas-only Git
 * history. Source files, Run runtime, logs, sessions, and view state never enter
 * this history layer.
 */
export class WorkspaceVersionManagerV2 {
  readonly canvases: WorkspaceCanvasStoreManagerV2

  readonly #projectRoot: string
  readonly #checkpointDelayMs: number
  readonly #canvasGitFactory: (canonicalProjectDir: string) => CanvasGitStoreV2
  readonly #projects = new Map<string, Promise<ProjectVersionStateV2>>()
  readonly #scheduled = new Map<string, ScheduledCheckpointV2>()
  readonly #checkpointTasks = new Set<Promise<void>>()
  readonly #branchTails = new Map<string, Promise<void>>()
  #closing = false
  #closePromise: Promise<void> | null = null

  constructor(options: WorkspaceVersionManagerV2Options) {
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#checkpointDelayMs = options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS
    if (!Number.isFinite(this.#checkpointDelayMs) || this.#checkpointDelayMs < 0) {
      throw new TypeError('checkpointDelayMs must be a non-negative finite number')
    }
    this.canvases = options.canvasStoreManager
    this.#canvasGitFactory = options.canvasGitFactory
      ?? ((projectDir) => new CanvasGitStoreV2(projectDir))
  }

  async getCanvas(projectDir = '.', branchRequest = 'main'): Promise<WorkspaceCanvasResultV2> {
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
    command: CanvasCommandV2,
  ): Promise<WorkspaceCanvasResultV2> {
    const branch = parseCanvasBranch(branchRequest)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [branch], async () => {
      const current = await this.#loadBranchCanvas(project, branch)
      if (isDestructiveCanvasCommandV2(command) && current.revision === baseRevision) {
        // Validate before touching Git, then make the exact pre-delete state
        // recoverable even when the normal debounced checkpoint has not fired.
        applyCanvasCommandV2(current.document, command)
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
    command: CanvasCommandV2,
  ): Promise<WorkspaceCanvasResultV2> {
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

  async status(projectDir = '.'): Promise<WorkspaceStatusesV2> {
    return this.#refreshStatuses(await this.#project(projectDir))
  }

  async manualCheckpoint(
    projectDir: string,
    branchRequest: string,
    reason = 'manual',
  ): Promise<WorkspaceOperationResultV2<WorkspaceCheckpointV2>> {
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
  ): Promise<WorkspaceOperationResultV2<CanvasGitV2Branch[]>> {
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
    options: CanvasGitV2HistoryOptions,
  ): Promise<WorkspaceOperationResultV2<CanvasGitV2HistoryPage>> {
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
    input: WorkspaceCreateBranchInputV2,
  ): Promise<WorkspaceOperationResultV2<WorkspaceBranchV2>> {
    const name = parseCanvasBranch(input.name)
    const fromBranch = parseCanvasBranch(input.fromBranch ?? 'main')
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [fromBranch, name], async () => {
      let branch: CanvasGitV2Branch | null = null
      let canvas: CanvasEnvelopeV2 | null = null
      let partial = false
      try {
        if (name === fromBranch) {
          throw new WorkspaceVersioningV2Error(
            'invariant_conflict',
            'new Canvas V2 branch must differ from its source branch',
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
  ): Promise<WorkspaceOperationResultV2<WorkspaceBranchV2>> {
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
    input: WorkspaceSaveConflictBranchInputV2,
  ): Promise<WorkspaceOperationResultV2<WorkspaceConflictBranchV2>> {
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
      let branch: CanvasGitV2Branch | null = null
      let canvas: CanvasEnvelopeV2 | null = null
      let partial = false
      try {
        if (newBranch === sourceBranch) {
          throw new WorkspaceVersioningV2Error(
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
          throw new WorkspaceVersioningV2Error(
            'conflict_base_unavailable',
            `Canvas V2 revision ${input.baseRevision} is unavailable on ${sourceBranch}`,
          )
        }
        let recoveredDocument = baseDocument
        for (const mutation of input.mutations) {
          recoveredDocument = applyCanvasCommandV2(recoveredDocument, mutation.command)
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
            throw new WorkspaceVersioningV2Error(
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
            throw new WorkspaceVersioningV2Error(
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
    input: CanvasGitV2RestoreInput,
  ): Promise<WorkspaceOperationResultV2<WorkspaceBranchV2>> {
    const sourceBranch = parseCanvasBranch(input.sourceBranch)
    const newBranch = parseCanvasBranch(input.newBranch)
    const checkpoint = canonicalFullGitCommit(input.checkpoint)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(project, [sourceBranch, newBranch], async () => {
      let branch: CanvasGitV2Branch | null = null
      let canvas: CanvasEnvelopeV2 | null = null
      let partial = false
      try {
        if (newBranch === sourceBranch) {
          throw new WorkspaceVersioningV2Error(
            'invariant_conflict',
            'restored Canvas V2 branch must differ from its history branch',
          )
        }
        this.#cancelScheduled(project, newBranch)
        await this.#reconcileCommittedCanvasMerge(project, newBranch)
        branch = await this.#canvasBranch(project, newBranch)
        canvas = await this.canvases.get(project.projectDir, newBranch)
        partial = branch !== null || canvas.revision > 0
        this.#assertBranchLayerConsistency(newBranch, branch, canvas)
        if (branch && branch.commit !== checkpoint) {
          throw new WorkspaceVersioningV2Error(
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
    input: WorkspaceMergeInputV2,
  ): Promise<WorkspaceOperationResultV2<WorkspaceMergePreviewV2>> {
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
    input: WorkspaceMergeExecutionInputV2,
  ): Promise<WorkspaceOperationResultV2<WorkspaceMergeExecutionV2>> {
    const parsed = parseMergeInput(input)
    const project = await this.#project(projectDir)
    return this.#withBranchLocks(
      project,
      [parsed.sourceBranch, parsed.targetBranch],
      async () => {
        let partialValue: WorkspaceMergeExecutionV2 | undefined
        try {
          if (!input.confirmed) {
            throw new WorkspaceVersioningV2Error(
              'merge_confirmation_required',
              'Canvas V2 merge execution requires explicit confirmation',
            )
          }
          await this.#assertMergeExpectationCurrent(project, parsed, input.expected)
          const prepared = await this.#prepareMerge(project, parsed)
          if (!sameMergeExpectation(prepared.preview.expectation, input.expected)) {
            throw staleMergePreview()
          }
          if (prepared.preview.state === 'conflicts') {
            const value: WorkspaceMergeExecutionV2 = {
              state: 'conflicts',
              canvas: unexecutedMerge(prepared.preview.canvas),
              canvasEnvelope: prepared.targetCanvas,
            }
            return this.#success(value, await this.#refreshStatuses(project))
          }

          const canvas = await project.canvasGit.merge(parsed)
          if (canvas.state === 'conflicts') {
            const value: WorkspaceMergeExecutionV2 = {
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
   * V2 runs do not require a legacy source-branch binding. The returned project
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
    project: ProjectVersionStateV2,
    input: WorkspaceMergeInputV2,
  ): Promise<PreparedWorkspaceMergeV2> {
    if (input.sourceBranch === input.targetBranch) {
      throw new WorkspaceVersioningV2Error(
        'invalid_merge',
        'Canvas V2 merge source and target branches must be different',
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
    project: ProjectVersionStateV2,
    input: WorkspaceMergeInputV2,
    expected: WorkspaceMergeExpectationV2,
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
    project: ProjectVersionStateV2,
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
      throw new WorkspaceVersioningV2Error(
        'invariant_conflict',
        `runtime Canvas V2 changed after checkpoint and cannot be replaced: ${branch}`,
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
    project: ProjectVersionStateV2,
    branchName: string,
  ): Promise<CanvasEnvelopeV2> {
    const [status, hasSnapshot] = await Promise.all([
      project.canvasGit.status(),
      this.canvases.hasSnapshot(project.projectDir, branchName),
    ])
    project.versioning = status
    if (status.state === 'degraded') {
      if (branchName === 'main' || hasSnapshot) {
        return this.canvases.get(project.projectDir, branchName)
      }
      throw new WorkspaceVersioningV2Error('canvas_degraded', status.reason)
    }
    if (status.state === 'uninitialized') {
      if (branchName === 'main') return this.canvases.get(project.projectDir, branchName)
      if (hasSnapshot) {
        throw new WorkspaceVersioningV2Error(
          'invariant_conflict',
          `runtime Canvas V2 has no matching Git branch: ${branchName}`,
        )
      }
      throw new CanvasGitV2Error(
        'BRANCH_NOT_FOUND',
        `Canvas V2 branch does not exist: ${branchName}`,
      )
    }
    const branch = (await project.canvasGit.listBranches())
      .find((candidate) => candidate.name === branchName)
    if (!branch) {
      if (hasSnapshot) {
        throw new WorkspaceVersioningV2Error(
          'invariant_conflict',
          `runtime Canvas V2 has no matching Git branch: ${branchName}`,
        )
      }
      throw new CanvasGitV2Error(
        'BRANCH_NOT_FOUND',
        `Canvas V2 branch does not exist: ${branchName}`,
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
    project: ProjectVersionStateV2,
    branch: CanvasGitV2Branch,
    runtime: CanvasEnvelopeV2,
  ): Promise<CanvasEnvelopeV2> {
    this.#assertManagedBranch(branch.name, branch)
    if (runtime.lastCheckpoint === branch.commit) return runtime
    const branchDocument = await project.canvasGit.readDocument(branch.commit)
    if (!isDeepStrictEqual(runtime.document, branchDocument)) {
      throw new WorkspaceVersioningV2Error(
        'invariant_conflict',
        `runtime Canvas V2 and Git history disagree for branch: ${branch.name}`,
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
    project: ProjectVersionStateV2,
    branch: string,
    reason: string,
  ): Promise<WorkspaceCheckpointV2> {
    let conflict: CanvasRevisionConflictV2Error | null = null
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
        if (!(error instanceof CanvasRevisionConflictV2Error)) throw error
        conflict = error
      }
    }
    throw conflict ?? new CanvasRevisionConflictV2Error(-1)
  }

  #scheduleCheckpoint(project: ProjectVersionStateV2, branch: string, reason: string): void {
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
      this.#trackCheckpointTask(task)
    }, this.#checkpointDelayMs)
    timer.unref?.()
    this.#scheduled.set(key, { timer, reason, project, branch })
  }

  #trackCheckpointTask(task: Promise<void>): void {
    this.#checkpointTasks.add(task)
    void task.finally(() => this.#checkpointTasks.delete(task))
  }

  #cancelScheduled(project: ProjectVersionStateV2, branch: string): void {
    const key = branchKey(project.projectDir, branch)
    const scheduled = this.#scheduled.get(key)
    if (!scheduled) return
    clearTimeout(scheduled.timer)
    this.#scheduled.delete(key)
  }

  async #withBranchLocks<T>(
    project: ProjectVersionStateV2,
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

  async #queryableBranch(
    project: ProjectVersionStateV2,
    branch: string,
  ): Promise<CanvasGitV2Branch | null> {
    const status = await project.canvasGit.status()
    project.versioning = status
    if (status.state === 'degraded') {
      throw new WorkspaceVersioningV2Error('canvas_degraded', status.reason)
    }
    if (status.state === 'uninitialized') {
      if (branch === 'main') return null
      throw new CanvasGitV2Error(
        'BRANCH_NOT_FOUND',
        `Canvas V2 branch does not exist: ${branch}`,
      )
    }
    const candidate = (await project.canvasGit.listBranches())
      .find((entry) => entry.name === branch)
    if (!candidate) {
      throw new CanvasGitV2Error(
        'BRANCH_NOT_FOUND',
        `Canvas V2 branch does not exist: ${branch}`,
      )
    }
    this.#assertManagedBranch(branch, candidate)
    return candidate
  }

  async #canvasBranch(
    project: ProjectVersionStateV2,
    branch: string,
  ): Promise<CanvasGitV2Branch | null> {
    const status = await project.canvasGit.status()
    project.versioning = status
    if (status.state === 'degraded') {
      throw new WorkspaceVersioningV2Error('canvas_degraded', status.reason)
    }
    if (status.state === 'uninitialized') return null
    return (await project.canvasGit.listBranches())
      .find((candidate) => candidate.name === branch) ?? null
  }

  async #requireCanvasBranch(
    project: ProjectVersionStateV2,
    branch: string,
  ): Promise<CanvasGitV2Branch> {
    const candidate = await this.#canvasBranch(project, branch)
    if (!candidate) {
      throw new CanvasGitV2Error(
        'BRANCH_NOT_FOUND',
        `Canvas V2 branch does not exist: ${branch}`,
      )
    }
    this.#assertManagedBranch(branch, candidate)
    return candidate
  }

  #assertManagedBranch(branchName: string, branch: CanvasGitV2Branch): void {
    if (!branch.worktree
      || !branch.worktree.managed
      || branch.worktree.branch !== branchName) {
      throw new WorkspaceVersioningV2Error(
        'invariant_conflict',
        `Canvas V2 branch has no matching managed worktree: ${branchName}`,
      )
    }
  }

  #assertBranchLayerConsistency(
    branchName: string,
    branch: CanvasGitV2Branch | null,
    canvas: CanvasEnvelopeV2,
  ): void {
    if (!branch && canvas.revision > 0) {
      throw new WorkspaceVersioningV2Error(
        'invariant_conflict',
        `Canvas V2 branch layers disagree because Git history is missing: ${branchName}`,
      )
    }
  }

  async #project(requestedProjectDir: string): Promise<ProjectVersionStateV2> {
    if (this.#closing) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
    const leasedProjectDir = await this.canvases.acquireProjectLease(requestedProjectDir)
    const projectDir = (await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: leasedProjectDir,
    })).projectDir
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

  async #cachedStatuses(project: ProjectVersionStateV2): Promise<WorkspaceStatusesV2> {
    return project.versioning
      ? { versioning: project.versioning }
      : this.#refreshStatuses(project)
  }

  async #refreshStatuses(project: ProjectVersionStateV2): Promise<WorkspaceStatusesV2> {
    const versioning = await safeCanvasStatus(project.canvasGit)
    project.versioning = versioning
    return { versioning }
  }

  #success<T>(
    value: T,
    statuses: WorkspaceStatusesV2,
  ): WorkspaceOperationResultV2<T> {
    return { ok: true, partial: false, value, ...statuses }
  }

  #failure<T>(
    error: unknown,
    statuses: WorkspaceStatusesV2,
    partial = false,
    value?: T,
  ): WorkspaceOperationResultV2<T> {
    return {
      ok: false,
      partial,
      error: workspaceError(error),
      ...(value === undefined ? {} : { value }),
      ...statuses,
    }
  }
}

export class WorkspaceVersioningV2Error extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceVersioningV2Error'
    this.code = code
  }
}

function parseMergeInput(input: WorkspaceMergeInputV2): WorkspaceMergeInputV2 {
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
    throw new WorkspaceVersioningV2Error(
      'invalid_checkpoint',
      'Canvas V2 restore requires a full Git checkpoint identifier',
    )
  }
  return value.toLowerCase()
}

function unexecutedMerge(preview: GitMergePreview): GitMergeExecution {
  return { ...preview, merged: false, commit: preview.targetCommit }
}

function assertMergeExpectation(expected: WorkspaceMergeExpectationV2): void {
  if (!isRecord(expected)
    || !isFullGitCommit(expected.sourceCommit)
    || !isFullGitCommit(expected.targetCommit)
    || !isRevision(expected.sourceRevision)
    || !isRevision(expected.targetRevision)) {
    throw invalidMergeExpectation()
  }
}

function sameMergeExpectation(
  current: WorkspaceMergeExpectationV2,
  expected: WorkspaceMergeExpectationV2,
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

function invalidMergeExpectation(): WorkspaceVersioningV2Error {
  return new WorkspaceVersioningV2Error(
    'invalid_merge_expectation',
    'Canvas V2 merge requires the exact expectation returned by preview',
  )
}

function staleMergePreview(): WorkspaceVersioningV2Error {
  return new WorkspaceVersioningV2Error(
    'merge_preview_stale',
    'Canvas V2 state changed after merge preview; preview the merge again',
  )
}

async function safeCanvasStatus(store: CanvasGitStoreV2): Promise<CanvasGitV2Status> {
  try {
    return await store.status()
  } catch (error) {
    return {
      state: 'degraded',
      initialized: false,
      gitAvailable: !(error instanceof CanvasGitV2Error && error.code === 'GIT_UNAVAILABLE'),
      reason: errorMessage(error),
    }
  }
}

function workspaceError(error: unknown): WorkspaceOperationErrorV2 {
  const code = error instanceof CanvasGitV2Error
    || error instanceof WorkspaceVersioningV2Error
    || error instanceof ProtocolError
    ? error.code
    : error instanceof CanvasCommandError
      ? `canvas_command_${error.code}`
    : error instanceof CanvasRevisionConflictV2Error
      ? 'canvas_revision_conflict'
      : error instanceof CanvasMutationReuseV2Error
        ? 'canvas_mutation_reuse'
        : error instanceof CanvasSnapshotV2Error
          ? 'canvas_snapshot_invalid'
          : 'versioning_failed'
  return { code, message: errorMessage(error) }
}

function isDestructiveCanvasCommandV2(command: CanvasCommandV2): boolean {
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
