import type { CanvasNode } from '../canvas/model.js'

export const PDF_PLAN_SCHEMA_VERSION = 1 as const
export const MAX_PDF_BYTES = 64 * 1024 * 1024
export const MAX_PDF_PAGES = 10_000

export interface PdfMaterializationPlan {
  schemaVersion: typeof PDF_PLAN_SCHEMA_VERSION
  planId: string
  importId: string
  kind: 'document' | 'decomposition'
  projectId: string
  canvasBranch: string
  taskId: string
  sourceRunId: string
  activityRunId: string
  sourceArtifactId: string
  sourcePdfDigest: string
  documentNodeId: string
  nodes: Array<{ logicalKey: string; node: CanvasNode }>
  digest: string
}

export interface PdfImportRecord {
  importId: string
  projectId: string
  canvasBranch: string
  taskId: string
  sourceRunId: string
  sourceArtifactId: string
  sourcePdfDigest: string
  pageCount: number
  metadata: Record<string, string | null>
  documentNodeId: string
  initialPlanId: string
  createdAt: string
}

export interface PdfPageBaseline {
  importId: string
  pageNumber: number
  viewport: { width: number; height: number; rotation: number; unit: 'pt' }
  text: { itemCount: number; summary: string }
  annotations: { count: number; subtypes: string[] }
  preview: { runId: string; artifactId: string }
}
