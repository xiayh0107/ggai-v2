import {
  MAX_ACCEPTED_TASK_PROPOSALS,
  MAX_CANVAS_EDGE_BATCH,
  MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES,
  MAX_TASK_PROPOSAL_EDIT_PROMPT_LENGTH,
  MAX_TASK_PROPOSAL_EDIT_TITLE_LENGTH,
  MAX_TASK_PROPOSAL_KEY_LENGTH,
  type CanvasCommand,
  type DerivedTaskSource,
  type TaskProposalEdit,
  type UpdateEdgePatch,
  type UpdateNodeContentPatch,
} from '../src/canvas/commands.js'
import {
  collectCanvasValidationIssues,
  emptyCanvasDocument,
  entityKey,
  isReservedCanvasId,
  parseEntityKey,
  type CanvasCollection,
  type CanvasEdgeContextRole,
  type CanvasEdgeRelation,
  type CanvasEdge,
  type CanvasEntityRef,
  type CanvasNode,
  type CanvasTask,
} from '../src/canvas/model.js'
import { canonicalNodeSkillBindings } from '../src/skills/contracts.js'
import { parseCanvasBranch, ProtocolError } from './protocol.js'

export const MAX_CANVAS_COMMAND_ENTITIES = 500
export {
  MAX_ACCEPTED_TASK_PROPOSALS,
  MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES,
}
export const MAX_PROPOSAL_KEY_LENGTH = MAX_TASK_PROPOSAL_KEY_LENGTH
export const MAX_PROPOSAL_EDIT_TITLE_LENGTH = MAX_TASK_PROPOSAL_EDIT_TITLE_LENGTH
export const MAX_PROPOSAL_EDIT_PROMPT_LENGTH = MAX_TASK_PROPOSAL_EDIT_PROMPT_LENGTH

type TrustedPlanCommand = Extract<CanvasCommand, {
  type: 'MaterializeProjectionPlan' | 'AcceptTaskProposals' | 'DismissPlan'
}>

export type OrdinaryCanvasCommand = Exclude<CanvasCommand, TrustedPlanCommand>

export type TaskProposalEditWire = TaskProposalEdit

/**
 * Browser-writable command wire shape.
 *
 * Plan operations contain only an opaque plan id. The daemon resolves and
 * validates the trusted plan before constructing an internal CanvasCommand.
 */
export type CanvasCommandWire =
  | OrdinaryCanvasCommand
  | { type: 'MaterializeProjectionPlan'; planId: string }
  | {
      type: 'AcceptTaskProposals'
      planId: string
      proposalKeys: string[]
      edits?: Record<string, TaskProposalEditWire>
    }
  | { type: 'DismissPlan'; planId: string }

export interface CanvasCommandRequestWire {
  branch: string
  baseRevision: number
  mutationId: string
  command: CanvasCommandWire
}

export interface CanvasConflictMutationWire {
  mutationId: string
  command: CanvasCommandWire
}

export interface CanvasConflictRecoveryRequest {
  sourceBranch: string
  newBranch: string
  baseRevision: number
  mutations: CanvasConflictMutationWire[]
}

/** Strict parser for the JSON body of POST /canvas/commands. */
export function parseCanvasCommandRequest(value: unknown): CanvasCommandRequestWire {
  if (!isExactRecord(value, ['branch', 'baseRevision', 'mutationId', 'command'])) {
    throw new ProtocolError('canvas command request has an invalid envelope')
  }
  const branch = parseCanvasBranch(value.branch)
  if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) {
    throw new ProtocolError('baseRevision must be a non-negative safe integer')
  }
  const mutationId = parseIdentifier(value.mutationId, 'mutationId')
  return {
    branch,
    baseRevision: value.baseRevision as number,
    mutationId,
    command: parseCanvasCommandWire(value.command),
  }
}

