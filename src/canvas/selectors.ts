import {
  entityKey,
  type CanvasDocument,
  type CanvasEdgeContextRole,
  type CanvasEdgeRelation,
  type CanvasEdge,
  type CanvasEntityRef,
  type CanvasNode,
  type CanvasTask,
} from './model'
import { TASK_CHROME_LAYOUT, taskOutputFrame } from './layout'

export { TASK_OUTPUT_LAYOUT, taskOutputFrame } from './layout'

export interface CanvasBounds {
  x: number
  y: number
  w: number
  h: number
}

export type CanvasTaskRunPhase =
  | 'draft'
  | 'queued'
  | 'running'
  | 'awaiting-permission'
  | 'done'
  | 'partial'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export type CanvasGhostOutputPhase = 'discovered' | 'writing' | 'ready'

export interface CanvasGhostOutput {
  key: string
  title: string
  /** Optional durable output-slot identity supplied by file-write events. */
  nodeId?: string
  pluginId?: string
  /**
   * Run 已启动、但 Agent 尚未声明具体产物时由 selector 投射的临时输出面。
   * 它只负责稳定生成阶段的视觉位置，不是持久 Node，也不猜测插件类型。
   */
  provisional?: boolean
  role?: 'primary' | 'supporting' | 'auxiliary'
  phase: CanvasGhostOutputPhase
  progress?: number
}

export interface CanvasTaskRuntime {
  taskId: string
  runId?: string
  phase: CanvasTaskRunPhase
  progress?: number
  message?: string
  ghosts: CanvasGhostOutput[]
}

export interface CanvasGhostLayout extends CanvasGhostOutput {
  frame: CanvasBounds
}

export type CanvasTaskPresentation = 'expanded' | 'compact' | 'collapsed'

export type CanvasTaskContainerKind = 'task-card' | 'title-strip' | 'output-frame'

export type CanvasTaskStatusKind =
  | 'draft'
  | 'queued'
  | 'generating'
  | 'needs-attention'
  | 'ready'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled'

export interface CanvasTaskStatus {
  kind: CanvasTaskStatusKind
  label: string
  progress?: number
  message?: string
  live: 'off' | 'polite' | 'assertive'
}

export interface CanvasProposalReviewItem {
  proposalKey: string
  state: 'pending' | 'accepted' | 'dismissed'
  acceptedTaskId?: string
}

export interface CanvasProposalReview {
  planId: string
  state: 'empty' | 'pending' | 'accepted' | 'dismissed' | 'mixed'
  items: CanvasProposalReviewItem[]
  pendingCount: number
  acceptedCount: number
  dismissedCount: number
}

export interface CanvasTaskAccessibility {
  label: string
  live: CanvasTaskStatus['live']
  liveMessage: string | null
}

export interface CanvasTaskViewOptions {
  zoom: number
  selected?: boolean
  explicitlyCollapsed?: boolean
  runtime?: CanvasTaskRuntime
  proposalReview?: CanvasProposalReview
}

export interface CanvasTaskView {
  task: CanvasTask
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  ghosts: CanvasGhostLayout[]
  bounds: CanvasBounds
  containerKind: CanvasTaskContainerKind
  presentation: CanvasTaskPresentation
  status: CanvasTaskStatus
  artifactCount: number
  accessibility: CanvasTaskAccessibility
}

export interface CanvasEdgeIndex {
  byId: ReadonlyMap<string, CanvasEdge>
  incomingByEntity: ReadonlyMap<string, CanvasEdge[]>
  outgoingByEntity: ReadonlyMap<string, CanvasEdge[]>
}

export type CanvasVisualEntityRef =
  | CanvasEntityRef
  | { kind: 'collection'; id: string }

export interface CanvasVisualEdgeBundle {
  key: string
  from: CanvasVisualEntityRef
  to: CanvasVisualEntityRef
  relation: CanvasEdgeRelation
  contextRole: CanvasEdgeContextRole
  edgeIds: string[]
}

export interface CanvasCollapsedEdgeProjection {
  bundles: CanvasVisualEdgeBundle[]
  hiddenEdgeIds: string[]
}

export interface CanvasCollectionMembers {
  tasks: CanvasTask[]
  nodes: CanvasNode[]
}

export interface CanvasCollectionAccessibility {
  label: string
}

