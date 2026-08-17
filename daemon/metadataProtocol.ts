export const METADATA_SCHEMA_VERSION = 1 as const
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
  | { operation: 'close' }

export type MetadataWorkerRequest = MetadataWorkerOperation & { id: number }

export type MetadataWorkerResult =
  | MetadataDiagnostics
  | { destination: string; pages: number }
  | null

export type MetadataWorkerResponse =
  | { id: number; ok: true; result: MetadataWorkerResult }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } }
