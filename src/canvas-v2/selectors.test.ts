import { describe, expect, it } from 'vitest'
import {
  collectionAccessibilityV2,
  deriveTaskContainerKindV2,
  deriveTaskPresentationV2,
  deriveTaskStatusV2,
  indexEdgesV2,
  layoutGhostOutputsV2,
  projectCollapsedCollectionEdgesV2,
  selectCollectionBoundsV2,
  selectCollectionMembersV2,
  selectContextEdgesV2,
  selectProposalReviewV2,
  selectTaskBoundsV2,
  selectTaskViewV2,
  taskChromeFrameV2,
  taskOutputFrameV2,
  type CanvasTaskRuntimeV2,
} from './selectors'
import {
  emptyCanvasDocumentV2,
  type CanvasDocumentV2,
  type CanvasEdgeV2,
  type CanvasNodeV2,
  type CanvasTaskV2,
} from './model'

const PLAN_ID = `plan_${'a'.repeat(64)}`

function task(id: string, x = 100, y = 120): CanvasTaskV2 {
  return {
    id,
    title: `Task ${id}`,
    goal: 'Create a rich result',
    anchor: { x, y },
    origin: { kind: 'user' },
  }
}

function node(
  id: string,
  x: number,
  y: number,
  options: { homeTaskId?: string; collectionId?: string; artifacts?: number } = {},
): CanvasNodeV2 {
  return {
    id,
    type: 'text',
    frame: { x, y, w: 400, h: 256, z: 1 },
    title: id,
    artifactRefs: Array.from({ length: options.artifacts ?? 0 }, (_, index) => ({
      runId: 'run-1',
      artifactId: `artifact_${id}_${index}`,
    })),
    ...(options.homeTaskId ? { homeTaskId: options.homeTaskId } : {}),
    ...(options.collectionId ? { collectionId: options.collectionId } : {}),
    origin: { kind: 'user' },
  }
}

function edge(
  id: string,
  from: CanvasEdgeV2['from'],
  to: CanvasEdgeV2['to'],
  contextRole: CanvasEdgeV2['contextRole'] = 'full',
): CanvasEdgeV2 {
  return {
    id,
    from,
    to,
    relation: 'source',
    contextRole,
    origin: { kind: 'user' },
  }
}

function runtime(
  phase: CanvasTaskRuntimeV2['phase'],
  overrides: Partial<CanvasTaskRuntimeV2> = {},
): CanvasTaskRuntimeV2 {
  return {
    taskId: 'task-1',
    phase,
    ghosts: [],
    ...overrides,
  }
}

describe('Canvas V2 task selectors', () => {
  it('derives a stable adaptive task view without changing semantic state', () => {
    const document = emptyCanvasDocumentV2()
    document.tasks.push(task('task-1'))
    document.nodes.push(node('existing', 148, 216, {
      homeTaskId: 'task-1',
      artifacts: 2,
    }))
    const before = structuredClone(document)
    const view = selectTaskViewV2(document, 'task-1', {
      zoom: 0.3,
      runtime: runtime('running', {
        progress: 1.4,
        ghosts: [{
          key: 'preview',
          title: 'Preview',
          phase: 'writing',
          progress: -0.3,
        }],
      }),
    })

    expect(view).not.toBeNull()
    expect(view?.status).toMatchObject({
      kind: 'generating',
      progress: 1,
      live: 'polite',
    })
    expect(view?.presentation).toBe('compact')
    expect(view?.containerKind).toBe('output-frame')
    expect(view?.artifactCount).toBe(2)
    expect(view?.ghosts).toEqual([{
      key: 'preview',
      title: 'Preview',
      phase: 'writing',
      progress: 0,
      frame: { x: 148, y: 216, w: 400, h: 256 },
    }])
    expect(view?.bounds).toEqual({ x: 136, y: 132, w: 424, h: 352 })
    expect(view?.accessibility.label).toContain('1 个产物节点')
    expect(view?.accessibility.liveMessage).toBe('Task task-1：生成中')
    expect(document).toEqual(before)
  })

  it('uses the materialization grid for deterministic ghost positions', () => {
    const subject = task('task-1', 20, 30)
    const ghosts = layoutGhostOutputsV2(subject, [
      { key: 'a', title: 'A', phase: 'discovered' },
      { key: 'b', title: 'B', phase: 'writing' },
      { key: 'c', title: 'C', phase: 'ready' },
    ])

    expect(ghosts.map((ghost) => ghost.frame)).toEqual([
      { x: 68, y: 126, w: 400, h: 256 },
      { x: 524, y: 126, w: 400, h: 256 },
      { x: 68, y: 430, w: 400, h: 256 },
    ])
    expect(taskOutputFrameV2(subject.anchor, 2)).toEqual(ghosts[2]?.frame)
  })

  it('keeps explicit collapse authoritative while surfacing active work otherwise', () => {
    const draft = deriveTaskStatusV2(undefined, [])
    const generating = deriveTaskStatusV2(runtime('running'), [])
    const failed = deriveTaskStatusV2(runtime('interrupted', { message: 'Connection lost' }), [])

    expect(deriveTaskPresentationV2(1, true, true, generating, 2)).toBe('collapsed')
    expect(deriveTaskPresentationV2(0.2, false, false, generating, 0)).toBe('compact')
    expect(deriveTaskPresentationV2(0.8, false, false, generating, 0)).toBe('expanded')
    expect(draft).toEqual({ kind: 'draft', label: '未运行', live: 'off' })
    expect(failed).toMatchObject({
      kind: 'failed',
      label: '运行失败',
      live: 'assertive',
      message: 'Connection lost',
    })
    expect(deriveTaskStatusV2(undefined, [node('done', 0, 0)]).kind).toBe('ready')
    expect([
      deriveTaskContainerKindV2(0),
      deriveTaskContainerKindV2(1),
      deriveTaskContainerKindV2(2),
    ]).toEqual(['task-card', 'title-strip', 'output-frame'])
  })

  it('attaches the task chrome above the primary output node', () => {
    const subject = task('task-1', 20, 30)
    const nodes = [
      node('later', 500, 300),
      node('primary', 148, 216),
    ]

    expect(taskChromeFrameV2(subject, nodes)).toEqual({
      x: 148,
      y: 216 - 64 - 8,
      w: 400,
      h: 64,
    })
    expect(taskChromeFrameV2(subject, [])).toEqual({
      x: 20,
      y: 30,
      w: 360,
      h: 156,
    })
    expect(taskChromeFrameV2(subject, nodes, [], 'collapsed')).toEqual({
      x: 20,
      y: 30,
      w: 360,
      h: 72,
    })
    expect(selectTaskBoundsV2(subject, nodes)).toEqual({
      x: 136,
      y: 132,
      w: 776,
      h: 436,
    })
  })
})