/** 节点是否已有可作用的内容：产物、正文或非空 payload（含文本标记预设）。 */
export function nodeHasVisibleContent(node: CanvasNode): boolean {
  return node.artifactRefs.length > 0
    || (node.text !== undefined && node.text.trim().length > 0)
    || (node.payload !== undefined && Object.keys(node.payload).length > 0)
}

export function layoutGhostOutputs(
  task: CanvasTask,
  ghosts: readonly CanvasGhostOutput[],
  nodeCount = 0,
): CanvasGhostLayout[] {
  return ghosts.map((ghost, index) => ({
    ...ghost,
    ...(ghost.progress === undefined ? {} : { progress: clampProgress(ghost.progress) }),
    // 接续既有产物节点的网格位置，而不是叠回任务锚点的第一格
    frame: taskOutputFrame(task.anchor, nodeCount + index),
  }))
}

export function selectTaskNodes(
  document: CanvasDocument,
  taskId: string,
): CanvasNode[] {
  return document.nodes.filter((node) => node.homeTaskId === taskId)
}

export function selectTaskEdges(
  document: CanvasDocument,
  taskId: string,
): CanvasEdge[] {
  const nodeIds = new Set(selectTaskNodes(document, taskId).map((node) => node.id))
  return document.edges.filter((edge) => edgeTouchesTask(edge, taskId, nodeIds))
}

/**
 * Node-centric chrome: the Task title strip attaches directly above the
 * top-most (then left-most) output Node instead of floating at the anchor.
 */
export const TASK_CHROME_GAP = 8

export function taskPrimaryOutputFrame(
  nodes: readonly CanvasNode[],
  ghosts: readonly CanvasGhostLayout[] = [],
): CanvasBounds | null {
  const frames: CanvasBounds[] = [
    ...nodes.map(({ frame }) => frame),
    ...ghosts.map(({ frame }) => frame),
  ]
  if (frames.length === 0) return null
  return frames.reduce((primary, frame) =>
    frame.y < primary.y || (frame.y === primary.y && frame.x < primary.x)
      ? frame
      : primary)
}

export function taskChromeFrame(
  task: CanvasTask,
  nodes: readonly CanvasNode[],
  ghosts: readonly CanvasGhostLayout[] = [],
  presentation: CanvasTaskPresentation = 'expanded',
): CanvasBounds {
  if (presentation === 'collapsed') {
    return {
      x: task.anchor.x,
      y: task.anchor.y,
      w: TASK_CHROME_LAYOUT.collapsedWidth,
      h: TASK_CHROME_LAYOUT.collapsedHeight,
    }
  }
  const primary = taskPrimaryOutputFrame(nodes, ghosts)
  if (!primary) {
    return {
      x: task.anchor.x,
      y: task.anchor.y,
      w: TASK_CHROME_LAYOUT.cardWidth,
      h: presentation === 'compact'
        ? TASK_CHROME_LAYOUT.compactHeight
        : TASK_CHROME_LAYOUT.cardHeight,
    }
  }
  return {
    x: primary.x,
    y: primary.y - TASK_CHROME_LAYOUT.titleStripHeight - TASK_CHROME_GAP,
    w: primary.w,
    h: TASK_CHROME_LAYOUT.titleStripHeight,
  }
}

export function selectTaskBounds(
  task: CanvasTask,
  nodes: readonly CanvasNode[],
  ghosts: readonly CanvasGhostLayout[] = [],
): CanvasBounds {
  const chrome = taskChromeFrame(task, nodes, ghosts)
  const children: CanvasBounds[] = [
    ...nodes.map(({ frame }) => frame),
    ...ghosts.map(({ frame }) => frame),
  ]
  if (children.length === 0) return chrome
  const content = boundsOf([chrome, ...children])
  const padding = 12
  return {
    x: content.x - padding,
    y: content.y - padding,
    w: content.w + padding * 2,
    h: content.h + padding * 2,
  }
}

