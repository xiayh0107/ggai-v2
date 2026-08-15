import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type { CanvasDocument } from '../src/canvas/model.js'
import { atomicWriteText } from './atomic-file.js'
import {
  CanvasGitCodecError,
  decodeCanvasGitTree,
  encodeCanvasGitTree,
  type CanvasGitTreeEntry,
} from './canvasGitCodec.js'
import {
  nulSeparatedPaths,
  parseUnmergedIndex,
  type GitMergeExecution,
  type GitMergePreview,
} from './mergeTypes.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'
import { MAX_CANVAS_BRANCH_LENGTH } from './protocol.js'

const DEFAULT_BRANCH = 'main'
const MANAGED_LOCK_REASON = 'ggai-v2-managed'
const MANAGED_ROOT_FILES = ['.gitignore', 'meta.json'] as const
const MANAGED_DIRECTORIES = ['tasks', 'nodes', 'collections', 'edges', 'receipts'] as const
const MANAGED_PATHS = [...MANAGED_ROOT_FILES, ...MANAGED_DIRECTORIES] as const
const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 15_000
const TREE_PATH_PATTERN = /^(?:tasks|nodes|collections|edges|receipts)\/[a-z]+_[0-9a-f]{64}\.json$/u

export type CanvasGitErrorCode =
  | 'BRANCH_EXISTS'
  | 'BRANCH_NOT_FOUND'
  | 'CHECKPOINT_NOT_FOUND'
  | 'DIRTY_WORKTREE'
  | 'GIT_COMMAND_FAILED'
  | 'GIT_UNAVAILABLE'
  | 'INVALID_BRANCH'
  | 'INVALID_MERGE'
  | 'INVALID_SNAPSHOT'
  | 'MERGE_FAILED'
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
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CanvasGitError'
    this.code = code
    this.exitCode = options.exitCode
  }
}

