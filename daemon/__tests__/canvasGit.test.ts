import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'

import {
  CanvasGitStore,
  CanvasGitError,
} from '../canvasGit.js'
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasNode,
  CanvasTask,
} from '../../src/canvas/model.js'

const temporaryDirectories: string[] = []
const exec = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ggai-canvas-git-v2-'))
  temporaryDirectories.push(directory)
  return directory
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })).stdout.trim()
}

function document(options: {
  nodes?: CanvasNode[]
  tasks?: CanvasTask[]
  edges?: CanvasEdge[]
  everCreated?: boolean
} = {}): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes: options.nodes ?? [],
    tasks: options.tasks ?? [],
    collections: [],
    edges: options.edges ?? [],
    receipts: [],
    everCreated: options.everCreated ?? false,
  }
}

function userNode(id: string, title: string): CanvasNode {
  return {
    id,
    typeRef: { id: 'text', revision: 1, digest: '0000000000000000000000000000000000000000000000000000000000000000' },
    parentId: null,
    orderKey: (1).toString(36).padStart(12, '0'),
    bounds: { w: 280, h: 180 },
    transform: { matrix: [1, 0, 0, 1, 20, 30] },
    title,
    text: `${title} body`,
    artifactRefs: [],
    origin: { kind: 'user' },
  }
}

function userTask(id: string, title = id): CanvasTask {
  return {
    id,
    title,
    goal: `${title} goal`,
    anchor: { x: 20, y: 30 },
    origin: { kind: 'user' },
  }
}

function expectProtocolError(code: CanvasGitError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof CanvasGitError)
    assert.equal(error.code, code)
    return true
  }
}

test('checkpoints only normalized Canvas entities and provides deterministic history', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  assert.equal(store.repoDir, join(projectDir, '.gg', 'canvas'))
  assert.equal(store.worktreesDir, join(projectDir, '.gg', 'canvas-worktrees'))
  assert.deepEqual(await store.status(), {
    state: 'uninitialized',
    initialized: false,
    gitAvailable: true,
  })

  const firstDocument = document({
    nodes: [userNode('node-a', 'First')],
    everCreated: true,
  })
  const first = await store.checkpoint({
    branch: 'main',
    document: firstDocument,
    reason: 'node-created\nno subject injection',
  })
  assert.equal(first.changed, true)
  assert.match(first.commit, /^[0-9a-f]{40,64}$/u)

  const paths = (await git(store.repoDir, ['ls-tree', '-r', '--name-only', 'HEAD']))
    .split('\n')
    .filter(Boolean)
  assert.deepEqual(paths.slice(0, 2), ['.gitignore', 'meta.json'])
  assert.ok(paths.some((path) => /^nodes\/node_[0-9a-f]{64}\.json$/u.test(path)))
  assert.equal(
    paths.some((path) => /(?:runtime|runs|logs|artifacts|selection|session|view)/u.test(path)),
    false,
  )
  assert.deepEqual(await store.readDocument(first.commit.toUpperCase()), firstDocument)

  const unchanged = await store.checkpoint({ branch: 'main', document: firstDocument })
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.commit, first.commit)

  const second = await store.checkpoint({
    branch: 'main',
    document: document({ nodes: [userNode('node-a', 'Second')], everCreated: true }),
    reason: 'node-updated',
  })
  assert.notEqual(second.commit, first.commit)
  const page = await store.history({ branch: 'main', limit: 1 })
  assert.equal(page.entries[0]?.commit, second.commit)
  assert.equal(page.entries[0]?.subject, 'canvas: node-updated')
  assert.equal(page.nextCursor, second.commit)
  const older = await store.history({
    branch: 'main',
    cursor: page.nextCursor ?? undefined,
    limit: 10,
  })
  assert.deepEqual(older.entries.map((entry) => entry.commit), [first.commit])
})

