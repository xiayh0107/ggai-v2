import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  autoMaterializeProjectionPlanV2,
  commitProjectionPlanCommandV2,
  ProjectionPlanUnavailableV2Error,
  type ProjectionPlanRecordLookupV2,
} from '../canvasProjectionCoordinatorV2.js'
import { CanvasCommandStoreV2Manager } from '../canvasCommandStoreV2Manager.js'
import type { ProjectionPlanV2 } from '../projectionPlanV2.js'

const temporaryDirectories: string[] = []
const PLAN_ID = `plan_${'a'.repeat(64)}`

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-plan-coordinator-'))
  temporaryDirectories.push(root)
  const canvases = new CanvasCommandStoreV2Manager({
    projectRoot: root,
    acquireProjectLease: async (projectDir) => path.resolve(root, projectDir),
  })
  await canvases.commit('.', 'main', 0, 'create-task', {
    type: 'CreateTask',
    task: {
      id: 'task-1',
      title: 'Scatter plot',
      goal: 'Create a scatter plot',
      anchor: { x: 100, y: 120 },
      origin: { kind: 'user' },
    },
  })
  return { canvases }
}

function plan(): ProjectionPlanV2 {
  return {
    schemaVersion: 2,
    planId: PLAN_ID,
    runId: 'run-1',
    taskId: 'task-1',
    status: 'complete',
    manifestDigest: 'b'.repeat(64),
    outputs: [
      {
        key: 'source',
        pluginId: 'code',
        role: 'primary',
        title: 'R source',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'c'.repeat(64)}`,
        }],
        derivedFrom: [],
        materialize: true,
      },
      {
        key: 'preview',
        pluginId: 'image',
        role: 'supporting',
        title: 'Scatter plot preview',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'d'.repeat(64)}`,
        }],
        derivedFrom: ['source'],
        materialize: true,
      },
      {
        key: 'notes',
        pluginId: 'file',
        role: 'auxiliary',
        title: 'Notes',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'e'.repeat(64)}`,
        }],
        derivedFrom: [],
        materialize: false,
      },
    ],
    taskProposals: [{
      key: 'explain',
      title: 'Explain findings',
      prompt: 'Explain the relationship',
      inputOutputKeys: ['preview'],
      dependsOn: [],
    }],
    warnings: [],
    digest: 'f'.repeat(64),
  }
}

function registry(initialPlan = plan()) {
  let record: ProjectionPlanRecordLookupV2 = {
    state: 'pending',
    plan: initialPlan,
    suggestedActions: [],
  }
  let dismissCount = 0
  return {
    async getProjectionPlanRecord(planId: string) {
      return planId === record.plan.planId ? structuredClone(record) : null
    },
    async dismissProjectionPlan(planId: string) {
      if (planId !== record.plan.planId) return false
      dismissCount += 1
      record = { ...record, state: 'dismissed' }
      return true
    },
    get record() {
      return record
    },
    get dismissCount() {
      return dismissCount
    },
  }
}

test('auto-materializes the latest revision once and preserves auxiliary tray outputs', async () => {
  const { canvases } = await fixture()
  const first = await autoMaterializeProjectionPlanV2({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plan(),
  })

  assert.equal(first.revision, 2)
  assert.deepEqual(first.document.nodes.map((node) => node.type), ['code', 'image'])
  assert.equal(first.document.edges.filter((edge) => edge.relation === 'produced').length, 2)
  assert.equal(first.document.edges.filter((edge) => edge.relation === 'derived').length, 1)
  assert.equal(first.document.receipts[0]?.kind, 'materialization')

  const replay = await autoMaterializeProjectionPlanV2({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plan(),
  })
  assert.equal(replay.revision, 2)
  assert.equal(replay.document.nodes.length, 2)

  const deleted = await canvases.commit('.', 'main', 2, 'delete-preview', {
    type: 'DeleteNode',
    nodeId: first.document.nodes[1]!.id,
  })
  const afterDeleteReplay = await autoMaterializeProjectionPlanV2({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plan(),
  })
  assert.equal(afterDeleteReplay.revision, deleted.revision)
  assert.equal(afterDeleteReplay.document.nodes.length, 1)
})

test('resolves proposal edits from an opaque plan and repairs lifecycle on replay', async () => {
  const { canvases } = await fixture()
  const plans = registry()
  await autoMaterializeProjectionPlanV2({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plans.record.plan,
  })

  const accepted = await commitProjectionPlanCommandV2({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 2,
    mutationId: 'accept-proposal',
    command: {
      type: 'AcceptTaskProposals',
      planId: PLAN_ID,
      proposalKeys: ['explain'],
      edits: {
        explain: {
          title: 'Explain the chart clearly',
          prompt: 'Explain the chart in plain language',
        },
      },
    },
  })

  assert.equal(accepted.revision, 3)
  assert.equal(accepted.document.tasks[1]?.title, 'Explain the chart clearly')
  assert.equal(accepted.document.tasks[1]?.goal, 'Explain the chart in plain language')
  assert.equal(plans.record.state, 'dismissed')
  assert.equal(plans.dismissCount, 1)

  const replay = await commitProjectionPlanCommandV2({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 2,
    mutationId: 'accept-proposal',
    command: {
      type: 'AcceptTaskProposals',
      planId: PLAN_ID,
      proposalKeys: ['explain'],
    },
  })
  assert.equal(replay.revision, 3)
  assert.equal(replay.document.tasks.length, 2)
  assert.equal(plans.dismissCount, 1)
})

test('rejects missing and settled plans without accepting browser-authored content', async () => {
  const { canvases } = await fixture()
  const plans = registry()

  await assert.rejects(commitProjectionPlanCommandV2({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 1,
    mutationId: 'missing-plan',
    command: {
      type: 'MaterializeProjectionPlan',
      planId: `plan_${'0'.repeat(64)}`,
    },
  }), (error: unknown) =>
    error instanceof ProjectionPlanUnavailableV2Error && error.reason === 'missing')

  await plans.dismissProjectionPlan(PLAN_ID)
  await assert.rejects(commitProjectionPlanCommandV2({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 1,
    mutationId: 'settled-plan',
    command: { type: 'MaterializeProjectionPlan', planId: PLAN_ID },
  }), (error: unknown) =>
    error instanceof ProjectionPlanUnavailableV2Error && error.reason === 'settled')
})
