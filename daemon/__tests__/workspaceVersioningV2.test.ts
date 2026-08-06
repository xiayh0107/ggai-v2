import assert from 'node:assert/strict'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import type { CanvasCommandV2 } from '../../src/canvas-v2/commands.js'
import { CanvasCommandStoreV2Manager } from '../canvasCommandStoreV2Manager.js'
import { CanvasGitStoreV2, CanvasGitV2Error } from '../canvasGitV2.js'
import {
  WorkspaceVersionManagerV2,
  type WorkspaceCanvasStoreManagerV2,
} from '../workspaceVersioningV2.js'

const temporaryDirectories: string[] = []
const workspaces: WorkspaceVersionManagerV2[] = []
const canvasManagers: CanvasCommandStoreV2Manager[] = []

afterEach(async () => {
  await Promise.allSettled(workspaces.splice(0).map((workspace) => workspace.close()))
  for (const manager of canvasManagers.splice(0)) manager.close()
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function harness(options: {
  checkpointDelayMs?: number
  canvasStoreManager?: WorkspaceCanvasStoreManagerV2
  canvasGitFactory?: (projectDir: string) => CanvasGitStoreV2
} = {}): Promise<{
  projectDir: string
  canvases: CanvasCommandStoreV2Manager
  workspace: WorkspaceVersionManagerV2
}> {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'ggai-workspace-v2-'))
  temporaryDirectories.push(projectDir)
  const canvases = new CanvasCommandStoreV2Manager({
    projectRoot: projectDir,
    acquireProjectLease: async (requested) => realpath(
      path.isAbsolute(requested) ? requested : path.resolve(projectDir, requested),
    ),
  })
  canvasManagers.push(canvases)
  const workspace = new WorkspaceVersionManagerV2({
    projectRoot: projectDir,
    checkpointDelayMs: options.checkpointDelayMs ?? 60_000,
    canvasStoreManager: options.canvasStoreManager ?? canvases,
    ...(options.canvasGitFactory === undefined
      ? {}
      : { canvasGitFactory: options.canvasGitFactory }),
  })
  workspaces.push(workspace)
  return { projectDir, canvases, workspace }
}

function createTask(id: string, title = id): CanvasCommandV2 {
  return {
    type: 'CreateTask',
    task: {
      id,
      title,
      goal: `${title} goal`,
      anchor: { x: 20, y: 30 },
      origin: { kind: 'user' },
    },
  }
}

function updateGoal(taskId: string, goal: string): CanvasCommandV2 {
  return { type: 'UpdateTaskGoal', taskId, goal }
}

function expectGitError(code: CanvasGitV2Error['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof CanvasGitV2Error)
    assert.equal(error.code, code)
    return true
  }
}

test('validates V2 branch queries without creating orphan runtime snapshots', async () => {
  const { projectDir, workspace } = await harness()
  const canonicalProjectDir = await realpath(projectDir)
  const runtimeRoot = path.join(projectDir, '.gg', 'runtime', 'canvas-v2')

  assert.equal(await workspace.sourceExecutionProjectDir(projectDir, 'main'), canonicalProjectDir)
  await assert.rejects(access(runtimeRoot), { code: 'ENOENT' })
  await assert.rejects(
    workspace.sourceExecutionProjectDir(projectDir, 'feature/missing'),
    expectGitError('BRANCH_NOT_FOUND'),
  )
  await assert.rejects(
    workspace.getCanvas(projectDir, 'feature/missing'),
    expectGitError('BRANCH_NOT_FOUND'),
  )
  await assert.rejects(access(runtimeRoot), { code: 'ENOENT' })

  const main = await workspace.getCanvas(projectDir, 'main')
  assert.equal(main.canvas.revision, 0)
  assert.equal(main.versioning.state, 'uninitialized')
  await assert.rejects(access(runtimeRoot), { code: 'ENOENT' })
})

test('flushes authoritative commands to normalized history on clean shutdown', async () => {
  const { projectDir, canvases, workspace } = await harness()
  const initial = await workspace.getCanvas(projectDir, 'main')
  const saved = await workspace.commitCanvas(
    projectDir,
    'main',
    initial.canvas.revision,
    'create-main-task',
    createTask('task-main', 'Main'),
  )
  assert.equal(saved.canvas.revision, 1)
  assert.equal(saved.canvas.lastCheckpoint, null)

  await workspace.close()
  const durable = await canvases.get(projectDir, 'main')
  assert.match(durable.lastCheckpoint ?? '', /^[0-9a-f]{40,64}$/u)
  assert.equal(durable.revision, 1)
  const history = await new CanvasGitStoreV2(projectDir).history({ branch: 'main' })
  assert.equal(history.entries.length, 1)
  assert.equal(history.entries[0]?.commit, durable.lastCheckpoint)
})