test('rejects runtime-shaped data before initializing or mutating Git', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  const invalid = document() as CanvasDocument & Record<string, unknown>
  invalid.runtime = {
    activeRunId: 'run-private',
    sseCursor: 24,
    selection: ['node-a'],
    session: 'private',
  }
  await assert.rejects(
    store.checkpoint({ branch: 'main', document: invalid }),
    expectProtocolError('INVALID_SNAPSHOT'),
  )
  assert.equal((await store.status()).state, 'uninitialized')
})

test('creates UUID worktrees without putting logical branch names in paths', async () => {
  const projectDir = await temporaryProject()
  const id = '11111111-1111-4111-8111-111111111111'
  const store = new CanvasGitStore(projectDir, { uuid: () => id })
  const base = await store.checkpoint({
    branch: 'main',
    document: document({ nodes: [userNode('node-a', 'Base')], everCreated: true }),
  })
  const branch = await store.createBranch({ name: 'feature/private-goal' })
  assert.ok(branch.worktree)
  assert.equal(branch.commit, base.commit)
  assert.equal(branch.worktree.id, id)
  assert.equal(basename(branch.worktree.path), id)
  assert.equal(branch.worktree.path.includes('feature'), false)
  assert.equal(branch.worktree.locked, true)
  assert.equal(branch.worktree.lockReason, 'ggai-v2-managed')
  assert.deepEqual(
    (await store.listBranches()).map((entry) => entry.name),
    ['feature/private-goal', 'main'],
  )

  await assert.rejects(
    store.createBranch({ name: '--upload-pack=touch-owned' }),
    expectProtocolError('INVALID_BRANCH'),
  )
})

test('strictly restores an old checkpoint as an isolated branch', async () => {
  const projectDir = await temporaryProject()
  const ids = ['22222222-2222-4222-8222-222222222222']
  const store = new CanvasGitStore(projectDir, { uuid: () => ids.shift() ?? '' })
  const oldDocument = document({ nodes: [userNode('node-a', 'Old')], everCreated: true })
  const old = await store.checkpoint({ branch: 'main', document: oldDocument })
  await store.checkpoint({
    branch: 'main',
    document: document({ nodes: [userNode('node-a', 'Current')], everCreated: true }),
  })

  const restored = await store.restoreAsNewBranch({
    sourceBranch: 'main',
    checkpoint: old.commit.toUpperCase(),
    newBranch: 'restore/old',
  })
  assert.ok(restored.worktree)
  assert.equal(restored.commit, old.commit)
  assert.deepEqual(await store.readDocument('restore/old'), oldDocument)
  assert.deepEqual(
    (await store.history({ branch: 'restore/old' })).entries.map((entry) => entry.commit),
    [old.commit],
  )
})

test('rejects malformed or unmanaged commit trees during reads and restores', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir, {
    uuid: () => '33333333-3333-4333-8333-333333333333',
  })
  await store.checkpoint({ branch: 'main', document: document() })
  await writeFile(join(store.repoDir, 'runtime.json'), '{"activeRun":"private"}\n', 'utf8')
  await git(store.repoDir, ['add', '--', 'runtime.json'])
  await git(store.repoDir, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--no-gpg-sign', '-m', 'tamper tree',
  ])
  const tampered = await git(store.repoDir, ['rev-parse', 'HEAD'])

  await assert.rejects(store.readDocument(tampered), expectProtocolError('INVALID_SNAPSHOT'))
  await assert.rejects(
    store.restoreAsNewBranch({
      sourceBranch: 'main',
      checkpoint: tampered,
      newBranch: 'restore/tampered',
    }),
    expectProtocolError('INVALID_SNAPSHOT'),
  )
  assert.equal(
    (await store.listBranches()).some((branch) => branch.name === 'restore/tampered'),
    false,
  )
})

