import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildProjectionPlanV2 } from '../projectionPlanV2.js'
import type { ProjectionPlanRecordV2 } from '../projectionPlanStoreV2.js'
import {
  recoverInterruptedTaskRunsV2,
  type InterruptedProjectionPlanStoreV2,
} from '../runRecoveryV2.js'
import { RunArtifactStoreV2 } from '../runArtifactStorageV2.js'
import { RunLogStore } from '../runLogs.js'

class PendingRecoveryPlans implements InterruptedProjectionPlanStoreV2 {
  readonly calls: Array<{ taskId: string; runId: string }> = []
  readonly records = new Map<string, ProjectionPlanRecordV2>()

  async get(planId: string): Promise<ProjectionPlanRecordV2 | undefined> {
    const record = this.records.get(planId)
    return record ? structuredClone(record) : undefined
  }

  async recoverInterrupted(
    input: Parameters<InterruptedProjectionPlanStoreV2['recoverInterrupted']>[0],
  ): Promise<Awaited<ReturnType<InterruptedProjectionPlanStoreV2['recoverInterrupted']>>> {
    this.calls.push({ taskId: input.taskId, runId: input.runId })
    const built = buildProjectionPlanV2({
      ...input,
      runStatus: 'interrupted',
    })
    const record: ProjectionPlanRecordV2 = {
      state: 'pending',
      createdAt: 100,
      updatedAt: 100,
      plan: built.plan,
      suggestedActions: built.suggestedActions,
    }
    this.records.set(record.plan.planId, record)
    return { record, disposition: 'created' }
  }
}

