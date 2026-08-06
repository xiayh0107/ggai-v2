import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CanvasDocumentV2 } from '../../src/canvas-v2/model.js'
import {
  CanvasGitCodecV2Error,
  canvasGitEntityFileNameV2,
  decodeCanvasGitTreeV2,
  encodeCanvasGitTreeV2,
  readCanvasGitTreeV2,
  type CanvasGitCodecV2ErrorCode,
  type CanvasGitTreeEntryV2,
} from '../canvasGitCodecV2.js'

const OUTPUT_PLAN_ID = `plan_${'1'.repeat(64)}`
const PROPOSAL_PLAN_ID = `plan_${'2'.repeat(64)}`
const OUTPUT_ARTIFACT_A = `artifact_${'a'.repeat(64)}`
const OUTPUT_ARTIFACT_B = `artifact_${'b'.repeat(64)}`

function documentFixture(): CanvasDocumentV2 {
  return {
    schemaVersion: 2,
    tasks: [
      {
        id: 'task-b',
        title: 'Generate a chart',
        goal: 'Generate source and a chart',
        anchor: { x: 20, y: 30 },
        collectionId: 'collection-a',
        origin: { kind: 'user' },
      },
      {
        id: 'task-a',
        title: 'Refine the chart',
        goal: 'Use a clearer palette',
        anchor: { x: 500, y: 30 },
        origin: {
          kind: 'agent-proposal',
          parentTaskId: 'task-b',
          planId: PROPOSAL_PLAN_ID,
          proposalKey: 'refine',
        },
      },
    ],
    nodes: [
      {
        id: 'node-b',
        type: 'image',
        frame: { x: 40, y: 140, w: 360, h: 280, z: 2 },
        title: 'Chart',
        payload: {
          presentation: { caption: 'Vehicle weight versus economy' },
          orderedSeries: ['weight', 'economy'],
        },
        artifactRefs: [
          { runId: 'run-output', artifactId: OUTPUT_ARTIFACT_B },
          { runId: 'run-output', artifactId: OUTPUT_ARTIFACT_A },
        ],
        homeTaskId: 'task-b',
        origin: {
          kind: 'agent-output',
          taskId: 'task-b',
          runId: 'run-output',
          planId: OUTPUT_PLAN_ID,
          outputKey: 'chart',
        },
      },
      {
        id: 'node-a',
        type: 'text',
        frame: { x: -300, y: 40, w: 280, h: 180, z: 1 },
        title: 'Brief',
        text: 'Use the mtcars dataset',
        artifactRefs: [],
        collectionId: 'collection-a',
        origin: { kind: 'user' },
      },
    ],
    collections: [
      {
        id: 'collection-a',
        title: 'Scatter plot work',
        anchor: { x: -320, y: 0 },
      },
    ],
    edges: [
      {
        id: 'edge-b',
        from: { kind: 'task', id: 'task-b' },
        to: { kind: 'node', id: 'node-b' },
        relation: 'produced',
        contextRole: 'none',
        origin: { kind: 'agent', runId: 'run-output', planId: OUTPUT_PLAN_ID },
      },
      {
        id: 'edge-a',
        from: { kind: 'node', id: 'node-a' },
        to: { kind: 'task', id: 'task-b' },
        relation: 'source',
        contextRole: 'full',
        origin: { kind: 'user' },
      },
    ],
    receipts: [
      {
        kind: 'proposal-acceptance',
        planId: PROPOSAL_PLAN_ID,
        runId: 'run-proposal',
        taskId: 'task-b',
        proposals: [{ proposalKey: 'refine', taskId: 'task-a' }],
      },
      {
        kind: 'materialization',
        planId: OUTPUT_PLAN_ID,
        runId: 'run-output',
        taskId: 'task-b',
        outcomes: [{ outputKey: 'chart', nodeId: 'node-b' }],
        dismissedProposalKeys: ['supporting-table', 'export-pdf'],
      },
    ],
    everCreated: true,
  }
}

function expectCodecError(
  operation: () => unknown,
  code: CanvasGitCodecV2ErrorCode,
): CanvasGitCodecV2Error {
  let caught: unknown
  try {
    operation()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof CanvasGitCodecV2Error)
  assert.equal(caught.code, code)
  return caught
}

function replaceEntry(
  entries: readonly CanvasGitTreeEntryV2[],
  path: string,
  content: string,
): CanvasGitTreeEntryV2[] {
  return entries.map((entry) => entry.path === path ? { path, content } : entry)
}

function entryPath(entries: readonly CanvasGitTreeEntryV2[], prefix: string): string {
  const path = entries.find((entry) => entry.path.startsWith(prefix))?.path
  assert.ok(path)
  return path
}