test('keeps main-branch commands and execution available when Canvas Git is degraded', async () => {
  const { projectDir, canvases, workspace } = await harness({
    canvasGitFactory: (canonicalProjectDir) => new CanvasGitStoreV2(
      canonicalProjectDir,
      { gitBinary: 'ggai-definitely-missing-git' },
    ),
  })
  const initial = await workspace.getCanvas(projectDir, 'main')
  assert.equal(initial.versioning.state, 'degraded')
  const saved = await workspace.commitCanvas(
    projectDir,
    'main',
    initial.canvas.revision,
    'save-without-git',
    createTask('task-without-git'),
  )
  assert.equal(saved.canvas.revision, 1)
  assert.equal(saved.versioning.state, 'degraded')
  assert.equal(
    await workspace.sourceExecutionProjectDir(projectDir, 'main'),
    await realpath(projectDir),
  )
  const checkpoint = await workspace.manualCheckpoint(projectDir, 'main')
  assert.equal(checkpoint.ok, false)
  assert.equal(checkpoint.ok ? '' : checkpoint.error.code, 'GIT_UNAVAILABLE')
  assert.equal((await canvases.get(projectDir, 'main')).document.tasks.length, 1)
})

test('coordinates create, switch, restore, history, and idempotent branch retries', async () => {
  const { projectDir, workspace } = await harness()
  const initial = await workspace.getCanvas(projectDir, 'main')
  const oldCanvas = await workspace.commitCanvas(
    projectDir,
    'main',
    initial.canvas.revision,
    'create-versioned-task',
    createTask('task-versioned', 'Old'),
  )
  const oldCheckpoint = await workspace.manualCheckpoint(projectDir, 'main', 'old')
  assert.equal(oldCheckpoint.ok, true)
  if (!oldCheckpoint.ok) return

  const current = await workspace.commitCanvas(
    projectDir,
    'main',
    oldCanvas.canvas.revision,
    'update-versioned-task',
    updateGoal('task-versioned', 'Current goal'),
  )
  const currentCheckpoint = await workspace.manualCheckpoint(projectDir, 'main', 'current')
  assert.equal(currentCheckpoint.ok, true)
  assert.notEqual(
    currentCheckpoint.ok ? currentCheckpoint.value.checkpoint.commit : '',
    oldCheckpoint.value.checkpoint.commit,
  )

  const created = await workspace.createBranch(projectDir, {
    name: 'feature/demo',
    fromBranch: 'main',
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.value.canvas.document.tasks[0]?.goal, 'Current goal')
  assert.equal(created.value.canvas.lastCheckpoint, created.value.branch.commit)
  assert.equal(created.value.branch.worktree?.path.includes('feature/demo'), false)
  assert.equal(
    await workspace.sourceExecutionProjectDir(projectDir, 'feature/demo'),
    await realpath(projectDir),
  )

  const createdRetry = await workspace.createBranch(projectDir, {
    name: 'feature/demo',
    fromBranch: 'main',
  })
  assert.equal(createdRetry.ok, true)
  assert.equal(createdRetry.ok ? createdRetry.value.branch.commit : '', created.value.branch.commit)

  const restored = await workspace.restoreAsNewBranch(projectDir, {
    sourceBranch: 'main',
    checkpoint: oldCheckpoint.value.checkpoint.commit.toUpperCase(),
    newBranch: 'restore/old',
  })
  assert.equal(restored.ok, true)
  if (!restored.ok) return
  assert.equal(restored.value.canvas.document.tasks[0]?.goal, 'Old goal')
  assert.equal(restored.value.canvas.lastCheckpoint, oldCheckpoint.value.checkpoint.commit)

  const restoredRetry = await workspace.restoreAsNewBranch(projectDir, {
    sourceBranch: 'main',
    checkpoint: oldCheckpoint.value.checkpoint.commit,
    newBranch: 'restore/old',
  })
  assert.equal(restoredRetry.ok, true)
  const switched = await workspace.switchBranch(projectDir, 'restore/old')
  assert.equal(switched.ok, true)
  assert.equal(switched.ok ? switched.value.canvas.document.tasks[0]?.goal : '', 'Old goal')

  const branches = await workspace.listBranches(projectDir)
  assert.equal(branches.ok, true)
  assert.deepEqual(
    branches.ok ? branches.value.map((branch) => branch.name) : [],
    ['feature/demo', 'main', 'restore/old'],
  )
  const history = await workspace.history(projectDir, { branch: 'main', limit: 10 })
  assert.equal(history.ok, true)
  assert.ok(history.ok && history.value.entries.length >= 2)
  assert.equal(current.canvas.document.tasks[0]?.goal, 'Current goal')
})

test('rejects a stale merge preview then atomically applies a fresh semantic merge', async () => {
  const { projectDir, workspace } = await harness()
  const created = await workspace.createBranch(projectDir, {
    name: 'feature/source',
    fromBranch: 'main',
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const source = await workspace.commitCanvas(
    projectDir,
    'feature/source',
    created.value.canvas.revision,
    'create-source-task',
    createTask('task-source', 'Source'),
  )
  const main = await workspace.getCanvas(projectDir, 'main')
  await workspace.commitCanvas(
    projectDir,
    'main',
    main.canvas.revision,
    'create-target-task',
    createTask('task-target', 'Target'),
  )

  const firstPreview = await workspace.previewMerge(projectDir, {
    sourceBranch: 'feature/source',
    targetBranch: 'main',
  })
  assert.equal(firstPreview.ok, true)
  if (!firstPreview.ok) return
  assert.equal(firstPreview.value.state, 'ready')
  const changedTarget = await workspace.commitCanvas(
    projectDir,
    'main',
    firstPreview.value.expectation.targetRevision,
    'create-late-task',
    createTask('task-late', 'Late'),
  )
  const stale = await workspace.executeMerge(projectDir, {
    sourceBranch: 'feature/source',
    targetBranch: 'main',
    confirmed: true,
    expected: firstPreview.value.expectation,
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok ? '' : stale.error.code, 'merge_preview_stale')
  assert.equal(stale.partial, false)

  const freshPreview = await workspace.previewMerge(projectDir, {
    sourceBranch: 'feature/source',
    targetBranch: 'main',
  })
  assert.equal(freshPreview.ok, true)
  if (!freshPreview.ok) return
  const merged = await workspace.executeMerge(projectDir, {
    sourceBranch: 'feature/source',
    targetBranch: 'main',
    confirmed: true,
    expected: freshPreview.value.expectation,
  })
  assert.equal(merged.ok, true)
  if (!merged.ok) return
  assert.equal(merged.value.state, 'merged')
  assert.equal(merged.value.canvas.merged, true)
  assert.deepEqual(
    merged.value.canvasEnvelope?.document.tasks.map((task) => task.id),
    ['task-late', 'task-source', 'task-target'],
  )
  assert.equal(
    merged.value.canvasEnvelope?.lastCheckpoint,
    merged.value.canvas.commit,
  )
  assert.equal(source.canvas.document.tasks[0]?.id, 'task-source')
  assert.equal(changedTarget.canvas.document.tasks.length, 2)
})

test('reports semantic conflicts without mutating or dirtying the target branch', async () => {
  const { projectDir, workspace } = await harness()
  const main = await workspace.getCanvas(projectDir, 'main')
  const base = await workspace.commitCanvas(
    projectDir,
    'main',
    main.canvas.revision,
    'create-shared-task',
    createTask('task-shared', 'Base'),
  )
  await workspace.manualCheckpoint(projectDir, 'main', 'base')
  const created = await workspace.createBranch(projectDir, {
    name: 'feature/conflict',
    fromBranch: 'main',
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  await workspace.commitCanvas(
    projectDir,
    'main',
    base.canvas.revision,
    'update-main-goal',
    updateGoal('task-shared', 'Main goal'),
  )
  await workspace.commitCanvas(
    projectDir,
    'feature/conflict',
    created.value.canvas.revision,
    'update-feature-goal',
    updateGoal('task-shared', 'Feature goal'),
  )

  const preview = await workspace.previewMerge(projectDir, {
    sourceBranch: 'feature/conflict',
    targetBranch: 'main',
  })
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  assert.equal(preview.value.state, 'conflicts')
  const execution = await workspace.executeMerge(projectDir, {
    sourceBranch: 'feature/conflict',
    targetBranch: 'main',
    confirmed: true,
    expected: preview.value.expectation,
  })
  assert.equal(execution.ok, true)
  if (!execution.ok) return
  assert.equal(execution.value.state, 'conflicts')
  assert.equal(execution.value.canvas.merged, false)
  assert.equal(execution.value.canvas.commit, preview.value.canvas.targetCommit)
  assert.equal(execution.value.canvasEnvelope?.document.tasks[0]?.goal, 'Main goal')

  const checkpoint = await workspace.manualCheckpoint(projectDir, 'main', 'after-conflict')
  assert.equal(checkpoint.ok, true)
  assert.equal(checkpoint.ok ? checkpoint.value.checkpoint.changed : true, false)
})

test('recovers a committed merge after runtime apply fails at the partial boundary', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'ggai-workspace-v2-recovery-'))
  temporaryDirectories.push(projectDir)
  const delegate = new CanvasCommandStoreV2Manager({
    projectRoot: projectDir,
    acquireProjectLease: async (requested) => realpath(
      path.isAbsolute(requested) ? requested : path.resolve(projectDir, requested),
    ),
  })
  canvasManagers.push(delegate)
  let failApply = false
  const faulting: WorkspaceCanvasStoreManagerV2 = {
    acquireProjectLease: (requested) => delegate.acquireProjectLease(requested),
    hasSnapshot: (requested, branch) => delegate.hasSnapshot(requested, branch),
    get: (requested, branch) => delegate.get(requested, branch),
    commit: (requested, branch, revision, mutationId, command) =>
      delegate.commit(requested, branch, revision, mutationId, command),
    commitLatest: (requested, branch, mutationId, command) =>
      delegate.commitLatest(requested, branch, mutationId, command),
    setLastCheckpoint: (requested, branch, revision, commit) =>
      delegate.setLastCheckpoint(requested, branch, revision, commit),
    materialize: (requested, branch, document, commit) =>
      delegate.materialize(requested, branch, document, commit),
    applyCheckpoint: async (requested, branch, document, commit, revision) => {
      if (failApply) {
        failApply = false
        throw new Error('injected runtime apply failure')
      }
      return delegate.applyCheckpoint(requested, branch, document, commit, revision)
    },
  }
  const workspace = new WorkspaceVersionManagerV2({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasStoreManager: faulting,
  })
  workspaces.push(workspace)

  const created = await workspace.createBranch(projectDir, {
    name: 'feature/recover',
    fromBranch: 'main',
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  await workspace.commitCanvas(
    projectDir,
    'feature/recover',
    created.value.canvas.revision,
    'create-recovery-source',
    createTask('task-recovery-source'),
  )
  const main = await workspace.getCanvas(projectDir, 'main')
  await workspace.commitCanvas(
    projectDir,
    'main',
    main.canvas.revision,
    'create-recovery-target',
    createTask('task-recovery-target'),
  )
  const preview = await workspace.previewMerge(projectDir, {
    sourceBranch: 'feature/recover',
    targetBranch: 'main',
  })
  assert.equal(preview.ok, true)
  if (!preview.ok) return

  failApply = true
  const partial = await workspace.executeMerge(projectDir, {
    sourceBranch: 'feature/recover',
    targetBranch: 'main',
    confirmed: true,
    expected: preview.value.expectation,
  })
  assert.equal(partial.ok, false)
  assert.equal(partial.partial, true)
  assert.equal(partial.ok ? '' : partial.error.code, 'versioning_failed')
  assert.equal(partial.ok ? '' : partial.value?.state, 'partial')
  const beforeRecovery = await delegate.get(projectDir, 'main')
  assert.equal(beforeRecovery.lastCheckpoint, preview.value.canvas.targetCommit)

  const restarted = new WorkspaceVersionManagerV2({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasStoreManager: faulting,
  })
  workspaces.push(restarted)
  const recovered = await restarted.getCanvas(projectDir, 'main')
  assert.deepEqual(
    recovered.canvas.document.tasks.map((task) => task.id),
    ['task-recovery-source', 'task-recovery-target'],
  )
  assert.equal(recovered.canvas.lastCheckpoint, partial.ok ? '' : partial.value?.canvas.commit)
  assert.equal(recovered.canvas.revision, beforeRecovery.revision + 1)
})

test('requires explicit confirmation and exact merge expectations', async () => {
  const { projectDir, workspace } = await harness()
  const created = await workspace.createBranch(projectDir, {
    name: 'feature/confirm',
    fromBranch: 'main',
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const preview = await workspace.previewMerge(projectDir, {
    sourceBranch: 'feature/confirm',
    targetBranch: 'main',
  })
  assert.equal(preview.ok, true)
  if (!preview.ok) return

  const denied = await workspace.executeMerge(projectDir, {
    sourceBranch: 'feature/confirm',
    targetBranch: 'main',
    confirmed: false,
    expected: preview.value.expectation,
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.ok ? '' : denied.error.code, 'merge_confirmation_required')

  const malformed = await workspace.executeMerge(projectDir, {
    sourceBranch: 'feature/confirm',
    targetBranch: 'main',
    confirmed: true,
    expected: {
      ...preview.value.expectation,
      sourceCommit: 'not-a-commit',
    },
  })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.ok ? '' : malformed.error.code, 'invalid_merge_expectation')
})