export function parseCanvasConflictRecoveryRequest(
  value: unknown,
): CanvasConflictRecoveryRequest {
  if (!isExactRecord(value, [
    'sourceBranch',
    'newBranch',
    'baseRevision',
    'mutations',
  ])) {
    throw new ProtocolError('canvas conflict recovery request has an invalid envelope')
  }
  const sourceBranch = parseCanvasBranch(value.sourceBranch)
  const newBranch = parseCanvasBranch(value.newBranch)
  if (sourceBranch === newBranch) {
    throw new ProtocolError('conflict recovery branch must differ from its source branch')
  }
  if (!Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 0) {
    throw new ProtocolError('baseRevision must be a non-negative safe integer')
  }
  if (!Array.isArray(value.mutations)
    || value.mutations.length === 0
    || value.mutations.length > MAX_CANVAS_COMMAND_ENTITIES) {
    throw new ProtocolError('mutations must contain 1 to 500 commands')
  }
  const seen = new Set<string>()
  const mutations = value.mutations.map((candidate, index): CanvasConflictMutationWire => {
    if (!isExactRecord(candidate, ['mutationId', 'command'])) {
      throw new ProtocolError(`mutations[${index}] has an invalid shape`)
    }
    const mutationId = parseIdentifier(candidate.mutationId, `mutations[${index}].mutationId`)
    if (seen.has(mutationId)) throw new ProtocolError('mutations contains duplicate mutation ids')
    seen.add(mutationId)
    return {
      mutationId,
      command: parseCanvasCommandWire(candidate.command),
    }
  })
  return {
    sourceBranch,
    newBranch,
    baseRevision: Number(value.baseRevision),
    mutations,
  }
}

