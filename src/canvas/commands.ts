import {
  assertCanvasDocument,
  canvasNodeWorldRect,
  canvasNodeGeometry,
  canvasNodeTypeRef,
  canvasOrderKey,
  canvasOrderNumber,
  canvasEdgeTopologyIssue,
  cloneCanvasDocument,
  entityKey,
  isReservedCanvasId,
  type CanvasCollection,
  type CanvasDocument,
  type CanvasEdgeContextRole,
  type CanvasEdgeRelation,
  type CanvasEdge,
  type CanvasEntityRef,
  type CanvasMaterializationReceipt,
  type CanvasNode,
  type CanvasPoint,
  type CanvasReceipt,
  type CanvasTask,
} from './model.js'
import {
  canonicalNodeSkillBindings,
  type NodeSkillBindings,
} from '../skills/contracts.js'
import { taskOutputFrame } from './layout.js'
import { isContextBearingEdge, promotedTaskInputsForOutputSlot } from './contextEdges.js'
import type { NodeTypeSnapshot } from '../plugins/nodeTypeContracts.js'
import type { PdfMaterializationPlan } from '../pdf/contracts.js'

export type TrustedProjectionOutputRole = 'primary' | 'supporting' | 'auxiliary'

export interface TrustedProjectionArtifactRef {
  runId: string
  artifactId: string
}

export interface TrustedProjectionOutput {
  key: string
  pluginId: string
  role: TrustedProjectionOutputRole
  title: string
  artifactRefs: TrustedProjectionArtifactRef[]
  derivedFrom: string[]
  materialize: boolean
}

export interface TrustedTaskProposal {
  key: string
  title: string
  prompt: string
  inputOutputKeys: string[]
  dependsOn: string[]
}

export const MAX_ACCEPTED_TASK_PROPOSALS = 12
export const MAX_CANVAS_EDGE_BATCH = 500
export const MAX_TRUSTED_PROJECTION_OUTPUTS = 32
export const MAX_TASK_PROPOSAL_INPUTS = 32
export const MAX_TASK_PROPOSAL_KEY_LENGTH = 80
export const MAX_TASK_PROPOSAL_EDIT_TITLE_LENGTH = 240
export const MAX_TASK_PROPOSAL_EDIT_PROMPT_LENGTH = 10_000
export const MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES = 12

export interface TaskProposalEdit {
  title?: string
  prompt?: string
  dependsOn?: string[]
}

export type TaskProposalEdits = Record<string, TaskProposalEdit>

export interface TrustedProjectionPlanInput {
  schemaVersion: 2
  taskId: string
  planId: string
  runId: string
  status: 'complete' | 'partial'
  manifestDigest: string
  outputs: TrustedProjectionOutput[]
  taskProposals: TrustedTaskProposal[]
  graphPlan?: TrustedGraphMaterializationPlanInput
  warnings: string[]
  digest: string
}

export interface TrustedGraphMaterializationPlanInput {
  schemaVersion: 1
  planId: string
  runId: string
  taskId: string
  nodes: Array<{ logicalKey: string; node: CanvasNode }>
  edges: CanvasEdge[]
  nodeTypes: NodeTypeSnapshot[]
  digest: string
}

export interface TrustedInstanceExpansion {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  edgePatches: Array<{ edgeId: string; from?: CanvasEntityRef; to?: CanvasEntityRef }>
}

export interface UpdateNodeContentPatch {
  title?: string
  text?: string | null
  payload?: Record<string, unknown> | null
}

export interface UpdateEdgePatch {
  from?: CanvasEntityRef
  to?: CanvasEntityRef
  relation?: CanvasEdgeRelation
  contextRole?: CanvasEdgeContextRole
}

export interface DerivedTaskSource {
  entity: CanvasEntityRef
  relation: 'source' | 'modified'
  contextRole: CanvasEdgeContextRole
}

export type CanvasCommand =
  | { type: 'CreateTask'; task: CanvasTask }
  | { type: 'UpdateTaskGoal'; taskId: string; goal: string }
  | { type: 'CreateNode'; node: CanvasNode }
  | { type: 'UpdateNodeContent'; nodeId: string; patch: UpdateNodeContentPatch }
  | { type: 'UpdateNodeSkillBindings'; nodeId: string; bindings: NodeSkillBindings }
  | { type: 'ResizeNode'; nodeId: string; w: number; h: number }
  | { type: 'SetNodeBounds'; nodeId: string; w: number; h: number }
  | {
      type: 'SetNodeTransform'
      nodeId: string
      matrix: [number, number, number, number, number, number]
    }
  | {
      type: 'ReparentNodes'
      nodeIds: string[]
      parentId: string | null
      beforeOrderKey?: string
    }
  | {
      type: 'ReorderChildren'
      parentId: string | null
      moves: Array<{ nodeId: string; orderKey: string }>
    }
  | { type: 'CreatePortEdge'; edge: CanvasEdge }
  | { type: 'SelectNodeExecution'; nodeId: string; executionId: string | null }
  | { type: 'BindNodeToFilesystem'; nodeId: string; bindingId: string }
  | { type: 'DeleteNode'; nodeId: string }
  | {
      type: 'DuplicateNode'
      sourceNodeId: string
      newNodeId: string
      offset: CanvasPoint
      title?: string
    }
  | { type: 'CreateEdge'; edge: CanvasEdge }
  | { type: 'CreateEdges'; edges: CanvasEdge[] }
  | { type: 'UpdateEdge'; edgeId: string; patch: UpdateEdgePatch }
  | { type: 'DeleteEdge'; edgeId: string }
  | { type: 'DeleteEdges'; edgeIds: string[] }
  | { type: 'DetachNodeFromTask'; nodeId: string }
  | { type: 'AssignNodeToTask'; nodeId: string; taskId: string }
  | { type: 'CreateTaskForOutputSlot'; task: CanvasTask; nodeId: string }
  | {
      type: 'CreateDerivedTaskFromSelection'
      task: CanvasTask
      sources: DerivedTaskSource[]
    }
  | {
      type: 'MoveEntities'
      entities: CanvasEntityRef[]
      collectionIds?: string[]
      dx: number
      dy: number
    }
  | {
      type: 'CreateCollectionFromSelection'
      collection: CanvasCollection
      members: CanvasEntityRef[]
    }
  | { type: 'AssignToCollection'; collectionId: string; members: CanvasEntityRef[] }
  | { type: 'RemoveFromCollection'; collectionId: string; members: CanvasEntityRef[] }
  | { type: 'DissolveCollection'; collectionId: string }
  | { type: 'DeleteTask'; taskId: string }
  | { type: 'DeleteTaskAndViews'; taskId: string }
  | { type: 'DeleteCollection'; collectionId: string }
  | { type: 'DeleteCollectionAndContents'; collectionId: string }
  | {
      type: 'DuplicateCollection'
      sourceCollectionId: string
      newCollectionId: string
      offset: CanvasPoint
      title?: string
    }
  | {
      type: 'DuplicateTaskAsDraft'
      sourceTaskId: string
      newTaskId: string
      offset: CanvasPoint
      title?: string
    }
  | {
      type: 'MaterializeProjectionPlan'
      plan: TrustedProjectionPlanInput
    }
  | {
      type: 'AcceptTaskProposals'
      plan: TrustedProjectionPlanInput
      proposalKeys: string[]
      edits?: TaskProposalEdits
    }
  | {
      type: 'DismissPlan'
      plan: TrustedProjectionPlanInput
    }
  | {
      type: 'MaterializeGraphPlan'
      plan: TrustedGraphMaterializationPlanInput
    }
  | {
      type: 'MaterializeDecompositionPlan'
      plan: PdfMaterializationPlan
    }
  | { type: 'CreateInstance'; node: CanvasNode }
  | {
      type: 'DetachInstance'
      nodeId: string
      expansion?: TrustedInstanceExpansion
    }
  | {
      type: 'UpdateInstanceRef'
      nodeId: string
      instanceRef: { definitionId: string; revision: number; digest: string }
    }

export class CanvasCommandError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CanvasCommandError'
    this.code = code
  }
}

export function applyCanvasCommand(
  document: CanvasDocument,
  command: CanvasCommand,
): CanvasDocument {
  assertCanvasDocument(document)
  if (isIdempotentReplay(document, command)) return document

  const next = cloneCanvasDocument(document)
  switch (command.type) {
    case 'CreateTask':
      createTask(next, command.task)
      break
    case 'UpdateTaskGoal':
      requireTask(next, command.taskId).goal = command.goal
      break
    case 'CreateNode':
      createNode(next, command.node)
      break
    case 'UpdateNodeContent':
      updateNodeContent(next, command.nodeId, command.patch)
      break
    case 'UpdateNodeSkillBindings':
      requireNode(next, command.nodeId).skillBindings = canonicalNodeSkillBindings(
        command.bindings,
      )
      break
    case 'ResizeNode':
      resizeNode(next, command.nodeId, command.w, command.h)
      break
    case 'SetNodeBounds':
      resizeNode(next, command.nodeId, command.w, command.h)
      break
    case 'SetNodeTransform':
      setNodeTransform(next, command.nodeId, command.matrix)
      break
    case 'ReparentNodes':
      reparentNodes(next, command)
      break
    case 'ReorderChildren':
      reorderChildren(next, command)
      break
    case 'DeleteNode':
      deleteNode(next, command.nodeId)
      break
    case 'DuplicateNode':
      duplicateNode(next, command)
      break
    case 'CreateEdge':
      createUserEdge(next, command.edge)
      break
    case 'CreatePortEdge':
      createPortEdge(next, command.edge)
      break
    case 'CreateEdges':
      createUserEdges(next, command.edges)
      break
    case 'UpdateEdge':
      updateUserEdge(next, command.edgeId, command.patch)
      break
    case 'DeleteEdge':
      deleteEdge(next, command.edgeId)
      break
    case 'DeleteEdges':
      deleteEdges(next, command.edgeIds)
      break
    case 'SelectNodeExecution':
      selectNodeExecution(next, command.nodeId, command.executionId)
      break
    case 'BindNodeToFilesystem':
      bindNodeToFilesystem(next, command.nodeId, command.bindingId)
      break
    case 'DetachNodeFromTask':
      detachNodeFromTask(next, command.nodeId)
      break
    case 'AssignNodeToTask':
      assignNodeToTask(next, command.nodeId, command.taskId)
      break
    case 'CreateTaskForOutputSlot':
      createTaskForOutputSlot(next, command.task, command.nodeId)
      break
    case 'CreateDerivedTaskFromSelection':
      createDerivedTaskFromSelection(next, command.task, command.sources)
      break
    case 'MoveEntities':
      moveEntities(
        next,
        command.entities,
        command.collectionIds ?? [],
        command.dx,
        command.dy,
      )
      break
    case 'CreateCollectionFromSelection':
      createCollection(next, command.collection, command.members)
      break
    case 'AssignToCollection':
      assignToCollection(next, command.collectionId, command.members)
      break
    case 'RemoveFromCollection':
      removeFromCollection(next, command.collectionId, command.members)
      break
    case 'DissolveCollection':
      dissolveCollection(next, command.collectionId)
      break
    case 'DeleteTask':
      deleteTask(next, command.taskId)
      break
    case 'DeleteTaskAndViews':
      deleteTaskAndViews(next, command.taskId)
      break
    case 'DeleteCollection':
      deleteCollection(next, command.collectionId)
      break
    case 'DeleteCollectionAndContents':
      deleteCollectionAndContents(next, command.collectionId)
      break
    case 'DuplicateCollection':
      duplicateCollection(next, command)
      break
    case 'DuplicateTaskAsDraft':
      duplicateTaskAsDraft(next, command)
      break
    case 'MaterializeProjectionPlan':
      materializeProjectionPlan(next, command)
      break
    case 'AcceptTaskProposals':
      acceptTaskProposals(next, command)
      break
    case 'DismissPlan':
      dismissPlan(next, command)
      break
    case 'MaterializeGraphPlan':
      materializeGraphPlan(next, command.plan)
      break
    case 'MaterializeDecompositionPlan':
      materializeDecompositionPlan(next, command.plan)
      break
    case 'CreateInstance':
      createInstance(next, command.node)
      break
    case 'DetachInstance':
      detachInstance(next, command.nodeId, command.expansion)
      break
    case 'UpdateInstanceRef':
      updateInstanceRef(next, command.nodeId, command.instanceRef)
      break
    default:
      command satisfies never
  }

  assertCanvasDocument(next)
  return next
}

export function deterministicCanvasId(
  kind: 'node' | 'task' | 'collection' | 'edge',
  ...parts: string[]
): string {
  const value = parts.join('\u001f')
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
  const digest = seeds.map((seed) => fnv1a(value, seed).toString(16).padStart(8, '0')).join('')
  return `canvas_${kind}_${digest}`
}

function createTask(document: CanvasDocument, task: CanvasTask): void {
  requireClientOwnedId(task.id, 'task')
  ensureEntityIdAvailable(document, task.id)
  if (task.origin.kind !== 'user') {
    throw new CanvasCommandError(
      'invalid-task-origin',
      'CreateTask creates user tasks; Agent proposals must use AcceptTaskProposals',
    )
  }
  if (task.collectionId) requireCollection(document, task.collectionId)
  document.tasks.push(structuredClone(task))
  document.everCreated = true
}

function createNode(document: CanvasDocument, node: CanvasNode): void {
  requireClientOwnedId(node.id, 'node')
  ensureEntityIdAvailable(document, node.id)
  if (node.origin.kind !== 'user') {
    throw new CanvasCommandError(
      'invalid-node-origin',
      'CreateNode creates user nodes; trusted outputs use MaterializeProjectionPlan',
    )
  }
  if (!Array.isArray(node.artifactRefs) || node.artifactRefs.length !== 0) {
    throw new CanvasCommandError(
      'forged-artifact-reference',
      'CreateNode cannot attach daemon-owned artifact references',
    )
  }
  if (node.homeTaskId) requireTask(document, node.homeTaskId)
  if (node.collectionId) requireCollection(document, node.collectionId)
  document.nodes.push(structuredClone(node))
  document.everCreated = true
}

function updateNodeContent(
  document: CanvasDocument,
  nodeId: string,
  patch: UpdateNodeContentPatch,
): void {
  if (!isPlainRecord(patch)) {
    throw new CanvasCommandError('invalid-node-content-patch', 'Node content patch must be an object')
  }
  const keys = Object.keys(patch)
  if (keys.length === 0
    || keys.some((key) => !['title', 'text', 'payload'].includes(key))) {
    throw new CanvasCommandError(
      'invalid-node-content-patch',
      'UpdateNodeContent requires an allow-listed content field',
    )
  }
  const node = requireNode(document, nodeId)
  if (hasOwn(patch, 'title')) {
    if (typeof patch.title !== 'string' || patch.title.length === 0 || patch.title.length > 1_000) {
      throw new CanvasCommandError('invalid-node-title', 'Node title is invalid')
    }
    node.title = patch.title
  }
  if (hasOwn(patch, 'text')) {
    if (patch.text === null) delete node.text
    else {
      if (typeof patch.text !== 'string' || patch.text.length > 1_000_000) {
        throw new CanvasCommandError('invalid-node-text', 'Node text is invalid')
      }
      node.text = patch.text
    }
  }
  if (hasOwn(patch, 'payload')) {
    if (patch.payload === null) delete node.payload
    else {
      if (!isPlainRecord(patch.payload)) {
        throw new CanvasCommandError('invalid-node-payload', 'Node payload must be a JSON object')
      }
      node.payload = structuredClone(patch.payload)
    }
  }
}

function resizeNode(
  document: CanvasDocument,
  nodeId: string,
  w: number,
  h: number,
): void {
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
    throw new CanvasCommandError('invalid-node-size', 'Node dimensions must be positive and finite')
  }
  const node = requireNode(document, nodeId)
  node.bounds.w = w
  node.bounds.h = h
}

function setNodeTransform(
  document: CanvasDocument,
  nodeId: string,
  matrix: [number, number, number, number, number, number],
): void {
  if (!Array.isArray(matrix)
    || matrix.length !== 6
    || matrix.some((value) => !Number.isFinite(value))
    || Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-12) {
    throw new CanvasCommandError('invalid-node-transform', 'Node transform must be invertible and finite')
  }
  requireNode(document, nodeId).transform = { matrix: [...matrix] }
}

function reparentNodes(
  document: CanvasDocument,
  command: Extract<CanvasCommand, { type: 'ReparentNodes' }>,
): void {
  const nodeIds = uniqueIds(command.nodeIds, 'reparent')
  if (nodeIds.length === 0) throw new CanvasCommandError('empty-reparent', 'Reparent requires nodes')
  const moving = new Set(nodeIds)
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const parent = command.parentId === null ? null : requireNode(document, command.parentId)
  if (parent && moving.has(parent.id)) {
    throw new CanvasCommandError('containment-cycle', 'A node cannot become its own parent')
  }
  for (const nodeId of nodeIds) {
    const node = requireNode(document, nodeId)
    let ancestor = node.parentId
    while (ancestor) {
      if (moving.has(ancestor)) {
        throw new CanvasCommandError(
          'nested-reparent-selection',
          'Reparent selection must not contain both an ancestor and descendant',
        )
      }
      ancestor = nodesById.get(ancestor)?.parentId ?? null
    }
    let targetAncestor = parent?.id ?? null
    while (targetAncestor) {
      if (targetAncestor === node.id) {
        throw new CanvasCommandError('containment-cycle', 'Reparent would create a cycle')
      }
      targetAncestor = nodesById.get(targetAncestor)?.parentId ?? null
    }
  }

  const worldById = new Map(nodeIds.map((nodeId) => [
    nodeId,
    worldTransform(requireNode(document, nodeId), nodesById),
  ]))
  const parentWorld = parent ? worldTransform(parent, nodesById) : identityMatrix()
  const inverseParent = invertMatrix(parentWorld)
  const siblings = document.nodes.filter((node) => node.parentId === command.parentId && !moving.has(node.id))
  const insertAt = command.beforeOrderKey === undefined
    ? siblings.reduce((max, node) => Math.max(max, canvasOrderNumber(node.orderKey)), -1) + 1
    : canvasOrderNumber(command.beforeOrderKey)
  for (const sibling of siblings) {
    const order = canvasOrderNumber(sibling.orderKey)
    if (order >= insertAt) sibling.orderKey = canvasOrderKey(order + nodeIds.length)
  }
  const ordered = nodeIds.map((id) => requireNode(document, id))
    .sort((left, right) => left.orderKey.localeCompare(right.orderKey))
  for (const [index, node] of ordered.entries()) {
    node.parentId = command.parentId
    node.orderKey = canvasOrderKey(insertAt + index)
    node.transform = {
      matrix: multiplyMatrices(inverseParent, worldById.get(node.id)!),
    }
    if (command.parentId !== null) {
      delete node.homeTaskId
      delete node.collectionId
    }
  }
}

function reorderChildren(
  document: CanvasDocument,
  command: Extract<CanvasCommand, { type: 'ReorderChildren' }>,
): void {
  if (!Array.isArray(command.moves) || command.moves.length === 0) {
    throw new CanvasCommandError('empty-reorder', 'Reorder requires at least one move')
  }
  const ids = uniqueIds(command.moves.map((move) => move.nodeId), 'reorder')
  if (ids.length !== command.moves.length) {
    throw new CanvasCommandError('duplicate-reorder-node', 'Reorder contains duplicate nodes')
  }
  for (const move of command.moves) {
    const node = requireNode(document, move.nodeId)
    if (node.parentId !== command.parentId) {
      throw new CanvasCommandError('reorder-parent-mismatch', 'Reorder nodes must share the parent')
    }
    if (!/^[0-9A-Za-z._~-]{1,128}$/u.test(move.orderKey)) {
      throw new CanvasCommandError('invalid-order-key', 'Reorder contains an invalid orderKey')
    }
    node.orderKey = move.orderKey
  }
}

function selectNodeExecution(
  document: CanvasDocument,
  nodeId: string,
  executionId: string | null,
): void {
  const node = requireNode(document, nodeId)
  if (executionId === null) {
    delete node.selectedExecutionId
    return
  }
  requireOrdinaryId(executionId, 'executionId')
  node.selectedExecutionId = executionId
}

function bindNodeToFilesystem(
  document: CanvasDocument,
  nodeId: string,
  bindingId: string,
): void {
  requireOrdinaryId(bindingId, 'bindingId')
  requireNode(document, nodeId).bindingId = bindingId
}

function deleteNode(document: CanvasDocument, nodeId: string): void {
  const node = requireNode(document, nodeId)
  const ownerTaskId = node.homeTaskId
  if (ownerTaskId && !document.nodes.some((entry) =>
    entry.id !== nodeId && entry.homeTaskId === ownerTaskId)) {
    // A Task without any output view is not a retained artifact container. Removing its final
    // Node removes the now-empty Task projection and every incident edge in the same revision;
    // durable receipts and run-owned artifact manifests deliberately remain untouched.
    requireTask(document, ownerTaskId)
    removeEntities(document, new Set([ownerTaskId]), new Set([nodeId]))
    return
  }
  document.nodes = document.nodes.filter((node) => node.id !== nodeId)
  document.edges = document.edges.filter((edge) =>
    !(edge.from.kind === 'node' && edge.from.id === nodeId)
    && !(edge.to.kind === 'node' && edge.to.id === nodeId))
}

