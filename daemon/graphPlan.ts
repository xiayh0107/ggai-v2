import { createHash } from 'node:crypto'
import type { GraphProposal } from '../src/agent/graphProposal.js'
import { canvasOrderKey, type CanvasEdge, type CanvasNode, type CanvasPoint } from '../src/canvas/model.js'
import type { NodeTypeSnapshot, PortDefinition } from '../src/plugins/nodeTypeContracts.js'
import { createBuiltinPayloadSchemaRegistry } from './builtinPayloadSchemas.js'
import { snapshotNodeTypeDefinition } from './nodeTypeSnapshots.js'

export const GRAPH_MATERIALIZATION_PLAN_SCHEMA_VERSION = 1 as const

export interface GraphMaterializationPlan {
  schemaVersion: typeof GRAPH_MATERIALIZATION_PLAN_SCHEMA_VERSION
  planId: string
  runId: string
  taskId: string
  nodes: Array<{ logicalKey: string; node: CanvasNode }>
  edges: CanvasEdge[]
  nodeTypes: NodeTypeSnapshot[]
  digest: string
}

export type GraphPlanInspection =
  | { status: 'valid'; plan: GraphMaterializationPlan }
  | { status: 'invalid'; reason: string }

export function buildGraphMaterializationPlan(input: {
  taskId: string
  runId: string
  taskAnchor: CanvasPoint
  proposal: GraphProposal
  nodeTypes: readonly NodeTypeSnapshot[]
  allowedRootIds: ReadonlySet<string>
}): GraphMaterializationPlan {
  const types = canonicalNodeTypes(input.nodeTypes)
  const typesById = new Map(types.map((type) => [type.id, type]))
  validateParentGraph(input.proposal, typesById)
  validateDataGraph(input.proposal, typesById)
  const payloadSchemas = createBuiltinPayloadSchemaRegistry()
  const planId = `plan_${createHash('sha256')
    .update(input.taskId, 'utf8').update('\0').update(input.runId, 'utf8').digest('hex')}`
  const idByKey = new Map(input.proposal.nodes.map((node) => [
    node.key,
    reservedId('node', planId, node.key),
  ]))
  const childIndex = new Map<string, number>()
  const rootNodes = input.proposal.nodes.filter((node) => node.parentKey === undefined)
  const rootIndex = new Map(rootNodes.map((node, index) => [node.key, index]))
  const nodes = input.proposal.nodes.map((proposalNode) => {
    const type = typesById.get(proposalNode.typeId)
    if (!type || !type.agent.constructible || !type.agent.writableInitSchema
      || type.agent.writableInitSchema === 'ggai://schema/payload/open') {
      throw new TypeError(`graph node type is not Agent-constructible: ${proposalNode.typeId}`)
    }
    const payload = { ...structuredClone(type.initialPayload), ...structuredClone(proposalNode.init) }
    const validation = payloadSchemas.validate(type.agent.writableInitSchema, payload)
    if (!validation.valid) throw new TypeError(`graph node init does not match ${type.agent.writableInitSchema}`)
    const rootId = payload.rootId
    if (typeof rootId === 'string' && !input.allowedRootIds.has(rootId)) {
      throw new TypeError('graph node references an unauthorized resource handle')
    }
    const parentId = proposalNode.parentKey ? idByKey.get(proposalNode.parentKey)! : null
    const sibling = proposalNode.parentKey
      ? childIndex.get(proposalNode.parentKey) ?? 0
      : rootIndex.get(proposalNode.key) ?? 0
    if (proposalNode.parentKey) childIndex.set(proposalNode.parentKey, sibling + 1)
    const rootColumn = sibling % 3
    const rootRow = Math.floor(sibling / 3)
    const node: CanvasNode = {
      id: idByKey.get(proposalNode.key)!,
      typeRef: { id: type.id, revision: type.revision, digest: type.digest },
      parentId,
      orderKey: canvasOrderKey(sibling),
      bounds: { w: type.defaultWidth, h: 200 },
      transform: {
        matrix: proposalNode.parentKey
          ? [1, 0, 0, 1, 24, 56 + sibling * 224]
          : [
              1, 0, 0, 1,
              input.taskAnchor.x + 420 + rootColumn * 520,
              input.taskAnchor.y + rootRow * 280,
            ],
      },
      title: proposalNode.title,
      payload,
      artifactRefs: [],
      ...(proposalNode.parentKey ? {} : { homeTaskId: input.taskId }),
      origin: {
        kind: 'agent-output',
        taskId: input.taskId,
        runId: input.runId,
        planId,
        outputKey: proposalNode.key,
      },
    }
    return { logicalKey: proposalNode.key, node }
  })
  const edges = input.proposal.edges.map((edge, index): CanvasEdge => ({
    id: reservedId('edge', planId, String(index), edge.fromKey, edge.fromPort, edge.toKey, edge.toPort),
    from: { kind: 'node', id: idByKey.get(edge.fromKey)!, port: edge.fromPort },
    to: { kind: 'node', id: idByKey.get(edge.toKey)!, port: edge.toPort },
    relation: 'data',
    contextRole: 'none',
    orderKey: canvasOrderKey(index),
    origin: { kind: 'agent', runId: input.runId, planId },
  }))
  const usedTypeIds = new Set(input.proposal.nodes.map((node) => node.typeId))
  const nodeTypes = types.filter((type) => usedTypeIds.has(type.id))
  const unsigned = {
    schemaVersion: GRAPH_MATERIALIZATION_PLAN_SCHEMA_VERSION,
    planId,
    runId: input.runId,
    taskId: input.taskId,
    nodes,
    edges,
    nodeTypes,
  }
  return {
    ...unsigned,
    digest: digestJson('ggai.graph-materialization-plan.v1', unsigned),
  }
}