export function parseCanvasCommandWire(value: unknown): CanvasCommandWire {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new ProtocolError('command must be an object with a type')
  }
  switch (value.type) {
    case 'MaterializeProjectionPlan':
      assertCommandKeys(value, ['type', 'planId'], ['type', 'planId'])
      return { type: value.type, planId: parsePlanId(value.planId) }
    case 'AcceptTaskProposals':
      return parseAcceptTaskProposals(value)
    case 'DismissPlan':
      assertCommandKeys(value, ['type', 'planId'], ['type', 'planId'])
      return { type: value.type, planId: parsePlanId(value.planId) }
    case 'CreateTask':
      assertCommandKeys(value, ['type', 'task'], ['type', 'task'])
      return { type: value.type, task: parseUserTask(value.task) }
    case 'UpdateTaskGoal':
      assertCommandKeys(value, ['type', 'taskId', 'goal'], ['type', 'taskId', 'goal'])
      return {
        type: value.type,
        taskId: parseIdentifier(value.taskId, 'command.taskId'),
        goal: parseString(value.goal, 'command.goal', 250_000, true),
      }
    case 'CreateNode':
      assertCommandKeys(value, ['type', 'node'], ['type', 'node'])
      return { type: value.type, node: parseUserNode(value.node) }
    case 'UpdateNodeContent':
      return parseUpdateNodeContent(value)
    case 'UpdateNodeSkillBindings':
      return parseUpdateNodeSkillBindings(value)
    case 'ResizeNode':
      assertCommandKeys(value, ['type', 'nodeId', 'w', 'h'], ['type', 'nodeId', 'w', 'h'])
      return {
        type: value.type,
        nodeId: parseIdentifier(value.nodeId, 'command.nodeId'),
        w: parsePositiveFinite(value.w, 'command.w'),
        h: parsePositiveFinite(value.h, 'command.h'),
      }
    case 'DeleteNode':
      assertCommandKeys(value, ['type', 'nodeId'], ['type', 'nodeId'])
      return {
        type: value.type,
        nodeId: parseIdentifier(value.nodeId, 'command.nodeId'),
      }
    case 'DuplicateNode':
      return parseDuplicateNode(value)
    case 'CreateEdge':
      assertCommandKeys(value, ['type', 'edge'], ['type', 'edge'])
      return { type: value.type, edge: parseUserEdge(value.edge, 'command.edge') }
    case 'CreateEdges':
      assertCommandKeys(value, ['type', 'edges'], ['type', 'edges'])
      return { type: value.type, edges: parseUserEdges(value.edges) }
    case 'UpdateEdge':
      return parseUpdateEdge(value)
    case 'DeleteEdge':
      assertCommandKeys(value, ['type', 'edgeId'], ['type', 'edgeId'])
      return {
        type: value.type,
        edgeId: parseIdentifier(value.edgeId, 'command.edgeId'),
      }
    case 'DeleteEdges':
      assertCommandKeys(value, ['type', 'edgeIds'], ['type', 'edgeIds'])
      return {
        type: value.type,
        edgeIds: parseIdentifierArray(value.edgeIds, 'command.edgeIds', true),
      }
    case 'DetachNodeFromTask':
      assertCommandKeys(value, ['type', 'nodeId'], ['type', 'nodeId'])
      return {
        type: value.type,
        nodeId: parseIdentifier(value.nodeId, 'command.nodeId'),
      }
    case 'AssignNodeToTask':
      assertCommandKeys(value, ['type', 'nodeId', 'taskId'], ['type', 'nodeId', 'taskId'])
      return {
        type: value.type,
        nodeId: parseIdentifier(value.nodeId, 'command.nodeId'),
        taskId: parseIdentifier(value.taskId, 'command.taskId'),
      }
    case 'CreateTaskForOutputSlot':
      assertCommandKeys(value, ['type', 'task', 'nodeId'], ['type', 'task', 'nodeId'])
      return {
        type: value.type,
        task: parseUserTask(value.task),
        nodeId: parseIdentifier(value.nodeId, 'command.nodeId'),
      }
    case 'CreateDerivedTaskFromSelection':
      return parseCreateDerivedTask(value)
    case 'MoveEntities':
      return parseMoveEntities(value)
    case 'CreateCollectionFromSelection':
      assertCommandKeys(
        value,
        ['type', 'collection', 'members'],
        ['type', 'collection', 'members'],
      )
      return {
        type: value.type,
        collection: parseCollection(value.collection),
        members: parseEntityRefs(value.members, 'command.members', true),
      }
    case 'AssignToCollection':
      assertCommandKeys(
        value,
        ['type', 'collectionId', 'members'],
        ['type', 'collectionId', 'members'],
      )
      return {
        type: value.type,
        collectionId: parseIdentifier(value.collectionId, 'command.collectionId'),
        members: parseEntityRefs(value.members, 'command.members', true),
      }
    case 'RemoveFromCollection':
      assertCommandKeys(
        value,
        ['type', 'collectionId', 'members'],
        ['type', 'collectionId', 'members'],
      )
      return {
        type: value.type,
        collectionId: parseIdentifier(value.collectionId, 'command.collectionId'),
        members: parseEntityRefs(value.members, 'command.members', true),
      }
    case 'DissolveCollection':
      assertCommandKeys(value, ['type', 'collectionId'], ['type', 'collectionId'])
      return {
        type: value.type,
        collectionId: parseIdentifier(value.collectionId, 'command.collectionId'),
      }
    case 'DeleteTask':
    case 'DeleteTaskAndViews':
      assertCommandKeys(value, ['type', 'taskId'], ['type', 'taskId'])
      return {
        type: value.type,
        taskId: parseIdentifier(value.taskId, 'command.taskId'),
      }
    case 'DeleteCollection':
    case 'DeleteCollectionAndContents':
      assertCommandKeys(value, ['type', 'collectionId'], ['type', 'collectionId'])
      return {
        type: value.type,
        collectionId: parseIdentifier(value.collectionId, 'command.collectionId'),
      }
    case 'DuplicateCollection':
      return parseDuplicateCollection(value)
    case 'DuplicateTaskAsDraft':
      return parseDuplicateTask(value)
    default:
      throw new ProtocolError(`unsupported canvas command type: ${value.type}`)
  }
}

function parseAcceptTaskProposals(
  value: Record<string, unknown>,
): Extract<CanvasCommandWire, { type: 'AcceptTaskProposals' }> {
  assertCommandKeys(
    value,
    ['type', 'planId', 'proposalKeys', 'edits'],
    ['type', 'planId', 'proposalKeys'],
  )
  const planId = parsePlanId(value.planId)
  const proposalKeys = parseProposalKeys(value.proposalKeys)
  const edits = value.edits === undefined
    ? undefined
    : parseProposalEdits(value.edits, new Set(proposalKeys))
  return {
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys,
    ...(edits ? { edits } : {}),
  }
}

