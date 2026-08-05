import {
  assertCanvasDocumentV2,
  canvasEdgeTopologyIssueV2,
  cloneCanvasDocumentV2,
  entityKeyV2,
  isReservedCanvasIdV2,
  type CanvasCollectionV2,
  type CanvasDocumentV2,
  type CanvasEdgeContextRoleV2,
  type CanvasEdgeRelationV2,
  type CanvasEdgeV2,
  type CanvasEntityRef,
  type CanvasNodeV2,
  type CanvasPointV2,
  type CanvasReceiptV2,
  type CanvasTaskV2,
} from './model.js'
import { taskOutputFrameV2 } from './layout.js'

export type TrustedProjectionOutputRoleV2 = 'primary' | 'supporting' | 'auxiliary'

export interface TrustedProjectionArtifactRefV2 {
  runId: string
  artifactId: string
}

export interface TrustedProjectionOutputV2 {
  key: string
  pluginId: string
  role: TrustedProjectionOutputRoleV2
  title: string
  artifactRefs: TrustedProjectionArtifactRefV2[]
  derivedFrom: string[]
  materialize: boolean
}

export interface TrustedTaskProposalV2 {
  key: string
  title: string
  prompt: string
  inputOutputKeys: string[]
  dependsOn: string[]
}

export interface TrustedProjectionPlanInputV2 {
  schemaVersion: 2
  taskId: string
  planId: string
  runId: string
  status: 'complete' | 'partial'
  manifestDigest: string
  outputs: TrustedProjectionOutputV2[]
  taskProposals: TrustedTaskProposalV2[]
  warnings: string[]
  digest: string
}

export interface UpdateNodeContentPatchV2 {
  title?: string
  text?: string | null
  payload?: Record<string, unknown> | null
}

export interface UpdateEdgePatchV2 {
  from?: CanvasEntityRef
  to?: CanvasEntityRef
  relation?: CanvasEdgeRelationV2
  contextRole?: CanvasEdgeContextRoleV2
}

export interface DerivedTaskSourceV2 {
  entity: CanvasEntityRef
  relation: 'source' | 'modified'
  contextRole: CanvasEdgeContextRoleV2
}

export type CanvasCommandV2 =
  | { type: 'CreateTask'; task: CanvasTaskV2 }
  | { type: 'UpdateTaskGoal'; taskId: string; goal: string }
  | { type: 'CreateNode'; node: CanvasNodeV2 }
  | { type: 'UpdateNodeContent'; nodeId: string; patch: UpdateNodeContentPatchV2 }
  | { type: 'ResizeNode'; nodeId: string; w: number; h: number }
  | { type: 'DeleteNode'; nodeId: string }
  | {
      type: 'DuplicateNode'
      sourceNodeId: string
      newNodeId: string
      offset: CanvasPointV2
      title?: string
    }
  | { type: 'CreateEdge'; edge: CanvasEdgeV2 }
  | { type: 'CreateEdges'; edges: CanvasEdgeV2[] }
  | { type: 'UpdateEdge'; edgeId: string; patch: UpdateEdgePatchV2 }
  | { type: 'DeleteEdge'; edgeId: string }
  | { type: 'DetachNodeFromTask'; nodeId: string }
  | { type: 'AssignNodeToTask'; nodeId: string; taskId: string }
  | { type: 'CreateTaskForOutputSlot'; task: CanvasTaskV2; nodeId: string }
  | {
      type: 'CreateDerivedTaskFromSelection'
      task: CanvasTaskV2
      sources: DerivedTaskSourceV2[]
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
      collection: CanvasCollectionV2
      members: CanvasEntityRef[]
    }
  | { type: 'AssignToCollection'; collectionId: string; members: CanvasEntityRef[] }
  | { type: 'DissolveCollection'; collectionId: string }
  | { type: 'DeleteTask'; taskId: string }
  | { type: 'DeleteCollection'; collectionId: string }
  | {
      type: 'DuplicateTaskAsDraft'
      sourceTaskId: string
      newTaskId: string
      offset: CanvasPointV2
      title?: string
    }
  | {
      type: 'MaterializeProjectionPlan'
      plan: TrustedProjectionPlanInputV2
    }
  | {
      type: 'AcceptTaskProposals'
      plan: TrustedProjectionPlanInputV2
      proposalKeys: string[]
    }
  | {
      type: 'DismissPlan'
      plan: TrustedProjectionPlanInputV2
    }

