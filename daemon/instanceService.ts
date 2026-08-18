import { createHash } from 'node:crypto'
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasNode,
} from '../src/canvas/model.js'
import { canvasOrderKey } from '../src/canvas/model.js'
import type {
  InstanceUpdatePreview,
  NodeTreeDefinition,
  NodeTreeDefinitionEdge,
  NodeTreeDefinitionNode,
  NodeTreeExposedPort,
} from '../src/instances/contracts.js'
import type { NodeTypeSnapshot } from '../src/plugins/nodeTypeContracts.js'
import { NodeTreeCatalog } from './nodeTreeCatalog.js'

export class InstanceServiceError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'InstanceServiceError'
    this.code = code
    this.status = status
  }
}

export interface DetachInstanceExpansion {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  edgePatches: Array<{ edgeId: string; from?: CanvasEdge['from']; to?: CanvasEdge['to'] }>
}

export class InstanceService {
  readonly catalog: NodeTreeCatalog
  readonly #nodeTypes: () => Promise<NodeTypeSnapshot[]>

  constructor(catalog: NodeTreeCatalog, nodeTypes: () => Promise<NodeTypeSnapshot[]>) {
    this.catalog = catalog
    this.#nodeTypes = nodeTypes
  }

  async capture(input: {
    document: CanvasDocument
    rootNodeId: string
    definitionId: string
    title: string
    expectedRevision: number
    overrideAllowlist: Array<{ nodeId: string; field: string }>
    exposedPorts: Array<{
      key: string
      nodeId: string
      port: string
      direction: 'input' | 'output'
      schema: string
    }>
  }): Promise<NodeTreeDefinition> {
    const root = input.document.nodes.find((node) => node.id === input.rootNodeId)
    if (!root) throw new InstanceServiceError('instance_source_not_found', 'Source node tree does not exist', 404)
    if (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 240) {
      throw new InstanceServiceError('invalid_definition_title', 'Definition title is invalid', 400)
    }
    const sourceNodes = collectSubtree(input.document, root.id)
    const keyById = new Map(sourceNodes.map((node, index) => [
      node.id,
      node.id === root.id ? 'root' : `node-${String(index).padStart(4, '0')}`,
    ]))
    const nodes: NodeTreeDefinitionNode[] = sourceNodes.map((node) => ({
      key: keyById.get(node.id)!,
      typeRef: structuredClone(node.typeRef),
      parentKey: node.parentId && keyById.has(node.parentId) ? keyById.get(node.parentId)! : null,
      orderKey: node.id === root.id ? canvasOrderKey(0) : node.orderKey,
      bounds: structuredClone(node.bounds),
      transform: node.id === root.id
        ? { matrix: [1, 0, 0, 1, 0, 0] }
        : structuredClone(node.transform),
      ...(node.coordinateSpace ? { coordinateSpace: structuredClone(node.coordinateSpace) } : {}),
      title: node.title,
      ...(node.text === undefined ? {} : { text: node.text }),
      ...(node.payload === undefined ? {} : { payload: structuredClone(node.payload) }),
      artifactRefs: structuredClone(node.artifactRefs),
      ...(node.instanceRef ? { instanceRef: structuredClone(node.instanceRef) } : {}),
    }))
    const edges: NodeTreeDefinitionEdge[] = input.document.edges
      .filter((edge) => edge.from.kind === 'node' && edge.to.kind === 'node'
        && keyById.has(edge.from.id) && keyById.has(edge.to.id))
      .map((edge, index) => {
        if (edge.from.kind !== 'node' || edge.to.kind !== 'node') {
          throw new Error('Filtered instance edge changed type')
        }
        return {
        key: `edge-${String(index).padStart(4, '0')}`,
        from: {
          nodeKey: keyById.get(edge.from.id)!,
          ...(edge.from.port ? { port: edge.from.port } : {}),
        },
        to: {
          nodeKey: keyById.get(edge.to.id)!,
          ...(edge.to.port ? { port: edge.to.port } : {}),
        },
        relation: edge.relation,
        contextRole: edge.contextRole,
        ...(edge.orderKey ? { orderKey: edge.orderKey } : {}),
        }
      })
    const overrideAllowlist = input.overrideAllowlist.map((entry) => {
      const nodeKey = keyById.get(entry.nodeId)
      if (!nodeKey || !/^(?:title|text|payload\.[A-Za-z0-9][A-Za-z0-9._:-]*)$/u.test(entry.field)) {
        throw new InstanceServiceError('invalid_override_allowlist', 'Override allowlist entry is invalid', 400)
      }
      return `${nodeKey}:${entry.field}`
    }).sort()
    if (new Set(overrideAllowlist).size !== overrideAllowlist.length) {
      throw new InstanceServiceError('invalid_override_allowlist', 'Override allowlist is duplicated', 400)
    }
    const nodeTypes = new Map((await this.#nodeTypes()).map((type) => [type.id, type]))
    const exposedPorts: NodeTreeExposedPort[] = input.exposedPorts.map((entry) => {
      const node = sourceNodes.find((candidate) => candidate.id === entry.nodeId)
      const nodeKey = keyById.get(entry.nodeId)
      const port = nodeTypes.get(node?.typeRef.id ?? '')?.ports.find((candidate) =>
        candidate.key === entry.port && candidate.direction === entry.direction)
      if (!nodeKey || !port || port.schema !== entry.schema) {
        throw new InstanceServiceError('invalid_exposed_port', 'Exposed port does not match a pinned NodeType', 400)
      }
      return {
        key: entry.key,
        nodeKey,
        port: entry.port,
        direction: entry.direction,
        schema: entry.schema,
      }
    })
    await this.#assertNoDefinitionCycle(input.definitionId, nodes)
    return this.catalog.append({
      definitionId: input.definitionId,
      expectedRevision: input.expectedRevision,
      title: input.title.trim(),
      rootKey: 'root',
      nodes,
      edges,
      overrideAllowlist,
      exposedPorts,
    })
  }

  async createInstanceNode(input: {
    nodeId: string
    definitionId: string
    revision: number
    title?: string
    overrides: Record<string, unknown>
    x: number
    y: number
    homeTaskId?: string
    collectionId?: string
  }): Promise<CanvasNode> {
    const definition = await this.#definition(input.definitionId, input.revision)
    validateOverrides(definition, input.overrides)
    const instanceType = (await this.#nodeTypes()).find((type) => type.id === 'instance')
    if (!instanceType) throw new Error('Instance NodeType is unavailable')
    const root = definition.nodes.find((node) => node.key === definition.rootKey)!
    return {
      id: input.nodeId,
      typeRef: { id: instanceType.id, revision: instanceType.revision, digest: instanceType.digest },
      parentId: null,
      orderKey: canvasOrderKey(0),
      bounds: structuredClone(root.bounds),
      transform: { matrix: [1, 0, 0, 1, input.x, input.y] },
      title: input.title?.trim() || definition.title,
      payload: { overrides: structuredClone(input.overrides) },
      artifactRefs: [],
      instanceRef: {
        definitionId: definition.definitionId,
        revision: definition.revision,
        digest: definition.digest,
      },
      ...(input.homeTaskId ? { homeTaskId: input.homeTaskId } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      origin: { kind: 'user' },
    }
  }

  async resolveDocument(document: CanvasDocument): Promise<CanvasDocument> {
    let resolved = structuredClone(document)
    for (const instance of document.nodes.filter((node) => node.instanceRef)) {
      if (!resolved.nodes.some((node) => node.id === instance.id && node.instanceRef)) continue
      const expansion = await this.detachExpansion(resolved, instance.id)
      resolved = applyExpansion(resolved, instance.id, expansion)
    }
    return resolved
  }

  async resolveInstance(document: CanvasDocument, nodeId: string) {
    const expansion = await this.detachExpansion(document, nodeId)
    return {
      nodes: expansion.nodes,
      edges: expansion.edges,
      edgePatches: expansion.edgePatches,
    }
  }

  async detachExpansion(document: CanvasDocument, nodeId: string): Promise<DetachInstanceExpansion> {
    const instance = document.nodes.find((node) => node.id === nodeId)
    if (!instance?.instanceRef) {
      throw new InstanceServiceError('instance_not_found', 'Instance node does not exist', 404)
    }
    const definition = await this.#definition(
      instance.instanceRef.definitionId,
      instance.instanceRef.revision,
      instance.instanceRef.digest,
    )
    const overrides = instanceOverrides(instance)
    validateOverrides(definition, overrides)
    const expanded = await this.#expandDefinition(definition, instance, overrides, [])
    const endpointByPort = new Map(definition.exposedPorts.map((port) => [
      `${port.direction}:${port.key}`,
      { kind: 'node' as const, id: expanded.idByKey.get(port.nodeKey)!, port: port.port },
    ]))
    const edgePatches = document.edges.flatMap((edge) => {
      const patch: { edgeId: string; from?: CanvasEdge['from']; to?: CanvasEdge['to'] } = {
        edgeId: edge.id,
      }
      if (edge.from.kind === 'node' && edge.from.id === instance.id && edge.from.port) {
        patch.from = endpointByPort.get(`output:${edge.from.port}`) ?? edge.from
      }
      if (edge.to.kind === 'node' && edge.to.id === instance.id && edge.to.port) {
        patch.to = endpointByPort.get(`input:${edge.to.port}`) ?? edge.to
      }
      return patch.from || patch.to ? [patch] : []
    })
    return { nodes: expanded.nodes, edges: expanded.edges, edgePatches }
  }

  async previewUpdate(
    node: CanvasNode,
    targetRevision: number,
  ): Promise<InstanceUpdatePreview> {
    if (!node.instanceRef) throw new InstanceServiceError('instance_not_found', 'Node is not an instance', 404)
    const current = await this.#definition(
      node.instanceRef.definitionId, node.instanceRef.revision, node.instanceRef.digest,
    )
    const target = await this.#definition(node.instanceRef.definitionId, targetRevision)
    const overrideKeys = Object.keys(instanceOverrides(node))
    const targetOverrides = new Set(target.overrideAllowlist)
    const targetPorts = new Set(target.exposedPorts.map((port) => `${port.direction}:${port.key}`))
    return {
      nodeId: node.id,
      current: ref(current),
      target: ref(target),
      conflicts: [
        ...overrideKeys.filter((key) => !targetOverrides.has(key))
          .map((key) => ({ code: 'override-removed' as const, key })),
        ...current.exposedPorts
          .map((port) => `${port.direction}:${port.key}`)
          .filter((key) => !targetPorts.has(key))
          .map((key) => ({ code: 'exposed-port-removed' as const, key })),
      ],
    }
  }

  async updateInstanceNode(node: CanvasNode, targetRevision: number): Promise<CanvasNode> {
    const preview = await this.previewUpdate(node, targetRevision)
    if (preview.conflicts.length > 0) {
      throw new InstanceServiceError('instance_update_conflict', 'Instance update has override or port conflicts')
    }
    return {
      ...structuredClone(node),
      instanceRef: structuredClone(preview.target),
    }
  }

  async #expandDefinition(
    definition: NodeTreeDefinition,
    instance: CanvasNode,
    overrides: Record<string, unknown>,
    stack: string[],
  ): Promise<{
    nodes: CanvasNode[]
    edges: CanvasEdge[]
    idByKey: Map<string, string>
  }> {
    const identity = `${definition.definitionId}@${definition.revision}`
    if (stack.includes(identity)) throw new InstanceServiceError('instance_cycle', 'Nested instance cycle detected')
    if (stack.length >= 32) throw new InstanceServiceError('instance_depth', 'Nested instance depth exceeds 32')
    const idByKey = new Map(definition.nodes.map((node) => [
      node.key,
      node.key === definition.rootKey ? instance.id : reservedNodeId(instance.id, identity, node.key),
    ]))
    const nodes: CanvasNode[] = []
    const edges: CanvasEdge[] = []
    for (const template of definition.nodes) {
      const base = templateNode(template, idByKey, instance, definition.rootKey)
      applyOverrides(base, template.key, overrides)
      if (template.instanceRef) {
        const nestedDefinition = await this.#definition(
          template.instanceRef.definitionId,
          template.instanceRef.revision,
          template.instanceRef.digest,
        )
        const nested = await this.#expandDefinition(
          nestedDefinition,
          { ...base, instanceRef: template.instanceRef },
          template.payload && isRecord(template.payload.overrides)
            ? template.payload.overrides : {},
          [...stack, identity],
        )
        nodes.push(...nested.nodes)
        edges.push(...nested.edges)
      } else {
        nodes.push(base)
      }
    }
    for (const edge of definition.edges) {
      edges.push({
        id: reservedEdgeId(instance.id, identity, edge.key),
        from: {
          kind: 'node', id: idByKey.get(edge.from.nodeKey)!,
          ...(edge.from.port ? { port: edge.from.port } : {}),
        },
        to: {
          kind: 'node', id: idByKey.get(edge.to.nodeKey)!,
          ...(edge.to.port ? { port: edge.to.port } : {}),
        },
        relation: edge.relation,
        contextRole: edge.contextRole,
        ...(edge.orderKey ? { orderKey: edge.orderKey } : {}),
        origin: { kind: 'user' },
      })
    }
    return { nodes, edges, idByKey }
  }

  async #definition(id: string, revision: number, digest?: string): Promise<NodeTreeDefinition> {
    const definition = await this.catalog.get(id, revision)
    if (!definition || (digest !== undefined && definition.digest !== digest)) {
      throw new InstanceServiceError('definition_not_found', 'Pinned NodeTreeDefinition does not exist', 404)
    }
    return definition
  }

  async #assertNoDefinitionCycle(definitionId: string, nodes: NodeTreeDefinitionNode[]): Promise<void> {
    const visit = async (id: string, revision: number, stack: string[]): Promise<void> => {
      if (id === definitionId || stack.includes(id)) {
        throw new InstanceServiceError('definition_cycle', 'NodeTreeDefinition cycle detected', 400)
      }
      const definition = await this.catalog.get(id, revision)
      if (!definition) throw new InstanceServiceError('definition_not_found', 'Nested definition does not exist', 400)
      for (const node of definition.nodes) {
        if (node.instanceRef) await visit(
          node.instanceRef.definitionId, node.instanceRef.revision, [...stack, id],
        )
      }
    }
    for (const node of nodes) {
      if (node.instanceRef) await visit(node.instanceRef.definitionId, node.instanceRef.revision, [])
    }
  }
}