export function inspectGraphMaterializationPlan(value: unknown): GraphPlanInspection {
  if (!isRecord(value) || !exactKeys(value, [
    'digest', 'edges', 'nodeTypes', 'nodes', 'planId', 'runId', 'schemaVersion', 'taskId',
  ]) || value.schemaVersion !== GRAPH_MATERIALIZATION_PLAN_SCHEMA_VERSION
    || typeof value.planId !== 'string' || typeof value.runId !== 'string'
    || typeof value.taskId !== 'string' || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges) || !Array.isArray(value.nodeTypes)
    || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    return invalid('graph materialization plan envelope is invalid')
  }
  const unsigned = {
    schemaVersion: value.schemaVersion,
    planId: value.planId,
    runId: value.runId,
    taskId: value.taskId,
    nodes: value.nodes,
    edges: value.edges,
    nodeTypes: value.nodeTypes,
  }
  if (value.digest !== digestJson('ggai.graph-materialization-plan.v1', unsigned)) {
    return invalid('graph materialization plan digest does not match')
  }
  try {
    const plan = structuredClone(value) as unknown as GraphMaterializationPlan
    const types = canonicalNodeTypes(plan.nodeTypes)
    const typesById = new Map(types.map((type) => [type.id, type]))
    if (plan.nodes.length < 1 || plan.nodes.length > 256 || plan.edges.length > 512
      || new Set(plan.nodes.map((entry) => entry.logicalKey)).size !== plan.nodes.length
      || new Set(plan.nodes.map((entry) => entry.node.id)).size !== plan.nodes.length
      || plan.nodes.some((entry) => entry.node.origin.kind !== 'agent-output'
        || entry.node.origin.planId !== plan.planId || entry.node.origin.runId !== plan.runId)
      || plan.edges.some((edge) => edge.origin.kind !== 'agent'
        || edge.origin.planId !== plan.planId || edge.origin.runId !== plan.runId)) {
      return invalid('graph materialization plan contents are invalid')
    }
    const keyByNodeId = new Map(plan.nodes.map((entry) => [entry.node.id, entry.logicalKey]))
    const proposal: GraphProposal = {
      nodes: plan.nodes.map((entry) => {
        const parentKey = entry.node.parentId ? keyByNodeId.get(entry.node.parentId) : undefined
        if (entry.node.parentId && !parentKey) throw new TypeError('graph plan parent is invalid')
        return {
          key: entry.logicalKey,
          typeId: entry.node.typeRef.id,
          title: entry.node.title,
          ...(parentKey ? { parentKey } : {}),
          init: structuredClone(entry.node.payload ?? {}),
        }
      }),
      edges: plan.edges.map((edge) => {
        if (edge.from.kind !== 'node' || edge.to.kind !== 'node'
          || !edge.from.port || !edge.to.port
          || !keyByNodeId.has(edge.from.id) || !keyByNodeId.has(edge.to.id)) {
          throw new TypeError('graph plan edge endpoint is invalid')
        }
        return {
          fromKey: keyByNodeId.get(edge.from.id)!, fromPort: edge.from.port,
          toKey: keyByNodeId.get(edge.to.id)!, toPort: edge.to.port,
        }
      }),
    }
    validateParentGraph(proposal, typesById)
    validateDataGraph(proposal, typesById)
    const schemas = createBuiltinPayloadSchemaRegistry()
    for (const entry of plan.nodes) {
      const type = typesById.get(entry.node.typeRef.id)
      if (!type || type.revision !== entry.node.typeRef.revision
        || type.digest !== entry.node.typeRef.digest || !type.agent.writableInitSchema
        || !schemas.validate(type.agent.writableInitSchema, entry.node.payload ?? {}).valid) {
        throw new TypeError('graph plan node type or payload is invalid')
      }
    }
    return { status: 'valid', plan }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'graph materialization plan is invalid')
  }
}

