import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CANVAS_BRANCH_LENGTH,
  parseCanvasBranch,
  parseCreateRunRequest,
  ProtocolError,
} from '../protocol.js'

function body(): Record<string, unknown> {
  return {
    nodeId: 'node_1',
    agentId: 'acpx:codex',
    prompt: 'Generate output',
    projectDir: '.',
    canvasSnapshot: {
      nodes: [{ id: 'node_1', type: 'text', title: 'Text', payload: {} }],
      edges: [],
      plugins: [{ id: '@author/text', label: 'Text', description: '' }],
    },
  }
}

test('accepts namespaced plugins while rejecting path-like node identifiers', () => {
  assert.equal(parseCreateRunRequest(body()).canvasSnapshot.plugins?.[0]?.id, '@author/text')

  const invalid = body()
  invalid.nodeId = 'nested/node'
  const snapshot = invalid.canvasSnapshot as { nodes: Array<Record<string, unknown>> }
  snapshot.nodes[0] = { ...snapshot.nodes[0], id: 'nested/node' }
  assert.throws(() => parseCreateRunRequest(invalid), ProtocolError)
})

test('rejects untrusted source ids and dangling graph edges before packer path use', () => {
  const traversal = body()
  const traversalSnapshot = traversal.canvasSnapshot as { nodes: Array<Record<string, unknown>> }
  traversalSnapshot.nodes.push({ id: '../../outside', type: 'text', title: 'Bad' })
  assert.throws(() => parseCreateRunRequest(traversal), ProtocolError)

  const dangling = body()
  const danglingSnapshot = dangling.canvasSnapshot as { edges: Array<Record<string, unknown>> }
  danglingSnapshot.edges.push({ from: 'missing', to: 'node_1', label: 'source' })
  assert.throws(() => parseCreateRunRequest(dangling), /missing node/)
})

test('accepts a safe client run id and rejects option-like session ids', () => {
  const request = body()
  request.runId = 'run_019abc'
  assert.equal(parseCreateRunRequest(request).runId, 'run_019abc')

  const unsafeSession = body()
  unsafeSession.sessionId = '--dangerous-option'
  assert.throws(() => parseCreateRunRequest(unsafeSession), /unsupported characters/)

  const unsafeRun = body()
  unsafeRun.runId = '../outside'
  assert.throws(() => parseCreateRunRequest(unsafeRun), /unsupported characters/)
})

test('accepts optional canvas branch and automation mode while validating both', () => {
  const parsed = parseCreateRunRequest({
    ...body(),
    canvasBranch: 'feature/persist-runs',
    automationMode: 'confirm',
  })
  assert.equal(parsed.canvasBranch, 'feature/persist-runs')
  assert.equal(parsed.automationMode, 'confirm')

  assert.throws(
    () => parseCreateRunRequest({ ...body(), canvasBranch: '../escape' }),
    /branch contains unsupported characters/u,
  )
  assert.throws(
    () => parseCreateRunRequest({ ...body(), automationMode: 'unsafe' }),
    /automationMode/u,
  )
  assert.equal(
    parseCanvasBranch('b'.repeat(MAX_CANVAS_BRANCH_LENGTH)),
    'b'.repeat(MAX_CANVAS_BRANCH_LENGTH),
  )
  assert.throws(
    () => parseCanvasBranch('b'.repeat(MAX_CANVAS_BRANCH_LENGTH + 1)),
    /branch is too long/u,
  )
})

test('bounds attachment and plugin instruction collections', () => {
  const attachments = body()
  const snapshot = attachments.canvasSnapshot as { nodes: Array<Record<string, unknown>> }
  snapshot.nodes[0] = {
    ...snapshot.nodes[0],
    instruction: { attachments: Array.from({ length: 101 }, () => 'file.txt') },
  }
  assert.throws(() => parseCreateRunRequest(attachments), /attachments is invalid/)

  const actions = body()
  const actionSnapshot = actions.canvasSnapshot as { plugins: Array<Record<string, unknown>> }
  actionSnapshot.plugins[0] = {
    ...actionSnapshot.plugins[0],
    instruction: { placeholder: '', actions: Array.from({ length: 101 }, () => 'do') },
  }
  assert.throws(() => parseCreateRunRequest(actions), /too many actions/)
})
