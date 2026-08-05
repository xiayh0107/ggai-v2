import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { SourceGitError, SourceGitStore } from '../sourceGit.js'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim()
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-source-git-'))
  await git(root, ['init', '--initial-branch=main'])
  await writeFile(path.join(root, 'README.md'), '# demo\n', 'utf8')
  await git(root, ['add', 'README.md'])
  await git(root, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'initial',
  ])
  return root
}

test('source Git stays unavailable without initializing the user project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-source-no-git-'))
  try {
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    assert.equal((await store.status()).status, 'unavailable')
    await assert.rejects(store.bind(), (error: unknown) => {
      assert.ok(error instanceof SourceGitError)
      assert.equal(error.code, 'not_git')
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('binding creates an isolated ggai source branch and checkpoints run changes', async () => {
  const root = await repository()
  try {
    const originalHead = await git(root, ['rev-parse', 'HEAD'])
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    const binding = await store.bind('main')
    assert.equal(binding.gitBranch, 'ggai/main')
    assert.equal(binding.dirty, false)
    assert.equal(await git(root, ['branch', '--show-current']), 'main')
    assert.equal(await git(root, ['rev-parse', 'HEAD']), originalHead)

    await writeFile(path.join(binding.projectDir, 'feature.ts'), 'export const answer = 42\n', 'utf8')
    const checkpoint = await store.checkpoint('main', {
      runId: 'run-source-1',
      nodeTitle: 'Build feature',
    })
    assert.equal(checkpoint.changed, true)
    assert.equal(checkpoint.requiresConfirmation, false)
    assert.notEqual(checkpoint.commit, originalHead)
    assert.match(await git(binding.worktreePath, ['log', '-1', '--format=%s']), /ggai\(run\)/u)
    assert.equal(await git(root, ['rev-parse', 'HEAD']), originalHead)

    const exclude = await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /^\.gg\/$/mu)
    assert.match(exclude, /^artifacts\/$/mu)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sensitive changes require explicit confirmation even in a managed worktree', async () => {
  const root = await repository()
  try {
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    const binding = await store.bind('main')
    await writeFile(path.join(binding.projectDir, '.env.local'), 'TOKEN=secret\n', 'utf8')

    const blocked = await store.checkpoint('main', {
      runId: 'run-sensitive',
      nodeTitle: 'Configure app',
    })
    assert.equal(blocked.requiresConfirmation, true)
    assert.match(blocked.warnings.join('\n'), /sensitive path/u)
    assert.equal((await store.branch('main'))?.dirty, true)

    const accepted = await store.checkpoint('main', {
      runId: 'run-sensitive',
      nodeTitle: 'Configure app',
      allowSensitive: true,
    })
    assert.equal(accepted.requiresConfirmation, true)
    assert.equal((await store.branch('main'))?.dirty, false)

    await writeFile(path.join(binding.projectDir, '.env'), 'TOKEN=second\n', 'utf8')
    await assert.rejects(
      store.checkpoint('main', {
        runId: 'run-no-preview',
        nodeTitle: 'Skip preview',
        allowSensitive: true,
      }),
      (error: unknown) =>
        error instanceof SourceGitError && error.code === 'confirmation_required',
    )

    await store.checkpoint('main', {
      runId: 'run-stale-preview',
      nodeTitle: 'Preview change',
    })
    await writeFile(path.join(binding.projectDir, '.env'), 'TOKEN=changed-after-preview\n', 'utf8')
    await assert.rejects(
      store.checkpoint('main', {
        runId: 'run-stale-preview',
        nodeTitle: 'Preview change',
        allowSensitive: true,
      }),
      (error: unknown) =>
        error instanceof SourceGitError && error.code === 'source_changed_since_confirmation',
    )
    assert.equal((await store.branch('main'))?.dirty, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed source branches use UUID paths and reject unsafe names', async () => {
  const root = await repository()
  try {
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    await store.bind('main')
    const branch = await store.createBranch('feature/site', 'main')
    assert.equal(branch.gitBranch, 'ggai/feature/site')
    assert.doesNotMatch(branch.worktreePath, /feature\/site/u)
    await store.removeBranch('feature/site')
    assert.equal(await store.branch('feature/site'), null)

    await assert.rejects(
      store.createBranch('../escape', 'main'),
      (error: unknown) => error instanceof SourceGitError && error.code === 'invalid_branch',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('historical source branches require a full commit on the indicated managed lineage', async () => {
  const root = await repository()
  try {
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    const binding = await store.bind('main')
    const historicalHead = binding.head
    await writeFile(path.join(binding.projectDir, 'advanced.ts'), 'export const advanced = true\n')
    const advanced = await store.checkpoint('main', {
      runId: 'run-advanced',
      nodeTitle: 'Advance managed source',
    })
    assert.notEqual(advanced.commit, historicalHead)

    const restored = await store.createBranchAt(
      'restore/historical',
      'main',
      historicalHead,
    )
    assert.equal(restored.head, historicalHead)
    assert.equal(await store.containsCommit('restore/historical', historicalHead), true)
    await assert.rejects(
      readFile(path.join(restored.projectDir, 'advanced.ts'), 'utf8'),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    )
    await assert.rejects(
      store.createBranchAt('restore/short', 'main', historicalHead.slice(0, 12)),
      (error: unknown) => {
        assert.ok(error instanceof SourceGitError)
        assert.equal(error.code, 'invalid_commit')
        return true
      },
    )

    await writeFile(path.join(root, 'user-only.ts'), 'export const userOnly = true\n', 'utf8')
    await git(root, ['add', 'user-only.ts'])
    await git(root, [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'divergent user commit',
    ])
    const nonAncestor = await git(root, ['rev-parse', 'HEAD'])
    assert.equal(await store.containsCommit('restore/historical', nonAncestor), false)
    await assert.rejects(
      store.createBranchAt('restore/not-ancestor', 'main', nonAncestor),
      (error: unknown) => {
        assert.ok(error instanceof SourceGitError)
        assert.equal(error.code, 'commit_not_ancestor')
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('previews and executes a clean merge only in managed source worktrees', async () => {
  const root = await repository()
  try {
    const originalHead = await git(root, ['rev-parse', 'HEAD'])
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    const main = await store.bind('main')
    const feature = await store.createBranch('feature/clean', 'main')
    await writeFile(path.join(feature.projectDir, 'feature.ts'), 'export const value = 1\n', 'utf8')
    const sourceCheckpoint = await store.checkpoint('feature/clean', {
      runId: 'run-feature',
      nodeTitle: 'Create feature',
    })

    const worktreesBefore = (await git(root, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length
    const preview = await store.previewMerge({
      sourceBranch: 'feature/clean',
      targetBranch: 'main',
    })
    assert.equal(preview.state, 'ready')
    assert.equal(preview.sourceCommit, sourceCheckpoint.commit)
    assert.deepEqual(preview.paths, ['feature.ts'])
    assert.equal(
      (await git(root, ['worktree', 'list', '--porcelain']))
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length,
      worktreesBefore,
    )

    const merged = await store.merge({
      sourceBranch: 'feature/clean',
      targetBranch: 'main',
    })
    assert.equal(merged.state, 'ready')
    assert.equal(merged.merged, true)
    assert.notEqual(merged.commit, originalHead)
    assert.equal(await readFile(path.join(main.projectDir, 'feature.ts'), 'utf8'), 'export const value = 1\n')
    assert.equal(await git(main.worktreePath, ['status', '--porcelain']), '')
    assert.equal(await git(root, ['rev-parse', 'HEAD']), originalHead)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('source merge conflicts are reported and aborted without dirtying the target', async () => {
  const root = await repository()
  try {
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    const main = await store.bind('main')
    const feature = await store.createBranch('feature/conflict', 'main')
    await writeFile(path.join(main.projectDir, 'README.md'), '# main\n', 'utf8')
    await store.checkpoint('main', { runId: 'run-main', nodeTitle: 'Main edit' })
    await writeFile(path.join(feature.projectDir, 'README.md'), '# feature\n', 'utf8')
    await store.checkpoint('feature/conflict', {
      runId: 'run-feature',
      nodeTitle: 'Feature edit',
    })
    const targetHead = await git(main.worktreePath, ['rev-parse', 'HEAD'])

    const preview = await store.previewMerge({
      sourceBranch: 'feature/conflict',
      targetBranch: 'main',
    })
    assert.equal(preview.state, 'conflicts')
    assert.deepEqual(preview.paths, ['README.md'])
    assert.equal(preview.conflicts[0]?.kind, 'content')
    assert.equal(preview.resolution?.requiresExplicitApproval, true)

    const result = await store.merge({
      sourceBranch: 'feature/conflict',
      targetBranch: 'main',
    })
    assert.equal(result.state, 'conflicts')
    assert.equal(result.merged, false)
    assert.equal(result.commit, targetHead)
    assert.equal(await git(main.worktreePath, ['rev-parse', 'HEAD']), targetHead)
    assert.equal(await git(main.worktreePath, ['status', '--porcelain']), '')
    assert.equal(await readFile(path.join(main.projectDir, 'README.md'), 'utf8'), '# main\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('strict registry validation rejects repository and managed worktree tampering', async () => {
  const root = await repository()
  try {
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    await store.bind('main')
    await store.createBranch('feature/remove', 'main')
    const pristine = JSON.parse(await readFile(store.registryPath, 'utf8')) as {
      commonDir: string
      branches: Array<Record<string, unknown>>
      [key: string]: unknown
    }

    await writeFile(
      store.registryPath,
      `${JSON.stringify({ ...pristine, unexpected: true })}\n`,
      'utf8',
    )
    assert.equal((await store.status()).status, 'degraded')
    await assert.rejects(
      store.branch('main'),
      (error: unknown) => error instanceof SourceGitError && error.code === 'registry_corrupt',
    )

    await writeFile(
      store.registryPath,
      `${JSON.stringify({ ...pristine, commonDir: path.join(root, 'other-git') })}\n`,
      'utf8',
    )
    await assert.rejects(
      store.checkpoint('main', { runId: 'tampered', nodeTitle: 'Tampered' }),
      (error: unknown) => error instanceof SourceGitError && error.code === 'registry_mismatch',
    )

    const tampered = structuredClone(pristine)
    tampered.branches[0] = {
      ...tampered.branches[0],
      worktreePath: path.join(root, 'outside-managed-root'),
    }
    await writeFile(store.registryPath, `${JSON.stringify(tampered)}\n`, 'utf8')
    const operations = [
      store.bind('main'),
      store.branch('main'),
      store.createBranch('feature/rejected', 'main'),
      store.checkpoint('main', { runId: 'rejected', nodeTitle: 'Rejected' }),
      store.removeBranch('feature/remove'),
      store.previewMerge({ sourceBranch: 'feature/remove', targetBranch: 'main' }),
      store.merge({ sourceBranch: 'feature/remove', targetBranch: 'main' }),
    ]
    for (const operation of operations) {
      await assert.rejects(
        operation,
        (error: unknown) => error instanceof SourceGitError && error.code === 'registry_corrupt',
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed metadata symlinks and Git common directories outside projectRoot are rejected', async () => {
  const symlinkRoot = await repository()
  const outsideMetadata = await mkdtemp(path.join(os.tmpdir(), 'ggai-source-outside-metadata-'))
  try {
    await symlink(outsideMetadata, path.join(symlinkRoot, '.gg'))
    const store = new SourceGitStore({ projectRoot: symlinkRoot, projectDir: symlinkRoot })
    assert.equal((await store.status()).status, 'degraded')
    await assert.rejects(
      store.bind('main'),
      (error: unknown) => error instanceof SourceGitError && error.code === 'unsafe_managed_path',
    )
  } finally {
    await rm(symlinkRoot, { recursive: true, force: true })
    await rm(outsideMetadata, { recursive: true, force: true })
  }

  const daemonRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-source-boundary-'))
  const projectDir = path.join(daemonRoot, 'project')
  const outsideCommon = await mkdtemp(path.join(os.tmpdir(), 'ggai-source-common-'))
  try {
    await mkdir(projectDir, { recursive: true })
    await exec('git', [
      'init', '--initial-branch=main', '--separate-git-dir', path.join(outsideCommon, 'git'),
      projectDir,
    ])
    await writeFile(path.join(projectDir, 'README.md'), '# boundary\n', 'utf8')
    await git(projectDir, ['add', 'README.md'])
    await git(projectDir, [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'initial',
    ])
    const store = new SourceGitStore({ projectRoot: daemonRoot, projectDir })
    const status = await store.status()
    assert.equal(status.status, 'degraded')
    assert.match(status.reason ?? '', /common directory/u)
    await assert.rejects(
      store.bind('main'),
      (error: unknown) => error instanceof SourceGitError
        && error.code === 'common_dir_outside_root',
    )
  } finally {
    await rm(daemonRoot, { recursive: true, force: true })
    await rm(outsideCommon, { recursive: true, force: true })
  }
})

test('binding refuses a symlinked Git info/exclude without modifying its target', async () => {
  const root = await repository()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-source-exclude-target-'))
  const outsideFile = path.join(outside, 'outside-exclude')
  try {
    const commonRaw = await git(root, ['rev-parse', '--git-common-dir'])
    const commonDir = path.resolve(root, commonRaw)
    const excludePath = path.join(commonDir, 'info', 'exclude')
    await writeFile(outsideFile, 'DO NOT MODIFY\n', 'utf8')
    await rm(excludePath, { force: true })
    await symlink(outsideFile, excludePath)

    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    await assert.rejects(
      store.bind('main'),
      (error: unknown) => error instanceof SourceGitError
        && error.code === 'unsafe_common_metadata',
    )
    assert.equal(await readFile(outsideFile, 'utf8'), 'DO NOT MODIFY\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('checkpoint refuses staged or dirty monorepo changes outside the bound project', async () => {
  const root = await repository()
  try {
    const projectDir = path.join(root, 'packages', 'app')
    await mkdir(projectDir, { recursive: true })
    await writeFile(path.join(projectDir, 'index.ts'), 'export const base = true\n', 'utf8')
    await git(root, ['add', 'packages/app/index.ts'])
    await git(root, [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'add app',
    ])
    const store = new SourceGitStore({ projectRoot: root, projectDir })
    const binding = await store.bind('main')
    const headBefore = await git(binding.worktreePath, ['rev-parse', 'HEAD'])
    await writeFile(path.join(binding.worktreePath, 'outside.txt'), 'outside\n', 'utf8')
    await git(binding.worktreePath, ['add', 'outside.txt'])
    await writeFile(path.join(binding.projectDir, 'inside.ts'), 'export const inside = true\n', 'utf8')

    await assert.rejects(
      store.checkpoint('main', { runId: 'outside', nodeTitle: 'Outside' }),
      (error: unknown) => error instanceof SourceGitError
        && error.code === 'changes_outside_project',
    )
    assert.equal(await git(binding.worktreePath, ['rev-parse', 'HEAD']), headBefore)
    assert.equal(
      await git(binding.worktreePath, ['diff', '--cached', '--name-only']),
      'outside.txt',
    )
    await git(binding.worktreePath, ['restore', '--staged', 'outside.txt'])
    await rm(path.join(binding.worktreePath, 'outside.txt'))
    const accepted = await store.checkpoint('main', {
      runId: 'inside-only',
      nodeTitle: 'Inside only',
    })
    assert.equal(accepted.changed, true)
    assert.equal(
      await git(binding.worktreePath, [
        'diff-tree', '--no-commit-id', '--name-only', '-r', accepted.commit,
      ]),
      'packages/app/inside.ts',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('diverged source history with an identical tree still previews and creates a merge commit', async () => {
  const root = await repository()
  try {
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    const main = await store.bind('main')
    const feature = await store.createBranch('feature/empty-commit', 'main')
    await git(feature.worktreePath, [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'empty feature commit',
    ])

    const preview = await store.previewMerge({
      sourceBranch: 'feature/empty-commit',
      targetBranch: 'main',
    })
    assert.equal(preview.state, 'ready')
    assert.deepEqual(preview.paths, [])

    const result = await store.merge({
      sourceBranch: 'feature/empty-commit',
      targetBranch: 'main',
    })
    assert.equal(result.state, 'ready')
    assert.equal(result.merged, true)
    assert.equal((await git(main.worktreePath, ['show', '-s', '--format=%P', 'HEAD'])).split(' ').length, 2)
    assert.equal(await git(main.worktreePath, ['status', '--porcelain']), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed registry persistence rolls back a newly-created worktree and branch', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0,
}, async () => {
  const root = await repository()
  try {
    const store = new SourceGitStore({ projectRoot: root, projectDir: root })
    await store.bind('main')
    const worktreesBefore = (await git(root, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length
    await chmod(store.runtimeDir, 0o500)
    try {
      await assert.rejects(store.createBranch('feature/rollback', 'main'))
    } finally {
      await chmod(store.runtimeDir, 0o700)
    }
    const worktreesAfter = (await git(root, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length
    assert.equal(worktreesAfter, worktreesBefore)
    assert.equal(await git(root, ['branch', '--list', 'ggai/feature/rollback']), '')
    const registry = JSON.parse(await readFile(store.registryPath, 'utf8')) as {
      branches: Array<{ logicalBranch: string }>
    }
    assert.deepEqual(registry.branches.map((branch) => branch.logicalBranch), ['main'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
