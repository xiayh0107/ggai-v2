import { describe, expect, it } from 'vitest'
import {
  collectionAccessibility,
  deriveTaskContainerKind,
  deriveTaskPresentation,
  deriveTaskStatus,
  indexEdges,
  layoutGhostOutputs,
  projectCollapsedCollectionEdges,
  selectCollectionBounds,
  selectCollectionMembers,
  selectContextEdges,
  selectProposalReview,
  selectTaskBounds,
  selectTaskView,
  taskChromeFrame,
  taskOutputFrame,
  type CanvasTaskRuntime,
} from './selectors'
import {
  emptyCanvasDocument,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode,
  type CanvasTask,
} from './model'

const PLAN_ID = `plan_${'a'.repeat(64)}`

function task(id: string, x = 100, y = 120): CanvasTask {
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
): CanvasNode {
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
  from: CanvasEdge['from'],
  to: CanvasEdge['to'],
  contextRole: CanvasEdge['contextRole'] = 'full',
): CanvasEdge {
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
  phase: CanvasTaskRuntime['phase'],
  overrides: Partial<CanvasTaskRuntime> = {},
): CanvasTaskRuntime {
  return {
    taskId: 'task-1',
    phase,
    ghosts: [],
    ...overrides,
  }
}

describe('Canvas task selectors', () => {
  it('derives a stable adaptive task view without changing semantic state', () => {
    const document = emptyCanvasDocument()
    document.tasks.push(task('task-1'))
    document.nodes.push(node('existing', 148, 216, {
      homeTaskId: 'task-1',
      artifacts: 2,
    }))
    const before = structuredClone(document)
    const view = selectTaskView(document, 'task-1', {
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
    expect(view?.presentation).toBe('expanded')
    expect(view?.containerKind).toBe('output-frame')
    expect(view?.artifactCount).toBe(2)
    // ghost 接续既有产物节点的网格位（index = 节点数），不再叠回锚点第一格
    expect(view?.ghosts).toEqual([{
      key: 'preview',
      title: 'Preview',
      phase: 'writing',
      progress: 0,
      frame: { x: 604, y: 216, w: 400, h: 256 },
    }])
    expect(view?.bounds).toEqual({ x: 136, y: 132, w: 880, h: 352 })
    expect(view?.accessibility.label).toContain('1 个产物节点')
    expect(view?.accessibility.liveMessage).toBe('Task task-1：生成中')
    expect(document).toEqual(before)
  })

  it('uses the materialization grid for deterministic ghost positions', () => {
    const subject = task('task-1', 20, 30)
    const ghosts = layoutGhostOutputs(subject, [
      { key: 'a', title: 'A', phase: 'discovered' },
      { key: 'b', title: 'B', phase: 'writing' },
      { key: 'c', title: 'C', phase: 'ready' },
    ])

    expect(ghosts.map((ghost) => ghost.frame)).toEqual([
      { x: 68, y: 126, w: 400, h: 256 },
      { x: 524, y: 126, w: 400, h: 256 },
      { x: 68, y: 430, w: 400, h: 256 },
    ])
    expect(taskOutputFrame(subject.anchor, 2)).toEqual(ghosts[2]?.frame)
  })

  it('projects an anonymous output surface as soon as a zero-output task starts', () => {
    const document = emptyCanvasDocument()
    document.tasks.push(task('task-1', 20, 30))

    const queued = selectTaskView(document, 'task-1', {
      zoom: 1,
      runtime: runtime('queued'),
    })
    const running = selectTaskView(document, 'task-1', {
      zoom: 1,
      runtime: runtime('running'),
    })
    const draft = selectTaskView(document, 'task-1', { zoom: 1 })

    for (const view of [queued, running]) {
      expect(view?.containerKind).toBe('title-strip')
      expect(view?.ghosts).toEqual([{
        key: 'pending-output:task-1',
        title: '生成结果',
        phase: 'writing',
        provisional: true,
        frame: taskOutputFrame({ x: 20, y: 30 }, 0),
      }])
    }
    expect(draft?.containerKind).toBe('task-card')
    expect(draft?.ghosts).toEqual([])
  })

  it('keeps explicit collapse as the only folded presentation', () => {
    const draft = deriveTaskStatus(undefined, [])
    const failed = deriveTaskStatus(runtime('interrupted', { message: 'Connection lost' }), [])

    expect(deriveTaskPresentation(true)).toBe('collapsed')
    expect(deriveTaskPresentation(false)).toBe('expanded')
    expect(draft).toEqual({ kind: 'draft', label: '未运行', live: 'off' })
    expect(failed).toMatchObject({
      kind: 'failed',
      label: '运行失败',
      live: 'assertive',
      message: 'Connection lost',
    })
    expect(deriveTaskStatus(undefined, [node('done', 0, 0)]).kind).toBe('ready')
    expect([
      deriveTaskContainerKind(0),
      deriveTaskContainerKind(1),
      deriveTaskContainerKind(2),
    ]).toEqual(['task-card', 'title-strip', 'output-frame'])
  })

  it('attaches the task chrome above the primary output node', () => {
    const subject = task('task-1', 20, 30)
    const nodes = [
      node('later', 500, 300),
      node('primary', 148, 216),
    ]

    expect(taskChromeFrame(subject, nodes)).toEqual({
      x: 148,
      y: 216 - 64 - 8,
      w: 400,
      h: 64,
    })
    expect(taskChromeFrame(subject, [])).toEqual({
      x: 20,
      y: 30,
      w: 360,
      h: 156,
    })
    expect(taskChromeFrame(subject, nodes, [], 'collapsed')).toEqual({
      x: 20,
      y: 30,
      w: 360,
      h: 72,
    })
    expect(selectTaskBounds(subject, nodes)).toEqual({
      x: 136,
      y: 132,
      w: 776,
      h: 436,
    })
  })
})

describe('Canvas typed edges and collections', () => {
  it('indexes typed edges and excludes contextRole none from task context', () => {
    const document = emptyCanvasDocument()
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

    const index = indexEdges(document)
    expect(index.incomingByEntity.get('task:task-1')?.map(({ id }) => id)).toEqual([
      'edge-full',
      'edge-none',
    ])
    expect(index.outgoingByEntity.get('node:source')?.[0]?.id).toBe('edge-full')
    expect(selectContextEdges(document, { kind: 'task', id: 'task-1' })
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

    const projection = projectCollapsedCollectionEdges(
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
    const members = selectCollectionMembers(document, 'collection-1')

    expect(members.tasks.map(({ id }) => id)).toEqual(['task-1'])
    expect(members.nodes.map(({ id }) => id)).toEqual(['loose-member'])
    expect(selectCollectionBounds(document, 'collection-1')).toEqual({
      x: 20,
      y: 80,
      w: 1000,
      h: 580,
    })
    expect(collectionAccessibility('Research', members, true).label)
      .toBe('集合：Research，已折叠，1 个任务，1 个独立节点')
  })
})

describe('Canvas proposal review', () => {
  it('derives pending, accepted, and dismissed suggestions from receipts', () => {
    const document = emptyCanvasDocument()
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

    const review = selectProposalReview(
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

function collectionDocument(): CanvasDocument {
  const document = emptyCanvasDocument()
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
