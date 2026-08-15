import type { SuggestedAction } from './suggestedActions'

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
  warnings: string[]
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
