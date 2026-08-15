import { describe, expect, it } from 'vitest'
import { emptyCanvasDocument, type CanvasDocument } from './model'
import { legacyDeletedViewTaskIds } from './legacyRepairs'

const PLAN_ID = `plan_${'a'.repeat(64)}`
const ARTIFACT_ID = `artifact_${'b'.repeat(64)}`

function taskDocument(): CanvasDocument {
  const document = emptyCanvasDocument()
  document.tasks.push({
    id: 'task-output',
    title: 'Generate image',
    goal: 'Generate an image',
    anchor: { x: 100, y: 100 },
    origin: { kind: 'user' },
  })
  return document
}

function addMaterialization(document: CanvasDocument, nodeId: string): void {
  document.receipts.push({
    kind: 'materialization',
    planId: PLAN_ID,
    runId: 'run-output',
    taskId: 'task-output',
    outcomes: [{ outputKey: 'image', nodeId }],
    dismissedProposalKeys: [],
  })
}

describe('legacy Canvas repairs', () => {
  it('finds only a receipt-backed Task whose materialized views are all gone', () => {
    const document = taskDocument()
    addMaterialization(document, 'node-deleted')

    expect(legacyDeletedViewTaskIds(document)).toEqual(['task-output'])
  })

  it('keeps an ordinary empty draft without a materialization outcome', () => {
    expect(legacyDeletedViewTaskIds(taskDocument())).toEqual([])
  })

  it('keeps a deliberately detached materialized Node', () => {
    const document = taskDocument()
    addMaterialization(document, 'node-detached')
    document.nodes.push({
      id: 'node-detached',
      type: 'image',
      frame: { x: 400, y: 100, w: 400, h: 300, z: 1 },
      title: 'Detached image',
      artifactRefs: [{ runId: 'run-output', artifactId: ARTIFACT_ID }],
      origin: {
        kind: 'agent-output',
        taskId: 'task-output',
        runId: 'run-output',
        planId: PLAN_ID,
        outputKey: 'image',
      },
    })

    expect(legacyDeletedViewTaskIds(document)).toEqual([])
  })

  it('keeps a Task that still owns another live Node', () => {
    const document = taskDocument()
    addMaterialization(document, 'node-deleted')
    document.nodes.push({
      id: 'node-live-slot',
      type: 'image',
      frame: { x: 400, y: 100, w: 400, h: 300, z: 1 },
      title: 'Live output slot',
      artifactRefs: [],
      homeTaskId: 'task-output',
      origin: { kind: 'user' },
    })

    expect(legacyDeletedViewTaskIds(document)).toEqual([])
  })
})
