import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseCanvasCommandRequestV2,
  parseCanvasCommandWireV2,
} from '../canvasCommandProtocolV2.js'

const planId = `plan_${'a'.repeat(64)}`

function request(command: unknown): Record<string, unknown> {
  return {
    branch: 'main',
    baseRevision: 3,
    mutationId: 'mutation-1',
    command,
  }
}

test('strictly parses ordinary CanvasCommandV2 commands', () => {
  const created = parseCanvasCommandRequestV2(request({
    type: 'CreateTask',
    task: {
      id: 'task-1',
      title: 'Scatter plot',
      goal: 'Create a classic scatter plot',
      anchor: { x: 100, y: 120 },
      origin: { kind: 'user' },
    },
  }))
  assert.deepEqual(created, {
    branch: 'main',
    baseRevision: 3,
    mutationId: 'mutation-1',
    command: {
      type: 'CreateTask',
      task: {
        id: 'task-1',
        title: 'Scatter plot',
        goal: 'Create a classic scatter plot',
        anchor: { x: 100, y: 120 },
        origin: { kind: 'user' },
      },
    },
  })

  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'MoveEntities',
    entities: [
      { kind: 'task', id: 'task-1' },
      { kind: 'node', id: 'node-1' },
    ],
    collectionIds: ['collection-1'],
    dx: 20,
    dy: -10,
  }), {
    type: 'MoveEntities',
    entities: [
      { kind: 'task', id: 'task-1' },
      { kind: 'node', id: 'node-1' },
    ],
    collectionIds: ['collection-1'],
    dx: 20,
    dy: -10,
  })

  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'DuplicateTaskAsDraft',
    sourceTaskId: 'task-1',
    newTaskId: 'task-copy',
    offset: { x: 24, y: 36 },
    title: 'Scatter plot copy',
  }), {
    type: 'DuplicateTaskAsDraft',
    sourceTaskId: 'task-1',
    newTaskId: 'task-copy',
    offset: { x: 24, y: 36 },
    title: 'Scatter plot copy',
  })
})

test('parses bounded user node, edge, membership, and derived-task commands', () => {
  const node = {
    id: 'node-1',
    type: 'image',
    frame: { x: 20, y: 40, w: 320, h: 180, z: 1 },
    title: 'Empty image',
    artifactRefs: [],
    origin: { kind: 'user' },
  }
  assert.deepEqual(parseCanvasCommandWireV2({ type: 'CreateNode', node }), {
    type: 'CreateNode',
    node,
  })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'UpdateNodeContent',
    nodeId: 'node-1',
    patch: { title: 'Edited', text: null, payload: { count: 2 } },
  }), {
    type: 'UpdateNodeContent',
    nodeId: 'node-1',
    patch: { title: 'Edited', text: null, payload: { count: 2 } },
  })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'CreateEdges',
    edges: [{
      id: 'edge-source',
      from: { kind: 'node', id: 'node-1' },
      to: { kind: 'task', id: 'task-1' },
      relation: 'source',
      contextRole: 'full',
      origin: { kind: 'user' },
    }],
  }), {
    type: 'CreateEdges',
    edges: [{
      id: 'edge-source',
      from: { kind: 'node', id: 'node-1' },
      to: { kind: 'task', id: 'task-1' },
      relation: 'source',
      contextRole: 'full',
      origin: { kind: 'user' },
    }],
  })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'UpdateEdge',
    edgeId: 'edge-source',
    patch: { relation: 'modified', contextRole: 'summary' },
  }), {
    type: 'UpdateEdge',
    edgeId: 'edge-source',
    patch: { relation: 'modified', contextRole: 'summary' },
  })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'CreateDerivedTaskFromSelection',
    task: {
      id: 'task-derived',
      title: 'Adjust colors',
      goal: 'Adjust the plot colors',
      anchor: { x: 400, y: 200 },
      origin: { kind: 'user' },
    },
    sources: [{
      entity: { kind: 'node', id: 'node-1' },
      relation: 'modified',
      contextRole: 'full',
    }],
  }), {
    type: 'CreateDerivedTaskFromSelection',
    task: {
      id: 'task-derived',
      title: 'Adjust colors',
      goal: 'Adjust the plot colors',
      anchor: { x: 400, y: 200 },
      origin: { kind: 'user' },
    },
    sources: [{
      entity: { kind: 'node', id: 'node-1' },
      relation: 'modified',
      contextRole: 'full',
    }],
  })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'CreateTaskForOutputSlot',
    task: {
      id: 'task-slot',
      title: 'Generate image',
      goal: 'Generate an image',
      anchor: { x: 100, y: 100 },
      origin: { kind: 'user' },
    },
    nodeId: 'node-1',
  }).type, 'CreateTaskForOutputSlot')
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'ResizeNode',
    nodeId: 'node-1',
    w: 480,
    h: 320,
  }), { type: 'ResizeNode', nodeId: 'node-1', w: 480, h: 320 })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'RemoveFromCollection',
    collectionId: 'collection-1',
    members: [{ kind: 'node', id: 'node-1' }],
  }), {
    type: 'RemoveFromCollection',
    collectionId: 'collection-1',
    members: [{ kind: 'node', id: 'node-1' }],
  })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'DeleteTaskAndViews',
    taskId: 'task-1',
  }), { type: 'DeleteTaskAndViews', taskId: 'task-1' })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'DeleteCollectionAndContents',
    collectionId: 'collection-1',
  }), { type: 'DeleteCollectionAndContents', collectionId: 'collection-1' })
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'DuplicateCollection',
    sourceCollectionId: 'collection-1',
    newCollectionId: 'collection-copy',
    offset: { x: 72, y: 48 },
    title: 'Collection copy',
  }), {
    type: 'DuplicateCollection',
    sourceCollectionId: 'collection-1',
    newCollectionId: 'collection-copy',
    offset: { x: 72, y: 48 },
    title: 'Collection copy',
  })
})

