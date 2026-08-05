import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  nulSeparatedPaths,
  parseUnmergedIndex,
  type GitMergeExecution,
  type GitMergePreview,
} from './mergeTypes.js'
import {
  canonicalizePotentialPath,
  createProjectScope,
  isPathWithin,
} from './permissions.js'
import { MAX_CANVAS_BRANCH_LENGTH } from './protocol.js'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 4 * 1024 * 1024
const SOURCE_BRANCH_PREFIX = 'ggai/'
const LARGE_FILE_BYTES = 10 * 1024 * 1024
const LARGE_DIFF_BYTES = 50 * 1024 * 1024
const SOURCE_CONFIRMATION_TTL_MS = 10 * 60 * 1_000
const MAX_PENDING_SOURCE_CONFIRMATIONS = 256

export type SourceGitStatusKind = 'unavailable' | 'unbound' | 'ready' | 'degraded'

export interface SourceGitStatus {
  status: SourceGitStatusKind
  repoRoot?: string
  projectRelativeDir?: string
  reason?: string
  branches: SourceBranchBinding[]
}

export interface SourceBranchBinding {
  logicalBranch: string
  gitBranch: string
  worktreeId: string
  worktreePath: string
  projectDir: string
  head: string
  dirty: boolean
}

export interface SourceCheckpointResult {
  changed: boolean
  commit: string
  requiresConfirmation: boolean
  warnings: string[]
  paths: string[]
}

export interface SourceGitMergeInput {
  sourceBranch: string
  targetBranch: string
}

interface SourceRegistry {
  version: 1
  repoRoot: string
  commonDir: string
  projectRelativeDir: string
  branches: Array<Omit<SourceBranchBinding, 'head' | 'dirty'>>
}

interface DetectedRepository {
  repoRoot: string
  projectRelativeDir: string
  commonDir: string
}

interface SourceMergeContext {
  registry: SourceRegistry
  source: Omit<SourceBranchBinding, 'head' | 'dirty'>
  target: Omit<SourceBranchBinding, 'head' | 'dirty'>
  metadata: {
    sourceBranch: string
    targetBranch: string
    sourceCommit: string
    targetCommit: string
    baseCommit: string | null
  }
}

interface GitCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface ManagedSourcePaths {
  projectRoot: string
  projectDir: string
  ggDir: string
  runtimeDir: string
  registryPath: string
  worktreesRoot: string
}

export class SourceGitError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SourceGitError'
    this.code = code
  }
}

/** Manages source worktrees without ever checking out or committing on the user's main worktree. */
export class SourceGitStore {
  readonly projectRoot: string
  readonly projectDir: string
  readonly runtimeDir: string
  readonly registryPath: string
  readonly worktreesRoot: string
  readonly #confirmations = new Map<string, { fingerprint: string; createdAt: number }>()
  #tail = Promise.resolve()

  constructor(options: { projectRoot: string; projectDir: string }) {
    this.projectRoot = path.resolve(options.projectRoot)
    this.projectDir = path.resolve(options.projectDir)
    if (!isPathWithin(this.projectRoot, this.projectDir)) {
      throw new SourceGitError('project_outside_root', 'source project is outside configured root')
    }
    this.runtimeDir = path.join(this.projectDir, '.gg', 'runtime')
    this.registryPath = path.join(this.runtimeDir, 'source-worktrees.json')
    this.worktreesRoot = path.join(this.projectDir, '.gg', 'source-worktrees')
  }

  status(): Promise<SourceGitStatus> {
    return this.#serialize(async () => {
      let detected: DetectedRepository | undefined
      try {
        detected = await this.#detectRepository()
        const registry = await this.#readRegistry(detected)
        if (!registry) {
          return {
            status: 'unbound',
            repoRoot: detected.repoRoot,
            projectRelativeDir: detected.projectRelativeDir,
            branches: [],
          }
        }
        return {
          status: 'ready',
          repoRoot: detected.repoRoot,
          projectRelativeDir: detected.projectRelativeDir,
          branches: await Promise.all(registry.branches.map((branch) => this.#describe(branch))),
        }
      } catch (error) {
        return {
          status: error instanceof SourceGitError && error.code === 'not_git'
            ? 'unavailable'
            : 'degraded',
          ...(detected
            ? {
                repoRoot: detected.repoRoot,
                projectRelativeDir: detected.projectRelativeDir,
              }
            : {}),
          reason: errorMessage(error),
          branches: [],
        }
      }
    })
  }