export class CanvasCommandError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CanvasCommandError'
    this.code = code
  }
}

export function applyCanvasCommandV2(
  document: CanvasDocumentV2,
  command: CanvasCommandV2,
): CanvasDocumentV2 {
  assertCanvasDocumentV2(document)
  if (isIdempotentReplay(document, command)) return document

  const next = cloneCanvasDocumentV2(document)
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
    case 'ResizeNode':
      resizeNode(next, command.nodeId, command.w, command.h)
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
    case 'CreateEdges':
      createUserEdges(next, command.edges)
      break
    case 'UpdateEdge':
      updateUserEdge(next, command.edgeId, command.patch)
      break
    case 'DeleteEdge':
      deleteEdge(next, command.edgeId)
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
    case 'DissolveCollection':
      dissolveCollection(next, command.collectionId)
      break
    case 'DeleteTask':
      deleteTask(next, command.taskId)
      break
    case 'DeleteCollection':
      deleteCollection(next, command.collectionId)
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
    default:
      command satisfies never
  }

  assertCanvasDocumentV2(next)
  return next
}

export function deterministicCanvasIdV2(
  kind: 'node' | 'task' | 'collection' | 'edge',
  ...parts: string[]
): string {
  const value = parts.join('\u001f')
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
  const digest = seeds.map((seed) => fnv1a(value, seed).toString(16).padStart(8, '0')).join('')
  return `cv2_${kind}_${digest}`
}

function createTask(document: CanvasDocumentV2, task: CanvasTaskV2): void {
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

function createNode(document: CanvasDocumentV2, node: CanvasNodeV2): void {
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
  document: CanvasDocumentV2,
  nodeId: string,
  patch: UpdateNodeContentPatchV2,
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
  document: CanvasDocumentV2,
  nodeId: string,
  w: number,
  h: number,
): void {
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
    throw new CanvasCommandError('invalid-node-size', 'Node dimensions must be positive and finite')
  }
  const node = requireNode(document, nodeId)
  node.frame.w = w
  node.frame.h = h
}

function deleteNode(document: CanvasDocumentV2, nodeId: string): void {
  requireNode(document, nodeId)
  document.nodes = document.nodes.filter((node) => node.id !== nodeId)
  document.edges = document.edges.filter((edge) =>
    !(edge.from.kind === 'node' && edge.from.id === nodeId)
    && !(edge.to.kind === 'node' && edge.to.id === nodeId))
}

function duplicateNode(
  document: CanvasDocumentV2,
  command: Extract<CanvasCommandV2, { type: 'DuplicateNode' }>,
): void {
  const source = requireNode(document, command.sourceNodeId)
  requireClientOwnedId(command.newNodeId, 'node')
  ensureEntityIdAvailable(document, command.newNodeId)
  if (!Number.isFinite(command.offset.x) || !Number.isFinite(command.offset.y)) {
    throw new CanvasCommandError('invalid-offset', 'Duplicate offset must be finite')
  }

  const duplicate: CanvasNodeV2 = {
    id: command.newNodeId,
    type: source.type,
    frame: {
      ...source.frame,
      x: source.frame.x + command.offset.x,
      y: source.frame.y + command.offset.y,
      z: maxNodeZ(document) + 1,
    },
    title: command.title ?? `${source.title} copy`,
    ...(source.text === undefined ? {} : { text: source.text }),
    ...(source.payload === undefined ? {} : { payload: structuredClone(source.payload) }),
    artifactRefs: structuredClone(source.artifactRefs),
    ...(source.homeTaskId ? { homeTaskId: source.homeTaskId } : {}),
    ...(source.collectionId ? { collectionId: source.collectionId } : {}),
    origin: { kind: 'copied', sourceNodeId: source.id },
  }
  document.nodes.push(duplicate)
  document.everCreated = true
}