test('encodes and reads a deterministic normalized Canvas V2 Git tree', () => {
  const document = documentFixture()
  const entries = encodeCanvasGitTreeV2(document)

  assert.deepEqual(
    entries.map((entry) => entry.path),
    [...entries.map((entry) => entry.path)].sort(),
  )
  assert.deepEqual(JSON.parse(entries.find((entry) => entry.path === 'meta.json')!.content), {
    everCreated: true,
    schemaVersion: 2,
  })
  assert.equal(entries.some((entry) => /(?:runs|runtime|artifacts|selection|session)/u.test(entry.path)), false)
  assert.ok(entries.every((entry) => entry.path === '.gitignore'
    || entry.path === 'meta.json'
    || /^(?:tasks|nodes|collections|edges|receipts)\/[a-z]+_[0-9a-f]{64}\.json$/u.test(entry.path)))

  const byPath = new Map(entries.map((entry) => [entry.path, entry.content]))
  const decoded = readCanvasGitTreeV2({
    paths: [...byPath.keys()].reverse(),
    read: (path) => byPath.get(path),
  })

  assert.deepEqual(decoded.tasks.map((task) => task.id), ['task-a', 'task-b'])
  assert.deepEqual(decoded.nodes.map((node) => node.id), ['node-a', 'node-b'])
  assert.deepEqual(decoded.edges.map((edge) => edge.id), ['edge-a', 'edge-b'])
  assert.deepEqual(
    decoded.nodes.find((node) => node.id === 'node-b')?.artifactRefs,
    [
      { runId: 'run-output', artifactId: OUTPUT_ARTIFACT_A },
      { runId: 'run-output', artifactId: OUTPUT_ARTIFACT_B },
    ],
  )
  assert.deepEqual(encodeCanvasGitTreeV2(decoded), entries)
})

test('represents an empty canvas with only the managed root files', () => {
  const document: CanvasDocumentV2 = {
    schemaVersion: 2,
    tasks: [],
    nodes: [],
    collections: [],
    edges: [],
    receipts: [],
    everCreated: false,
  }
  const entries = encodeCanvasGitTreeV2(document)
  assert.deepEqual(entries.map((entry) => entry.path), ['.gitignore', 'meta.json'])
  assert.deepEqual(decodeCanvasGitTreeV2(entries), document)
})

test('normalizes order-insensitive arrays without changing ordered payload arrays', () => {
  const original = documentFixture()
  const reordered = structuredClone(original)
  reordered.tasks.reverse()
  reordered.nodes.reverse()
  reordered.edges.reverse()
  reordered.receipts.reverse()
  reordered.nodes.find((node) => node.id === 'node-b')!.artifactRefs.reverse()
  const materialization = reordered.receipts.find((receipt) => receipt.kind === 'materialization')
  assert.ok(materialization?.kind === 'materialization')
  materialization.dismissedProposalKeys.reverse()

  assert.deepEqual(encodeCanvasGitTreeV2(reordered), encodeCanvasGitTreeV2(original))
  const nodeEntry = encodeCanvasGitTreeV2(reordered).find((entry) => {
    if (!entry.path.startsWith('nodes/')) return false
    return (JSON.parse(entry.content) as { id?: string }).id === 'node-b'
  })
  assert.ok(nodeEntry)
  const nodeValue = JSON.parse(nodeEntry!.content) as { id: string; payload?: { orderedSeries?: string[] } }
  assert.deepEqual(nodeValue.payload?.orderedSeries, ['weight', 'economy'])
})

test('uses receipt kind and plan ID together as the stable receipt identity', () => {
  const document = documentFixture()
  document.receipts.push({
    kind: 'plan-dismissal',
    planId: OUTPUT_PLAN_ID,
    runId: 'run-output',
    taskId: 'task-b',
    proposalKeys: ['later'],
  })

  const paths = encodeCanvasGitTreeV2(document).map((entry) => entry.path)
  assert.ok(paths.includes(
    `receipts/${canvasGitEntityFileNameV2('receipt', `materialization\0${OUTPUT_PLAN_ID}`)}`,
  ))
  assert.ok(paths.includes(
    `receipts/${canvasGitEntityFileNameV2('receipt', `plan-dismissal\0${OUTPUT_PLAN_ID}`)}`,
  ))
})

test('does not admit runtime, log, selection, session, or view state', () => {
  const withRuntime = documentFixture() as CanvasDocumentV2 & Record<string, unknown>
  withRuntime.runtime = { activeRunId: 'run-private', sseCursor: 42 }
  expectCodecError(() => encodeCanvasGitTreeV2(withRuntime), 'INVALID_DOCUMENT')

  const withNodePhase = documentFixture()
  Object.assign(withNodePhase.nodes[0]!, {
    phase: 'running',
    sessionId: 'session-private',
    log: ['private'],
  })
  expectCodecError(() => encodeCanvasGitTreeV2(withNodePhase), 'INVALID_DOCUMENT')
})