function parseMoveEntities(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommand, { type: 'MoveEntities' }> {
  assertCommandKeys(
    value,
    ['type', 'entities', 'collectionIds', 'dx', 'dy'],
    ['type', 'entities', 'dx', 'dy'],
  )
  const collectionIds = value.collectionIds === undefined
    ? undefined
    : parseIdentifierArray(value.collectionIds, 'command.collectionIds', false)
  return {
    type: 'MoveEntities',
    entities: parseEntityRefs(value.entities, 'command.entities', false),
    ...(collectionIds ? { collectionIds } : {}),
    dx: parseFinite(value.dx, 'command.dx'),
    dy: parseFinite(value.dy, 'command.dy'),
  }
}

function parseUpdateNodeContent(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommand, { type: 'UpdateNodeContent' }> {
  assertCommandKeys(value, ['type', 'nodeId', 'patch'], ['type', 'nodeId', 'patch'])
  if (!isRecord(value.patch)) throw new ProtocolError('command.patch must be an object')
  assertCommandKeys(value.patch, ['title', 'text', 'payload'], [])
  if (Object.keys(value.patch).length === 0) {
    throw new ProtocolError('UpdateNodeContent requires at least one content field')
  }
  const patch: UpdateNodeContentPatch = {}
  if (hasOwn(value.patch, 'title')) {
    patch.title = parseString(value.patch.title, 'command.patch.title', 1_000, false)
  }
  if (hasOwn(value.patch, 'text')) {
    patch.text = value.patch.text === null
      ? null
      : parseString(value.patch.text, 'command.patch.text', 1_000_000, true)
  }
  if (hasOwn(value.patch, 'payload')) {
    patch.payload = value.patch.payload === null
      ? null
      : parseJsonPayload(value.patch.payload, 'command.patch.payload')
  }
  return {
    type: 'UpdateNodeContent',
    nodeId: parseIdentifier(value.nodeId, 'command.nodeId'),
    patch,
  }
}

function parseUpdateNodeSkillBindings(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommand, { type: 'UpdateNodeSkillBindings' }> {
  assertCommandKeys(value, ['type', 'nodeId', 'bindings'], ['type', 'nodeId', 'bindings'])
  let bindings
  try {
    bindings = canonicalNodeSkillBindings(value.bindings, 'command.bindings')
  } catch (error) {
    throw new ProtocolError(error instanceof Error ? error.message : 'command.bindings is invalid')
  }
  return {
    type: 'UpdateNodeSkillBindings',
    nodeId: parseIdentifier(value.nodeId, 'command.nodeId'),
    bindings,
  }
}

function parseDuplicateNode(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommand, { type: 'DuplicateNode' }> {
  assertCommandKeys(
    value,
    ['type', 'sourceNodeId', 'newNodeId', 'offset', 'title'],
    ['type', 'sourceNodeId', 'newNodeId', 'offset'],
  )
  const offset = parsePoint(value.offset, 'command.offset')
  const title = value.title === undefined
    ? undefined
    : parseString(value.title, 'command.title', 1_000, false)
  return {
    type: 'DuplicateNode',
    sourceNodeId: parseIdentifier(value.sourceNodeId, 'command.sourceNodeId'),
    newNodeId: parseClientIdentifier(value.newNodeId, 'command.newNodeId'),
    offset,
    ...(title === undefined ? {} : { title }),
  }
}

function parseUserEdges(value: unknown): CanvasEdge[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CANVAS_EDGE_BATCH) {
    throw new ProtocolError(`command.edges must contain 1 to ${MAX_CANVAS_EDGE_BATCH} edges`)
  }
  const edges = value.map((candidate, index) =>
    parseUserEdge(candidate, `command.edges[${index}]`, false))
  const ids = edges.map((edge) => edge.id)
  if (new Set(ids).size !== ids.length) {
    throw new ProtocolError('command.edges contains duplicate edge ids')
  }
  assertEdgeFragments(edges, 'command.edges')
  return edges
}

function parseUserEdge(
  value: unknown,
  label: string,
  validateFragment = true,
): CanvasEdge {
  if (!isExactRecord(value, ['id', 'from', 'to', 'relation', 'contextRole', 'origin'])
    || !isExactRecord(value.origin, ['kind'])
    || value.origin.kind !== 'user') {
    throw new ProtocolError(`${label} must be a user-origin edge`)
  }
  const edge: CanvasEdge = {
    id: parseClientIdentifier(value.id, `${label}.id`),
    from: parseEntityRef(value.from, `${label}.from`),
    to: parseEntityRef(value.to, `${label}.to`),
    relation: parseEdgeRelation(value.relation, `${label}.relation`),
    contextRole: parseContextRole(value.contextRole, `${label}.contextRole`),
    origin: { kind: 'user' },
  }
  if (validateFragment) assertEdgeFragments([edge], label)
  return edge
}

function parseUpdateEdge(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommand, { type: 'UpdateEdge' }> {
  assertCommandKeys(value, ['type', 'edgeId', 'patch'], ['type', 'edgeId', 'patch'])
  if (!isRecord(value.patch)) throw new ProtocolError('command.patch must be an object')
  assertCommandKeys(value.patch, ['from', 'to', 'relation', 'contextRole'], [])
  if (Object.keys(value.patch).length === 0) {
    throw new ProtocolError('UpdateEdge requires at least one semantic field')
  }
  const patch: UpdateEdgePatch = {}
  if (hasOwn(value.patch, 'from')) {
    patch.from = parseEntityRef(value.patch.from, 'command.patch.from')
  }
  if (hasOwn(value.patch, 'to')) {
    patch.to = parseEntityRef(value.patch.to, 'command.patch.to')
  }
  if (hasOwn(value.patch, 'relation')) {
    patch.relation = parseEdgeRelation(value.patch.relation, 'command.patch.relation')
  }
  if (hasOwn(value.patch, 'contextRole')) {
    patch.contextRole = parseContextRole(value.patch.contextRole, 'command.patch.contextRole')
  }
  return {
    type: 'UpdateEdge',
    edgeId: parseIdentifier(value.edgeId, 'command.edgeId'),
    patch,
  }
}

function parseCreateDerivedTask(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommand, { type: 'CreateDerivedTaskFromSelection' }> {
  assertCommandKeys(value, ['type', 'task', 'sources'], ['type', 'task', 'sources'])
  if (!Array.isArray(value.sources)
    || value.sources.length === 0
    || value.sources.length > MAX_CANVAS_COMMAND_ENTITIES) {
    throw new ProtocolError('command.sources must contain 1 to 500 selected entities')
  }
  const seen = new Set<string>()
  const sources: DerivedTaskSource[] = value.sources.map((candidate, index) => {
    const label = `command.sources[${index}]`
    if (!isExactRecord(candidate, ['entity', 'relation', 'contextRole'])) {
      throw new ProtocolError(`${label} has an invalid shape`)
    }
    const entity = parseEntityRef(candidate.entity, `${label}.entity`)
    const relation = candidate.relation
    if (relation !== 'source' && relation !== 'modified') {
      throw new ProtocolError(`${label}.relation must be source or modified`)
    }
    if (relation === 'modified' && entity.kind !== 'node') {
      throw new ProtocolError(`${label}.relation modified requires a node source`)
    }
    const key = entityKey(entity)
    if (seen.has(key)) throw new ProtocolError('command.sources contains a duplicate entity')
    seen.add(key)
    return {
      entity,
      relation,
      contextRole: parseContextRole(candidate.contextRole, `${label}.contextRole`),
    }
  })
  return {
    type: 'CreateDerivedTaskFromSelection',
    task: parseUserTask(value.task),
    sources,
  }
}

function parseDuplicateTask(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommand, { type: 'DuplicateTaskAsDraft' }> {
  assertCommandKeys(
    value,
    ['type', 'sourceTaskId', 'newTaskId', 'offset', 'title'],
    ['type', 'sourceTaskId', 'newTaskId', 'offset'],
  )
  if (!isExactRecord(value.offset, ['x', 'y'])) {
    throw new ProtocolError('command.offset has an invalid shape')
  }
  const title = value.title === undefined
    ? undefined
    : parseString(value.title, 'command.title', 1_000, false)
  return {
    type: 'DuplicateTaskAsDraft',
    sourceTaskId: parseIdentifier(value.sourceTaskId, 'command.sourceTaskId'),
    newTaskId: parseClientIdentifier(value.newTaskId, 'command.newTaskId'),
    offset: {
      x: parseFinite(value.offset.x, 'command.offset.x'),
      y: parseFinite(value.offset.y, 'command.offset.y'),
    },
    ...(title ? { title } : {}),
  }
}

function parseDuplicateCollection(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommand, { type: 'DuplicateCollection' }> {
  assertCommandKeys(
    value,
    ['type', 'sourceCollectionId', 'newCollectionId', 'offset', 'title'],
    ['type', 'sourceCollectionId', 'newCollectionId', 'offset'],
  )
  const title = value.title === undefined
    ? undefined
    : parseString(value.title, 'command.title', 1_000, false)
  return {
    type: 'DuplicateCollection',
    sourceCollectionId: parseIdentifier(
      value.sourceCollectionId,
      'command.sourceCollectionId',
    ),
    newCollectionId: parseClientIdentifier(
      value.newCollectionId,
      'command.newCollectionId',
    ),
    offset: parsePoint(value.offset, 'command.offset'),
    ...(title === undefined ? {} : { title }),
  }
}

function parseUserTask(value: unknown): CanvasTask {
  if (!isRecord(value)
    || !isExactRecord(value.origin, ['kind'])
    || value.origin.kind !== 'user') {
    throw new ProtocolError('CreateTask only accepts a user-origin task')
  }
  parseClientIdentifier(value.id, 'command.task.id')
  const document = emptyCanvasDocument()
  document.tasks = [structuredClone(value) as unknown as CanvasTask]
  if (typeof value.collectionId === 'string') {
    document.collections = [{
      id: value.collectionId,
      title: 'Validation placeholder',
      anchor: { x: 0, y: 0 },
    }]
  }
  assertModelFragment(document, 'command.task')
  return structuredClone(value) as unknown as CanvasTask
}

function parseUserNode(value: unknown): CanvasNode {
  if (!isRecord(value)
    || !isExactRecord(value.origin, ['kind'])
    || value.origin.kind !== 'user') {
    throw new ProtocolError('CreateNode only accepts a user-origin node')
  }
  parseClientIdentifier(value.id, 'command.node.id')
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.length !== 0) {
    throw new ProtocolError('CreateNode cannot attach daemon-owned artifactRefs')
  }
  const document = emptyCanvasDocument()
  document.nodes = [structuredClone(value) as unknown as CanvasNode]
  if (typeof value.homeTaskId === 'string') {
    document.tasks = [placeholderTask(value.homeTaskId)]
  }
  if (typeof value.collectionId === 'string') {
    document.collections = [placeholderCollection(value.collectionId)]
  }
  assertModelFragment(document, 'command.node')
  return structuredClone(value) as unknown as CanvasNode
}

function parseCollection(value: unknown): CanvasCollection {
  if (!isRecord(value)) throw new ProtocolError('command.collection must be an object')
  parseClientIdentifier(value.id, 'command.collection.id')
  const document = emptyCanvasDocument()
  document.collections = [structuredClone(value) as unknown as CanvasCollection]
  assertModelFragment(document, 'command.collection')
  return structuredClone(value) as unknown as CanvasCollection
}

function parseJsonPayload(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError(`${label} must be a JSON object`)
  const document = emptyCanvasDocument()
  document.nodes = [{
    id: 'validation-node',
    type: 'validation',
    frame: { x: 0, y: 0, w: 1, h: 1, z: 0 },
    title: 'Validation',
    payload: structuredClone(value),
    artifactRefs: [],
    origin: { kind: 'user' },
  }]
  assertModelFragment(document, label)
  return structuredClone(value)
}

function assertEdgeFragments(edges: CanvasEdge[], label: string): void {
  const document = emptyCanvasDocument()
  const entities = new Map<string, CanvasEntityRef>()
  for (const edge of edges) {
    entities.set(entityKey(edge.from), edge.from)
    entities.set(entityKey(edge.to), edge.to)
  }
  for (const entity of entities.values()) {
    if (entity.kind === 'node') document.nodes.push(placeholderNode(entity.id))
    else document.tasks.push(placeholderTask(entity.id))
  }
  document.edges = structuredClone(edges)
  assertModelFragment(document, label)
}

function placeholderNode(id: string): CanvasNode {
  return {
    id,
    type: 'validation',
    frame: { x: 0, y: 0, w: 1, h: 1, z: 0 },
    title: 'Validation',
    artifactRefs: [],
    origin: { kind: 'user' },
  }
}

function placeholderTask(id: string): CanvasTask {
  return {
    id,
    title: 'Validation',
    goal: '',
    anchor: { x: 0, y: 0 },
    origin: { kind: 'user' },
  }
}

function placeholderCollection(id: string): CanvasCollection {
  return {
    id,
    title: 'Validation',
    anchor: { x: 0, y: 0 },
  }
}

function assertModelFragment(document: ReturnType<typeof emptyCanvasDocument>, label: string): void {
  const issues = collectCanvasValidationIssues(document)
  if (issues.length === 0) return
  const detail = issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join('; ')
  throw new ProtocolError(`${label} is invalid: ${detail}`)
}

function parseEntityRefs(value: unknown, label: string, requireNonEmpty: boolean): CanvasEntityRef[] {
  if (!Array.isArray(value)
    || value.length > MAX_CANVAS_COMMAND_ENTITIES
    || (requireNonEmpty && value.length === 0)) {
    throw new ProtocolError(`${label} must be a bounded${requireNonEmpty ? ' non-empty' : ''} array`)
  }
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    const parsed = parseEntityRef(candidate, `${label}[${index}]`)
    const key = `${parsed.kind}:${parsed.id}`
    if (seen.has(key)) throw new ProtocolError(`${label} contains a duplicate entity`)
    seen.add(key)
    return parsed
  })
}

function parseEntityRef(value: unknown, label: string): CanvasEntityRef {
  if (!isExactRecord(value, ['kind', 'id'])
    || (value.kind !== 'node' && value.kind !== 'task')
    || typeof value.id !== 'string') {
    throw new ProtocolError(`${label} is invalid`)
  }
  const parsed = parseEntityKey(`${value.kind}:${value.id}`)
  if (!parsed) throw new ProtocolError(`${label} is invalid`)
  return parsed
}

function parseIdentifierArray(value: unknown, label: string, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(value)
    || value.length > MAX_CANVAS_COMMAND_ENTITIES
    || (requireNonEmpty && value.length === 0)) {
    throw new ProtocolError(`${label} must be a bounded${requireNonEmpty ? ' non-empty' : ''} array`)
  }
  const parsed = value.map((candidate, index) =>
    parseIdentifier(candidate, `${label}[${index}]`))
  if (new Set(parsed).size !== parsed.length) {
    throw new ProtocolError(`${label} contains duplicate ids`)
  }
  return parsed
}

function parseProposalKeys(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > MAX_ACCEPTED_TASK_PROPOSALS) {
    throw new ProtocolError('command.proposalKeys must contain 1 to 12 keys')
  }
  const keys = value.map((candidate, index) =>
    parseStableKey(candidate, `command.proposalKeys[${index}]`))
  if (new Set(keys).size !== keys.length) {
    throw new ProtocolError('command.proposalKeys contains duplicate keys')
  }
  return keys
}

function parseProposalEdits(
  value: unknown,
  acceptedKeys: ReadonlySet<string>,
): Record<string, TaskProposalEditWire> {
  if (!isRecord(value)) throw new ProtocolError('command.edits must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_ACCEPTED_TASK_PROPOSALS) {
    throw new ProtocolError('command.edits has too many entries')
  }
  const edits: Record<string, TaskProposalEditWire> = {}
  for (const [rawKey, candidate] of entries) {
    const key = parseStableKey(rawKey, 'command.edits key')
    if (!acceptedKeys.has(key)) {
      throw new ProtocolError(`command.edits.${key} is not present in proposalKeys`)
    }
    if (!isRecord(candidate)) throw new ProtocolError(`command.edits.${key} must be an object`)
    assertCommandKeys(candidate, ['title', 'prompt', 'dependsOn'], [])
    if (Object.keys(candidate).length === 0) {
      throw new ProtocolError(`command.edits.${key} must change title, prompt, or dependencies`)
    }
    const title = candidate.title === undefined
      ? undefined
      : parseDisplayString(
        candidate.title,
        `command.edits.${key}.title`,
        MAX_PROPOSAL_EDIT_TITLE_LENGTH,
      )
    const prompt = candidate.prompt === undefined
      ? undefined
      : parseDisplayString(
        candidate.prompt,
        `command.edits.${key}.prompt`,
        MAX_PROPOSAL_EDIT_PROMPT_LENGTH,
      )
    const dependsOn = candidate.dependsOn === undefined
      ? undefined
      : parseProposalDependencies(candidate.dependsOn, acceptedKeys, key)
    if (title === undefined && prompt === undefined && dependsOn === undefined) {
      throw new ProtocolError(`command.edits.${key} must change title, prompt, or dependencies`)
    }
    edits[key] = {
      ...(title === undefined ? {} : { title }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
    }
  }
  return edits
}

function parseProposalDependencies(
  value: unknown,
  acceptedKeys: ReadonlySet<string>,
  proposalKey: string,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES) {
    throw new ProtocolError(`command.edits.${proposalKey}.dependsOn is invalid`)
  }
  const dependencies = value.map((candidate, index) => parseStableKey(
    candidate,
    `command.edits.${proposalKey}.dependsOn[${index}]`,
  ))
  if (new Set(dependencies).size !== dependencies.length) {
    throw new ProtocolError(`command.edits.${proposalKey}.dependsOn contains duplicate keys`)
  }
  for (const dependencyKey of dependencies) {
    if (dependencyKey === proposalKey) {
      throw new ProtocolError(`command.edits.${proposalKey}.dependsOn cannot contain itself`)
    }
    if (!acceptedKeys.has(dependencyKey)) {
      throw new ProtocolError(
        `command.edits.${proposalKey}.dependsOn contains an unselected proposal`,
      )
    }
  }
  return dependencies
}

function parsePlanId(value: unknown): string {
  if (typeof value !== 'string' || !/^plan_[0-9a-f]{64}$/u.test(value)) {
    throw new ProtocolError('command.planId is invalid')
  }
  return value
}

function parseClientIdentifier(value: unknown, label: string): string {
  const id = parseIdentifier(value, label)
  if (isReservedCanvasId(id)) {
    throw new ProtocolError(`${label} uses a daemon-reserved deterministic id`)
  }
  return id
}

function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    || value.includes('..')) throw new ProtocolError(`${label} is invalid`)
  return value
}

