import assert from 'node:assert/strict'
import test from 'node:test'
import { buildArtifactManifest } from '../artifactManifest.js'
import { inspectGraphMaterializationPlan } from '../graphPlan.js'
import { builtinNodeTypeSnapshots } from '../nodeTypeSnapshots.js'
import { buildProjectionPlan, inspectProjectionPlan } from '../projectionPlan.js'

const graphOutcome = {
  schemaVersion: 2,
  suggestedActions: [],
  outputs: [],
  taskProposals: [],
  graphProposal: {
    nodes: [
      { key: 'source', typeId: 'text', title: 'Source', init: { content: 'A' } },
      { key: 'result', typeId: 'text', title: 'Result', init: {} },
    ],
    edges: [{ fromKey: 'source', fromPort: 'content', toKey: 'result', toPort: 'content-in' }],
  },
}

test('successful RunOutcome pins a complete GraphMaterializationPlan', () => {
  const result = buildProjectionPlan({
    taskId: 'task-test', runId: 'run-test', runStatus: 'done',
    manifest: buildArtifactManifest({ runId: 'run-test', complete: true, files: [] }),
    plugins: [], outcome: graphOutcome,
    nodeTypes: builtinNodeTypeSnapshots(), taskAnchor: { x: 10, y: 20 },
    allowedRootIds: new Set<string>(),
  })
  assert.ok(result.plan.graphPlan)
  assert.equal(result.plan.graphPlan?.planId, result.plan.planId)
  assert.equal(inspectProjectionPlan(result.plan).status, 'valid')
  assert.equal(inspectGraphMaterializationPlan(result.plan.graphPlan).status, 'valid')
})

test('semantic graph failure is retained as a warning and never partially materialized', () => {
  const outcome = structuredClone(graphOutcome)
  outcome.graphProposal.nodes[0]!.typeId = 'unknown-type'
  const result = buildProjectionPlan({
    taskId: 'task-test', runId: 'run-invalid', runStatus: 'done',
    manifest: buildArtifactManifest({ runId: 'run-invalid', complete: true, files: [] }),
    plugins: [], outcome,
    nodeTypes: builtinNodeTypeSnapshots(), taskAnchor: { x: 0, y: 0 },
  })
  assert.equal(result.plan.graphPlan, undefined)
  assert.ok(result.plan.warnings.some((warning) => warning.includes('unknown node type')))
})

test('partial and failed runs discard the whole graph proposal', () => {
  const result = buildProjectionPlan({
    taskId: 'task-test', runId: 'run-error', runStatus: 'error',
    manifest: buildArtifactManifest({ runId: 'run-error', complete: false, files: [] }),
    plugins: [], outcome: graphOutcome,
    nodeTypes: builtinNodeTypeSnapshots(), taskAnchor: { x: 0, y: 0 },
  })
  assert.equal(result.plan.graphPlan, undefined)
  assert.equal(result.plan.status, 'partial')
})