export type CanvasGitStatus =
  | { state: 'uninitialized'; initialized: false; gitAvailable: true }
  | { state: 'ready'; initialized: true; gitAvailable: true }
  | {
      state: 'degraded'
      initialized: boolean
      gitAvailable: boolean
      reason: string
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

export interface CanvasGitCheckpointInput {
  branch: string
  document: CanvasDocument
  reason?: string
}

export interface CanvasGitCheckpointResult {
  branch: string
  commit: string
  changed: boolean
  status: Extract<CanvasGitStatus, { state: 'ready' }>
}

export interface CanvasGitCreateBranchInput {
  name: string
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

export interface CanvasGitRecoverableMerge {
  branch: string
  commit: string
  firstParent: string
  secondParent: string
  document: CanvasDocument
  firstParentDocument: CanvasDocument
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
 * Canvas history owns a repository and linked worktrees that are
 * physically disjoint from the legacy Canvas Git store.
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
    this.repoDir = resolve(this.projectDir, '.gg', 'canvas-state-v2')
    this.worktreesDir = resolve(this.projectDir, '.gg', 'canvas-worktrees-v2')
    this.#gitBinary = options.gitBinary ?? 'git'
    this.#uuid = options.uuid ?? randomUUID
    this.#gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  }

  async status(): Promise<CanvasGitStatus> {
    return this.#runExclusive(() => this.#inspectStatus())
  }

  async checkpoint(input: CanvasGitCheckpointInput): Promise<CanvasGitCheckpointResult> {
    const entries = encodeSnapshot(input.document)
    return this.#runExclusive(async () => {
      let worktreePath: string | undefined
      let hadHead = false
      let committed = false
      try {
        await this.#ensureInitialized()
        await this.#validateBranch(input.branch)
        const worktree = await this.#worktreeForBranch(input.branch)
        worktreePath = worktree.path
        hadHead = await this.#hasHead(worktree.path)
        await this.#assertCheckpointReady(worktree.path, input.branch, hadHead)
        if (hadHead) {
          const currentCommit = (
            await this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: worktree.path })
          ).stdout.trim()
          await this.#readDocumentFromTree(currentCommit)
        }

        await this.#writeSnapshot(worktree.path, entries)
        await this.#git(['add', '--all', '--', ...MANAGED_PATHS], { cwd: worktree.path })
        await this.#readDocumentFromWorktree(worktree.path)

        const diff = await this.#git(
          ['diff', '--cached', '--quiet'],
          { cwd: worktree.path, allowedExitCodes: [0, 1] },
        )
        let changed = diff.exitCode === 1
        if (changed || !hadHead) {
          await this.#git(
            [
              '-c',
              'user.name=GGAI',
              '-c',
              'user.email=ggai@local',
              'commit',
              '--no-gpg-sign',
              ...(changed ? [] : ['--allow-empty']),
              '-m',
              checkpointSubject(input.reason),
            ],
            { cwd: worktree.path },
          )
          committed = true
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
        if (worktreePath && !committed) {
          await this.#restoreFailedCheckpoint(worktreePath, hadHead).catch(() => undefined)
        }
        this.#recordFailure(error)
        throw normalizeCodecError(error, 'Canvas checkpoint is invalid')
      }
    })
  }

  async readDocument(refOrBranch: string): Promise<CanvasDocument> {
    return this.#runExclusive(async () => {
      try {
        await this.#requireInitialized()
        const resolved = await this.#resolveReadableRef(refOrBranch)
        const document = await this.#readDocumentFromTree(resolved.ref)
        this.#degraded = null
        return document
      } catch (error) {
        this.#recordFailure(error)
        throw normalizeCodecError(error, 'Canvas checkpoint is invalid')
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

  async listBranches(): Promise<CanvasGitBranch[]> {
    return this.#runExclusive(async () => {
      await this.#requireInitialized()
      const [refs, worktrees] = await Promise.all([
        this.#git(
          [
            'for-each-ref',
            '--sort=refname',
            '--format=%(refname:short)%09%(objectname)',
            'refs/heads/',
          ],
          { cwd: this.repoDir },
        ),
        this.#listWorktreesInternal(),
      ])
      const byBranch = new Map(
        worktrees
          .filter((worktree): worktree is CanvasGitWorktree & { branch: string } =>
            worktree.branch !== null)
          .map((worktree) => [worktree.branch, worktree]),
      )
      const branches = refs.stdout.split('\n').filter(Boolean).map((line) => {
        const separator = line.indexOf('\t')
        if (separator <= 0) {
          throw new CanvasGitError(
            'GIT_COMMAND_FAILED',
            'Git returned malformed Canvas branch data',
          )
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
          throw new CanvasGitError(
            'BRANCH_EXISTS',
            `Canvas branch already exists: ${input.name}`,
          )
        }
        const resolvedStart = await this.#resolveStartPoint(input.startPoint ?? DEFAULT_BRANCH)
        await this.#readDocumentFromTree(resolvedStart)
        const worktree = await this.#createWorktree(input.name, resolvedStart)
        this.#degraded = null
        return { name: input.name, commit: worktree.commit, worktree }
      } catch (error) {
        this.#recordFailure(error)
        throw normalizeCodecError(error, 'Canvas branch start point is invalid')
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
        await this.#readDocumentFromTree(checkpoint)
        const worktree = await this.#createWorktree(input.newBranch, checkpoint)
        this.#degraded = null
        return { name: input.newBranch, commit: worktree.commit, worktree }
      } catch (error) {
        this.#recordFailure(error)
        throw normalizeCodecError(error, 'Canvas restore checkpoint is invalid')
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
          const cursor = canonicalCheckpointHash(options.cursor)
          await this.#assertCheckpointOnBranch(cursor, options.branch)
          const parents = (
            await this.#git(['rev-list', '--parents', '--max-count=1', cursor], {
              cwd: this.repoDir,
            })
          ).stdout.trim().split(/\s+/u)
          if (parents.length === 1) return { entries: [], nextCursor: null }
          startPoint = `${cursor}^1`
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
          nextCursor: allEntries.length > limit ? entries.at(-1)?.commit ?? null : null,
        }
      } catch (error) {
        this.#recordFailure(error)
        throw error
      }
    })
  }

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
        throw normalizeMergeError(error)
      }
    })
  }

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
            return { ...preview, merged: false, commit: metadata.targetCommit }
          }
          if (preview.state === 'up-to-date') {
            return { ...preview, merged: false, commit: metadata.targetCommit }
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
        throw normalizeMergeError(error)
      }
    })
  }

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
        if (fields.length !== 3 || fields[0] !== tip || fields[1] !== checkpoint) return null
        const firstParent = fields[1]
        const secondParent = fields[2]
        if (!firstParent || !secondParent) return null
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
        throw normalizeCodecError(error, 'Canvas recoverable merge is invalid')
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
        throw new CanvasGitError(
          'BRANCH_NOT_FOUND',
          `Canvas branch does not exist: ${branch}`,
        )
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
    const metadata = {
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      sourceCommit: source.stdout.trim(),
      targetCommit: target.stdout.trim(),
      baseCommit: base.exitCode === 0 ? base.stdout.trim() || null : null,
    }
    await Promise.all([
      this.#readDocumentFromTree(metadata.sourceCommit),
      this.#readDocumentFromTree(metadata.targetCommit),
    ])
    return metadata
  }

  async #attemptMerge(
    worktreePath: string,
    sourceBranch: string,
    metadata: MergeMetadata,
  ): Promise<GitMergePreview> {
    const result = await this.#git(
      ['merge', '--no-commit', '--no-ff', '--no-edit', `refs/heads/${sourceBranch}`],
      { cwd: worktreePath, allowedExitCodes: [0, 1] },
    )
    const [unmerged, changed] = await Promise.all([
      this.#git(['ls-files', '-u', '-z'], { cwd: worktreePath }),
      this.#git(['diff', '--name-only', '-z', 'HEAD'], { cwd: worktreePath }),
    ])
    const conflicts = parseUnmergedIndex(unmerged.stdout)
    const paths = nulSeparatedPaths(changed.stdout)
    if (result.exitCode !== 0 && conflicts.length === 0) {
      const detail = sanitizeGitError(result.stderr)
      throw new CanvasGitError(
        'MERGE_FAILED',
        detail ? `Canvas merge failed: ${detail}` : 'Canvas merge failed',
        { exitCode: result.exitCode },
      )
    }
    const preview = mergePreview(metadata, paths, conflicts)
    if (preview.state !== 'conflicts') {
      try {
        await this.#readDocumentFromWorktree(worktreePath)
      } catch (error) {
        throw new CanvasGitError(
          'INVALID_MERGE',
          'Git produced a clean but semantically invalid Canvas merge',
          { cause: error },
        )
      }
    }
    return preview
  }

  async #withPreviewWorktree<T>(
    targetBranch: string,
    operation: (worktreePath: string) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.worktreesDir, { recursive: true, mode: 0o700 })
    const id = managedUuid(this.#uuid())
    const worktreePath = resolve(this.worktreesDir, id)
    await this.#assertUnusedManagedWorktreePath(worktreePath)
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
        await this.#assertCleanWorktree(worktreePath, 'Canvas merge preview')
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

  async #assertCheckpointReady(
    worktreePath: string,
    branch: string,
    hadHead: boolean,
  ): Promise<void> {
    const status = (
      await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: worktreePath,
      })
    ).stdout.split('\0').filter(Boolean)
    if (!hadHead && status.length === 1 && status[0] === '?? .gitignore') return
    if (status.length > 0) {
      throw new CanvasGitError(
        'DIRTY_WORKTREE',
        `Canvas worktree has uncommitted changes: ${branch}`,
      )
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

  async #writeSnapshot(
    worktreePath: string,
    entries: readonly CanvasGitTreeEntry[],
  ): Promise<void> {
    await this.#assertManagedWorktreePath(worktreePath)
    for (const path of MANAGED_PATHS) {
      await removePathWithoutFollowing(resolve(worktreePath, path))
    }
    for (const directory of MANAGED_DIRECTORIES) {
      await mkdir(resolve(worktreePath, directory), { recursive: true, mode: 0o700 })
    }
    const batchSize = 32
    for (let index = 0; index < entries.length; index += batchSize) {
      await Promise.all(entries.slice(index, index + batchSize).map(async (entry) => {
        if (!isManagedTreePath(entry.path)) {
          throw new CanvasGitError(
            'INVALID_SNAPSHOT',
            `Codec returned an unmanaged Canvas path: ${entry.path}`,
          )
        }
        const path = resolve(worktreePath, entry.path)
        if (!isPathWithin(worktreePath, path)) {
          throw new CanvasGitError('UNSAFE_PATH', 'Canvas snapshot path escapes worktree')
        }
        await atomicWriteText(path, entry.content)
      }))
    }
  }

  async #restoreFailedCheckpoint(worktreePath: string, hadHead: boolean): Promise<void> {
    if (hadHead) {
      await this.#git(['reset', '--hard', 'HEAD'], { cwd: worktreePath })
      await this.#git(['clean', '-f', '-d', '--', ...MANAGED_PATHS], { cwd: worktreePath })
      return
    }
    await this.#git(
      ['rm', '-r', '--cached', '--ignore-unmatch', '--', ...MANAGED_PATHS],
      { cwd: worktreePath, allowedExitCodes: [0, 1, 128] },
    )
    for (const path of MANAGED_PATHS) {
      await removePathWithoutFollowing(resolve(worktreePath, path))
    }
  }

  async #readDocumentFromTree(ref: string): Promise<CanvasDocument> {
    const output = await this.#git(['ls-tree', '-r', '-z', '--full-tree', ref], {
      cwd: this.repoDir,
    })
    const paths: string[] = []
    for (const record of output.stdout.split('\0').filter(Boolean)) {
      const separator = record.indexOf('\t')
      const metadata = separator < 0 ? [] : record.slice(0, separator).split(' ')
      const path = separator < 0 ? '' : record.slice(separator + 1)
      if (metadata.length !== 3 || metadata[0] !== '100644' || metadata[1] !== 'blob') {
        throw new CanvasGitError(
          'INVALID_SNAPSHOT',
          `Canvas Git tree contains a non-regular entry: ${path || '<unknown>'}`,
        )
      }
      if (!isManagedTreePath(path)) {
        throw new CanvasGitError(
          'INVALID_SNAPSHOT',
          `Canvas Git tree contains an unsupported path: ${path}`,
        )
      }
      paths.push(path)
    }
    const entries = await this.#readTreeFiles(ref, paths.sort(compareStrings))
    return decodeSnapshot(entries)
  }

  async #readTreeFiles(
    ref: string,
    paths: readonly string[],
  ): Promise<CanvasGitTreeEntry[]> {
    const entries: CanvasGitTreeEntry[] = []
    const batchSize = 16
    for (let index = 0; index < paths.length; index += batchSize) {
      const batch = paths.slice(index, index + batchSize)
      const results = await Promise.all(
        batch.map((path) => this.#git(['show', `${ref}:${path}`], { cwd: this.repoDir })),
      )
      results.forEach((result, resultIndex) => {
        const path = batch[resultIndex]
        if (path !== undefined) entries.push({ path, content: result.stdout })
      })
    }
    return entries
  }

  async #readDocumentFromWorktree(worktreePath: string): Promise<CanvasDocument> {
    await this.#assertManagedWorktreePath(worktreePath)
    const index = await this.#git(['ls-files', '-s', '-z'], { cwd: worktreePath })
    const indexedPaths: string[] = []
    for (const record of index.stdout.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) [0-9a-f]+ ([0-3])\t(.+)$/u.exec(record)
      if (!match || match[1] !== '100644' || match[2] !== '0') {
        throw new CanvasGitError(
          'INVALID_SNAPSHOT',
          'Canvas worktree index contains a non-regular or unmerged entry',
        )
      }
      const path = match[3]
      if (!path || !isManagedTreePath(path)) {
        throw new CanvasGitError(
          'INVALID_SNAPSHOT',
          `Canvas worktree contains an unsupported indexed path: ${path ?? '<unknown>'}`,
        )
      }
      indexedPaths.push(path)
    }
    indexedPaths.sort(compareStrings)
    const actualPaths = await listManagedWorktreeFiles(worktreePath)
    if (!sameStrings(actualPaths, indexedPaths)) {
      throw new CanvasGitError(
        'INVALID_SNAPSHOT',
        'Canvas worktree files do not exactly match its Git index',
      )
    }
    const entries = await Promise.all(actualPaths.map(async (path) => ({
      path,
      content: await readFile(resolve(worktreePath, path), 'utf8'),
    })))
    return decodeSnapshot(entries)
  }

  async #ensureInitialized(): Promise<void> {
    await this.#assertSafeManagedPaths()
    const current = await this.#repositoryState()
    if (current === 'ready') return
    if (current === 'invalid') {
      throw new CanvasGitError(
        'GIT_COMMAND_FAILED',
        `Canvas state path is not a Git worktree: ${this.repoDir}`,
      )
    }
    await mkdir(resolve(this.projectDir, '.gg'), { recursive: true, mode: 0o700 })
    await this.#git(
      ['init', `--initial-branch=${DEFAULT_BRANCH}`, this.repoDir],
      { cwd: this.projectDir },
    )
    await atomicWriteText(resolve(this.repoDir, '.gitignore'), '.DS_Store\n')
  }

  async #requireInitialized(): Promise<void> {
    await this.#assertSafeManagedPaths()
    const state = await this.#repositoryState()
    if (state === 'missing') {
      throw new CanvasGitError(
        'REPOSITORY_EMPTY',
        'Canvas Git history has not been initialized',
      )
    }
    if (state === 'invalid') {
      throw new CanvasGitError(
        'GIT_COMMAND_FAILED',
        `Canvas state path is not a valid Git worktree: ${this.repoDir}`,
      )
    }
  }

  async #inspectStatus(): Promise<CanvasGitStatus> {
    try {
      await this.#git(['--version'], { cwd: this.projectDir })
    } catch (error) {
      const gitAvailable = !(error instanceof CanvasGitError
        && error.code === 'GIT_UNAVAILABLE')
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
    try {
      const gitDirectory = await lstat(resolve(this.repoDir, '.git'))
      if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) return 'invalid'
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return 'invalid'
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
        'Create the first Canvas checkpoint before creating a branch',
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
      throw new CanvasGitError('INVALID_BRANCH', 'Invalid Canvas branch name')
    }
    const result = await this.#git(
      ['check-ref-format', '--branch', branch],
      { cwd: this.projectDir, allowedExitCodes: [0, 1, 128, 129] },
    )
    if (result.exitCode !== 0) {
      throw new CanvasGitError(
        'INVALID_BRANCH',
        `Invalid Canvas branch name: ${branch}`,
      )
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
    if (isCheckpointHash(startPoint)) {
      const checkpoint = startPoint.toLowerCase()
      const result = await this.#git(
        ['cat-file', '-e', `${checkpoint}^{commit}`],
        { cwd: this.repoDir, allowedExitCodes: [0, 1, 128] },
      )
      if (result.exitCode !== 0) {
        throw new CanvasGitError(
          'CHECKPOINT_NOT_FOUND',
          'Canvas checkpoint does not exist',
        )
      }
      return checkpoint
    }
    await this.#validateBranch(startPoint)
    if (!(await this.#branchExists(startPoint))) {
      throw new CanvasGitError(
        'BRANCH_NOT_FOUND',
        `Canvas branch does not exist: ${startPoint}`,
      )
    }
    return `refs/heads/${startPoint}`
  }

  async #resolveReadableRef(refOrBranch: string): Promise<{ ref: string; branch: string | null }> {
    if (isCheckpointHash(refOrBranch)) {
      const checkpoint = refOrBranch.toLowerCase()
      const result = await this.#git(
        ['cat-file', '-e', `${checkpoint}^{commit}`],
        { cwd: this.repoDir, allowedExitCodes: [0, 1, 128] },
      )
      if (result.exitCode !== 0) {
        throw new CanvasGitError(
          'CHECKPOINT_NOT_FOUND',
          'Canvas checkpoint does not exist',
        )
      }
      return { ref: checkpoint, branch: null }
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
      throw new CanvasGitError(
        'CHECKPOINT_NOT_FOUND',
        'Canvas checkpoint does not exist',
      )
    }
    const ancestor = await this.#git(
      ['merge-base', '--is-ancestor', checkpoint, `refs/heads/${branch}`],
      { cwd: this.repoDir, allowedExitCodes: [0, 1] },
    )
    if (ancestor.exitCode !== 0) {
      throw new CanvasGitError(
        'CHECKPOINT_NOT_FOUND',
        `Checkpoint is not part of Canvas branch ${branch}`,
      )
    }
  }

  async #createWorktree(branch: string, startPoint: string): Promise<CanvasGitWorktree> {
    await mkdir(this.worktreesDir, { recursive: true, mode: 0o700 })
    const id = managedUuid(this.#uuid())
    const path = resolve(this.worktreesDir, id)
    await this.#assertUnusedManagedWorktreePath(path)
    let added = false
    let locked = false
    try {
      await this.#git(['worktree', 'add', '-b', branch, path, startPoint], {
        cwd: this.repoDir,
      })
      added = true
      await this.#git(
        ['worktree', 'lock', '--reason', MANAGED_LOCK_REASON, path],
        { cwd: this.repoDir },
      )
      locked = true
      const canonicalPath = await canonicalizePotentialPath(path)
      const worktree = (await this.#listWorktreesInternal()).find(
        (candidate) => candidate.path === canonicalPath,
      )
      if (!worktree) {
        throw new CanvasGitError(
          'GIT_COMMAND_FAILED',
          'Git did not report the new Canvas worktree',
        )
      }
      return worktree
    } catch (error) {
      if (added) {
        if (locked) {
          await this.#git(['worktree', 'unlock', path], { cwd: this.repoDir })
            .catch(() => undefined)
        }
        await this.#git(['worktree', 'remove', '--force', path], { cwd: this.repoDir })
          .catch(() => undefined)
        await this.#git(['branch', '--delete', '--force', '--', branch], { cwd: this.repoDir })
          .catch(() => undefined)
      }
      throw error
    }
  }

  async #assertUnusedManagedWorktreePath(path: string): Promise<void> {
    if (!isPathWithin(this.worktreesDir, path) || path === this.worktreesDir) {
      throw new CanvasGitError('UNSAFE_PATH', 'Generated Canvas worktree path is unsafe')
    }
    try {
      await lstat(path)
      throw new CanvasGitError(
        'UNSAFE_PATH',
        'Generated Canvas worktree path already exists',
      )
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  async #worktreeForBranch(branch: string): Promise<CanvasGitWorktree> {
    if (!(await this.#branchExists(branch))) {
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
      throw new CanvasGitError(
        'BRANCH_NOT_FOUND',
        `Canvas branch does not exist: ${branch}`,
      )
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
        `Canvas branch is checked out outside managed state: ${branch}`,
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

  async #assertSafeManagedPaths(): Promise<void> {
    let canonicalProject: string
    try {
      canonicalProject = await realpath(this.projectDir)
    } catch (error) {
      throw new CanvasGitError(
        'UNSAFE_PATH',
        'Project directory cannot be resolved safely',
        { cause: error },
      )
    }
    for (const path of [resolve(this.projectDir, '.gg'), this.repoDir, this.worktreesDir]) {
      const canonical = await canonicalizePotentialPath(path)
      if (!isPathWithin(canonicalProject, canonical)) {
        throw new CanvasGitError(
          'UNSAFE_PATH',
          `Canvas Git path escapes the project: ${path}`,
        )
      }
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink()) {
          throw new CanvasGitError(
            'UNSAFE_PATH',
            `Canvas Git path must not be a symlink: ${path}`,
          )
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
      throw new CanvasGitError(
        'UNSAFE_PATH',
        `Worktree is outside managed Canvas state paths: ${path}`,
      )
    }
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CanvasGitError(
        'UNSAFE_PATH',
        `Managed Canvas worktree must be a real directory: ${path}`,
      )
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
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
          maxBuffer: MAX_GIT_OUTPUT,
          timeout: this.#gitTimeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const errorExitCode = typeof error?.code === 'number' ? error.code : null
          const exitCode = errorExitCode ?? 0
          if (error && (errorExitCode === null || !allowedExitCodes.has(errorExitCode))) {
            if (isNodeError(error, 'ENOENT')) {
              reject(new CanvasGitError(
                'GIT_UNAVAILABLE',
                'Git executable is not available',
                { cause: error },
              ))
              return
            }
            const detail = sanitizeGitError(stderr || error.message)
            reject(new CanvasGitError(
              'GIT_COMMAND_FAILED',
              detail ? `Git command failed: ${detail}` : 'Git command failed',
              { cause: error, exitCode },
            ))
            return
          }
          resolvePromise({ stdout, stderr, exitCode })
        },
      )
    })
  }

  #recordFailure(error: unknown): void {
    if (!(error instanceof CanvasGitError)) return
    if (error.code !== 'GIT_COMMAND_FAILED'
      && error.code !== 'GIT_UNAVAILABLE'
      && error.code !== 'UNSAFE_PATH') return
    this.#degraded = {
      reason: error.message,
      gitAvailable: error.code !== 'GIT_UNAVAILABLE',
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function encodeSnapshot(document: CanvasDocument): CanvasGitTreeEntry[] {
  try {
    return encodeCanvasGitTree(document)
  } catch (error) {
    throw normalizeCodecError(error, 'Canvas document cannot be checkpointed')
  }
}

