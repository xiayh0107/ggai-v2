import assert from 'node:assert/strict'
import test from 'node:test'
import type { GraphProposal } from '../../src/agent/graphProposal.js'
import { buildGraphMaterializationPlan, inspectGraphMaterializationPlan } from '../graphPlan.js'
import { builtinNodeTypeSnapshots } from '../nodeTypeSnapshots.js'
import { applyCanvasCommand } from '../../src/canvas/commands.js'
import { emptyCanvasDocument } from '../../src/canvas/model.js'
import { commitProjectionPlanCommand } from '../canvasProjectionCoordinator.js'
import { buildArtifactManifest } from '../artifactManifest.js'
import { buildProjectionPlan } from '../projectionPlan.js'

test('builds deterministic hierarchy, pinned types, typed edges, and daemon layout', () => {
  const proposal: GraphProposal = {
    nodes: [
      { key: 'group', typeId: 'group', title: 'Group', init: {} },
      { key: 'source', typeId: 'text', title: 'Source', parentKey: 'group', init: { content: 'A' } },
      { key: 'result', typeId: 'text', title: 'Result', parentKey: 'group', init: {} },
    ],
    edges: [{ fromKey: 'source', fromPort: 'content', toKey: 'result', toPort: 'content-in' }],
  }
  const input = {
    taskId: 'task-test', runId: 'run-test', taskAnchor: { x: 100, y: 200 }, proposal,
    nodeTypes: builtinNodeTypeSnapshots(), allowedRootIds: new Set<string>(),
  }
  const first = buildGraphMaterializationPlan(input)
  const second = buildGraphMaterializationPlan(input)
  assert.deepEqual(first, second)
  assert.equal(inspectGraphMaterializationPlan(first).status, 'valid')
  assert.equal(first.nodes[1]?.node.parentId, first.nodes[0]?.node.id)
  assert.equal(first.nodes[0]?.node.homeTaskId, 'task-test')
  assert.equal(first.nodes[1]?.node.homeTaskId, undefined)
  assert.deepEqual(first.edges[0]?.from, {
    kind: 'node', id: first.nodes[1]?.node.id, port: 'content',
  })
  assert.equal(first.nodeTypes.length, 2)
  assert.match(first.nodes[0]!.node.typeRef.digest, /^[0-9a-f]{64}$/u)
})

test('rejects parent cycles, data cycles, cardinality, schema mismatches, and unknown types', () => {
  const build = (proposal: GraphProposal) => buildGraphMaterializationPlan({
    taskId: 'task-test', runId: 'run-test', taskAnchor: { x: 0, y: 0 }, proposal,
    nodeTypes: builtinNodeTypeSnapshots(), allowedRootIds: new Set<string>(),
  })
  assert.throws(() => build({
    nodes: [
      { key: 'a', typeId: 'group', title: 'A', parentKey: 'b', init: {} },
      { key: 'b', typeId: 'group', title: 'B', parentKey: 'a', init: {} },
    ], edges: [],
  }), /cycle/u)
  assert.throws(() => build({
    nodes: [
      { key: 'a', typeId: 'text', title: 'A', init: {} },
      { key: 'b', typeId: 'text', title: 'B', init: {} },
    ],
    edges: [
      { fromKey: 'a', fromPort: 'content', toKey: 'b', toPort: 'content-in' },
      { fromKey: 'b', fromPort: 'content', toKey: 'a', toPort: 'content-in' },
    ],
  }), /cardinality|cycle/u)
  assert.throws(() => build({
    nodes: [
      { key: 'json', typeId: 'smart', title: 'JSON', init: {} },
      { key: 'text', typeId: 'text', title: 'Text', init: {} },
    ],
    edges: [{ fromKey: 'json', fromPort: 'result', toKey: 'text', toPort: 'content-in' }],
  }), /incompatible/u)
  assert.throws(() => build({
    nodes: [{ key: 'x', typeId: 'unknown', title: 'X', init: {} }], edges: [],
  }), /unknown/u)
  assert.throws(() => build({
    nodes: [{ key: 'x', typeId: 'text', title: 'X', init: { unexpected: true } }], edges: [],
  }), /does not match/u)
})

test('filesystem init requires an authorized opaque root handle', () => {
  const proposal: GraphProposal = {
    nodes: [{
      key: 'project', typeId: 'project', title: 'Project',
      init: { rootId: 'root_authorized', relativePath: '' },
    }],
    edges: [],
  }
  const base = {
    taskId: 'task-test', runId: 'run-test', taskAnchor: { x: 0, y: 0 }, proposal,
    nodeTypes: builtinNodeTypeSnapshots(),
  }
  assert.throws(() => buildGraphMaterializationPlan({
    ...base, allowedRootIds: new Set<string>(),
  }), /unauthorized/u)
  assert.doesNotThrow(() => buildGraphMaterializationPlan({
    ...base, allowedRootIds: new Set(['root_authorized']),
  }))
})

