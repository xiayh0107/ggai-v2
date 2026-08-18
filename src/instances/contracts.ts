import type {
  CanvasArtifactRef,
  CanvasEdgeContextRole,
  CanvasEdgeRelation,
  CanvasNodeBounds,
  CanvasNodeTransform,
  CanvasNodeTypeRef,
} from '../canvas/model.js'

export const NODE_TREE_DEFINITION_SCHEMA_VERSION = 1 as const

export interface NodeTreeDefinitionNode {
  key: string
  typeRef: CanvasNodeTypeRef
  parentKey: string | null
  orderKey: string
  bounds: CanvasNodeBounds
  transform: CanvasNodeTransform
  coordinateSpace?: { unit: 'px' | 'pt' | 'in' | 'normalized'; dpi?: number }
  title: string
  text?: string
  payload?: Record<string, unknown>
  artifactRefs: CanvasArtifactRef[]
  instanceRef?: { definitionId: string; revision: number; digest: string }
}

export interface NodeTreeDefinitionEdge {
  key: string
  from: { nodeKey: string; port?: string }
  to: { nodeKey: string; port?: string }
  relation: CanvasEdgeRelation
  contextRole: CanvasEdgeContextRole
  orderKey?: string
}

export interface NodeTreeExposedPort {
  key: string
  nodeKey: string
  port: string
  direction: 'input' | 'output'
  schema: string
}

export interface NodeTreeDefinition {
  schemaVersion: typeof NODE_TREE_DEFINITION_SCHEMA_VERSION
  definitionId: string
  revision: number
  digest: string
  title: string
  rootKey: string
  nodes: NodeTreeDefinitionNode[]
  edges: NodeTreeDefinitionEdge[]
  overrideAllowlist: string[]
  exposedPorts: NodeTreeExposedPort[]
  createdAt: string
}

export interface NodeTreeInstanceOverrides {
  overrides: Record<string, string | number | boolean | null | Record<string, unknown>>
}

export interface InstanceUpdatePreview {
  nodeId: string
  current: { definitionId: string; revision: number; digest: string }
  target: { definitionId: string; revision: number; digest: string }
  conflicts: Array<{ code: 'override-removed' | 'exposed-port-removed'; key: string }>
}