function duplicateNode(
  document: CanvasDocument,
  command: Extract<CanvasCommand, { type: 'DuplicateNode' }>,
): void {
  const source = requireNode(document, command.sourceNodeId)
  requireClientOwnedId(command.newNodeId, 'node')
  ensureEntityIdAvailable(document, command.newNodeId)
  if (!Number.isFinite(command.offset.x) || !Number.isFinite(command.offset.y)) {
    throw new CanvasCommandError('invalid-offset', 'Duplicate offset must be finite')
  }

  const duplicate: CanvasNode = {
    id: command.newNodeId,
    typeRef: structuredClone(source.typeRef),
    ...canvasNodeGeometry({
      ...canvasNodeWorldRect(source),
      x: canvasNodeWorldRect(source).x + command.offset.x,
      y: canvasNodeWorldRect(source).y + command.offset.y,
      z: maxNodeZ(document) + 1,
    }),
    title: command.title ?? `${source.title} copy`,
    ...(source.text === undefined ? {} : { text: source.text }),
    ...(source.payload === undefined ? {} : { payload: structuredClone(source.payload) }),
    artifactRefs: structuredClone(source.artifactRefs),
    ...(source.skillBindings === undefined
      ? {}
      : { skillBindings: structuredClone(source.skillBindings) }),
    ...(source.homeTaskId ? { homeTaskId: source.homeTaskId } : {}),
    ...(source.collectionId ? { collectionId: source.collectionId } : {}),
    origin: { kind: 'copied', sourceNodeId: source.id },
  }
  document.nodes.push(duplicate)
  document.everCreated = true
}

function createUserEdge(document: CanvasDocument, edge: CanvasEdge): void {
  if (!isPlainRecord(edge)
    || !['id', 'from', 'to', 'relation', 'contextRole', 'origin']
      .every((key) => hasOwn(edge, key))
    || Object.keys(edge).some((key) =>
      !['id', 'from', 'to', 'relation', 'contextRole', 'orderKey', 'origin'].includes(key))) {
    throw new CanvasCommandError('invalid-edge', 'CreateEdge has an invalid shape')
  }
  requireClientOwnedId(edge.id, 'edge')
  if (!isExactUserOrigin(edge.origin)) {
    throw new CanvasCommandError(
      'invalid-edge-origin',
      'CreateEdge creates user edges; Agent edges come only from trusted plans',
    )
  }
  ensureEdgeIdAvailable(document, edge.id)
  requireEntity(document, edge.from)
  requireEntity(document, edge.to)
  requireValidEdgeSemantics(edge)
  document.edges.push(structuredClone(edge))
}

function createPortEdge(document: CanvasDocument, edge: CanvasEdge): void {
  if (edge.relation !== 'data') {
    throw new CanvasCommandError('invalid-port-edge', 'CreatePortEdge requires a data relation')
  }
  createUserEdge(document, edge)
}

function createUserEdges(document: CanvasDocument, edges: CanvasEdge[]): void {
  if (!Array.isArray(edges) || edges.length === 0 || edges.length > MAX_CANVAS_EDGE_BATCH) {
    throw new CanvasCommandError(
      'invalid-edges',
      `CreateEdges requires 1 to ${MAX_CANVAS_EDGE_BATCH} edges`,
    )
  }
  for (const edge of edges) createUserEdge(document, edge)
}

function updateUserEdge(
  document: CanvasDocument,
  edgeId: string,
  patch: UpdateEdgePatch,
): void {
  if (!isPlainRecord(patch)) {
    throw new CanvasCommandError('invalid-edge-patch', 'Edge patch must be an object')
  }
  const keys = Object.keys(patch)
  if (keys.length === 0
    || keys.some((key) => !['from', 'to', 'relation', 'contextRole'].includes(key))) {
    throw new CanvasCommandError(
      'invalid-edge-patch',
      'UpdateEdge requires an allow-listed semantic field',
    )
  }
  const edge = requireEdge(document, edgeId)
  if (edge.origin.kind !== 'user') {
    throw new CanvasCommandError(
      'trusted-edge-immutable',
      'Agent-authored edges cannot be patched by a browser command',
    )
  }
  if (hasOwn(patch, 'from')) {
    if (!isEntityRef(patch.from)) throw new CanvasCommandError('invalid-edge-endpoint', 'from is invalid')
    edge.from = structuredClone(patch.from)
  }
  if (hasOwn(patch, 'to')) {
    if (!isEntityRef(patch.to)) throw new CanvasCommandError('invalid-edge-endpoint', 'to is invalid')
    edge.to = structuredClone(patch.to)
  }
  if (hasOwn(patch, 'relation')) {
    requireEdgeRelation(patch.relation)
    edge.relation = patch.relation as CanvasEdgeRelation
  }
  if (hasOwn(patch, 'contextRole')) {
    requireContextRole(patch.contextRole)
    edge.contextRole = patch.contextRole as CanvasEdgeContextRole
  }
  requireEntity(document, edge.from)
  requireEntity(document, edge.to)
  requireValidEdgeSemantics(edge)
}

function deleteEdge(document: CanvasDocument, edgeId: string): void {
  requireEdge(document, edgeId)
  document.edges = document.edges.filter((edge) => edge.id !== edgeId)
}

function deleteEdges(document: CanvasDocument, edgeIds: string[]): void {
  if (!Array.isArray(edgeIds)
    || edgeIds.length === 0
    || edgeIds.length > MAX_CANVAS_EDGE_BATCH
    || new Set(edgeIds).size !== edgeIds.length) {
    throw new CanvasCommandError(
      'invalid-edge-ids',
      `DeleteEdges requires 1 to ${MAX_CANVAS_EDGE_BATCH} unique edge ids`,
    )
  }
  for (const edgeId of edgeIds) requireEdge(document, edgeId)
  const deleted = new Set(edgeIds)
  document.edges = document.edges.filter((edge) => !deleted.has(edge.id))
}

function detachNodeFromTask(document: CanvasDocument, nodeId: string): void {
  const node = requireNode(document, nodeId)
  delete node.homeTaskId
}

function assignNodeToTask(document: CanvasDocument, nodeId: string, taskId: string): void {
  const node = requireNode(document, nodeId)
  requireTask(document, taskId)
  if (node.origin.kind === 'agent-output' && node.origin.taskId !== taskId) {
    throw new CanvasCommandError(
      'output-task-mismatch',
      'An Agent output can only return to its provenance task',
    )
  }
  delete node.collectionId
  node.homeTaskId = taskId
}

function createTaskForOutputSlot(
  document: CanvasDocument,
  task: CanvasTask,
  nodeId: string,
): void {
  const node = requireNode(document, nodeId)
  if (!isEmptyUserOutputSlot(node)) {
    throw new CanvasCommandError(
      'node-not-empty-output-slot',
      'Only an empty user-origin node without artifacts can become an output slot',
    )
  }
  if (node.homeTaskId) {
    throw new CanvasCommandError('node-already-assigned', 'Output slot already belongs to a task')
  }
  if (node.collectionId !== task.collectionId) {
    throw new CanvasCommandError(
      'collection-mismatch',
      'An output slot and its new task must share collection membership',
    )
  }
  const inheritedInputs = promotedTaskInputsForOutputSlot(document.edges, node.id)
  if (inheritedInputs.length > MAX_CANVAS_EDGE_BATCH) {
    throw new CanvasCommandError(
      'too-many-output-slot-inputs',
      `An output slot can inherit at most ${MAX_CANVAS_EDGE_BATCH} unique inputs`,
    )
  }
  createTask(document, task)
  delete node.collectionId
  node.homeTaskId = task.id
  const target = { kind: 'task' as const, id: task.id }
  for (const input of inheritedInputs) {
    const edge: CanvasEdge = {
      id: deterministicCanvasId(
        'edge',
        'output-slot-input',
        task.id,
        entityKey(input.from),
      ),
      from: structuredClone(input.from),
      to: target,
      relation: input.from.kind === 'task' ? 'depends-on' : 'source',
      contextRole: input.contextRole,
      origin: { kind: 'user' },
    }
    ensureEdgeIdAvailable(document, edge.id)
    requireValidEdgeSemantics(edge)
    document.edges.push(edge)
  }
  // 继承是“晋升”而非复制：指向槽节点的上下文连线已晋升给任务，原连线必须移除，
  // 否则同一来源会同时画出 来源→任务 与 来源→节点 两条线；contextRole 为 none 的
  // 纯视觉 lineage 不参与晋升，保留原样。
  const slotKey = entityKey({ kind: 'node', id: nodeId })
  document.edges = document.edges.filter((edge) =>
    !(isContextBearingEdge(edge) && entityKey(edge.to) === slotKey))
}

function createDerivedTaskFromSelection(
  document: CanvasDocument,
  task: CanvasTask,
  sources: DerivedTaskSource[],
): void {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 500) {
    throw new CanvasCommandError(
      'invalid-derived-sources',
      'A derived task requires 1 to 500 selected sources',
    )
  }
  if (!sources.every((source) => hasExactKeys(source, [
    'entity',
    'relation',
    'contextRole',
  ]) && isEntityRef(source.entity))) {
    throw new CanvasCommandError(
      'invalid-derived-sources',
      'Every derived task source must be a typed entity relation',
    )
  }
  const sourceKeys = sources.map((source) => entityKey(source.entity))
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new CanvasCommandError('duplicate-entities', 'Derived task sources must be unique')
  }
  for (const source of sources) {
    requireEntity(document, source.entity)
    if (source.relation !== 'source' && source.relation !== 'modified') {
      throw new CanvasCommandError(
        'invalid-derived-relation',
        'Derived task edges allow only source or modified',
      )
    }
    if (source.relation === 'modified' && source.entity.kind !== 'node') {
      throw new CanvasCommandError(
        'invalid-derived-relation',
        'Only a node can be a modified input',
      )
    }
    requireContextRole(source.contextRole)
  }

  createTask(document, task)
  const target = { kind: 'task' as const, id: task.id }
  for (const source of sources) {
    const edge: CanvasEdge = {
      id: deterministicCanvasId(
        'edge',
        'derived-task-source',
        task.id,
        entityKey(source.entity),
      ),
      from: structuredClone(source.entity),
      to: target,
      relation: source.relation,
      contextRole: source.contextRole,
      origin: { kind: 'user' },
    }
    ensureEdgeIdAvailable(document, edge.id)
    requireValidEdgeSemantics(edge)
    document.edges.push(edge)
  }
}

