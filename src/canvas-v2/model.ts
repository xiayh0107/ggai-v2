export type CanvasEntityRef =
  | { kind: 'node'; id: string }
  | { kind: 'task'; id: string }

export type CanvasEntityRefV2 = CanvasEntityRef

export interface CanvasPointV2 {
  x: number
  y: number
}

export interface CanvasFrameV2 extends CanvasPointV2 {
  w: number
  h: number
  z: number
}

export type CanvasTaskOriginV2 =
  | { kind: 'user' }
  | {
      kind: 'agent-proposal'
      parentTaskId: string
      planId: string
      proposalKey: string
    }

export interface CanvasTaskV2 {
  id: string
  title: string
  goal: string
  anchor: CanvasPointV2
  collectionId?: string
  origin: CanvasTaskOriginV2
}

export interface CanvasArtifactRefV2 {
  runId: string
  artifactId: string
}

export type CanvasNodeOriginV2 =
  | { kind: 'user' }
  | {
      kind: 'agent-output'
      taskId: string
      runId: string
      planId: string
      outputKey: string
    }
  | {
      kind: 'copied'
      sourceNodeId: string
    }

export interface CanvasNodeV2 {
  id: string
  type: string
  frame: CanvasFrameV2
  title: string
  text?: string
  payload?: Record<string, unknown>
  artifactRefs: CanvasArtifactRefV2[]
  homeTaskId?: string
  collectionId?: string
  origin: CanvasNodeOriginV2
}

export interface CanvasCollectionV2 {
  id: string
  title: string
  anchor: CanvasPointV2
}

export type CanvasEdgeRelationV2 =
  | 'source'
  | 'produced'
  | 'derived'
  | 'modified'
  | 'references'
  | 'compares'
  | 'replaces'
  | 'depends-on'

export type CanvasEdgeContextRoleV2 = 'full' | 'summary' | 'none'

export type CanvasEdgeOriginV2 =
  | { kind: 'user' }
  | {
      kind: 'agent'
      runId: string
      planId: string
    }

export interface CanvasEdgeV2 {
  id: string
  from: CanvasEntityRef
  to: CanvasEntityRef
  relation: CanvasEdgeRelationV2
  contextRole: CanvasEdgeContextRoleV2
  origin: CanvasEdgeOriginV2
}

export interface CanvasMaterializationReceiptV2 {
  kind: 'materialization'
  planId: string
  runId: string
  taskId: string
  outcomes: Array<{ outputKey: string; nodeId: string }>
  dismissedProposalKeys: string[]
}

export interface CanvasPlanDismissalReceiptV2 {
  kind: 'plan-dismissal'
  planId: string
  runId: string
  taskId: string
  proposalKeys: string[]
}

export interface CanvasProposalAcceptanceReceiptV2 {
  kind: 'proposal-acceptance'
  planId: string
  runId: string
  taskId: string
  proposals: Array<{ proposalKey: string; taskId: string }>
}

export type CanvasReceiptV2 =
  | CanvasMaterializationReceiptV2
  | CanvasPlanDismissalReceiptV2
  | CanvasProposalAcceptanceReceiptV2

export interface CanvasDocumentV2 {
  schemaVersion: 2
  nodes: CanvasNodeV2[]
  tasks: CanvasTaskV2[]
  collections: CanvasCollectionV2[]
  edges: CanvasEdgeV2[]
  receipts: CanvasReceiptV2[]
  everCreated: boolean
}

export interface CanvasV2ValidationIssue {
  path: string
  message: string
}

export class CanvasV2ValidationError extends Error {
  readonly issues: CanvasV2ValidationIssue[]