describe('Canvas V2 typed edges and collections', () => {
  it('indexes typed edges and excludes contextRole none from task context', () => {
    const document = emptyCanvasDocumentV2()
    document.tasks.push(task('task-1'))
    document.nodes.push(node('source', 0, 0), node('ignored', 0, 0))
    document.edges.push(
      edge('edge-full', { kind: 'node', id: 'source' }, { kind: 'task', id: 'task-1' }),
      edge(
        'edge-none',
        { kind: 'node', id: 'ignored' },
        { kind: 'task', id: 'task-1' },
        'none',
      ),
    )

    const index = indexEdgesV2(document)
    expect(index.incomingByEntity.get('task:task-1')?.map(({ id }) => id)).toEqual([
      'edge-full',
      'edge-none',
    ])
    expect(index.outgoingByEntity.get('node:source')?.[0]?.id).toBe('edge-full')
    expect(selectContextEdgesV2(document, { kind: 'task', id: 'task-1' })
      .map(({ id }) => id)).toEqual(['edge-full'])
  })

  it('bundles external edges at collapsed collections and hides internal edges', () => {
    const document = collectionDocument()
    document.edges.push(
      edge(
        'internal',
        { kind: 'node', id: 'task-output' },
        { kind: 'task', id: 'task-1' },
      ),
      edge(
        'external-a',
        { kind: 'node', id: 'task-output' },
        { kind: 'node', id: 'outside' },
      ),
      edge(
        'external-b',
        { kind: 'node', id: 'loose-member' },
        { kind: 'node', id: 'outside' },
      ),
    )

    const projection = projectCollapsedCollectionEdgesV2(
      document,
      new Set(['collection-1']),
    )

    expect(projection.hiddenEdgeIds).toEqual(['internal'])
    expect(projection.bundles).toEqual([{
      key: 'collection:collection-1\u001fnode:outside\u001fsource\u001ffull',
      from: { kind: 'collection', id: 'collection-1' },
      to: { kind: 'node', id: 'outside' },
      relation: 'source',
      contextRole: 'full',
      edgeIds: ['external-a', 'external-b'],
    }])
  })

  it('includes task descendants in collection bounds but counts only direct members', () => {
    const document = collectionDocument()
    const members = selectCollectionMembersV2(document, 'collection-1')

    expect(members.tasks.map(({ id }) => id)).toEqual(['task-1'])
    expect(members.nodes.map(({ id }) => id)).toEqual(['loose-member'])
    expect(selectCollectionBoundsV2(document, 'collection-1')).toEqual({
      x: 20,
      y: 80,
      w: 1000,
      h: 580,
    })
    expect(collectionAccessibilityV2('Research', members, true).label)
      .toBe('集合：Research，已折叠，1 个任务，1 个独立节点')
  })
})

describe('Canvas V2 proposal review', () => {
  it('derives pending, accepted, and dismissed suggestions from receipts', () => {
    const document = emptyCanvasDocumentV2()
    document.receipts.push(
      {
        kind: 'proposal-acceptance',
        planId: PLAN_ID,
        runId: 'run-1',
        taskId: 'task-1',
        proposals: [{ proposalKey: 'translate', taskId: 'task-translate' }],
      },
      {
        kind: 'plan-dismissal',
        planId: PLAN_ID,
        runId: 'run-1',
        taskId: 'task-1',
        proposalKeys: ['export'],
      },
    )

    const review = selectProposalReviewV2(
      document,
      PLAN_ID,
      ['translate', 'export', 'explain', 'translate'],
    )

    expect(review).toEqual({
      planId: PLAN_ID,
      state: 'mixed',
      items: [
        { proposalKey: 'translate', state: 'accepted', acceptedTaskId: 'task-translate' },
        { proposalKey: 'export', state: 'dismissed' },
        { proposalKey: 'explain', state: 'pending' },
      ],
      pendingCount: 1,
      acceptedCount: 1,
      dismissedCount: 1,
    })
  })
})

function collectionDocument(): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
  document.collections.push({
    id: 'collection-1',
    title: 'Research',
    anchor: { x: 20, y: 80 },
  })
  document.tasks.push({ ...task('task-1', 100, 120), collectionId: 'collection-1' })
  document.nodes.push(
    node('task-output', 148, 216, { homeTaskId: 'task-1' }),
    node('loose-member', 588, 372, { collectionId: 'collection-1' }),
    node('outside', 1200, 200),
  )
  return document
}
