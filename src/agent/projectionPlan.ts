import type { SuggestedAction } from './suggestedActions'
import type { CanvasEdge, CanvasNode } from '@/canvas/model'
import type { NodeTypeSnapshot } from '@/plugins/nodeTypeContracts'

export interface DaemonProjectionArtifactRef {
  runId: string
  artifactId: string
}

export interface DaemonProjectionOutput {
  key: string
  pluginId: string
  role: 'primary' | 'supporting' | 'auxiliary'
  title: string
  artifactRefs: DaemonProjectionArtifactRef[]
  derivedFrom: string[]
  materialize: boolean
}

export interface DaemonProjectionTaskProposal {
  key: string
  title: string
  prompt: string
  inputOutputKeys: string[]
  dependsOn: string[]
}

export interface DaemonProjectionPlan {
  schemaVersion: 2
  planId: string
  runId: string
  taskId: string
  status: 'complete' | 'partial'
  manifestDigest: string
  outputs: DaemonProjectionOutput[]
  taskProposals: DaemonProjectionTaskProposal[]
  graphPlan?: DaemonGraphMaterializationPlan
  warnings: string[]
  digest: string
}

export interface DaemonGraphMaterializationPlan {
  schemaVersion: 1
  planId: string
  runId: string
  taskId: string
  nodes: Array<{ logicalKey: string; node: CanvasNode }>
  edges: CanvasEdge[]
  nodeTypes: NodeTypeSnapshot[]
  digest: string
}

export interface DaemonProjectionPlanQuery {
  projectDir?: string
  branch?: string
}

export interface DaemonPendingProjection {
  plan: DaemonProjectionPlan
  suggestedActions: SuggestedAction[]
}