  constructor(issues: CanvasV2ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
    this.name = 'CanvasV2ValidationError'
    this.issues = issues
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u
const TYPE_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u
const PLAN_ID_PATTERN = /^plan_[0-9a-f]{64}$/u
const ARTIFACT_ID_PATTERN = /^artifact_[0-9a-f]{64}$/u
const RESERVED_CANVAS_ID_PATTERN = /^cv2_(?:node|task|collection|edge)_[0-9a-f]{32}$/u
const EDGE_RELATIONS = new Set<CanvasEdgeRelationV2>([
  'source',
  'produced',
  'derived',
  'modified',
  'references',
  'compares',
  'replaces',
  'depends-on',
])

export function emptyCanvasDocumentV2(): CanvasDocumentV2 {
  return {
    schemaVersion: 2,
    nodes: [],
    tasks: [],
    collections: [],
    edges: [],
    receipts: [],
    everCreated: false,
  }
}

export function entityKeyV2(ref: CanvasEntityRef): string {
  return `${ref.kind}:${ref.id}`
}

export function parseEntityKeyV2(value: string): CanvasEntityRef | null {
  if (value.startsWith('node:')) {
    const id = value.slice('node:'.length)
    return validId(id) ? { kind: 'node', id } : null
  }
  if (value.startsWith('task:')) {
    const id = value.slice('task:'.length)
    return validId(id) ? { kind: 'task', id } : null
  }
  return null
}

/** IDs in this namespace are assigned only by trusted reducer operations. */
export function isReservedCanvasIdV2(value: unknown): value is string {
  return typeof value === 'string' && RESERVED_CANVAS_ID_PATTERN.test(value)
}

/** Returns a human-readable reason when a typed edge has impossible endpoints. */
export function canvasEdgeTopologyIssueV2(
  edge: Pick<CanvasEdgeV2, 'from' | 'to' | 'relation'>,
): string | null {
  const { from, to, relation } = edge
  if (entityKeyV2(from) === entityKeyV2(to)) return 'must not be a self edge'
  if (relation === 'modified') {
    return from.kind === 'node' && to.kind === 'task'
      ? null
      : 'modified edges must connect a node to a task'
  }
  if (relation === 'produced') {
    return from.kind === 'task' && to.kind === 'node'
      ? null
      : 'produced edges must connect a task to a node'
  }
  if (relation === 'derived') {
    return from.kind === 'node' && to.kind === 'node'
      ? null
      : 'derived edges must connect two nodes'
  }
  if (relation === 'depends-on') {
    return from.kind === 'task' && to.kind === 'task'
      ? null
      : 'depends-on edges must connect two tasks'
  }
  return null
}

export function cloneCanvasDocumentV2(document: CanvasDocumentV2): CanvasDocumentV2 {
  return structuredClone(document)
}

export function parseCanvasDocumentV2(value: unknown): CanvasDocumentV2 {
  const issues = collectCanvasV2ValidationIssues(value)
  if (issues.length > 0) throw new CanvasV2ValidationError(issues)
  return structuredClone(value) as CanvasDocumentV2
}

export function assertCanvasDocumentV2(document: CanvasDocumentV2): void {
  const issues = collectCanvasV2ValidationIssues(document)
  if (issues.length > 0) throw new CanvasV2ValidationError(issues)
}

export function collectCanvasV2ValidationIssues(value: unknown): CanvasV2ValidationIssue[] {
  const issues: CanvasV2ValidationIssue[] = []
  if (!isExactRecord(value, [
    'schemaVersion',
    'nodes',
    'tasks',
    'collections',
    'edges',
    'receipts',
    'everCreated',
  ])) return [{ path: 'document', message: 'has an invalid envelope' }]
  if (value.schemaVersion !== 2) issue(issues, 'schemaVersion', 'must be 2')
  if (!Array.isArray(value.nodes)) issue(issues, 'nodes', 'must be an array')
  if (!Array.isArray(value.tasks)) issue(issues, 'tasks', 'must be an array')
  if (!Array.isArray(value.collections)) issue(issues, 'collections', 'must be an array')
  if (!Array.isArray(value.edges)) issue(issues, 'edges', 'must be an array')
  if (!Array.isArray(value.receipts)) issue(issues, 'receipts', 'must be an array')
  if (typeof value.everCreated !== 'boolean') issue(issues, 'everCreated', 'must be a boolean')
  if (issues.length > 0) return issues

  const nodes = value.nodes as unknown[]
  const tasks = value.tasks as unknown[]
  const collections = value.collections as unknown[]
  const edges = value.edges as unknown[]
  const receipts = value.receipts as unknown[]
  if (nodes.length > 10_000) issue(issues, 'nodes', 'has too many entries')
  if (tasks.length > 2_000) issue(issues, 'tasks', 'has too many entries')
  if (collections.length > 2_000) issue(issues, 'collections', 'has too many entries')
  if (edges.length > 50_000) issue(issues, 'edges', 'has too many entries')
  if (receipts.length > 20_000) issue(issues, 'receipts', 'has too many entries')
  nodes.forEach((node, index) => validateNode(node, `nodes[${index}]`, issues))
  tasks.forEach((task, index) => validateTask(task, `tasks[${index}]`, issues))
  collections.forEach((collection, index) =>
    validateCollection(collection, `collections[${index}]`, issues))
  edges.forEach((edge, index) => validateEdge(edge, `edges[${index}]`, issues))
  receipts.forEach((receipt, index) => validateReceipt(receipt, `receipts[${index}]`, issues))
  if (issues.length === 0) validateInvariants(value as unknown as CanvasDocumentV2, issues)
  return issues
}

function validateNode(value: unknown, path: string, issues: CanvasV2ValidationIssue[]): void {
  if (!isRecordWithOnly(value, [
    'id',
    'type',
    'frame',
    'title',
    'text',
    'payload',
    'artifactRefs',
    'homeTaskId',
    'collectionId',
    'origin',
  ])) {
    issue(issues, path, 'has unsupported fields')
    return
  }
  validateId(value.id, `${path}.id`, issues)
  if (typeof value.type !== 'string'
    || value.type.length === 0
    || value.type.length > 160
    || !TYPE_PATTERN.test(value.type)
    || value.type.includes('..')
    || value.type.includes('//')) issue(issues, `${path}.type`, 'is invalid')
  validateFrame(value.frame, `${path}.frame`, issues)
  validateString(value.title, `${path}.title`, 1_000, false, issues)
  if (value.text !== undefined) validateString(value.text, `${path}.text`, 1_000_000, true, issues)
  if (value.payload !== undefined) {
    if (!isJsonObject(value.payload)) issue(issues, `${path}.payload`, 'must be a JSON object')
    else validateJsonValue(value.payload, `${path}.payload`, 0, new WeakSet(), issues)
  }
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.length > 500) {
    issue(issues, `${path}.artifactRefs`, 'must be a bounded array')
  } else {
    value.artifactRefs.forEach((artifact, index) =>
      validateArtifactRef(artifact, `${path}.artifactRefs[${index}]`, issues))
  }
  if (value.homeTaskId !== undefined) validateId(value.homeTaskId, `${path}.homeTaskId`, issues)
  if (value.collectionId !== undefined) validateId(value.collectionId, `${path}.collectionId`, issues)
  validateNodeOrigin(value.origin, `${path}.origin`, issues)
}

function validateTask(value: unknown, path: string, issues: CanvasV2ValidationIssue[]): void {
  if (!isRecordWithOnly(value, ['id', 'title', 'goal', 'anchor', 'collectionId', 'origin'])) {
    issue(issues, path, 'has unsupported fields')
    return
  }
  validateId(value.id, `${path}.id`, issues)
  validateString(value.title, `${path}.title`, 1_000, false, issues)
  validateString(value.goal, `${path}.goal`, 250_000, true, issues)
  validatePoint(value.anchor, `${path}.anchor`, issues)
  if (value.collectionId !== undefined) validateId(value.collectionId, `${path}.collectionId`, issues)
  validateTaskOrigin(value.origin, `${path}.origin`, issues)
}

function validateCollection(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (!isExactRecord(value, ['id', 'title', 'anchor'])) {
    issue(issues, path, 'has an invalid shape')
    return
  }
  validateId(value.id, `${path}.id`, issues)
  validateString(value.title, `${path}.title`, 1_000, false, issues)
  validatePoint(value.anchor, `${path}.anchor`, issues)
}

function validateEdge(value: unknown, path: string, issues: CanvasV2ValidationIssue[]): void {
  if (!isExactRecord(value, ['id', 'from', 'to', 'relation', 'contextRole', 'origin'])) {
    issue(issues, path, 'has an invalid shape')
    return
  }
  validateId(value.id, `${path}.id`, issues)
  validateEntityRef(value.from, `${path}.from`, issues)
  validateEntityRef(value.to, `${path}.to`, issues)
  if (typeof value.relation !== 'string'
    || !EDGE_RELATIONS.has(value.relation as CanvasEdgeRelationV2)) {
    issue(issues, `${path}.relation`, 'is invalid')
  }
  if (value.contextRole !== 'full'
    && value.contextRole !== 'summary'
    && value.contextRole !== 'none') issue(issues, `${path}.contextRole`, 'is invalid')
  validateEdgeOrigin(value.origin, `${path}.origin`, issues)
}

function validateReceipt(value: unknown, path: string, issues: CanvasV2ValidationIssue[]): void {
  if (!isRecord(value)) {
    issue(issues, path, 'must be an object')
    return
  }
  if (value.kind === 'materialization') {
    if (!hasOnlyKeys(value, [
      'kind',
      'planId',
      'runId',
      'taskId',
      'outcomes',
      'dismissedProposalKeys',
    ])) {
      issue(issues, path, 'has unsupported fields')
      return
    }
    validateReceiptIdentity(value, path, issues)
    validateMappingArray(value.outcomes, `${path}.outcomes`, 'outputKey', 'nodeId', issues)
    validateKeyArray(value.dismissedProposalKeys, `${path}.dismissedProposalKeys`, issues)
    return
  }
  if (value.kind === 'plan-dismissal') {
    if (!hasOnlyKeys(value, ['kind', 'planId', 'runId', 'taskId', 'proposalKeys'])) {
      issue(issues, path, 'has unsupported fields')
      return
    }
    validateReceiptIdentity(value, path, issues)
    validateKeyArray(value.proposalKeys, `${path}.proposalKeys`, issues)
    return
  }
  if (value.kind === 'proposal-acceptance') {
    if (!hasOnlyKeys(value, ['kind', 'planId', 'runId', 'taskId', 'proposals'])) {
      issue(issues, path, 'has unsupported fields')
      return
    }
    validateReceiptIdentity(value, path, issues)
    validateMappingArray(value.proposals, `${path}.proposals`, 'proposalKey', 'taskId', issues)
    return
  }
  issue(issues, `${path}.kind`, 'is invalid')
}

function validateReceiptIdentity(
  value: Record<string, unknown>,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  validatePlanId(value.planId, `${path}.planId`, issues)
  validateId(value.runId, `${path}.runId`, issues)
  validateId(value.taskId, `${path}.taskId`, issues)
}

function validateMappingArray(
  value: unknown,
  path: string,
  keyName: 'outputKey' | 'proposalKey',
  idName: 'nodeId' | 'taskId',
  issues: CanvasV2ValidationIssue[],
): void {
  if (!Array.isArray(value) || value.length > 64) {
    issue(issues, path, 'must be a bounded array')
    return
  }
  value.forEach((entry, index) => {
    if (!isExactRecord(entry, [keyName, idName])) {
      issue(issues, `${path}[${index}]`, 'has an invalid shape')
      return
    }
    validateId(entry[keyName], `${path}[${index}].${keyName}`, issues, 80)
    validateId(entry[idName], `${path}[${index}].${idName}`, issues)
  })
}

function validateKeyArray(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (!Array.isArray(value)
    || value.length > 64
    || !value.every((entry) => validId(entry, 80))) issue(issues, path, 'must be a bounded key array')
}

function validateTaskOrigin(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (!isRecord(value)) {
    issue(issues, path, 'must be an object')
    return
  }
  if (value.kind === 'user' && isExactRecord(value, ['kind'])) return
  if (value.kind === 'agent-proposal'
    && isExactRecord(value, ['kind', 'parentTaskId', 'planId', 'proposalKey'])) {
    validateId(value.parentTaskId, `${path}.parentTaskId`, issues)
    validatePlanId(value.planId, `${path}.planId`, issues)
    validateId(value.proposalKey, `${path}.proposalKey`, issues, 80)
    return
  }
  issue(issues, path, 'is invalid')
}

function validateNodeOrigin(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (!isRecord(value)) {
    issue(issues, path, 'must be an object')
    return
  }
  if (value.kind === 'user' && isExactRecord(value, ['kind'])) return
  if (value.kind === 'agent-output'
    && isExactRecord(value, ['kind', 'taskId', 'runId', 'planId', 'outputKey'])) {
    validateId(value.taskId, `${path}.taskId`, issues)
    validateId(value.runId, `${path}.runId`, issues)
    validatePlanId(value.planId, `${path}.planId`, issues)
    validateId(value.outputKey, `${path}.outputKey`, issues, 80)
    return
  }
  if (value.kind === 'copied' && isExactRecord(value, ['kind', 'sourceNodeId'])) {
    validateId(value.sourceNodeId, `${path}.sourceNodeId`, issues)
    return
  }
  issue(issues, path, 'is invalid')
}

function validateEdgeOrigin(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (!isRecord(value)) {
    issue(issues, path, 'must be an object')
    return
  }
  if (value.kind === 'user' && isExactRecord(value, ['kind'])) return
  if (value.kind === 'agent' && isExactRecord(value, ['kind', 'runId', 'planId'])) {
    validateId(value.runId, `${path}.runId`, issues)
    validatePlanId(value.planId, `${path}.planId`, issues)
    return
  }
  issue(issues, path, 'is invalid')
}

function validateArtifactRef(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (!isExactRecord(value, ['runId', 'artifactId'])) {
    issue(issues, path, 'must contain only runId and artifactId')
    return
  }
  validateId(value.runId, `${path}.runId`, issues)
  if (typeof value.artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(value.artifactId)) {
    issue(issues, `${path}.artifactId`, 'is invalid')
  }
}

function validateInvariants(
  document: CanvasDocumentV2,
  issues: CanvasV2ValidationIssue[],
): void {
  const allIds = new Set<string>()
  const nodeIds = new Set<string>()
  const taskIds = new Set<string>()
  const collectionIds = new Set<string>()
  for (const [index, collection] of document.collections.entries()) {
    addUniqueId(collection.id, `collections[${index}].id`, allIds, collectionIds, issues)
  }
  for (const [index, task] of document.tasks.entries()) {
    addUniqueId(task.id, `tasks[${index}].id`, allIds, taskIds, issues)
  }
  for (const [index, node] of document.nodes.entries()) {
    addUniqueId(node.id, `nodes[${index}].id`, allIds, nodeIds, issues)
  }

  const acceptanceByProposal = new Map<string, string>()
  const materializationByOutput = new Map<string, string>()
  const receiptKinds = new Set<string>()
  const identityByPlan = new Map<string, { runId: string; taskId: string }>()
  for (const [index, receipt] of document.receipts.entries()) {
    const kindKey = `${receipt.kind}\0${receipt.planId}`
    if (receiptKinds.has(kindKey)) issue(issues, `receipts[${index}]`, 'duplicates a receipt kind for this plan')
    receiptKinds.add(kindKey)
    const identity = identityByPlan.get(receipt.planId)
    if (identity && (identity.runId !== receipt.runId || identity.taskId !== receipt.taskId)) {
      issue(issues, `receipts[${index}]`, 'disagrees with another receipt for this plan')
    } else {
      identityByPlan.set(receipt.planId, { runId: receipt.runId, taskId: receipt.taskId })
    }
    if (receipt.kind === 'materialization') {
      validateUniqueMappings(receipt.outcomes, 'outputKey', 'nodeId', `receipts[${index}].outcomes`, issues)
      validateUniqueStrings(receipt.dismissedProposalKeys, `receipts[${index}].dismissedProposalKeys`, issues)
      for (const outcome of receipt.outcomes) {
        materializationByOutput.set(`${receipt.planId}\0${outcome.outputKey}`, outcome.nodeId)
      }
    } else if (receipt.kind === 'proposal-acceptance') {
      validateUniqueMappings(receipt.proposals, 'proposalKey', 'taskId', `receipts[${index}].proposals`, issues)
      for (const proposal of receipt.proposals) {
        acceptanceByProposal.set(`${receipt.planId}\0${proposal.proposalKey}`, proposal.taskId)
      }
    } else {
      validateUniqueStrings(receipt.proposalKeys, `receipts[${index}].proposalKeys`, issues)
    }
  }

  for (const [index, task] of document.tasks.entries()) {
    if (task.collectionId && !collectionIds.has(task.collectionId)) {
      issue(issues, `tasks[${index}].collectionId`, 'references a missing collection')
    }
    if (task.origin.kind === 'agent-proposal') {
      const acceptedTaskId = acceptanceByProposal.get(
        `${task.origin.planId}\0${task.origin.proposalKey}`,
      )
      if (acceptedTaskId !== task.id) {
        issue(issues, `tasks[${index}].origin`, 'does not match an acceptance receipt')
      }
    }
  }
  validateTaskOriginCycles(document.tasks, issues)

  const agentOutputs = new Set<string>()
  for (const [index, node] of document.nodes.entries()) {
    if (node.homeTaskId && node.collectionId) {
      issue(issues, `nodes[${index}]`, 'task-internal nodes cannot have collectionId')
    }
    if (node.homeTaskId && !taskIds.has(node.homeTaskId)) {
      issue(issues, `nodes[${index}].homeTaskId`, 'references a missing task')
    }
    if (node.collectionId && !collectionIds.has(node.collectionId)) {
      issue(issues, `nodes[${index}].collectionId`, 'references a missing collection')
    }
    const artifactKeys = node.artifactRefs.map((ref) => `${ref.runId}\0${ref.artifactId}`)
    if (new Set(artifactKeys).size !== artifactKeys.length) {
      issue(issues, `nodes[${index}].artifactRefs`, 'contains duplicate artifact references')
    }
    if (node.origin.kind === 'agent-output') {
      const outputOrigin = node.origin
      const provenanceKey = `${outputOrigin.planId}\0${outputOrigin.outputKey}`
      if (agentOutputs.has(provenanceKey)) {
        issue(issues, `nodes[${index}].origin`, 'duplicates agent output provenance')
      }
      agentOutputs.add(provenanceKey)
      if (node.homeTaskId && node.homeTaskId !== outputOrigin.taskId) {
        issue(issues, `nodes[${index}].homeTaskId`, 'must match agent output taskId')
      }
      if (materializationByOutput.get(provenanceKey) !== node.id) {
        issue(issues, `nodes[${index}].origin`, 'does not match a materialization receipt')
      }
      if (node.artifactRefs.some((artifact) => artifact.runId !== outputOrigin.runId)) {
        issue(issues, `nodes[${index}].artifactRefs`, 'must belong to the output run')
      }
    }
  }

  const edgeIds = new Set<string>()
  const edgeSemantics = new Set<string>()
  for (const [index, edge] of document.edges.entries()) {
    if (edgeIds.has(edge.id)) issue(issues, `edges[${index}].id`, 'duplicates an edge id')
    edgeIds.add(edge.id)
    const fromKey = entityKeyV2(edge.from)
    const toKey = entityKeyV2(edge.to)
    if (!entityExists(nodeIds, taskIds, edge.from)) issue(issues, `edges[${index}].from`, 'is missing')
    if (!entityExists(nodeIds, taskIds, edge.to)) issue(issues, `edges[${index}].to`, 'is missing')
    const topologyIssue = canvasEdgeTopologyIssueV2(edge)
    if (topologyIssue) issue(issues, `edges[${index}]`, topologyIssue)
    const semanticKey = JSON.stringify([fromKey, toKey, edge.relation, edge.contextRole])
    if (edgeSemantics.has(semanticKey)) issue(issues, `edges[${index}]`, 'duplicates a semantic edge')
    edgeSemantics.add(semanticKey)
  }
}

function validateTaskOriginCycles(
  tasks: CanvasTaskV2[],
  issues: CanvasV2ValidationIssue[],
): void {
  const parents = new Map(tasks.flatMap((task) => task.origin.kind === 'agent-proposal'
    ? [[task.id, task.origin.parentTaskId] as const]
    : []))
  for (const [index, task] of tasks.entries()) {
    const seen = new Set<string>()
    let current: string | undefined = task.id
    while (current) {
      if (seen.has(current)) {
        issue(issues, `tasks[${index}].origin`, 'forms a task provenance cycle')
        break
      }
      seen.add(current)
      current = parents.get(current)
    }
  }
}

function validateUniqueMappings<T extends Record<string, string>>(
  entries: T[],
  keyName: keyof T,
  valueName: keyof T,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  const keys = entries.map((entry) => entry[keyName])
  const values = entries.map((entry) => entry[valueName])
  if (new Set(keys).size !== keys.length) issue(issues, path, `duplicates ${String(keyName)}`)
  if (new Set(values).size !== values.length) issue(issues, path, `duplicates ${String(valueName)}`)
}

function validateUniqueStrings(
  values: string[],
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (new Set(values).size !== values.length) issue(issues, path, 'must contain unique values')
}

function addUniqueId(
  id: string,
  path: string,
  allIds: Set<string>,
  typedIds: Set<string>,
  issues: CanvasV2ValidationIssue[],
): void {
  if (allIds.has(id)) issue(issues, path, 'duplicates an entity id')
  allIds.add(id)
  typedIds.add(id)
}

function entityExists(
  nodeIds: Set<string>,
  taskIds: Set<string>,
  ref: CanvasEntityRef,
): boolean {
  return ref.kind === 'node' ? nodeIds.has(ref.id) : taskIds.has(ref.id)
}

function validateEntityRef(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (!isExactRecord(value, ['kind', 'id'])
    || (value.kind !== 'node' && value.kind !== 'task')) {
    issue(issues, path, 'must be a node or task reference')
    return
  }
  validateId(value.id, `${path}.id`, issues)
}

function validateFrame(value: unknown, path: string, issues: CanvasV2ValidationIssue[]): void {
  if (!isExactRecord(value, ['x', 'y', 'w', 'h', 'z'])) {
    issue(issues, path, 'has an invalid shape')
    return
  }
  validateFinite(value.x, `${path}.x`, issues)
  validateFinite(value.y, `${path}.y`, issues)
  validatePositive(value.w, `${path}.w`, issues)
  validatePositive(value.h, `${path}.h`, issues)
  validateFinite(value.z, `${path}.z`, issues)
}

function validatePoint(value: unknown, path: string, issues: CanvasV2ValidationIssue[]): void {
  if (!isExactRecord(value, ['x', 'y'])) {
    issue(issues, path, 'has an invalid shape')
    return
  }
  validateFinite(value.x, `${path}.x`, issues)
  validateFinite(value.y, `${path}.y`, issues)
}

function validateId(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
  maxLength = 160,
): void {
  if (!validId(value, maxLength)) issue(issues, path, 'is not a valid identifier')
}

function validId(value: unknown, maxLength = 160): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && ID_PATTERN.test(value)
    && !value.includes('..')
}