function validateParentGraph(
  proposal: GraphProposal,
  types: ReadonlyMap<string, NodeTypeSnapshot>,
): void {
  const byKey = new Map(proposal.nodes.map((node) => [node.key, node]))
  for (const node of proposal.nodes) {
    const type = types.get(node.typeId)
    if (!type) throw new TypeError(`graph proposal names an unknown node type: ${node.typeId}`)
    if (!node.parentKey) continue
    const parent = byKey.get(node.parentKey)!
    const parentType = types.get(parent.typeId)
    if (!parentType?.containment.canHaveChildren
      || (parentType.containment.allowedChildTypes.length > 0
        && !parentType.containment.allowedChildTypes.includes(node.typeId))) {
      throw new TypeError(`graph proposal violates containment policy: ${parent.typeId} -> ${node.typeId}`)
    }
  }
  for (const node of proposal.nodes) {
    const seen = new Set<string>()
    let cursor = node
    let depth = 0
    while (cursor.parentKey) {
      if (seen.has(cursor.key)) throw new TypeError('graph proposal parent relation contains a cycle')
      seen.add(cursor.key)
      depth += 1
      if (depth > 32) throw new TypeError('graph proposal exceeds maximum depth')
      cursor = byKey.get(cursor.parentKey)!
      const ancestorType = types.get(cursor.typeId)
      if (!ancestorType || depth > ancestorType.containment.maxDepth) {
        throw new TypeError('graph proposal exceeds node type containment depth')
      }
    }
  }
}

function validateDataGraph(
  proposal: GraphProposal,
  types: ReadonlyMap<string, NodeTypeSnapshot>,
): void {
  const nodes = new Map(proposal.nodes.map((node) => [node.key, node]))
  const incomingOne = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const edge of proposal.edges) {
    const fromNode = nodes.get(edge.fromKey)!
    const toNode = nodes.get(edge.toKey)!
    const from = requirePort(types.get(fromNode.typeId), edge.fromPort, 'output')
    const to = requirePort(types.get(toNode.typeId), edge.toPort, 'input')
    if (from.schema !== to.schema) throw new TypeError('graph proposal connects incompatible port schemas')
    const inputKey = `${edge.toKey}\0${edge.toPort}`
    if (to.cardinality === 'one' && incomingOne.has(inputKey)) {
      throw new TypeError('graph proposal exceeds one-input cardinality')
    }
    incomingOne.add(inputKey)
    const targets = adjacency.get(edge.fromKey) ?? []
    targets.push(edge.toKey)
    adjacency.set(edge.fromKey, targets)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new TypeError('graph proposal data edges contain a cycle')
    if (visited.has(key)) return
    visiting.add(key)
    for (const target of adjacency.get(key) ?? []) visit(target)
    visiting.delete(key)
    visited.add(key)
  }
  for (const node of proposal.nodes) visit(node.key)
}

function requirePort(
  type: NodeTypeSnapshot | undefined,
  key: string,
  direction: PortDefinition['direction'],
): PortDefinition {
  const port = type?.ports.find((candidate) => candidate.key === key && candidate.direction === direction)
  if (!port) throw new TypeError(`graph proposal references an unknown ${direction} port`)
  return port
}

function canonicalNodeTypes(types: readonly NodeTypeSnapshot[]): NodeTypeSnapshot[] {
  const snapshots = types.map((type) => {
    const { digest, ...definition } = type
    const snapshot = snapshotNodeTypeDefinition(definition)
    if (snapshot.digest !== digest) throw new TypeError(`node type snapshot digest mismatch: ${type.id}`)
    return snapshot
  })
  if (new Set(snapshots.map((type) => type.id)).size !== snapshots.length) {
    throw new TypeError('node type snapshots contain duplicate ids')
  }
  return snapshots.sort((left, right) => left.id.localeCompare(right.id))
}

function reservedId(kind: 'node' | 'edge', ...parts: string[]): string {
  return `canvas_${kind}_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`
}

function digestJson(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\0`).update(JSON.stringify(value)).digest('hex')
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join('\0') === expected.sort().join('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(reason: string): GraphPlanInspection {
  return { status: 'invalid', reason }
}