test('materializes the accepted graph in one atomic revision and replays by receipt', () => {
  const plan = buildGraphMaterializationPlan({
    taskId: 'task-test', runId: 'run-test', taskAnchor: { x: 20, y: 30 },
    proposal: {
      nodes: [
        { key: 'source', typeId: 'text', title: 'Source', init: { content: 'A' } },
        { key: 'result', typeId: 'text', title: 'Result', init: {} },
      ],
      edges: [{ fromKey: 'source', fromPort: 'content', toKey: 'result', toPort: 'content-in' }],
    },
    nodeTypes: builtinNodeTypeSnapshots(), allowedRootIds: new Set<string>(),
  })
  const document = emptyCanvasDocument()
  document.tasks.push({
    id: 'task-test', title: 'Task', goal: 'Goal', anchor: { x: 20, y: 30 },
    origin: { kind: 'user' },
  })
  const command = { type: 'MaterializeGraphPlan' as const, plan }
  const materialized = applyCanvasCommand(document, command)
  assert.equal(materialized.nodes.length, 2)
  assert.equal(materialized.edges.length, 1)
  assert.equal(materialized.receipts[0]?.kind, 'graph-materialization')
  assert.deepEqual(applyCanvasCommand(materialized, command), materialized)

  const forged = structuredClone(plan)
  forged.edges[0]!.to = { kind: 'node', id: 'missing', port: 'content-in' }
  assert.throws(() => applyCanvasCommand(document, {
    type: 'MaterializeGraphPlan', plan: forged,
  }), /outside|dangling|invalid/u)
  assert.equal(document.nodes.length, 0)
})

test('opaque graph acceptance resolves daemon plan once and SSE-style replay creates nothing twice', async () => {
  const projection = buildProjectionPlan({
    taskId: 'task-test', runId: 'run-test', runStatus: 'done',
    manifest: buildArtifactManifest({ runId: 'run-test', complete: true, files: [] }),
    plugins: [],
    outcome: {
      schemaVersion: 2, suggestedActions: [], outputs: [], taskProposals: [],
      graphProposal: {
        nodes: [{ key: 'result', typeId: 'text', title: 'Result', init: {} }], edges: [],
      },
    },
    nodeTypes: builtinNodeTypeSnapshots(), taskAnchor: { x: 0, y: 0 },
  }).plan
  let document = emptyCanvasDocument()
  document.tasks.push({
    id: 'task-test', title: 'Task', goal: 'Goal', anchor: { x: 0, y: 0 },
    origin: { kind: 'user' },
  })
  let revision = 0
  const canvases = {
    get: async () => ({
      branch: 'main', revision, updatedAt: '', lastMutationId: null, lastCheckpoint: null, document,
    }),
    commit: async (_project: string, _branch: string, baseRevision: number, _mutation: string, command: Parameters<typeof applyCanvasCommand>[1]) => {
      assert.equal(baseRevision, revision)
      document = applyCanvasCommand(document, command)
      revision += 1
      return { branch: 'main', revision, updatedAt: '', lastMutationId: null, lastCheckpoint: null, document }
    },
    commitLatest: async (_project: string, _branch: string, _mutation: string, command: Parameters<typeof applyCanvasCommand>[1]) => {
      document = applyCanvasCommand(document, command)
      revision += 1
      return { branch: 'main', revision, updatedAt: '', lastMutationId: null, lastCheckpoint: null, document }
    },
  }
  const plans = {
    getProjectionPlanRecord: async () => ({
      plan: projection, suggestedActions: [], state: 'pending' as const,
    }),
    dismissProjectionPlan: async () => true,
  }
  await commitProjectionPlanCommand({
    canvases, plans, projectDir: '.', branch: 'main', baseRevision: 0,
    mutationId: 'accept-graph', command: { type: 'MaterializeGraphPlan', planId: projection.planId },
  })
  const replay = await commitProjectionPlanCommand({
    canvases, plans, projectDir: '.', branch: 'main', baseRevision: 0,
    mutationId: 'replay-graph', command: { type: 'MaterializeGraphPlan', planId: projection.planId },
  })
  assert.equal(replay.revision, 1)
  assert.equal(document.nodes.length, 1)
  assert.equal(document.receipts.filter((receipt) => receipt.kind === 'graph-materialization').length, 1)
})
