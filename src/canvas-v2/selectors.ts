import {
  entityKeyV2,
  type CanvasDocumentV2,
  type CanvasEdgeContextRoleV2,
  type CanvasEdgeRelationV2,
  type CanvasEdgeV2,
  type CanvasEntityRef,
  type CanvasNodeV2,
  type CanvasTaskV2,
} from './model'
import { taskOutputFrameV2 } from './layout'

export { TASK_OUTPUT_LAYOUT_V2, taskOutputFrameV2 } from './layout'

export interface CanvasBoundsV2 {
  x: number
  y: number
  w: number
  h: number
}

export type CanvasTaskRunPhaseV2 =
  | 'draft'
  | 'queued'
  | 'running'
  | 'awaiting-permission'
  | 'done'
  | 'partial'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export type CanvasGhostOutputPhaseV2 = 'discovered' | 'writing' | 'ready'

export interface CanvasGhostOutputV2 {
  key: string
  title: string
  pluginId?: string
  role?: 'primary' | 'supporting' | 'auxiliary'
  phase: CanvasGhostOutputPhaseV2
  progress?: number
}

export interface CanvasTaskRuntimeV2 {
  taskId: string
  runId?: string
  phase: CanvasTaskRunPhaseV2
  progress?: number
  message?: string
  ghosts: CanvasGhostOutputV2[]
}

export interface CanvasGhostLayoutV2 extends CanvasGhostOutputV2 {
  frame: CanvasBoundsV2
}

export type CanvasTaskPresentationV2 = 'expanded' | 'compact' | 'collapsed'

export type CanvasTaskContainerKindV2 = 'task-card' | 'title-strip' | 'output-frame'

export type CanvasTaskStatusKindV2 =
  | 'draft'
  | 'queued'
  | 'generating'
  | 'needs-attention'
  | 'ready'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled'

export interface CanvasTaskStatusV2 {
  kind: CanvasTaskStatusKindV2
  label: string
  progress?: number
  message?: string
  live: 'off' | 'polite' | 'assertive'
}

export interface CanvasProposalReviewItemV2 {
  proposalKey: string
  state: 'pending' | 'accepted' | 'dismissed'
  acceptedTaskId?: string
}

export interface CanvasProposalReviewV2 {
  planId: string
  state: 'empty' | 'pending' | 'accepted' | 'dismissed' | 'mixed'
  items: CanvasProposalReviewItemV2[]
  pendingCount: number
  acceptedCount: number
  dismissedCount: number
}

export interface CanvasTaskAccessibilityV2 {
  label: string
  live: CanvasTaskStatusV2['live']
  liveMessage: string | null
}

export interface CanvasTaskViewOptionsV2 {
  zoom: number
  selected?: boolean
  explicitlyCollapsed?: boolean
  runtime?: CanvasTaskRuntimeV2
  proposalReview?: CanvasProposalReviewV2
}

export interface CanvasTaskViewV2 {
  task: CanvasTaskV2
  nodes: CanvasNodeV2[]
  edges: CanvasEdgeV2[]
  ghosts: CanvasGhostLayoutV2[]
  bounds: CanvasBoundsV2
  containerKind: CanvasTaskContainerKindV2
  presentation: CanvasTaskPresentationV2
  status: CanvasTaskStatusV2
  artifactCount: number
  accessibility: CanvasTaskAccessibilityV2
}

export interface CanvasEdgeIndexV2 {
  byId: ReadonlyMap<string, CanvasEdgeV2>
  incomingByEntity: ReadonlyMap<string, CanvasEdgeV2[]>
  outgoingByEntity: ReadonlyMap<string, CanvasEdgeV2[]>
}

export type CanvasVisualEntityRefV2 =
  | CanvasEntityRef
  | { kind: 'collection'; id: string }

export interface CanvasVisualEdgeBundleV2 {
  key: string
  from: CanvasVisualEntityRefV2
  to: CanvasVisualEntityRefV2
  relation: CanvasEdgeRelationV2
  contextRole: CanvasEdgeContextRoleV2
  edgeIds: string[]
}

export interface CanvasCollapsedEdgeProjectionV2 {
  bundles: CanvasVisualEdgeBundleV2[]
  hiddenEdgeIds: string[]
}

export interface CanvasCollectionMembersV2 {
  tasks: CanvasTaskV2[]
  nodes: CanvasNodeV2[]
}

export interface CanvasCollectionAccessibilityV2 {
  label: string
}

export function layoutGhostOutputsV2(
  task: CanvasTaskV2,
  ghosts: readonly CanvasGhostOutputV2[],
): CanvasGhostLayoutV2[] {
  return ghosts.map((ghost, index) => ({
    ...ghost,
    ...(ghost.progress === undefined ? {} : { progress: clampProgress(ghost.progress) }),
    frame: taskOutputFrameV2(task.anchor, index),
  }))
}

