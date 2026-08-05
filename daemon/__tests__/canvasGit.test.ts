import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'

import {
  CanvasGitError,
  CanvasGitStore,
  canvasGitEntityFileName,
  readCanvasGitProjectFile,
} from '../canvasGit.js'

const temporaryDirectories: string[] = []
const exec = promisify(execFile)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ggai-canvas-git-'))
  temporaryDirectories.push(directory)
  return directory
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim()
}

function canvasDocument(title = 'First node'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'node:one',
        type: 'text',
        title,
        x: 10,
        y: 20,
      },
    ],
    edges: [{ id: 'edge/one', from: 'node:one', to: 'node:one', label: '' }],
    everCreated: true,
    latestRunByNodeId: { 'node:one': 'run-1' },
    generationByNodeId: {
      'node:one': { log: [{ kind: 'thinking', text: 'persisted preview' }] },
    },
  }
}

test('lazily initializes and writes deterministic normalized checkpoints', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)

  assert.deepEqual(await store.status(), {
    state: 'uninitialized',
    initialized: false,
    gitAvailable: true,
  })

  const first = await store.checkpoint({
    branch: 'main',
    document: canvasDocument(),
    runs: [{ runId: 'run-1', status: 'done', privateLog: undefined }],
    artifacts: [{ nodeId: 'node:one', path: 'artifacts/result.txt', size: 12 }],
    reason: 'node-created',
  })
  assert.equal(first.changed, true)
  assert.match(first.commit, /^[0-9a-f]{40,64}$/)
  assert.equal(first.status.state, 'ready')

  const project = await readCanvasGitProjectFile(store.repoDir) as Record<string, unknown>
  assert.equal(project.schemaVersion, 1)
  assert.equal(project.everCreated, true)
  assert.equal('nodes' in project, false)
  assert.equal('edges' in project, false)
  assert.equal('generationByNodeId' in project, false)

  const nodePath = join(store.repoDir, 'nodes', canvasGitEntityFileName('node:one'))
  const node = JSON.parse(await readFile(nodePath, 'utf8')) as Record<string, unknown>
  assert.equal(node.title, 'First node')
  assert.equal(
    JSON.parse(
      await readFile(
        join(store.repoDir, 'runs', canvasGitEntityFileName('run-1')),
        'utf8',
      ),
    ).privateLog,
    undefined,
  )

  const unchanged = await store.checkpoint({
    branch: 'main',
    document: canvasDocument(),
    runs: [{ runId: 'run-1', status: 'done', privateLog: undefined }],
    artifacts: [{ nodeId: 'node:one', path: 'artifacts/result.txt', size: 12 }],
    reason: 'idle',
  })
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.commit, first.commit)

  const updated = await store.checkpoint({
    branch: 'main',
    document: canvasDocument('Updated title'),
    reason: 'node-updated\nwith injected subject line',
  })
  assert.equal(updated.changed, true)
  assert.notEqual(updated.commit, first.commit)

  const history = await store.history({ branch: 'main', limit: 1 })
  assert.equal(history.entries.length, 1)
  assert.equal(history.entries[0]?.commit, updated.commit)
  assert.equal(history.entries[0]?.subject, 'canvas: node-updated with injected subject line')
  assert.equal(history.nextCursor, updated.commit)

  const older = await store.history({
    branch: 'main',
    cursor: history.nextCursor ?? undefined,
    limit: 10,
  })
  assert.deepEqual(older.entries.map((entry) => entry.commit), [first.commit])
  assert.equal(older.nextCursor, null)

  const reassembled = await store.readDocument('main') as Record<string, unknown>
  assert.equal((reassembled.nodes as Array<Record<string, unknown>>)[0]?.title, 'Updated title')
  assert.equal((reassembled.edges as unknown[]).length, 1)
  assert.equal('generationByNodeId' in reassembled, false)
})

