import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  METADATA_SCHEMA_VERSION,
  MINIMUM_SQLITE_VERSION,
  type MetadataDiagnostics,
  type MetadataWorkerRequest,
  type MetadataWorkerResponse,
  type MetadataWorkerResult,
  type ProvenanceRecord,
} from './metadataProtocol.js'
import {
  validateExecutionOutputs,
  type NodeExecution,
  type ValueRef,
} from '../src/execution/contracts.js'

interface MetadataWorkerData {
  databasePath: string
}

const port = requireParentPort()

const input = workerData as MetadataWorkerData
if (!input || typeof input.databasePath !== 'string' || input.databasePath.length === 0) {
  throw new TypeError('Metadata worker database path is invalid')
}

let database: DatabaseSync | null = null
let diagnostics: MetadataDiagnostics | null = null
let operationTail: Promise<void> = Promise.resolve()

port.on('message', (request: MetadataWorkerRequest) => {
  operationTail = operationTail.then(
    () => respond(request),
    () => respond(request),
  )
})

async function respond(request: MetadataWorkerRequest): Promise<void> {
  let response: MetadataWorkerResponse
  try {
    response = {
      id: request.id,
      ok: true,
      result: await execute(request),
    }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: serializeError(error),
    }
  }
  port.postMessage(response)
  if (request.operation === 'close' && response.ok) port.close()
}

async function execute(request: MetadataWorkerRequest): Promise<MetadataWorkerResult> {
  switch (request.operation) {
    case 'initialize':
      return initialize()
    case 'diagnostics':
      if (!diagnostics) throw new Error('Metadata store is not initialized')
      return { ...diagnostics }
    case 'backup': {
      const subject = requireDatabase()
      const pages = await backup(subject, request.destination, { rate: 100 })
      return { destination: request.destination, pages }
    }
    case 'execution-create':
      createExecution(requireDatabase(), request.execution)
      return structuredClone(request.execution)
    case 'execution-get':
      return readExecution(requireDatabase(), request.executionId)
    case 'execution-list':
      return listExecutions(requireDatabase(), request)
    case 'execution-find-cache':
      return findCachedExecution(requireDatabase(), request)
    case 'execution-complete':
      return completeExecution(requireDatabase(), request)
    case 'provenance-append':
      appendProvenance(requireDatabase(), request.records)
      return request.records.map((record) => structuredClone(record))
    case 'provenance-query':
      return queryProvenance(requireDatabase(), request.projectId, request.identity, request.limit)
    case 'close':
      database?.close()
      database = null
      diagnostics = null
      return null
    default:
      request satisfies never
      throw new Error('Unsupported metadata worker operation')
  }
}

function createExecution(subject: DatabaseSync, execution: NodeExecution): void {
  if (Object.keys(execution.outputs).length > 0) {
    throw new TypeError('new execution cannot contain outputs')
  }
  subject.prepare(`
    INSERT INTO node_executions (
      execution_id, project_id, canvas_branch, node_id, node_type_id,
      node_type_revision, node_type_digest, executor_id, artifact_run_id,
      inputs_digest, code_digest, environment_digest, cache_key, status,
      started_at, finished_at, error_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    execution.executionId,
    execution.projectId,
    execution.canvasBranch,
    execution.nodeId,
    execution.nodeTypeRef.id,
    execution.nodeTypeRef.revision,
    execution.nodeTypeRef.digest,
    execution.executorId,
    execution.artifactRunId,
    execution.inputsDigest,
    execution.codeDigest ?? null,
    execution.environmentDigest,
    execution.cacheKey,
    execution.status,
    execution.startedAt,
  )
}

function completeExecution(
  subject: DatabaseSync,
  request: Extract<MetadataWorkerRequest, { operation: 'execution-complete' }>,
): NodeExecution {
  const items = validateExecutionOutputs(request.outputs)
  subject.exec('BEGIN IMMEDIATE')
  try {
    const result = subject.prepare(`
      UPDATE node_executions
      SET status = ?, finished_at = ?, error_json = ?
      WHERE execution_id = ? AND status IN ('queued', 'awaiting-approval', 'running')
    `).run(
      request.status,
      request.finishedAt,
      request.error ? JSON.stringify(request.error) : null,
      request.executionId,
    )
    if (result.changes !== 1) throw new Error('execution is missing or already terminal')
    const insert = subject.prepare(`
      INSERT INTO execution_outputs (
        execution_id, port_key, item_key, item_order, value_kind, value_json,
        artifact_run_id, artifact_id, source_execution_id, source_port_key, source_item_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of items) {
      const artifact = item.value.kind === 'artifact' ? item.value : null
      const source = item.value.kind === 'execution-output' ? item.value : null
      insert.run(
        request.executionId,
        item.portKey,
        item.itemKey,
        item.itemOrder,
        item.value.kind,
        JSON.stringify(item.value),
        artifact?.runId ?? null,
        artifact?.artifactId ?? null,
        source?.executionId ?? null,
        source?.port ?? null,
        source?.itemKey ?? null,
      )
    }
    subject.exec('COMMIT')
  } catch (error) {
    subject.exec('ROLLBACK')
    throw error
  }
  const execution = readExecution(subject, request.executionId)
  if (!execution) throw new Error('terminal execution disappeared')
  return execution
}