export function selectTaskNodesV2(
  document: CanvasDocumentV2,
  taskId: string,
): CanvasNodeV2[] {
  return document.nodes.filter((node) => node.homeTaskId === taskId)
}

export function selectTaskEdgesV2(
  document: CanvasDocumentV2,
  taskId: string,
): CanvasEdgeV2[] {
  const nodeIds = new Set(selectTaskNodesV2(document, taskId).map((node) => node.id))
  return document.edges.filter((edge) => edgeTouchesTask(edge, taskId, nodeIds))
}

export function selectTaskBoundsV2(
  task: CanvasTaskV2,
  nodes: readonly CanvasNodeV2[],
  ghosts: readonly CanvasGhostLayoutV2[] = [],
): CanvasBoundsV2 {
  const base: CanvasBoundsV2 = {
    x: task.anchor.x,
    y: task.anchor.y,
    w: 360,
    h: 80,
  }
  const children: CanvasBoundsV2[] = [
    ...nodes.map(({ frame }) => frame),
    ...ghosts.map(({ frame }) => frame),
  ]
  if (children.length === 0) return base
  const content = boundsOf(children)
  const x = Math.min(base.x, content.x - 24)
  const y = Math.min(base.y, content.y - 24)
  const right = Math.max(base.x + base.w, content.x + content.w + 24)
  const bottom = Math.max(base.y + base.h, content.y + content.h + 24)
  return {
    x,
    y,
    w: right - x,
    h: bottom - y,
  }
}

export function deriveTaskStatusV2(
  runtime: CanvasTaskRuntimeV2 | undefined,
  nodes: readonly CanvasNodeV2[] = [],
): CanvasTaskStatusV2 {
  if (!runtime || runtime.phase === 'draft') {
    return nodes.length > 0
      ? { kind: 'ready', label: '已有产物', live: 'off' }
      : { kind: 'draft', label: '未运行', live: 'off' }
  }

  const progress = runtime.progress === undefined
    ? undefined
    : clampProgress(runtime.progress)
  const detail = {
    ...(progress === undefined ? {} : { progress }),
    ...(runtime.message ? { message: runtime.message } : {}),
  }
  switch (runtime.phase) {
    case 'queued':
      return { kind: 'queued', label: '等待运行', live: 'polite', ...detail }
    case 'running':
      return { kind: 'generating', label: '生成中', live: 'polite', ...detail }
    case 'awaiting-permission':
      return { kind: 'needs-attention', label: '等待确认', live: 'assertive', ...detail }
    case 'done':
      return { kind: 'done', label: '已完成', live: 'polite', ...detail }
    case 'partial':
      return { kind: 'partial', label: '部分完成', live: 'assertive', ...detail }
    case 'error':
    case 'interrupted':
      return { kind: 'failed', label: '运行失败', live: 'assertive', ...detail }
    case 'cancelled':
      return { kind: 'cancelled', label: '已取消', live: 'polite', ...detail }
  }
}

export function deriveTaskPresentationV2(
  zoom: number,
  selected: boolean,
  explicitlyCollapsed: boolean,
  status: CanvasTaskStatusV2,
  ghostCount: number,
): CanvasTaskPresentationV2 {
  if (explicitlyCollapsed) return 'collapsed'
  if (selected || zoom >= 0.72) return 'expanded'
  const active = status.kind === 'queued'
    || status.kind === 'generating'
    || status.kind === 'needs-attention'
    || status.kind === 'partial'
    || status.kind === 'failed'
  if (active || ghostCount > 0 || zoom >= 0.42) return 'compact'
  return 'collapsed'
}

export function deriveTaskContainerKindV2(
  outputCount: number,
): CanvasTaskContainerKindV2 {
  if (outputCount <= 0) return 'task-card'
  if (outputCount === 1) return 'title-strip'
  return 'output-frame'
}

export function selectTaskViewV2(
  document: CanvasDocumentV2,
  taskId: string,
  options: CanvasTaskViewOptionsV2,
): CanvasTaskViewV2 | null {
  const task = document.tasks.find((entry) => entry.id === taskId)
  if (!task) return null
  const runtime = options.runtime?.taskId === taskId ? options.runtime : undefined
  const nodes = selectTaskNodesV2(document, taskId)
  const ghosts = layoutGhostOutputsV2(task, runtime?.ghosts ?? [])
  const status = deriveTaskStatusV2(runtime, nodes)
  const artifactCount = new Set(nodes.flatMap((node) => node.artifactRefs.map((artifact) =>
    `${artifact.runId}\u001f${artifact.artifactId}`))).size
  const accessibility = taskAccessibilityV2(
    task,
    status,
    nodes.length,
    artifactCount,
    options.proposalReview?.pendingCount ?? 0,
  )
  return {
    task,
    nodes,
    edges: selectTaskEdgesV2(document, taskId),
    ghosts,
    bounds: selectTaskBoundsV2(task, nodes, ghosts),
    containerKind: deriveTaskContainerKindV2(nodes.length + ghosts.length),
    presentation: deriveTaskPresentationV2(
      options.zoom,
      options.selected ?? false,
      options.explicitlyCollapsed ?? false,
      status,
      ghosts.length,
    ),
    status,
    artifactCount,
    accessibility,
  }
}

