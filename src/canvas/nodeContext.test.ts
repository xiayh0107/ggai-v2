import { describe, expect, it } from 'vitest'
import { emptyCanvasDocument } from './model'
import { selectCanvasNodeContext } from './nodeContext'

describe('Canvas Node context read model', () => {
  it('joins content, ownership, provenance, and typed relationships without Run UI state', () => {
    const document = emptyCanvasDocument()
    document.tasks.push({
      id: 'task-owner',
      title: 'Owner task',
      goal: 'Generate the result',
      anchor: { x: 10, y: 10 },
      collectionId: 'collection-1',
      origin: { kind: 'user' },
    })
    document.collections.push({
      id: 'collection-1',
      title: 'Research',
      anchor: { x: 0, y: 0 },
    })
    document.nodes.push({
      id: 'node-source',
      type: 'text',
      frame: { x: 0, y: 0, w: 320, h: 180, z: 1 },
      title: 'Source',
      text: 'Input',
      artifactRefs: [],
      origin: { kind: 'user' },
    }, {
      id: 'node-result',
      type: 'image',
      frame: { x: 400, y: 0, w: 320, h: 240, z: 2 },
      title: 'Result',
      payload: { caption: 'Visible' },
      artifactRefs: [{
        runId: 'run-result',
        artifactId: `artifact_${'a'.repeat(64)}`,
      }],
      homeTaskId: 'task-owner',
      origin: {
        kind: 'agent-output',
        taskId: 'task-owner',
        runId: 'run-result',
        planId: `plan_${'b'.repeat(64)}`,
        outputKey: 'preview',
      },
      skillBindings: {
        inheritType: false,
        skills: [{
          skillId: '@workspace/image-direction',
          revision: 3,
          digest: 'c'.repeat(64),
        }],
      },
    })
    document.edges.push({
      id: 'edge-source-result',
      from: { kind: 'node', id: 'node-source' },
      to: { kind: 'node', id: 'node-result' },
      relation: 'source',
      contextRole: 'full',
      origin: { kind: 'user' },
    }, {
      id: 'edge-result-task',
      from: { kind: 'node', id: 'node-result' },
      to: { kind: 'task', id: 'task-owner' },
      relation: 'references',
      contextRole: 'none',
      origin: { kind: 'user' },
    })
    document.receipts.push({
      kind: 'materialization',
      planId: `plan_${'b'.repeat(64)}`,
      runId: 'run-result',
      taskId: 'task-owner',
      outcomes: [{ outputKey: 'preview', nodeId: 'node-result' }],
      dismissedProposalKeys: [],
    })

    expect(selectCanvasNodeContext(document, 'node-result')).toMatchObject({
      identity: { id: 'node-result', type: 'image', title: 'Result' },
      content: { state: 'mixed', payload: { caption: 'Visible' } },
      placement: {
        task: { id: 'task-owner', title: 'Owner task', goal: 'Generate the result' },
        collection: { id: 'collection-1', title: 'Research' },
      },
      provenance: {
        materialization: {
          planId: `plan_${'b'.repeat(64)}`,
          runId: 'run-result',
          taskId: 'task-owner',
          outputKey: 'preview',
        },
      },
      capabilities: {
        inheritTypeSkills: false,
        skillBindings: [{
          skillId: '@workspace/image-direction',
          revision: 3,
          digest: 'c'.repeat(64),
        }],
      },
      relationships: [{
        edgeId: 'edge-source-result',
        direction: 'incoming',
        peerTitle: 'Source',
        relation: 'source',
        agentVisibility: 'full',
      }, {
        edgeId: 'edge-result-task',
        direction: 'outgoing',
        peerTitle: 'Owner task',
        relation: 'references',
        agentVisibility: 'hidden',
      }],
    })
    expect(selectCanvasNodeContext(document, 'missing')).toBeNull()
  })
})