test('persists validated source metadata per checkpoint and rejects tampered history', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  const legacy = await store.checkpoint({ branch: 'main', document: canvasDocument() })
  assert.equal(await store.readSourceMetadata(legacy.commit), null)

  const firstSource = 'a'.repeat(40)
  const paired = await store.checkpoint({
    branch: 'main',
    document: canvasDocument(),
    source: { version: 1, commit: firstSource },
  })
  assert.equal(paired.changed, true)
  assert.deepEqual(await store.readSourceMetadata(paired.commit), {
    version: 1,
    commit: firstSource,
  })
  const unchanged = await store.checkpoint({
    branch: 'main',
    document: canvasDocument(),
    source: { version: 1, commit: firstSource },
  })
  assert.equal(unchanged.changed, false)

  await assert.rejects(
    store.checkpoint({
      branch: 'main',
      document: canvasDocument(),
      source: { version: 1, commit: 'abc123' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CanvasGitError)
      assert.equal(error.code, 'INVALID_SOURCE_METADATA')
      return true
    },
  )

  await writeFile(join(store.repoDir, 'source.json'), '{"version":1,"commit":"bad","extra":true}\n')
  await git(store.repoDir, ['add', '--', 'source.json'])
  await git(store.repoDir, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--no-gpg-sign', '-m', 'tamper source metadata',
  ])
  const tampered = await git(store.repoDir, ['rev-parse', 'HEAD'])
  await assert.rejects(
    store.readSourceMetadata(tampered),
    (error: unknown) => {
      assert.ok(error instanceof CanvasGitError)
      assert.equal(error.code, 'INVALID_SOURCE_METADATA')
      return true
    },
  )
})

test('canvas merges preserve target source metadata for the later coordinated source merge', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  await store.checkpoint({
    branch: 'main',
    document: canvasDocument('Base'),
    source: { version: 1, commit: 'a'.repeat(40) },
  })
  await store.createBranch({ name: 'feature/source-metadata' })
  await store.checkpoint({
    branch: 'main',
    document: canvasDocument('Base'),
    source: { version: 1, commit: 'b'.repeat(40) },
  })
  await store.checkpoint({
    branch: 'feature/source-metadata',
    document: canvasDocument('Feature'),
    source: { version: 1, commit: 'c'.repeat(40) },
  })

  const preview = await store.previewMerge({
    sourceBranch: 'feature/source-metadata',
    targetBranch: 'main',
  })
  assert.equal(preview.state, 'ready')
  assert.equal(preview.paths.includes('source.json'), false)
  assert.equal(preview.conflicts.some((conflict) => conflict.path === 'source.json'), false)
  const merged = await store.merge({
    sourceBranch: 'feature/source-metadata',
    targetBranch: 'main',
  })
  assert.equal(merged.merged, true)
  assert.deepEqual(await store.readSourceMetadata('main'), {
    version: 1,
    commit: 'b'.repeat(40),
  })
})

test('creates locked UUID worktrees and safely deletes only clean merged branches', async () => {
  const projectDir = await temporaryProject()
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]
  const store = new CanvasGitStore(projectDir, { uuid: () => ids.shift() ?? '' })
  await store.checkpoint({ branch: 'main', document: canvasDocument() })

  const disposable = await store.createBranch({ name: 'experiment/disposable' })
  assert.equal(disposable.worktree?.id, '11111111-1111-4111-8111-111111111111')
  assert.equal(disposable.worktree?.locked, true)
  assert.equal(disposable.worktree?.lockReason, 'ggai-managed')
  assert.equal(disposable.worktree?.managed, true)

  await store.deleteBranch('experiment/disposable')
  assert.equal(
    (await store.listBranches()).some((branch) => branch.name === 'experiment/disposable'),
    false,
  )

  const dirty = await store.createBranch({ name: 'experiment/dirty' })
  assert.ok(dirty.worktree)
  await writeFile(join(dirty.worktree.path, 'untracked.txt'), 'do not discard', 'utf8')
  await assert.rejects(
    store.deleteBranch('experiment/dirty'),
    (error: unknown) => error instanceof CanvasGitError && error.code === 'DIRTY_WORKTREE',
  )
  assert.equal(
    (await store.listBranches()).some((branch) => branch.name === 'experiment/dirty'),
    true,
  )
  await assert.rejects(
    store.deleteBranch('main'),
    (error: unknown) => error instanceof CanvasGitError && error.code === 'PROTECTED_BRANCH',
  )
})

