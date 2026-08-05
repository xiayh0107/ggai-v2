import {
  assertCanvasDocumentV2,
  cloneCanvasDocumentV2,
  entityKeyV2,
  type CanvasCollectionV2,
  type CanvasDocumentV2,
  type CanvasEdgeV2,
  type CanvasEntityRef,
  type CanvasNodeV2,
  type CanvasPointV2,
  type CanvasReceiptV2,
  type CanvasTaskV2,
} from './model.js'

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

export type CanvasCommandV2 =
  | { type: 'CreateTask'; task: CanvasTaskV2 }
  | { type: 'UpdateTaskGoal'; taskId: string; goal: string }
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

  const nodeIdByOutput = new Map(materializedOutputs.map((output) => [
    output.key,
    deterministicCanvasIdV2('node', plan.planId, output.key),
  ]))
  for (const nodeId of nodeIdByOutput.values()) ensureEntityIdAvailable(document, nodeId)

  const maxZ = maxNodeZ(document)
  const newNodes: CanvasNodeV2[] = materializedOutputs.map((output, index) => ({
    id: requireMappedId(nodeIdByOutput, output.key),
    type: output.pluginId,
    frame: projectionFrame(task.anchor, index, maxZ),
    title: output.title,
    artifactRefs: structuredClone(output.artifactRefs),
    homeTaskId: task.id,
    origin: {
      kind: 'agent-output',
      taskId: task.id,
      runId: plan.runId,
      planId: plan.planId,
      outputKey: output.key,
    },
  }))

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

function requireMappedId(map: Map<string, string>, key: string): string {
  const value = map.get(key)
  if (!value) throw new CanvasCommandError('mapping-missing', `No deterministic id for ${key}`)
  return value
}

function maxNodeZ(document: CanvasDocumentV2): number {
  return document.nodes.reduce((maximum, node) => Math.max(maximum, node.frame.z), 0)
}

function projectionFrame(anchor: CanvasPointV2, index: number, maxZ: number) {
  const column = index % 2
  const row = Math.floor(index / 2)
  return {
    x: anchor.x + 48 + column * 456,
    y: anchor.y + 96 + row * 304,
    w: 400,
    h: 256,
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