function moveEntities(
  document: CanvasDocument,
  refs: CanvasEntityRef[],
  collectionIds: string[],
  dx: number,
  dy: number,
): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new CanvasCommandError('invalid-delta', 'Movement must be finite')
  }
  const uniqueRefs = requireUniqueRefs(refs)
  requireUniqueKeys(collectionIds, 'collection ids')
  const taskIds = new Set<string>()
  const nodeIds = new Set<string>()
  const movingCollectionIds = new Set(collectionIds)
  for (const collectionId of movingCollectionIds) requireCollection(document, collectionId)
  for (const task of document.tasks) {
    if (task.collectionId && movingCollectionIds.has(task.collectionId)) taskIds.add(task.id)
  }
  for (const node of document.nodes) {
    if (node.collectionId && movingCollectionIds.has(node.collectionId)) nodeIds.add(node.id)
  }
  for (const ref of uniqueRefs) {
    if (ref.kind === 'task') {
      requireTask(document, ref.id)
      taskIds.add(ref.id)
      for (const node of document.nodes) {
        if (node.homeTaskId === ref.id) nodeIds.add(node.id)
      }
    } else {
      requireNode(document, ref.id)
      nodeIds.add(ref.id)
    }
  }
  for (const node of document.nodes) {
    if (node.homeTaskId && taskIds.has(node.homeTaskId)) nodeIds.add(node.id)
  }
  for (const collection of document.collections) {
    if (!movingCollectionIds.has(collection.id)) continue
    collection.anchor.x += dx
    collection.anchor.y += dy
  }
  for (const task of document.tasks) {
    if (!taskIds.has(task.id)) continue
    task.anchor.x += dx
    task.anchor.y += dy
  }
  for (const node of document.nodes) {
    if (!nodeIds.has(node.id)) continue
    if (!node.parentId) {
      node.transform.matrix[4] += dx
      node.transform.matrix[5] += dy
      continue
    }
    const nodesById = new Map(document.nodes.map((entry) => [entry.id, entry]))
    const parent = requireNode(document, node.parentId)
    const inverse = invertMatrix(worldTransform(parent, nodesById))
    node.transform.matrix[4] += inverse[0] * dx + inverse[2] * dy
    node.transform.matrix[5] += inverse[1] * dx + inverse[3] * dy
  }
}

function createCollection(
  document: CanvasDocument,
  collection: CanvasCollection,
  refs: CanvasEntityRef[],
): void {
  requireClientOwnedId(collection.id, 'collection')
  ensureEntityIdAvailable(document, collection.id)
  const members = requireUniqueRefs(refs)
  if (members.length === 0) {
    throw new CanvasCommandError('empty-selection', 'A collection requires at least one member')
  }
  for (const ref of members) ensureTopLevelUncollected(document, ref)
  document.collections.push(structuredClone(collection))
  setCollectionMembership(document, collection.id, members)
  document.everCreated = true
}

function assignToCollection(
  document: CanvasDocument,
  collectionId: string,
  refs: CanvasEntityRef[],
): void {
  requireCollection(document, collectionId)
  const members = requireUniqueRefs(refs)
  if (members.length === 0) {
    throw new CanvasCommandError('empty-selection', 'At least one member is required')
  }
  for (const ref of members) {
    if (ref.kind === 'node') {
      const node = requireNode(document, ref.id)
      if (node.homeTaskId) {
        throw new CanvasCommandError(
          'task-node-cannot-be-collected',
          `Node ${node.id} belongs to task ${node.homeTaskId}`,
        )
      }
    } else {
      requireTask(document, ref.id)
    }
  }
  setCollectionMembership(document, collectionId, members)
}

function removeFromCollection(
  document: CanvasDocument,
  collectionId: string,
  refs: CanvasEntityRef[],
): void {
  requireCollection(document, collectionId)
  const members = requireUniqueRefs(refs)
  if (members.length === 0) {
    throw new CanvasCommandError('empty-selection', 'At least one member is required')
  }
  for (const ref of members) {
    if (ref.kind === 'node') {
      const node = requireNode(document, ref.id)
      if (node.collectionId !== collectionId) {
        throw new CanvasCommandError('collection-mismatch', `Node ${node.id} is not in the collection`)
      }
      delete node.collectionId
    } else {
      const task = requireTask(document, ref.id)
      if (task.collectionId !== collectionId) {
        throw new CanvasCommandError('collection-mismatch', `Task ${task.id} is not in the collection`)
      }
      delete task.collectionId
    }
  }
}

function dissolveCollection(document: CanvasDocument, collectionId: string): void {
  requireCollection(document, collectionId)
  document.collections = document.collections.filter((entry) => entry.id !== collectionId)
  for (const task of document.tasks) {
    if (task.collectionId === collectionId) delete task.collectionId
  }
  for (const node of document.nodes) {
    if (node.collectionId === collectionId) delete node.collectionId
  }
}

function deleteTask(document: CanvasDocument, taskId: string): void {
  const task = requireTask(document, taskId)
  document.tasks = document.tasks.filter((entry) => entry.id !== taskId)
  for (const node of document.nodes) {
    if (node.homeTaskId !== taskId) continue
    delete node.homeTaskId
    if (task.collectionId) node.collectionId = task.collectionId
  }
  document.edges = document.edges.filter((edge) =>
    !(edge.from.kind === 'task' && edge.from.id === taskId)
    && !(edge.to.kind === 'task' && edge.to.id === taskId))
}

function deleteTaskAndViews(document: CanvasDocument, taskId: string): void {
  requireTask(document, taskId)
  const taskIds = new Set([taskId])
  const nodeIds = new Set(document.nodes
    .filter((node) => node.homeTaskId === taskId)
    .map((node) => node.id))
  removeEntities(document, taskIds, nodeIds)
}

function deleteCollection(document: CanvasDocument, collectionId: string): void {
  dissolveCollection(document, collectionId)
}

function deleteCollectionAndContents(
  document: CanvasDocument,
  collectionId: string,
): void {
  requireCollection(document, collectionId)
  const taskIds = new Set(document.tasks
    .filter((task) => task.collectionId === collectionId)
    .map((task) => task.id))
  const nodeIds = new Set(document.nodes
    .filter((node) => node.collectionId === collectionId
      || (node.homeTaskId !== undefined && taskIds.has(node.homeTaskId)))
    .map((node) => node.id))
  removeEntities(document, taskIds, nodeIds)
  document.collections = document.collections.filter((entry) => entry.id !== collectionId)
}

function duplicateCollection(
  document: CanvasDocument,
  command: Extract<CanvasCommand, { type: 'DuplicateCollection' }>,
): void {
  const sourceCollection = requireCollection(document, command.sourceCollectionId)
  requireClientOwnedId(command.newCollectionId, 'collection')
  ensureEntityIdAvailable(document, command.newCollectionId)
  if (!Number.isFinite(command.offset.x) || !Number.isFinite(command.offset.y)) {
    throw new CanvasCommandError('invalid-offset', 'Duplicate offset must be finite')
  }

  const sourceTasks = document.tasks
    .filter((task) => task.collectionId === sourceCollection.id)
  const sourceTaskIds = new Set(sourceTasks.map((task) => task.id))
  const sourceNodes = document.nodes.filter((node) =>
    node.collectionId === sourceCollection.id
    || (node.homeTaskId !== undefined && sourceTaskIds.has(node.homeTaskId)))
  const entityMap = new Map<string, CanvasEntityRef>()
  const taskIdMap = new Map<string, string>()
  const nextTasks: CanvasTask[] = []
  for (const task of sourceTasks) {
    const id = deterministicCanvasId(
      'task',
      'duplicate-collection',
      command.newCollectionId,
      task.id,
    )
    ensureEntityIdAvailable(document, id)
    taskIdMap.set(task.id, id)
    entityMap.set(entityKey({ kind: 'task', id: task.id }), { kind: 'task', id })
    nextTasks.push({
      id,
      title: task.title,
      goal: task.goal,
      anchor: {
        x: task.anchor.x + command.offset.x,
        y: task.anchor.y + command.offset.y,
      },
      collectionId: command.newCollectionId,
      origin: { kind: 'user' },
    })
  }

  const maxZ = maxNodeZ(document)
  const nextNodes: CanvasNode[] = []
  for (const [index, node] of sourceNodes.entries()) {
    const id = deterministicCanvasId(
      'node',
      'duplicate-collection',
      command.newCollectionId,
      node.id,
    )
    ensureEntityIdAvailable(document, id)
    entityMap.set(entityKey({ kind: 'node', id: node.id }), { kind: 'node', id })
    const homeTaskId = node.homeTaskId ? taskIdMap.get(node.homeTaskId) : undefined
    nextNodes.push({
      id,
      typeRef: structuredClone(node.typeRef),
      ...canvasNodeGeometry({
        ...canvasNodeWorldRect(node),
        x: canvasNodeWorldRect(node).x + command.offset.x,
        y: canvasNodeWorldRect(node).y + command.offset.y,
        z: maxZ + index + 1,
      }),
      title: node.title,
      ...(node.text === undefined ? {} : { text: node.text }),
      ...(node.payload === undefined ? {} : { payload: structuredClone(node.payload) }),
      artifactRefs: structuredClone(node.artifactRefs),
      ...(homeTaskId
        ? { homeTaskId }
        : { collectionId: command.newCollectionId }),
      origin: { kind: 'copied', sourceNodeId: node.id },
    })
  }

  const nextEdges: CanvasEdge[] = []
  for (const edge of document.edges) {
    const from = entityMap.get(entityKey(edge.from))
    const to = entityMap.get(entityKey(edge.to))
    if (!from || !to) continue
    const id = deterministicCanvasId(
      'edge',
      'duplicate-collection',
      command.newCollectionId,
      edge.id,
    )
    ensureEdgeIdAvailable(document, id)
    nextEdges.push({
      id,
      from: structuredClone(from),
      to: structuredClone(to),
      relation: edge.relation,
      contextRole: edge.contextRole,
      origin: { kind: 'user' },
    })
  }

  document.collections.push({
    id: command.newCollectionId,
    title: command.title ?? `${sourceCollection.title} copy`,
    anchor: {
      x: sourceCollection.anchor.x + command.offset.x,
      y: sourceCollection.anchor.y + command.offset.y,
    },
  })
  document.tasks.push(...nextTasks)
  document.nodes.push(...nextNodes)
  document.edges.push(...nextEdges)
  document.everCreated = true
}