test('restores an old checkpoint as an isolated new branch', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir, {
    uuid: () => '33333333-3333-4333-8333-333333333333',
  })
  const old = await store.checkpoint({
    branch: 'main',
    document: canvasDocument('Old version'),
  })
  await store.checkpoint({
    branch: 'main',
    document: canvasDocument('Current version'),
  })

  const restored = await store.restoreAsNewBranch({
    sourceBranch: 'main',
    checkpoint: old.commit.toUpperCase(),
    newBranch: 'restore/old-version',
  })
  assert.ok(restored.worktree)
  assert.equal(restored.commit, old.commit)
  assert.notEqual(restored.worktree.path, store.repoDir)
  const restoredNode = JSON.parse(
    await readFile(
      join(restored.worktree.path, 'nodes', canvasGitEntityFileName('node:one')),
      'utf8',
    ),
  ) as Record<string, unknown>
  assert.equal(restoredNode.title, 'Old version')
  const restoredDocument = await store.readDocument('restore/old-version') as Record<
    string,
    unknown
  >
  assert.equal(
    (restoredDocument.nodes as Array<Record<string, unknown>>)[0]?.title,
    'Old version',
  )

  const restoredHistory = await store.history({ branch: 'restore/old-version' })
  assert.deepEqual(restoredHistory.entries.map((entry) => entry.commit), [old.commit])
})

test('rejects branch injection and reports a missing Git executable as degraded', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  await store.checkpoint({ branch: 'main', document: canvasDocument() })

  await assert.rejects(
    store.createBranch({ name: '--upload-pack=touch-owned' }),
    (error: unknown) => error instanceof CanvasGitError && error.code === 'INVALID_BRANCH',
  )
  await assert.rejects(
    store.createBranch({ name: 'unsafe branch' }),
    (error: unknown) => error instanceof CanvasGitError && error.code === 'INVALID_BRANCH',
  )

  const unavailable = new CanvasGitStore(projectDir, {
    gitBinary: join(projectDir, 'definitely-not-git'),
  })
  const status = await unavailable.status()
  assert.equal(status.state, 'degraded')
  assert.equal(status.gitAvailable, false)
  await assert.rejects(
    unavailable.checkpoint({ branch: 'main', document: canvasDocument() }),
    (error: unknown) => error instanceof CanvasGitError && error.code === 'GIT_UNAVAILABLE',
  )
})

test('rejects unsafe state symlinks before writing outside the project', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  await mkdir(join(projectDir, '.gg'), { recursive: true })
  await symlink(outside, join(projectDir, '.gg', 'canvas-state'))

  const store = new CanvasGitStore(projectDir)
  await assert.rejects(
    store.checkpoint({ branch: 'main', document: canvasDocument() }),
    (error: unknown) => error instanceof CanvasGitError && error.code === 'UNSAFE_PATH',
  )
  await assert.rejects(readFile(join(outside, 'project.json'), 'utf8'), { code: 'ENOENT' })
})

test('project.json symlinks are never followed for reads or checkpoint writes', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  await store.checkpoint({ branch: 'main', document: canvasDocument('Before') })
  const outsideFile = join(outside, 'outside.json')
  await writeFile(outsideFile, '{"sentinel":true}\n', 'utf8')
  const projectFile = join(store.repoDir, 'project.json')
  await rm(projectFile)
  await symlink(outsideFile, projectFile)

  await assert.rejects(
    store.readDocument('main'),
    (error: unknown) => error instanceof CanvasGitError && error.code === 'UNSAFE_PATH',
  )
  await store.checkpoint({ branch: 'main', document: canvasDocument('After') })
  assert.equal(await readFile(outsideFile, 'utf8'), '{"sentinel":true}\n')
  assert.equal((await lstat(projectFile)).isSymbolicLink(), false)
})

test('rejects duplicate normalized entity identifiers before initializing Git', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)

  await assert.rejects(
    store.checkpoint({
      branch: 'main',
      document: {
        schemaVersion: 1,
        nodes: [{ id: 'same' }, { id: 'same' }],
        edges: [],
      },
    }),
    (error: unknown) => error instanceof CanvasGitError && error.code === 'INVALID_SNAPSHOT',
  )
  assert.equal((await store.status()).state, 'uninitialized')
})

