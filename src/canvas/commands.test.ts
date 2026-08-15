import { describe, expect, it } from 'vitest'
import {
  applyCanvasCommand,
  CanvasCommandError,
  deterministicCanvasId,
  type CanvasCommand,
  type TrustedProjectionPlanInput,
} from './commands'
import {
  emptyCanvasDocument,
  type CanvasDocument,
  type CanvasNode,
  type CanvasTask,
} from './model'

const PLAN_ID = `plan_${'a'.repeat(64)}`

function task(id = 'task-1'): CanvasTask {
  return {
    id,
    title: 'Scatter plot',
    goal: 'Create a classic scatter plot',
    anchor: { x: 100, y: 120 },
    origin: { kind: 'user' },
  }
}

function node(
  id: string,
  x: number,
  y: number,
  homeTaskId?: string,
): CanvasNode {
  return {
    id,
    type: 'text',
    frame: { x, y, w: 300, h: 180, z: 1 },
    title: id,
    artifactRefs: [],
    ...(homeTaskId ? { homeTaskId } : {}),
    origin: { kind: 'user' },
  }
}

function documentWithTask(): CanvasDocument {
  const document = emptyCanvasDocument()
  document.tasks.push(task())
  return document
}

function plan(planId = PLAN_ID): TrustedProjectionPlanInput {
  return {
    schemaVersion: 2,
    planId,
    runId: 'run-1',
    taskId: 'task-1',
    status: 'complete',
    manifestDigest: 'b'.repeat(64),
    outputs: [
      {
        key: 'source',
        pluginId: 'code',
        role: 'primary',
        title: 'R source',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'c'.repeat(64)}`,
        }],
        derivedFrom: [],
        materialize: true,
      },
      {
        key: 'preview',
        pluginId: 'image',
        role: 'supporting',
        title: 'Scatter plot preview',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'d'.repeat(64)}`,
        }],
        derivedFrom: ['source'],
        materialize: true,
      },
      {
        key: 'notes',
        pluginId: 'file',
        role: 'auxiliary',
        title: 'Notes',
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'e'.repeat(64)}`,
        }],
        derivedFrom: [],
        materialize: false,
      },
    ],
    taskProposals: [
      {
        key: 'explain',
        title: 'Explain findings',
        prompt: 'Explain the relationship in the chart',
        inputOutputKeys: ['source'],
        dependsOn: [],
      },
      {
        key: 'export',
        title: 'Export report',
        prompt: 'Export the chart and explanation',
        inputOutputKeys: ['preview'],
        dependsOn: ['explain'],
      },
    ],
    warnings: ['Run ended with a partial but valid manifest'],
    digest: 'f'.repeat(64),
  }
}

describe('Canvas commands', () => {
  it('manages task goals and moves a collection as one spatial unit', () => {
    let current = applyCanvasCommand(emptyCanvasDocument(), {
      type: 'CreateTask',
      task: task(),
    })
    current.nodes.push(
      node('task-node', 140, 240, 'task-1'),
      node('top-node', 500, 200),
    )
    current = applyCanvasCommand(current, {
      type: 'UpdateTaskGoal',
      taskId: 'task-1',
      goal: 'Create and explain a scatter plot',
    })
    current = applyCanvasCommand(current, {
      type: 'CreateCollectionFromSelection',
      collection: {
        id: 'collection-1',
        title: 'Analysis',
        anchor: { x: 60, y: 80 },
      },
      members: [
        { kind: 'task', id: 'task-1' },
        { kind: 'node', id: 'top-node' },
      ],
    })
    const moved = applyCanvasCommand(current, {
      type: 'MoveEntities',
      entities: [],
      collectionIds: ['collection-1'],
      dx: 25,
      dy: -10,
    })

    expect(moved.tasks[0]).toMatchObject({
      goal: 'Create and explain a scatter plot',
      anchor: { x: 125, y: 110 },
      collectionId: 'collection-1',
    })
    expect(moved.collections[0].anchor).toEqual({ x: 85, y: 70 })
    expect(moved.nodes.find((entry) => entry.id === 'task-node')?.frame).toMatchObject({
      x: 165,
      y: 230,
    })
    expect(moved.nodes.find((entry) => entry.id === 'top-node')?.frame).toMatchObject({
      x: 525,
      y: 190,
    })

    const dissolved = applyCanvasCommand(moved, {
      type: 'DissolveCollection',
      collectionId: 'collection-1',
    })
    const regrouped = applyCanvasCommand(dissolved, {
      type: 'CreateCollectionFromSelection',
      collection: {
        id: 'collection-2',
        title: 'Delete together',
        anchor: { x: 0, y: 0 },
      },
      members: [{ kind: 'node', id: 'top-node' }],
    })
    const assigned = applyCanvasCommand(regrouped, {
      type: 'AssignToCollection',
      collectionId: 'collection-2',
      members: [{ kind: 'task', id: 'task-1' }],
    })
    const deleted = applyCanvasCommand(assigned, {
      type: 'DeleteCollectionAndContents',
      collectionId: 'collection-2',
    })

    expect(deleted.collections).toEqual([])
    expect(deleted.tasks).toEqual([])
    expect(deleted.nodes).toEqual([])
  })

  it('removes explicit collection membership and keeps members on ordinary deletion', () => {
    const initial = emptyCanvasDocument()
    initial.tasks.push(task())
    initial.nodes.push(node('top-node', 500, 200), node('task-node', 140, 240, 'task-1'))
    const collected = applyCanvasCommand(initial, {
      type: 'CreateCollectionFromSelection',
      collection: {
        id: 'collection-1',
        title: 'Saved selection',
        anchor: { x: 60, y: 80 },
      },
      members: [
        { kind: 'task', id: 'task-1' },
        { kind: 'node', id: 'top-node' },
      ],
    })
    const removed = applyCanvasCommand(collected, {
      type: 'RemoveFromCollection',
      collectionId: 'collection-1',
      members: [{ kind: 'node', id: 'top-node' }],
    })
    expect(removed.nodes.find((entry) => entry.id === 'top-node')?.collectionId).toBeUndefined()
    expect(removed.tasks[0].collectionId).toBe('collection-1')

    const deletedBoundary = applyCanvasCommand(removed, {
      type: 'DeleteCollection',
      collectionId: 'collection-1',
    })
    expect(deletedBoundary.collections).toEqual([])
    expect(deletedBoundary.tasks.map((entry) => entry.id)).toEqual(['task-1'])
    expect(deletedBoundary.tasks[0].collectionId).toBeUndefined()
    expect(deletedBoundary.nodes.map((entry) => entry.id)).toEqual(['top-node', 'task-node'])

    expect(() => applyCanvasCommand(collected, {
      type: 'RemoveFromCollection',
      collectionId: 'collection-1',
      members: [{ kind: 'node', id: 'task-node' }],
    })).toThrowError(CanvasCommandError)
  })

  it('deep-copies collection tasks, views, internal edges, and immutable artifacts', () => {
    let current = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: { ...plan(), taskProposals: [] },
    })
    current.nodes.push(node('top-node', 620, 160))
    current = applyCanvasCommand(current, {
      type: 'CreateCollectionFromSelection',
      collection: {
        id: 'collection-source',
        title: 'Analysis set',
        anchor: { x: 60, y: 80 },
      },
      members: [
        { kind: 'task', id: 'task-1' },
        { kind: 'node', id: 'top-node' },
      ],
    })
    current = applyCanvasCommand(current, {
      type: 'CreateEdge',
      edge: {
        id: 'edge-context',
        from: { kind: 'node', id: 'top-node' },
        to: { kind: 'task', id: 'task-1' },
        relation: 'source',
        contextRole: 'full',
        origin: { kind: 'user' },
      },
    })

    const duplicated = applyCanvasCommand(current, {
      type: 'DuplicateCollection',
      sourceCollectionId: 'collection-source',
      newCollectionId: 'collection-copy',
      offset: { x: 720, y: 40 },
    })
    const copiedTaskId = deterministicCanvasId(
      'task',
      'duplicate-collection',
      'collection-copy',
      'task-1',
    )
    const copiedTopNodeId = deterministicCanvasId(
      'node',
      'duplicate-collection',
      'collection-copy',
      'top-node',
    )
    const copiedTask = duplicated.tasks.find((entry) => entry.id === copiedTaskId)
    const copiedNodes = duplicated.nodes.filter((entry) =>
      entry.collectionId === 'collection-copy' || entry.homeTaskId === copiedTaskId)

    expect(copiedTask).toMatchObject({
      collectionId: 'collection-copy',
      origin: { kind: 'user' },
      anchor: { x: 820, y: 160 },
    })
    expect(copiedNodes).toHaveLength(3)
    expect(copiedNodes.every((entry) => entry.origin.kind === 'copied')).toBe(true)
    expect(copiedNodes.find((entry) => entry.id === copiedTopNodeId)?.collectionId)
      .toBe('collection-copy')
    const copiedArtifactNode = copiedNodes.find((entry) => entry.artifactRefs.length > 0)
    const sourceArtifactNode = current.nodes.find((entry) => entry.artifactRefs.length > 0)
    expect(copiedArtifactNode?.artifactRefs).toEqual(sourceArtifactNode?.artifactRefs)
    expect(copiedArtifactNode?.artifactRefs).not.toBe(sourceArtifactNode?.artifactRefs)
    expect(duplicated.receipts).toEqual(current.receipts)

    const copiedEntityIds = new Set([
      copiedTaskId,
      ...copiedNodes.map((entry) => entry.id),
    ])
    const copiedEdges = duplicated.edges.filter((edge) =>
      copiedEntityIds.has(edge.from.id) || copiedEntityIds.has(edge.to.id))
    expect(copiedEdges).toHaveLength(current.edges.length)
    expect(copiedEdges.every((edge) =>
      copiedEntityIds.has(edge.from.id)
      && copiedEntityIds.has(edge.to.id)
      && edge.origin.kind === 'user')).toBe(true)

    const deletedSource = applyCanvasCommand(duplicated, {
      type: 'DeleteCollectionAndContents',
      collectionId: 'collection-source',
    })
    expect(deletedSource.collections.map((entry) => entry.id)).toEqual(['collection-copy'])
    expect(deletedSource.tasks.map((entry) => entry.id)).toEqual([copiedTaskId])
    expect(deletedSource.nodes.every((entry) => copiedEntityIds.has(entry.id))).toBe(true)
    expect(deletedSource.receipts).toEqual(current.receipts)
    expect(applyCanvasCommand(deletedSource, {
      type: 'MaterializeProjectionPlan',
      plan: { ...plan(), taskProposals: [] },
    })).toBe(deletedSource)
  })

  it('duplicates only task intent and inbound context, then releases nodes on task deletion', () => {
    const initial = documentWithTask()
    initial.nodes.push(
      node('source-context', 20, 40),
      node('task-output', 180, 260, 'task-1'),
    )
    initial.edges.push(
      {
        id: 'edge-input',
        from: { kind: 'node', id: 'source-context' },
        to: { kind: 'task', id: 'task-1' },
        relation: 'source',
        contextRole: 'full',
        origin: { kind: 'user' },
      },
      {
        id: 'edge-output',
        from: { kind: 'task', id: 'task-1' },
        to: { kind: 'node', id: 'task-output' },
        relation: 'produced',
        contextRole: 'summary',
        origin: { kind: 'user' },
      },
    )

    const duplicated = applyCanvasCommand(initial, {
      type: 'DuplicateTaskAsDraft',
      sourceTaskId: 'task-1',
      newTaskId: 'task-draft',
      offset: { x: 420, y: 0 },
    })

    expect(duplicated.tasks).toHaveLength(2)
    expect(duplicated.nodes).toHaveLength(2)
    expect(duplicated.tasks[1]).toMatchObject({
      id: 'task-draft',
      goal: initial.tasks[0].goal,
      origin: { kind: 'user' },
    })
    expect(duplicated.edges.filter((edge) => edge.to.id === 'task-draft')).toHaveLength(1)

    const deleted = applyCanvasCommand(duplicated, {
      type: 'DeleteTask',
      taskId: 'task-1',
    })

    expect(deleted.tasks.map((entry) => entry.id)).toEqual(['task-draft'])
    expect(deleted.nodes.find((entry) => entry.id === 'task-output')?.homeTaskId).toBeUndefined()
    expect(deleted.edges).toHaveLength(1)
    expect(deleted.edges[0].to).toEqual({ kind: 'task', id: 'task-draft' })
  })

  it('materializes trusted auto outputs once and never resurrects after task deletion', () => {
    const initial = documentWithTask()
    const trustedPlan = {
      ...plan(),
      status: 'partial' as const,
      taskProposals: [],
    }
    const materialized = applyCanvasCommand(initial, {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    const sourceId = deterministicCanvasId('node', PLAN_ID, 'source')
    const previewId = deterministicCanvasId('node', PLAN_ID, 'preview')

    expect(materialized.nodes.map((entry) => entry.id)).toEqual([sourceId, previewId])
    expect(materialized.nodes.every((entry) => entry.homeTaskId === 'task-1')).toBe(true)
    expect(materialized.edges.filter((edge) => edge.relation === 'produced')).toHaveLength(2)
    expect(materialized.edges.filter((edge) => edge.relation === 'derived')).toHaveLength(1)
    expect(materialized.edges[0].from).toEqual({ kind: 'task', id: 'task-1' })
    expect(materialized.receipts[0]).toEqual({
      kind: 'materialization',
      planId: PLAN_ID,
      runId: 'run-1',
      taskId: 'task-1',
      outcomes: [
        { outputKey: 'source', nodeId: sourceId },
        { outputKey: 'preview', nodeId: previewId },
      ],
      dismissedProposalKeys: [],
    })
    expect(applyCanvasCommand(materialized, {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })).toBe(materialized)

    const deletedWithViews = applyCanvasCommand(materialized, {
      type: 'DeleteTaskAndViews',
      taskId: 'task-1',
    })
    expect(deletedWithViews.tasks).toEqual([])
    expect(deletedWithViews.nodes).toEqual([])
    expect(deletedWithViews.edges).toEqual([])
    expect(deletedWithViews.receipts).toHaveLength(1)
    expect(applyCanvasCommand(deletedWithViews, {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })).toBe(deletedWithViews)

    const deleted = applyCanvasCommand(materialized, {
      type: 'DeleteTask',
      taskId: 'task-1',
    })
    const replayed = applyCanvasCommand(deleted, {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })

    expect(replayed).toBe(deleted)
    expect(replayed.tasks).toEqual([])
    expect(replayed.nodes).toHaveLength(2)
    expect(replayed.nodes.every((entry) => entry.homeTaskId === undefined)).toBe(true)
    expect(replayed.receipts).toHaveLength(1)
  })

  it('accepts bounded task proposals with source/dependency edges and records dismissal', () => {
    const trustedPlan = plan()
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    const accepted = applyCanvasCommand(materialized, {
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['explain', 'export'],
    })

    expect(accepted.tasks).toHaveLength(3)
    expect(accepted.tasks.slice(1).map((entry) => entry.origin.kind)).toEqual([
      'agent-proposal',
      'agent-proposal',
    ])
    expect(accepted.edges.filter((edge) => edge.relation === 'source')).toHaveLength(2)
    expect(accepted.edges.filter((edge) => edge.relation === 'depends-on')).toHaveLength(1)
    expect(accepted.receipts.map((receipt) => receipt.kind)).toEqual([
      'materialization',
      'proposal-acceptance',
    ])
    expect(applyCanvasCommand(accepted, {
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['explain', 'export'],
    })).toBe(accepted)

    const dismissed = applyCanvasCommand(accepted, {
      type: 'DismissPlan',
      plan: trustedPlan,
    })
    expect(dismissed.tasks).toHaveLength(3)
    expect(dismissed.nodes).toHaveLength(2)
    expect(dismissed.receipts[2]).toMatchObject({
      kind: 'plan-dismissal',
      proposalKeys: [],
    })
    expect(applyCanvasCommand(dismissed, {
      type: 'DismissPlan',
      plan: trustedPlan,
    })).toBe(dismissed)
  })

  it('materializes an auxiliary proposal input with trusted relations and extends the receipt', () => {
    const trustedPlan = plan()
    trustedPlan.outputs[2]!.derivedFrom = ['preview']
    trustedPlan.taskProposals = [{
      key: 'inspect-notes',
      title: 'Inspect notes',
      prompt: 'Inspect the supporting notes alongside the preview',
      inputOutputKeys: ['notes', 'preview'],
      dependsOn: [],
    }]
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    expect(materialized.nodes).toHaveLength(2)

    const accepted = applyCanvasCommand(materialized, {
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['inspect-notes'],
    })
    const notesNodeId = deterministicCanvasId('node', PLAN_ID, 'notes')
    const previewNodeId = deterministicCanvasId('node', PLAN_ID, 'preview')
    const proposalTaskId = deterministicCanvasId('task', PLAN_ID, 'inspect-notes')

    expect(accepted.nodes).toHaveLength(3)
    expect(accepted.nodes.find((entry) => entry.id === notesNodeId)).toMatchObject({
      type: 'file',
      title: 'Notes',
      homeTaskId: 'task-1',
      origin: {
        kind: 'agent-output',
        taskId: 'task-1',
        runId: 'run-1',
        planId: PLAN_ID,
        outputKey: 'notes',
      },
    })
    expect(accepted.edges.find((edge) =>
      edge.relation === 'produced' && edge.to.id === notesNodeId)).toMatchObject({
      from: { kind: 'task', id: 'task-1' },
      contextRole: 'none',
    })
    expect(accepted.edges.find((edge) =>
      edge.relation === 'derived' && edge.to.id === notesNodeId)).toMatchObject({
      from: { kind: 'node', id: previewNodeId },
      contextRole: 'full',
    })
    expect(accepted.edges.filter((edge) =>
      edge.relation === 'source' && edge.to.id === proposalTaskId).map((edge) => edge.from.id))
      .toEqual([notesNodeId, previewNodeId])
    expect(accepted.receipts.find((receipt) => receipt.kind === 'materialization'))
      .toMatchObject({
        outcomes: [
          { outputKey: 'source' },
          { outputKey: 'preview' },
          { outputKey: 'notes', nodeId: notesNodeId },
        ],
      })
    expect(Object.keys(accepted.tasks.find((entry) => entry.id === proposalTaskId)!).sort())
      .toEqual(['anchor', 'goal', 'id', 'origin', 'title'])
  })

  it('recursively materializes trusted lineage for a proposal input', () => {
    const trustedPlan = plan()
    for (const output of trustedPlan.outputs) output.materialize = false
    trustedPlan.outputs[2]!.derivedFrom = ['preview']
    trustedPlan.taskProposals = [{
      key: 'inspect-notes',
      title: 'Inspect notes',
      prompt: 'Inspect notes with their full lineage',
      inputOutputKeys: ['notes'],
      dependsOn: [],
    }]
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    expect(materialized.nodes).toEqual([])

    const accepted = applyCanvasCommand(materialized, {
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['inspect-notes'],
    })
    const nodeIdByOutputKey = new Map(accepted.nodes.map((entry) => [
      entry.origin.kind === 'agent-output' ? entry.origin.outputKey : '',
      entry.id,
    ]))
    const proposalTaskId = deterministicCanvasId('task', PLAN_ID, 'inspect-notes')

    expect([...nodeIdByOutputKey.keys()]).toEqual(['source', 'preview', 'notes'])
    expect(accepted.edges.filter((edge) => edge.relation === 'produced').map((edge) => {
      const outputNode = accepted.nodes.find((node) => node.id === edge.to.id)
      return [
        outputNode?.origin.kind === 'agent-output' ? outputNode.origin.outputKey : null,
        edge.contextRole,
      ]
    })).toEqual([
      ['source', 'full'],
      ['preview', 'summary'],
      ['notes', 'none'],
    ])
    expect(accepted.edges.filter((edge) => edge.relation === 'derived').map((edge) => [
      edge.from.id,
      edge.to.id,
    ])).toEqual([
      [nodeIdByOutputKey.get('source'), nodeIdByOutputKey.get('preview')],
      [nodeIdByOutputKey.get('preview'), nodeIdByOutputKey.get('notes')],
    ])
    expect(accepted.edges.filter((edge) => edge.relation === 'source')).toEqual([
      expect.objectContaining({
        from: { kind: 'node', id: nodeIdByOutputKey.get('notes') },
        to: { kind: 'task', id: proposalTaskId },
      }),
    ])
    expect(accepted.receipts.find((receipt) => receipt.kind === 'materialization'))
      .toMatchObject({
        outcomes: [
          { outputKey: 'source' },
          { outputKey: 'preview' },
          { outputKey: 'notes' },
        ],
      })
  })

  it('materializes a confirmed proposal input beyond the twelve automatic output slots', () => {
    const trustedPlan = plan()
    trustedPlan.outputs = Array.from({ length: 13 }, (_, index) => ({
      key: `output-${index + 1}`,
      pluginId: 'file',
      role: 'supporting' as const,
      title: `Output ${index + 1}`,
      artifactRefs: [{
        runId: 'run-1',
        artifactId: `artifact_${(index + 1).toString(16).padStart(64, '0')}`,
      }],
      derivedFrom: [],
      materialize: index < 12,
    }))
    trustedPlan.taskProposals = [{
      key: 'use-tray-output',
      title: 'Use tray output',
      prompt: 'Use the thirteenth output',
      inputOutputKeys: ['output-13'],
      dependsOn: [],
    }]
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    expect(materialized.nodes).toHaveLength(12)

    const accepted = applyCanvasCommand(materialized, {
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['use-tray-output'],
    })
    const inputNodeId = deterministicCanvasId('node', PLAN_ID, 'output-13')
    const proposalTaskId = deterministicCanvasId('task', PLAN_ID, 'use-tray-output')
    expect(accepted.nodes).toHaveLength(13)
    expect(accepted.nodes.find((node) => node.id === inputNodeId)?.origin).toMatchObject({
      kind: 'agent-output',
      outputKey: 'output-13',
    })
    expect(accepted.edges.find((edge) =>
      edge.relation === 'produced' && edge.to.id === inputNodeId)?.contextRole).toBe('summary')
    expect(accepted.edges.find((edge) =>
      edge.relation === 'source' && edge.to.id === proposalTaskId)?.from)
      .toEqual({ kind: 'node', id: inputNodeId })
    expect(accepted.receipts.find((receipt) => receipt.kind === 'materialization'))
      .toMatchObject({ outcomes: expect.arrayContaining([{ outputKey: 'output-13', nodeId: inputNodeId }]) })
  })

  it('rejects unresolved or unbounded proposal inputs without changing the canvas', () => {
    const missingOutputPlan = plan()
    missingOutputPlan.taskProposals = [{
      key: 'missing-input',
      title: 'Missing input',
      prompt: 'Use an output that is not in the plan',
      inputOutputKeys: ['missing-output'],
      dependsOn: [],
    }]
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: missingOutputPlan,
    })
    const materializedSnapshot = structuredClone(materialized)
    expectCanvasCommandError(() => applyCanvasCommand(materialized, {
      type: 'AcceptTaskProposals',
      plan: missingOutputPlan,
      proposalKeys: ['missing-input'],
    }), 'proposal-input-output-not-found')
    expect(materialized).toEqual(materializedSnapshot)

    const missingLineagePlan = plan()
    missingLineagePlan.outputs[2]!.derivedFrom = ['missing-parent']
    missingLineagePlan.taskProposals = [{
      key: 'missing-lineage',
      title: 'Missing lineage',
      prompt: 'Use an output with unresolved lineage',
      inputOutputKeys: ['notes'],
      dependsOn: [],
    }]
    const lineageMaterialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: missingLineagePlan,
    })
    const lineageSnapshot = structuredClone(lineageMaterialized)
    expectCanvasCommandError(() => applyCanvasCommand(lineageMaterialized, {
      type: 'AcceptTaskProposals',
      plan: missingLineagePlan,
      proposalKeys: ['missing-lineage'],
    }), 'proposal-input-lineage-output-not-found')
    expect(lineageMaterialized).toEqual(lineageSnapshot)

    const deletedInput = applyCanvasCommand(materialized, {
      type: 'DeleteNode',
      nodeId: deterministicCanvasId('node', PLAN_ID, 'source'),
    })
    const deletedSnapshot = structuredClone(deletedInput)
    expectCanvasCommandError(() => applyCanvasCommand(deletedInput, {
      type: 'AcceptTaskProposals',
      plan: plan(),
      proposalKeys: ['explain'],
    }), 'proposal-input-node-missing')
    expect(deletedInput).toEqual(deletedSnapshot)

    const unboundedPlan = plan()
    unboundedPlan.taskProposals[0]!.inputOutputKeys = Array.from(
      { length: 33 },
      (_, index) => `input-${index}`,
    )
    expectCanvasCommandError(() => applyCanvasCommand(materialized, {
      type: 'AcceptTaskProposals',
      plan: unboundedPlan,
      proposalKeys: ['explain'],
    }), 'invalid-proposal-inputs')
  })

  it('uses edited proposal order, content, and dependencies without starting a run', () => {
    const trustedPlan = plan()
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    const accepted = applyCanvasCommand(materialized, {
      type: 'AcceptTaskProposals',
      plan: trustedPlan,
      proposalKeys: ['export', 'explain'],
      edits: {
        export: {
          title: 'Publish report',
          prompt: 'Publish the final chart report',
          dependsOn: [],
        },
        explain: { dependsOn: ['export'] },
      },
    })
    const exportTaskId = deterministicCanvasId('task', PLAN_ID, 'export')
    const explainTaskId = deterministicCanvasId('task', PLAN_ID, 'explain')

    expect(accepted.tasks.slice(1).map((entry) => ({
      id: entry.id,
      title: entry.title,
      goal: entry.goal,
      anchor: entry.anchor,
    }))).toEqual([
      {
        id: exportTaskId,
        title: 'Publish report',
        goal: 'Publish the final chart report',
        anchor: { x: 148, y: 216 },
      },
      {
        id: explainTaskId,
        title: 'Explain findings',
        goal: 'Explain the relationship in the chart',
        anchor: { x: 148, y: 328 },
      },
    ])
    expect(accepted.edges.find((edge) => edge.relation === 'depends-on')).toMatchObject({
      from: { kind: 'task', id: exportTaskId },
      to: { kind: 'task', id: explainTaskId },
    })
    expect(accepted.receipts.find((receipt) => receipt.kind === 'proposal-acceptance'))
      .toMatchObject({
        proposals: [
          { proposalKey: 'export', taskId: exportTaskId },
          { proposalKey: 'explain', taskId: explainTaskId },
        ],
      })
    expect(accepted.receipts.some((receipt) => receipt.kind === 'plan-dismissal')).toBe(false)
    expect(Object.keys(accepted.tasks[1]!).sort()).toEqual([
      'anchor',
      'goal',
      'id',
      'origin',
      'title',
    ])
  })

  it('atomically accepts a subset, dismisses every unselected key, and replays once', () => {
    const trustedPlan = plan()
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    const command = {
      type: 'AcceptTaskProposals' as const,
      plan: trustedPlan,
      proposalKeys: ['explain'],
      edits: { explain: { title: 'Explain only' } },
    }
    const accepted = applyCanvasCommand(materialized, command)

    expect(accepted.tasks).toHaveLength(2)
    expect(accepted.tasks[1]?.title).toBe('Explain only')
    expect(accepted.receipts.slice(1)).toEqual([
      {
        kind: 'proposal-acceptance',
        planId: PLAN_ID,
        runId: 'run-1',
        taskId: 'task-1',
        proposals: [{
          proposalKey: 'explain',
          taskId: deterministicCanvasId('task', PLAN_ID, 'explain'),
        }],
      },
      {
        kind: 'plan-dismissal',
        planId: PLAN_ID,
        runId: 'run-1',
        taskId: 'task-1',
        proposalKeys: ['export'],
      },
    ])
    expect(applyCanvasCommand(accepted, command)).toBe(accepted)
  })

  it('rejects invalid edited proposal graphs atomically', () => {
    const trustedPlan = plan()
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    const snapshot = structuredClone(materialized)
    const invalidCommands: Array<{
      code: string
      command: Extract<CanvasCommand, { type: 'AcceptTaskProposals' }>
    }> = [
      {
        code: 'invalid-proposal-edits',
        command: {
          type: 'AcceptTaskProposals',
          plan: trustedPlan,
          proposalKeys: ['explain'],
          edits: { explain: {} },
        },
      },
      {
        code: 'proposal-edit-not-selected',
        command: {
          type: 'AcceptTaskProposals',
          plan: trustedPlan,
          proposalKeys: ['explain'],
          edits: { export: { title: 'Not selected' } },
        },
      },
      {
        code: 'invalid-proposal-dependency',
        command: {
          type: 'AcceptTaskProposals',
          plan: trustedPlan,
          proposalKeys: ['explain'],
          edits: { explain: { dependsOn: ['explain'] } },
        },
      },
      {
        code: 'invalid-proposal-dependency',
        command: {
          type: 'AcceptTaskProposals',
          plan: trustedPlan,
          proposalKeys: ['explain', 'export'],
          edits: { explain: { dependsOn: ['foreign'] } },
        },
      },
      {
        code: 'invalid-proposal-dependency',
        command: {
          type: 'AcceptTaskProposals',
          plan: trustedPlan,
          proposalKeys: ['export'],
          edits: { export: { dependsOn: ['explain'] } },
        },
      },
      {
        code: 'invalid-proposal-dependency',
        command: {
          type: 'AcceptTaskProposals',
          plan: trustedPlan,
          proposalKeys: ['explain', 'export'],
          edits: { explain: { dependsOn: ['export', 'export'] } },
        },
      },
      {
        code: 'proposal-dependency-cycle',
        command: {
          type: 'AcceptTaskProposals',
          plan: trustedPlan,
          proposalKeys: ['explain', 'export'],
          edits: {
            explain: { dependsOn: ['export'] },
            export: { dependsOn: ['explain'] },
          },
        },
      },
      {
        code: 'invalid-proposal-dependency',
        command: {
          type: 'AcceptTaskProposals',
          plan: trustedPlan,
          proposalKeys: ['export'],
        },
      },
    ]

    for (const { command, code } of invalidCommands) {
      try {
        applyCanvasCommand(materialized, command)
        throw new Error(`Expected ${code}`)
      } catch (error) {
        expect(error).toBeInstanceOf(CanvasCommandError)
        expect((error as CanvasCommandError).code).toBe(code)
      }
      expect(materialized).toEqual(snapshot)
    }
  })

  it('creates, edits, resizes, duplicates, and deletes user nodes without forging artifacts', () => {
    let current = applyCanvasCommand(emptyCanvasDocument(), {
      type: 'CreateNode',
      node: node('node-1', 20, 40),
    })
    current = applyCanvasCommand(current, {
      type: 'UpdateNodeContent',
      nodeId: 'node-1',
      patch: {
        title: 'Edited node',
        text: 'User-authored content',
        payload: { style: 'concise', count: 2 },
      },
    })
    current = applyCanvasCommand(current, {
      type: 'ResizeNode',
      nodeId: 'node-1',
      w: 420,
      h: 260,
    })
    current = applyCanvasCommand(current, {
      type: 'UpdateNodeSkillBindings',
      nodeId: 'node-1',
      bindings: {
        inheritType: true,
        skills: [{
          skillId: '@workspace/concise-writing',
          revision: 1,
          digest: 'e'.repeat(64),
        }],
      },
    })
    current = applyCanvasCommand(current, {
      type: 'DuplicateNode',
      sourceNodeId: 'node-1',
      newNodeId: 'node-copy',
      offset: { x: 48, y: 64 },
    })

    expect(current.nodes[0]).toMatchObject({
      title: 'Edited node',
      text: 'User-authored content',
      payload: { style: 'concise', count: 2 },
      frame: { w: 420, h: 260 },
      skillBindings: {
        inheritType: true,
        skills: [{ skillId: '@workspace/concise-writing', revision: 1 }],
      },
      origin: { kind: 'user' },
    })
    expect(current.nodes[1]).toMatchObject({
      id: 'node-copy',
      artifactRefs: [],
      origin: { kind: 'copied', sourceNodeId: 'node-1' },
      frame: { x: 68, y: 104, w: 420, h: 260 },
      skillBindings: {
        inheritType: true,
        skills: [{ skillId: '@workspace/concise-writing', revision: 1 }],
      },
    })

    const forged = {
      type: 'CreateNode',
      node: {
        ...node('forged', 0, 0),
        artifactRefs: [{
          runId: 'run-1',
          artifactId: `artifact_${'a'.repeat(64)}`,
        }],
      },
    } satisfies CanvasCommand
    expect(() => applyCanvasCommand(current, forged)).toThrowError(CanvasCommandError)
    const freePatch = {
      type: 'UpdateNodeContent',
      nodeId: 'node-1',
      patch: { artifactRefs: [] },
    } as unknown as CanvasCommand
    expect(() => applyCanvasCommand(current, freePatch)).toThrowError(CanvasCommandError)

    current = applyCanvasCommand(current, {
      type: 'CreateEdge',
      edge: {
        id: 'edge-copy',
        from: { kind: 'node', id: 'node-1' },
        to: { kind: 'node', id: 'node-copy' },
        relation: 'derived',
        contextRole: 'summary',
        origin: { kind: 'user' },
      },
    })
    const deleted = applyCanvasCommand(current, { type: 'DeleteNode', nodeId: 'node-1' })
    expect(deleted.nodes.map(({ id }) => id)).toEqual(['node-copy'])
    expect(deleted.edges).toEqual([])
  })

  it('removes an owned Node\'s empty Task projection only when the final output is removed', () => {
    const trustedPlan = plan()
    const materialized = applyCanvasCommand(documentWithTask(), {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })
    const sourceId = deterministicCanvasId('node', PLAN_ID, 'source')
    const previewId = deterministicCanvasId('node', PLAN_ID, 'preview')

    const oneRemoved = applyCanvasCommand(materialized, {
      type: 'DeleteNode',
      nodeId: sourceId,
    })
    expect(oneRemoved.tasks.map((entry) => entry.id)).toEqual(['task-1'])
    expect(oneRemoved.nodes.map((entry) => entry.id)).toEqual([previewId])
    expect(oneRemoved.edges.every((edge) =>
      edge.from.id !== sourceId && edge.to.id !== sourceId)).toBe(true)
    expect(oneRemoved.receipts).toEqual(materialized.receipts)

    const finalRemoved = applyCanvasCommand(oneRemoved, {
      type: 'DeleteNode',
      nodeId: previewId,
    })
    expect(finalRemoved.tasks).toEqual([])
    expect(finalRemoved.nodes).toEqual([])
    expect(finalRemoved.edges).toEqual([])
    expect(finalRemoved.receipts).toEqual(materialized.receipts)
    expect(applyCanvasCommand(finalRemoved, {
      type: 'MaterializeProjectionPlan',
      plan: trustedPlan,
    })).toBe(finalRemoved)
  })

  it('creates and edits typed edges with atomic fanout', () => {
    const initial = emptyCanvasDocument()
    initial.tasks.push(task('task-a'), task('task-b'))
    initial.nodes.push(node('node-a', 0, 0), node('node-b', 20, 20))
    const created = applyCanvasCommand(initial, {
      type: 'CreateEdges',
      edges: [
        {
          id: 'edge-source',
          from: { kind: 'node', id: 'node-a' },
          to: { kind: 'task', id: 'task-a' },
          relation: 'source',
          contextRole: 'full',
          origin: { kind: 'user' },
        },
        {
          id: 'edge-dependency',
          from: { kind: 'task', id: 'task-a' },
          to: { kind: 'task', id: 'task-b' },
          relation: 'depends-on',
          contextRole: 'summary',
          origin: { kind: 'user' },
        },
      ],
    })
    const updated = applyCanvasCommand(created, {
      type: 'UpdateEdge',
      edgeId: 'edge-source',
      patch: { relation: 'modified', contextRole: 'summary' },
    })
    expect(updated.edges[0]).toMatchObject({ relation: 'modified', contextRole: 'summary' })

    const snapshot = structuredClone(updated)
    expect(() => applyCanvasCommand(updated, {
      type: 'CreateEdges',
      edges: [
        {
          id: 'edge-valid-first',
          from: { kind: 'node', id: 'node-b' },
          to: { kind: 'task', id: 'task-a' },
          relation: 'source',
          contextRole: 'full',
          origin: { kind: 'user' },
        },
        {
          id: 'edge-invalid-second',
          from: { kind: 'node', id: 'node-a' },
          to: { kind: 'task', id: 'task-a' },
          relation: 'produced',
          contextRole: 'full',
          origin: { kind: 'user' },
        },
      ],
    })).toThrowError(CanvasCommandError)
    expect(updated).toEqual(snapshot)

    const snapshotBeforeInvalidDelete = structuredClone(updated)
    expect(() => applyCanvasCommand(updated, {
      type: 'DeleteEdges',
      edgeIds: ['edge-source', 'edge-missing'],
    })).toThrowError(CanvasCommandError)
    expect(updated).toEqual(snapshotBeforeInvalidDelete)

    const deleted = applyCanvasCommand(updated, {
      type: 'DeleteEdges',
      edgeIds: ['edge-dependency', 'edge-source'],
    })
    expect(deleted.edges).toEqual([])
  })

  it('adopts one empty output slot, supports detach/assign, and never resurrects a deleted view', () => {
    const emptyImage = { ...node('image-slot', 40, 60), type: 'image' }
    let current = applyCanvasCommand(emptyCanvasDocument(), {
      type: 'CreateNode',
      node: emptyImage,
    })
    current = applyCanvasCommand(current, {
      type: 'CreateTaskForOutputSlot',
      task: task('task-1'),
      nodeId: 'image-slot',
    })
    const outputPlan: TrustedProjectionPlanInput = {
      ...plan(),
      outputs: [{
        ...plan().outputs[1]!,
        role: 'primary',
      }],
      taskProposals: [],
    }
    current = applyCanvasCommand(current, {
      type: 'MaterializeProjectionPlan',
      plan: outputPlan,
    })

    expect(current.nodes).toHaveLength(1)
    expect(current.nodes[0]).toMatchObject({
      id: 'image-slot',
      homeTaskId: 'task-1',
      artifactRefs: outputPlan.outputs[0]!.artifactRefs,
      origin: {
        kind: 'agent-output',
        taskId: 'task-1',
        outputKey: 'preview',
      },
    })
    expect(current.receipts[0]).toMatchObject({
      outcomes: [{ outputKey: 'preview', nodeId: 'image-slot' }],
    })
    current = applyCanvasCommand(current, {
      type: 'DuplicateNode',
      sourceNodeId: 'image-slot',
      newNodeId: 'image-copy',
      offset: { x: 40, y: 40 },
    })
    expect(current.nodes[1]).toMatchObject({
      artifactRefs: outputPlan.outputs[0]!.artifactRefs,
      origin: { kind: 'copied', sourceNodeId: 'image-slot' },
    })
    current = applyCanvasCommand(current, { type: 'DeleteNode', nodeId: 'image-copy' })

    const detached = applyCanvasCommand(current, {
      type: 'DetachNodeFromTask',
      nodeId: 'image-slot',
    })
    expect(detached.nodes[0].homeTaskId).toBeUndefined()
    expect(detached.edges.some((edge) => edge.relation === 'produced')).toBe(true)
    const reassigned = applyCanvasCommand(detached, {
      type: 'AssignNodeToTask',
      nodeId: 'image-slot',
      taskId: 'task-1',
    })
    expect(reassigned.nodes[0].homeTaskId).toBe('task-1')
    const withForeignTask = applyCanvasCommand(reassigned, {
      type: 'CreateTask',
      task: task('task-2'),
    })
    expect(() => applyCanvasCommand(withForeignTask, {
      type: 'AssignNodeToTask',
      nodeId: 'image-slot',
      taskId: 'task-2',
    })).toThrowError(CanvasCommandError)

    const deleted = applyCanvasCommand(withForeignTask, {
      type: 'DeleteNode',
      nodeId: 'image-slot',
    })
    const replayed = applyCanvasCommand(deleted, {
      type: 'MaterializeProjectionPlan',
      plan: outputPlan,
    })
    expect(replayed).toBe(deleted)
    expect(replayed.nodes).toEqual([])
    expect(replayed.receipts).toHaveLength(1)
  })

  it('atomically promotes an output slot\'s content-bearing sources to Task inputs', () => {
    const initial = emptyCanvasDocument()
    initial.tasks.push(task('upstream-task'))
    initial.nodes.push(
      {
        ...node('community-image', 20, 40),
        type: '@community/image',
        artifactRefs: [{
          runId: 'run-source',
          artifactId: `artifact_${'e'.repeat(64)}`,
        }],
      },
      { ...node('summary-source', 20, 260), type: '@community/data' },
      { ...node('visual-only', 20, 480), type: '@community/note' },
      { ...node('community-text-slot', 420, 40), type: '@community/review' },
    )
    initial.edges.push(
      {
        id: 'edge-image-slot',
        from: { kind: 'node', id: 'community-image' },
        to: { kind: 'node', id: 'community-text-slot' },
        relation: 'source',
        contextRole: 'full',
        origin: { kind: 'user' },
      },
      {
        id: 'edge-summary-slot',
        from: { kind: 'node', id: 'summary-source' },
        to: { kind: 'node', id: 'community-text-slot' },
        relation: 'references',
        contextRole: 'summary',
        origin: { kind: 'user' },
      },
      {
        id: 'edge-visual-slot',
        from: { kind: 'node', id: 'visual-only' },
        to: { kind: 'node', id: 'community-text-slot' },
        relation: 'references',
        contextRole: 'none',
        origin: { kind: 'user' },
      },
      {
        id: 'edge-task-slot',
        from: { kind: 'task', id: 'upstream-task' },
        to: { kind: 'node', id: 'community-text-slot' },
        relation: 'references',
        contextRole: 'summary',
        origin: { kind: 'user' },
      },
    )

    const promoted = applyCanvasCommand(initial, {
      type: 'CreateTaskForOutputSlot',
      task: task('review-task'),
      nodeId: 'community-text-slot',
    })

    expect(promoted.nodes.find((entry) => entry.id === 'community-text-slot')?.homeTaskId)
      .toBe('review-task')
    // 晋升是移动而非复制：3 条内容连线改指任务后，原指向槽节点的连线移除，
    // 同一来源不会同时画出 来源→任务 与 来源→节点 两条线
    expect(promoted.edges).toHaveLength(initial.edges.length)
    expect(promoted.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deterministicCanvasId(
          'edge',
          'output-slot-input',
          'review-task',
          'node:community-image',
        ),
        from: { kind: 'node', id: 'community-image' },
        to: { kind: 'task', id: 'review-task' },
        relation: 'source',
        contextRole: 'full',
        origin: { kind: 'user' },
      }),
      expect.objectContaining({
        from: { kind: 'node', id: 'summary-source' },
        to: { kind: 'task', id: 'review-task' },
        relation: 'source',
        contextRole: 'summary',
      }),
      expect.objectContaining({
        from: { kind: 'task', id: 'upstream-task' },
        to: { kind: 'task', id: 'review-task' },
        relation: 'depends-on',
        contextRole: 'summary',
      }),
    ]))
    expect(promoted.edges.some((edge) =>
      edge.from.id === 'visual-only'
      && edge.to.kind === 'task'
      && edge.to.id === 'review-task')).toBe(false)
    // 已晋升的上下文连线不再指向槽节点；纯视觉 lineage（contextRole none）保留
    expect(promoted.edges.some((edge) =>
      edge.to.kind === 'node'
      && edge.to.id === 'community-text-slot'
      && edge.contextRole !== 'none')).toBe(false)
    expect(promoted.edges).toContainEqual(expect.objectContaining({
      id: 'edge-visual-slot',
      to: { kind: 'node', id: 'community-text-slot' },
      contextRole: 'none',
    }))
  })

  it('atomically creates a derived task and never overwrites a content source node', () => {
    const initial = emptyCanvasDocument()
    initial.tasks.push(task('upstream-task'))
    initial.nodes.push({
      ...node('content-source', 20, 40),
      type: 'image',
      text: 'Keep this original content',
    })
    const derived = applyCanvasCommand(initial, {
      type: 'CreateDerivedTaskFromSelection',
      task: task('task-derived'),
      sources: [
        {
          entity: { kind: 'node', id: 'content-source' },
          relation: 'modified',
          contextRole: 'full',
        },
        {
          entity: { kind: 'task', id: 'upstream-task' },
          relation: 'source',
          contextRole: 'summary',
        },
      ],
    })

    expect(derived.tasks.map(({ id }) => id)).toEqual(['upstream-task', 'task-derived'])
    expect(derived.edges).toHaveLength(2)
    expect(derived.edges.map(({ id }) => id)).toEqual([
      deterministicCanvasId('edge', 'derived-task-source', 'task-derived', 'node:content-source'),
      deterministicCanvasId('edge', 'derived-task-source', 'task-derived', 'task:upstream-task'),
    ])
    expect(derived.nodes[0]).toMatchObject({
      id: 'content-source',
      text: 'Keep this original content',
      origin: { kind: 'user' },
    })

    const derivedPlan: TrustedProjectionPlanInput = {
      ...plan(`plan_${'b'.repeat(64)}`),
      taskId: 'task-derived',
      outputs: [{ ...plan().outputs[1]!, role: 'primary' }],
      taskProposals: [],
    }
    const materialized = applyCanvasCommand(derived, {
      type: 'MaterializeProjectionPlan',
      plan: derivedPlan,
    })
    expect(materialized.nodes.find(({ id }) => id === 'content-source')).toMatchObject({
      text: 'Keep this original content',
      origin: { kind: 'user' },
    })
    expect(materialized.nodes.map(({ id }) => id)).toContain(
      deterministicCanvasId('node', derivedPlan.planId, 'preview'),
    )

    const snapshot = structuredClone(initial)
    expect(() => applyCanvasCommand(initial, {
      type: 'CreateDerivedTaskFromSelection',
      task: task('failed-task'),
      sources: [{
        entity: { kind: 'node', id: 'missing-node' },
        relation: 'source',
        contextRole: 'full',
      }],
    })).toThrowError(CanvasCommandError)
    expect(initial).toEqual(snapshot)
  })

  it('keeps multi-step command failures atomic', () => {
    const initial = documentWithTask()
    initial.nodes.push(node('task-node', 140, 240, 'task-1'))
    const snapshot = structuredClone(initial)

    expect(() => applyCanvasCommand(initial, {
      type: 'CreateCollectionFromSelection',
      collection: {
        id: 'collection-1',
        title: 'Invalid nesting',
        anchor: { x: 0, y: 0 },
      },
      members: [{ kind: 'node', id: 'task-node' }],
    })).toThrowError(CanvasCommandError)
    expect(() => applyCanvasCommand(initial, {
      type: 'MoveEntities',
      entities: [{ kind: 'task', id: 'task-1' }],
      dx: Number.NaN,
      dy: 10,
    })).toThrowError(CanvasCommandError)
    expect(initial).toEqual(snapshot)
  })
})

function expectCanvasCommandError(run: () => unknown, code: string): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CanvasCommandError)
  expect(thrown).toMatchObject({ code })
}