test('plan operations remain opaque discriminated wire commands', () => {
  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'MaterializeProjectionPlan',
    planId,
  }), { type: 'MaterializeProjectionPlan', planId })

  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain', 'publish'],
    edits: {
      explain: { title: 'Explain the chart', dependsOn: ['publish'] },
      publish: { prompt: 'Prepare a concise publication-ready report.', dependsOn: [] },
    },
  }), {
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain', 'publish'],
    edits: {
      explain: { title: 'Explain the chart', dependsOn: ['publish'] },
      publish: { prompt: 'Prepare a concise publication-ready report.', dependsOn: [] },
    },
  })

  assert.deepEqual(parseCanvasCommandWireV2({
    type: 'DismissPlan',
    planId,
  }), { type: 'DismissPlan', planId })
})

test('rejects extra request and ordinary-command fields', () => {
  assert.throws(() => parseCanvasCommandRequestV2({
    ...request({ type: 'DeleteTask', taskId: 'task-1' }),
    projectDir: '/tmp/foreign',
  }), /invalid envelope/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'DeleteTask',
    taskId: 'task-1',
    payload: { hidden: true },
  }), /unsupported/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'CreateTask',
    task: {
      id: 'task-1',
      title: 'Injected task',
      goal: 'Do something',
      anchor: { x: 0, y: 0 },
      payload: { hidden: true },
      origin: { kind: 'user' },
    },
  }), /invalid/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'CreateTask',
    task: {
      id: 'task-1',
      title: 'Forged proposal',
      goal: 'Do something',
      anchor: { x: 0, y: 0 },
      origin: {
        kind: 'agent-proposal',
        parentTaskId: 'task-parent',
        planId,
        proposalKey: 'forged',
      },
    },
  }), /user-origin/u)
})

test('rejects forged plans, authority fields, coordinates, payloads, and edges on plan commands', () => {
  const forbiddenValues: Record<string, unknown> = {
    plan: { schemaVersion: 2 },
    runId: 'run-forged',
    taskId: 'task-forged',
    nodeId: 'node-forged',
    x: 100,
    y: 200,
    payload: { arbitrary: true },
    edges: [{ from: 'task', to: 'node' }],
  }
  for (const [field, value] of Object.entries(forbiddenValues)) {
    assert.throws(() => parseCanvasCommandWireV2({
      type: 'MaterializeProjectionPlan',
      planId,
      [field]: value,
    }), /unsupported/u)
    assert.throws(() => parseCanvasCommandWireV2({
      type: 'AcceptTaskProposals',
      planId,
      proposalKeys: ['explain'],
      [field]: value,
    }), /unsupported/u)
    assert.throws(() => parseCanvasCommandWireV2({
      type: 'DismissPlan',
      planId,
      [field]: value,
    }), /unsupported/u)
  }
})