function collectSubtree(document: CanvasDocument, rootId: string): CanvasNode[] {
  const result: CanvasNode[] = []
  const visit = (parentId: string) => {
    const node = document.nodes.find((candidate) => candidate.id === parentId)
    if (node) result.push(node)
    document.nodes.filter((candidate) => candidate.parentId === parentId)
      .sort((left, right) => left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id))
      .forEach((child) => visit(child.id))
  }
  visit(rootId)
  return result
}

function templateNode(
  template: NodeTreeDefinitionNode,
  idByKey: Map<string, string>,
  instance: CanvasNode,
  rootKey: string,
): CanvasNode {
  const root = template.key === rootKey
  return {
    id: idByKey.get(template.key)!,
    typeRef: structuredClone(template.typeRef),
    parentId: root
      ? instance.parentId
      : template.parentKey ? idByKey.get(template.parentKey)! : instance.id,
    orderKey: root ? instance.orderKey : template.orderKey,
    bounds: root ? structuredClone(instance.bounds) : structuredClone(template.bounds),
    transform: root ? structuredClone(instance.transform) : structuredClone(template.transform),
    ...(template.coordinateSpace ? { coordinateSpace: structuredClone(template.coordinateSpace) } : {}),
    title: template.title,
    ...(template.text === undefined ? {} : { text: template.text }),
    ...(template.payload === undefined ? {} : { payload: structuredClone(template.payload) }),
    artifactRefs: structuredClone(template.artifactRefs),
    ...(root && instance.homeTaskId ? { homeTaskId: instance.homeTaskId } : {}),
    ...(root && instance.collectionId ? { collectionId: instance.collectionId } : {}),
    origin: root ? { kind: 'user' } : { kind: 'copied', sourceNodeId: instance.id },
  }
}

