import { describe, expect, it } from 'vitest'
import {
  CanvasV2ValidationError,
  collectCanvasV2ValidationIssues,
  emptyCanvasDocumentV2,
  parseCanvasDocumentV2,
  parseEntityKeyV2,
  type CanvasNodeV2,
  type CanvasTaskV2,
} from './model'

function task(id: string): CanvasTaskV2 {
  return {
    id,
    title: 'Scatter plot',
    goal: 'Create a classic scatter plot',
    anchor: { x: 100, y: 120 },
    origin: { kind: 'user' },
  }
}

function node(id: string): CanvasNodeV2 {
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

describe('Canvas V2 model', () => {
  it('parses the exact domain envelope without persisting run/session state', () => {
    const input = emptyCanvasDocumentV2()
    input.tasks.push(task('task-1'))
    input.nodes.push(node('node-1'))

    const parsed = parseCanvasDocumentV2(input)

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
    expect(parseEntityKeyV2('node:node-1')).toEqual({ kind: 'node', id: 'node-1' })
    expect(parseEntityKeyV2('task:task-1')).toEqual({ kind: 'task', id: 'task-1' })
    expect(parseEntityKeyV2('collection:collection-1')).toBeNull()
  })

  it('rejects forbidden node state and nested collection membership', () => {
    const input = emptyCanvasDocumentV2()
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
    input.nodes.push(invalidNode as CanvasNodeV2)

    const issues = collectCanvasV2ValidationIssues(input)

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nodes[0]' }),
    ]))
    expect(() => parseCanvasDocumentV2(input)).toThrowError(CanvasV2ValidationError)
  })

  it('requires every live Agent output to match a persisted receipt', () => {
    const input = emptyCanvasDocumentV2()
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

    expect(collectCanvasV2ValidationIssues(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'nodes[0].origin',
        message: 'does not match a materialization receipt',
      }),
    ]))
  })
})