function validatePlanId(
  value: unknown,
  path: string,
  issues: CanvasV2ValidationIssue[],
): void {
  if (typeof value !== 'string' || !PLAN_ID_PATTERN.test(value)) issue(issues, path, 'is invalid')
}

function validateString(
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty: boolean,
  issues: CanvasV2ValidationIssue[],
): void {
  if (typeof value !== 'string'
    || value.length > maxLength
    || (!allowEmpty && value.length === 0)) issue(issues, path, 'is invalid')
}

function validateFinite(value: unknown, path: string, issues: CanvasV2ValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) issue(issues, path, 'must be finite')
}

function validatePositive(value: unknown, path: string, issues: CanvasV2ValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    issue(issues, path, 'must be positive and finite')
  }
}

function validateJsonValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: WeakSet<object>,
  issues: CanvasV2ValidationIssue[],
): void {
  if (depth > 50) {
    issue(issues, path, 'is nested too deeply')
    return
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issue(issues, path, 'contains a non-finite number')
    return
  }
  if (typeof value !== 'object') {
    issue(issues, path, 'is not JSON serializable')
    return
  }
  if (ancestors.has(value)) {
    issue(issues, path, 'contains a cycle')
    return
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateJsonValue(entry, `${path}[${index}]`, depth + 1, ancestors, issues))
  } else {
    if (!isJsonObject(value)) {
      issue(issues, path, 'is not a plain JSON object')
      ancestors.delete(value)
      return
    }
    for (const [key, entry] of Object.entries(value)) {
      validateJsonValue(entry, `${path}.${key}`, depth + 1, ancestors, issues)
    }
  }
  ancestors.delete(value)
}

function issue(issues: CanvasV2ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isRecordWithOnly(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key))
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