function createUserEdge(document: CanvasDocumentV2, edge: CanvasEdgeV2): void {
  if (!hasExactKeys(edge, ['id', 'from', 'to', 'relation', 'contextRole', 'origin'])) {
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

function createUserEdges(document: CanvasDocumentV2, edges: CanvasEdgeV2[]): void {
  if (!Array.isArray(edges) || edges.length === 0 || edges.length > 500) {
    throw new CanvasCommandError('invalid-edges', 'CreateEdges requires 1 to 500 edges')
  }
  for (const edge of edges) createUserEdge(document, edge)
}

function updateUserEdge(
  document: CanvasDocumentV2,
  edgeId: string,
  patch: UpdateEdgePatchV2,
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
    edge.relation = patch.relation as CanvasEdgeRelationV2
  }
  if (hasOwn(patch, 'contextRole')) {
    requireContextRole(patch.contextRole)
    edge.contextRole = patch.contextRole as CanvasEdgeContextRoleV2
  }
  requireEntity(document, edge.from)
  requireEntity(document, edge.to)
  requireValidEdgeSemantics(edge)
}

function deleteEdge(document: CanvasDocumentV2, edgeId: string): void {
  requireEdge(document, edgeId)
  document.edges = document.edges.filter((edge) => edge.id !== edgeId)
}

function detachNodeFromTask(document: CanvasDocumentV2, nodeId: string): void {
  const node = requireNode(document, nodeId)
  delete node.homeTaskId
}

function assignNodeToTask(document: CanvasDocumentV2, nodeId: string, taskId: string): void {
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
  document: CanvasDocumentV2,
  task: CanvasTaskV2,
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
  createTask(document, task)
  delete node.collectionId
  node.homeTaskId = task.id
}

function createDerivedTaskFromSelection(
  document: CanvasDocumentV2,
  task: CanvasTaskV2,
  sources: DerivedTaskSourceV2[],
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
  const sourceKeys = sources.map((source) => entityKeyV2(source.entity))
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
    const edge: CanvasEdgeV2 = {
      id: deterministicCanvasIdV2(
        'edge',
        'derived-task-source',
        task.id,
        entityKeyV2(source.entity),
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
  document: CanvasDocumentV2,
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
    node.frame.x += dx
    node.frame.y += dy
  }
}

function createCollection(
  document: CanvasDocumentV2,
  collection: CanvasCollectionV2,
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
  document: CanvasDocumentV2,
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

function dissolveCollection(document: CanvasDocumentV2, collectionId: string): void {
  requireCollection(document, collectionId)
  document.collections = document.collections.filter((entry) => entry.id !== collectionId)
  for (const task of document.tasks) {
    if (task.collectionId === collectionId) delete task.collectionId
  }
  for (const node of document.nodes) {
    if (node.collectionId === collectionId) delete node.collectionId
  }
}

function deleteTask(document: CanvasDocumentV2, taskId: string): void {
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

function deleteCollection(document: CanvasDocumentV2, collectionId: string): void {
  requireCollection(document, collectionId)
  const directTaskIds = new Set(document.tasks
    .filter((task) => task.collectionId === collectionId)
    .map((task) => task.id))
  const taskIds = directTaskIds
  const nodeIds = new Set(document.nodes
    .filter((node) => node.collectionId === collectionId)
    .map((node) => node.id))
  for (const taskId of taskIds) {
    for (const node of document.nodes) {
      if (node.homeTaskId !== taskId) continue
      delete node.homeTaskId
    }
  }
  removeEntities(document, taskIds, nodeIds)
  document.collections = document.collections.filter((entry) => entry.id !== collectionId)
}

function duplicateTaskAsDraft(
  document: CanvasDocumentV2,
  command: Extract<CanvasCommandV2, { type: 'DuplicateTaskAsDraft' }>,
): void {
  const source = requireTask(document, command.sourceTaskId)
  requireClientOwnedId(command.newTaskId, 'task')
  ensureEntityIdAvailable(document, command.newTaskId)
  if (!Number.isFinite(command.offset.x) || !Number.isFinite(command.offset.y)) {
    throw new CanvasCommandError('invalid-offset', 'Duplicate offset must be finite')
  }

  const duplicate: CanvasTaskV2 = {
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
  const copiedEdges: CanvasEdgeV2[] = []
  for (const edge of document.edges) {
    if (edge.to.kind !== 'task' || edge.to.id !== source.id) continue
    const edgeId = deterministicCanvasIdV2('edge', 'draft', command.newTaskId, edge.id)
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
  document: CanvasDocumentV2,
  command: Extract<CanvasCommandV2, { type: 'MaterializeProjectionPlan' }>,
): void {
  const { plan } = command
  const task = requireTask(document, plan.taskId)
  const outputKeys = plan.outputs.map((output) => output.key)
  if (new Set(outputKeys).size !== outputKeys.length) {
    throw new CanvasCommandError('invalid-plan', 'Projection plan output keys must be unique')
  }
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
      && node.type === output.pluginId
      && isEmptyUserOutputSlot(node))
    if (candidates.length === 1) {
      const candidate = candidates[0]!
      adoptedOutputKeys.add(output.key)
      adoptedNodeIds.add(candidate.id)
      nodeIdByOutput.set(output.key, candidate.id)
      continue
    }
    const nodeId = deterministicCanvasIdV2('node', plan.planId, output.key)
    ensureEntityIdAvailable(document, nodeId)
    nodeIdByOutput.set(output.key, nodeId)
  }

  const maxZ = maxNodeZ(document)
  const newNodes: CanvasNodeV2[] = []
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
      type: output.pluginId,
      frame: projectionFrame(task.anchor, index, maxZ),
      title: output.title,
      artifactRefs: structuredClone(output.artifactRefs),
      homeTaskId: task.id,
      origin,
    })
  }

  const newEdges: CanvasEdgeV2[] = []
  for (const output of materializedOutputs) {
    const outputNodeId = requireMappedId(nodeIdByOutput, output.key)
    newEdges.push(agentEdge(
      deterministicCanvasIdV2('edge', plan.planId, 'produced', output.key),
      { kind: 'task', id: task.id },
      { kind: 'node', id: outputNodeId },
      'produced',
      output.role === 'primary' ? 'full' : output.role === 'supporting' ? 'summary' : 'none',
      plan.runId,
      plan.planId,
    ))
    for (const parentKey of output.derivedFrom) {
      const parentNodeId = nodeIdByOutput.get(parentKey)
      if (!parentNodeId) continue
      newEdges.push(agentEdge(
        deterministicCanvasIdV2('edge', plan.planId, 'derived', parentKey, output.key),
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

function acceptTaskProposals(
  document: CanvasDocumentV2,
  command: Extract<CanvasCommandV2, { type: 'AcceptTaskProposals' }>,
): void {
  const { plan } = command
  const parent = requireTask(document, plan.taskId)
  if (command.proposalKeys.length === 0 || command.proposalKeys.length > 12) {
    throw new CanvasCommandError('invalid-proposals', 'AcceptTaskProposals requires 1 to 12 proposals')
  }
  requireUniqueKeys(command.proposalKeys, 'proposal keys')
  const proposalsByKey = new Map(plan.taskProposals.map((proposal) => [proposal.key, proposal]))
  const proposals = command.proposalKeys.map((proposalKey) => {
    const proposal = proposalsByKey.get(proposalKey)
    if (!proposal) {
      throw new CanvasCommandError(
        'proposal-not-found',
        `Proposal ${proposalKey} is not present in plan ${plan.planId}`,
      )
    }
    return proposal
  })
  const materialization = findReceipt(document, 'materialization', plan.planId)
  if (materialization?.dismissedProposalKeys.some((key) => command.proposalKeys.includes(key))) {
    throw new CanvasCommandError('proposal-dismissed', 'A dismissed proposal cannot be accepted')
  }

  const newTasks = proposals.map((proposal, index): CanvasTaskV2 => {
    const taskId = deterministicCanvasIdV2('task', plan.planId, proposal.key)
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
  const outcomeNodeIdByKey = new Map(
    materialization?.outcomes.map((outcome) => [outcome.outputKey, outcome.nodeId]) ?? [],
  )
  const newEdges: CanvasEdgeV2[] = []
  for (const proposal of proposals) {
    const proposalTaskId = requireMappedId(taskIdByProposal, proposal.key)
    for (const outputKey of proposal.inputOutputKeys) {
      const nodeId = outcomeNodeIdByKey.get(outputKey)
      if (!nodeId || !document.nodes.some((node) => node.id === nodeId)) continue
      newEdges.push(agentEdge(
        deterministicCanvasIdV2('edge', plan.planId, 'proposal-source', outputKey, proposal.key),
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
        deterministicCanvasIdV2(
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
  document.everCreated = true
}

function dismissPlan(
  document: CanvasDocumentV2,
  command: Extract<CanvasCommandV2, { type: 'DismissPlan' }>,
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

function isIdempotentReplay(document: CanvasDocumentV2, command: CanvasCommandV2): boolean {
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
  document: CanvasDocumentV2,
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

function findReceipt<K extends CanvasReceiptV2['kind']>(
  document: CanvasDocumentV2,
  kind: K,
  planId: string,
): Extract<CanvasReceiptV2, { kind: K }> | undefined {
  return document.receipts.find((receipt): receipt is Extract<CanvasReceiptV2, { kind: K }> =>
    receipt.kind === kind && receipt.planId === planId)
}

function setCollectionMembership(
  document: CanvasDocumentV2,
  collectionId: string,
  refs: CanvasEntityRef[],
): void {
  for (const ref of refs) {
    if (ref.kind === 'node') requireNode(document, ref.id).collectionId = collectionId
    else requireTask(document, ref.id).collectionId = collectionId
  }
}

function ensureTopLevelUncollected(document: CanvasDocumentV2, ref: CanvasEntityRef): void {
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
  document: CanvasDocumentV2,
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
  const keys = refs.map(entityKeyV2)
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

function requireNode(document: CanvasDocumentV2, nodeId: string): CanvasNodeV2 {
  const node = document.nodes.find((entry) => entry.id === nodeId)
  if (!node) throw new CanvasCommandError('node-not-found', `Node ${nodeId} does not exist`)
  return node
}

function requireEntity(document: CanvasDocumentV2, ref: CanvasEntityRef): void {
  if (!isEntityRef(ref)) {
    throw new CanvasCommandError('invalid-edge-endpoint', 'Edge endpoint is invalid')
  }
  if (ref.kind === 'node') requireNode(document, ref.id)
  else requireTask(document, ref.id)
}

function requireEdge(document: CanvasDocumentV2, edgeId: string): CanvasEdgeV2 {
  const edge = document.edges.find((entry) => entry.id === edgeId)
  if (!edge) throw new CanvasCommandError('edge-not-found', `Edge ${edgeId} does not exist`)
  return edge
}

function requireTask(document: CanvasDocumentV2, taskId: string): CanvasTaskV2 {
  const task = document.tasks.find((entry) => entry.id === taskId)
  if (!task) throw new CanvasCommandError('task-not-found', `Task ${taskId} does not exist`)
  return task
}

function requireCollection(
  document: CanvasDocumentV2,
  collectionId: string,
): CanvasCollectionV2 {
  const collection = document.collections.find((entry) => entry.id === collectionId)
  if (!collection) {
    throw new CanvasCommandError(
      'collection-not-found',
      `Collection ${collectionId} does not exist`,
    )
  }
  return collection
}

function ensureEntityIdAvailable(document: CanvasDocumentV2, id: string): void {
  if (document.nodes.some((node) => node.id === id)
    || document.tasks.some((task) => task.id === id)
    || document.collections.some((collection) => collection.id === id)) {
    throw new CanvasCommandError('entity-id-conflict', `Entity id ${id} is already in use`)
  }
}

function ensureEdgeIdAvailable(document: CanvasDocumentV2, id: string): void {
  if (document.edges.some((edge) => edge.id === id)) {
    throw new CanvasCommandError('edge-id-conflict', `Edge id ${id} is already in use`)
  }
}

function requireClientOwnedId(id: string, kind: string): void {
  if (isReservedCanvasIdV2(id)) {
    throw new CanvasCommandError(
      'reserved-id',
      `Browser commands cannot assign trusted ${kind} id ${id}`,
    )
  }
}

function requireValidEdgeSemantics(edge: CanvasEdgeV2): void {
  if (!isEntityRef(edge.from) || !isEntityRef(edge.to)) {
    throw new CanvasCommandError('invalid-edge-endpoint', 'Edge endpoints must be typed entities')
  }
  requireEdgeRelation(edge.relation)
  requireContextRole(edge.contextRole)
  const issue = canvasEdgeTopologyIssueV2(edge)
  if (issue) throw new CanvasCommandError('invalid-edge-topology', issue)
}

function requireEdgeRelation(value: unknown): asserts value is CanvasEdgeRelationV2 {
  if (value !== 'source'
    && value !== 'produced'
    && value !== 'derived'
    && value !== 'modified'
    && value !== 'references'
    && value !== 'compares'
    && value !== 'replaces'
    && value !== 'depends-on') {
    throw new CanvasCommandError('invalid-edge-relation', 'Edge relation is invalid')
  }
}

function requireContextRole(value: unknown): asserts value is CanvasEdgeContextRoleV2 {
  if (value !== 'full' && value !== 'summary' && value !== 'none') {
    throw new CanvasCommandError('invalid-context-role', 'Edge contextRole is invalid')
  }
}

function isEntityRef(value: unknown): value is CanvasEntityRef {
  return isPlainRecord(value)
    && hasExactKeys(value, ['kind', 'id'])
    && (value.kind === 'node' || value.kind === 'task')
    && typeof value.id === 'string'
}

function isExactUserOrigin(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['kind'])
    && value.kind === 'user'
}

function isEmptyUserOutputSlot(node: CanvasNodeV2): boolean {
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

function maxNodeZ(document: CanvasDocumentV2): number {
  return document.nodes.reduce((maximum, node) => Math.max(maximum, node.frame.z), 0)
}

function projectionFrame(anchor: CanvasPointV2, index: number, maxZ: number) {
  const frame = taskOutputFrameV2(anchor, index)
  return {
    ...frame,
    z: maxZ + index + 1,
  }
}

function agentEdge(
  id: string,
  from: CanvasEntityRef,
  to: CanvasEntityRef,
  relation: 'produced' | 'derived' | 'source' | 'depends-on',
  contextRole: 'full' | 'summary' | 'none',
  runId: string,
  planId: string,
): CanvasEdgeV2 {
  return {
    id,
    from,
    to,
    relation,
    contextRole,
    origin: { kind: 'agent', runId, planId },
  }
}

function outputRoleRank(role: TrustedProjectionOutputRoleV2): number {
  if (role === 'primary') return 0
  if (role === 'supporting') return 1
  return 2
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