test('recovers Task V2 manifests, partial plans, and closes while leaving V1 unchanged', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-run-recovery-v2-')))
  const runLogs = new RunLogStore(root)
  const plans = new PendingRecoveryPlans()
  const materialized: string[] = []
  const artifactStores = new Map<string, RunArtifactStoreV2>()
  const artifactStore = (branch: string) => {
    let store = artifactStores.get(branch)
    if (!store) {
      store = new RunArtifactStoreV2(root, branch)
      artifactStores.set(branch, store)
    }
    return store
  }
  try {
    await runLogs.start({
      runId: 'run-v2-recover',
      taskId: 'task-recover',
      nodeId: 'task-recover',
      agentId: 'codex',
      canvasBranch: 'feature/recovery',
      status: 'running',
      startedAt: 100,
      sessionId: 'session-recover',
    })
    await runLogs.append('run-v2-recover', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'durable work' },
    })
    const location = await artifactStore('feature/recovery').prepareRun('run-v2-recover')
    await writeFile(path.join(location.absoluteFilesRoot, 'partial.R'), 'plot(1:3)\n', 'utf8')

    await runLogs.start({
      runId: 'run-v1-recover',
      nodeId: 'node-legacy',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'running',
      startedAt: 100,
      sessionId: null,
    })

    const first = await recoverInterruptedTaskRunsV2({
      projectDir: root,
      runLogs,
      artifactStore,
      projectionPlanStore: () => plans,
      onProjectionPlanReady: async ({ plan }) => {
        assert.equal((await runLogs.terminalClose(plan.runId))?.status, 'interrupted')
        materialized.push(plan.planId)
      },
    })
    assert.deepEqual(first, {
      candidates: 1,
      appendedCloses: 1,
      closedPlans: 0,
      failures: [],
    })
    assert.deepEqual(plans.calls, [{ taskId: 'task-recover', runId: 'run-v2-recover' }])
    assert.deepEqual(materialized, [closePlanId(await runLogs.terminalClose('run-v2-recover'))])
    assert.equal((await runLogs.summary('run-v2-recover'))?.status, 'interrupted')
    assert.equal((await runLogs.summary('run-v1-recover'))?.status, 'interrupted')

    const page = await runLogs.page('run-v2-recover')
    assert.deepEqual(page?.entries.map(({ id, event }) => ({ id, event })), [
      { id: 1, event: 'agent-event' },
      { id: 2, event: 'close' },
    ])
    const close = page?.entries.at(-1)
    assert.ok(close && close.event === 'close')
    assert.equal(close.data.status, 'interrupted')
    assert.equal(close.data.sessionId, 'session-recover')
    assert.equal(close.data.artifactsComplete, false)
    assert.equal(close.data.artifactManifest?.complete, false)
    assert.deepEqual(close.data.artifactManifest?.entries.map((entry) => entry.relativePath), [
      'partial.R',
    ])
    assert.match(close.data.artifacts[0] ?? '', /\/run-v2-recover\/files\/partial\.R$/u)
    assert.equal(close.data.projectionPlan?.status, 'partial')
    assert.deepEqual(close.data.projectionPlan?.taskProposals, [])
    assert.deepEqual(close.data.suggestedActions, [])
    assert.equal((await runLogs.page('run-v1-recover'))?.entries.length, 0)

    const second = await recoverInterruptedTaskRunsV2({
      projectDir: root,
      runLogs,
      artifactStore,
      projectionPlanStore: () => plans,
      onProjectionPlanReady: async ({ plan }) => {
        materialized.push(plan.planId)
      },
    })
    assert.equal(second.candidates, 1)
    assert.equal(second.appendedCloses, 0)
    assert.equal(materialized.length, 2)
    assert.equal((await runLogs.page('run-v2-recover'))?.entries.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function closePlanId(close: Awaited<ReturnType<RunLogStore['terminalClose']>>): string {
  assert.ok(close?.projectionPlan)
  return close.projectionPlan.planId
}

test('isolates a corrupt manifest and still recovers missing files for another run', async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'ggai-run-recovery-v2-corrupt-')),
  )
  const runLogs = new RunLogStore(root)
  const plans = new PendingRecoveryPlans()
  const stores = new Map<string, RunArtifactStoreV2>()
  const artifactStore = (branch: string) => {
    let store = stores.get(branch)
    if (!store) {
      store = new RunArtifactStoreV2(root, branch)
      stores.set(branch, store)
    }
    return store
  }
  try {
    for (const runId of ['run-corrupt-manifest', 'run-missing-files']) {
      await runLogs.start({
        runId,
        taskId: `task-${runId}`,
        nodeId: `task-${runId}`,
        agentId: 'codex',
        canvasBranch: 'main',
        status: 'preparing',
        startedAt: 100,
        sessionId: null,
      })
    }
    const damaged = await artifactStore('main').prepareRun('run-corrupt-manifest')
    await mkdir(path.dirname(damaged.absoluteManifestPath), { recursive: true })
    await writeFile(damaged.absoluteManifestPath, '{not a manifest', 'utf8')

    const report = await recoverInterruptedTaskRunsV2({
      projectDir: root,
      runLogs,
      artifactStore,
      projectionPlanStore: () => plans,
    })
    assert.equal(report.candidates, 2)
    assert.equal(report.appendedCloses, 2)
    assert.deepEqual(report.failures.map(({ runId, stage }) => ({ runId, stage })), [{
      runId: 'run-corrupt-manifest',
      stage: 'manifest',
    }])

    const damagedClose = (await runLogs.page('run-corrupt-manifest'))?.entries.at(-1)
    assert.ok(damagedClose && damagedClose.event === 'close')
    assert.equal(damagedClose.data.artifactManifest, undefined)
    assert.equal(damagedClose.data.projectionPlan, undefined)
    assert.deepEqual(damagedClose.data.artifacts, [])

    const missingClose = (await runLogs.page('run-missing-files'))?.entries.at(-1)
    assert.ok(missingClose && missingClose.event === 'close')
    assert.equal(missingClose.data.artifactManifest?.complete, false)
    assert.deepEqual(missingClose.data.artifactManifest?.entries, [])
    assert.equal(missingClose.data.projectionPlan?.status, 'partial')
    assert.deepEqual(missingClose.data.projectionPlan?.outputs, [])
    assert.equal(
      await readFile(damaged.absoluteManifestPath, 'utf8'),
      '{not a manifest',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reuses an already-closed manifest but emits an interrupted partial plan', async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'ggai-run-recovery-v2-closed-')),
  )
  const runLogs = new RunLogStore(root)
  const plans = new PendingRecoveryPlans()
  const artifacts = new RunArtifactStoreV2(root, 'main')
  try {
    await runLogs.start({
      runId: 'run-closed-manifest',
      taskId: 'task-closed-manifest',
      nodeId: 'task-closed-manifest',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'awaiting-permission',
      startedAt: 100,
      sessionId: null,
    })
    const location = await artifacts.prepareRun('run-closed-manifest')
    await writeFile(path.join(location.absoluteFilesRoot, 'finished.txt'), 'finished\n', 'utf8')
    const previouslyClosed = await artifacts.closeRun('run-closed-manifest', { complete: true })
    assert.equal(previouslyClosed.manifest.complete, true)

    await recoverInterruptedTaskRunsV2({
      projectDir: root,
      runLogs,
      artifactStore: () => artifacts,
      projectionPlanStore: () => plans,
    })
    const close = (await runLogs.page('run-closed-manifest'))?.entries.at(-1)
    assert.ok(close && close.event === 'close')
    assert.equal(close.data.artifactManifest?.complete, true)
    assert.equal(close.data.artifactsComplete, false)
    assert.equal(close.data.projectionPlan?.status, 'partial')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
