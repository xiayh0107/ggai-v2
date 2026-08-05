import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { atomicWriteText } from './atomic-file.js'
import {
  nulSeparatedPaths,
  parseUnmergedIndex,
  type GitMergeExecution,
  type GitMergePreview,
} from './mergeTypes.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'
import { MAX_CANVAS_BRANCH_LENGTH } from './protocol.js'

const DEFAULT_BRANCH = 'main'
const CHECKPOINT_PATHS = [
  '.gitignore',
  'project.json',
  'nodes',
  'edges',
  'runs',
  'artifacts',
] as const
const MANAGED_LOCK_REASON = 'ggai-managed'
const MAX_GIT_OUTPUT = 4 * 1024 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 15_000

export type CanvasGitErrorCode =
  | 'BRANCH_EXISTS'
  | 'BRANCH_NOT_FOUND'
  | 'BRANCH_NOT_MERGED'
  | 'CHECKPOINT_NOT_FOUND'
  | 'DIRTY_WORKTREE'
  | 'GIT_COMMAND_FAILED'
  | 'GIT_UNAVAILABLE'
  | 'INVALID_BRANCH'
  | 'INVALID_MERGE'
  | 'INVALID_SNAPSHOT'
  | 'INVALID_SOURCE_METADATA'
  | 'MERGE_FAILED'
  | 'PROTECTED_BRANCH'
  | 'REPOSITORY_EMPTY'
  | 'UNMANAGED_WORKTREE'
  | 'UNSAFE_PATH'

export class CanvasGitError extends Error {
  readonly code: CanvasGitErrorCode
  readonly exitCode?: number

  constructor(
    code: CanvasGitErrorCode,
    message: string,
    options: { cause?: unknown; exitCode?: number } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'CanvasGitError'
    this.code = code
    this.exitCode = options.exitCode
  }
}

export type CanvasGitStatus =
  | {
      state: 'uninitialized'
      initialized: false
      gitAvailable: true
    }
  | {
      state: 'ready'
      initialized: true
      gitAvailable: true
    }
  | {
      state: 'degraded'
      initialized: boolean
      gitAvailable: boolean
      reason: string
    }

export interface CanvasGitWorktree {
  /** `main` for the primary checkout, otherwise the daemon-generated UUID. */
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

export interface CanvasGitRecoverableMerge {
  branch: string
  commit: string
  firstParent: string
  secondParent: string
  document: unknown
  firstParentDocument: unknown
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

export interface CanvasGitCheckpointInput {
  branch: string
  /** CanvasDocumentV1 at runtime; kept structural to avoid coupling stores. */
  document: unknown
  /** Durable run summaries only. Raw event logs must never be supplied here. */
  runs?: readonly unknown[]
  /** Versioned completeness/truncation stats written as runs/index.json. */
  runIndex?: unknown
  /** Artifact manifests only. Artifact contents remain outside Git. */
  artifacts?: readonly unknown[]
  /** Versioned completeness/truncation stats written as artifacts/index.json. */
  artifactIndex?: unknown
  /** Exact managed source HEAD paired with this canvas checkpoint, when bound. */
  source?: CanvasGitSourceMetadata | null
  /** A short semantic reason such as `node-created` or `run-completed`. */
  reason?: string
}

export interface CanvasGitSourceMetadata {
  version: 1
  commit: string
}

export interface CanvasGitCheckpointResult {
  branch: string
  commit: string
  changed: boolean
  status: Extract<CanvasGitStatus, { state: 'ready' }>
}

export interface CanvasGitCreateBranchInput {
  name: string
  /** Existing branch or full checkpoint hash. Defaults to `main`. */
  startPoint?: string
}

export interface CanvasGitRestoreInput {
  sourceBranch: string
  checkpoint: string
  newBranch: string
}

export interface CanvasGitMergeInput {
  sourceBranch: string
  targetBranch: string
}

export interface CanvasGitHistoryOptions {
  branch: string
  cursor?: string
  limit?: number
}

export interface CanvasGitStoreOptions {
  gitBinary?: string
  uuid?: () => string
  gitTimeoutMs?: number
}

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface GitOptions {
  cwd?: string
  allowedExitCodes?: readonly number[]
}

interface NormalizedSnapshot {
  project: unknown
  source: CanvasGitSourceMetadata | null
  nodes: NormalizedEntry[]
  edges: NormalizedEntry[]
  runs: NormalizedEntry[]
  runIndex: unknown | null
  artifacts: NormalizedEntry[]
  artifactIndex: unknown | null
}

interface NormalizedEntry {
  fileName: string
  value: unknown
}

interface PorcelainWorktree {
  path: string
  commit: string
  branch: string | null
  locked: boolean
  lockReason?: string
  prunable: boolean
}

interface MergeMetadata {
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
  targetCommit: string
  baseCommit: string | null
}

/**
 * Owns the state-only Git repository under `.gg/`.
 *
 * This class deliberately has no HTTP or CanvasStore dependency. Callers save
 * their authoritative runtime snapshot first, then request a best-effort Git
 * checkpoint. A Git failure is reflected by {@link status} and must not roll
 * back the already durable canvas save.
 */
export class CanvasGitStore {
  readonly projectDir: string
  readonly repoDir: string
  readonly worktreesDir: string

  readonly #gitBinary: string
  readonly #uuid: () => string
  readonly #gitTimeoutMs: number
  #degraded: { reason: string; gitAvailable: boolean } | null = null
  #operationTail: Promise<void> = Promise.resolve()

  constructor(projectDir: string, options: CanvasGitStoreOptions = {}) {
    if (typeof projectDir !== 'string' || projectDir.trim().length === 0) {
      throw new TypeError('projectDir must be a non-empty string')
    }
    this.projectDir = resolve(projectDir)
    this.repoDir = resolve(this.projectDir, '.gg', 'canvas-state')
    this.worktreesDir = resolve(this.projectDir, '.gg', 'canvas-worktrees')
    this.#gitBinary = options.gitBinary ?? 'git'
    this.#uuid = options.uuid ?? randomUUID
    this.#gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  }

  async status(): Promise<CanvasGitStatus> {
    return this.#runExclusive(() => this.#inspectStatus())
  }

  async checkpoint(input: CanvasGitCheckpointInput): Promise<CanvasGitCheckpointResult> {
    const normalized = normalizeSnapshot(
      input.document,
      input.runs,
      input.runIndex,
      input.artifacts,
      input.artifactIndex,
      input.source,
    )
    return this.#runExclusive(async () => {
      try {
        await this.#ensureInitialized()
        await this.#validateBranch(input.branch)
        const worktree = await this.#worktreeForBranch(input.branch)
        await this.#writeSnapshot(worktree.path, normalized)

        await this.#git(
          ['add', '--all', '--', ...CHECKPOINT_PATHS],
          { cwd: worktree.path },
        )
        await this.#stageSourceMetadata(worktree.path, normalized.source !== null)
        const diff = await this.#git(
          ['diff', '--cached', '--quiet'],
          { cwd: worktree.path, allowedExitCodes: [0, 1] },
        )

        let changed = diff.exitCode === 1
        if (changed) {
          const subject = checkpointSubject(input.reason)
          await this.#git(
            [
              '-c',
              'user.name=GGAI',
              '-c',
              'user.email=ggai@local',
              'commit',
              '--no-gpg-sign',
              '-m',
              subject,
            ],
            { cwd: worktree.path },
          )
        } else if (!(await this.#hasHead(worktree.path))) {
          // An empty normalized snapshot still needs a stable branch tip.
          await this.#git(
            [
              '-c',
              'user.name=GGAI',
              '-c',
              'user.email=ggai@local',
              'commit',
              '--allow-empty',
              '--no-gpg-sign',
              '-m',
              checkpointSubject(input.reason),
            ],
            { cwd: worktree.path },
          )
          changed = true
        }

