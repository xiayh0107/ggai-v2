import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_RUN_INTENT_ATTACHMENTS,
  MAX_RUN_INTENT_BRANCH_LENGTH,
  MAX_RUN_INTENT_ID_LENGTH,
  MAX_RUN_INTENT_PROMPT_LENGTH,
  parseAttachmentRef,
  parseRunIntent,
  TaskRunProtocolError,
} from '../taskRunProtocol.js'

const artifactId = `artifact_${'a'.repeat(64)}`

function intent(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    runId: 'run_019abc',
    taskId: 'task_1',
    agentId: 'acpx:codex',
    canvasBranch: 'feature/rich-nodes',
    baseRevision: 7,
    prompt: 'Create a scatter plot.',
    attachments: [
      { kind: 'artifact', runId: 'run_source', artifactId },
      { kind: 'node', nodeId: 'node_source' },
    ],
    materializationPolicy: 'auto',
  }
}

test('parses the exact Run intent and preserves only controlled attachment references', () => {
  const source = intent()
  const parsed = parseRunIntent(source)
  assert.deepEqual(parsed, source)
  assert.notEqual(parsed.attachments, source.attachments)
  assert.deepEqual(parseRunIntent({ ...source, prompt: '', attachments: [] }), {
    ...source,
    prompt: '',
    attachments: [],
  })
})

test('requires every exact top-level field, especially a client-generated runId', () => {
  for (const key of Object.keys(intent())) {
    const candidate = intent()
    delete candidate[key]
    assert.throws(
      () => parseRunIntent(candidate),
      TaskRunProtocolError,
      `missing ${key} must fail`,
    )
  }
  assert.throws(
    () => parseRunIntent({ ...intent(), runId: '' }),
    /runId is invalid/u,
  )
  assert.throws(
    () => parseRunIntent({ ...intent(), runId: '../escape' }),
    /runId is invalid/u,
  )
})

test('rejects archived authority and arbitrary canvas mutation fields', () => {
  for (const forbidden of [
    'projectDir',
    'canvasSnapshot',
    'sessionId',
    'nodeId',
    'x',
    'y',
    'payload',
    'edges',
    'commands',
  ]) {
    assert.throws(
      () => parseRunIntent({ ...intent(), [forbidden]: {} }),
      /exact supported fields/u,
      `${forbidden} must fail closed`,
    )
  }
})

test('bounds scalar fields and accepts only the auto materialization policy', () => {
  assert.throws(() => parseRunIntent({ ...intent(), schemaVersion: 1 }), /schemaVersion/u)
  assert.throws(() => parseRunIntent({
    ...intent(),
    materializationPolicy: 'manual',
  }), /materializationPolicy/u)
  for (const baseRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(() => parseRunIntent({ ...intent(), baseRevision }), /baseRevision/u)
  }
  assert.equal(parseRunIntent({
    ...intent(),
    prompt: 'p'.repeat(MAX_RUN_INTENT_PROMPT_LENGTH),
  }).prompt.length, MAX_RUN_INTENT_PROMPT_LENGTH)
  assert.throws(() => parseRunIntent({
    ...intent(),
    prompt: 'p'.repeat(MAX_RUN_INTENT_PROMPT_LENGTH + 1),
  }), /prompt/u)
  assert.throws(() => parseRunIntent({ ...intent(), prompt: null }), /prompt/u)
})

test('strictly validates identifiers and logical branch labels', () => {
  for (const field of ['runId', 'taskId', 'agentId'] as const) {
    assert.equal(parseRunIntent({
      ...intent(),
      [field]: 'a'.repeat(MAX_RUN_INTENT_ID_LENGTH),
    })[field].length, MAX_RUN_INTENT_ID_LENGTH)
    for (const invalid of [
      'a'.repeat(MAX_RUN_INTENT_ID_LENGTH + 1),
      '--option',
      'nested/id',
      'two..dots',
      'white space',
    ]) {
      assert.throws(() => parseRunIntent({ ...intent(), [field]: invalid }), /invalid/u)
    }
  }
  assert.equal(parseRunIntent({
    ...intent(),
    canvasBranch: 'b'.repeat(MAX_RUN_INTENT_BRANCH_LENGTH),
  }).canvasBranch.length, MAX_RUN_INTENT_BRANCH_LENGTH)
  for (const canvasBranch of [
    '../escape',
    'feature//bad',
    'feature/',
    'feature.',
    'feature.lock',
    'a'.repeat(MAX_RUN_INTENT_BRANCH_LENGTH + 1),
  ]) {
    assert.throws(() => parseRunIntent({ ...intent(), canvasBranch }), /canvasBranch/u)
  }
})

test('accepts only exact artifact or node attachment records', () => {
  assert.deepEqual(parseAttachmentRef({
    kind: 'artifact',
    runId: 'run_source',
    artifactId,
  }), {
    kind: 'artifact',
    runId: 'run_source',
    artifactId,
  })
  assert.deepEqual(parseAttachmentRef({ kind: 'node', nodeId: 'node_source' }), {
    kind: 'node',
    nodeId: 'node_source',
  })

  for (const attachment of [
    { kind: 'artifact', runId: 'run_source', artifactId, path: '/tmp/file' },
    { kind: 'artifact', runId: 'run_source', artifactId, nodeId: 'node_source' },
    { kind: 'artifact', runId: 'run_source', artifactId: 'result.png' },
    { kind: 'artifact', runId: '../bad', artifactId },
    { kind: 'node', nodeId: 'node_source', payload: {} },
    { kind: 'node', nodeId: '../bad' },
    { kind: 'file', path: 'result.png' },
    { kind: 'node' },
  ]) {
    assert.throws(() => parseAttachmentRef(attachment), TaskRunProtocolError)
  }
})

test('bounds and deduplicates attachments', () => {
  assert.doesNotThrow(() => parseRunIntent({
    ...intent(),
    attachments: Array.from({ length: MAX_RUN_INTENT_ATTACHMENTS }, (_, index) => ({
      kind: 'node',
      nodeId: `node_${index}`,
    })),
  }))
  assert.throws(() => parseRunIntent({
    ...intent(),
    attachments: Array.from({ length: MAX_RUN_INTENT_ATTACHMENTS + 1 }, (_, index) => ({
      kind: 'node',
      nodeId: `node_${index}`,
    })),
  }), /attachments is invalid/u)
  assert.throws(() => parseRunIntent({
    ...intent(),
    attachments: [
      { kind: 'artifact', runId: 'run_source', artifactId },
      { kind: 'artifact', runId: 'run_source', artifactId },
    ],
  }), /duplicates/u)
})