test('rejects unknown roots, nested paths, case aliases, and unreadable entries', () => {
  const entries = encodeCanvasGitTreeV2(documentFixture())
  const invalidPaths = [
    'runs/run_deadbeef.json',
    'nodes/archive/node_deadbeef.json',
    'Tasks/task_deadbeef.json',
    './meta.json',
    'nodes\\node_deadbeef.json',
  ]
  for (const path of invalidPaths) {
    expectCodecError(
      () => decodeCanvasGitTreeV2([...entries, { path, content: '{}\n' }]),
      'INVALID_TREE',
    )
  }

  expectCodecError(
    () => readCanvasGitTreeV2({ paths: ['.gitignore', 'meta.json'], read: () => undefined }),
    'INVALID_TREE',
  )
  let readCalled = false
  expectCodecError(
    () => readCanvasGitTreeV2({
      paths: ['../meta.json'],
      read: () => {
        readCalled = true
        return '{}\n'
      },
    }),
    'INVALID_TREE',
  )
  assert.equal(readCalled, false)
})

test('rejects malformed JSON, invalid metadata shape, and schema mismatches', () => {
  const entries = encodeCanvasGitTreeV2(documentFixture())
  const nodePath = entryPath(entries, 'nodes/')
  expectCodecError(
    () => decodeCanvasGitTreeV2(replaceEntry(entries, nodePath, '{broken\n')),
    'MALFORMED_JSON',
  )
  expectCodecError(
    () => decodeCanvasGitTreeV2(replaceEntry(
      entries,
      'meta.json',
      '{"schemaVersion":2,"everCreated":true,"activeRun":"run-private"}\n',
    )),
    'INVALID_TREE',
  )
  expectCodecError(
    () => decodeCanvasGitTreeV2(replaceEntry(
      entries,
      'meta.json',
      '{"schemaVersion":1,"everCreated":true}\n',
    )),
    'INVALID_TREE',
  )
})

test('rejects duplicate paths, identity tampering, and hash collision ambiguity', () => {
  const entries = encodeCanvasGitTreeV2(documentFixture())
  const nodePath = entryPath(entries, 'nodes/')
  const nodeEntry = entries.find((entry) => entry.path === nodePath)!

  expectCodecError(
    () => decodeCanvasGitTreeV2([...entries, { ...nodeEntry }]),
    'DUPLICATE_PATH',
  )

  const tampered = JSON.parse(nodeEntry.content) as Record<string, unknown>
  tampered.id = 'node-tampered'
  expectCodecError(
    () => decodeCanvasGitTreeV2(replaceEntry(
      entries,
      nodePath,
      `${JSON.stringify(tampered)}\n`,
    )),
    'HASH_MISMATCH',
  )

  assert.notEqual(
    canvasGitEntityFileNameV2('task', 'same-id'),
    canvasGitEntityFileNameV2('node', 'same-id'),
  )
})

test('rejects unsupported entity fields while decoding', () => {
  const entries = encodeCanvasGitTreeV2(documentFixture())
  const taskEntry = entries.find((entry) => entry.path.startsWith('tasks/'))!
  const task = JSON.parse(taskEntry.content) as Record<string, unknown>
  task.activeRunId = 'run-private'
  expectCodecError(
    () => decodeCanvasGitTreeV2(replaceEntry(
      entries,
      taskEntry.path,
      `${JSON.stringify(task)}\n`,
    )),
    'INVALID_DOCUMENT',
  )
})

test('runs full V2 semantic validation for dangling refs, cycles, and provenance', () => {
  const entries = encodeCanvasGitTreeV2(documentFixture())
  const edgePath = entryPath(entries, 'edges/')
  const edgeEntry = entries.find((entry) => entry.path === edgePath)!
  const danglingEdge = JSON.parse(edgeEntry.content) as Record<string, unknown>
  danglingEdge.to = { kind: 'node', id: 'missing-node' }
  expectCodecError(
    () => decodeCanvasGitTreeV2(replaceEntry(
      entries,
      edgePath,
      `${JSON.stringify(danglingEdge)}\n`,
    )),
    'INVALID_DOCUMENT',
  )

  const taskPath = entries.find((entry) => {
    if (!entry.path.startsWith('tasks/')) return false
    return (JSON.parse(entry.content) as { id?: string }).id === 'task-a'
  })!.path
  const task = JSON.parse(entries.find((entry) => entry.path === taskPath)!.content) as {
    origin: { parentTaskId: string }
  }
  task.origin.parentTaskId = 'task-a'
  expectCodecError(
    () => decodeCanvasGitTreeV2(replaceEntry(entries, taskPath, `${JSON.stringify(task)}\n`)),
    'INVALID_DOCUMENT',
  )

  const withoutMaterialization = entries.filter((entry) => {
    if (!entry.path.startsWith('receipts/')) return true
    const receipt = JSON.parse(entry.content) as { kind?: string }
    return receipt.kind !== 'materialization'
  })
  expectCodecError(() => decodeCanvasGitTreeV2(withoutMaterialization), 'INVALID_DOCUMENT')
})