        const commit = (
          await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktree.path })
        ).stdout.trim()
        this.#degraded = null
        return {
          branch: input.branch,
          commit,
          changed,
          status: { state: 'ready', initialized: true, gitAvailable: true },
        }
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  async listWorktrees(): Promise<CanvasGitWorktree[]> {
    return this.#runExclusive(async () => {
      await this.#requireInitialized()
      const worktrees = await this.#listWorktreesInternal()
      this.#degraded = null
      return worktrees
    })
  }

  /** Reassembles a CanvasDocumentV1 from a branch or full checkpoint hash. */
  async readDocument(refOrBranch: string): Promise<unknown> {
    return this.#runExclusive(async () => {
      try {
        await this.#requireInitialized()
        const resolved = await this.#resolveReadableRef(refOrBranch)
        const worktree = (await this.#listWorktreesInternal()).find((candidate) =>
          resolved.branch === null
            ? candidate.commit === resolved.ref
            : candidate.branch === resolved.branch,
        )
        const document = worktree
          ? await this.#readDocumentFromWorktree(worktree.path)
          : await this.#readDocumentFromTree(resolved.ref)
        this.#degraded = null
        return document
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  /**
   * Returns only a managed branch tip that is exactly the two-parent merge
   * produced after the runtime's checkpoint. Ordinary checkpoint divergence
   * remains runtime-authoritative and is never returned here.
   */
  async recoverableMergeTip(
    branch: string,
    runtimeCheckpoint: string,
  ): Promise<CanvasGitRecoverableMerge | null> {
    return this.#runExclusive(async () => {
      try {
        await this.#requireInitialized()
        await this.#validateBranch(branch)
        const checkpoint = canonicalCheckpointHash(runtimeCheckpoint)
        await this.#worktreeForBranch(branch)
        const tip = (
          await this.#git(['rev-parse', '--verify', `refs/heads/${branch}`], {
            cwd: this.repoDir,
          })
        ).stdout.trim()
        const fields = (
          await this.#git(['rev-list', '--parents', '--max-count=1', tip], {
            cwd: this.repoDir,
          })
        ).stdout.trim().split(/\s+/u)
        if (
          fields.length !== 3
          || fields[0] !== tip
          || fields[1] !== checkpoint
        ) {
          this.#degraded = null
          return null
        }
        const firstParent = fields[1]
        const secondParent = fields[2]
        if (!firstParent || !secondParent) {
          this.#degraded = null
          return null
        }
        const [document, firstParentDocument] = await Promise.all([
          this.#readDocumentFromTree(tip),
          this.#readDocumentFromTree(firstParent),
        ])
        this.#degraded = null
        return {
          branch,
          commit: tip,
          firstParent,
          secondParent,
          document,
          firstParentDocument,
        }
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  /** Reads validated source metadata from the immutable commit tree, never from a worktree. */
  async readSourceMetadata(refOrBranch: string): Promise<CanvasGitSourceMetadata | null> {
    return this.#runExclusive(async () => {
      try {
        await this.#requireInitialized()
        const resolved = await this.#resolveReadableRef(refOrBranch)
        const exists = await this.#git(
          ['cat-file', '-e', `${resolved.ref}:source.json`],
          { cwd: this.repoDir, allowedExitCodes: [0, 1, 128] },
        )
        if (exists.exitCode !== 0) return null
        const result = await this.#git(['show', `${resolved.ref}:source.json`], {
          cwd: this.repoDir,
        })
        let value: unknown
        try {
          value = JSON.parse(result.stdout) as unknown
        } catch (error) {
          throw new CanvasGitError(
            'INVALID_SOURCE_METADATA',
            'Canvas checkpoint source metadata is invalid JSON',
            { cause: error },
          )
        }
        const metadata = parseSourceMetadata(value)
        this.#degraded = null
        return metadata
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  async listBranches(): Promise<CanvasGitBranch[]> {
    return this.#runExclusive(async () => {
      await this.#requireInitialized()
      const [refs, worktrees] = await Promise.all([
        this.#git(
          ['for-each-ref', '--sort=refname', '--format=%(refname:short)%09%(objectname)', 'refs/heads/'],
          { cwd: this.repoDir },
        ),
        this.#listWorktreesInternal(),
      ])
      const byBranch = new Map(
        worktrees
          .filter((worktree): worktree is CanvasGitWorktree & { branch: string } =>
            worktree.branch !== null,
          )
          .map((worktree) => [worktree.branch, worktree]),
      )
      const branches = refs.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf('\t')
          if (separator <= 0) {
            throw new CanvasGitError('GIT_COMMAND_FAILED', 'Git returned malformed branch data')
          }
          const name = line.slice(0, separator)
          return {
            name,
            commit: line.slice(separator + 1),
            worktree: byBranch.get(name) ?? null,
          }
        })
      this.#degraded = null
      return branches
    })
  }

  async createBranch(input: CanvasGitCreateBranchInput): Promise<CanvasGitBranch> {
    return this.#runExclusive(async () => {
      try {
        await this.#requireInitialized()
        await this.#requireHead()
        await this.#validateBranch(input.name)
        if (await this.#branchExists(input.name)) {
          throw new CanvasGitError('BRANCH_EXISTS', `Canvas branch already exists: ${input.name}`)
        }

        const startPoint = input.startPoint ?? DEFAULT_BRANCH
        const resolvedStart = await this.#resolveStartPoint(startPoint)
        const worktree = await this.#createWorktree(input.name, resolvedStart)
        this.#degraded = null
        return {
          name: input.name,
          commit: worktree.commit,
          worktree,
        }
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  async deleteBranch(branch: string): Promise<void> {
    return this.#runExclusive(async () => {
      try {
        await this.#requireInitialized()
        await this.#validateBranch(branch)
        if (branch === DEFAULT_BRANCH) {
          throw new CanvasGitError('PROTECTED_BRANCH', 'The main canvas branch cannot be deleted')
        }
        if (!(await this.#branchExists(branch))) {
          throw new CanvasGitError('BRANCH_NOT_FOUND', `Canvas branch does not exist: ${branch}`)
        }
        const merged = await this.#git(
          ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${DEFAULT_BRANCH}`],
          { cwd: this.repoDir, allowedExitCodes: [0, 1] },
        )
        if (merged.exitCode !== 0) {
          throw new CanvasGitError(
            'BRANCH_NOT_MERGED',
            `Canvas branch is not fully merged and was not deleted: ${branch}`,
          )
        }

        const worktree = (await this.#listWorktreesInternal()).find(
          (candidate) => candidate.branch === branch,
        )
        if (worktree) {
          if (!worktree.managed || worktree.id === DEFAULT_BRANCH) {
            throw new CanvasGitError(
              'UNMANAGED_WORKTREE',
              `Refusing to remove an unmanaged canvas worktree: ${worktree.path}`,
            )
          }
          const dirty = (
            await this.#git(['status', '--porcelain=v1', '--untracked-files=all'], {
              cwd: worktree.path,
            })
          ).stdout
          if (dirty.length > 0) {
            throw new CanvasGitError(
              'DIRTY_WORKTREE',
              `Canvas worktree has uncommitted changes: ${branch}`,
            )
          }
          if (worktree.locked) {
            if (worktree.lockReason !== MANAGED_LOCK_REASON) {
              throw new CanvasGitError(
                'UNMANAGED_WORKTREE',
                `Canvas worktree is locked for another reason: ${worktree.lockReason ?? 'unknown'}`,
              )
            }
            await this.#git(['worktree', 'unlock', worktree.path], { cwd: this.repoDir })
          }
          await this.#git(['worktree', 'remove', worktree.path], { cwd: this.repoDir })
        }

        await this.#git(['branch', '--delete', '--', branch], { cwd: this.repoDir })
        this.#degraded = null
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  /** Simulates a Git merge in a disposable, locked worktree. Branch tips are unchanged. */
  async previewMerge(input: CanvasGitMergeInput): Promise<GitMergePreview> {
    return this.#runExclusive(async () => {
      try {
        const metadata = await this.#mergeMetadata(input)
        if (metadata.sourceCommit === metadata.targetCommit) {
          return mergePreview(metadata, [], [])
        }
        const preview = await this.#withPreviewWorktree(
          input.targetBranch,
          (worktreePath) => this.#attemptMerge(worktreePath, input.sourceBranch, metadata),
        )
        this.#degraded = null
        return preview
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  /**
   * Explicitly merges `sourceBranch` into `targetBranch`. Conflicts are
   * reported and immediately aborted, leaving the target worktree clean.
   */
  async merge(input: CanvasGitMergeInput): Promise<GitMergeExecution> {
    return this.#runExclusive(async () => {
      try {
        const metadata = await this.#mergeMetadata(input)
        const worktree = await this.#worktreeForBranch(input.targetBranch)
        await this.#assertCleanWorktree(worktree.path, input.targetBranch)
        if (metadata.sourceCommit === metadata.targetCommit) {
          return {
            ...mergePreview(metadata, [], []),
            merged: false,
            commit: metadata.targetCommit,
          }
        }

        try {
          const preview = await this.#attemptMerge(
            worktree.path,
            input.sourceBranch,
            metadata,
          )
          if (preview.state === 'conflicts') {
            await this.#abortMergeIfNeeded(worktree.path)
            await this.#assertCleanWorktree(worktree.path, input.targetBranch)
            return {
              ...preview,
              merged: false,
              commit: metadata.targetCommit,
            }
          }
          if (preview.state === 'up-to-date') {
            return {
              ...preview,
              merged: false,
              commit: metadata.targetCommit,
            }
          }

          await this.#git(
            [
              '-c',
              'user.name=GGAI',
              '-c',
              'user.email=ggai@local',
              'commit',
              '--no-gpg-sign',
              '--no-verify',
              '-m',
              mergeSubject(input.sourceBranch, input.targetBranch),
            ],
            { cwd: worktree.path },
          )
          const commit = (
            await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktree.path })
          ).stdout.trim()
          this.#degraded = null
          return { ...preview, merged: true, commit }
        } catch (error) {
          await this.#abortMergeIfNeeded(worktree.path).catch(() => undefined)
          await this.#assertCleanWorktree(worktree.path, input.targetBranch)
          throw error
        }
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  async history(options: CanvasGitHistoryOptions): Promise<CanvasGitHistoryPage> {
    return this.#runExclusive(async () => {
      try {
        await this.#requireInitialized()
        await this.#validateBranch(options.branch)
        if (!(await this.#branchExists(options.branch))) {
          throw new CanvasGitError(
            'BRANCH_NOT_FOUND',
            `Canvas branch does not exist: ${options.branch}`,
          )
        }
        const limit = options.limit ?? 50
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new TypeError('history limit must be an integer from 1 through 100')
        }

        let startPoint = `refs/heads/${options.branch}`
        if (options.cursor !== undefined) {
          assertCheckpointHash(options.cursor)
          await this.#assertCheckpointOnBranch(options.cursor, options.branch)
          const parents = (
            await this.#git(['rev-list', '--parents', '--max-count=1', options.cursor], {
              cwd: this.repoDir,
            })
          ).stdout.trim().split(/\s+/)
          if (parents.length === 1) return { entries: [], nextCursor: null }
          startPoint = `${options.cursor}^1`
        }

        const output = await this.#git(
          [
            'log',
            '--first-parent',
            `--max-count=${limit + 1}`,
            '--format=%H%x00%P%x00%ct%x00%s',
            '-z',
            startPoint,
          ],
          { cwd: this.repoDir },
        )
        const allEntries = parseHistory(output.stdout)
        const entries = allEntries.slice(0, limit)
        this.#degraded = null
        return {
          entries,
          nextCursor: allEntries.length > limit
            ? entries.at(-1)?.commit ?? null
            : null,
        }
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  async restoreAsNewBranch(input: CanvasGitRestoreInput): Promise<CanvasGitBranch> {
    return this.#runExclusive(async () => {
      try {
        await this.#requireInitialized()
        await this.#validateBranch(input.sourceBranch)
        await this.#validateBranch(input.newBranch)
        if (!(await this.#branchExists(input.sourceBranch))) {
          throw new CanvasGitError(
            'BRANCH_NOT_FOUND',
            `Canvas branch does not exist: ${input.sourceBranch}`,
          )
        }
        if (await this.#branchExists(input.newBranch)) {
          throw new CanvasGitError(
            'BRANCH_EXISTS',
            `Canvas branch already exists: ${input.newBranch}`,
          )
        }
        const checkpoint = canonicalCheckpointHash(input.checkpoint)
        await this.#assertCheckpointOnBranch(checkpoint, input.sourceBranch)

        const worktree = await this.#createWorktree(input.newBranch, checkpoint)
        this.#degraded = null
        return {
          name: input.newBranch,
          commit: worktree.commit,
          worktree,
        }
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

  async #mergeMetadata(input: CanvasGitMergeInput): Promise<MergeMetadata> {
    await this.#requireInitialized()
    await this.#requireHead()
    await this.#validateBranch(input.sourceBranch)
    await this.#validateBranch(input.targetBranch)
    if (input.sourceBranch === input.targetBranch) {
      throw new CanvasGitError(
        'INVALID_MERGE',
        'Canvas merge source and target branches must be different',
      )
    }
    for (const branch of [input.sourceBranch, input.targetBranch]) {
      if (!(await this.#branchExists(branch))) {
        throw new CanvasGitError('BRANCH_NOT_FOUND', `Canvas branch does not exist: ${branch}`)
      }
    }
    const [source, target, base] = await Promise.all([
      this.#git(['rev-parse', '--verify', `refs/heads/${input.sourceBranch}`], {
        cwd: this.repoDir,
      }),
      this.#git(['rev-parse', '--verify', `refs/heads/${input.targetBranch}`], {
        cwd: this.repoDir,
      }),
      this.#git(
        ['merge-base', `refs/heads/${input.targetBranch}`, `refs/heads/${input.sourceBranch}`],
        { cwd: this.repoDir, allowedExitCodes: [0, 1] },
      ),
    ])
    return {
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      sourceCommit: source.stdout.trim(),
      targetCommit: target.stdout.trim(),
      baseCommit: base.exitCode === 0 ? base.stdout.trim() || null : null,
    }
  }

  async #attemptMerge(
    worktreePath: string,
    sourceBranch: string,
    metadata: MergeMetadata,
  ): Promise<GitMergePreview> {
    const result = await this.#git(
      [
        'merge',
        '--no-commit',
        '--no-ff',
        '--no-edit',
        `refs/heads/${sourceBranch}`,
      ],
      { cwd: worktreePath, allowedExitCodes: [0, 1] },
    )
    const initialUnmerged = await this.#git(['ls-files', '-u', '-z'], { cwd: worktreePath })
    const initialConflicts = parseUnmergedIndex(initialUnmerged.stdout)
    // Source history is merged separately after the canvas merge. Preserve the
    // target pairing here, then a workspace checkpoint records the final
    // merged source HEAD. This also keeps source.json out of canvas conflicts.
    await this.#restoreTargetSourceMetadata(worktreePath)
    const [unmerged, changed] = await Promise.all([
      this.#git(['ls-files', '-u', '-z'], { cwd: worktreePath }),
      this.#git(['diff', '--name-only', '-z', 'HEAD'], { cwd: worktreePath }),
    ])
    const conflicts = parseUnmergedIndex(unmerged.stdout)
      .filter((conflict) => conflict.path !== 'source.json')
    const paths = nulSeparatedPaths(changed.stdout)
      .filter((path) => path !== 'source.json')
    if (result.exitCode !== 0 && initialConflicts.length === 0) {
      const detail = sanitizeGitError(result.stderr)
      throw new CanvasGitError(
        'MERGE_FAILED',
        detail ? `Canvas merge failed: ${detail}` : 'Canvas merge failed',
        { exitCode: result.exitCode },
      )
    }
    return mergePreview(metadata, paths, conflicts)
  }

  async #restoreTargetSourceMetadata(worktreePath: string): Promise<void> {
    const exists = await this.#git(
      ['cat-file', '-e', 'HEAD:source.json'],
      { cwd: worktreePath, allowedExitCodes: [0, 1, 128] },
    )
    const sourcePath = resolve(worktreePath, 'source.json')
    if (exists.exitCode === 0) {
      await this.#git(['checkout', 'HEAD', '--', 'source.json'], { cwd: worktreePath })
      await this.#git(['add', '--', 'source.json'], { cwd: worktreePath })
    } else {
      await rm(sourcePath, { force: true })
      await this.#stageSourceMetadata(worktreePath, false)
    }
  }

  async #stageSourceMetadata(worktreePath: string, present: boolean): Promise<void> {
    if (present) {
      await this.#git(['add', '--', 'source.json'], { cwd: worktreePath })
      return
    }
    const tracked = await this.#git(
      ['ls-files', '--error-unmatch', '--', 'source.json'],
      { cwd: worktreePath, allowedExitCodes: [0, 1] },
    )
    if (tracked.exitCode === 0) {
      await this.#git(['add', '--update', '--', 'source.json'], { cwd: worktreePath })
    }
  }

  async #withPreviewWorktree<T>(
    targetBranch: string,
    operation: (worktreePath: string) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.worktreesDir, { recursive: true, mode: 0o700 })
    let id = this.#uuid()
    if (!isUuid(id)) id = randomUUID()
    const worktreePath = resolve(this.worktreesDir, id)
    if (!isPathWithin(this.worktreesDir, worktreePath) || worktreePath === this.worktreesDir) {
      throw new CanvasGitError('UNSAFE_PATH', 'Generated preview worktree path is unsafe')
    }
    try {
      await lstat(worktreePath)
      throw new CanvasGitError('UNSAFE_PATH', 'Generated preview worktree path already exists')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }

    let added = false
    let locked = false
    try {
      await this.#git(
        ['worktree', 'add', '--detach', worktreePath, `refs/heads/${targetBranch}`],
        { cwd: this.repoDir },
      )
      added = true
      await this.#git(
        ['worktree', 'lock', '--reason', MANAGED_LOCK_REASON, worktreePath],
        { cwd: this.repoDir },
      )
      locked = true
      return await operation(worktreePath)
    } finally {
      if (added) {
        await this.#abortMergeIfNeeded(worktreePath)
        await this.#assertCleanWorktree(worktreePath, 'merge preview')
        if (locked) {
          await this.#git(['worktree', 'unlock', worktreePath], { cwd: this.repoDir })
        }
        await this.#git(['worktree', 'remove', worktreePath], { cwd: this.repoDir })
      }
    }
  }

  async #abortMergeIfNeeded(worktreePath: string): Promise<void> {
    const merging = await this.#git(
      ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
      { cwd: worktreePath, allowedExitCodes: [0, 1] },
    )
    if (merging.exitCode === 0) {
      await this.#git(['merge', '--abort'], { cwd: worktreePath })
    }
  }

  async #assertCleanWorktree(worktreePath: string, label: string): Promise<void> {
    const dirty = (
      await this.#git(['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: worktreePath,
      })
    ).stdout
    if (dirty.length > 0) {
      throw new CanvasGitError(
        'DIRTY_WORKTREE',
        `Canvas worktree has uncommitted changes: ${label}`,
      )
    }
  }

  async #ensureInitialized(): Promise<void> {
    await this.#assertSafeManagedPaths()
    const current = await this.#repositoryState()
    if (current === 'ready') return
    if (current === 'invalid') {
      throw new CanvasGitError(
        'GIT_COMMAND_FAILED',
        `Canvas state path exists but is not a Git worktree: ${this.repoDir}`,
      )
    }

    await mkdir(resolve(this.projectDir, '.gg'), { recursive: true, mode: 0o700 })
    await this.#git(
      ['init', `--initial-branch=${DEFAULT_BRANCH}`, this.repoDir],
      { cwd: this.projectDir },
    )
    await atomicWriteText(
      join(this.repoDir, '.gitignore'),
      '.DS_Store\n',
    )
  }

  async #requireInitialized(): Promise<void> {
    await this.#assertSafeManagedPaths()
    const state = await this.#repositoryState()
    if (state === 'missing') {
      throw new CanvasGitError('REPOSITORY_EMPTY', 'Canvas Git history has not been initialized')
    }
    if (state === 'invalid') {
      throw new CanvasGitError(
        'GIT_COMMAND_FAILED',
        `Canvas state path is not a valid Git worktree: ${this.repoDir}`,
      )
    }
  }

  async #inspectStatus(): Promise<CanvasGitStatus> {
    let gitAvailable = true
    try {
      await this.#git(['--version'], { cwd: this.projectDir })
    } catch (error) {
      gitAvailable = !(error instanceof CanvasGitError && error.code === 'GIT_UNAVAILABLE')
      const reason = errorMessage(error)
      this.#degraded = { reason, gitAvailable }
      return {
        state: 'degraded',
        initialized: (await this.#repositoryStateWithoutGit()) === 'present',
        gitAvailable,
        reason,
      }
    }

    try {
      await this.#assertSafeManagedPaths()
      const state = await this.#repositoryState()
      if (state === 'missing') {
        this.#degraded = null
        return { state: 'uninitialized', initialized: false, gitAvailable: true }
      }
      if (state === 'invalid') {
        const reason = `Canvas state path is not a valid Git worktree: ${this.repoDir}`
        this.#degraded = { reason, gitAvailable: true }
        return {
          state: 'degraded',
          initialized: false,
          gitAvailable: true,
          reason,
        }
      }
      if (this.#degraded) {
        return {
          state: 'degraded',
          initialized: true,
          gitAvailable: this.#degraded.gitAvailable,
          reason: this.#degraded.reason,
        }
      }
      this.#degraded = null
      return { state: 'ready', initialized: true, gitAvailable: true }
    } catch (error) {
      const reason = errorMessage(error)
      this.#degraded = { reason, gitAvailable: true }
      return {
        state: 'degraded',
        initialized: (await this.#repositoryStateWithoutGit()) === 'present',
        gitAvailable: true,
        reason,
      }
    }
  }

  async #repositoryState(): Promise<'missing' | 'ready' | 'invalid'> {
    try {
      const info = await lstat(this.repoDir)
      if (!info.isDirectory() || info.isSymbolicLink()) return 'invalid'
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return 'missing'
      throw error
    }
    const probe = await this.#git(
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: this.repoDir, allowedExitCodes: [0, 128] },
    )
    return probe.exitCode === 0 && probe.stdout.trim() === 'true' ? 'ready' : 'invalid'
  }

  async #repositoryStateWithoutGit(): Promise<'missing' | 'present'> {
    try {
      await lstat(this.repoDir)
      return 'present'
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return 'missing'
      throw error
    }
  }

  async #requireHead(): Promise<void> {
    if (!(await this.#hasHead(this.repoDir))) {
      throw new CanvasGitError(
        'REPOSITORY_EMPTY',
        'Create the first canvas checkpoint before creating a branch',
      )
    }
  }

  async #hasHead(cwd: string): Promise<boolean> {
    const result = await this.#git(
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      { cwd, allowedExitCodes: [0, 1] },
    )
    return result.exitCode === 0
  }

  async #validateBranch(branch: string): Promise<void> {
    if (
      typeof branch !== 'string'
      || branch.length === 0
      || branch.length > MAX_CANVAS_BRANCH_LENGTH
      || branch.startsWith('-')
      || branch.startsWith('@{')
      || branch.includes('\0')
    ) {
      throw new CanvasGitError('INVALID_BRANCH', 'Invalid canvas branch name')
    }
    const result = await this.#git(
      ['check-ref-format', '--branch', branch],
      { cwd: this.projectDir, allowedExitCodes: [0, 1, 128, 129] },
    )
    if (result.exitCode !== 0) {
      throw new CanvasGitError('INVALID_BRANCH', `Invalid canvas branch name: ${branch}`)
    }
  }

  async #branchExists(branch: string): Promise<boolean> {
    const result = await this.#git(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { cwd: this.repoDir, allowedExitCodes: [0, 1] },
    )
    return result.exitCode === 0
  }

  async #resolveStartPoint(startPoint: string): Promise<string> {
    if (/^[0-9a-f]{40,64}$/i.test(startPoint)) {
      const result = await this.#git(
        ['cat-file', '-e', `${startPoint}^{commit}`],
        { cwd: this.repoDir, allowedExitCodes: [0, 1, 128] },
      )
      if (result.exitCode !== 0) {
        throw new CanvasGitError('CHECKPOINT_NOT_FOUND', 'Canvas checkpoint does not exist')
      }
      return startPoint
    }
    await this.#validateBranch(startPoint)
    if (!(await this.#branchExists(startPoint))) {
      throw new CanvasGitError('BRANCH_NOT_FOUND', `Canvas branch does not exist: ${startPoint}`)
    }
    return `refs/heads/${startPoint}`
  }

  async #resolveReadableRef(
    refOrBranch: string,
  ): Promise<{ ref: string; branch: string | null }> {
    if (/^[0-9a-f]{40,64}$/i.test(refOrBranch)) {
      const result = await this.#git(
        ['cat-file', '-e', `${refOrBranch}^{commit}`],
        { cwd: this.repoDir, allowedExitCodes: [0, 1, 128] },
      )
      if (result.exitCode !== 0) {
        throw new CanvasGitError('CHECKPOINT_NOT_FOUND', 'Canvas checkpoint does not exist')
      }
      return { ref: refOrBranch, branch: null }
    }
    await this.#validateBranch(refOrBranch)
    if (!(await this.#branchExists(refOrBranch))) {
      throw new CanvasGitError(
        'BRANCH_NOT_FOUND',
        `Canvas branch does not exist: ${refOrBranch}`,
      )
    }
    return { ref: `refs/heads/${refOrBranch}`, branch: refOrBranch }
  }

  async #assertCheckpointOnBranch(checkpoint: string, branch: string): Promise<void> {
    const exists = await this.#git(
      ['cat-file', '-e', `${checkpoint}^{commit}`],
      { cwd: this.repoDir, allowedExitCodes: [0, 1, 128] },
    )
    if (exists.exitCode !== 0) {
      throw new CanvasGitError('CHECKPOINT_NOT_FOUND', 'Canvas checkpoint does not exist')
    }
    const ancestor = await this.#git(
      ['merge-base', '--is-ancestor', checkpoint, `refs/heads/${branch}`],
      { cwd: this.repoDir, allowedExitCodes: [0, 1] },
    )
    if (ancestor.exitCode !== 0) {
      throw new CanvasGitError(
        'CHECKPOINT_NOT_FOUND',
        `Checkpoint is not part of canvas branch ${branch}`,
      )
    }
  }

  async #createWorktree(branch: string, startPoint: string): Promise<CanvasGitWorktree> {
    await mkdir(this.worktreesDir, { recursive: true, mode: 0o700 })
    let id = this.#uuid()
    if (!isUuid(id)) id = randomUUID()
    const path = resolve(this.worktreesDir, id)
    if (!isPathWithin(this.worktreesDir, path) || path === this.worktreesDir) {
      throw new CanvasGitError('UNSAFE_PATH', 'Generated canvas worktree path is unsafe')
    }
    try {
      await lstat(path)
      throw new CanvasGitError('UNSAFE_PATH', 'Generated canvas worktree path already exists')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }

    await this.#git(
      ['worktree', 'add', '-b', branch, path, startPoint],
      { cwd: this.repoDir },
    )
    await this.#git(
      ['worktree', 'lock', '--reason', MANAGED_LOCK_REASON, path],
      { cwd: this.repoDir },
    )
    const canonicalPath = await canonicalizePotentialPath(path)
    const worktree = (await this.#listWorktreesInternal()).find(
      (candidate) => candidate.path === canonicalPath,
    )
    if (!worktree) {
      throw new CanvasGitError('GIT_COMMAND_FAILED', 'Git did not report the new canvas worktree')
    }
    return worktree
  }

  async #worktreeForBranch(branch: string): Promise<CanvasGitWorktree> {
    if (!(await this.#branchExists(branch))) {
      // `main` is unborn until its first checkpoint.
      if (branch === DEFAULT_BRANCH && !(await this.#hasHead(this.repoDir))) {
        return {
          id: DEFAULT_BRANCH,
          path: this.repoDir,
          branch: DEFAULT_BRANCH,
          commit: '',
          locked: false,
          prunable: false,
          managed: true,
        }
      }
      throw new CanvasGitError('BRANCH_NOT_FOUND', `Canvas branch does not exist: ${branch}`)
    }
    const worktree = (await this.#listWorktreesInternal()).find(
      (candidate) => candidate.branch === branch,
    )
    if (!worktree) {
      throw new CanvasGitError(
        'UNMANAGED_WORKTREE',
        `Canvas branch has no active managed worktree: ${branch}`,
      )
    }
    if (!worktree.managed) {
      throw new CanvasGitError(
        'UNMANAGED_WORKTREE',
        `Canvas branch is checked out outside the managed state directory: ${branch}`,
      )
    }
    return worktree
  }

  async #listWorktreesInternal(): Promise<CanvasGitWorktree[]> {
    const output = await this.#git(
      ['worktree', 'list', '--porcelain', '-z'],
      { cwd: this.repoDir },
    )
    const [canonicalRepo, canonicalWorktrees] = await Promise.all([
      canonicalizePotentialPath(this.repoDir),
      canonicalizePotentialPath(this.worktreesDir),
    ])
    return Promise.all(parseWorktrees(output.stdout).map(async (worktree) => {
      const path = await canonicalizePotentialPath(resolve(worktree.path))
      const primary = path === canonicalRepo
      const linked = isPathWithin(canonicalWorktrees, path) && path !== canonicalWorktrees
      return {
        id: primary ? DEFAULT_BRANCH : basename(path),
        path,
        branch: worktree.branch,
        commit: worktree.commit,
        locked: worktree.locked,
        ...(worktree.lockReason === undefined ? {} : { lockReason: worktree.lockReason }),
        prunable: worktree.prunable,
        managed: primary || linked,
      }
    }))
  }

  async #writeSnapshot(worktreePath: string, snapshot: NormalizedSnapshot): Promise<void> {
    await this.#assertManagedWorktreePath(worktreePath)
    await Promise.all(
      ['nodes', 'edges', 'runs', 'artifacts'].map((directory) =>
        rm(resolve(worktreePath, directory), { recursive: true, force: true }),
      ),
    )
    await Promise.all(
      ['nodes', 'edges', 'runs', 'artifacts'].map((directory) =>
        mkdir(resolve(worktreePath, directory), { recursive: true, mode: 0o700 }),
      ),
    )
    await writeJson(resolve(worktreePath, 'project.json'), snapshot.project)
    const sourcePath = resolve(worktreePath, 'source.json')
    if (snapshot.source) await writeJson(sourcePath, snapshot.source)
    else await rm(sourcePath, { force: true })
    await Promise.all([
      writeEntries(resolve(worktreePath, 'nodes'), snapshot.nodes),
      writeEntries(resolve(worktreePath, 'edges'), snapshot.edges),
      writeEntries(resolve(worktreePath, 'runs'), snapshot.runs),
      writeEntries(resolve(worktreePath, 'artifacts'), snapshot.artifacts),
      ...(snapshot.runIndex === null
        ? []
        : [writeJson(resolve(worktreePath, 'runs', 'index.json'), snapshot.runIndex)]),
      ...(snapshot.artifactIndex === null
        ? []
        : [writeJson(
            resolve(worktreePath, 'artifacts', 'index.json'),
            snapshot.artifactIndex,
          )]),
    ])
  }

  async #readDocumentFromWorktree(worktreePath: string): Promise<unknown> {
    await this.#assertManagedWorktreePath(worktreePath)
    const [project, nodes, edges] = await Promise.all([
      readJsonFile(resolve(worktreePath, 'project.json')),
      readJsonDirectory(resolve(worktreePath, 'nodes')),
      readJsonDirectory(resolve(worktreePath, 'edges')),
    ])
    if (!isPlainObject(project)) {
      throw new CanvasGitError('INVALID_SNAPSHOT', 'Git project.json must contain an object')
    }
    return { ...project, nodes, edges }
  }

  async #readDocumentFromTree(ref: string): Promise<unknown> {
    const projectResult = await this.#git(['show', `${ref}:project.json`], {
      cwd: this.repoDir,
    })
    let project: unknown
    try {
      project = JSON.parse(projectResult.stdout) as unknown
    } catch (error) {
      throw new CanvasGitError(
        'INVALID_SNAPSHOT',
        'Git project.json contains invalid JSON',
        { cause: error },
      )
    }
    if (!isPlainObject(project)) {
      throw new CanvasGitError('INVALID_SNAPSHOT', 'Git project.json must contain an object')
    }

    const tree = await this.#git(
      ['ls-tree', '-r', '-z', '--name-only', ref, '--', 'nodes', 'edges'],
      { cwd: this.repoDir },
    )
    const nodePaths: string[] = []
    const edgePaths: string[] = []
    for (const path of tree.stdout.split('\0').filter(Boolean)) {
      if (!/^(nodes|edges)\/[^/]+\.json$/.test(path)) {
        throw new CanvasGitError('INVALID_SNAPSHOT', `Unexpected canvas Git path: ${path}`)
      }
      if (path.startsWith('nodes/')) nodePaths.push(path)
      else edgePaths.push(path)
    }

    // Historical restores are infrequent; bounded batches avoid launching an
    // unbounded number of Git processes for a large graph.
    const nodes = await this.#readTreeJsonFiles(ref, nodePaths.sort())
    const edges = await this.#readTreeJsonFiles(ref, edgePaths.sort())
    return { ...project, nodes, edges }
  }

  async #readTreeJsonFiles(ref: string, paths: readonly string[]): Promise<unknown[]> {
    const values: unknown[] = []
    const batchSize = 16
    for (let index = 0; index < paths.length; index += batchSize) {
      const batch = paths.slice(index, index + batchSize)
      const results = await Promise.all(
        batch.map((path) => this.#git(['show', `${ref}:${path}`], { cwd: this.repoDir })),
      )
      for (const result of results) {
        try {
          values.push(JSON.parse(result.stdout) as unknown)
        } catch (error) {
          throw new CanvasGitError('INVALID_SNAPSHOT', 'Canvas Git entity contains invalid JSON', {
            cause: error,
          })
        }
      }
    }
    return values
  }

  async #assertSafeManagedPaths(): Promise<void> {
    let canonicalProject: string
    try {
      canonicalProject = await realpath(this.projectDir)
    } catch (error) {
      throw new CanvasGitError('UNSAFE_PATH', 'Project directory cannot be resolved safely', {
        cause: error,
      })
    }
    for (const path of [resolve(this.projectDir, '.gg'), this.repoDir, this.worktreesDir]) {
      const canonical = await canonicalizePotentialPath(path)
      if (!isPathWithin(canonicalProject, canonical)) {
        throw new CanvasGitError('UNSAFE_PATH', `Canvas Git path escapes the project: ${path}`)
      }
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink()) {
          throw new CanvasGitError('UNSAFE_PATH', `Canvas Git path must not be a symlink: ${path}`)
        }
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
  }

  async #assertManagedWorktreePath(path: string): Promise<void> {
    await this.#assertSafeManagedPaths()
    const absolute = await canonicalizePotentialPath(resolve(path))
    const canonicalRepo = await canonicalizePotentialPath(this.repoDir)
    const canonicalWorktrees = await canonicalizePotentialPath(this.worktreesDir)
    const primary = absolute === canonicalRepo
    const linked = isPathWithin(canonicalWorktrees, absolute) && absolute !== canonicalWorktrees
    if (!primary && !linked) {
      throw new CanvasGitError('UNSAFE_PATH', `Worktree is outside managed state paths: ${path}`)
    }
    const canonicalRoot = primary ? canonicalRepo : canonicalWorktrees
    if (!isPathWithin(canonicalRoot, absolute)) {
      throw new CanvasGitError('UNSAFE_PATH', `Worktree resolves outside managed state paths: ${path}`)
    }
  }

  async #git(arguments_: readonly string[], options: GitOptions = {}): Promise<GitResult> {
    const args = ['-c', 'core.hooksPath=/dev/null', ...arguments_]
    const cwd = options.cwd ?? this.projectDir
    const allowedExitCodes = new Set(options.allowedExitCodes ?? [0])
    return new Promise((resolvePromise, reject) => {
      execFile(
        this.#gitBinary,
        args,
        {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            LC_ALL: 'C',
          },
          maxBuffer: MAX_GIT_OUTPUT,
          timeout: this.#gitTimeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const errorExitCode = typeof error?.code === 'number' ? error.code : null
          const exitCode = errorExitCode ?? 0
          if (error && (errorExitCode === null || !allowedExitCodes.has(errorExitCode))) {
            if (isNodeError(error, 'ENOENT')) {
              reject(
                new CanvasGitError('GIT_UNAVAILABLE', 'Git executable is not available', {
                  cause: error,
                }),
              )
              return
            }
            const detail = sanitizeGitError(stderr || error.message)
            reject(
              new CanvasGitError(
                'GIT_COMMAND_FAILED',
                detail ? `Git command failed: ${detail}` : 'Git command failed',
                { cause: error, exitCode },
              ),
            )
            return
          }
          resolvePromise({ stdout, stderr, exitCode })
        },
      )
    })
  }

  #recordFailure(error: unknown): void {
    if (!(error instanceof CanvasGitError)) return
    // Validation and user-state errors do not mean Git itself is degraded.
    if (
      error.code !== 'GIT_COMMAND_FAILED'
      && error.code !== 'GIT_UNAVAILABLE'
      && error.code !== 'UNSAFE_PATH'
    ) return
    this.#degraded = {
      reason: error.message,
      gitAvailable: error.code !== 'GIT_UNAVAILABLE',
    }
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

function mergePreview(
  metadata: MergeMetadata,
  paths: string[],
  conflicts: GitMergePreview['conflicts'],
): GitMergePreview {
  const allPaths = [...new Set([...paths, ...conflicts.map((conflict) => conflict.path)])].sort()
  const sourceAlreadyIncluded = metadata.sourceCommit === metadata.targetCommit
    || metadata.baseCommit === metadata.sourceCommit
  const state = conflicts.length > 0
    ? 'conflicts'
    : sourceAlreadyIncluded
      ? 'up-to-date'
      : 'ready'
  return {
    ...metadata,
    state,
    changed: state !== 'up-to-date',
    paths: allPaths,
    conflicts,
    ...(state === 'conflicts'
      ? { resolution: { requiresExplicitApproval: true as const } }
      : {}),
  }
}

function mergeSubject(sourceBranch: string, targetBranch: string): string {
  return `canvas: merge ${sourceBranch} into ${targetBranch}`.slice(0, 200)
}

/** Stable, collision-resistant filename for a user-provided entity ID. */
export function canvasGitEntityFileName(id: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new CanvasGitError('INVALID_SNAPSHOT', 'Checkpoint entity ID must be non-empty')
  }
  const encoded = encodeURIComponent(id)
    .replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .slice(0, 96)
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 12)
  return `${encoded}--${digest}.json`
}

function normalizeSnapshot(
  document: unknown,
  runs: readonly unknown[] = [],
  runIndex: unknown,
  artifacts: readonly unknown[] = [],
  artifactIndex: unknown,
  source: CanvasGitSourceMetadata | null | undefined = null,
): NormalizedSnapshot {
  if (!isPlainObject(document)) {
    throw new CanvasGitError('INVALID_SNAPSHOT', 'Canvas checkpoint document must be an object')
  }
  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
    throw new CanvasGitError(
      'INVALID_SNAPSHOT',
      'Canvas checkpoint document must contain node and edge arrays',
    )
  }

  const project = { ...document }
  delete project.nodes
  delete project.edges
  // Generation panels contain raw Agent/tool text. Durable JSONL logs remain
  // outside Git and can be deleted independently; never copy their preview
  // into immutable canvas history.
  delete project.generationByNodeId
  return {
    project: canonicalJsonValue(project),
    source: source == null ? null : parseSourceMetadata(source),
    nodes: normalizeEntries(document.nodes, ['id'], 'node'),
    edges: normalizeEntries(document.edges, ['id'], 'edge'),
    runs: normalizeEntries(runs, ['runId', 'id'], 'run'),
    runIndex: normalizeCollectionIndex(runIndex, 'run'),
    artifacts: normalizeEntries(artifacts, ['nodeId', 'id', 'path'], 'artifact'),
    artifactIndex: normalizeCollectionIndex(artifactIndex, 'artifact'),
  }
}

function normalizeCollectionIndex(value: unknown, label: string): unknown | null {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) {
    throw new CanvasGitError(
      'INVALID_SNAPSHOT',
      `Canvas checkpoint ${label} collection index must be an object`,
    )
  }
  return canonicalJsonValue(value)
}

function normalizeEntries(
  values: readonly unknown[],
  identifierKeys: readonly string[],
  label: string,
): NormalizedEntry[] {
  const identifiers = new Set<string>()
  return values
    .map((value, index) => {
      if (!isPlainObject(value)) {
        throw new CanvasGitError(
          'INVALID_SNAPSHOT',
          `Canvas checkpoint ${label} ${index} must be an object`,
        )
      }
      const identifier = identifierKeys
        .map((key) => value[key])
        .find((candidate): candidate is string =>
          typeof candidate === 'string' && candidate.length > 0,
        )
      if (!identifier) {
        throw new CanvasGitError(
          'INVALID_SNAPSHOT',
          `Canvas checkpoint ${label} ${index} has no stable identifier`,
        )
      }
      if (identifiers.has(identifier)) {
        throw new CanvasGitError(
          'INVALID_SNAPSHOT',
          `Duplicate canvas checkpoint ${label} identifier: ${identifier}`,
        )
      }
      identifiers.add(identifier)
      return {
        fileName: canvasGitEntityFileName(identifier),
        value: canonicalJsonValue(value),
      }
    })
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
}

function parseSourceMetadata(value: unknown): CanvasGitSourceMetadata {
  if (!isPlainObject(value)) {
    throw new CanvasGitError(
      'INVALID_SOURCE_METADATA',
      'Canvas checkpoint source metadata must be an object',
    )
  }
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'commit' || keys[1] !== 'version') {
    throw new CanvasGitError(
      'INVALID_SOURCE_METADATA',
      'Canvas checkpoint source metadata has unexpected fields',
    )
  }
  if (
    value.version !== 1
    || typeof value.commit !== 'string'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.commit)
  ) {
    throw new CanvasGitError(
      'INVALID_SOURCE_METADATA',
      'Canvas checkpoint source metadata is invalid',
    )
  }
  return { version: 1, commit: value.commit }
}

function canonicalJsonValue(value: unknown): unknown {
  let cloned: unknown
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new TypeError('value is not JSON serializable')
    }
    cloned = JSON.parse(serialized) as unknown
  } catch (error) {
    throw new CanvasGitError(
      'INVALID_SNAPSHOT',
      'Canvas checkpoint contains a value that is not JSON serializable',
      { cause: error },
    )
  }
  return sortJsonValue(cloned)
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  )
}

async function writeEntries(directory: string, entries: readonly NormalizedEntry[]): Promise<void> {
  await Promise.all(
    entries.map((entry) => writeJson(resolve(directory, entry.fileName), entry.value)),
  )
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CanvasGitError(
        'UNSAFE_PATH',
        `Canvas Git JSON must be a regular file: ${path}`,
      )
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof CanvasGitError) throw error
    throw new CanvasGitError('INVALID_SNAPSHOT', `Canvas Git file is unreadable: ${path}`, {
      cause: error,
    })
  }
}

async function readJsonDirectory(directory: string): Promise<unknown[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return []
    throw error
  }
  const names = entries
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of names) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new CanvasGitError(
        'UNSAFE_PATH',
        `Canvas Git entity must be a regular file: ${resolve(directory, entry.name)}`,
      )
    }
  }
  return Promise.all(names.map((entry) => readJsonFile(resolve(directory, entry.name))))
}

function parseWorktrees(source: string): PorcelainWorktree[] {
  return source
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      let path: string | undefined
      let commit = ''
      let branch: string | null = null
      let locked = false
      let lockReason: string | undefined
      let prunable = false
      for (const field of record.split('\0').filter(Boolean)) {
        const separator = field.indexOf(' ')
        const key = separator === -1 ? field : field.slice(0, separator)
        const value = separator === -1 ? '' : field.slice(separator + 1)
        if (key === 'worktree') path = value
        else if (key === 'HEAD') commit = value
        else if (key === 'branch') branch = value.replace(/^refs\/heads\//, '')
        else if (key === 'locked') {
          locked = true
          if (value.length > 0) lockReason = value
        } else if (key === 'prunable') prunable = true
      }
      if (!path) {
        throw new CanvasGitError('GIT_COMMAND_FAILED', 'Git returned malformed worktree data')
      }
      return {
        path,
        commit,
        branch,
        locked,
        ...(lockReason === undefined ? {} : { lockReason }),
        prunable,
      }
    })
}

function parseHistory(source: string): CanvasGitHistoryEntry[] {
  const fields = source.split('\0')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 4 !== 0) {
    throw new CanvasGitError('GIT_COMMAND_FAILED', 'Git returned malformed history data')
  }
  const entries: CanvasGitHistoryEntry[] = []
  for (let index = 0; index < fields.length; index += 4) {
    const commit = fields[index]
    const parents = fields[index + 1]
    const seconds = Number(fields[index + 2])
    const subject = fields[index + 3]
    if (!commit || parents === undefined || !Number.isFinite(seconds) || subject === undefined) {
      throw new CanvasGitError('GIT_COMMAND_FAILED', 'Git returned malformed history data')
    }
    entries.push({
      commit,
      parents: parents.length === 0 ? [] : parents.split(' '),
      committedAt: new Date(seconds * 1_000).toISOString(),
      subject,
    })
  }
  return entries
}

function checkpointSubject(reason: string | undefined): string {
  const normalized = reason === undefined
    ? undefined
    : scrubControlCharacters(reason)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
  return normalized ? `canvas: ${normalized}` : 'canvas: checkpoint'
}

function assertCheckpointHash(value: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new CanvasGitError('CHECKPOINT_NOT_FOUND', 'Invalid canvas checkpoint identifier')
  }
}

function canonicalCheckpointHash(value: string): string {
  assertCheckpointHash(value)
  return value.toLowerCase()
}

function sanitizeGitError(value: string): string {
  return scrubControlCharacters(value).replace(/\s+/g, ' ').trim().slice(0, 500)
}

function scrubControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? ' ' : character
  }).join('')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Canvas Git operation failed'
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

/** Test/debug helper for reading the current normalized project metadata. */
export async function readCanvasGitProjectFile(worktreePath: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(worktreePath, 'project.json'), 'utf8')) as unknown
}