function parseStableKey(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROPOSAL_KEY_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new ProtocolError(`${label} is invalid`)
  }
  return value
}

function parseString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string'
    || value.length > maxLength
    || (!allowEmpty && value.length === 0)) throw new ProtocolError(`${label} is invalid`)
  return value
}

function parseDisplayString(value: unknown, label: string, maxLength: number): string {
  const result = parseString(value, label, maxLength, false)
  if (result !== result.trim()) throw new ProtocolError(`${label} must be trimmed`)
  for (let index = 0; index < result.length; index += 1) {
    const code = result.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) throw new ProtocolError(`${label} has control characters`)
  }
  return result
}

function parseFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${label} must be finite`)
  }
  return value
}

function parsePositiveFinite(value: unknown, label: string): number {
  const parsed = parseFinite(value, label)
  if (parsed <= 0) throw new ProtocolError(`${label} must be positive`)
  return parsed
}

function parsePoint(value: unknown, label: string): { x: number; y: number } {
  if (!isExactRecord(value, ['x', 'y'])) {
    throw new ProtocolError(`${label} has an invalid shape`)
  }
  return {
    x: parseFinite(value.x, `${label}.x`),
    y: parseFinite(value.y, `${label}.y`),
  }
}

function parseEdgeRelation(value: unknown, label: string): CanvasEdgeRelation {
  if (value !== 'source'
    && value !== 'produced'
    && value !== 'derived'
    && value !== 'modified'
    && value !== 'references'
    && value !== 'compares'
    && value !== 'replaces'
    && value !== 'depends-on') throw new ProtocolError(`${label} is invalid`)
  return value
}

function parseContextRole(value: unknown, label: string): CanvasEdgeContextRole {
  if (value !== 'full' && value !== 'summary' && value !== 'none') {
    throw new ProtocolError(`${label} is invalid`)
  }
  return value
}

function assertCommandKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new ProtocolError(`${String(value.type ?? 'command')} has unsupported or missing fields`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}