test('rejects symlink entries in an immutable checkpoint tree', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  await store.checkpoint({ branch: 'main', document: document() })
  const target = join(outside, 'meta.json')
  await writeFile(target, '{"schemaVersion":2,"everCreated":false}\n', 'utf8')
  await rm(join(store.repoDir, 'meta.json'))
  await symlink(target, join(store.repoDir, 'meta.json'))
  await git(store.repoDir, ['add', '--', 'meta.json'])
  await git(store.repoDir, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--no-gpg-sign', '-m', 'tamper symlink',
  ])
  const tampered = await git(store.repoDir, ['rev-parse', 'HEAD'])
  await assert.rejects(store.readDocument(tampered), expectProtocolError('INVALID_SNAPSHOT'))
})

test('previews and commits a clean semantic merge without mutating the source', async () => {
  const projectDir = await temporaryProject()
  const ids = [
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
  ]
  const store = new CanvasGitStore(projectDir, { uuid: () => ids.shift() ?? '' })
  const base = await store.checkpoint({ branch: 'main', document: document() })
  await store.createBranch({ name: 'feature/source' })
  const source = await store.checkpoint({
    branch: 'feature/source',
    document: document({ nodes: [userNode('node-a', 'Source')], everCreated: true }),
  })
  await store.checkpoint({
    branch: 'main',
    document: document({ nodes: [userNode('node-b', 'Target')], everCreated: true }),
  })
  const targetBefore = (await store.listBranches()).find((branch) => branch.name === 'main')!.commit

  const preview = await store.previewMerge({
    sourceBranch: 'feature/source',
    targetBranch: 'main',
  })
  assert.equal(preview.state, 'ready')
  assert.equal(preview.conflicts.length, 0)
  assert.equal(
    (await store.listBranches()).find((branch) => branch.name === 'main')?.commit,
    targetBefore,
  )
  assert.equal((await store.listWorktrees()).length, 2)

  const merged = await store.merge({
    sourceBranch: 'feature/source',
    targetBranch: 'main',
  })
  assert.equal(merged.merged, true)
  assert.equal(merged.state, 'ready')
  const result = await store.readDocument('main')
  assert.deepEqual(result.nodes.map((node) => node.id), ['node-a', 'node-b'])
  assert.equal(
    (await store.listBranches()).find((branch) => branch.name === 'feature/source')?.commit,
    source.commit,
  )
  const recoverable = await store.recoverableMergeTip('main', targetBefore)
  assert.equal(recoverable?.commit, merged.commit)
  assert.equal(recoverable?.firstParent, targetBefore)
  assert.equal(await store.recoverableMergeTip('feature/source', base.commit), null)
})

test('reports textual conflicts and leaves the target clean and recoverable', async () => {
  const projectDir = await temporaryProject()
  const ids = [
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
  ]
  const store = new CanvasGitStore(projectDir, { uuid: () => ids.shift() ?? '' })
  await store.checkpoint({
    branch: 'main',
    document: document({ nodes: [userNode('node-a', 'Base')], everCreated: true }),
  })
  await store.createBranch({ name: 'feature/conflict' })
  await store.checkpoint({
    branch: 'main',
    document: document({ nodes: [userNode('node-a', 'Main')], everCreated: true }),
  })
  await store.checkpoint({
    branch: 'feature/conflict',
    document: document({ nodes: [userNode('node-a', 'Feature')], everCreated: true }),
  })
  const targetBefore = (await store.listBranches()).find((branch) => branch.name === 'main')!.commit

  const preview = await store.previewMerge({
    sourceBranch: 'feature/conflict',
    targetBranch: 'main',
  })
  assert.equal(preview.state, 'conflicts')
  assert.equal(preview.conflicts[0]?.kind, 'content')
  assert.equal(preview.resolution?.requiresExplicitApproval, true)
  const merged = await store.merge({
    sourceBranch: 'feature/conflict',
    targetBranch: 'main',
  })
  assert.equal(merged.merged, false)
  assert.equal(merged.commit, targetBefore)
  assert.equal((await store.readDocument('main')).nodes[0]?.title, 'Main')
  const unchanged = await store.checkpoint({
    branch: 'main',
    document: document({ nodes: [userNode('node-a', 'Main')], everCreated: true }),
  })
  assert.equal(unchanged.changed, false)
})