function validateOverrides(definition: NodeTreeDefinition, overrides: Record<string, unknown>): void {
  const allowed = new Set(definition.overrideAllowlist)
  if (Object.keys(overrides).some((key) => !allowed.has(key))) {
    throw new InstanceServiceError('instance_override_denied', 'Instance override is not allowlisted', 400)
  }
}

function instanceOverrides(node: CanvasNode): Record<string, unknown> {
  if (!node.payload || !isRecord(node.payload.overrides)
    || Object.keys(node.payload).some((key) => key !== 'overrides')) {
    throw new InstanceServiceError('invalid_instance_payload', 'Instance payload must contain only overrides', 400)
  }
  return structuredClone(node.payload.overrides)
}

function applyOverrides(node: CanvasNode, nodeKey: string, overrides: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(overrides)) {
    const prefix = `${nodeKey}:`
    if (!key.startsWith(prefix)) continue
    const field = key.slice(prefix.length)
    if (field === 'title' && typeof value === 'string') node.title = value
    else if (field === 'text' && (typeof value === 'string' || value === null)) {
      if (value === null) delete node.text
      else node.text = value
    } else if (field.startsWith('payload.')) {
      const payloadKey = field.slice('payload.'.length)
      node.payload = { ...(node.payload ?? {}), [payloadKey]: structuredClone(value) }
    }
  }
}

function applyExpansion(
  document: CanvasDocument,
  instanceId: string,
  expansion: DetachInstanceExpansion,
): CanvasDocument {
  const next = structuredClone(document)
  next.nodes = next.nodes.filter((node) => node.id !== instanceId)
  next.nodes.push(...structuredClone(expansion.nodes))
  next.edges.push(...structuredClone(expansion.edges))
  for (const patch of expansion.edgePatches) {
    const edge = next.edges.find((candidate) => candidate.id === patch.edgeId)
    if (!edge) continue
    if (patch.from) edge.from = structuredClone(patch.from)
    if (patch.to) edge.to = structuredClone(patch.to)
  }
  return next
}

function ref(definition: NodeTreeDefinition) {
  return {
    definitionId: definition.definitionId,
    revision: definition.revision,
    digest: definition.digest,
  }
}

function reservedNodeId(...parts: string[]): string {
  return `canvas_node_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`
}

function reservedEdgeId(...parts: string[]): string {
  return `canvas_edge_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