export function indexEdgesV2(document: CanvasDocumentV2): CanvasEdgeIndexV2 {
  const byId = new Map<string, CanvasEdgeV2>()
  const incomingByEntity = new Map<string, CanvasEdgeV2[]>()
  const outgoingByEntity = new Map<string, CanvasEdgeV2[]>()
  for (const edge of document.edges) {
    byId.set(edge.id, edge)
    appendMapValue(outgoingByEntity, entityKeyV2(edge.from), edge)
    appendMapValue(incomingByEntity, entityKeyV2(edge.to), edge)
  }
  return { byId, incomingByEntity, outgoingByEntity }
}

export function selectContextEdgesV2(
  document: CanvasDocumentV2,
  target: CanvasEntityRef,
): CanvasEdgeV2[] {
  return document.edges.filter((edge) =>
    entityKeyV2(edge.to) === entityKeyV2(target) && edge.contextRole !== 'none')
}

export function selectCollectionMembersV2(
  document: CanvasDocumentV2,
  collectionId: string,
): CanvasCollectionMembersV2 {
  return {
    tasks: document.tasks.filter((task) => task.collectionId === collectionId),
    nodes: document.nodes.filter((node) => node.collectionId === collectionId),
  }
}

export function selectCollectionBoundsV2(
  document: CanvasDocumentV2,
  collectionId: string,
): CanvasBoundsV2 | null {
  const collection = document.collections.find((entry) => entry.id === collectionId)
  if (!collection) return null
  const members = selectCollectionMembersV2(document, collectionId)
  const memberBounds: CanvasBoundsV2[] = [
    ...members.nodes.map(({ frame }) => frame),
    ...members.tasks.map((task) => selectTaskBoundsV2(
      task,
      selectTaskNodesV2(document, task.id),
    )),
  ]
  if (memberBounds.length === 0) {
    return { x: collection.anchor.x, y: collection.anchor.y, w: 320, h: 64 }
  }
  const content = boundsOf(memberBounds)
  const x = Math.min(collection.anchor.x, content.x - 32)
  const y = Math.min(collection.anchor.y, content.y - 32)
  return {
    x,
    y,
    w: Math.max(collection.anchor.x + 320, content.x + content.w + 32) - x,
    h: Math.max(collection.anchor.y + 64, content.y + content.h + 32) - y,
  }
}

export function projectCollapsedCollectionEdgesV2(
  document: CanvasDocumentV2,
  collapsedCollectionIds: ReadonlySet<string>,
): CanvasCollapsedEdgeProjectionV2 {
  const existingCollapsedIds = new Set(document.collections
    .map((collection) => collection.id)
    .filter((id) => collapsedCollectionIds.has(id)))
  const bundlesByKey = new Map<string, CanvasVisualEdgeBundleV2>()
  const hiddenEdgeIds: string[] = []

  for (const edge of document.edges) {
    const from = visualEndpointV2(document, edge.from, existingCollapsedIds)
    const to = visualEndpointV2(document, edge.to, existingCollapsedIds)
    if (from.kind === 'collection' && to.kind === 'collection' && from.id === to.id) {
      hiddenEdgeIds.push(edge.id)
      continue
    }
    const key = [
      visualEntityKeyV2(from),
      visualEntityKeyV2(to),
      edge.relation,
      edge.contextRole,
    ].join('\u001f')
    const existing = bundlesByKey.get(key)
    if (existing) {
      existing.edgeIds.push(edge.id)
      continue
    }
    bundlesByKey.set(key, {
      key,
      from,
      to,
      relation: edge.relation,
      contextRole: edge.contextRole,
      edgeIds: [edge.id],
    })
  }

  return {
    bundles: [...bundlesByKey.values()],
    hiddenEdgeIds,
  }
}