function readExecution(subject: DatabaseSync, executionId: string): NodeExecution | null {
  const row = subject.prepare('SELECT * FROM node_executions WHERE execution_id = ?').get(executionId)
  if (!row) return null
  const outputs: Record<string, ValueRef[]> = {}
  for (const output of subject.prepare(`
    SELECT port_key, value_json FROM execution_outputs
    WHERE execution_id = ? ORDER BY port_key, item_order
  `).all(executionId)) {
    const port = String(output.port_key)
    const value = JSON.parse(String(output.value_json)) as ValueRef
    ;(outputs[port] ??= []).push(value)
  }
  const error = row.error_json === null
    ? undefined
    : JSON.parse(String(row.error_json)) as { code: string; message: string }
  return {
    executionId: String(row.execution_id),
    projectId: String(row.project_id),
    canvasBranch: String(row.canvas_branch),
    nodeId: String(row.node_id),
    nodeTypeRef: {
      id: String(row.node_type_id),
      revision: Number(row.node_type_revision),
      digest: String(row.node_type_digest),
    },
    executorId: String(row.executor_id),
    artifactRunId: String(row.artifact_run_id),
    inputsDigest: String(row.inputs_digest),
    ...(row.code_digest === null ? {} : { codeDigest: String(row.code_digest) }),
    environmentDigest: String(row.environment_digest),
    cacheKey: String(row.cache_key),
    status: String(row.status) as NodeExecution['status'],
    outputs,
    startedAt: String(row.started_at),
    ...(row.finished_at === null ? {} : { finishedAt: String(row.finished_at) }),
    ...(error ? { error } : {}),
  }
}

function listExecutions(
  subject: DatabaseSync,
  request: Extract<MetadataWorkerRequest, { operation: 'execution-list' }>,
): NodeExecution[] {
  return subject.prepare(`
    SELECT execution_id FROM node_executions
    WHERE project_id = ? AND canvas_branch = ? AND node_id = ?
    ORDER BY started_at DESC, execution_id DESC LIMIT ?
  `).all(request.projectId, request.canvasBranch, request.nodeId, request.limit)
    .map((row) => readExecution(subject, String(row.execution_id))!)
}

function findCachedExecution(
  subject: DatabaseSync,
  request: Extract<MetadataWorkerRequest, { operation: 'execution-find-cache' }>,
): NodeExecution | null {
  const row = subject.prepare(`
    SELECT execution_id FROM node_executions
    WHERE project_id = ? AND canvas_branch = ? AND node_id = ?
      AND cache_key = ? AND status = 'succeeded'
    ORDER BY finished_at DESC LIMIT 1
  `).get(request.projectId, request.canvasBranch, request.nodeId, request.cacheKey)
  return row ? readExecution(subject, String(row.execution_id)) : null
}