function duplicateTaskAsDraft(
  document: CanvasDocument,
  command: Extract<CanvasCommand, { type: 'DuplicateTaskAsDraft' }>,
): void {
  const source = requireTask(document, command.sourceTaskId)
  requireClientOwnedId(command.newTaskId, 'task')
  ensureEntityIdAvailable(document, command.newTaskId)
  if (!Number.isFinite(command.offset.x) || !Number.isFinite(command.offset.y)) {
    throw new CanvasCommandError('invalid-offset', 'Duplicate offset must be finite')
  }

  const duplicate: CanvasTask = {
    id: command.newTaskId,
    title: command.title ?? `${source.title} copy`,
    goal: source.goal,
    anchor: {
      x: source.anchor.x + command.offset.x,
      y: source.anchor.y + command.offset.y,
    },
    ...(source.collectionId ? { collectionId: source.collectionId } : {}),
    origin: { kind: 'user' },
  }
  const copiedEdges: CanvasEdge[] = []
  for (const edge of document.edges) {
    if (edge.to.kind !== 'task' || edge.to.id !== source.id) continue
    const edgeId = deterministicCanvasId('edge', 'draft', command.newTaskId, edge.id)
    ensureEdgeIdAvailable(document, edgeId)
    copiedEdges.push({
      ...structuredClone(edge),
      id: edgeId,
      to: { kind: 'task', id: duplicate.id },
      origin: { kind: 'user' },
    })
  }

  document.tasks.push(duplicate)
  document.edges.push(...copiedEdges)
  document.everCreated = true
}

function materializeProjectionPlan(
  document: CanvasDocument,
  command: Extract<CanvasCommand, { type: 'MaterializeProjectionPlan' }>,
): void {
  const { plan } = command
  const task = requireTask(document, plan.taskId)
  projectionOutputsByKey(plan)
  const materializedOutputs = plan.outputs
    .map((output, index) => ({ output, index }))
    .filter(({ output }) => output.materialize)
    .sort((left, right) => outputRoleRank(left.output.role) - outputRoleRank(right.output.role)
      || left.index - right.index)
    .slice(0, 12)
    .map(({ output }) => output)

  const adoptedOutputKeys = new Set<string>()
  const adoptedNodeIds = new Set<string>()
  const nodeIdByOutput = new Map<string, string>()
  for (const output of materializedOutputs) {
    const candidates = document.nodes.filter((node) =>
      !adoptedNodeIds.has(node.id)
      && node.homeTaskId === task.id
      && node.typeRef.id === output.pluginId
      && isEmptyUserOutputSlot(node))
    if (candidates.length === 1) {
      const candidate = candidates[0]!
      adoptedOutputKeys.add(output.key)
      adoptedNodeIds.add(candidate.id)
      nodeIdByOutput.set(output.key, candidate.id)
      continue
    }
    const nodeId = deterministicCanvasId('node', plan.planId, output.key)
    ensureEntityIdAvailable(document, nodeId)
    nodeIdByOutput.set(output.key, nodeId)
  }

  const maxZ = maxNodeZ(document)
  const newNodes: CanvasNode[] = []
  for (const [index, output] of materializedOutputs.entries()) {
    const origin = {
      kind: 'agent-output' as const,
      taskId: task.id,
      runId: plan.runId,
      planId: plan.planId,
      outputKey: output.key,
    }
    if (adoptedOutputKeys.has(output.key)) {
      const node = requireNode(document, requireMappedId(nodeIdByOutput, output.key))
      node.title = output.title
      delete node.text
      delete node.payload
      node.artifactRefs = structuredClone(output.artifactRefs)
      node.origin = origin
      continue
    }
    newNodes.push({
      id: requireMappedId(nodeIdByOutput, output.key),
      typeRef: canvasNodeTypeRef(output.pluginId),
      ...projectionGeometry(task.anchor, index, maxZ),
      title: output.title,
      artifactRefs: structuredClone(output.artifactRefs),
      homeTaskId: task.id,
      origin,
    })
  }

  const newEdges: CanvasEdge[] = []
  for (const output of materializedOutputs) {
    const outputNodeId = requireMappedId(nodeIdByOutput, output.key)
    newEdges.push(agentEdge(
      deterministicCanvasId('edge', plan.planId, 'produced', output.key),
      { kind: 'task', id: task.id },
      { kind: 'node', id: outputNodeId },
      'produced',
      projectionOutputContextRole(output.role),
      plan.runId,
      plan.planId,
    ))
    for (const parentKey of output.derivedFrom) {
      const parentNodeId = nodeIdByOutput.get(parentKey)
      if (!parentNodeId) continue
      newEdges.push(agentEdge(
        deterministicCanvasId('edge', plan.planId, 'derived', parentKey, output.key),
        { kind: 'node', id: parentNodeId },
        { kind: 'node', id: outputNodeId },
        'derived',
        'full',
        plan.runId,
        plan.planId,
      ))
    }
  }
  for (const edge of newEdges) ensureEdgeIdAvailable(document, edge.id)

  document.nodes.push(...newNodes)
  document.edges.push(...newEdges)
  document.receipts.push({
    kind: 'materialization',
    planId: plan.planId,
    runId: plan.runId,
    taskId: task.id,
    outcomes: materializedOutputs.map((output) => ({
      outputKey: output.key,
      nodeId: requireMappedId(nodeIdByOutput, output.key),
    })),
    dismissedProposalKeys: [],
  })
  document.everCreated = true
}

function materializeGraphPlan(
  document: CanvasDocument,
  plan: TrustedGraphMaterializationPlanInput,
): void {
  requireTask(document, plan.taskId)
  if (plan.nodes.length < 1 || plan.nodes.length > 256 || plan.edges.length > 512) {
    throw new CanvasCommandError('invalid-graph-plan', 'Graph materialization plan exceeds bounds')
  }
  const logicalKeys = new Set<string>()
  const nodeIds = new Set<string>()
  const types = new Map(plan.nodeTypes.map((type) => [type.id, type]))
  for (const entry of plan.nodes) {
    if (logicalKeys.has(entry.logicalKey) || nodeIds.has(entry.node.id)) {
      throw new CanvasCommandError('invalid-graph-plan', 'Graph materialization plan duplicates a node')
    }
    logicalKeys.add(entry.logicalKey)
    nodeIds.add(entry.node.id)
    ensureEntityIdAvailable(document, entry.node.id)
    const type = types.get(entry.node.typeRef.id)
    if (!type || type.revision !== entry.node.typeRef.revision
      || type.digest !== entry.node.typeRef.digest
      || entry.node.origin.kind !== 'agent-output'
      || entry.node.origin.planId !== plan.planId
      || entry.node.origin.runId !== plan.runId
      || entry.node.origin.taskId !== plan.taskId
      || entry.node.origin.outputKey !== entry.logicalKey) {
      throw new CanvasCommandError('invalid-graph-plan', 'Graph node identity or type snapshot is invalid')
    }
  }
  for (const { node } of plan.nodes) {
    if (node.parentId !== null && !nodeIds.has(node.parentId)) {
      throw new CanvasCommandError('invalid-graph-plan', 'Graph node parent is outside the plan')
    }
    if (node.parentId === null && node.homeTaskId !== plan.taskId) {
      throw new CanvasCommandError('invalid-graph-plan', 'Graph root does not belong to its Task')
    }
    if (node.parentId !== null && (node.homeTaskId || node.collectionId)) {
      throw new CanvasCommandError('invalid-graph-plan', 'Graph descendant stores root ownership')
    }
  }
  for (const edge of plan.edges) {
    ensureEdgeIdAvailable(document, edge.id)
    if (edge.from.kind !== 'node' || edge.to.kind !== 'node'
      || !nodeIds.has(edge.from.id) || !nodeIds.has(edge.to.id)
      || edge.relation !== 'data' || edge.origin.kind !== 'agent'
      || edge.origin.planId !== plan.planId || edge.origin.runId !== plan.runId) {
      throw new CanvasCommandError('invalid-graph-plan', 'Graph edge is outside the trusted plan')
    }
  }
  document.nodes.push(...plan.nodes.map((entry) => structuredClone(entry.node)))
  document.edges.push(...structuredClone(plan.edges))
  document.receipts.push({
    kind: 'graph-materialization',
    planId: plan.planId,
    runId: plan.runId,
    taskId: plan.taskId,
    nodes: plan.nodes.map((entry) => ({ logicalKey: entry.logicalKey, nodeId: entry.node.id })),
  })
  document.everCreated = true
}

function materializeDecompositionPlan(
  document: CanvasDocument,
  plan: PdfMaterializationPlan,
): void {
  requireTask(document, plan.taskId)
  if (plan.nodes.length < 1 || plan.nodes.length > 256) {
    throw new CanvasCommandError('invalid-decomposition-plan', 'PDF decomposition plan exceeds bounds')
  }
  const plannedIds = new Set(plan.nodes.map((entry) => entry.node.id))
  if (plannedIds.size !== plan.nodes.length) {
    throw new CanvasCommandError('invalid-decomposition-plan', 'PDF decomposition plan duplicates nodes')
  }
  if (plan.kind === 'document') {
    if (plan.nodes.length !== 1 || plan.nodes[0]?.node.id !== plan.documentNodeId
      || plan.nodes[0]?.node.typeRef.id !== 'pdf-document') {
      throw new CanvasCommandError('invalid-decomposition-plan', 'PDF document plan is invalid')
    }
  } else {
    const documentNode = requireNode(document, plan.documentNodeId)
    if (documentNode.typeRef.id !== 'pdf-document'
      || documentNode.payload?.sourcePdfDigest !== plan.sourcePdfDigest) {
      throw new CanvasCommandError('invalid-decomposition-plan', 'PDF source document does not match')
    }
  }
  for (const entry of plan.nodes) {
    ensureEntityIdAvailable(document, entry.node.id)
    if (entry.node.origin.kind !== 'agent-output'
      || entry.node.origin.planId !== plan.planId
      || entry.node.origin.runId !== plan.activityRunId
      || entry.node.origin.taskId !== plan.taskId
      || entry.node.origin.outputKey !== entry.logicalKey) {
      throw new CanvasCommandError('invalid-decomposition-plan', 'PDF node origin is invalid')
    }
    const parentId = entry.node.parentId
    if (plan.kind === 'document') {
      if (parentId !== null || entry.node.homeTaskId !== plan.taskId) {
        throw new CanvasCommandError('invalid-decomposition-plan', 'PDF document ownership is invalid')
      }
    } else if (parentId !== plan.documentNodeId && !plannedIds.has(parentId ?? '')) {
      throw new CanvasCommandError('invalid-decomposition-plan', 'PDF child parent is outside the plan')
    }
  }
  document.nodes.push(...plan.nodes.map((entry) => structuredClone(entry.node)))
  document.receipts.push({
    kind: 'decomposition-materialization',
    planId: plan.planId,
    runId: plan.activityRunId,
    taskId: plan.taskId,
    importId: plan.importId,
    nodes: plan.nodes.map((entry) => ({ logicalKey: entry.logicalKey, nodeId: entry.node.id })),
  })
  document.everCreated = true
}

