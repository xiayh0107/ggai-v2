import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { autoMaterializeProjectionPlanV2 } from '../canvasProjectionCoordinatorV2.js'
import { CanvasCommandStoreV2Manager } from '../canvasCommandStoreV2Manager.js'
import { canvasBranchStorageId } from '../canvasStore.js'
import { ProjectionPlanStoreV2 } from '../projectionPlanStoreV2.js'
import { BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2 } from '../projectionPluginsV2.js'
import { RunArtifactStoreV2 } from '../runArtifactStorageV2.js'
import { RunLogStore } from '../runLogs.js'
import { RunManager } from '../runs.js'

test('RunManager startup recovers Task V2 by branch and isolates corrupt/V1 runs', async () => {
  const root = await temporaryRoot('ggai-manager-recovery-v2-')
  const logs = new RunLogStore(root)
  const featureArtifacts = new RunArtifactStoreV2(root, 'feature/recovery')
  try {
    await logs.start(runningTaskSummary(
      'run-recover-good',
      'task-recover-good',
      'feature/recovery',
    ))
    await logs.append('run-recover-good', {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'before restart' },
    })
    const goodLocation = await featureArtifacts.prepareRun('run-recover-good')
    await writeFile(path.join(goodLocation.absoluteFilesRoot, 'partial.R'), 'plot(1:3)\n', 'utf8')

    await logs.start(runningTaskSummary('run-recover-corrupt', 'task-recover-corrupt', 'main'))
    const corruptLocation = await new RunArtifactStoreV2(root, 'main')
      .prepareRun('run-recover-corrupt')
    await mkdir(path.dirname(corruptLocation.absoluteManifestPath), { recursive: true })
    await writeFile(corruptLocation.absoluteManifestPath, '{broken manifest', 'utf8')

    await logs.start({
      runId: 'run-recover-v1',
      nodeId: 'node-v1',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'running',
      startedAt: 100,
      sessionId: null,
    })

    const materialized: string[] = []
    const manager = new RunManager({
      projectRoot: root,
      onProjectionPlanReady: async ({ plan }) => {
        assert.equal((await new RunLogStore(root).terminalClose(plan.runId))?.status, 'interrupted')
        materialized.push(plan.planId)
      },
    })
    assert.equal((await manager.getPersisted('run-recover-good'))?.status, 'interrupted')

    const goodClose = await logs.terminalClose('run-recover-good')
    assert.equal(goodClose?.status, 'interrupted')
    assert.equal(goodClose?.artifactManifest?.complete, false)
    assert.deepEqual(goodClose?.artifactManifest?.entries.map((entry) => entry.relativePath), [
      'partial.R',
    ])
    assert.equal(goodClose?.projectionPlan?.status, 'partial')
    assert.deepEqual(goodClose?.projectionPlan?.taskProposals, [])
    assert.deepEqual(goodClose?.suggestedActions, [])
    assert.deepEqual(materialized, [goodClose?.projectionPlan?.planId])
    assert.equal((await logs.page('run-recover-good'))?.entries.at(-1)?.id, 2)

    const planId = goodClose?.projectionPlan?.planId
    assert.ok(planId)
    assert.equal(
      (await manager.getPendingProjectionPlan(planId, '.', 'feature/recovery'))?.plan.digest,
      goodClose?.projectionPlan?.digest,
    )
    assert.equal(await manager.getPendingProjectionPlan(planId, '.', 'main'), null)

    const corruptClose = await logs.terminalClose('run-recover-corrupt')
    assert.equal(corruptClose?.status, 'interrupted')
    assert.equal(corruptClose?.artifactManifest, undefined)
    assert.equal(corruptClose?.projectionPlan, undefined)
    assert.equal((await logs.summary('run-recover-v1'))?.status, 'interrupted')
    assert.equal(await logs.terminalClose('run-recover-v1'), null)
    await manager.close()

    const replayed: string[] = []
    const reopened = new RunManager({
      projectRoot: root,
      onProjectionPlanReady: async ({ plan }) => { replayed.push(plan.planId) },
    })
    assert.equal((await reopened.getPersisted('run-recover-good'))?.status, 'interrupted')
    assert.deepEqual(replayed, [planId])
    assert.equal((await logs.page('run-recover-good'))?.entries.length, 2)
    await reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startup preserves durable completed and dismissed projection settlements', async () => {
  const root = await temporaryRoot('ggai-manager-recovery-v2-settled-')
  const logs = new RunLogStore(root)
  const artifacts = new RunArtifactStoreV2(root, 'main')
  const plans = projectionStore(root, 'main')
  try {
    await logs.start(runningTaskSummary('run-completed-close', 'task-completed-close', 'main'))
    const completedLocation = await artifacts.prepareRun('run-completed-close')
    await writeFile(
      path.join(completedLocation.absoluteFilesRoot, 'completed.txt'),
      'completed\n',
      'utf8',
    )
    const completedManifest = (await artifacts.closeRun(
      'run-completed-close',
      { complete: true },
    )).manifest
    const completedPlan = await plans.createPending({
      taskId: 'task-completed-close',
      runId: 'run-completed-close',
      runStatus: 'done',
      manifest: completedManifest,
      plugins: BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2,
    })
    await logs.append('run-completed-close', {
      id: 1,
      event: 'close',
      data: {
        runId: 'run-completed-close',
        status: 'done',
        sessionId: null,
        artifacts: [path.posix.join(
          completedLocation.projectRelativeFilesRoot,
          'completed.txt',
        )],
        artifactsComplete: true,
        artifactManifest: completedManifest,
        projectionPlan: completedPlan.plan,
        suggestedActions: completedPlan.suggestedActions,
      },
    })

    await logs.start(runningTaskSummary('run-dismissed-plan', 'task-dismissed-plan', 'main'))
    const dismissedLocation = await artifacts.prepareRun('run-dismissed-plan')
    await writeFile(path.join(dismissedLocation.absoluteFilesRoot, 'partial.R'), 'plot(1)\n', 'utf8')
    const dismissedManifest = (await artifacts.closeRun(
      'run-dismissed-plan',
      { complete: false },
    )).manifest
    const dismissedPlan = await plans.createPending({
      taskId: 'task-dismissed-plan',
      runId: 'run-dismissed-plan',
      runStatus: 'error',
      manifest: dismissedManifest,
      plugins: BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2,
    })
    await plans.dismiss(dismissedPlan.plan.planId)

    const materialized: string[] = []
    const manager = new RunManager({
      projectRoot: root,
      onProjectionPlanReady: async ({ plan }) => { materialized.push(plan.planId) },
    })
    await manager.listRunHistory('.')

    const reopenedPlans = projectionStore(root, 'main')
    const completedRecord = await reopenedPlans.get(completedPlan.plan.planId)
    assert.equal(completedRecord?.state, 'pending')
    assert.equal(completedRecord?.plan.status, 'complete')
    assert.equal(completedRecord?.plan.digest, completedPlan.plan.digest)
    assert.equal((await logs.page('run-completed-close'))?.entries.length, 1)
    assert.equal((await logs.terminalClose('run-completed-close'))?.status, 'done')

    const dismissedRecord = await reopenedPlans.get(dismissedPlan.plan.planId)
    assert.equal(dismissedRecord?.state, 'dismissed')
    assert.equal(dismissedRecord?.plan.digest, dismissedPlan.plan.digest)
    const dismissedClose = await logs.terminalClose('run-dismissed-plan')
    assert.equal(dismissedClose?.status, 'interrupted')
    assert.equal(dismissedClose?.projectionPlan, undefined)
    assert.deepEqual(materialized, [completedPlan.plan.planId])
    await manager.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('replayed startup materialization is idempotent and never revives Canvas entities', async () => {
  const root = await temporaryRoot('ggai-manager-recovery-v2-materialized-')
  const logs = new RunLogStore(root)
  const artifacts = new RunArtifactStoreV2(root, 'main')
  const canvases = new CanvasCommandStoreV2Manager({
    projectRoot: root,
    acquireProjectLease: async () => root,
  })
  try {
    await canvases.commit('.', 'main', 0, 'create-recovery-task', {
      type: 'CreateTask',
      task: {
        id: 'task-materialized',
        title: 'Recovered task',
        goal: 'Recover the partial output',
        anchor: { x: 100, y: 120 },
        origin: { kind: 'user' },
      },
    })
    await logs.start(runningTaskSummary('run-materialized', 'task-materialized', 'main'))
    const location = await artifacts.prepareRun('run-materialized')
    await writeFile(path.join(location.absoluteFilesRoot, 'partial.R'), 'plot(1:3)\n', 'utf8')

    let hookCalls = 0
    const onProjectionPlanReady = async (input: {
      plan: Parameters<typeof autoMaterializeProjectionPlanV2>[0]['plan']
      projectDir: string
      canvasBranch: string
    }) => {
      hookCalls += 1
      await autoMaterializeProjectionPlanV2({
        canvases,
        projectDir: input.projectDir,
        branch: input.canvasBranch,
        plan: input.plan,
      })
    }
    const firstManager = new RunManager({ projectRoot: root, onProjectionPlanReady })
    await firstManager.getPersisted('run-materialized')
    const firstCanvas = await canvases.get('.', 'main')
    assert.equal(firstCanvas.revision, 2)
    assert.equal(firstCanvas.document.nodes.length, 1)
    assert.equal(firstCanvas.document.receipts.length, 1)
    await firstManager.close()

    const reopened = new RunManager({ projectRoot: root, onProjectionPlanReady })
    await reopened.getPersisted('run-materialized')
    const replayedCanvas = await canvases.get('.', 'main')
    assert.equal(hookCalls, 2)
    assert.equal(replayedCanvas.revision, firstCanvas.revision)
    assert.deepEqual(replayedCanvas.document.nodes, firstCanvas.document.nodes)
    assert.deepEqual(replayedCanvas.document.receipts, firstCanvas.document.receipts)
    await reopened.close()
  } finally {
    canvases.close()
    await rm(root, { recursive: true, force: true })
  }
})

function runningTaskSummary(runId: string, taskId: string, canvasBranch: string) {
  return {
    runId,
    taskId,
    nodeId: taskId,
    agentId: 'codex',
    canvasBranch,
    status: 'running' as const,
    startedAt: 100,
    sessionId: null,
  }
}

function projectionStore(root: string, branch: string): ProjectionPlanStoreV2 {
  return new ProjectionPlanStoreV2(path.join(
    root,
    '.gg',
    'runtime',
    'projection-plans',
    `${canvasBranchStorageId(branch)}.json`,
  ))
}

async function temporaryRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
}
