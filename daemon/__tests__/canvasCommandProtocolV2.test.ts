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
      explain: { title: 'Explain the chart' },
      publish: { prompt: 'Prepare a concise publication-ready report.' },
    },
  }), {
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys: ['explain', 'publish'],
    edits: {
      explain: { title: 'Explain the chart' },
      publish: { prompt: 'Prepare a concise publication-ready report.' },
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
})
