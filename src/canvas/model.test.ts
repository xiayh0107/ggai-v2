import { describe, expect, it } from 'vitest'
import {
  CanvasValidationError,
  collectCanvasValidationIssues,
  emptyCanvasDocument,
  canvasNodeTypeRef,
  canvasNodeWorldFrame,
  canvasNodeWorldTransform,
  parseCanvasDocument,
  parseEntityKey,
  type CanvasNode,
  type CanvasTask,
} from './model'

function task(id: string): CanvasTask {
  return {
    id,
    title: 'Scatter plot',
    goal: 'Create a classic scatter plot',
    anchor: { x: 100, y: 120 },
    origin: { kind: 'user' },
  }
}

function node(id: string): CanvasNode {
  return {
    id,
    typeRef: { id: 'text', revision: 1, digest: '0000000000000000000000000000000000000000000000000000000000000000' },
    parentId: null,
    orderKey: (1).toString(36).padStart(12, '0'),
    bounds: { w: 320, h: 180 },
    transform: { matrix: [1, 0, 0, 1, 120, 220] },
    title: 'Prompt',
    artifactRefs: [],
    homeTaskId: 'task-1',
    origin: { kind: 'user' },
  }
}

describe('Canvas model', () => {
  it('validates containment as a single parentId tree with inherited root scope', () => {
    const input = emptyCanvasDocument()
    input.tasks.push(task('task-1'))
    const parent = node('parent')
    const child: CanvasNode = { ...node('child'), parentId: parent.id }
    delete child.homeTaskId
    parent.parentId = child.id
    input.nodes.push(parent, child)
    expect(collectCanvasValidationIssues(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nodes[0].parentId', message: 'forms a containment cycle' }),
    ]))

    parent.parentId = null
    child.homeTaskId = 'task-1'
    expect(collectCanvasValidationIssues(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nodes[1]' }),
    ]))
  })

  it('requires data edges to connect named ports without granting context', () => {
    const input = emptyCanvasDocument()
    input.tasks.push(task('task-1'))
    input.nodes.push(node('source'), { ...node('target'), orderKey: '000000000002' })
    input.edges.push({
      id: 'edge-data',
      from: { kind: 'node', id: 'source', port: 'out' },
      to: { kind: 'node', id: 'target', port: 'in' },
      relation: 'data',
      contextRole: 'none',
      orderKey: '000000000001',
      origin: { kind: 'user' },
    })
    expect(collectCanvasValidationIssues(input)).toEqual([])
    input.edges[0]!.contextRole = 'full'
    expect(collectCanvasValidationIssues(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'edges[0].contextRole' }),
    ]))
  })

  it('composes parent-local affine transforms into deterministic world geometry', () => {
    const input = emptyCanvasDocument()
    input.tasks.push(task('task-1'))
    const parent = node('parent')
    parent.transform.matrix = [2, 0, 0, 2, 100, 80]
    const child: CanvasNode = {
      ...node('child'),
      parentId: parent.id,
      transform: { matrix: [1, 0, 0, 1, 30, 20] },
    }
    delete child.homeTaskId
    input.nodes.push(parent, child)

    expect(canvasNodeWorldTransform(input, child)).toEqual([2, 0, 0, 2, 160, 120])
    expect(canvasNodeWorldFrame(input, child)).toMatchObject({
      x: 160,
      y: 120,
      w: 640,
      h: 360,
    })
  })

  it('parses the exact domain envelope without persisting run/session state', () => {
    const input = emptyCanvasDocument()
    input.tasks.push(task('task-1'))
    input.nodes.push(node('node-1'))

    const parsed = parseCanvasDocument(input)

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(Object.keys(parsed)).toEqual([
      'schemaVersion',
      'nodes',
      'tasks',
      'collections',
      'edges',
      'receipts',
      'everCreated',
    ])
    expect(parseEntityKey('node:node-1')).toEqual({ kind: 'node', id: 'node-1' })
    expect(parseEntityKey('task:task-1')).toEqual({ kind: 'task', id: 'task-1' })
    expect(parseEntityKey('collection:collection-1')).toBeNull()
  })

  it('rejects forbidden node state and nested collection membership', () => {
    const input = emptyCanvasDocument()
    input.tasks.push(task('task-1'))
    input.collections.push({
      id: 'collection-1',
      title: 'Analysis',
      anchor: { x: 40, y: 60 },
    })
    const invalidNode = {
      ...node('node-1'),
      collectionId: 'collection-1',
      instruction: { prompt: 'forbidden' },
    }
    input.nodes.push(invalidNode as CanvasNode)

    const issues = collectCanvasValidationIssues(input)

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nodes[0]' }),
    ]))
    expect(() => parseCanvasDocument(input)).toThrowError(CanvasValidationError)
  })

  it('requires every live Agent output to match a persisted receipt', () => {
    const input = emptyCanvasDocument()
    input.tasks.push(task('task-1'))
    input.nodes.push({
      ...node('node-output'),
      typeRef: canvasNodeTypeRef('image'),
      artifactRefs: [{
        runId: 'run-1',
        artifactId: `artifact_${'a'.repeat(64)}`,
      }],
      origin: {
        kind: 'agent-output',
        taskId: 'task-1',
        runId: 'run-1',
        planId: `plan_${'b'.repeat(64)}`,
        outputKey: 'preview',
      },
    })

    expect(collectCanvasValidationIssues(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'nodes[0].origin',
        message: 'does not match a materialization receipt',
      }),
    ]))
  })

  it('enforces artifact uniqueness and typed edge endpoint topology', () => {
    const input = emptyCanvasDocument()
    input.tasks.push(task('task-1'))
    input.nodes.push({
      ...node('node-1'),
      artifactRefs: [
        { runId: 'run-1', artifactId: `artifact_${'a'.repeat(64)}` },
        { runId: 'run-1', artifactId: `artifact_${'a'.repeat(64)}` },
      ],
    })
    input.edges.push({
      id: 'invalid-produced',
      from: { kind: 'node', id: 'node-1' },
      to: { kind: 'task', id: 'task-1' },
      relation: 'produced',
      contextRole: 'full',
      origin: { kind: 'user' },
    })

    expect(collectCanvasValidationIssues(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'nodes[0].artifactRefs',
        message: 'contains duplicate artifact references',
      }),
      expect.objectContaining({
        path: 'edges[0]',
        message: 'produced edges must connect a task to a node',
      }),
    ]))
  })

  it('permits a receipt-backed Agent output to detach while retaining provenance', () => {
    const input = emptyCanvasDocument()
    input.tasks.push(task('task-1'))
    input.nodes.push({
      ...node('node-output'),
      homeTaskId: undefined,
      typeRef: canvasNodeTypeRef('image'),
      artifactRefs: [{
        runId: 'run-1',
        artifactId: `artifact_${'a'.repeat(64)}`,
      }],
      origin: {
        kind: 'agent-output',
        taskId: 'task-1',
        runId: 'run-1',
        planId: `plan_${'b'.repeat(64)}`,
        outputKey: 'preview',
      },
    })
    input.receipts.push({
      kind: 'materialization',
      planId: `plan_${'b'.repeat(64)}`,
      runId: 'run-1',
      taskId: 'task-1',
      outcomes: [{ outputKey: 'preview', nodeId: 'node-output' }],
      dismissedProposalKeys: [],
    })

    expect(collectCanvasValidationIssues(input)).toEqual([])
  })

  it('rejects proposal keys accepted and dismissed by the same plan', () => {
    const input = emptyCanvasDocument()
    const planId = `plan_${'c'.repeat(64)}`
    input.tasks.push(task('task-1'), {
      id: 'task-proposal',
      title: 'Explain findings',
      goal: 'Explain the chart',
      anchor: { x: 180, y: 240 },
      origin: {
        kind: 'agent-proposal',
        parentTaskId: 'task-1',
        planId,
        proposalKey: 'explain',
      },
    })
    input.receipts.push(
      {
        kind: 'proposal-acceptance',
        planId,
        runId: 'run-1',
        taskId: 'task-1',
        proposals: [{ proposalKey: 'explain', taskId: 'task-proposal' }],
      },
      {
        kind: 'plan-dismissal',
        planId,
        runId: 'run-1',
        taskId: 'task-1',
        proposalKeys: ['explain'],
      },
    )

    expect(collectCanvasValidationIssues(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'receipts[0].proposals[0].proposalKey',
        message: 'is both accepted and dismissed for this plan',
      }),
    ]))
    expect(() => parseCanvasDocument(input)).toThrowError(CanvasValidationError)
  })
})