  bind(logicalBranch = 'main'): Promise<SourceBranchBinding> {
    return this.#serialize(async () => {
      const repository = await this.#detectRepository()
      const existing = await this.#readRegistry(repository)
      if (existing) {
        const match = existing.branches.find((branch) => branch.logicalBranch === logicalBranch)
        if (!match) {
          throw new SourceGitError('already_bound', 'source Git is already bound to another canvas branch')
        }
        return this.#describe(match)
      }

      await this.#ensureLocalExcludes(repository)
      await this.#assertSourceMetadataUntracked(repository)
      await this.#assertClean(repository.repoRoot, 'source repository must be clean before binding')
      validateLogicalBranch(logicalBranch)
      await assertGitBranch(repository.repoRoot, sourceBranch(logicalBranch))

      const worktreeId = randomUUID()
      const worktreePath = path.join(this.worktreesRoot, worktreeId)
      const gitBranch = sourceBranch(logicalBranch)
      await this.#assertManagedPaths()
      await mkdir(this.worktreesRoot, { recursive: true, mode: 0o700 })
      await this.#assertManagedPaths()
      let added = false
      let locked = false
      try {
        await git(repository.repoRoot, ['worktree', 'add', '-b', gitBranch, worktreePath, 'HEAD'])
        added = true
        await git(repository.repoRoot, ['worktree', 'lock', '--reason', 'ggai-managed', worktreePath])
        locked = true
        const projectDir = path.join(worktreePath, repository.projectRelativeDir)
        const record: Omit<SourceBranchBinding, 'head' | 'dirty'> = {
          logicalBranch,
          gitBranch,
          worktreeId,
          worktreePath,
          projectDir,
        }
        const registry: SourceRegistry = {
          version: 1,
          repoRoot: repository.repoRoot,
          commonDir: repository.commonDir,
          projectRelativeDir: repository.projectRelativeDir,
          branches: [record],
        }
        await this.#assertManagedBinding(registry, record)
        const described = await this.#describe(record)
        await this.#writeRegistry(registry)
        return described
      } catch (error) {
        if (added) {
          await this.#rollbackNewWorktree(
            repository.repoRoot,
            worktreePath,
            gitBranch,
            locked,
            error,
          )
        }
        throw error
      }
    })
  }

  createBranch(logicalBranch: string, fromLogicalBranch: string): Promise<SourceBranchBinding> {
    return this.#serialize(() => this.#createBranch(logicalBranch, fromLogicalBranch))
  }

  /** Creates a managed branch at an exact historical commit on the indicated source lineage. */
  createBranchAt(
    logicalBranch: string,
    fromLogicalBranch: string,
    startCommit: string,
  ): Promise<SourceBranchBinding> {
    return this.#serialize(async () => {
      assertFullSourceCommit(startCommit)
      return this.#createBranch(logicalBranch, fromLogicalBranch, startCommit)
    })
  }

  branch(logicalBranch: string): Promise<SourceBranchBinding | null> {
    return this.#serialize(async () => {
      const repository = await this.#detectRepository()
      const registry = await this.#readRegistry(repository)
      const record = registry?.branches.find((candidate) => candidate.logicalBranch === logicalBranch)
      return record ? this.#describe(record) : null
    })
  }

  /** Proves that an immutable checkpoint commit belongs to an existing managed branch lineage. */
  containsCommit(logicalBranch: string, commit: string): Promise<boolean> {
    return this.#serialize(async () => {
      assertFullSourceCommit(commit)
      const registry = await this.#requireRegistry()
      const binding = registry.branches.find(
        (candidate) => candidate.logicalBranch === logicalBranch,
      )
      if (!binding) {
        throw new SourceGitError('branch_not_found', `source branch not found: ${logicalBranch}`)
      }
      await this.#assertManagedBinding(registry, binding)
      const exists = await gitResult(
        registry.repoRoot,
        ['cat-file', '-e', `${commit}^{commit}`],
        [0, 1, 128],
      )
      if (exists.exitCode !== 0) return false
      const ancestor = await gitResult(
        registry.repoRoot,
        ['merge-base', '--is-ancestor', commit, binding.gitBranch],
        [0, 1],
      )
      return ancestor.exitCode === 0
    })
  }

  checkpoint(
    logicalBranch: string,
    options: { runId: string; nodeTitle: string; allowSensitive?: boolean },
  ): Promise<SourceCheckpointResult> {
    return this.#serialize(async () => {
      const registry = await this.#requireRegistry()
      const binding = registry.branches.find((candidate) => candidate.logicalBranch === logicalBranch)
      if (!binding) throw new SourceGitError('branch_not_found', `source branch not found: ${logicalBranch}`)
      await this.#assertNoChangesOutsideProject(registry, binding)
      const paths = await changedPaths(binding.projectDir)
      const currentHead = await head(binding.worktreePath)
      const confirmationKey = `${logicalBranch}\0${options.runId}`
      if (paths.length === 0) {
        this.#confirmations.delete(confirmationKey)
        return { changed: false, commit: currentHead, requiresConfirmation: false, warnings: [], paths }
      }

      const warnings = await changeWarnings(binding.projectDir, paths)
      const requiresConfirmation = warnings.length > 0
      if (requiresConfirmation) {
        const fingerprint = await sourceChangeFingerprint(binding.projectDir, currentHead, paths)
        if (!options.allowSensitive) {
          this.#rememberConfirmation(confirmationKey, fingerprint)
          return { changed: true, commit: currentHead, requiresConfirmation, warnings, paths }
        }
        const pending = this.#confirmations.get(confirmationKey)
        this.#confirmations.delete(confirmationKey)
        if (!pending || Date.now() - pending.createdAt > SOURCE_CONFIRMATION_TTL_MS) {
          throw new SourceGitError(
            'confirmation_required',
            'sensitive source changes require a fresh explicit preview',
          )
        }
        if (pending.fingerprint !== fingerprint) {
          throw new SourceGitError(
            'source_changed_since_confirmation',
            'source changes no longer match the confirmed preview',
          )
        }
      } else {
        this.#confirmations.delete(confirmationKey)
      }

      await git(binding.projectDir, ['add', '-A', '--', '.'])
      await this.#assertNoChangesOutsideProject(registry, binding)
      const title = compactCommitPart(options.nodeTitle, 72)
      const runId = compactCommitPart(options.runId, 24)
      await git(binding.projectDir, [
        '-c', 'user.name=GGAI',
        '-c', 'user.email=ggai@local',
        'commit', '--no-gpg-sign', '--no-verify', '--only',
        '-m', `ggai(run): ${title} [${runId}]`, '--', '.',
      ])
      const commit = await head(binding.worktreePath)
      const committedPaths = nulSeparatedPaths(await git(binding.worktreePath, [
        'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit,
      ]))
      const outsideCommit = committedPaths.filter(
        (candidate) => !isRepositoryPathWithin(registry.projectRelativeDir, candidate),
      )
      if (outsideCommit.length > 0) {
        await git(binding.worktreePath, ['update-ref', 'HEAD', currentHead, commit])
        throw new SourceGitError(
          'commit_scope_violation',
          `source checkpoint attempted to commit outside project directory: ${outsideCommit.join(', ')}`,
        )
      }
      return {
        changed: true,
        commit,
        requiresConfirmation,
        warnings,
        paths,
      }
    })
  }

  /** Simulates a source merge in a disposable managed worktree. */
  previewMerge(input: SourceGitMergeInput): Promise<GitMergePreview> {
    return this.#serialize(async () => {
      const context = await this.#mergeContext(input)
      if (context.metadata.sourceCommit === context.metadata.targetCommit) {
        return sourceMergePreview(context.metadata, [], [])
      }
      return this.#withPreviewWorktree(context, (worktreePath) =>
        this.#attemptMerge(worktreePath, context))
    })
  }

  /**
   * Merges source into target only inside the target's managed worktree.
   * Any conflict is collected and aborted; the worktree remains clean.
   */
  merge(input: SourceGitMergeInput): Promise<GitMergeExecution> {
    return this.#serialize(async () => {
      const context = await this.#mergeContext(input)
      if (context.metadata.sourceCommit === context.metadata.targetCommit) {
        return {
          ...sourceMergePreview(context.metadata, [], []),
          merged: false,
          commit: context.metadata.targetCommit,
        }
      }
      try {
        const preview = await this.#attemptMerge(context.target.worktreePath, context)
        if (preview.state === 'conflicts') {
          await this.#abortMergeIfNeeded(context.target.worktreePath)
          await this.#assertClean(
            context.target.worktreePath,
            'source target worktree was not clean after aborting merge',
          )
          return {
            ...preview,
            merged: false,
            commit: context.metadata.targetCommit,
          }
        }
        if (preview.state === 'up-to-date') {
          return {
            ...preview,
            merged: false,
            commit: context.metadata.targetCommit,
          }
        }
        await git(context.target.worktreePath, [
          '-c', 'user.name=GGAI',
          '-c', 'user.email=ggai@local',
          'commit', '--no-gpg-sign', '--no-verify',
          '-m', sourceMergeSubject(input.sourceBranch, input.targetBranch),
        ])
        return {
          ...preview,
          merged: true,
          commit: await head(context.target.worktreePath),
        }
      } catch (error) {
        await this.#abortMergeIfNeeded(context.target.worktreePath).catch(() => undefined)
        await this.#assertClean(
          context.target.worktreePath,
          'source target worktree was left dirty after failed merge',
        )
        throw error
      }
    })
  }

  removeBranch(logicalBranch: string): Promise<void> {
    return this.#serialize(async () => {
      const registry = await this.#requireRegistry()
      if (logicalBranch === 'main') throw new SourceGitError('main_protected', 'main source branch cannot be removed')
      if (registry.branches.length === 1) {
        throw new SourceGitError('last_branch_protected', 'last source branch cannot be removed')
      }
      const binding = registry.branches.find((candidate) => candidate.logicalBranch === logicalBranch)
      if (!binding) throw new SourceGitError('branch_not_found', `source branch not found: ${logicalBranch}`)
      await this.#assertClean(binding.worktreePath, 'dirty source worktree cannot be removed')
      await git(registry.repoRoot, ['worktree', 'unlock', binding.worktreePath])
      await git(registry.repoRoot, ['worktree', 'remove', binding.worktreePath])
      const mainWorktree = registry.branches.find((candidate) => candidate.logicalBranch === 'main')
      await git(mainWorktree?.worktreePath ?? registry.repoRoot, ['branch', '-d', binding.gitBranch])
      await this.#writeRegistry({
        ...registry,
        branches: registry.branches.filter((candidate) => candidate.logicalBranch !== logicalBranch),
      })
    })
  }

  async #createBranch(
    logicalBranch: string,
    fromLogicalBranch: string,
    startCommit?: string,
  ): Promise<SourceBranchBinding> {
    validateLogicalBranch(logicalBranch)
    const registry = await this.#requireRegistry()
    await assertGitBranch(registry.repoRoot, sourceBranch(logicalBranch))
    if (registry.branches.some((branch) => branch.logicalBranch === logicalBranch)) {
      throw new SourceGitError('branch_exists', `source branch already exists: ${logicalBranch}`)
    }
    const source = registry.branches.find((branch) => branch.logicalBranch === fromLogicalBranch)
    if (!source) throw new SourceGitError('branch_not_found', `source branch not found: ${fromLogicalBranch}`)
    await this.#assertManagedBinding(registry, source)
    await this.#assertClean(source.worktreePath, 'source worktree must be clean before branching')

    let startPoint = source.gitBranch
    if (startCommit !== undefined) {
      const exists = await gitResult(
        registry.repoRoot,
        ['cat-file', '-e', `${startCommit}^{commit}`],
        [0, 1, 128],
      )
      if (exists.exitCode !== 0) {
        throw new SourceGitError(
          'commit_not_found',
          `historical source commit does not exist: ${startCommit}`,
        )
      }
      const ancestor = await gitResult(
        registry.repoRoot,
        ['merge-base', '--is-ancestor', startCommit, source.gitBranch],
        [0, 1],
      )
      if (ancestor.exitCode !== 0) {
        throw new SourceGitError(
          'commit_not_ancestor',
          `historical source commit is not an ancestor of ${fromLogicalBranch}`,
        )
      }
      startPoint = startCommit
    }

    const worktreeId = randomUUID()
    const worktreePath = path.join(this.worktreesRoot, worktreeId)
    const gitBranch = sourceBranch(logicalBranch)
    await this.#assertManagedPaths()
    let added = false
    let locked = false
    try {
      await git(registry.repoRoot, [
        'worktree', 'add', '-b', gitBranch, worktreePath, startPoint,
      ])
      added = true
      await git(registry.repoRoot, ['worktree', 'lock', '--reason', 'ggai-managed', worktreePath])
      locked = true
      const record: Omit<SourceBranchBinding, 'head' | 'dirty'> = {
        logicalBranch,
        gitBranch,
        worktreeId,
        worktreePath,
        projectDir: path.join(worktreePath, registry.projectRelativeDir),
      }
      const next = { ...registry, branches: [...registry.branches, record] }
      await this.#assertManagedBinding(next, record)
      const described = await this.#describe(record)
      await this.#writeRegistry(next)
      return described
    } catch (error) {
      if (added) {
        await this.#rollbackNewWorktree(
          registry.repoRoot,
          worktreePath,
          gitBranch,
          locked,
          error,
        )
      }
      throw error
    }
  }

  async close(): Promise<void> {
    await this.#tail
    this.#confirmations.clear()
  }

  #rememberConfirmation(key: string, fingerprint: string): void {
    const now = Date.now()
    for (const [candidate, pending] of this.#confirmations) {
      if (now - pending.createdAt > SOURCE_CONFIRMATION_TTL_MS) {
        this.#confirmations.delete(candidate)
      }
    }
    while (this.#confirmations.size >= MAX_PENDING_SOURCE_CONFIRMATIONS) {
      const oldest = this.#confirmations.keys().next().value as string | undefined
      if (!oldest) break
      this.#confirmations.delete(oldest)
    }
    this.#confirmations.set(key, { fingerprint, createdAt: now })
  }

  async #mergeContext(input: SourceGitMergeInput): Promise<SourceMergeContext> {
    validateLogicalBranch(input.sourceBranch)
    validateLogicalBranch(input.targetBranch)
    if (input.sourceBranch === input.targetBranch) {
      throw new SourceGitError(
        'invalid_merge',
        'source merge source and target branches must be different',
      )
    }
    const registry = await this.#requireRegistry()
    const source = registry.branches.find(
      (candidate) => candidate.logicalBranch === input.sourceBranch,
    )
    const target = registry.branches.find(
      (candidate) => candidate.logicalBranch === input.targetBranch,
    )
    if (!source) {
      throw new SourceGitError(
        'branch_not_found',
        `source branch not found: ${input.sourceBranch}`,
      )
    }
    if (!target) {
      throw new SourceGitError(
        'branch_not_found',
        `source branch not found: ${input.targetBranch}`,
      )
    }
    await this.#assertManagedBinding(registry, source)
    await this.#assertManagedBinding(registry, target)
    await this.#assertClean(source.worktreePath, 'source merge branch must be clean')
    await this.#assertClean(target.worktreePath, 'source target branch must be clean')

    const [sourceCommit, targetCommit, base] = await Promise.all([
      head(source.worktreePath),
      head(target.worktreePath),
      gitResult(
        registry.repoRoot,
        ['merge-base', source.gitBranch, target.gitBranch],
        [0, 1],
      ),
    ])
    return {
      registry,
      source,
      target,
      metadata: {
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        sourceCommit,
        targetCommit,
        baseCommit: base.exitCode === 0 ? base.stdout.trim() || null : null,
      },
    }
  }

  async #attemptMerge(
    worktreePath: string,
    context: SourceMergeContext,
  ): Promise<GitMergePreview> {
    const result = await gitResult(
      worktreePath,
      ['merge', '--no-commit', '--no-ff', '--no-edit', context.source.gitBranch],
      [0, 1],
    )
    const [unmerged, changed] = await Promise.all([
      git(worktreePath, ['ls-files', '-u', '-z']),
      git(worktreePath, ['diff', '--name-only', '-z', 'HEAD']),
    ])
    const conflicts = parseUnmergedIndex(unmerged)
    const paths = nulSeparatedPaths(changed)
    if (result.exitCode !== 0 && conflicts.length === 0) {
      throw new SourceGitError(
        'merge_failed',
        `source merge failed: ${sanitizeGitError(result.stderr) || 'Git rejected the merge'}`,
      )
    }
    return sourceMergePreview(context.metadata, paths, conflicts)
  }

  async #withPreviewWorktree<T>(
    context: SourceMergeContext,
    operation: (worktreePath: string) => Promise<T>,
  ): Promise<T> {
    await this.#assertManagedPaths()
    await mkdir(this.worktreesRoot, { recursive: true, mode: 0o700 })
    await this.#assertManagedPaths()
    const worktreeId = randomUUID()
    const worktreePath = path.resolve(this.worktreesRoot, worktreeId)
    if (!isPathWithin(this.worktreesRoot, worktreePath) || worktreePath === this.worktreesRoot) {
      throw new SourceGitError('unsafe_worktree', 'generated source preview path is unsafe')
    }
    try {
      await lstat(worktreePath)
      throw new SourceGitError('unsafe_worktree', 'source preview path already exists')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }

    let added = false
    let locked = false
    try {
      await git(context.registry.repoRoot, [
        'worktree', 'add', '--detach', worktreePath, context.target.gitBranch,
      ])
      added = true
      await git(context.registry.repoRoot, [
        'worktree', 'lock', '--reason', 'ggai-managed', worktreePath,
      ])
      locked = true
      return await operation(worktreePath)
    } finally {
      if (added) {
        await this.#abortMergeIfNeeded(worktreePath)
        await this.#assertClean(worktreePath, 'source merge preview was not cleaned up')
        if (locked) {
          await git(context.registry.repoRoot, ['worktree', 'unlock', worktreePath])
        }
        await git(context.registry.repoRoot, ['worktree', 'remove', worktreePath])
      }
    }
  }

  async #abortMergeIfNeeded(worktreePath: string): Promise<void> {
    const merging = await gitResult(
      worktreePath,
      ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
      [0, 1],
    )
    if (merging.exitCode === 0) await git(worktreePath, ['merge', '--abort'])
  }

  async #assertManagedBinding(
    registry: SourceRegistry,
    binding: Omit<SourceBranchBinding, 'head' | 'dirty'>,
  ): Promise<void> {
    if (!isUuid(binding.worktreeId)) {
      throw new SourceGitError('unmanaged_worktree', 'source worktree ID is not daemon-managed')
    }
    if (binding.gitBranch !== sourceBranch(binding.logicalBranch)) {
      throw new SourceGitError('unmanaged_worktree', 'source worktree branch mapping is invalid')
    }
    const expectedWorktree = path.resolve(this.worktreesRoot, binding.worktreeId)
    if (
      path.resolve(binding.worktreePath) !== expectedWorktree
      || !isPathWithin(this.worktreesRoot, expectedWorktree)
    ) {
      throw new SourceGitError('unmanaged_worktree', 'source worktree escapes managed paths')
    }
    const expectedProject = path.resolve(expectedWorktree, registry.projectRelativeDir || '.')
    if (
      path.resolve(binding.projectDir) !== expectedProject
      || !isPathWithin(expectedWorktree, expectedProject)
    ) {
      throw new SourceGitError('unmanaged_worktree', 'source project path escapes its worktree')
    }
    const info = await lstat(expectedWorktree)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SourceGitError('unmanaged_worktree', 'source worktree path is not a safe directory')
    }
    const managedPaths = await this.#assertManagedPaths()
    const [canonicalWorktree, canonicalProject] = await Promise.all([
      realpath(expectedWorktree),
      realpath(expectedProject),
    ])
    if (!isPathWithin(managedPaths.worktreesRoot, canonicalWorktree)) {
      throw new SourceGitError('unmanaged_worktree', 'source worktree resolves outside managed paths')
    }
    const expectedCanonicalProject = path.resolve(
      canonicalWorktree,
      registry.projectRelativeDir || '.',
    )
    if (
      canonicalProject !== expectedCanonicalProject
      || !isPathWithin(canonicalWorktree, canonicalProject)
    ) {
      throw new SourceGitError('unmanaged_worktree', 'source project resolves outside its worktree')
    }
    const projectInfo = await lstat(expectedProject)
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) {
      throw new SourceGitError('unmanaged_worktree', 'source project path is not a safe directory')
    }
    const worktrees = parseSourceWorktrees(
      await git(registry.repoRoot, ['worktree', 'list', '--porcelain', '-z']),
    )
    let reported: ReportedSourceWorktree | undefined
    for (const candidate of worktrees) {
      try {
        if (await realpath(candidate.path) === canonicalWorktree) {
          reported = candidate
          break
        }
      } catch {
        // Prunable or concurrently removed worktrees are never trusted.
      }
    }
    if (
      !reported
      || reported.branch !== binding.gitBranch
      || !reported.locked
      || reported.lockReason !== 'ggai-managed'
    ) {
      throw new SourceGitError('unmanaged_worktree', 'source worktree is not registered and locked')
    }
    const commonRaw = (await git(expectedWorktree, ['rev-parse', '--git-common-dir'])).trim()
    const commonDir = await realpath(path.resolve(expectedWorktree, commonRaw))
    if (commonDir !== registry.commonDir || !isPathWithin(managedPaths.projectRoot, commonDir)) {
      throw new SourceGitError('unmanaged_worktree', 'source worktree belongs to another repository')
    }
  }

  async #detectRepository(): Promise<DetectedRepository> {
    const managedPaths = await this.#assertManagedPaths()
    let repoRoot: string
    try {
      repoRoot = await realpath(
        path.resolve((await git(this.projectDir, ['rev-parse', '--show-toplevel'])).trim()),
      )
    } catch (error) {
      throw new SourceGitError('not_git', 'project is not inside a Git repository', { cause: error })
    }
    if (
      !isPathWithin(managedPaths.projectRoot, repoRoot)
      || !isPathWithin(repoRoot, managedPaths.projectDir)
    ) {
      throw new SourceGitError('repo_outside_root', 'source Git root is outside the daemon project boundary')
    }
    const commonRaw = (await git(repoRoot, ['rev-parse', '--git-common-dir'])).trim()
    const commonPath = path.resolve(repoRoot, commonRaw)
    const commonInfo = await lstat(commonPath)
    if (!commonInfo.isDirectory() || commonInfo.isSymbolicLink()) {
      throw new SourceGitError('unsafe_common_dir', 'Git common directory is not a safe directory')
    }
    const commonDir = await realpath(commonPath)
    if (!isPathWithin(managedPaths.projectRoot, commonDir)) {
      throw new SourceGitError(
        'common_dir_outside_root',
        'Git common directory is outside the daemon project boundary',
      )
    }
    const projectRelativeDir = path.relative(repoRoot, managedPaths.projectDir)
    if (!isSafeProjectRelativeDir(projectRelativeDir)) {
      throw new SourceGitError('repo_outside_root', 'source project has an unsafe repository path')
    }
    return {
      repoRoot,
      projectRelativeDir,
      commonDir,
    }
  }

  async #assertManagedPaths(): Promise<ManagedSourcePaths> {
    try {
      const projectRoot = await realpath(this.projectRoot)
      const projectDir = await realpath(this.projectDir)
      if (!isPathWithin(projectRoot, projectDir)) {
        throw new SourceGitError(
          'project_outside_root',
          'source project resolves outside configured root',
        )
      }
      const ggDir = path.join(this.projectDir, '.gg')
      const paths = {
        ggDir,
        runtimeDir: this.runtimeDir,
        registryPath: this.registryPath,
        worktreesRoot: this.worktreesRoot,
      }
      await Promise.all([
        assertManagedPathType(ggDir, 'directory'),
        assertManagedPathType(paths.runtimeDir, 'directory'),
        assertManagedPathType(paths.registryPath, 'file'),
        assertManagedPathType(paths.worktreesRoot, 'directory'),
      ])
      const [canonicalGg, canonicalRuntime, canonicalRegistry, canonicalWorktrees] =
        await Promise.all([
          canonicalizePotentialPath(ggDir),
          canonicalizePotentialPath(paths.runtimeDir),
          canonicalizePotentialPath(paths.registryPath),
          canonicalizePotentialPath(paths.worktreesRoot),
        ])
      if (
        !isPathWithin(projectDir, canonicalGg)
        || !isPathWithin(canonicalGg, canonicalRuntime)
        || !isPathWithin(canonicalRuntime, canonicalRegistry)
        || !isPathWithin(canonicalGg, canonicalWorktrees)
        || canonicalRegistry !== path.join(canonicalRuntime, 'source-worktrees.json')
      ) {
        throw new SourceGitError(
          'unsafe_managed_path',
          'source Git metadata resolves outside managed project paths',
        )
      }
      return {
        projectRoot,
        projectDir,
        ggDir: canonicalGg,
        runtimeDir: canonicalRuntime,
        registryPath: canonicalRegistry,
        worktreesRoot: canonicalWorktrees,
      }
    } catch (error) {
      if (error instanceof SourceGitError) throw error
      throw new SourceGitError(
        'unsafe_managed_path',
        `source Git metadata path is unsafe: ${errorMessage(error)}`,
        { cause: error },
      )
    }
  }

  async #ensureLocalExcludes(repository: { commonDir: string }): Promise<void> {
    const infoDir = path.join(repository.commonDir, 'info')
    const excludePath = path.join(infoDir, 'exclude')
    await assertSafeCommonMetadataPath(repository.commonDir, infoDir, 'directory')
    await mkdir(infoDir, { recursive: true, mode: 0o700 })
    await assertSafeCommonMetadataPath(repository.commonDir, infoDir, 'directory')
    await assertSafeCommonMetadataPath(repository.commonDir, excludePath, 'file')
    let current = ''
    try {
      current = await readFile(excludePath, 'utf8')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
    const additions = ['.gg/', 'artifacts/'].filter((entry) =>
      !current.split(/\r?\n/u).some((line) => line.trim() === entry))
    if (additions.length > 0) {
      await atomicWriteText(
        excludePath,
        `${current}${current && !current.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`,
      )
    }
  }

  async #assertSourceMetadataUntracked(
    repository: { repoRoot: string; projectRelativeDir: string },
  ): Promise<void> {
    const prefix = repository.projectRelativeDir ? `${repository.projectRelativeDir}/` : ''
    const tracked = await git(repository.repoRoot, [
      'ls-files', '-z', '--', `${prefix}.gg`, `${prefix}artifacts`,
    ])
    if (tracked) {
      throw new SourceGitError(
        'managed_paths_tracked',
        'source repository already tracks .gg or artifacts; untrack them before binding',
      )
    }
  }

  async #assertClean(cwd: string, message: string): Promise<void> {
    const status = await git(cwd, ['status', '--porcelain=v1', '-z'])
    if (status) throw new SourceGitError('worktree_dirty', message)
  }

  async #describe(
    record: Omit<SourceBranchBinding, 'head' | 'dirty'>,
  ): Promise<SourceBranchBinding> {
    const status = await git(record.worktreePath, ['status', '--porcelain=v1', '-z'])
    return { ...record, head: await head(record.worktreePath), dirty: Boolean(status) }
  }

  async #readRegistry(repository: DetectedRepository): Promise<SourceRegistry | null> {
    await this.#assertManagedPaths()
    try {
      const source = await readFile(this.registryPath, 'utf8')
      if (Buffer.byteLength(source, 'utf8') > 1024 * 1024) {
        throw new SourceGitError('registry_corrupt', 'source worktree registry is too large')
      }
      let value: unknown
      try {
        value = JSON.parse(source) as unknown
      } catch (error) {
        throw new SourceGitError('registry_corrupt', 'source worktree registry is invalid JSON', {
          cause: error,
        })
      }
      const registry = parseSourceRegistry(value, this.worktreesRoot)
      await this.#assertRegistryMatchesRepository(registry, repository)
      return registry
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  async #requireRegistry(): Promise<SourceRegistry> {
    const repository = await this.#detectRepository()
    const registry = await this.#readRegistry(repository)
    if (!registry) throw new SourceGitError('not_bound', 'source Git is not bound')
    return registry
  }

  async #writeRegistry(registry: SourceRegistry): Promise<void> {
    const repository = await this.#detectRepository()
    const validated = parseSourceRegistry(registry, this.worktreesRoot)
    await this.#assertRegistryMatchesRepository(validated, repository)
    await this.#assertManagedPaths()
    await atomicWriteJson(this.registryPath, registry)
  }

  async #assertRegistryMatchesRepository(
    registry: SourceRegistry,
    repository: DetectedRepository,
  ): Promise<void> {
    if (
      registry.repoRoot !== repository.repoRoot
      || registry.commonDir !== repository.commonDir
      || registry.projectRelativeDir !== repository.projectRelativeDir
    ) {
      throw new SourceGitError(
        'registry_mismatch',
        'source worktree registry does not match the detected Git repository',
      )
    }
    for (const binding of registry.branches) {
      await this.#assertManagedBinding(registry, binding)
    }
  }

  async #assertNoChangesOutsideProject(
    registry: SourceRegistry,
    binding: Omit<SourceBranchBinding, 'head' | 'dirty'>,
  ): Promise<void> {
    if (registry.projectRelativeDir === '') return
    const [status, staged] = await Promise.all([
      git(binding.worktreePath, [
        'status', '--porcelain=v1', '-z', '--untracked-files=all',
      ]),
      git(binding.worktreePath, ['diff', '--cached', '--name-only', '-z']),
    ])
    const changed = new Set([
      ...parsePorcelainPaths(status),
      ...nulSeparatedPaths(staged),
    ])
    const outside = [...changed]
      .filter((candidate) => !isRepositoryPathWithin(registry.projectRelativeDir, candidate))
      .sort()
    if (outside.length > 0) {
      throw new SourceGitError(
        'changes_outside_project',
        `source checkpoint refused changes outside project directory: ${outside.join(', ')}`,
      )
    }
  }

  async #rollbackNewWorktree(
    repoRoot: string,
    worktreePath: string,
    gitBranch: string,
    locked: boolean,
    originalError: unknown,
  ): Promise<void> {
    try {
      const createdHead = await head(worktreePath)
      await this.#assertClean(worktreePath, 'new source worktree became dirty during rollback')
      if (locked) await git(repoRoot, ['worktree', 'unlock', worktreePath])
      await git(repoRoot, ['worktree', 'remove', worktreePath])
      await git(repoRoot, ['update-ref', '-d', `refs/heads/${gitBranch}`, createdHead])
    } catch (rollbackError) {
      throw new SourceGitError(
        'worktree_rollback_failed',
        `source worktree setup failed and could not be rolled back: ${errorMessage(rollbackError)}`,
        { cause: originalError },
      )
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export class SourceGitManager {
  readonly #projectRoot: string
  readonly #stores = new Map<string, SourceGitStore>()
  #closing = false

  constructor(projectRoot: string) {
    this.#projectRoot = path.resolve(projectRoot)
  }

  async store(projectDirRequest = '.'): Promise<SourceGitStore> {
    if (this.#closing) throw new SourceGitError('manager_closing', 'source Git manager is closing')
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: projectDirRequest,
    })
    let store = this.#stores.get(scope.projectDir)
    if (!store) {
      store = new SourceGitStore({ projectRoot: scope.projectRoot, projectDir: scope.projectDir })
      this.#stores.set(scope.projectDir, store)
    }
    return store
  }

  async close(): Promise<void> {
    this.#closing = true
    await Promise.allSettled([...this.#stores.values()].map((store) => store.close()))
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitResult(cwd, args)).stdout
}

async function gitResult(
  cwd: string,
  args: string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (error) {
    const exitCode = numericErrorCode(error)
    if (exitCode !== null && allowedExitCodes.includes(exitCode)) {
      return {
        stdout: childProcessOutput(error, 'stdout'),
        stderr: childProcessOutput(error, 'stderr'),
        exitCode,
      }
    }
    throw new SourceGitError('git_failed', `git ${args[0] ?? ''} failed: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

async function head(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}

async function assertGitBranch(cwd: string, branch: string): Promise<void> {
  try {
    await git(cwd, ['check-ref-format', '--branch', branch])
  } catch (error) {
    throw new SourceGitError('invalid_branch', `invalid Git branch name: ${branch}`, {
      cause: error,
    })
  }
}

function sourceBranch(logicalBranch: string): string {
  const branch = `${SOURCE_BRANCH_PREFIX}${logicalBranch}`
  validateGitBranch(branch)
  return branch
}

function validateLogicalBranch(branch: string): void {
  if (
    !branch
    || branch.length > MAX_CANVAS_BRANCH_LENGTH
    || branch.startsWith('-')
    || branch.includes('\0')
  ) {
    throw new SourceGitError('invalid_branch', 'canvas branch name is invalid')
  }
  validateGitBranch(sourceBranchName(branch))
}

function sourceBranchName(logicalBranch: string): string {
  return `${SOURCE_BRANCH_PREFIX}${logicalBranch}`
}

function validateGitBranch(branch: string): void {
  if (
    branch.includes('..')
    || branch.includes('//')
    || /[\s~^:?*[\\]/u.test(branch)
    || containsControlCharacter(branch)
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.endsWith('.lock')
  ) {
    throw new SourceGitError('invalid_branch', `invalid Git branch name: ${branch}`)
  }
}

function assertFullSourceCommit(commit: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new SourceGitError(
      'invalid_commit',
      'historical source commit must be a full lowercase Git object id',
    )
  }
}

function parseSourceRegistry(value: unknown, worktreesRoot: string): SourceRegistry {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'version',
    'repoRoot',
    'commonDir',
    'projectRelativeDir',
    'branches',
  ])) {
    throw new SourceGitError('registry_corrupt', 'source worktree registry has invalid fields')
  }
  if (value.version !== 1 || !Array.isArray(value.branches)) {
    throw new SourceGitError('registry_corrupt', 'source worktree registry has an invalid version')
  }
  if (value.branches.length < 1 || value.branches.length > 1_000) {
    throw new SourceGitError('registry_corrupt', 'source worktree registry branch count is invalid')
  }
  const repoRoot = registryAbsolutePath(value.repoRoot, 'repoRoot')
  const commonDir = registryAbsolutePath(value.commonDir, 'commonDir')
  const projectRelativeDir = registryString(value.projectRelativeDir, 'projectRelativeDir', 4_096)
  if (!isSafeProjectRelativeDir(projectRelativeDir)) {
    throw new SourceGitError('registry_corrupt', 'source registry project path is invalid')
  }

  const logicalBranches = new Set<string>()
  const gitBranches = new Set<string>()
  const worktreeIds = new Set<string>()
  const worktreePaths = new Set<string>()
  const branches = value.branches.map((candidate, index) => {
    if (!isPlainObject(candidate) || !hasExactKeys(candidate, [
      'logicalBranch',
      'gitBranch',
      'worktreeId',
      'worktreePath',
      'projectDir',
    ])) {
      throw new SourceGitError(
        'registry_corrupt',
        `source registry branch ${index} has invalid fields`,
      )
    }
    const logicalBranch = registryString(candidate.logicalBranch, 'logicalBranch', 120)
    try {
      validateLogicalBranch(logicalBranch)
    } catch (error) {
      throw new SourceGitError('registry_corrupt', 'source registry branch name is invalid', {
        cause: error,
      })
    }
    const gitBranch = registryString(candidate.gitBranch, 'gitBranch', 256)
    const worktreeId = registryString(candidate.worktreeId, 'worktreeId', 64)
    const worktreePath = registryAbsolutePath(candidate.worktreePath, 'worktreePath')
    const projectDir = registryAbsolutePath(candidate.projectDir, 'projectDir')
    const expectedWorktree = path.join(worktreesRoot, worktreeId)
    const expectedProject = path.join(expectedWorktree, projectRelativeDir)
    if (
      !isUuid(worktreeId)
      || gitBranch !== sourceBranch(logicalBranch)
      || worktreePath !== expectedWorktree
      || projectDir !== expectedProject
      || !isPathWithin(worktreesRoot, worktreePath)
      || !isPathWithin(worktreePath, projectDir)
    ) {
      throw new SourceGitError(
        'registry_corrupt',
        `source registry branch ${logicalBranch} is not daemon-managed`,
      )
    }
    if (
      logicalBranches.has(logicalBranch)
      || gitBranches.has(gitBranch)
      || worktreeIds.has(worktreeId)
      || worktreePaths.has(worktreePath)
    ) {
      throw new SourceGitError('registry_corrupt', 'source registry contains duplicate branches')
    }
    logicalBranches.add(logicalBranch)
    gitBranches.add(gitBranch)
    worktreeIds.add(worktreeId)
    worktreePaths.add(worktreePath)
    return { logicalBranch, gitBranch, worktreeId, worktreePath, projectDir }
  })
  return { version: 1, repoRoot, commonDir, projectRelativeDir, branches }
}

function registryString(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0 && name !== 'projectRelativeDir'
    || value.length > maxLength
    || value.includes('\0')
  ) {
    throw new SourceGitError('registry_corrupt', `source registry ${name} is invalid`)
  }
  return value
}

function registryAbsolutePath(value: unknown, name: string): string {
  const result = registryString(value, name, 4_096)
  if (!path.isAbsolute(result) || path.resolve(result) !== result) {
    throw new SourceGitError('registry_corrupt', `source registry ${name} is not canonical`)
  }
  return result
}

function isSafeProjectRelativeDir(value: string): boolean {
  if (value === '') return true
  return !path.isAbsolute(value)
    && path.normalize(value) === value
    && value !== '.'
    && !value.split(path.sep).includes('..')
    && !value.includes('\0')
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

async function assertManagedPathType(
  target: string,
  expected: 'directory' | 'file',
): Promise<void> {
  try {
    const info = await lstat(target)
    if (
      info.isSymbolicLink()
      || expected === 'directory' && !info.isDirectory()
      || expected === 'file' && !info.isFile()
    ) {
      throw new SourceGitError(
        'unsafe_managed_path',
        `source Git managed ${expected} is unsafe: ${target}`,
      )
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
}

async function assertSafeCommonMetadataPath(
  commonDir: string,
  target: string,
  expected: 'directory' | 'file',
): Promise<void> {
  try {
    const absolute = path.resolve(target)
    if (!isPathWithin(commonDir, absolute)) {
      throw new SourceGitError(
        'unsafe_common_metadata',
        'Git common metadata path escapes the common directory',
      )
    }
    try {
      const info = await lstat(absolute)
      if (
        info.isSymbolicLink()
        || expected === 'directory' && !info.isDirectory()
        || expected === 'file' && !info.isFile()
      ) {
        throw new SourceGitError(
          'unsafe_common_metadata',
          `Git common metadata ${expected} is unsafe: ${absolute}`,
        )
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
    const canonical = await canonicalizePotentialPath(absolute)
    if (canonical !== absolute || !isPathWithin(commonDir, canonical)) {
      throw new SourceGitError(
        'unsafe_common_metadata',
        `Git common metadata resolves outside its expected path: ${absolute}`,
      )
    }
  } catch (error) {
    if (error instanceof SourceGitError) throw error
    throw new SourceGitError(
      'unsafe_common_metadata',
      `Git common metadata path is unsafe: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

function parsePorcelainPaths(raw: string): string[] {
  const fields = raw.split('\0')
  const result: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field) continue
    if (field.length < 4 || field[2] !== ' ') {
      throw new SourceGitError('git_failed', 'Git returned malformed status data')
    }
    const code = field.slice(0, 2)
    result.push(field.slice(3))
    if (code.includes('R') || code.includes('C')) {
      const paired = fields[index + 1]
      if (!paired) throw new SourceGitError('git_failed', 'Git returned malformed rename data')
      result.push(paired)
      index += 1
    }
  }
  return [...new Set(result)]
}

function isRepositoryPathWithin(projectRelativeDir: string, candidate: string): boolean {
  if (!candidate || candidate.startsWith('/') || candidate.includes('\0')) return false
  if (projectRelativeDir === '') {
    return candidate !== '..' && !candidate.startsWith('../')
  }
  const prefix = projectRelativeDir.split(path.sep).join('/')
  return candidate === prefix || candidate.startsWith(`${prefix}/`)
}

function sourceMergePreview(
  metadata: SourceMergeContext['metadata'],
  paths: string[],
  conflicts: GitMergePreview['conflicts'],
): GitMergePreview {
  const allPaths = [...new Set([...paths, ...conflicts.map((conflict) => conflict.path)])].sort()
  const state = conflicts.length > 0
    ? 'conflicts'
    : metadata.baseCommit === metadata.sourceCommit
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

function sourceMergeSubject(source: string, target: string): string {
  return `ggai(merge): ${source} -> ${target}`.slice(0, 200)
}

interface ReportedSourceWorktree {
  path: string
  branch: string | null
  locked: boolean
  lockReason?: string
}

function parseSourceWorktrees(raw: string): ReportedSourceWorktree[] {
  return raw
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      let worktreePath: string | undefined
      let branch: string | null = null
      let locked = false
      let lockReason: string | undefined
      for (const field of record.split('\0').filter(Boolean)) {
        const separator = field.indexOf(' ')
        const key = separator === -1 ? field : field.slice(0, separator)
        const value = separator === -1 ? '' : field.slice(separator + 1)
        if (key === 'worktree') worktreePath = value
        else if (key === 'branch') branch = value.replace(/^refs\/heads\//u, '')
        else if (key === 'locked') {
          locked = true
          if (value) lockReason = value
        }
      }
      if (!worktreePath) {
        throw new SourceGitError('git_failed', 'Git returned malformed worktree data')
      }
      return {
        path: worktreePath,
        branch,
        locked,
        ...(lockReason === undefined ? {} : { lockReason }),
      }
    })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  )
}

async function changedPaths(projectDir: string): Promise<string[]> {
  const raw = await git(projectDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])
  if (!raw) return []
  const fields = raw.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field) continue
    const code = field.slice(0, 2)
    const value = field.slice(3)
    if (value) paths.push(value)
    if (code.includes('R') || code.includes('C')) {
      const prior = fields[index + 1]
      if (prior) paths.push(prior)
      index += 1
    }
  }
  return [...new Set(paths)].sort()
}