function createInstance(document: CanvasDocument, node: CanvasNode): void {
  requireClientOwnedId(node.id, 'node')
  ensureEntityIdAvailable(document, node.id)
  if (node.typeRef.id !== 'instance' || !node.instanceRef
    || node.origin.kind !== 'user' || node.artifactRefs.length > 0) {
    throw new CanvasCommandError('invalid-instance', 'Trusted instance node is invalid')
  }
  if (node.parentId) requireNode(document, node.parentId)
  if (node.homeTaskId) requireTask(document, node.homeTaskId)
  if (node.collectionId) requireCollection(document, node.collectionId)
  document.nodes.push(structuredClone(node))
  document.everCreated = true
}

function detachInstance(
  document: CanvasDocument,
  nodeId: string,
  expansion?: TrustedInstanceExpansion,
): void {
  if (!expansion) return
  const instance = requireNode(document, nodeId)
  if (!instance.instanceRef) throw new CanvasCommandError('not-an-instance', 'Node is not an instance')
  if (document.nodes.some((node) => node.parentId === instance.id)) {
    throw new CanvasCommandError('instance-has-children', 'Instance cannot own persisted children before detach')
  }
  document.nodes = document.nodes.filter((node) => node.id !== instance.id)
  for (const node of expansion.nodes) {
    ensureEntityIdAvailable(document, node.id)
    if (node.instanceRef) throw new CanvasCommandError('invalid-instance-expansion', 'Detached nodes retain instance refs')
    document.nodes.push(structuredClone(node))
  }
  for (const edge of expansion.edges) {
    ensureEdgeIdAvailable(document, edge.id)
    document.edges.push(structuredClone(edge))
  }
  for (const patch of expansion.edgePatches) {
    const edge = document.edges.find((candidate) => candidate.id === patch.edgeId)
    if (!edge) throw new CanvasCommandError('invalid-instance-expansion', 'Instance edge patch is dangling')
    if (patch.from) edge.from = structuredClone(patch.from)
    if (patch.to) edge.to = structuredClone(patch.to)
  }
}

function updateInstanceRef(
  document: CanvasDocument,
  nodeId: string,
  instanceRef: { definitionId: string; revision: number; digest: string },
): void {
  const node = requireNode(document, nodeId)
  if (!node.instanceRef) throw new CanvasCommandError('not-an-instance', 'Node is not an instance')
  node.instanceRef = structuredClone(instanceRef)
}

function acceptTaskProposals(
  document: CanvasDocument,
  command: Extract<CanvasCommand, { type: 'AcceptTaskProposals' }>,
): void {
  const { plan } = command
  const parent = requireTask(document, plan.taskId)
  if (command.proposalKeys.length === 0
    || command.proposalKeys.length > MAX_ACCEPTED_TASK_PROPOSALS) {
    throw new CanvasCommandError('invalid-proposals', 'AcceptTaskProposals requires 1 to 12 proposals')
  }
  requireUniqueKeys(command.proposalKeys, 'proposal keys')
  requireUniqueKeys(plan.taskProposals.map((proposal) => proposal.key), 'plan proposal keys')
  const proposalsByKey = new Map(plan.taskProposals.map((proposal) => [proposal.key, proposal]))
  const selectedKeys = new Set(command.proposalKeys)
  const edits = parseTaskProposalEdits(command.edits, selectedKeys)
  const proposals = command.proposalKeys.map((proposalKey): TrustedTaskProposal => {
    const proposal = proposalsByKey.get(proposalKey)
    if (!proposal) {
      throw new CanvasCommandError(
        'proposal-not-found',
        `Proposal ${proposalKey} is not present in plan ${plan.planId}`,
      )
    }
    const edit = edits.get(proposalKey)
    return {
      ...structuredClone(proposal),
      ...(edit?.title === undefined ? {} : { title: edit.title }),
      ...(edit?.prompt === undefined ? {} : { prompt: edit.prompt }),
      dependsOn: edit?.dependsOn === undefined
        ? [...proposal.dependsOn]
        : [...edit.dependsOn],
    }
  })
  validateSelectedProposalGraph(proposals, selectedKeys)
  const materialization = findReceipt(document, 'materialization', plan.planId)
  if (!materialization) {
    throw new CanvasCommandError(
      'materialization-receipt-missing',
      `Plan ${plan.planId} must be materialized before its proposals can be accepted`,
    )
  }
  if (materialization.dismissedProposalKeys.some((key) => command.proposalKeys.includes(key))) {
    throw new CanvasCommandError('proposal-dismissed', 'A dismissed proposal cannot be accepted')
  }

  const outcomeNodeIdByKey = materializeProposalInputOutputs(
    document,
    parent,
    plan,
    materialization,
    proposals,
  )

  const newTasks = proposals.map((proposal, index): CanvasTask => {
    const taskId = deterministicCanvasId('task', plan.planId, proposal.key)
    ensureEntityIdAvailable(document, taskId)
    return {
      id: taskId,
      title: proposal.title,
      goal: proposal.prompt,
      anchor: { x: parent.anchor.x + 48, y: parent.anchor.y + 96 + index * 112 },
      ...(parent.collectionId ? { collectionId: parent.collectionId } : {}),
      origin: {
        kind: 'agent-proposal',
        parentTaskId: parent.id,
        planId: plan.planId,
        proposalKey: proposal.key,
      },
    }
  })
  const taskIdByProposal = new Map(proposals.map((proposal, index) => [
    proposal.key,
    newTasks[index]!.id,
  ]))
  const newEdges: CanvasEdge[] = []
  for (const proposal of proposals) {
    const proposalTaskId = requireMappedId(taskIdByProposal, proposal.key)
    for (const outputKey of proposal.inputOutputKeys) {
      const nodeId = requireMappedId(outcomeNodeIdByKey, outputKey)
      requireNode(document, nodeId)
      newEdges.push(agentEdge(
        deterministicCanvasId('edge', plan.planId, 'proposal-source', outputKey, proposal.key),
        { kind: 'node', id: nodeId },
        { kind: 'task', id: proposalTaskId },
        'source',
        'full',
        plan.runId,
        plan.planId,
      ))
    }
    for (const dependencyKey of proposal.dependsOn) {
      const dependencyTaskId = taskIdByProposal.get(dependencyKey)
      if (!dependencyTaskId) continue
      newEdges.push(agentEdge(
        deterministicCanvasId(
          'edge',
          plan.planId,
          'proposal-dependency',
          dependencyKey,
          proposal.key,
        ),
        { kind: 'task', id: dependencyTaskId },
        { kind: 'task', id: proposalTaskId },
        'depends-on',
        'summary',
        plan.runId,
        plan.planId,
      ))
    }
  }
  for (const edge of newEdges) ensureEdgeIdAvailable(document, edge.id)
  document.tasks.push(...newTasks)
  document.edges.push(...newEdges)
  document.receipts.push({
    kind: 'proposal-acceptance',
    planId: plan.planId,
    runId: plan.runId,
    taskId: parent.id,
    proposals: proposals.map((proposal, index) => ({
      proposalKey: proposal.key,
      taskId: newTasks[index]!.id,
    })),
  })
  const dismissedProposalKeys = plan.taskProposals
    .map((proposal) => proposal.key)
    .filter((proposalKey) => !selectedKeys.has(proposalKey))
  if (dismissedProposalKeys.length > 0) {
    document.receipts.push({
      kind: 'plan-dismissal',
      planId: plan.planId,
      runId: plan.runId,
      taskId: parent.id,
      proposalKeys: dismissedProposalKeys,
    })
  }
  document.everCreated = true
}

function materializeProposalInputOutputs(
  document: CanvasDocument,
  parent: CanvasTask,
  plan: TrustedProjectionPlanInput,
  materialization: CanvasMaterializationReceipt,
  proposals: readonly TrustedTaskProposal[],
): Map<string, string> {
  const outputsByKey = projectionOutputsByKey(plan)
  const directInputKeys = new Set<string>()
  for (const proposal of proposals) {
    if (proposal.inputOutputKeys.length > MAX_TASK_PROPOSAL_INPUTS
      || new Set(proposal.inputOutputKeys).size !== proposal.inputOutputKeys.length) {
      throw new CanvasCommandError(
        'invalid-proposal-inputs',
        `Proposal ${proposal.key} input outputs must be bounded and unique`,
      )
    }
    for (const outputKey of proposal.inputOutputKeys) {
      if (!outputsByKey.has(outputKey)) {
        throw new CanvasCommandError(
          'proposal-input-output-not-found',
          `Proposal ${proposal.key} references missing output ${outputKey}`,
        )
      }
      directInputKeys.add(outputKey)
    }
  }

  const requiredOutputKeys = new Set(directInputKeys)
  const pendingLineageKeys = [...directInputKeys]
  while (pendingLineageKeys.length > 0) {
    const outputKey = pendingLineageKeys.pop()!
    const output = outputsByKey.get(outputKey)!
    for (const parentKey of output.derivedFrom) {
      if (!outputsByKey.has(parentKey)) {
        throw new CanvasCommandError(
          'proposal-input-lineage-output-not-found',
          `Proposal input ${output.key} derives from missing output ${parentKey}`,
        )
      }
      if (requiredOutputKeys.has(parentKey)) continue
      requiredOutputKeys.add(parentKey)
      pendingLineageKeys.push(parentKey)
    }
  }

  const outcomeNodeIdByKey = new Map<string, string>()
  for (const outcome of materialization.outcomes) {
    const output = outputsByKey.get(outcome.outputKey)
    if (!output) {
      throw new CanvasCommandError(
        'plan-receipt-conflict',
        `Materialization receipt references unknown output ${outcome.outputKey}`,
      )
    }
    outcomeNodeIdByKey.set(outcome.outputKey, outcome.nodeId)
    if (requiredOutputKeys.has(outcome.outputKey)) {
      requireExistingProposalInputNode(document, plan, output, outcome.nodeId)
    }
  }

  const missingOutputs = plan.outputs.filter((output) =>
    requiredOutputKeys.has(output.key) && !outcomeNodeIdByKey.has(output.key))
  if (missingOutputs.length === 0) return outcomeNodeIdByKey

  const newNodeIdByKey = new Map<string, string>()
  for (const output of missingOutputs) {
    const nodeId = deterministicCanvasId('node', plan.planId, output.key)
    ensureEntityIdAvailable(document, nodeId)
    newNodeIdByKey.set(output.key, nodeId)
    outcomeNodeIdByKey.set(output.key, nodeId)
  }

  const maxZ = maxNodeZ(document)
  const firstLayoutIndex = materialization.outcomes.length
  const newNodes = missingOutputs.map((output, index): CanvasNode => ({
    id: requireMappedId(newNodeIdByKey, output.key),
    typeRef: canvasNodeTypeRef(output.pluginId),
    ...projectionGeometry(parent.anchor, firstLayoutIndex + index, maxZ),
    title: output.title,
    artifactRefs: structuredClone(output.artifactRefs),
    homeTaskId: parent.id,
    origin: {
      kind: 'agent-output',
      taskId: parent.id,
      runId: plan.runId,
      planId: plan.planId,
      outputKey: output.key,
    },
  }))

  const newEdges: CanvasEdge[] = []
  for (const output of missingOutputs) {
    const nodeId = requireMappedId(newNodeIdByKey, output.key)
    newEdges.push(agentEdge(
      deterministicCanvasId('edge', plan.planId, 'produced', output.key),
      { kind: 'task', id: parent.id },
      { kind: 'node', id: nodeId },
      'produced',
      projectionOutputContextRole(output.role),
      plan.runId,
      plan.planId,
    ))
  }

  const missingKeys = new Set(missingOutputs.map((output) => output.key))
  for (const output of plan.outputs) {
    const outputNodeId = outcomeNodeIdByKey.get(output.key)
    if (!outputNodeId) continue
    for (const parentKey of output.derivedFrom) {
      const parentNodeId = outcomeNodeIdByKey.get(parentKey)
      if (!parentNodeId || (!missingKeys.has(output.key) && !missingKeys.has(parentKey))) continue
      const edge = agentEdge(
        deterministicCanvasId('edge', plan.planId, 'derived', parentKey, output.key),
        { kind: 'node', id: parentNodeId },
        { kind: 'node', id: outputNodeId },
        'derived',
        'full',
        plan.runId,
        plan.planId,
      )
      const existing = document.edges.find((candidate) => candidate.id === edge.id)
      if (existing) {
        if (!sameCanvasEdge(existing, edge)) {
          throw new CanvasCommandError('edge-id-conflict', `Edge id ${edge.id} is already in use`)
        }
        continue
      }
      newEdges.push(edge)
    }
  }

  for (const edge of newEdges) ensureEdgeIdAvailable(document, edge.id)
  materialization.outcomes.push(...missingOutputs.map((output) => ({
    outputKey: output.key,
    nodeId: requireMappedId(newNodeIdByKey, output.key),
  })))
  document.nodes.push(...newNodes)
  document.edges.push(...newEdges)
  return outcomeNodeIdByKey
}

