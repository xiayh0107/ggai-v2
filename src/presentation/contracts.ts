import type { CanvasArtifactRef, CanvasNodeTypeRef } from '../canvas/model.js'

export type PresentationExportMode = 'hybrid' | 'editable' | 'fidelity'

export interface PresentationExportDiagnostic {
  code: 'missing-font' | 'raster-fallback' | 'unsupported-editable-node' | 'invalid-native-data'
  nodeId?: string
  message: string
}

export interface PresentationProvenanceManifest {
  schemaVersion: 1
  exporter: { id: 'ggai-pptx'; version: '1' }
  projectId: string
  canvasBranch: string
  canvasRevision: number
  presentationNodeId: string
  mode: PresentationExportMode
  nodes: Array<{
    nodeId: string
    typeRef: CanvasNodeTypeRef
    artifactRefs: CanvasArtifactRef[]
  }>
}

export interface PresentationExportResponse {
  runId: string
  pptx: CanvasArtifactRef
  diagnostics: CanvasArtifactRef
  provenance: CanvasArtifactRef
  diagnosticCount: number
}