test('aborts a clean Git merge whose combined document violates Canvas semantics', async () => {
  const projectDir = await temporaryProject()
  const ids = [
    '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999',
  ]
  const store = new CanvasGitStore(projectDir, { uuid: () => ids.shift() ?? '' })
  const taskA = userTask('task-a')
  const taskB = userTask('task-b')
  await store.checkpoint({
    branch: 'main',
    document: document({ tasks: [taskA, taskB], everCreated: true }),
  })
  await store.createBranch({ name: 'feature/delete-task' })
  const dependency: CanvasEdge = {
    id: 'edge-dependency',
    from: { kind: 'task', id: 'task-a' },
    to: { kind: 'task', id: 'task-b' },
    relation: 'depends-on',
    contextRole: 'none',
    origin: { kind: 'user' },
  }
  await store.checkpoint({
    branch: 'main',
    document: document({ tasks: [taskA, taskB], edges: [dependency], everCreated: true }),
  })
  await store.checkpoint({
    branch: 'feature/delete-task',
    document: document({ tasks: [taskB], everCreated: true }),
  })
  const targetBefore = (await store.listBranches()).find((branch) => branch.name === 'main')!.commit

  await assert.rejects(
    store.previewMerge({ sourceBranch: 'feature/delete-task', targetBranch: 'main' }),
    expectProtocolError('INVALID_MERGE'),
  )
  assert.equal(
    (await store.listBranches()).find((branch) => branch.name === 'main')?.commit,
    targetBefore,
  )
  await assert.rejects(
    store.merge({ sourceBranch: 'feature/delete-task', targetBranch: 'main' }),
    expectProtocolError('INVALID_MERGE'),
  )
  assert.equal(
    (await store.listBranches()).find((branch) => branch.name === 'main')?.commit,
    targetBefore,
  )
  assert.equal((await store.readDocument('main')).edges.length, 1)
  const unchanged = await store.checkpoint({
    branch: 'main',
    document: document({ tasks: [taskA, taskB], edges: [dependency], everCreated: true }),
  })
  assert.equal(unchanged.changed, false)
})

test('refuses dirty managed worktrees and unsafe repository symlinks', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir)
  await store.checkpoint({ branch: 'main', document: document() })
  const untracked = join(store.repoDir, 'private-run.log')
  await writeFile(untracked, 'private log', 'utf8')
  await assert.rejects(
    store.checkpoint({ branch: 'main', document: document() }),
    expectProtocolError('DIRTY_WORKTREE'),
  )
  assert.equal(await readFile(untracked, 'utf8'), 'private log')

  const secondProject = await temporaryProject()
  const outside = await temporaryProject()
  await mkdir(join(secondProject, '.gg'), { recursive: true })
  await symlink(outside, join(secondProject, '.gg', 'canvas'))
  const unsafe = new CanvasGitStore(secondProject)
  await assert.rejects(
    unsafe.checkpoint({ branch: 'main', document: document() }),
    expectProtocolError('UNSAFE_PATH'),
  )
  await assert.rejects(lstat(join(outside, 'meta.json')), { code: 'ENOENT' })
})

test('reports an unavailable Git executable without touching state', async () => {
  const projectDir = await temporaryProject()
  const store = new CanvasGitStore(projectDir, {
    gitBinary: join(projectDir, 'definitely-not-git'),
  })
  const status = await store.status()
  assert.equal(status.state, 'degraded')
  assert.equal(status.gitAvailable, false)
  await assert.rejects(
    store.checkpoint({ branch: 'main', document: document() }),
    expectProtocolError('GIT_UNAVAILABLE'),
  )
})