export function selectProposalReviewV2(
  document: CanvasDocumentV2,
  planId: string,
  proposalKeys: readonly string[],
): CanvasProposalReviewV2 {
  const acceptedTaskByKey = new Map<string, string>()
  const dismissedKeys = new Set<string>()
  for (const receipt of document.receipts) {
    if (receipt.planId !== planId) continue
    if (receipt.kind === 'proposal-acceptance') {
      for (const proposal of receipt.proposals) {
        acceptedTaskByKey.set(proposal.proposalKey, proposal.taskId)
      }
    } else if (receipt.kind === 'plan-dismissal') {
      for (const key of receipt.proposalKeys) dismissedKeys.add(key)
    } else {
      for (const key of receipt.dismissedProposalKeys) dismissedKeys.add(key)
    }
  }

  const uniqueKeys = [...new Set(proposalKeys)]
  const items = uniqueKeys.map((proposalKey): CanvasProposalReviewItemV2 => {
    const acceptedTaskId = acceptedTaskByKey.get(proposalKey)
    if (acceptedTaskId) return { proposalKey, state: 'accepted', acceptedTaskId }
    if (dismissedKeys.has(proposalKey)) return { proposalKey, state: 'dismissed' }
    return { proposalKey, state: 'pending' }
  })
  const pendingCount = items.filter((item) => item.state === 'pending').length
  const acceptedCount = items.filter((item) => item.state === 'accepted').length
  const dismissedCount = items.filter((item) => item.state === 'dismissed').length
  return {
    planId,
    state: proposalReviewState(items),
    items,
    pendingCount,
    acceptedCount,
    dismissedCount,
  }
}

export function taskAccessibilityV2(
  task: CanvasTaskV2,
  status: CanvasTaskStatusV2,
  outputCount: number,
  artifactCount: number,
  pendingProposalCount: number,
): CanvasTaskAccessibilityV2 {
  const label = [
    `任务：${task.title}`,
    `状态：${status.label}`,
    `${outputCount} 个产物节点`,
    `${artifactCount} 个文件产物`,
    `${pendingProposalCount} 个待处理建议`,
  ].join('，')
  return {
    label,
    live: status.live,
    liveMessage: status.live === 'off'
      ? null
      : `${task.title}：${status.message ?? status.label}`,
  }
}

export function collectionAccessibilityV2(
  title: string,
  members: CanvasCollectionMembersV2,
  collapsed: boolean,
): CanvasCollectionAccessibilityV2 {
  return {
    label: [
      `集合：${title}`,
      collapsed ? '已折叠' : '已展开',
      `${members.tasks.length} 个任务`,
      `${members.nodes.length} 个独立节点`,
    ].join('，'),
  }
}

function boundsOf(bounds: readonly CanvasBoundsV2[]): CanvasBoundsV2 {
  const left = Math.min(...bounds.map((entry) => entry.x))
  const top = Math.min(...bounds.map((entry) => entry.y))
  const right = Math.max(...bounds.map((entry) => entry.x + entry.w))
  const bottom = Math.max(...bounds.map((entry) => entry.y + entry.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

function edgeTouchesTask(
  edge: CanvasEdgeV2,
  taskId: string,
  nodeIds: ReadonlySet<string>,
): boolean {
  return refTouchesTask(edge.from, taskId, nodeIds)
    || refTouchesTask(edge.to, taskId, nodeIds)
}

function refTouchesTask(
  ref: CanvasEntityRef,
  taskId: string,
  nodeIds: ReadonlySet<string>,
): boolean {
  return ref.kind === 'task' ? ref.id === taskId : nodeIds.has(ref.id)
}

function appendMapValue(
  map: Map<string, CanvasEdgeV2[]>,
  key: string,
  edge: CanvasEdgeV2,
): void {
  const values = map.get(key)
  if (values) values.push(edge)
  else map.set(key, [edge])
}

function visualEndpointV2(
  document: CanvasDocumentV2,
  ref: CanvasEntityRef,
  collapsedCollectionIds: ReadonlySet<string>,
): CanvasVisualEntityRefV2 {
  const collectionId = collectionIdForRefV2(document, ref)
  return collectionId && collapsedCollectionIds.has(collectionId)
    ? { kind: 'collection', id: collectionId }
    : ref
}

function collectionIdForRefV2(
  document: CanvasDocumentV2,
  ref: CanvasEntityRef,
): string | undefined {
  if (ref.kind === 'task') {
    return document.tasks.find((task) => task.id === ref.id)?.collectionId
  }
  const node = document.nodes.find((entry) => entry.id === ref.id)
  if (!node) return undefined
  if (node.collectionId) return node.collectionId
  if (!node.homeTaskId) return undefined
  return document.tasks.find((task) => task.id === node.homeTaskId)?.collectionId
}

function visualEntityKeyV2(ref: CanvasVisualEntityRefV2): string {
  return `${ref.kind}:${ref.id}`
}

function proposalReviewState(
  items: readonly CanvasProposalReviewItemV2[],
): CanvasProposalReviewV2['state'] {
  if (items.length === 0) return 'empty'
  const states = new Set(items.map((item) => item.state))
  if (states.size > 1) return 'mixed'
  const state = items[0]?.state
  if (state === 'accepted' || state === 'dismissed' || state === 'pending') return state
  return 'empty'
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.min(1, Math.max(0, progress))
}