function projectionOutputsByKey(
  plan: TrustedProjectionPlanInput,
): Map<string, TrustedProjectionOutput> {
  if (plan.outputs.length > MAX_TRUSTED_PROJECTION_OUTPUTS) {
    throw new CanvasCommandError(
      'invalid-plan',
      `Projection plan may contain at most ${MAX_TRUSTED_PROJECTION_OUTPUTS} outputs`,
    )
  }
  const outputKeys = plan.outputs.map((output) => output.key)
  if (new Set(outputKeys).size !== outputKeys.length) {
    throw new CanvasCommandError('invalid-plan', 'Projection plan output keys must be unique')
  }
  return new Map(plan.outputs.map((output) => [output.key, output]))
}

function requireExistingProposalInputNode(
  document: CanvasDocument,
  plan: TrustedProjectionPlanInput,
  output: TrustedProjectionOutput,
  nodeId: string,
): CanvasNode {
  const node = document.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) {
    throw new CanvasCommandError(
      'proposal-input-node-missing',
      `Materialized proposal input ${output.key} is no longer on the canvas`,
    )
  }
  if (node.typeRef.id !== output.pluginId
    || node.origin.kind !== 'agent-output'
    || node.origin.taskId !== plan.taskId
    || node.origin.runId !== plan.runId
    || node.origin.planId !== plan.planId
    || node.origin.outputKey !== output.key
    || JSON.stringify(node.artifactRefs) !== JSON.stringify(output.artifactRefs)) {
    throw new CanvasCommandError(
      'proposal-input-node-conflict',
      `Materialized proposal input ${output.key} does not match its trusted output`,
    )
  }
  return node
}

function sameCanvasEdge(left: CanvasEdge, right: CanvasEdge): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function parseTaskProposalEdits(
  value: TaskProposalEdits | undefined,
  selectedKeys: ReadonlySet<string>,
): ReadonlyMap<string, TaskProposalEdit> {
  if (value === undefined) return new Map()
  if (!isPlainRecord(value)) {
    throw new CanvasCommandError('invalid-proposal-edits', 'Proposal edits must be an object')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_ACCEPTED_TASK_PROPOSALS) {
    throw new CanvasCommandError('invalid-proposal-edits', 'Proposal edits are too large')
  }
  const edits = new Map<string, TaskProposalEdit>()
  for (const [proposalKey, candidate] of entries) {
    if (!selectedKeys.has(proposalKey)) {
      throw new CanvasCommandError(
        'proposal-edit-not-selected',
        `Proposal edit ${proposalKey} is not selected`,
      )
    }
    if (!isPlainRecord(candidate)) {
      throw new CanvasCommandError('invalid-proposal-edits', `Proposal edit ${proposalKey} is invalid`)
    }
    const fields = Object.keys(candidate)
    if (fields.length === 0
      || fields.some((field) => field !== 'title'
        && field !== 'prompt'
        && field !== 'dependsOn')) {
      throw new CanvasCommandError('invalid-proposal-edits', `Proposal edit ${proposalKey} is invalid`)
    }
    const title = candidate.title === undefined
      ? undefined
      : requireTaskProposalDisplayString(
        candidate.title,
        MAX_TASK_PROPOSAL_EDIT_TITLE_LENGTH,
        `${proposalKey}.title`,
      )
    const prompt = candidate.prompt === undefined
      ? undefined
      : requireTaskProposalDisplayString(
        candidate.prompt,
        MAX_TASK_PROPOSAL_EDIT_PROMPT_LENGTH,
        `${proposalKey}.prompt`,
      )
    let dependsOn: string[] | undefined
    if (candidate.dependsOn !== undefined) {
      if (!Array.isArray(candidate.dependsOn)
        || candidate.dependsOn.length > MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES
        || !candidate.dependsOn.every((dependency) => typeof dependency === 'string')) {
        throw new CanvasCommandError(
          'invalid-proposal-dependency',
          `Proposal edit ${proposalKey}.dependsOn is invalid`,
        )
      }
      dependsOn = [...candidate.dependsOn]
    }
    if (title === undefined && prompt === undefined && dependsOn === undefined) {
      throw new CanvasCommandError(
        'invalid-proposal-edits',
        `Proposal edit ${proposalKey} must change title, prompt, or dependencies`,
      )
    }
    edits.set(proposalKey, {
      ...(title === undefined ? {} : { title }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
    })
  }
  return edits
}

function requireTaskProposalDisplayString(
  value: unknown,
  maxLength: number,
  label: string,
): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()) {
    throw new CanvasCommandError('invalid-proposal-edits', `Proposal edit ${label} is invalid`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      throw new CanvasCommandError('invalid-proposal-edits', `Proposal edit ${label} is invalid`)
    }
  }
  return value
}