function decodeSnapshot(entries: readonly CanvasGitTreeEntry[]): CanvasDocument {
  try {
    return decodeCanvasGitTree(entries)
  } catch (error) {
    throw normalizeCodecError(error, 'Canvas Git tree is invalid')
  }
}

function normalizeCodecError(error: unknown, message: string): unknown {
  return error instanceof CanvasGitCodecError
    ? new CanvasGitError('INVALID_SNAPSHOT', message, { cause: error })
    : error
}

function normalizeMergeError(error: unknown): unknown {
  if (error instanceof CanvasGitCodecError) {
    return new CanvasGitError(
      'INVALID_MERGE',
      'Canvas merge failed semantic validation',
      { cause: error },
    )
  }
  return error
}

function mergePreview(
  metadata: MergeMetadata,
  paths: string[],
  conflicts: GitMergePreview['conflicts'],
): GitMergePreview {
  const allPaths = [...new Set([...paths, ...conflicts.map((conflict) => conflict.path)])]
    .sort(compareStrings)
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

function checkpointSubject(reason: string | undefined): string {
  const normalized = reason === undefined
    ? undefined
    : scrubControlCharacters(reason).replace(/\s+/gu, ' ').trim().slice(0, 120)
  return normalized ? `canvas: ${normalized}` : 'canvas: checkpoint'
}

function mergeSubject(sourceBranch: string, targetBranch: string): string {
  return `canvas: merge ${sourceBranch} into ${targetBranch}`.slice(0, 200)
}

function parseHistory(source: string): CanvasGitHistoryEntry[] {
  const fields = source.split('\0')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 4 !== 0) {
    throw new CanvasGitError(
      'GIT_COMMAND_FAILED',
      'Git returned malformed Canvas history data',
    )
  }
  const entries: CanvasGitHistoryEntry[] = []
  for (let index = 0; index < fields.length; index += 4) {
    const commit = fields[index]
    const parents = fields[index + 1]
    const seconds = Number(fields[index + 2])
    const subject = fields[index + 3]
    if (!commit || parents === undefined || !Number.isFinite(seconds) || subject === undefined) {
      throw new CanvasGitError(
        'GIT_COMMAND_FAILED',
        'Git returned malformed Canvas history data',
      )
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

function parseWorktrees(source: string): PorcelainWorktree[] {
  return source.split('\0\0').filter(Boolean).map((record) => {
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
      else if (key === 'branch') branch = value.replace(/^refs\/heads\//u, '')
      else if (key === 'locked') {
        locked = true
        if (value.length > 0) lockReason = value
      } else if (key === 'prunable') prunable = true
    }
    if (!path) {
      throw new CanvasGitError(
        'GIT_COMMAND_FAILED',
        'Git returned malformed Canvas worktree data',
      )
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

async function listManagedWorktreeFiles(worktreePath: string): Promise<string[]> {
  const paths: string[] = []
  const topLevel = await readdir(worktreePath, { withFileTypes: true })
  for (const entry of topLevel) {
    if (entry.name === '.git') continue
    const path = resolve(worktreePath, entry.name)
    const info = await lstat(path)
    if (entry.name === '.DS_Store') {
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new CanvasGitError('UNSAFE_PATH', `Ignored path is unsafe: ${path}`)
      }
      continue
    }
    if (info.isSymbolicLink()) {
      throw new CanvasGitError(
        'UNSAFE_PATH',
        `Canvas worktree path must not be a symlink: ${path}`,
      )
    }
    if ((MANAGED_ROOT_FILES as readonly string[]).includes(entry.name)) {
      if (!info.isFile()) {
        throw new CanvasGitError('INVALID_SNAPSHOT', `Expected regular file: ${path}`)
      }
      paths.push(entry.name)
      continue
    }
    if (!(MANAGED_DIRECTORIES as readonly string[]).includes(entry.name) || !info.isDirectory()) {
      throw new CanvasGitError(
        'INVALID_SNAPSHOT',
        `Canvas worktree contains an unsupported top-level path: ${entry.name}`,
      )
    }
    const children = await readdir(path, { withFileTypes: true })
    for (const child of children) {
      const relative = `${entry.name}/${child.name}`
      const childPath = resolve(path, child.name)
      const childInfo = await lstat(childPath)
      if (!childInfo.isFile() || childInfo.isSymbolicLink() || !isManagedTreePath(relative)) {
        throw new CanvasGitError(
          'INVALID_SNAPSHOT',
          `Canvas worktree contains an unsupported entity path: ${relative}`,
        )
      }
      paths.push(relative)
    }
  }
  return paths.sort(compareStrings)
}

async function removePathWithoutFollowing(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await rm(path, { recursive: true, force: true })
    } else {
      await unlink(path)
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

function isManagedTreePath(path: string): boolean {
  return path === '.gitignore' || path === 'meta.json' || TREE_PATH_PATTERN.test(path)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function canonicalCheckpointHash(value: string): string {
  if (!isCheckpointHash(value)) {
    throw new CanvasGitError(
      'CHECKPOINT_NOT_FOUND',
      'Invalid Canvas checkpoint identifier',
    )
  }
  return value.toLowerCase()
}

function isCheckpointHash(value: string): boolean {
  return /^[0-9a-f]{40,64}$/iu.test(value)
}

function managedUuid(candidate: string): string {
  return isUuid(candidate) ? candidate.toLowerCase() : randomUUID()
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  )
}

function sanitizeGitError(value: string): string {
  return scrubControlCharacters(value).replace(/\s+/gu, ' ').trim().slice(0, 500)
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