test('rejects duplicate proposal keys and invalid edit maps', () => {
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain', 'explain'],
  }), /duplicate keys/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain'],
    edits: { publish: { title: 'Not selected' } },
  }), /not present in proposalKeys/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain'],
    edits: { explain: { title: 'Valid', taskId: 'forged-task' } },
  }), /unsupported/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain'],
    edits: { explain: {} },
  }), /must change/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain'],
    edits: { explain: { dependsOn: ['explain'] } },
  }), /cannot contain itself/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain', 'publish'],
    edits: { explain: { dependsOn: ['publish', 'publish'] } },
  }), /duplicate keys/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain'],
    edits: { explain: { dependsOn: ['publish'] } },
  }), /unselected proposal/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain'],
    edits: { explain: { dependsOn: 'publish' } },
  }), /dependsOn is invalid/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: Array.from({ length: 12 }, (_, index) => `proposal-${index}`),
    edits: {
      'proposal-0': {
        dependsOn: Array.from({ length: 13 }, (_, index) => `proposal-${index}`),
      },
    },
  }), /dependsOn is invalid/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain'],
    edits: { explain: { title: ' trailing ' } },
  }), /trimmed/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain'],
    edits: { explain: { prompt: 'x'.repeat(10_001) } },
  }), /prompt is invalid/u)
})

test('rejects malformed request identity, duplicate entities, and non-finite movement', () => {
  assert.throws(() => parseCanvasCommandRequestV2({
    ...request({ type: 'DeleteTask', taskId: 'task-1' }),
    branch: '../escape',
  }), /branch/u)
  assert.throws(() => parseCanvasCommandRequestV2({
    ...request({ type: 'DeleteTask', taskId: 'task-1' }),
    baseRevision: -1,
  }), /baseRevision/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'MoveEntities',
    entities: [
      { kind: 'node', id: 'node-1' },
      { kind: 'node', id: 'node-1' },
    ],
    dx: 1,
    dy: 1,
  }), /duplicate entity/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'MoveEntities',
    entities: [],
    dx: Number.POSITIVE_INFINITY,
    dy: 0,
  }), /finite/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'RemoveFromCollection',
    collectionId: 'collection-1',
    members: [],
  }), /non-empty/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'DuplicateCollection',
    sourceCollectionId: 'collection-1',
    newCollectionId: `cv2_collection_${'a'.repeat(32)}`,
    offset: { x: 1, y: 1 },
  }), /reserved/u)
})

test('rejects forged artifacts/origins, free patches, invalid topology, and reserved ids', () => {
  const baseNode = {
    id: 'node-1',
    type: 'image',
    frame: { x: 0, y: 0, w: 320, h: 180, z: 1 },
    title: 'Image',
    artifactRefs: [],
    origin: { kind: 'user' },
  }
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'CreateNode',
    node: {
      ...baseNode,
      artifactRefs: [{
        runId: 'run-1',
        artifactId: `artifact_${'a'.repeat(64)}`,
      }],
    },
  }), /artifactRefs/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'CreateNode',
    node: {
      ...baseNode,
      origin: {
        kind: 'agent-output',
        taskId: 'task-1',
        runId: 'run-1',
        planId,
        outputKey: 'preview',
      },
    },
  }), /user-origin/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'UpdateNodeContent',
    nodeId: 'node-1',
    patch: { artifactRefs: [] },
  }), /unsupported/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'CreateEdge',
    edge: {
      id: 'edge-forged',
      from: { kind: 'task', id: 'task-1' },
      to: { kind: 'node', id: 'node-1' },
      relation: 'produced',
      contextRole: 'full',
      origin: { kind: 'agent', runId: 'run-1', planId },
    },
  }), /user-origin/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'CreateEdge',
    edge: {
      id: 'edge-invalid',
      from: { kind: 'node', id: 'node-1' },
      to: { kind: 'task', id: 'task-1' },
      relation: 'produced',
      contextRole: 'full',
      origin: { kind: 'user' },
    },
  }), /produced edges/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'CreateNode',
    node: { ...baseNode, id: `cv2_node_${'a'.repeat(32)}` },
  }), /reserved/u)
  assert.throws(() => parseCanvasCommandWireV2({
    type: 'CreateDerivedTaskFromSelection',
    task: {
      id: 'task-derived',
      title: 'Invalid source',
      goal: '',
      anchor: { x: 0, y: 0 },
      origin: { kind: 'user' },
    },
    sources: [{
      entity: { kind: 'task', id: 'task-1' },
      relation: 'modified',
      contextRole: 'full',
    }],
  }), /requires a node/u)
})
