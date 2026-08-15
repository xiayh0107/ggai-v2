import { describe, expect, it } from 'vitest'
import {
  CanvasValidationError,
  collectCanvasValidationIssues,
  emptyCanvasDocument,
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
    type: 'text',
    frame: { x: 120, y: 220, w: 320, h: 180, z: 1 },
    title: 'Prompt',
    artifactRefs: [],
    homeTaskId: 'task-1',
    origin: { kind: 'user' },
  }
}

describe('Canvas model', () => {
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
      type: 'image',
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
      type: 'image',
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