test('previews and executes a clean canvas merge without mutating the source branch', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  const initial = await store.checkpoint({ branch: 'main', document: canvasDocument('Base') })
  await store.createBranch({ name: 'feature/clean' })
  const feature = await store.checkpoint({
    branch: 'feature/clean',
    document: canvasDocument('Feature title'),
    reason: 'feature-update',
  })

  const beforePreview = (await store.listBranches()).find((branch) => branch.name === 'main')
  const preview = await store.previewMerge({
    sourceBranch: 'feature/clean',
    targetBranch: 'main',
  })
  assert.equal(preview.state, 'ready')
  assert.equal(preview.sourceCommit, feature.commit)
  assert.equal(preview.targetCommit, initial.commit)
  assert.equal(preview.conflicts.length, 0)
  assert.match(preview.paths.join('\n'), /nodes\//u)
  assert.equal(
    (await store.listBranches()).find((branch) => branch.name === 'main')?.commit,
    beforePreview?.commit,
  )
  assert.equal((await store.listWorktrees()).length, 2)

  const merged = await store.merge({
    sourceBranch: 'feature/clean',
    targetBranch: 'main',
  })
  assert.equal(merged.state, 'ready')
  assert.equal(merged.merged, true)
  assert.notEqual(merged.commit, initial.commit)
  const recoverable = await store.recoverableMergeTip('main', initial.commit)
  assert.equal(recoverable?.commit, merged.commit)
  assert.equal(recoverable?.firstParent, initial.commit)
  const recoveredDocument = recoverable?.document as Record<string, unknown>
  const recoveredParent = recoverable?.firstParentDocument as Record<string, unknown>
  assert.equal(
    (recoveredDocument.nodes as Array<Record<string, unknown>>)[0]?.title,
    'Feature title',
  )
  assert.equal(
    (recoveredParent.nodes as Array<Record<string, unknown>>)[0]?.title,
    'Base',
  )
  assert.equal(await store.recoverableMergeTip('feature/clean', initial.commit), null)
  const main = await store.readDocument('main') as Record<string, unknown>
  assert.equal((main.nodes as Array<Record<string, unknown>>)[0]?.title, 'Feature title')
  assert.equal(
    (await store.listBranches()).find((branch) => branch.name === 'feature/clean')?.commit,
    feature.commit,
  )
})

test('reports canvas conflicts and aborts without changing or dirtying the target', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  await store.checkpoint({ branch: 'main', document: canvasDocument('Base') })
  await store.createBranch({ name: 'feature/conflict' })
  await store.checkpoint({
    branch: 'main',
    document: canvasDocument('Main title'),
    reason: 'main-update',
  })
  await store.checkpoint({
    branch: 'feature/conflict',
    document: canvasDocument('Feature title'),
    reason: 'feature-update',
  })
  const targetBefore = (await store.listBranches()).find((branch) => branch.name === 'main')?.commit

  const preview = await store.previewMerge({
    sourceBranch: 'feature/conflict',
    targetBranch: 'main',
  })
  assert.equal(preview.state, 'conflicts')
  assert.equal(preview.conflicts.length, 1)
  assert.equal(preview.conflicts[0]?.kind, 'content')
  assert.equal(preview.resolution?.requiresExplicitApproval, true)
  assert.equal((await store.listWorktrees()).length, 2)

  const result = await store.merge({
    sourceBranch: 'feature/conflict',
    targetBranch: 'main',
  })
  assert.equal(result.state, 'conflicts')
  assert.equal(result.merged, false)
  assert.equal(result.commit, targetBefore)
  assert.equal(
    (await store.listBranches()).find((branch) => branch.name === 'main')?.commit,
    targetBefore,
  )
  const main = await store.readDocument('main') as Record<string, unknown>
  assert.equal((main.nodes as Array<Record<string, unknown>>)[0]?.title, 'Main title')
  const unchanged = await store.checkpoint({
    branch: 'main',
    document: canvasDocument('Main title'),
  })
  assert.equal(unchanged.changed, false)
})

test('diverged history with an identical tree still creates and cleans up a merge commit', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  await store.checkpoint({ branch: 'main', document: canvasDocument('Base') })
  await store.createBranch({ name: 'same-tree' })
  await store.checkpoint({ branch: 'main', document: canvasDocument('Final') })
  await store.checkpoint({ branch: 'same-tree', document: canvasDocument('Intermediate') })
  await store.checkpoint({ branch: 'same-tree', document: canvasDocument('Final') })

  const preview = await store.previewMerge({
    sourceBranch: 'same-tree',
    targetBranch: 'main',
  })
  assert.equal(preview.state, 'ready')
  assert.deepEqual(preview.paths, [])

  const merged = await store.merge({ sourceBranch: 'same-tree', targetBranch: 'main' })
  assert.equal(merged.state, 'ready')
  assert.equal(merged.merged, true)
  const latest = (await store.history({ branch: 'main', limit: 1 })).entries[0]
  assert.equal(latest?.parents.length, 2)
  assert.equal((await store.listBranches()).find((branch) => branch.name === 'main')?.commit, merged.commit)
})