function validateSelectedProposalGraph(
  proposals: readonly TrustedTaskProposal[],
  selectedKeys: ReadonlySet<string>,
): void {
  const proposalsByKey = new Map(proposals.map((proposal) => [proposal.key, proposal]))
  for (const proposal of proposals) {
    if (proposal.dependsOn.length > MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES
      || new Set(proposal.dependsOn).size !== proposal.dependsOn.length) {
      throw new CanvasCommandError(
        'invalid-proposal-dependency',
        `Proposal ${proposal.key} dependencies must be bounded and unique`,
      )
    }
    for (const dependencyKey of proposal.dependsOn) {
      if (dependencyKey === proposal.key) {
        throw new CanvasCommandError(
          'invalid-proposal-dependency',
          `Proposal ${proposal.key} cannot depend on itself`,
        )
      }
      if (!selectedKeys.has(dependencyKey) || !proposalsByKey.has(dependencyKey)) {
        throw new CanvasCommandError(
          'invalid-proposal-dependency',
          `Proposal ${proposal.key} depends on an unselected proposal ${dependencyKey}`,
        )
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (proposalKey: string) => {
    if (visited.has(proposalKey)) return
    if (visiting.has(proposalKey)) {
      throw new CanvasCommandError(
        'proposal-dependency-cycle',
        'Selected proposal dependencies must form a DAG',
      )
    }
    visiting.add(proposalKey)
    for (const dependencyKey of proposalsByKey.get(proposalKey)?.dependsOn ?? []) {
      visit(dependencyKey)
    }
    visiting.delete(proposalKey)
    visited.add(proposalKey)
  }
  for (const proposal of proposals) visit(proposal.key)
}

function dismissPlan(
  document: CanvasDocument,
  command: Extract<CanvasCommand, { type: 'DismissPlan' }>,
): void {
  const { plan } = command
  requireTask(document, plan.taskId)
  const proposalKeys = plan.taskProposals.map((proposal) => proposal.key)
  requireUniqueKeys(proposalKeys, 'proposal keys')
  ensurePlanReceiptIdentity(document, plan.planId, plan.runId, plan.taskId)
  const acceptance = findReceipt(document, 'proposal-acceptance', plan.planId)
  const acceptedKeys = new Set(acceptance?.proposals.map((proposal) => proposal.proposalKey) ?? [])
  document.receipts.push({
    kind: 'plan-dismissal',
    planId: plan.planId,
    runId: plan.runId,
    taskId: plan.taskId,
    proposalKeys: proposalKeys.filter((key) => !acceptedKeys.has(key)),
  })
}

function isIdempotentReplay(document: CanvasDocument, command: CanvasCommand): boolean {
  if (command.type === 'MaterializeGraphPlan') {
    ensurePlanReceiptIdentity(
      document, command.plan.planId, command.plan.runId, command.plan.taskId,
    )
    return Boolean(findReceipt(document, 'graph-materialization', command.plan.planId))
  }
  if (command.type === 'MaterializeDecompositionPlan') {
    ensurePlanReceiptIdentity(
      document,
      command.plan.planId,
      command.plan.activityRunId,
      command.plan.taskId,
    )
    return Boolean(findReceipt(document, 'decomposition-materialization', command.plan.planId))
  }
  if (command.type === 'MaterializeProjectionPlan') {
    ensurePlanReceiptIdentity(
      document,
      command.plan.planId,
      command.plan.runId,
      command.plan.taskId,
    )
    return Boolean(findReceipt(document, 'materialization', command.plan.planId)
      || findReceipt(document, 'plan-dismissal', command.plan.planId))
  }
  if (command.type === 'AcceptTaskProposals') {
    ensurePlanReceiptIdentity(
      document,
      command.plan.planId,
      command.plan.runId,
      command.plan.taskId,
    )
    return Boolean(findReceipt(document, 'proposal-acceptance', command.plan.planId)
      || findReceipt(document, 'plan-dismissal', command.plan.planId))
  }
  if (command.type === 'DismissPlan') {
    ensurePlanReceiptIdentity(
      document,
      command.plan.planId,
      command.plan.runId,
      command.plan.taskId,
    )
    return Boolean(findReceipt(document, 'plan-dismissal', command.plan.planId))
  }
  return false
}

function ensurePlanReceiptIdentity(
  document: CanvasDocument,
  planId: string,
  runId: string,
  taskId: string,
): void {
  const receipt = document.receipts.find((entry) => entry.planId === planId)
  if (receipt && (receipt.runId !== runId || receipt.taskId !== taskId)) {
    throw new CanvasCommandError(
      'plan-receipt-conflict',
      `Plan ${planId} already has a receipt for another run or task`,
    )
  }
}

function findReceipt<K extends CanvasReceipt['kind']>(
  document: CanvasDocument,
  kind: K,
  planId: string,
): Extract<CanvasReceipt, { kind: K }> | undefined {
  return document.receipts.find((receipt): receipt is Extract<CanvasReceipt, { kind: K }> =>
    receipt.kind === kind && receipt.planId === planId)
}

function setCollectionMembership(
  document: CanvasDocument,
  collectionId: string,
  refs: CanvasEntityRef[],
): void {
  for (const ref of refs) {
    if (ref.kind === 'node') requireNode(document, ref.id).collectionId = collectionId
    else requireTask(document, ref.id).collectionId = collectionId
  }
}

function ensureTopLevelUncollected(document: CanvasDocument, ref: CanvasEntityRef): void {
  if (ref.kind === 'node') {
    const node = requireNode(document, ref.id)
    if (node.homeTaskId) {
      throw new CanvasCommandError(
        'task-node-cannot-be-collected',
        `Node ${node.id} belongs to task ${node.homeTaskId}`,
      )
    }
    if (node.collectionId) {
      throw new CanvasCommandError('already-collected', `Node ${node.id} is already collected`)
    }
  } else {
    const task = requireTask(document, ref.id)
    if (task.collectionId) {
      throw new CanvasCommandError('already-collected', `Task ${task.id} is already collected`)
    }
  }
}

function removeEntities(
  document: CanvasDocument,
  taskIds: Set<string>,
  nodeIds: Set<string>,
): void {
  document.tasks = document.tasks.filter((task) => !taskIds.has(task.id))
  document.nodes = document.nodes.filter((node) => !nodeIds.has(node.id))
  document.edges = document.edges.filter((edge) =>
    !(edge.from.kind === 'task' ? taskIds.has(edge.from.id) : nodeIds.has(edge.from.id))
    && !(edge.to.kind === 'task' ? taskIds.has(edge.to.id) : nodeIds.has(edge.to.id)))
}

function requireUniqueRefs(refs: CanvasEntityRef[]): CanvasEntityRef[] {
  if (refs.length > 10_000) throw new CanvasCommandError('too-many-entities', 'Entity list is too large')
  const keys = refs.map(entityKey)
  if (new Set(keys).size !== keys.length) {
    throw new CanvasCommandError('duplicate-entities', 'Entity references must be unique')
  }
  return refs
}

function requireUniqueKeys(keys: string[], label: string): void {
  if (keys.length > 64 || new Set(keys).size !== keys.length) {
    throw new CanvasCommandError('invalid-keys', `${label} must be bounded and unique`)
  }
}

function requireNode(document: CanvasDocument, nodeId: string): CanvasNode {
  const node = document.nodes.find((entry) => entry.id === nodeId)
  if (!node) throw new CanvasCommandError('node-not-found', `Node ${nodeId} does not exist`)
  return node
}

function requireEntity(document: CanvasDocument, ref: CanvasEntityRef): void {
  if (!isEntityRef(ref)) {
    throw new CanvasCommandError('invalid-edge-endpoint', 'Edge endpoint is invalid')
  }
  if (ref.kind === 'node') requireNode(document, ref.id)
  else requireTask(document, ref.id)
}

function requireEdge(document: CanvasDocument, edgeId: string): CanvasEdge {
  const edge = document.edges.find((entry) => entry.id === edgeId)
  if (!edge) throw new CanvasCommandError('edge-not-found', `Edge ${edgeId} does not exist`)
  return edge
}

function requireTask(document: CanvasDocument, taskId: string): CanvasTask {
  const task = document.tasks.find((entry) => entry.id === taskId)
  if (!task) throw new CanvasCommandError('task-not-found', `Task ${taskId} does not exist`)
  return task
}

function requireCollection(
  document: CanvasDocument,
  collectionId: string,
): CanvasCollection {
  const collection = document.collections.find((entry) => entry.id === collectionId)
  if (!collection) {
    throw new CanvasCommandError(
      'collection-not-found',
      `Collection ${collectionId} does not exist`,
    )
  }
  return collection
}

function ensureEntityIdAvailable(document: CanvasDocument, id: string): void {
  if (document.nodes.some((node) => node.id === id)
    || document.tasks.some((task) => task.id === id)
    || document.collections.some((collection) => collection.id === id)) {
    throw new CanvasCommandError('entity-id-conflict', `Entity id ${id} is already in use`)
  }
}

function ensureEdgeIdAvailable(document: CanvasDocument, id: string): void {
  if (document.edges.some((edge) => edge.id === id)) {
    throw new CanvasCommandError('edge-id-conflict', `Edge id ${id} is already in use`)
  }
}

function requireClientOwnedId(id: string, kind: string): void {
  if (isReservedCanvasId(id)) {
    throw new CanvasCommandError(
      'reserved-id',
      `Browser commands cannot assign trusted ${kind} id ${id}`,
    )
  }
}

function requireValidEdgeSemantics(edge: CanvasEdge): void {
  if (!isEntityRef(edge.from) || !isEntityRef(edge.to)) {
    throw new CanvasCommandError('invalid-edge-endpoint', 'Edge endpoints must be typed entities')
  }
  requireEdgeRelation(edge.relation)
  requireContextRole(edge.contextRole)
  if (edge.relation === 'data'
    && (edge.contextRole !== 'none' || !edge.orderKey)) {
    throw new CanvasCommandError(
      'invalid-data-edge',
      'Data edges require contextRole none and an orderKey',
    )
  }
  const issue = canvasEdgeTopologyIssue(edge)
  if (issue) throw new CanvasCommandError('invalid-edge-topology', issue)
}

function requireEdgeRelation(value: unknown): asserts value is CanvasEdgeRelation {
  if (value !== 'source'
    && value !== 'produced'
    && value !== 'derived'
    && value !== 'modified'
    && value !== 'references'
    && value !== 'compares'
    && value !== 'replaces'
    && value !== 'depends-on'
    && value !== 'data') {
    throw new CanvasCommandError('invalid-edge-relation', 'Edge relation is invalid')
  }
}

function requireContextRole(value: unknown): asserts value is CanvasEdgeContextRole {
  if (value !== 'full' && value !== 'summary' && value !== 'none') {
    throw new CanvasCommandError('invalid-context-role', 'Edge contextRole is invalid')
  }
}

function isEntityRef(value: unknown): value is CanvasEntityRef {
  if (!isPlainRecord(value)
    || (value.kind !== 'node' && value.kind !== 'task')
    || typeof value.id !== 'string') return false
  if (value.kind === 'task') return hasExactKeys(value, ['kind', 'id'])
  return hasExactKeys(value, value.port === undefined ? ['kind', 'id'] : ['kind', 'id', 'port'])
    && (value.port === undefined
      || (typeof value.port === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.port)))
}

function isExactUserOrigin(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['kind'])
    && value.kind === 'user'
}

function isEmptyUserOutputSlot(node: CanvasNode): boolean {
  return node.origin.kind === 'user'
    && node.artifactRefs.length === 0
    && (node.text === undefined || node.text.trim().length === 0)
    && (node.payload === undefined || Object.keys(node.payload).length === 0)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function requireMappedId(map: Map<string, string>, key: string): string {
  const value = map.get(key)
  if (!value) throw new CanvasCommandError('mapping-missing', `No deterministic id for ${key}`)
  return value
}

function uniqueIds(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new CanvasCommandError(`invalid-${label}-ids`, `${label} node ids are invalid`)
  }
  const unique = [...new Set(values)]
  if (unique.length !== values.length) {
    throw new CanvasCommandError(`duplicate-${label}-ids`, `${label} contains duplicate node ids`)
  }
  return unique
}

function requireOrdinaryId(value: string, label: string): void {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    || value.includes('..')) {
    throw new CanvasCommandError(`invalid-${label}`, `${label} is invalid`)
  }
}

type Matrix = [number, number, number, number, number, number]

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0]
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = left
  const [a2, b2, c2, d2, e2, f2] = right
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

function invertMatrix(matrix: Matrix): Matrix {
  const [a, b, c, d, e, f] = matrix
  const determinant = a * d - b * c
  if (Math.abs(determinant) < 1e-12) {
    throw new CanvasCommandError('invalid-node-transform', 'Node transform is not invertible')
  }
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ]
}

function worldTransform(node: CanvasNode, nodesById: Map<string, CanvasNode>): Matrix {
  const chain: CanvasNode[] = []
  const seen = new Set<string>()
  let current: CanvasNode | undefined = node
  while (current) {
    if (seen.has(current.id)) throw new CanvasCommandError('containment-cycle', 'Containment cycle detected')
    seen.add(current.id)
    chain.push(current)
    current = current.parentId ? nodesById.get(current.parentId) : undefined
    if (chain.length > 32) throw new CanvasCommandError('containment-depth', 'Containment depth exceeds 32')
  }
  return chain.reverse().reduce(
    (matrix, entry) => multiplyMatrices(matrix, entry.transform.matrix),
    identityMatrix(),
  )
}

function maxNodeZ(document: CanvasDocument): number {
  return document.nodes.reduce((maximum, node) => Math.max(maximum, canvasNodeWorldRect(node).z), 0)
}

function projectionGeometry(anchor: CanvasPoint, index: number, maxZ: number) {
  const frame = taskOutputFrame(anchor, index)
  return canvasNodeGeometry({
    ...frame,
    z: maxZ + index + 1,
  })
}

function agentEdge(
  id: string,
  from: CanvasEntityRef,
  to: CanvasEntityRef,
  relation: 'produced' | 'derived' | 'source' | 'depends-on',
  contextRole: 'full' | 'summary' | 'none',
  runId: string,
  planId: string,
): CanvasEdge {
  return {
    id,
    from,
    to,
    relation,
    contextRole,
    origin: { kind: 'agent', runId, planId },
  }
}

function outputRoleRank(role: TrustedProjectionOutputRole): number {
  if (role === 'primary') return 0
  if (role === 'supporting') return 1
  return 2
}

function projectionOutputContextRole(
  role: TrustedProjectionOutputRole,
): CanvasEdgeContextRole {
  if (role === 'primary') return 'full'
  if (role === 'supporting') return 'summary'
  return 'none'
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
