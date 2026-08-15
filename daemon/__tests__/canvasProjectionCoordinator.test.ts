import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  autoMaterializeProjectionPlan,
  commitProjectionPlanCommand,
  ProjectionPlanUnavailableError,
  type ProjectionPlanRecordLookup,
} from '../canvasProjectionCoordinator.js'
import { CanvasCommandStoreManager } from '../canvasCommandStoreManager.js'
import type { ProjectionPlan } from '../projectionPlan.js'

const temporaryDirectories: string[] = []
const PLAN_ID = `plan_${'a'.repeat(64)}`

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-plan-coordinator-'))
  temporaryDirectories.push(root)
  const canvases = new CanvasCommandStoreManager({
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

function plan(): ProjectionPlan {
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
    taskProposals: [
      {
        key: 'explain',
        title: 'Explain findings',
        prompt: 'Explain the relationship',
        inputOutputKeys: ['preview'],
        dependsOn: [],
      },
      {
        key: 'publish',
        title: 'Publish report',
        prompt: 'Publish the chart and explanation',
        inputOutputKeys: ['source'],
        dependsOn: ['explain'],
      },
    ],
    warnings: [],
    digest: 'f'.repeat(64),
  }
}

function registry(initialPlan = plan()) {
  let record: ProjectionPlanRecordLookup = {
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
  const first = await autoMaterializeProjectionPlan({
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

  const replay = await autoMaterializeProjectionPlan({
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
  const afterDeleteReplay = await autoMaterializeProjectionPlan({
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
  await autoMaterializeProjectionPlan({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plans.record.plan,
  })

  const accepted = await commitProjectionPlanCommand({
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
  assert.deepEqual(accepted.document.receipts.slice(1).map((receipt) => receipt.kind), [
    'proposal-acceptance',
    'plan-dismissal',
  ])
  assert.deepEqual(accepted.document.receipts[2], {
    kind: 'plan-dismissal',
    planId: PLAN_ID,
    runId: 'run-1',
    taskId: 'task-1',
    proposalKeys: ['publish'],
  })
  assert.equal(plans.record.plan.taskProposals[0]?.title, 'Explain findings')
  assert.equal(plans.record.state, 'dismissed')
  assert.equal(plans.dismissCount, 1)

  const replay = await commitProjectionPlanCommand({
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

test('accepting an opaque proposal atomically materializes its auxiliary input', async () => {
  const { canvases } = await fixture()
  const trustedPlan = plan()
  trustedPlan.outputs[2]!.derivedFrom = ['preview']
  trustedPlan.taskProposals = [{
    key: 'inspect-notes',
    title: 'Inspect notes',
    prompt: 'Inspect the auxiliary notes',
    inputOutputKeys: ['notes'],
    dependsOn: [],
  }]
  const plans = registry(trustedPlan)
  const materialized = await autoMaterializeProjectionPlan({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plans.record.plan,
  })
  assert.equal(materialized.revision, 2)
  assert.equal(materialized.document.nodes.length, 2)

  const accepted = await commitProjectionPlanCommand({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 2,
    mutationId: 'accept-auxiliary-input',
    command: {
      type: 'AcceptTaskProposals',
      planId: PLAN_ID,
      proposalKeys: ['inspect-notes'],
    },
  })

  assert.equal(accepted.revision, 3)
  const input = accepted.document.nodes.find((node) =>
    node.origin.kind === 'agent-output' && node.origin.outputKey === 'notes')
  assert.ok(input)
  const proposal = accepted.document.tasks.find((task) =>
    task.origin.kind === 'agent-proposal' && task.origin.proposalKey === 'inspect-notes')
  assert.ok(proposal)
  assert.deepEqual(accepted.document.edges.find((edge) =>
    edge.relation === 'produced' && edge.to.id === input.id), {
    id: accepted.document.edges.find((edge) =>
      edge.relation === 'produced' && edge.to.id === input.id)?.id,
    from: { kind: 'task', id: 'task-1' },
    to: { kind: 'node', id: input.id },
    relation: 'produced',
    contextRole: 'none',
    origin: { kind: 'agent', runId: 'run-1', planId: PLAN_ID },
  })
  assert.deepEqual(accepted.document.edges.find((edge) =>
    edge.relation === 'derived' && edge.to.id === input.id)?.from, {
    kind: 'node',
    id: materialized.document.nodes[1]?.id,
  })
  assert.deepEqual(accepted.document.edges.find((edge) =>
    edge.relation === 'source' && edge.to.id === proposal.id)?.from, {
    kind: 'node',
    id: input.id,
  })
  const receipt = accepted.document.receipts.find((entry) => entry.kind === 'materialization')
  assert.deepEqual(receipt?.outcomes.map((outcome) => outcome.outputKey), [
    'source',
    'preview',
    'notes',
  ])
  assert.equal(plans.record.state, 'dismissed')
})

test('keeps canvas and plan pending when a proposal input lineage is unresolved', async () => {
  const { canvases } = await fixture()
  const trustedPlan = plan()
  trustedPlan.outputs[2]!.derivedFrom = ['missing-parent']
  trustedPlan.taskProposals = [{
    key: 'inspect-notes',
    title: 'Inspect notes',
    prompt: 'Inspect the auxiliary notes',
    inputOutputKeys: ['notes'],
    dependsOn: [],
  }]
  const plans = registry(trustedPlan)
  await autoMaterializeProjectionPlan({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plans.record.plan,
  })

  await assert.rejects(commitProjectionPlanCommand({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 2,
    mutationId: 'reject-unresolved-input-lineage',
    command: {
      type: 'AcceptTaskProposals',
      planId: PLAN_ID,
      proposalKeys: ['inspect-notes'],
    },
  }), /derives from missing output/u)

  const current = await canvases.get('.', 'main')
  assert.equal(current.revision, 2)
  assert.equal(current.document.nodes.length, 2)
  assert.equal(current.document.tasks.length, 1)
  assert.deepEqual(current.document.receipts.map((receipt) => receipt.kind), ['materialization'])
  assert.equal(plans.record.state, 'pending')
  assert.equal(plans.dismissCount, 0)
})

test('delegates reordered content and dependency edits to the atomic canvas reducer', async () => {
  const { canvases } = await fixture()
  const plans = registry()
  await autoMaterializeProjectionPlan({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plans.record.plan,
  })

  const accepted = await commitProjectionPlanCommand({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 2,
    mutationId: 'accept-reordered-proposals',
    command: {
      type: 'AcceptTaskProposals',
      planId: PLAN_ID,
      proposalKeys: ['publish', 'explain'],
      edits: {
        publish: {
          title: 'Publish final report',
          prompt: 'Publish a concise final report',
          dependsOn: [],
        },
        explain: { dependsOn: ['publish'] },
      },
    },
  })

  const created = accepted.document.tasks.slice(1)
  assert.deepEqual(created.map((task) => task.origin.kind === 'agent-proposal'
    ? task.origin.proposalKey
    : null), ['publish', 'explain'])
  assert.deepEqual(created.map((task) => task.anchor.y), [216, 328])
  assert.equal(created[0]?.title, 'Publish final report')
  assert.equal(created[0]?.goal, 'Publish a concise final report')
  assert.deepEqual(Object.keys(created[0] ?? {}).sort(), [
    'anchor',
    'goal',
    'id',
    'origin',
    'title',
  ])
  assert.deepEqual(accepted.document.edges.find((edge) => edge.relation === 'depends-on'), {
    id: accepted.document.edges.find((edge) => edge.relation === 'depends-on')?.id,
    from: { kind: 'task', id: created[0]?.id },
    to: { kind: 'task', id: created[1]?.id },
    relation: 'depends-on',
    contextRole: 'summary',
    origin: { kind: 'agent', runId: 'run-1', planId: PLAN_ID },
  })
  assert.deepEqual(accepted.document.receipts.map((receipt) => receipt.kind), [
    'materialization',
    'proposal-acceptance',
  ])
  assert.deepEqual(plans.record.plan.taskProposals.map((proposal) => proposal.dependsOn), [
    [],
    ['explain'],
  ])
  assert.equal(plans.record.state, 'dismissed')
})

test('keeps canvas and plan lifecycle unchanged when edited dependencies form a cycle', async () => {
  const { canvases } = await fixture()
  const plans = registry()
  await autoMaterializeProjectionPlan({
    canvases,
    projectDir: '.',
    branch: 'main',
    plan: plans.record.plan,
  })

  await assert.rejects(commitProjectionPlanCommand({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 2,
    mutationId: 'reject-proposal-cycle',
    command: {
      type: 'AcceptTaskProposals',
      planId: PLAN_ID,
      proposalKeys: ['explain', 'publish'],
      edits: {
        explain: { dependsOn: ['publish'] },
        publish: { dependsOn: ['explain'] },
      },
    },
  }), /must form a DAG/u)

  const current = await canvases.get('.', 'main')
  assert.equal(current.revision, 2)
  assert.equal(current.document.tasks.length, 1)
  assert.deepEqual(current.document.receipts.map((receipt) => receipt.kind), ['materialization'])
  assert.equal(plans.record.state, 'pending')
  assert.equal(plans.dismissCount, 0)
})

test('rejects missing and settled plans without accepting browser-authored content', async () => {
  const { canvases } = await fixture()
  const plans = registry()

  await assert.rejects(commitProjectionPlanCommand({
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
    error instanceof ProjectionPlanUnavailableError && error.reason === 'missing')

  await plans.dismissProjectionPlan(PLAN_ID)
  await assert.rejects(commitProjectionPlanCommand({
    canvases,
    plans,
    projectDir: '.',
    branch: 'main',
    baseRevision: 1,
    mutationId: 'settled-plan',
    command: { type: 'MaterializeProjectionPlan', planId: PLAN_ID },
  }), (error: unknown) =>
    error instanceof ProjectionPlanUnavailableError && error.reason === 'settled')
})