async function sourceChangeFingerprint(
  projectDir: string,
  currentHead: string,
  paths: readonly string[],
): Promise<string> {
  const hash = createHash('sha256')
  hash.update('ggai-source-confirmation-v1\0')
  hash.update(currentHead)
  for (const relative of [...paths].sort()) {
    const absolute = path.resolve(projectDir, relative)
    if (!isPathWithin(projectDir, absolute)) {
      throw new SourceGitError('unsafe_change_path', `changed path escapes project: ${relative}`)
    }
    hash.update('\0path\0')
    hash.update(relative)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(absolute)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        hash.update('\0deleted')
        continue
      }
      throw error
    }
    hash.update(`\0mode:${info.mode & 0o7777}`)
    if (info.isSymbolicLink()) {
      hash.update('\0symlink\0')
      hash.update(await readlink(absolute))
      continue
    }
    if (info.isFile()) {
      hash.update('\0file\0')
      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        const opened = await handle.stat()
        if (!opened.isFile()) {
          throw new SourceGitError(
            'source_changed_during_confirmation',
            `source path changed while preparing confirmation: ${relative}`,
          )
        }
        const stream = handle.createReadStream({ autoClose: false })
        for await (const chunk of stream) hash.update(chunk as Buffer)
      } finally {
        await handle.close()
      }
      continue
    }
    if (info.isDirectory()) {
      hash.update('\0directory\0')
      hash.update(await git(projectDir, ['diff', '--submodule=short', 'HEAD', '--', relative]))
      continue
    }
    hash.update('\0special')
  }
  return hash.digest('hex')
}

