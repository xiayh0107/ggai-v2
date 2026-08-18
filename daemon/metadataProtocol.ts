import type { NodeExecution, ValueRef } from '../src/execution/contracts.js'

export const METADATA_SCHEMA_VERSION = 3 as const
export const MINIMUM_SQLITE_VERSION = '3.51.3'

export interface MetadataDiagnostics {
  schemaVersion: typeof METADATA_SCHEMA_VERSION
  sqliteVersion: string
  journalMode: 'wal'
  integrity: 'ok'
}

export type MetadataWorkerOperation =
  | { operation: 'initialize' }
  | { operation: 'diagnostics' }
  | { operation: 'backup'; destination: string }
  | { operation: 'execution-create'; execution: NodeExecution }
  | { operation: 'execution-get'; executionId: string }
  | {
      operation: 'execution-list'
      projectId: string
      canvasBranch: string
      nodeId: string
      limit: number
    }
  | { operation: 'execution-find-cache'; projectId: string; canvasBranch: string; nodeId: string; cacheKey: string }
  | {
      operation: 'execution-complete'
      executionId: string
      status: 'succeeded' | 'failed' | 'cancelled' | 'timed-out'
      outputs: Record<string, ValueRef[]>
      finishedAt: string
      error?: { code: string; message: string }
    }
  | { operation: 'execution-mark-running'; executionId: string }
  | {
      operation: 'compute-approval-check'
      projectId: string
      nodeId: string
      codeDigest: string
      environmentDigest: string
    }
  | {
      operation: 'compute-approval-grant'
      projectId: string
      nodeId: string
      codeDigest: string
      environmentDigest: string
      approvedAt: string
    }
  | { operation: 'provenance-append'; records: ProvenanceRecord[] }
  | { operation: 'provenance-query'; projectId: string; identity: string; limit: number }
  | { operation: 'close' }

export type MetadataWorkerRequest = MetadataWorkerOperation & { id: number }

export type MetadataWorkerResult =
  | MetadataDiagnostics
  | { destination: string; pages: number }
  | NodeExecution
  | NodeExecution[]
  | ProvenanceRecord[]
  | boolean
  | null

export interface ProvenanceRecord {
  projectId: string
  relationKind: 'used' | 'was-generated-by' | 'was-derived-from' | 'was-associated-with' | 'had-plan'
  subjectId: string
  objectId: string
  attributes: Record<string, unknown>
}

export type MetadataWorkerResponse =
  | { id: number; ok: true; result: MetadataWorkerResult }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } }
