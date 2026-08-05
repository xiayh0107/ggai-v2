import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, test } from 'node:test'

import { CanvasGitStore } from '../canvasGit.js'
import {
  CanvasStore,
  CanvasStoreManager,
  canvasSnapshotPath,
  emptyCanvasDocument,
} from '../canvasStore.js'
import {
  MAX_CANVAS_BRANCH_LENGTH,
  type CanvasDocumentV1,
  type CanvasEnvelope,
  type PutCanvasRequest,
} from '../protocol.js'
import {
  SourceGitError,
  SourceGitManager,
  SourceGitStore,
  type SourceBranchBinding,
} from '../sourceGit.js'
import { WorkspaceVersionManager } from '../workspaceVersioning.js'

const temporaryDirectories: string[] = []
const exec = promisify(execFile)

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

class BlockingCanvasStoreManager extends CanvasStoreManager {
  readonly putEntered = deferred<void>()
  readonly concurrentGet = deferred<void>()
  readonly #putRelease = deferred<void>()
  #blockedMutationId: string | null = null
  #putBlocked = false

  blockMutation(mutationId: string): void {
    this.#blockedMutationId = mutationId
  }

  releaseMutation(): void {
    this.#putRelease.resolve()
  }

  override async put(
    projectDir: string,
    branch: string,
    request: PutCanvasRequest,
  ): Promise<CanvasEnvelope> {
    if (request.mutationId === this.#blockedMutationId) {
      this.#putBlocked = true
      this.putEntered.resolve()
      await this.#putRelease.promise
      this.#putBlocked = false
    }
    return super.put(projectDir, branch, request)
  }

  override get(projectDir: string, branch: string): Promise<CanvasEnvelope> {
    if (this.#putBlocked) this.concurrentGet.resolve()
    return super.get(projectDir, branch)
  }
}

class FailOnceMaterializeCanvasStoreManager extends CanvasStoreManager {
  readonly #branches: Set<string>

  constructor(projectRoot: string, branches: readonly string[]) {
    super({ projectRoot })
    this.#branches = new Set(branches)
  }

  override async materialize(
    projectDir: string,
    branch: string,
    canvas: CanvasDocumentV1,
    checkpoint: string,
  ): Promise<CanvasEnvelope> {
    if (this.#branches.delete(branch)) throw new Error(`injected materialize failure: ${branch}`)
    return super.materialize(projectDir, branch, canvas, checkpoint)
  }
}

class FailOnceApplyCheckpointCanvasStoreManager extends CanvasStoreManager {
  #branch: string | null = null

  failNextApply(branch: string): void {
    this.#branch = branch
  }

  override async applyCheckpoint(
    projectDir: string,
    branch: string,
    canvas: CanvasDocumentV1,
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelope> {
    if (this.#branch === branch) {
      this.#branch = null
      throw new Error(`injected apply checkpoint failure: ${branch}`)
    }
    return super.applyCheckpoint(projectDir, branch, canvas, checkpoint, expectedRevision)
  }
}

class FailAfterDeleteCanvasGitStore extends CanvasGitStore {
  readonly #branches = new Set<string>()

  failAfterDelete(branch: string): void {
    this.#branches.add(branch)
  }

  override async deleteBranch(branch: string): Promise<void> {
    await super.deleteBranch(branch)
    if (this.#branches.delete(branch)) throw new Error(`injected canvas delete failure: ${branch}`)
  }
}

class FailAfterRemoveCanvasStoreManager extends CanvasStoreManager {
  readonly #branches = new Set<string>()

  failAfterRemove(branch: string): void {
    this.#branches.add(branch)
  }

  override async removeBranch(projectDir: string, branch: string): Promise<void> {
    await super.removeBranch(projectDir, branch)
    if (this.#branches.delete(branch)) throw new Error(`injected runtime delete failure: ${branch}`)
  }
}

class FailOnceSourceGitStore extends SourceGitStore {
  readonly #createBranches = new Set<string>()
  readonly #afterCreateBranches = new Set<string>()
  readonly #removeBranches = new Set<string>()

  failCreate(branch: string): void {
    this.#createBranches.add(branch)
  }

  failAfterCreate(branch: string): void {
    this.#afterCreateBranches.add(branch)
  }

  failAfterRemove(branch: string): void {
    this.#removeBranches.add(branch)
  }

  override async createBranch(
    logicalBranch: string,
    fromLogicalBranch: string,
  ): Promise<SourceBranchBinding> {
    if (this.#createBranches.delete(logicalBranch)) {
      throw new SourceGitError('injected_failure', `injected source create failure: ${logicalBranch}`)
    }
    return super.createBranch(logicalBranch, fromLogicalBranch)
  }

  override async createBranchAt(
    logicalBranch: string,
    fromLogicalBranch: string,
    startCommit: string,
  ): Promise<SourceBranchBinding> {
    if (this.#createBranches.delete(logicalBranch)) {
      throw new SourceGitError('injected_failure', `injected source create failure: ${logicalBranch}`)
    }
    const binding = await super.createBranchAt(logicalBranch, fromLogicalBranch, startCommit)
    if (this.#afterCreateBranches.delete(logicalBranch)) {
      throw new SourceGitError(
        'injected_failure',
        `injected failure after source create: ${logicalBranch}`,
      )
    }
    return binding
  }

  override async removeBranch(logicalBranch: string): Promise<void> {
    await super.removeBranch(logicalBranch)
    if (this.#removeBranches.delete(logicalBranch)) {
      throw new SourceGitError('injected_failure', `injected source delete failure: ${logicalBranch}`)
    }
  }
}

class SingleSourceGitManager extends SourceGitManager {
  readonly #sourceStore: SourceGitStore

  constructor(projectRoot: string, sourceStore: SourceGitStore) {
    super(projectRoot)
    this.#sourceStore = sourceStore
  }

  override async store(): Promise<SourceGitStore> {
    return this.#sourceStore
  }

  override async close(): Promise<void> {
    await this.#sourceStore.close()
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-versioning-'))
  temporaryDirectories.push(directory)
  return directory
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim()
}

async function initializeSourceRepository(projectDir: string): Promise<void> {
  await git(projectDir, ['init', '--initial-branch=main'])
  await writeFile(path.join(projectDir, 'README.md'), '# project\n', 'utf8')
  await git(projectDir, ['add', 'README.md'])
  await git(projectDir, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'initial',
  ])
}

function document(title: string): CanvasDocumentV1 {
  return {
    ...emptyCanvasDocument(),
    everCreated: true,
    nodes: [{
      id: 'node_1',
      type: 'text',
      x: 10,
      y: 20,
      w: 320,
      h: 120,
      title,
      instruction: {
        phase: 'done',
        prompt: 'Write',
        attachments: [],
        sources: [],
        open: false,
      },
      payload: { text: title },
    }],
  }
}

test('coordinates durable canvas snapshots, checkpoints, branches, and restore', async () => {
  const projectDir = await temporaryProject()
  const versions = new WorkspaceVersionManager({ projectRoot: projectDir })
  const firstDocument = { ...emptyCanvasDocument(), everCreated: true }
  const saved = await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'mutation-1',
    changeKind: 'node-created',
    document: firstDocument,
  })
  assert.equal(saved.canvas.revision, 1)

  const checkpoint = await versions.manualCheckpoint('.', 'main', 'initial')
  assert.equal(checkpoint.ok, true)
  assert.ok(checkpoint.ok)
  assert.match(checkpoint.value.checkpoint.commit, /^[0-9a-f]{40,64}$/u)
  assert.equal(checkpoint.value.canvas.lastCheckpoint, checkpoint.value.checkpoint.commit)

  const branch = await versions.createBranch('.', { name: 'feature/persist' })
  assert.equal(branch.ok, true)
  assert.ok(branch.ok)
  assert.equal(branch.value.canvas.branch, 'feature/persist')
  assert.equal(branch.value.canvas.document.everCreated, true)
  assert.equal(branch.value.sourceBranch, null)

  await versions.saveCanvas('.', 'feature/persist', {
    baseRevision: branch.value.canvas.revision,
    mutationId: 'mutation-branch',
    changeKind: 'branch-edit',
    document: { ...firstDocument, everCreated: false },
  })
  const branchCheckpoint = await versions.manualCheckpoint('.', 'feature/persist', 'branch edit')
  assert.ok(branchCheckpoint.ok)
  assert.notEqual(
    branchCheckpoint.value.checkpoint.commit,
    checkpoint.value.checkpoint.commit,
  )
  assert.equal((await versions.getCanvas('.', 'main')).canvas.document.everCreated, true)

  const restored = await versions.restoreAsNewBranch('.', {
    sourceBranch: 'main',
    checkpoint: checkpoint.value.checkpoint.commit,
    newBranch: 'restore/initial',
  })
  assert.ok(restored.ok)
  assert.equal(restored.value.canvas.document.everCreated, true)

  const branches = await versions.listBranches('.')
  assert.ok(branches.ok)
  assert.deepEqual(
    branches.value.map((entry) => entry.name).sort(),
    ['feature/persist', 'main', 'restore/initial'],
  )
  await versions.close()
})

test('canvas and source branch layers share the same conservative name limit', async () => {
  const projectDir = await temporaryProject()
  await initializeSourceRepository(projectDir)
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'branch-limit-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  assert.ok((await versions.bindSource('.', 'main')).ok)

  const boundaryName = `b${'x'.repeat(MAX_CANVAS_BRANCH_LENGTH - 1)}`
  const boundary = await versions.createBranch('.', { name: boundaryName })
  assert.ok(boundary.ok)
  assert.equal(boundary.value.sourceBranch?.logicalBranch, boundaryName)

  const tooLong = `${boundaryName}x`
  const rejected = await versions.createBranch('.', { name: tooLong })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.partial, false)
  const canvasBranches = await versions.listBranches('.')
  assert.ok(canvasBranches.ok)
  assert.equal(canvasBranches.value.some((branch) => branch.name === tooLong), false)
  const source = await versions.sourceStatus('.')
  assert.equal(
    source.branches.some((branch) => branch.logicalBranch === tooLong),
    false,
  )
  await versions.close()
})

test('Git degradation never rolls back the authoritative canvas save', async () => {
  const projectDir = await temporaryProject()
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    canvasGitFactory: (canonicalProjectDir) => new CanvasGitStore(canonicalProjectDir, {
      gitBinary: path.join(projectDir, 'missing-git'),
    }),
  })

  const saved = await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'durable-without-git',
    changeKind: 'autosave',
    document: emptyCanvasDocument(),
  })
  assert.equal(saved.canvas.revision, 1)
  assert.equal((await versions.getCanvas('.', 'main')).canvas.revision, 1)

  const checkpoint = await versions.manualCheckpoint('.', 'main')
  assert.equal(checkpoint.ok, false)
  assert.equal(checkpoint.versioning.state, 'degraded')
  await versions.close()
})

test('a quarantined runtime snapshot can be restored safely from Git into a new branch', async () => {
  const projectDir = await temporaryProject()
  const first = new WorkspaceVersionManager({ projectRoot: projectDir })
  await first.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'before-corruption',
    changeKind: 'node-created',
    document: { ...emptyCanvasDocument(), everCreated: true },
  })
  const checkpoint = await first.manualCheckpoint('.', 'main', 'known good')
  assert.ok(checkpoint.ok)
  await first.close()

  await writeFile(canvasSnapshotPath(projectDir, 'main'), '{ invalid runtime snapshot', 'utf8')
  const reopened = new WorkspaceVersionManager({ projectRoot: projectDir })
  const restored = await reopened.restoreAsNewBranch('.', {
    sourceBranch: 'main',
    checkpoint: checkpoint.value.checkpoint.commit,
    newBranch: 'recovery/quarantined',
  })
  assert.ok(restored.ok)
  assert.equal(restored.value.canvas.document.everCreated, true)
  assert.equal(restored.value.canvas.branch, 'recovery/quarantined')
  await reopened.close()
})

test('clean shutdown flushes the final debounced canvas checkpoint', async () => {
  const projectDir = await temporaryProject()
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'pending-at-shutdown',
    changeKind: 'node-created',
    document: { ...emptyCanvasDocument(), everCreated: true },
  })
  await versions.close()

  const reopened = await new CanvasStore(projectDir, 'main').get()
  assert.match(reopened.lastCheckpoint ?? '', /^[0-9a-f]{40,64}$/u)
  const history = await new CanvasGitStore(projectDir).history({ branch: 'main' })
  assert.equal(history.entries.length, 1)
})

test('deleting a branch checkpoints the latest runtime edit before checking merge safety', async () => {
  const projectDir = await temporaryProject()
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'delete-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  const created = await versions.createBranch('.', { name: 'feature/pending-delete' })
  assert.ok(created.ok)

  const saved = await versions.saveCanvas('.', 'feature/pending-delete', {
    baseRevision: created.value.canvas.revision,
    mutationId: 'pending-delete-edit',
    changeKind: 'node-updated',
    document: document('Must survive'),
  })
  const deleted = await versions.deleteBranch('.', 'feature/pending-delete')

  assert.equal(deleted.ok, false)
  if (!deleted.ok) assert.equal(deleted.error.code, 'BRANCH_NOT_MERGED')
  const preserved = await versions.getCanvas('.', 'feature/pending-delete')
  assert.equal(preserved.canvas.revision, saved.canvas.revision)
  assert.equal(preserved.canvas.document.nodes[0]?.title, 'Must survive')
  const branches = await versions.listBranches('.')
  assert.ok(branches.ok)
  assert.equal(
    branches.value.some((branch) => branch.name === 'feature/pending-delete'),
    true,
  )
  await versions.close()
})

test('branch deletion cannot cross a concurrent save on the same branch', async () => {
  const projectDir = await temporaryProject()
  const canvases = new BlockingCanvasStoreManager({ projectRoot: projectDir })
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasStoreManager: canvases,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'concurrent-delete-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  const created = await versions.createBranch('.', { name: 'feature/concurrent-delete' })
  assert.ok(created.ok)

  canvases.blockMutation('concurrent-delete-edit')
  const saving = versions.saveCanvas('.', 'feature/concurrent-delete', {
    baseRevision: created.value.canvas.revision,
    mutationId: 'concurrent-delete-edit',
    changeKind: 'node-updated',
    document: document('Concurrent edit'),
  })
  await canvases.putEntered.promise
  const deleting = versions.deleteBranch('.', 'feature/concurrent-delete')
  const crossedSave = await Promise.race([
    canvases.concurrentGet.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ])
  canvases.releaseMutation()

  const [saved, deleted] = await Promise.all([saving, deleting])
  assert.equal(crossedSave, false)
  assert.equal(deleted.ok, false)
  if (!deleted.ok) assert.equal(deleted.error.code, 'BRANCH_NOT_MERGED')
  assert.equal(saved.canvas.document.nodes[0]?.title, 'Concurrent edit')
  assert.equal(
    (await versions.getCanvas('.', 'feature/concurrent-delete')).canvas.document.nodes[0]?.title,
    'Concurrent edit',
  )
  await versions.close()
})

test('merge execution waits for a concurrent save and rejects its stale preview', async () => {
  const projectDir = await temporaryProject()
  const canvases = new BlockingCanvasStoreManager({ projectRoot: projectDir })
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasStoreManager: canvases,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'concurrent-merge-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  const created = await versions.createBranch('.', { name: 'feature/concurrent-merge' })
  assert.ok(created.ok)
  const preview = await versions.previewMerge('.', {
    sourceBranch: 'feature/concurrent-merge',
    targetBranch: 'main',
  })
  assert.ok(preview.ok)

  canvases.blockMutation('concurrent-merge-edit')
  const saving = versions.saveCanvas('.', 'feature/concurrent-merge', {
    baseRevision: created.value.canvas.revision,
    mutationId: 'concurrent-merge-edit',
    changeKind: 'node-updated',
    document: document('Concurrent merge edit'),
  })
  await canvases.putEntered.promise
  const merging = versions.executeMerge('.', {
    sourceBranch: 'feature/concurrent-merge',
    targetBranch: 'main',
    confirmed: true,
    expected: preview.value.expectation,
  })
  const crossedSave = await Promise.race([
    canvases.concurrentGet.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ])
  canvases.releaseMutation()

  await saving
  const merged = await merging
  assert.equal(crossedSave, false)
  assert.equal(merged.ok, false)
  if (!merged.ok) assert.equal(merged.error.code, 'merge_preview_stale')
  assert.equal(
    (await versions.getCanvas('.', 'main')).canvas.document.nodes[0]?.title,
    'Base',
  )
  await versions.close()
})

test('a committed canvas merge is reconciled into runtime after apply failure and restart', async () => {
  const projectDir = await temporaryProject()
  const canvases = new FailOnceApplyCheckpointCanvasStoreManager({ projectRoot: projectDir })
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasStoreManager: canvases,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'recover-merge-base',
    changeKind: 'node-created',
    document: {
      ...document('Base'),
      generationByNodeId: {
        node_1: {
          epoch: 1,
          current: { key: 'finishing', kind: 'finishing', label: 'Finishing' },
          recent: [],
          log: [{ kind: 'info', text: 'Transient Agent log' }],
        },
      },
    },
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  const created = await versions.createBranch('.', { name: 'feature/recover-merge' })
  assert.ok(created.ok)
  await versions.saveCanvas('.', 'feature/recover-merge', {
    baseRevision: created.value.canvas.revision,
    mutationId: 'recover-merge-feature',
    changeKind: 'node-updated',
    document: document('Merged content'),
  })
  const preview = await versions.previewMerge('.', {
    sourceBranch: 'feature/recover-merge',
    targetBranch: 'main',
  })
  assert.ok(preview.ok)

  canvases.failNextApply('main')
  const failed = await versions.executeMerge('.', {
    sourceBranch: 'feature/recover-merge',
    targetBranch: 'main',
    confirmed: true,
    expected: preview.value.expectation,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.partial, true)
  assert.equal(failed.value?.canvas.merged, true)
  const mergeCommit = failed.value?.canvas.commit
  assert.ok(mergeCommit)
  const staleRuntime = (await versions.getCanvas('.', 'main')).canvas
  assert.equal(staleRuntime.document.nodes[0]?.title, 'Base')
  assert.equal(staleRuntime.lastCheckpoint, preview.value.canvas.targetCommit)
  assert.equal(
    (await new CanvasGitStore(projectDir).readDocument('main') as CanvasDocumentV1)
      .nodes[0]?.title,
    'Merged content',
  )
  await versions.close()

  const reopened = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  const recoveredPreview = await reopened.previewMerge('.', {
    sourceBranch: 'feature/recover-merge',
    targetBranch: 'main',
  })
  assert.ok(recoveredPreview.ok)
  assert.equal(recoveredPreview.value.state, 'up-to-date')
  const recovered = (await reopened.getCanvas('.', 'main')).canvas
  assert.equal(recovered.document.nodes[0]?.title, 'Merged content')
  assert.equal(recovered.lastCheckpoint, mergeCommit)
  const retried = await reopened.executeMerge('.', {
    sourceBranch: 'feature/recover-merge',
    targetBranch: 'main',
    confirmed: true,
    expected: recoveredPreview.value.expectation,
  })
  assert.ok(retried.ok)
  assert.equal(retried.value.state, 'up-to-date')
  assert.equal(
    (await reopened.getCanvas('.', 'main')).canvas.document.nodes[0]?.title,
    'Merged content',
  )
  await reopened.close()
})

test('merge recovery never overwrites runtime edits made after the recorded first parent', async () => {
  const projectDir = await temporaryProject()
  const canvases = new FailOnceApplyCheckpointCanvasStoreManager({ projectRoot: projectDir })
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasStoreManager: canvases,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'divergent-recovery-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  const created = await versions.createBranch('.', { name: 'feature/divergent-recovery' })
  assert.ok(created.ok)
  await versions.saveCanvas('.', 'feature/divergent-recovery', {
    baseRevision: created.value.canvas.revision,
    mutationId: 'divergent-recovery-feature',
    changeKind: 'node-updated',
    document: document('Committed merge content'),
  })
  const preview = await versions.previewMerge('.', {
    sourceBranch: 'feature/divergent-recovery',
    targetBranch: 'main',
  })
  assert.ok(preview.ok)
  canvases.failNextApply('main')
  const failed = await versions.executeMerge('.', {
    sourceBranch: 'feature/divergent-recovery',
    targetBranch: 'main',
    confirmed: true,
    expected: preview.value.expectation,
  })
  assert.equal(failed.ok, false)
  const mergeCommit = failed.value?.canvas.commit
  assert.ok(mergeCommit)
  await versions.close()

  const reopened = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  const beforeEdit = (await reopened.getCanvas('.', 'main')).canvas
  const edited = await reopened.saveCanvas('.', 'main', {
    baseRevision: beforeEdit.revision,
    mutationId: 'journal-edit-before-reconciliation',
    changeKind: 'node-updated',
    document: document('New runtime journal edit'),
  })
  assert.equal(edited.canvas.lastCheckpoint, preview.value.canvas.targetCommit)

  const refused = await reopened.previewMerge('.', {
    sourceBranch: 'feature/divergent-recovery',
    targetBranch: 'main',
  })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.error.code, 'invariant_conflict')
  const preservedRuntime = (await reopened.getCanvas('.', 'main')).canvas
  assert.equal(preservedRuntime.document.nodes[0]?.title, 'New runtime journal edit')
  assert.equal(preservedRuntime.revision, edited.canvas.revision)
  assert.equal(preservedRuntime.lastCheckpoint, preview.value.canvas.targetCommit)
  const gitStore = new CanvasGitStore(projectDir)
  assert.equal(
    (await gitStore.readDocument('main') as CanvasDocumentV1).nodes[0]?.title,
    'Committed merge content',
  )
  assert.equal(
    (await gitStore.listBranches()).find((branch) => branch.name === 'main')?.commit,
    mergeCommit,
  )
  await reopened.close()
})

test('create and restore retries fill a missing runtime layer without duplicate branches', async () => {
  const projectDir = await temporaryProject()
  const canvases = new FailOnceMaterializeCanvasStoreManager(projectDir, [
    'feature/materialize-retry',
    'restore/materialize-retry',
  ])
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasStoreManager: canvases,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'materialize-retry-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  const checkpoint = await versions.manualCheckpoint('.', 'main', 'base')
  assert.ok(checkpoint.ok)

  const failedCreate = await versions.createBranch('.', { name: 'feature/materialize-retry' })
  assert.equal(failedCreate.ok, false)
  assert.equal(failedCreate.partial, true)
  const created = await versions.createBranch('.', { name: 'feature/materialize-retry' })
  assert.ok(created.ok)
  assert.equal(created.value.canvas.document.nodes[0]?.title, 'Base')

  const failedRestore = await versions.restoreAsNewBranch('.', {
    sourceBranch: 'main',
    checkpoint: checkpoint.value.checkpoint.commit.toUpperCase(),
    newBranch: 'restore/materialize-retry',
  })
  assert.equal(failedRestore.ok, false)
  assert.equal(failedRestore.partial, true)
  const restored = await versions.restoreAsNewBranch('.', {
    sourceBranch: 'main',
    checkpoint: checkpoint.value.checkpoint.commit.toUpperCase(),
    newBranch: 'restore/materialize-retry',
  })
  assert.ok(restored.ok)
  assert.equal(restored.value.canvas.document.nodes[0]?.title, 'Base')

  const branches = await versions.listBranches('.')
  assert.ok(branches.ok)
  assert.equal(
    branches.value.filter((branch) => branch.name === 'feature/materialize-retry').length,
    1,
  )
  assert.equal(
    branches.value.filter((branch) => branch.name === 'restore/materialize-retry').length,
    1,
  )
  await versions.close()
})

test('create and restore retries fill a missing bound-source layer', async () => {
  const projectDir = await temporaryProject()
  await initializeSourceRepository(projectDir)
  const sourceStore = new FailOnceSourceGitStore({
    projectRoot: projectDir,
    projectDir,
  })
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    sourceGitManager: new SingleSourceGitManager(projectDir, sourceStore),
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'source-retry-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  const checkpoint = await versions.manualCheckpoint('.', 'main', 'base')
  assert.ok(checkpoint.ok)
  assert.ok((await versions.bindSource('.', 'main')).ok)
  const pairedCheckpoint = await versions.manualCheckpoint('.', 'main', 'paired source base')
  assert.ok(pairedCheckpoint.ok)

  sourceStore.failCreate('feature/source-retry')
  const failedCreate = await versions.createBranch('.', { name: 'feature/source-retry' })
  assert.equal(failedCreate.ok, false)
  assert.equal(failedCreate.partial, true)
  const created = await versions.createBranch('.', { name: 'feature/source-retry' })
  assert.ok(created.ok)
  assert.equal(created.value.sourceBranch?.logicalBranch, 'feature/source-retry')

  sourceStore.failAfterCreate('restore/source-retry')
  const restoreInput = {
    sourceBranch: 'main',
    checkpoint: pairedCheckpoint.value.checkpoint.commit,
    newBranch: 'restore/source-retry',
  }
  const failedRestore = await versions.restoreAsNewBranch('.', restoreInput)
  assert.equal(failedRestore.ok, false)
  assert.equal(failedRestore.partial, true)
  const partiallyRestoredSource = await sourceStore.branch('restore/source-retry')
  assert.ok(partiallyRestoredSource)
  await writeFile(
    path.join(partiallyRestoredSource.projectDir, 'continued-after-partial.ts'),
    'export const continued = true\n',
    'utf8',
  )
  const continued = await sourceStore.checkpoint('restore/source-retry', {
    runId: 'source-restore-retry-continued',
    nodeTitle: 'Continue after partial restore',
  })
  const restored = await versions.restoreAsNewBranch('.', restoreInput)
  assert.ok(restored.ok)
  assert.equal(restored.value.sourceBranch?.logicalBranch, 'restore/source-retry')
  assert.equal(restored.value.sourceBranch?.head, continued.commit)

  const source = await versions.sourceStatus('.')
  assert.equal(
    source.branches.filter((branch) => branch.logicalBranch === 'feature/source-retry').length,
    1,
  )
  assert.equal(
    source.branches.filter((branch) => branch.logicalBranch === 'restore/source-retry').length,
    1,
  )
  await versions.close()
})

test('historical restore recreates the source worktree at the checkpointed source HEAD', async () => {
  const projectDir = await temporaryProject()
  await initializeSourceRepository(projectDir)
  const userHead = await git(projectDir, ['rev-parse', 'HEAD'])
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'historical-source-base',
    changeKind: 'node-created',
    document: document('Historical canvas'),
  })
  const binding = await versions.bindSource('.', 'main')
  assert.ok(binding.ok)
  const historicalSourceHead = binding.value.head
  const historical = await versions.manualCheckpoint('.', 'main', 'historical pair')
  assert.ok(historical.ok)

  await writeFile(
    path.join(binding.value.projectDir, 'advanced-source.ts'),
    'export const advancedSource = true\n',
    'utf8',
  )
  const advanced = await versions.checkpointSource('.', 'main', {
    runId: 'historical-source-advance',
    nodeTitle: 'Advance source after canvas checkpoint',
  })
  assert.ok(advanced.ok)
  assert.notEqual(advanced.value.commit, historicalSourceHead)
  const anchoredCanvas = (await versions.getCanvas('.', 'main')).canvas.lastCheckpoint
  assert.ok(anchoredCanvas)
  assert.deepEqual(
    await new CanvasGitStore(projectDir).readSourceMetadata(anchoredCanvas),
    { version: 1, commit: advanced.value.commit },
  )

  const restored = await versions.restoreAsNewBranch('.', {
    sourceBranch: 'main',
    checkpoint: historical.value.checkpoint.commit,
    newBranch: 'restore/historical-source',
  })
  assert.ok(restored.ok)
  assert.equal(restored.value.sourceBranch?.head, historicalSourceHead)
  await assert.rejects(
    readFile(path.join(restored.value.sourceBranch?.projectDir ?? '', 'advanced-source.ts'), 'utf8'),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
  assert.equal((await versions.sourceBranch('.', 'main')).value?.head, advanced.value.commit)
  assert.equal(await git(projectDir, ['rev-parse', 'HEAD']), userHead)
  await versions.close()
})

test('confirmed sensitive source checkpoints anchor their exact HEAD in canvas history', async () => {
  const projectDir = await temporaryProject()
  await initializeSourceRepository(projectDir)
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'sensitive-source-anchor',
    changeKind: 'node-created',
    document: document('Sensitive source anchor'),
  })
  const binding = await versions.bindSource('.', 'main')
  assert.ok(binding.ok)
  const initial = await versions.manualCheckpoint('.', 'main', 'before sensitive source')
  assert.ok(initial.ok)

  await writeFile(
    path.join(binding.value.projectDir, 'credentials.pem'),
    'test-only-sensitive-material\n',
    'utf8',
  )
  const preview = await versions.checkpointSource('.', 'main', {
    runId: 'sensitive-source-run',
    nodeTitle: 'Sensitive source change',
  })
  assert.ok(preview.ok)
  assert.equal(preview.value.requiresConfirmation, true)
  assert.equal((await versions.getCanvas('.', 'main')).canvas.lastCheckpoint, initial.value.checkpoint.commit)

  const confirmed = await versions.checkpointSource('.', 'main', {
    runId: 'sensitive-source-run',
    nodeTitle: 'Sensitive source change',
    allowSensitive: true,
  })
  assert.ok(confirmed.ok)
  assert.equal(confirmed.value.requiresConfirmation, true)
  const anchored = (await versions.getCanvas('.', 'main')).canvas.lastCheckpoint
  assert.ok(anchored)
  assert.notEqual(anchored, initial.value.checkpoint.commit)
  assert.deepEqual(
    await new CanvasGitStore(projectDir).readSourceMetadata(anchored),
    { version: 1, commit: confirmed.value.commit },
  )
  await versions.close()
})

test('legacy canvas checkpoints without source metadata restore canvas-only', async () => {
  const projectDir = await temporaryProject()
  await initializeSourceRepository(projectDir)
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'legacy-source-base',
    changeKind: 'node-created',
    document: document('Legacy canvas'),
  })
  const legacy = await versions.manualCheckpoint('.', 'main', 'legacy canvas-only')
  assert.ok(legacy.ok)
  assert.equal(
    await new CanvasGitStore(projectDir).readSourceMetadata(legacy.value.checkpoint.commit),
    null,
  )
  assert.ok((await versions.bindSource('.', 'main')).ok)

  const restored = await versions.restoreAsNewBranch('.', {
    sourceBranch: 'main',
    checkpoint: legacy.value.checkpoint.commit,
    newBranch: 'restore/legacy-canvas-only',
  })
  assert.ok(restored.ok)
  assert.equal(restored.value.canvas.document.nodes[0]?.title, 'Legacy canvas')
  assert.equal(restored.value.sourceBranch, null)
  const source = await versions.sourceBranch('.', 'restore/legacy-canvas-only')
  assert.ok(source.ok)
  assert.equal(source.value, null)
  await versions.close()
})

test('a source-paired checkpoint restores canvas partially when source Git is unbound', async () => {
  const projectDir = await temporaryProject()
  await initializeSourceRepository(projectDir)
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'source-unbound-restore-base',
    changeKind: 'node-created',
    document: document('Source-paired canvas'),
  })
  await versions.manualCheckpoint('.', 'main', 'canvas base')
  const sourceHead = await git(projectDir, ['rev-parse', 'HEAD'])
  const paired = await new CanvasGitStore(projectDir).checkpoint({
    branch: 'main',
    document: document('Source-paired canvas'),
    reason: 'synthetic source pair',
    source: { version: 1, commit: sourceHead },
  })

  const restoreInput = {
    sourceBranch: 'main',
    checkpoint: paired.commit,
    newBranch: 'restore/source-unbound',
  }
  const restored = await versions.restoreAsNewBranch('.', restoreInput)
  assert.equal(restored.ok, false)
  assert.equal(restored.partial, true)
  assert.equal(restored.sourceDegraded, true)
  if (!restored.ok) {
    assert.equal(restored.error.code, 'source_restore_unavailable')
    assert.equal(restored.value?.canvas.document.nodes[0]?.title, 'Source-paired canvas')
    assert.equal(restored.value?.sourceBranch, null)
  }
  assert.equal(
    (await versions.getCanvas('.', 'restore/source-unbound')).canvas.document.nodes[0]?.title,
    'Source-paired canvas',
  )

  const retried = await versions.restoreAsNewBranch('.', restoreInput)
  assert.equal(retried.ok, false)
  assert.equal(retried.partial, true)
  if (!retried.ok) assert.equal(retried.error.code, 'source_restore_unavailable')
  await versions.close()
})

test('branch reconciliation rejects a runtime layer without a canvas Git branch', async () => {
  const projectDir = await temporaryProject()
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'invariant-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  await versions.saveCanvas('.', 'feature/runtime-only', {
    baseRevision: 0,
    mutationId: 'runtime-only',
    changeKind: 'node-created',
    document: document('Runtime only'),
  })

  const result = await versions.createBranch('.', { name: 'feature/runtime-only' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'invariant_conflict')
  const branches = await versions.listBranches('.')
  assert.ok(branches.ok)
  assert.equal(branches.value.some((branch) => branch.name === 'feature/runtime-only'), false)
  await versions.close()
})

test('delete retry converges after the canvas branch was removed before an error', async () => {
  const projectDir = await temporaryProject()
  const canvasGit = new FailAfterDeleteCanvasGitStore(projectDir)
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasGitFactory: () => canvasGit,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'canvas-delete-retry-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  assert.ok((await versions.createBranch('.', { name: 'feature/canvas-delete-retry' })).ok)
  canvasGit.failAfterDelete('feature/canvas-delete-retry')

  const failed = await versions.deleteBranch('.', 'feature/canvas-delete-retry')
  assert.equal(failed.ok, false)
  assert.equal(failed.partial, true)
  const retried = await versions.deleteBranch('.', 'feature/canvas-delete-retry')
  assert.ok(retried.ok)
  assert.equal(retried.value.canvasDeleted, true)
  assert.equal(retried.value.runtimeDeleted, true)
  assert.equal((await versions.getCanvas('.', 'feature/canvas-delete-retry')).canvas.revision, 0)
  await versions.close()
})

test('delete retry converges after runtime removal completed before an error', async () => {
  const projectDir = await temporaryProject()
  const canvases = new FailAfterRemoveCanvasStoreManager({ projectRoot: projectDir })
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    canvasStoreManager: canvases,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'runtime-delete-retry-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  assert.ok((await versions.createBranch('.', { name: 'feature/runtime-delete-retry' })).ok)
  canvases.failAfterRemove('feature/runtime-delete-retry')

  const failed = await versions.deleteBranch('.', 'feature/runtime-delete-retry')
  assert.equal(failed.ok, false)
  assert.equal(failed.partial, true)
  const retried = await versions.deleteBranch('.', 'feature/runtime-delete-retry')
  assert.ok(retried.ok)
  assert.equal(retried.value.canvasDeleted, true)
  assert.equal(retried.value.runtimeDeleted, true)
  await versions.close()
})

test('source delete safety is checked before any canvas layer is removed', async () => {
  const projectDir = await temporaryProject()
  await initializeSourceRepository(projectDir)
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'source-delete-safety-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  assert.ok((await versions.bindSource('.', 'main')).ok)
  const created = await versions.createBranch('.', { name: 'feature/source-delete-safety' })
  assert.ok(created.ok)
  assert.ok(created.value.sourceBranch)
  await writeFile(
    path.join(created.value.sourceBranch.projectDir, 'unmerged.ts'),
    'export const unmerged = true\n',
    'utf8',
  )
  assert.ok((await versions.checkpointSource('.', 'feature/source-delete-safety', {
    runId: 'source-delete-safety',
    nodeTitle: 'Unmerged source',
  })).ok)

  const deleted = await versions.deleteBranch('.', 'feature/source-delete-safety')
  assert.equal(deleted.ok, false)
  assert.equal(deleted.partial, false)
  if (!deleted.ok) assert.equal(deleted.error.code, 'branch_not_merged')
  const branches = await versions.listBranches('.')
  assert.ok(branches.ok)
  assert.equal(
    branches.value.some((branch) => branch.name === 'feature/source-delete-safety'),
    true,
  )
  const sourceBranch = await versions.sourceBranch('.', 'feature/source-delete-safety')
  assert.ok(sourceBranch.ok)
  assert.ok(sourceBranch.value)
  await versions.close()
})

test('delete retry converges after a source branch was removed before an error', async () => {
  const projectDir = await temporaryProject()
  await initializeSourceRepository(projectDir)
  const sourceStore = new FailOnceSourceGitStore({
    projectRoot: projectDir,
    projectDir,
  })
  const versions = new WorkspaceVersionManager({
    projectRoot: projectDir,
    checkpointDelayMs: 60_000,
    sourceGitManager: new SingleSourceGitManager(projectDir, sourceStore),
  })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'source-delete-retry-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  assert.ok((await versions.bindSource('.', 'main')).ok)
  assert.ok((await versions.createBranch('.', { name: 'feature/source-delete-retry' })).ok)
  sourceStore.failAfterRemove('feature/source-delete-retry')

  const failed = await versions.deleteBranch('.', 'feature/source-delete-retry')
  assert.equal(failed.ok, false)
  assert.equal(failed.partial, true)
  const retried = await versions.deleteBranch('.', 'feature/source-delete-retry')
  assert.ok(retried.ok)
  assert.equal(retried.value.canvasDeleted, true)
  assert.equal(retried.value.sourceDeleted, true)
  assert.equal(retried.value.runtimeDeleted, true)
  const source = await versions.sourceBranch('.', 'feature/source-delete-retry')
  assert.ok(source.ok)
  assert.equal(source.value, null)
  await versions.close()
})

test('previews and explicitly executes a canvas branch merge into durable runtime state', async () => {
  const projectDir = await temporaryProject()
  const versions = new WorkspaceVersionManager({ projectRoot: projectDir })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'merge-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  const branch = await versions.createBranch('.', { name: 'feature/merge' })
  assert.ok(branch.ok)
  await versions.saveCanvas('.', 'feature/merge', {
    baseRevision: branch.value.canvas.revision,
    mutationId: 'feature-edit',
    changeKind: 'node-updated',
    document: document('Feature'),
  })

  const preview = await versions.previewMerge('.', {
    sourceBranch: 'feature/merge',
    targetBranch: 'main',
  })
  assert.ok(preview.ok)
  assert.equal(preview.value.state, 'ready')
  assert.equal(preview.value.source, null)

  const denied = await versions.executeMerge('.', {
    sourceBranch: 'feature/merge',
    targetBranch: 'main',
    confirmed: false,
    expected: preview.value.expectation,
  })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, 'merge_confirmation_required')

  const merged = await versions.executeMerge('.', {
    sourceBranch: 'feature/merge',
    targetBranch: 'main',
    confirmed: true,
    expected: preview.value.expectation,
  })
  assert.ok(merged.ok)
  assert.equal(merged.value.state, 'merged')
  assert.equal(merged.value.canvas.merged, true)
  assert.equal(merged.value.canvasEnvelope?.document.nodes[0]?.title, 'Feature')
  assert.equal((await versions.getCanvas('.', 'main')).canvas.document.nodes[0]?.title, 'Feature')
  await versions.close()
})

test('workspace merge reports conflicts without overwriting the target canvas', async () => {
  const projectDir = await temporaryProject()
  const versions = new WorkspaceVersionManager({ projectRoot: projectDir })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'conflict-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  const branch = await versions.createBranch('.', { name: 'feature/conflict' })
  assert.ok(branch.ok)
  await versions.saveCanvas('.', 'main', {
    baseRevision: (await versions.getCanvas('.', 'main')).canvas.revision,
    mutationId: 'main-edit',
    changeKind: 'node-updated',
    document: document('Main'),
  })
  await versions.saveCanvas('.', 'feature/conflict', {
    baseRevision: branch.value.canvas.revision,
    mutationId: 'feature-conflict-edit',
    changeKind: 'node-updated',
    document: document('Feature'),
  })

  const preview = await versions.previewMerge('.', {
    sourceBranch: 'feature/conflict',
    targetBranch: 'main',
  })
  assert.ok(preview.ok)
  assert.equal(preview.value.state, 'conflicts')
  assert.equal(preview.value.canvas.resolution?.requiresExplicitApproval, true)

  const result = await versions.executeMerge('.', {
    sourceBranch: 'feature/conflict',
    targetBranch: 'main',
    confirmed: true,
    expected: preview.value.expectation,
  })
  assert.ok(result.ok)
  assert.equal(result.value.state, 'conflicts')
  assert.equal(result.value.canvas.merged, false)
  assert.equal((await versions.getCanvas('.', 'main')).canvas.document.nodes[0]?.title, 'Main')
  await versions.close()
})

test('workspace merge coordinates bound source and canvas branches without touching user main', async () => {
  const projectDir = await temporaryProject()
  await git(projectDir, ['init', '--initial-branch=main'])
  await writeFile(path.join(projectDir, 'README.md'), '# project\n', 'utf8')
  await git(projectDir, ['add', 'README.md'])
  await git(projectDir, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'initial',
  ])
  const userHead = await git(projectDir, ['rev-parse', 'HEAD'])

  const versions = new WorkspaceVersionManager({ projectRoot: projectDir })
  await versions.saveCanvas('.', 'main', {
    baseRevision: 0,
    mutationId: 'source-merge-base',
    changeKind: 'node-created',
    document: document('Base'),
  })
  await versions.manualCheckpoint('.', 'main', 'base')
  const binding = await versions.bindSource('.', 'main')
  assert.ok(binding.ok)
  const branch = await versions.createBranch('.', { name: 'feature/full-merge' })
  assert.ok(branch.ok)
  assert.ok(branch.value.sourceBranch)

  await writeFile(
    path.join(branch.value.sourceBranch.projectDir, 'feature.ts'),
    'export const feature = true\n',
    'utf8',
  )
  const sourceCheckpoint = await versions.checkpointSource('.', 'feature/full-merge', {
    runId: 'run-full-merge',
    nodeTitle: 'Build full feature',
  })
  assert.ok(sourceCheckpoint.ok)
  await versions.saveCanvas('.', 'feature/full-merge', {
    baseRevision: branch.value.canvas.revision,
    mutationId: 'source-merge-canvas-edit',
    changeKind: 'node-updated',
    document: document('Feature'),
  })

  const preview = await versions.previewMerge('.', {
    sourceBranch: 'feature/full-merge',
    targetBranch: 'main',
  })
  assert.ok(preview.ok)
  assert.equal(preview.value.canvas.state, 'ready')
  assert.equal(preview.value.source?.state, 'ready')

  await writeFile(
    path.join(branch.value.sourceBranch.projectDir, 'after-preview.ts'),
    'export const afterPreview = true\n',
    'utf8',
  )
  await git(branch.value.sourceBranch.projectDir, ['add', 'after-preview.ts'])
  await git(branch.value.sourceBranch.projectDir, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'change source after preview',
  ])
  const stale = await versions.executeMerge('.', {
    sourceBranch: 'feature/full-merge',
    targetBranch: 'main',
    confirmed: true,
    expected: preview.value.expectation,
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'merge_preview_stale')
  const refreshed = await versions.previewMerge('.', {
    sourceBranch: 'feature/full-merge',
    targetBranch: 'main',
  })
  assert.ok(refreshed.ok)

  const merged = await versions.executeMerge('.', {
    sourceBranch: 'feature/full-merge',
    targetBranch: 'main',
    confirmed: true,
    expected: refreshed.value.expectation,
  })
  assert.ok(merged.ok)
  assert.equal(merged.value.state, 'merged')
  assert.equal(merged.value.canvas.merged, true)
  assert.equal(merged.value.source?.merged, true)
  assert.equal(
    await readFile(path.join(binding.value.projectDir, 'feature.ts'), 'utf8'),
    'export const feature = true\n',
  )
  assert.equal(
    await readFile(path.join(binding.value.projectDir, 'after-preview.ts'), 'utf8'),
    'export const afterPreview = true\n',
  )
  assert.equal(await git(projectDir, ['rev-parse', 'HEAD']), userHead)
  await versions.close()
})

test('all workspace operations share the same single-daemon project lease', async () => {
  const projectDir = await temporaryProject()
  const first = new WorkspaceVersionManager({ projectRoot: projectDir })
  const second = new WorkspaceVersionManager({ projectRoot: projectDir })

  assert.equal((await first.sourceStatus('.')).status, 'unavailable')
  await assert.rejects(
    second.sourceStatus('.'),
    (error: unknown) => error instanceof Error && /another daemon process/u.test(error.message),
  )

  await first.close()
  assert.equal((await second.sourceStatus('.')).status, 'unavailable')
  await second.close()
})