function appendProvenance(subject: DatabaseSync, records: ProvenanceRecord[]): void {
  if (records.length > 1_024) throw new TypeError('too many provenance records')
  const insert = subject.prepare(`
    INSERT OR IGNORE INTO provenance_relations (
      project_id, relation_kind, subject_id, object_id, attributes_json
    ) VALUES (?, ?, ?, ?, ?)
  `)
  subject.exec('BEGIN IMMEDIATE')
  try {
    for (const record of records) {
      insert.run(
        record.projectId,
        record.relationKind,
        record.subjectId,
        record.objectId,
        JSON.stringify(record.attributes),
      )
    }
    subject.exec('COMMIT')
  } catch (error) {
    subject.exec('ROLLBACK')
    throw error
  }
}

function queryProvenance(
  subject: DatabaseSync,
  projectId: string,
  identity: string,
  limit: number,
): ProvenanceRecord[] {
  return subject.prepare(`
    SELECT project_id, relation_kind, subject_id, object_id, attributes_json
    FROM provenance_relations
    WHERE project_id = ? AND (subject_id = ? OR object_id = ?)
    ORDER BY relation_id DESC LIMIT ?
  `).all(projectId, identity, identity, limit).map((row) => ({
    projectId: String(row.project_id),
    relationKind: String(row.relation_kind) as ProvenanceRecord['relationKind'],
    subjectId: String(row.subject_id),
    objectId: String(row.object_id),
    attributes: JSON.parse(String(row.attributes_json)) as Record<string, unknown>,
  }))
}

function initialize(): MetadataDiagnostics {
  if (diagnostics) return { ...diagnostics }
  const subject = new DatabaseSync(input.databasePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  })
  try {
    const sqliteVersion = scalarString(subject, 'SELECT sqlite_version()')
    if (compareVersions(sqliteVersion, MINIMUM_SQLITE_VERSION) < 0) {
      throw new Error(
        `SQLite ${sqliteVersion} is unsupported; ${MINIMUM_SQLITE_VERSION} or newer is required`,
      )
    }

    subject.exec('PRAGMA foreign_keys = ON')
    subject.exec('PRAGMA busy_timeout = 5000')
    subject.exec('PRAGMA synchronous = FULL')
    const journalMode = scalarString(subject, 'PRAGMA journal_mode = WAL').toLowerCase()
    if (journalMode !== 'wal') throw new Error(`SQLite WAL mode is unavailable: ${journalMode}`)

    migrate(subject)
    const integrity = scalarString(subject, 'PRAGMA quick_check')
    if (integrity !== 'ok') throw new Error(`Metadata store integrity check failed: ${integrity}`)

    database = subject
    diagnostics = {
      schemaVersion: METADATA_SCHEMA_VERSION,
      sqliteVersion,
      journalMode: 'wal',
      integrity: 'ok',
    }
    return { ...diagnostics }
  } catch (error) {
    subject.close()
    throw error
  }
}

function migrate(subject: DatabaseSync): void {
  const version = scalarNumber(subject, 'PRAGMA user_version')
  if (version > METADATA_SCHEMA_VERSION) {
    throw new Error(`Metadata schema ${version} is newer than supported schema ${METADATA_SCHEMA_VERSION}`)
  }
  if (version === METADATA_SCHEMA_VERSION) return

  if (version === 1) {
    subject.exec('BEGIN IMMEDIATE')
    try {
      subject.exec(`
        DROP INDEX IF EXISTS node_executions_cache_success;
        CREATE INDEX node_executions_cache_success
          ON node_executions(project_id, canvas_branch, node_id, cache_key, finished_at DESC)
          WHERE status = 'succeeded';
        PRAGMA user_version = ${METADATA_SCHEMA_VERSION};
      `)
      subject.exec('COMMIT')
      return
    } catch (error) {
      subject.exec('ROLLBACK')
      throw error
    }
  }

  subject.exec('BEGIN IMMEDIATE')
  try {
    subject.exec(`
      CREATE TABLE node_executions (
        execution_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        canvas_branch TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_type_id TEXT NOT NULL,
        node_type_revision INTEGER NOT NULL CHECK (node_type_revision >= 1),
        node_type_digest TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        artifact_run_id TEXT NOT NULL,
        inputs_digest TEXT NOT NULL,
        code_digest TEXT,
        environment_digest TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'awaiting-approval', 'running', 'succeeded', 'failed', 'cancelled', 'timed-out')
        ),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_json TEXT
      );

      CREATE INDEX node_executions_cache_success
        ON node_executions(project_id, canvas_branch, node_id, cache_key, finished_at DESC)
        WHERE status = 'succeeded';

      CREATE INDEX node_executions_node_history
        ON node_executions(project_id, canvas_branch, node_id, started_at DESC);

      CREATE TABLE execution_outputs (
        execution_id TEXT NOT NULL REFERENCES node_executions(execution_id) ON DELETE CASCADE,
        port_key TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_order INTEGER NOT NULL CHECK (item_order >= 0),
        value_kind TEXT NOT NULL CHECK (value_kind IN ('json', 'artifact', 'node', 'execution-output')),
        value_json TEXT,
        artifact_run_id TEXT,
        artifact_id TEXT,
        source_execution_id TEXT,
        source_port_key TEXT,
        source_item_key TEXT,
        PRIMARY KEY (execution_id, port_key, item_key),
        UNIQUE (execution_id, port_key, item_order)
      );

      CREATE TABLE workspace_roots (
        root_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        platform_provider TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, canonical_path)
      );

      CREATE TABLE node_bindings (
        binding_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        canvas_branch TEXT NOT NULL,
        node_id TEXT NOT NULL,
        root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
        mode TEXT NOT NULL CHECK (mode IN ('fs-authoritative', 'canvas-authoritative', 'bidirectional')),
        base_digest TEXT,
        canvas_digest TEXT,
        disk_digest TEXT,
        state TEXT NOT NULL CHECK (state IN ('clean', 'canvas-dirty', 'disk-dirty', 'conflict', 'missing')),
        echo_token TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, canvas_branch, node_id),
        UNIQUE (project_id, canvas_branch, root_id, relative_path)
      );

      CREATE TABLE sync_conflicts (
        conflict_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES node_bindings(binding_id) ON DELETE CASCADE,
        base_digest TEXT,
        canvas_digest TEXT NOT NULL,
        disk_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved-canvas', 'resolved-disk')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX sync_conflicts_open
        ON sync_conflicts(binding_id, created_at DESC)
        WHERE state = 'open';

      CREATE TABLE provenance_entities (
        entity_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        digest TEXT,
        attributes_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE provenance_activities (
        activity_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        activity_kind TEXT NOT NULL,
        plan_id TEXT,
        status TEXT NOT NULL,
        attributes_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE provenance_agents (
        agent_id TEXT PRIMARY KEY,
        agent_kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        attributes_json TEXT NOT NULL
      );

      CREATE TABLE provenance_relations (
        relation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        relation_kind TEXT NOT NULL CHECK (
          relation_kind IN ('used', 'was-generated-by', 'was-derived-from', 'was-associated-with', 'had-plan')
        ),
        subject_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        attributes_json TEXT NOT NULL,
        UNIQUE (project_id, relation_kind, subject_id, object_id)
      );

      CREATE INDEX provenance_relations_subject
        ON provenance_relations(project_id, subject_id, relation_kind);
      CREATE INDEX provenance_relations_object
        ON provenance_relations(project_id, object_id, relation_kind);

      PRAGMA user_version = ${METADATA_SCHEMA_VERSION};
    `)
    subject.exec('COMMIT')
  } catch (error) {
    subject.exec('ROLLBACK')
    throw error
  }
}

function requireDatabase(): DatabaseSync {
  if (!database) throw new Error('Metadata store is not initialized')
  return database
}

function scalarString(subject: DatabaseSync, sql: string): string {
  const value = subject.prepare(sql).get()
  if (!value) throw new Error(`SQLite query returned no row: ${sql}`)
  const field = Object.values(value)[0]
  if (typeof field !== 'string') throw new Error(`SQLite query returned a non-string value: ${sql}`)
  return field
}

function scalarNumber(subject: DatabaseSync, sql: string): number {
  const value = subject.prepare(sql).get()
  if (!value) throw new Error(`SQLite query returned no row: ${sql}`)
  const field = Object.values(value)[0]
  if (typeof field !== 'number') throw new Error(`SQLite query returned a non-number value: ${sql}`)
  return field
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)
  if (!match) throw new Error(`SQLite reported an invalid version: ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  }
}

function requireParentPort(): MessagePort {
  if (!parentPort) throw new Error('Metadata worker requires a parent port')
  return parentPort
}