export function deriveTaskStatus(
  runtime: CanvasTaskRuntime | undefined,
  nodes: readonly CanvasNode[] = [],
): CanvasTaskStatus {
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

export function deriveTaskPresentation(
  explicitlyCollapsed: boolean,
): CanvasTaskPresentation {
  // 缩放不再降级展示：缩小画布时产物预览与「打开产物」入口保持可见（与旧版一致），
  // 只有用户显式收起才折叠成卡片。
  return explicitlyCollapsed ? 'collapsed' : 'expanded'
}

export function deriveTaskContainerKind(
  outputCount: number,
): CanvasTaskContainerKind {
  if (outputCount <= 0) return 'task-card'
  if (outputCount === 1) return 'title-strip'
  return 'output-frame'
}

export function selectTaskView(
  document: CanvasDocument,
  taskId: string,
  options: CanvasTaskViewOptions,
): CanvasTaskView | null {
  const task = document.tasks.find((entry) => entry.id === taskId)
  if (!task) return null
  const runtime = options.runtime?.taskId === taskId ? options.runtime : undefined
  const nodes = selectTaskNodes(document, taskId)
  const runtimeActive = runtime?.phase === 'queued'
    || runtime?.phase === 'running'
    || runtime?.phase === 'awaiting-permission'
  const runtimeOutputIsMaterialized = Boolean(runtime?.runId
    && taskHasMaterializedRunOutput(document, taskId, runtime.runId))
  // 空白画布或已有内容派生的 Task 会让 Agent 在 Run 中决定 output 类型。
  // 在首个 artifact/path 事件到达前，runtime.ghosts 为空；如果直接按 0 output
  // 渲染，就会短暂退回完整 Task 卡片，形成“生成中 / 尚无产物”残壳。
  // 这里投射一个不猜类型、不持久化的输出面，真实 ghost / Node 到达后自然替换。
  const runtimeGhosts: readonly CanvasGhostOutput[] = runtimeOutputIsMaterialized
    ? []
    : runtimeActive && nodes.length === 0 && (runtime?.ghosts.length ?? 0) === 0
      ? [{
          key: `pending-output:${task.id}`,
          title: '生成结果',
          phase: 'writing',
          provisional: true,
        }]
      : runtime?.ghosts ?? []
  // A bound Node already owns the visual slot, so its transient ghost is not
  // drawn separately. Unbound ghosts remain visible instead of being guessed
  // away by array position.
  const nodeIds = new Set(nodes.map((node) => node.id))
  const ghosts = layoutGhostOutputs(
    task,
    runtimeGhosts.filter((ghost) => !ghost.nodeId || !nodeIds.has(ghost.nodeId)),
    nodes.length,
  )
  const status = deriveTaskStatus(runtime, nodes)
  const artifactCount = new Set(nodes.flatMap((node) => node.artifactRefs.map((artifact) =>
    `${artifact.runId}\u001f${artifact.artifactId}`))).size
  const accessibility = taskAccessibility(
    task,
    status,
    nodes.length,
    artifactCount,
    options.proposalReview?.pendingCount ?? 0,
  )
  const containerKind = deriveTaskContainerKind(nodes.length + ghosts.length)
  return {
    task,
    nodes,
    edges: selectTaskEdges(document, taskId),
    ghosts,
    bounds: selectTaskBounds(task, nodes, ghosts),
    containerKind,
    // 单产物任务（title-strip）没有折叠形态：产物就是任务本体，收起没有承载界面；
    // 历史持久化的 collapsedTaskIds 对这类任务自然失效。
    presentation: containerKind === 'title-strip'
      ? 'expanded'
      : deriveTaskPresentation(options.explicitlyCollapsed ?? false),
    status,
    artifactCount,
    accessibility,
  }
}

/** Durable projections replace every transient file-write ghost from the same Run. */
export function taskHasMaterializedRunOutput(
  document: CanvasDocument,
  taskId: string,
  runId: string,
): boolean {
  return document.nodes.some((node) => node.homeTaskId === taskId && (
    (node.origin.kind === 'agent-output' && node.origin.runId === runId)
    || node.artifactRefs.some((artifact) => artifact.runId === runId)
  ))
}

export function indexEdges(document: CanvasDocument): CanvasEdgeIndex {
  const byId = new Map<string, CanvasEdge>()
  const incomingByEntity = new Map<string, CanvasEdge[]>()
  const outgoingByEntity = new Map<string, CanvasEdge[]>()
  for (const edge of document.edges) {
    byId.set(edge.id, edge)
    appendMapValue(outgoingByEntity, entityKey(edge.from), edge)
    appendMapValue(incomingByEntity, entityKey(edge.to), edge)
  }
  return { byId, incomingByEntity, outgoingByEntity }
}

export function selectContextEdges(
  document: CanvasDocument,
  target: CanvasEntityRef,
): CanvasEdge[] {
  return document.edges.filter((edge) =>
    entityKey(edge.to) === entityKey(target) && edge.contextRole !== 'none')
}

export function selectCollectionMembers(
  document: CanvasDocument,
  collectionId: string,
): CanvasCollectionMembers {
  return {
    tasks: document.tasks.filter((task) => task.collectionId === collectionId),
    nodes: document.nodes.filter((node) => node.collectionId === collectionId),
  }
}

export function selectCollectionBounds(
  document: CanvasDocument,
  collectionId: string,
): CanvasBounds | null {
  const collection = document.collections.find((entry) => entry.id === collectionId)
  if (!collection) return null
  const members = selectCollectionMembers(document, collectionId)
  const memberBounds: CanvasBounds[] = [
    ...members.nodes.map(({ frame }) => frame),
    ...members.tasks.map((task) => selectTaskBounds(
      task,
      selectTaskNodes(document, task.id),
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

export function projectCollapsedCollectionEdges(
  document: CanvasDocument,
  collapsedCollectionIds: ReadonlySet<string>,
): CanvasCollapsedEdgeProjection {
  const existingCollapsedIds = new Set(document.collections
    .map((collection) => collection.id)
    .filter((id) => collapsedCollectionIds.has(id)))
  const bundlesByKey = new Map<string, CanvasVisualEdgeBundle>()
  const hiddenEdgeIds: string[] = []

  for (const edge of document.edges) {
    const from = visualEndpoint(document, edge.from, existingCollapsedIds)
    const to = visualEndpoint(document, edge.to, existingCollapsedIds)
    if (from.kind === 'collection' && to.kind === 'collection' && from.id === to.id) {
      hiddenEdgeIds.push(edge.id)
      continue
    }
    const key = [
      visualEntityKey(from),
      visualEntityKey(to),
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

export function selectProposalReview(
  document: CanvasDocument,
  planId: string,
  proposalKeys: readonly string[],
): CanvasProposalReview {
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
  const items = uniqueKeys.map((proposalKey): CanvasProposalReviewItem => {
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

export function taskAccessibility(
  task: CanvasTask,
  status: CanvasTaskStatus,
  outputCount: number,
  artifactCount: number,
  pendingProposalCount: number,
): CanvasTaskAccessibility {
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

export function collectionAccessibility(
  title: string,
  members: CanvasCollectionMembers,
  collapsed: boolean,
): CanvasCollectionAccessibility {
  return {
    label: [
      `集合：${title}`,
      collapsed ? '已折叠' : '已展开',
      `${members.tasks.length} 个任务`,
      `${members.nodes.length} 个独立节点`,
    ].join('，'),
  }
}

function boundsOf(bounds: readonly CanvasBounds[]): CanvasBounds {
  const left = Math.min(...bounds.map((entry) => entry.x))
  const top = Math.min(...bounds.map((entry) => entry.y))
  const right = Math.max(...bounds.map((entry) => entry.x + entry.w))
  const bottom = Math.max(...bounds.map((entry) => entry.y + entry.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

function edgeTouchesTask(
  edge: CanvasEdge,
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
  map: Map<string, CanvasEdge[]>,
  key: string,
  edge: CanvasEdge,
): void {
  const values = map.get(key)
  if (values) values.push(edge)
  else map.set(key, [edge])
}

function visualEndpoint(
  document: CanvasDocument,
  ref: CanvasEntityRef,
  collapsedCollectionIds: ReadonlySet<string>,
): CanvasVisualEntityRef {
  const collectionId = collectionIdForRef(document, ref)
  return collectionId && collapsedCollectionIds.has(collectionId)
    ? { kind: 'collection', id: collectionId }
    : ref
}

function collectionIdForRef(
  document: CanvasDocument,
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

function visualEntityKey(ref: CanvasVisualEntityRef): string {
  return `${ref.kind}:${ref.id}`
}

function proposalReviewState(
  items: readonly CanvasProposalReviewItem[],
): CanvasProposalReview['state'] {
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