async function changeWarnings(projectDir: string, paths: string[]): Promise<string[]> {
  const warnings: string[] = []
  let total = 0
  for (const relative of paths) {
    if (isSensitivePath(relative)) warnings.push(`sensitive path: ${relative}`)
    const absolute = path.resolve(projectDir, relative)
    if (!isPathWithin(projectDir, absolute)) {
      throw new SourceGitError('unsafe_change_path', `changed path escapes project: ${relative}`)
    }
    try {
      const info = await lstat(absolute)
      if (!info.isFile()) continue
      total += info.size
      if (info.size > LARGE_FILE_BYTES) warnings.push(`large file: ${relative}`)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
  if (total > LARGE_DIFF_BYTES) warnings.push('total changed file size exceeds 50 MiB')
  return warnings
}

function isSensitivePath(relativePath: string): boolean {
  const name = path.basename(relativePath).toLowerCase()
  return name === '.env'
    || name.startsWith('.env.')
    || /\.(?:pem|key|p12|pfx)$/u.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u.test(name)
    || /^(?:credentials|secrets?)(?:\.|$)/u.test(name)
}

function compactCommitPart(value: string, max: number): string {
  const compact = value.replace(/[\r\n\t]+/gu, ' ').trim()
  return (compact || 'update').slice(0, max)
}

function numericErrorCode(error: unknown): number | null {
  if (
    error instanceof Error
    && 'code' in error
    && typeof error.code === 'number'
  ) return error.code
  return null
}

function childProcessOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!(error instanceof Error)) return ''
  const output = (error as Error & Partial<Record<'stdout' | 'stderr', unknown>>)[key]
  if (typeof output === 'string') return output
  return ''
}

function sanitizeGitError(value: string): string {
  return scrubControlCharacters(value)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500)
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function scrubControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? ' ' : character
  }).join('')
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicWriteText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(value, 'utf8')
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
    return error.stderr.trim() || error.message
  }
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
