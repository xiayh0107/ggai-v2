import {
  canonicalNodeSkillBindings,
  type NodeSkillBindings,
} from '../skills/contracts.js'

export type CanvasEntityRef =
  | { kind: 'node'; id: string; port?: string }
  | { kind: 'task'; id: string }

export interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasFrame extends CanvasPoint {
  w: number
  h: number
  z: number
}

export interface CanvasNodeTypeRef {
  id: string
  revision: number
  digest: string
}

export interface CanvasNodeBounds {
  w: number
  h: number
}

export interface CanvasNodeTransform {
  matrix: [number, number, number, number, number, number]
}

export type CanvasTaskOrigin =
  | { kind: 'user' }
  | {
      kind: 'agent-proposal'
      parentTaskId: string
      planId: string
      proposalKey: string
    }

export interface CanvasTask {
  id: string
  title: string
  goal: string
  anchor: CanvasPoint
  collectionId?: string
  origin: CanvasTaskOrigin
}

export interface CanvasArtifactRef {
  runId: string
  artifactId: string
}

export type CanvasNodeOrigin =
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

export interface CanvasNode {
  id: string
  typeRef: CanvasNodeTypeRef
  parentId: string | null
  orderKey: string
  bounds: CanvasNodeBounds
  transform: CanvasNodeTransform
  coordinateSpace?: { unit: 'px' | 'pt' | 'in' | 'normalized'; dpi?: number }
  title: string
  text?: string
  payload?: Record<string, unknown>
  artifactRefs: CanvasArtifactRef[]
  /** Optional instance-level task capabilities; absent means inherit the Node type defaults. */
  skillBindings?: NodeSkillBindings
  selectedExecutionId?: string
  bindingId?: string
  instanceRef?: { definitionId: string; revision: number; digest: string }
  homeTaskId?: string
  collectionId?: string
  origin: CanvasNodeOrigin
}

export interface CanvasCollection {
  id: string
  title: string
  anchor: CanvasPoint
}

export type CanvasEdgeRelation =
  | 'source'
  | 'produced'
  | 'derived'
  | 'modified'
  | 'references'
  | 'compares'
  | 'replaces'
  | 'depends-on'
  | 'data'

export type CanvasEdgeContextRole = 'full' | 'summary' | 'none'

export type CanvasEdgeOrigin =
  | { kind: 'user' }
  | {
      kind: 'agent'
      runId: string
      planId: string
    }

export interface CanvasEdge {
  id: string
  from: CanvasEntityRef
  to: CanvasEntityRef
  relation: CanvasEdgeRelation
  contextRole: CanvasEdgeContextRole
  orderKey?: string
  origin: CanvasEdgeOrigin
}

export interface CanvasMaterializationReceipt {
  kind: 'materialization'
  planId: string
  runId: string
  taskId: string
  outcomes: Array<{ outputKey: string; nodeId: string }>
  dismissedProposalKeys: string[]
}

export interface CanvasPlanDismissalReceipt {
  kind: 'plan-dismissal'
  planId: string
  runId: string
  taskId: string
  proposalKeys: string[]
}

export interface CanvasProposalAcceptanceReceipt {
  kind: 'proposal-acceptance'
  planId: string
  runId: string
  taskId: string
  proposals: Array<{ proposalKey: string; taskId: string }>
}

export interface CanvasGraphMaterializationReceipt {
  kind: 'graph-materialization'
  planId: string
  runId: string
  taskId: string
  nodes: Array<{ logicalKey: string; nodeId: string }>
}

export type CanvasReceipt =
  | CanvasMaterializationReceipt
  | CanvasPlanDismissalReceipt
  | CanvasProposalAcceptanceReceipt
  | CanvasGraphMaterializationReceipt

export interface CanvasDocument {
  schemaVersion: 3
  nodes: CanvasNode[]
  tasks: CanvasTask[]
  collections: CanvasCollection[]
  edges: CanvasEdge[]
  receipts: CanvasReceipt[]
  everCreated: boolean
}

export interface CanvasValidationIssue {
  path: string
  message: string
}

export class CanvasValidationError extends Error {
  readonly issues: CanvasValidationIssue[]

  constructor(issues: CanvasValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
    this.name = 'CanvasValidationError'
    this.issues = issues
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u
const TYPE_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u
const PLAN_ID_PATTERN = /^plan_[0-9a-f]{64}$/u
const ARTIFACT_ID_PATTERN = /^artifact_[0-9a-f]{64}$/u
const RESERVED_CANVAS_ID_PATTERN = /^canvas_(?:node|task|collection|edge)_[0-9a-f]{32}$/u
const RETIRED_CANVAS_ID_PATTERN = /^cv2_(?:node|task|collection|edge)_[0-9a-f]{32}$/u
// Read-only compatibility for deterministic entity IDs already persisted before rolling migration.
const EDGE_RELATIONS = new Set<CanvasEdgeRelation>([
  'source',
  'produced',
  'derived',
  'modified',
  'references',
  'compares',
  'replaces',
  'depends-on',
  'data',
])

export function emptyCanvasDocument(): CanvasDocument {
  return {
    schemaVersion: 3,
    nodes: [],
    tasks: [],
    collections: [],
    edges: [],
    receipts: [],
    everCreated: false,
  }
}

export function entityKey(ref: CanvasEntityRef): string {
  return `${ref.kind}:${ref.id}`
}

export function parseEntityKey(value: string): CanvasEntityRef | null {
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
export function isReservedCanvasId(value: unknown): value is string {
  return typeof value === 'string'
    && (RESERVED_CANVAS_ID_PATTERN.test(value) || RETIRED_CANVAS_ID_PATTERN.test(value))
}

export function canvasNodeTypeRef(id: string, revision = 1): CanvasNodeTypeRef {
  if (typeof id !== 'string' || !TYPE_PATTERN.test(id) || id.includes('..') || id.includes('//')) {
    throw new TypeError('node type id is invalid')
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('node type revision is invalid')
  }
  const value = `${id}\0${revision}`
  const seeds = [
    0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
    0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5,
  ]
  const digest = seeds.map((seed) => {
    let hash = seed >>> 0
    for (const character of value) {
      hash ^= character.codePointAt(0) ?? 0
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }).join('')
  return { id, revision, digest }
}

export function canvasNodeFrame(node: CanvasNode): CanvasFrame {
  return {
    x: node.transform.matrix[4],
    y: node.transform.matrix[5],
    w: node.bounds.w,
    h: node.bounds.h,
    z: canvasOrderNumber(node.orderKey),
  }
}

export function canvasNodeWorldTransform(
  document: Pick<CanvasDocument, 'nodes'>,
  node: CanvasNode,
): CanvasNodeTransform['matrix'] {
  const nodesById = new Map(document.nodes.map((entry) => [entry.id, entry]))
  const chain: CanvasNode[] = []
  const seen = new Set<string>()
  let current: CanvasNode | undefined = node
  while (current) {
    if (seen.has(current.id)) throw new CanvasValidationError([{
      path: `nodes.${node.id}.parentId`,
      message: 'forms a containment cycle',
    }])
    seen.add(current.id)
    chain.push(current)
    current = current.parentId ? nodesById.get(current.parentId) : undefined
    if (chain.length > 32) throw new CanvasValidationError([{
      path: `nodes.${node.id}.parentId`,
      message: 'exceeds maximum containment depth 32',
    }])
  }
  return chain.reverse().reduce<CanvasNodeTransform['matrix']>(
    (matrix, entry) => multiplyAffine(matrix, entry.transform.matrix),
    [1, 0, 0, 1, 0, 0],
  )
}

export function canvasNodeWorldFrame(
  document: Pick<CanvasDocument, 'nodes'>,
  node: CanvasNode,
): CanvasFrame {
  const matrix = canvasNodeWorldTransform(document, node)
  const corners = [
    transformPoint(matrix, 0, 0),
    transformPoint(matrix, node.bounds.w, 0),
    transformPoint(matrix, 0, node.bounds.h),
    transformPoint(matrix, node.bounds.w, node.bounds.h),
  ]
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  const root = canvasRootNode(document, node)
  let depth = 0
  let current: CanvasNode | undefined = node
  const byId = new Map(document.nodes.map((entry) => [entry.id, entry]))
  while (current?.parentId) {
    depth += 1
    current = byId.get(current.parentId)
  }
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    z: canvasOrderNumber(root.orderKey) * 1_000_000
      + depth * 10_000
      + canvasOrderNumber(node.orderKey),
  }
}

export function canvasRootNode(
  document: Pick<CanvasDocument, 'nodes'>,
  node: CanvasNode,
): CanvasNode {
  const nodesById = new Map(document.nodes.map((entry) => [entry.id, entry]))
  let current = node
  const seen = new Set<string>()
  while (current.parentId) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    const parent = nodesById.get(current.parentId)
    if (!parent) break
    current = parent
  }
  return current
}

export function canvasNodeGeometry(frame: CanvasFrame): Pick<
  CanvasNode,
  'parentId' | 'orderKey' | 'bounds' | 'transform'
> {
  return {
    parentId: null,
    orderKey: canvasOrderKey(Math.max(0, Math.trunc(frame.z))),
    bounds: { w: frame.w, h: frame.h },
    transform: { matrix: [1, 0, 0, 1, frame.x, frame.y] },
  }
}

export function canvasOrderKey(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('order value is invalid')
  return value.toString(36).padStart(12, '0')
}

export function canvasOrderNumber(value: string): number {
  if (!/^[0-9a-z]{12}$/u.test(value)) return 0
  const parsed = Number.parseInt(value, 36)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

/** Returns a human-readable reason when a typed edge has impossible endpoints. */
export function canvasEdgeTopologyIssue(
  edge: Pick<CanvasEdge, 'from' | 'to' | 'relation'>,
): string | null {
  const { from, to, relation } = edge
  if (entityKey(from) === entityKey(to)) return 'must not be a self edge'
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
  if (relation === 'data') {
    return from.kind === 'node'
      && to.kind === 'node'
      && Boolean(from.port)
      && Boolean(to.port)
      ? null
      : 'data edges must connect two named node ports'
  }
  if ((from.kind === 'node' && from.port) || (to.kind === 'node' && to.port)) {
    return 'semantic edges must use entity-level endpoints'
  }
  return null
}

export function cloneCanvasDocument(document: CanvasDocument): CanvasDocument {
  return structuredClone(document)
}

export function parseCanvasDocument(value: unknown): CanvasDocument {
  const issues = collectCanvasValidationIssues(value)
  if (issues.length > 0) throw new CanvasValidationError(issues)
  return structuredClone(value) as CanvasDocument
}

export function assertCanvasDocument(document: CanvasDocument): void {
  const issues = collectCanvasValidationIssues(document)
  if (issues.length > 0) throw new CanvasValidationError(issues)
}

export function collectCanvasValidationIssues(value: unknown): CanvasValidationIssue[] {
  const issues: CanvasValidationIssue[] = []
  if (!isExactRecord(value, [
    'schemaVersion',
    'nodes',
    'tasks',
    'collections',
    'edges',
    'receipts',
    'everCreated',
  ])) return [{ path: 'document', message: 'has an invalid envelope' }]
  if (value.schemaVersion !== 3) issue(issues, 'schemaVersion', 'must be 3')
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
  if (issues.length === 0) validateInvariants(value as unknown as CanvasDocument, issues)
  return issues
}

function validateNode(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (!isRecordWithOnly(value, [
    'id',
    'typeRef',
    'parentId',
    'orderKey',
    'bounds',
    'transform',
    'coordinateSpace',
    'title',
    'text',
    'payload',
    'artifactRefs',
    'skillBindings',
    'selectedExecutionId',
    'bindingId',
    'instanceRef',
    'homeTaskId',
    'collectionId',
    'origin',
  ])) {
    issue(issues, path, 'has unsupported fields')
    return
  }
  validateId(value.id, `${path}.id`, issues)
  validateNodeTypeRef(value.typeRef, `${path}.typeRef`, issues)
  if (value.parentId !== null) validateId(value.parentId, `${path}.parentId`, issues)
  validateOrderKey(value.orderKey, `${path}.orderKey`, issues)
  validateBounds(value.bounds, `${path}.bounds`, issues)
  validateTransform(value.transform, `${path}.transform`, issues)
  if (value.coordinateSpace !== undefined) {
    validateCoordinateSpace(value.coordinateSpace, `${path}.coordinateSpace`, issues)
  }
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
  if (value.skillBindings !== undefined) {
    try {
      canonicalNodeSkillBindings(value.skillBindings, `${path}.skillBindings`)
    } catch (error) {
      issue(
        issues,
        `${path}.skillBindings`,
        error instanceof Error ? error.message : 'is invalid',
      )
    }
  }
  if (value.selectedExecutionId !== undefined) {
    validateId(value.selectedExecutionId, `${path}.selectedExecutionId`, issues)
  }
  if (value.bindingId !== undefined) validateId(value.bindingId, `${path}.bindingId`, issues)
  if (value.instanceRef !== undefined) validateInstanceRef(value.instanceRef, `${path}.instanceRef`, issues)
  if (value.homeTaskId !== undefined) validateId(value.homeTaskId, `${path}.homeTaskId`, issues)
  if (value.collectionId !== undefined) validateId(value.collectionId, `${path}.collectionId`, issues)
  validateNodeOrigin(value.origin, `${path}.origin`, issues)
}

function validateTask(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
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
  issues: CanvasValidationIssue[],
): void {
  if (!isExactRecord(value, ['id', 'title', 'anchor'])) {
    issue(issues, path, 'has an invalid shape')
    return
  }
  validateId(value.id, `${path}.id`, issues)
  validateString(value.title, `${path}.title`, 1_000, false, issues)
  validatePoint(value.anchor, `${path}.anchor`, issues)
}

function validateEdge(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (!isRecordWithOnly(value, ['id', 'from', 'to', 'relation', 'contextRole', 'orderKey', 'origin'])) {
    issue(issues, path, 'has an invalid shape')
    return
  }
  validateId(value.id, `${path}.id`, issues)
  validateEntityRef(value.from, `${path}.from`, issues)
  validateEntityRef(value.to, `${path}.to`, issues)
  if (typeof value.relation !== 'string'
    || !EDGE_RELATIONS.has(value.relation as CanvasEdgeRelation)) {
    issue(issues, `${path}.relation`, 'is invalid')
  }
  if (value.contextRole !== 'full'
    && value.contextRole !== 'summary'
    && value.contextRole !== 'none') issue(issues, `${path}.contextRole`, 'is invalid')
  validateEdgeOrigin(value.origin, `${path}.origin`, issues)
  if (value.orderKey !== undefined) validateOrderKey(value.orderKey, `${path}.orderKey`, issues)
  if (value.relation === 'data' && value.orderKey === undefined) {
    issue(issues, `${path}.orderKey`, 'is required for data edges')
  }
  if (value.relation === 'data' && value.contextRole !== 'none') {
    issue(issues, `${path}.contextRole`, 'data edges must not implicitly grant Agent context')
  }
}

function validateReceipt(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
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
  if (value.kind === 'graph-materialization') {
    if (!hasOnlyKeys(value, ['kind', 'planId', 'runId', 'taskId', 'nodes'])) {
      issue(issues, path, 'has unsupported fields')
      return
    }
    validateReceiptIdentity(value, path, issues)
    validateMappingArray(value.nodes, `${path}.nodes`, 'logicalKey', 'nodeId', issues)
    return
  }
  issue(issues, `${path}.kind`, 'is invalid')
}

function validateReceiptIdentity(
  value: Record<string, unknown>,
  path: string,
  issues: CanvasValidationIssue[],
): void {
  validatePlanId(value.planId, `${path}.planId`, issues)
  validateId(value.runId, `${path}.runId`, issues)
  validateId(value.taskId, `${path}.taskId`, issues)
}

function validateMappingArray(
  value: unknown,
  path: string,
  keyName: 'outputKey' | 'proposalKey' | 'logicalKey',
  idName: 'nodeId' | 'taskId',
  issues: CanvasValidationIssue[],
): void {
  if (!Array.isArray(value) || value.length > (keyName === 'logicalKey' ? 256 : 64)) {
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
  issues: CanvasValidationIssue[],
): void {
  if (!Array.isArray(value)
    || value.length > 64
    || !value.every((entry) => validId(entry, 80))) issue(issues, path, 'must be a bounded key array')
}

function validateTaskOrigin(
  value: unknown,
  path: string,
  issues: CanvasValidationIssue[],
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
  issues: CanvasValidationIssue[],
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
  issues: CanvasValidationIssue[],
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
  issues: CanvasValidationIssue[],
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
  document: CanvasDocument,
  issues: CanvasValidationIssue[],
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
  const acceptedProposalPaths = new Map<string, string>()
  const dismissedProposalPaths = new Map<string, string>()
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
      for (const [proposalIndex, proposalKey] of receipt.dismissedProposalKeys.entries()) {
        dismissedProposalPaths.set(
          `${receipt.planId}\0${proposalKey}`,
          `receipts[${index}].dismissedProposalKeys[${proposalIndex}]`,
        )
      }
    } else if (receipt.kind === 'proposal-acceptance') {
      validateUniqueMappings(receipt.proposals, 'proposalKey', 'taskId', `receipts[${index}].proposals`, issues)
      for (const [proposalIndex, proposal] of receipt.proposals.entries()) {
        acceptanceByProposal.set(`${receipt.planId}\0${proposal.proposalKey}`, proposal.taskId)
        acceptedProposalPaths.set(
          `${receipt.planId}\0${proposal.proposalKey}`,
          `receipts[${index}].proposals[${proposalIndex}].proposalKey`,
        )
      }
    } else if (receipt.kind === 'plan-dismissal') {
      validateUniqueStrings(receipt.proposalKeys, `receipts[${index}].proposalKeys`, issues)
      for (const [proposalIndex, proposalKey] of receipt.proposalKeys.entries()) {
        dismissedProposalPaths.set(
          `${receipt.planId}\0${proposalKey}`,
          `receipts[${index}].proposalKeys[${proposalIndex}]`,
        )
      }
    } else {
      validateUniqueMappings(receipt.nodes, 'logicalKey', 'nodeId', `receipts[${index}].nodes`, issues)
      for (const node of receipt.nodes) {
        materializationByOutput.set(`${receipt.planId}\0${node.logicalKey}`, node.nodeId)
      }
    }
  }

  for (const [proposalIdentity, acceptedPath] of acceptedProposalPaths) {
    if (dismissedProposalPaths.has(proposalIdentity)) {
      issue(issues, acceptedPath, 'is both accepted and dismissed for this plan')
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
  const parentByNode = new Map<string, string>()
  for (const [index, node] of document.nodes.entries()) {
    if (node.parentId !== null) {
      if (!nodeIds.has(node.parentId)) {
        issue(issues, `nodes[${index}].parentId`, 'references a missing node')
      } else {
        parentByNode.set(node.id, node.parentId)
      }
      if (node.homeTaskId || node.collectionId) {
        issue(issues, `nodes[${index}]`, 'child nodes inherit Task and Collection scope')
      }
    }
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
  validateContainment(parentByNode, document.nodes, issues)

  const edgeIds = new Set<string>()
  const edgeSemantics = new Set<string>()
  for (const [index, edge] of document.edges.entries()) {
    if (edgeIds.has(edge.id)) issue(issues, `edges[${index}].id`, 'duplicates an edge id')
    edgeIds.add(edge.id)
    const fromKey = entityKey(edge.from)
    const toKey = entityKey(edge.to)
    if (!entityExists(nodeIds, taskIds, edge.from)) issue(issues, `edges[${index}].from`, 'is missing')
    if (!entityExists(nodeIds, taskIds, edge.to)) issue(issues, `edges[${index}].to`, 'is missing')
    const topologyIssue = canvasEdgeTopologyIssue(edge)
    if (topologyIssue) issue(issues, `edges[${index}]`, topologyIssue)
    const semanticKey = JSON.stringify([
      fromKey,
      edge.from.kind === 'node' ? edge.from.port ?? null : null,
      toKey,
      edge.to.kind === 'node' ? edge.to.port ?? null : null,
      edge.relation,
      edge.contextRole,
    ])
    if (edgeSemantics.has(semanticKey)) issue(issues, `edges[${index}]`, 'duplicates a semantic edge')
    edgeSemantics.add(semanticKey)
  }
}

function validateTaskOriginCycles(
  tasks: CanvasTask[],
  issues: CanvasValidationIssue[],
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

function multiplyAffine(
  left: CanvasNodeTransform['matrix'],
  right: CanvasNodeTransform['matrix'],
): CanvasNodeTransform['matrix'] {
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

function transformPoint(
  matrix: CanvasNodeTransform['matrix'],
  x: number,
  y: number,
): CanvasPoint {
  const [a, b, c, d, e, f] = matrix
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

function validateContainment(
  parentByNode: Map<string, string>,
  nodes: CanvasNode[],
  issues: CanvasValidationIssue[],
): void {
  for (const [index, node] of nodes.entries()) {
    const seen = new Set<string>()
    let current: string | undefined = node.id
    let depth = 0
    while (current) {
      if (seen.has(current)) {
        issue(issues, `nodes[${index}].parentId`, 'forms a containment cycle')
        break
      }
      seen.add(current)
      current = parentByNode.get(current)
      depth += 1
      if (depth > 32) {
        issue(issues, `nodes[${index}].parentId`, 'exceeds maximum containment depth 32')
        break
      }
    }
  }

}

function validateUniqueMappings<T extends Record<string, string>>(
  entries: T[],
  keyName: keyof T,
  valueName: keyof T,
  path: string,
  issues: CanvasValidationIssue[],
): void {
  const keys = entries.map((entry) => entry[keyName])
  const values = entries.map((entry) => entry[valueName])
  if (new Set(keys).size !== keys.length) issue(issues, path, `duplicates ${String(keyName)}`)
  if (new Set(values).size !== values.length) issue(issues, path, `duplicates ${String(valueName)}`)
}

function validateUniqueStrings(
  values: string[],
  path: string,
  issues: CanvasValidationIssue[],
): void {
  if (new Set(values).size !== values.length) issue(issues, path, 'must contain unique values')
}

function addUniqueId(
  id: string,
  path: string,
  allIds: Set<string>,
  typedIds: Set<string>,
  issues: CanvasValidationIssue[],
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
  issues: CanvasValidationIssue[],
): void {
  if (!isRecord(value) || (value.kind !== 'node' && value.kind !== 'task')) {
    issue(issues, path, 'must be a node or task reference')
    return
  }
  if (value.kind === 'task' && !isExactRecord(value, ['kind', 'id'])) {
    issue(issues, path, 'task endpoints cannot name a port')
    return
  }
  if (value.kind === 'node'
    && !isExactRecord(value, value.port === undefined ? ['kind', 'id'] : ['kind', 'id', 'port'])) {
    issue(issues, path, 'node endpoint has an invalid shape')
    return
  }
  validateId(value.id, `${path}.id`, issues)
  if (value.kind === 'node' && value.port !== undefined) {
    if (typeof value.port !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.port)
      || value.port.length > 120) issue(issues, `${path}.port`, 'is invalid')
  }
}

function validateBounds(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (!isExactRecord(value, ['w', 'h'])) {
    issue(issues, path, 'has an invalid shape')
    return
  }
  validatePositive(value.w, `${path}.w`, issues)
  validatePositive(value.h, `${path}.h`, issues)
}

function validateTransform(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (!isExactRecord(value, ['matrix'])
    || !Array.isArray(value.matrix)
    || value.matrix.length !== 6) {
    issue(issues, path, 'must contain one affine matrix')
    return
  }
  value.matrix.forEach((entry, index) => validateFinite(entry, `${path}.matrix[${index}]`, issues))
  const [a, b, c, d] = value.matrix
  if ([a, b, c, d].every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    && Math.abs((a as number) * (d as number) - (b as number) * (c as number)) < 1e-12) {
    issue(issues, `${path}.matrix`, 'must be invertible')
  }
}

function validateNodeTypeRef(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (!isExactRecord(value, ['id', 'revision', 'digest'])) {
    issue(issues, path, 'has an invalid shape')
    return
  }
  if (typeof value.id !== 'string'
    || value.id.length === 0
    || value.id.length > 160
    || !TYPE_PATTERN.test(value.id)
    || value.id.includes('..')
    || value.id.includes('//')) issue(issues, `${path}.id`, 'is invalid')
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    issue(issues, `${path}.revision`, 'must be a positive safe integer')
  }
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    issue(issues, `${path}.digest`, 'is invalid')
  }
}

function validateOrderKey(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || !/^[0-9A-Za-z._~-]+$/u.test(value)) issue(issues, path, 'is invalid')
}

function validateCoordinateSpace(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (!isRecordWithOnly(value, ['unit', 'dpi'])
    || !['px', 'pt', 'in', 'normalized'].includes(String(value.unit))) {
    issue(issues, path, 'is invalid')
    return
  }
  if (value.dpi !== undefined) validatePositive(value.dpi, `${path}.dpi`, issues)
}

function validateInstanceRef(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (!isExactRecord(value, ['definitionId', 'revision', 'digest'])) {
    issue(issues, path, 'is invalid')
    return
  }
  validateId(value.definitionId, `${path}.definitionId`, issues)
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    issue(issues, `${path}.revision`, 'must be a positive safe integer')
  }
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    issue(issues, `${path}.digest`, 'is invalid')
  }
}

function validatePoint(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
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
  issues: CanvasValidationIssue[],
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
  issues: CanvasValidationIssue[],
): void {
  if (typeof value !== 'string' || !PLAN_ID_PATTERN.test(value)) issue(issues, path, 'is invalid')
}

function validateString(
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty: boolean,
  issues: CanvasValidationIssue[],
): void {
  if (typeof value !== 'string'
    || value.length > maxLength
    || (!allowEmpty && value.length === 0)) issue(issues, path, 'is invalid')
}

function validateFinite(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) issue(issues, path, 'must be finite')
}

function validatePositive(value: unknown, path: string, issues: CanvasValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    issue(issues, path, 'must be positive and finite')
  }
}

function validateJsonValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: WeakSet<object>,
  issues: CanvasValidationIssue[],
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

function issue(issues: CanvasValidationIssue[], path: string, message: string): void {
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
