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
  type FilesystemBindingUpdate,
  type StoredFilesystemBinding,
  type StoredWorkspaceRoot,
} from './metadataProtocol.js'
import {
  validateExecutionOutputs,
  type NodeExecution,
  type ValueRef,
} from '../src/execution/contracts.js'
import type { FilesystemConflict } from '../src/filesystem/contracts.js'

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
    case 'execution-mark-running':
      return markExecutionRunning(requireDatabase(), request.executionId)
    case 'compute-approval-check':
      return hasComputeApproval(requireDatabase(), request)
    case 'compute-approval-grant':
      grantComputeApproval(requireDatabase(), request)
      return true
    case 'workspace-root-create':
      createWorkspaceRoot(requireDatabase(), request.root)
      return structuredClone(request.root)
    case 'workspace-root-list':
      return listWorkspaceRoots(requireDatabase(), request.projectId)
    case 'workspace-root-get':
      return getWorkspaceRoot(requireDatabase(), request.rootId)
    case 'filesystem-binding-create':
      createFilesystemBinding(requireDatabase(), request.binding)
      return structuredClone(request.binding)
    case 'filesystem-binding-get':
      return getFilesystemBinding(requireDatabase(), request.bindingId)
    case 'filesystem-binding-list-root':
      return listFilesystemBindingsForRoot(requireDatabase(), request.rootId)
    case 'filesystem-binding-delete':
      return deleteFilesystemBinding(requireDatabase(), request.bindingId)
    case 'filesystem-binding-update':
      return updateFilesystemBinding(requireDatabase(), request.bindingId, request.patch)
    case 'filesystem-conflict-create':
      createFilesystemConflict(requireDatabase(), request.conflict)
      return structuredClone(request.conflict)
    case 'filesystem-conflict-list':
      return listFilesystemConflicts(requireDatabase(), request.projectId, request.openOnly)
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

function createWorkspaceRoot(subject: DatabaseSync, root: StoredWorkspaceRoot): void {
  subject.prepare(`
    INSERT INTO workspace_roots (
      root_id, project_id, display_name, canonical_path, platform_provider, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(root.rootId, root.projectId, root.displayName, root.canonicalPath, root.platformProvider, root.createdAt)
}

function listWorkspaceRoots(subject: DatabaseSync, projectId: string): StoredWorkspaceRoot[] {
  return subject.prepare(`
    SELECT * FROM workspace_roots WHERE project_id = ? ORDER BY display_name, root_id
  `).all(projectId).map(storedWorkspaceRoot)
}

function getWorkspaceRoot(subject: DatabaseSync, rootId: string): StoredWorkspaceRoot | null {
  const row = subject.prepare('SELECT * FROM workspace_roots WHERE root_id = ?').get(rootId)
  return row ? storedWorkspaceRoot(row) : null
}

function storedWorkspaceRoot(row: Record<string, unknown>): StoredWorkspaceRoot {
  return {
    rootId: String(row.root_id),
    projectId: String(row.project_id),
    displayName: String(row.display_name),
    canonicalPath: String(row.canonical_path),
    platformProvider: String(row.platform_provider) as 'macos',
    createdAt: String(row.created_at),
  }
}

function createFilesystemBinding(subject: DatabaseSync, binding: StoredFilesystemBinding): void {
  subject.prepare(`
    INSERT INTO node_bindings (
      binding_id, project_id, canvas_branch, canvas_project_dir, node_id, root_id,
      relative_path, kind, mode, base_digest, canvas_digest, disk_digest, state,
      file_identity, echo_token, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    binding.bindingId, binding.projectId, binding.canvasBranch, binding.canvasProjectDir,
    binding.nodeId, binding.rootId, binding.relativePath, binding.kind, binding.mode,
    binding.baseDigest, binding.canvasDigest, binding.diskDigest, binding.state,
    binding.fileIdentity, binding.echoToken, binding.updatedAt,
  )
}

function getFilesystemBinding(subject: DatabaseSync, bindingId: string): StoredFilesystemBinding | null {
  const row = subject.prepare('SELECT * FROM node_bindings WHERE binding_id = ?').get(bindingId)
  return row ? storedFilesystemBinding(row) : null
}

function listFilesystemBindingsForRoot(
  subject: DatabaseSync,
  rootId: string,
): StoredFilesystemBinding[] {
  return subject.prepare(`
    SELECT * FROM node_bindings WHERE root_id = ? ORDER BY relative_path, binding_id
  `).all(rootId).map(storedFilesystemBinding)
}

function deleteFilesystemBinding(subject: DatabaseSync, bindingId: string): boolean {
  return subject.prepare('DELETE FROM node_bindings WHERE binding_id = ?').run(bindingId).changes === 1
}

function storedFilesystemBinding(row: Record<string, unknown>): StoredFilesystemBinding {
  return {
    bindingId: String(row.binding_id),
    projectId: String(row.project_id),
    canvasBranch: String(row.canvas_branch),
    canvasProjectDir: String(row.canvas_project_dir),
    nodeId: String(row.node_id),
    rootId: String(row.root_id),
    relativePath: String(row.relative_path),
    kind: String(row.kind) as StoredFilesystemBinding['kind'],
    mode: String(row.mode) as StoredFilesystemBinding['mode'],
    baseDigest: row.base_digest === null ? null : String(row.base_digest),
    canvasDigest: row.canvas_digest === null ? null : String(row.canvas_digest),
    diskDigest: row.disk_digest === null ? null : String(row.disk_digest),
    state: String(row.state) as StoredFilesystemBinding['state'],
    fileIdentity: row.file_identity === null ? null : String(row.file_identity),
    echoToken: row.echo_token === null ? null : String(row.echo_token),
    updatedAt: String(row.updated_at),
  }
}

function updateFilesystemBinding(
  subject: DatabaseSync,
  bindingId: string,
  patch: FilesystemBindingUpdate,
): StoredFilesystemBinding {
  const columns: Record<keyof FilesystemBindingUpdate, string> = {
    relativePath: 'relative_path', baseDigest: 'base_digest', canvasDigest: 'canvas_digest',
    diskDigest: 'disk_digest', state: 'state', fileIdentity: 'file_identity',
    echoToken: 'echo_token', updatedAt: 'updated_at',
  }
  const entries = Object.entries(patch) as Array<[keyof FilesystemBindingUpdate, unknown]>
  if (entries.length === 0 || entries.some(([key]) => !columns[key])) {
    throw new TypeError('filesystem binding update is invalid')
  }
  const assignments = entries.map(([key]) => `${columns[key]} = ?`).join(', ')
  const values = entries.map(([, value]) => {
    if (value === null || typeof value === 'string') return value
    throw new TypeError('filesystem binding update value is invalid')
  })
  const result = subject.prepare(`UPDATE node_bindings SET ${assignments} WHERE binding_id = ?`)
    .run(...values, bindingId)
  if (result.changes !== 1) throw new Error('filesystem binding does not exist')
  const updated = getFilesystemBinding(subject, bindingId)
  if (!updated) throw new Error('filesystem binding disappeared')
  return updated
}

function createFilesystemConflict(subject: DatabaseSync, conflict: FilesystemConflict): void {
  subject.prepare(`
    INSERT INTO sync_conflicts (
      conflict_id, binding_id, base_digest, canvas_digest, disk_digest,
      state, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conflict.conflictId, conflict.bindingId, conflict.baseDigest, conflict.canvasDigest,
    conflict.diskDigest, conflict.state, conflict.createdAt, conflict.resolvedAt,
  )
}

function listFilesystemConflicts(
  subject: DatabaseSync,
  projectId: string,
  openOnly: boolean,
): FilesystemConflict[] {
  return subject.prepare(`
    SELECT c.* FROM sync_conflicts c
    JOIN node_bindings b ON b.binding_id = c.binding_id
    WHERE b.project_id = ? ${openOnly ? "AND c.state = 'open'" : ''}
    ORDER BY c.created_at DESC, c.conflict_id DESC
  `).all(projectId).map((row) => ({
    conflictId: String(row.conflict_id), bindingId: String(row.binding_id),
    baseDigest: row.base_digest === null ? null : String(row.base_digest),
    canvasDigest: String(row.canvas_digest), diskDigest: String(row.disk_digest),
    state: String(row.state) as FilesystemConflict['state'],
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  }))
}

function markExecutionRunning(subject: DatabaseSync, executionId: string): NodeExecution {
  const result = subject.prepare(`
    UPDATE node_executions SET status = 'running'
    WHERE execution_id = ? AND status = 'awaiting-approval'
  `).run(executionId)
  if (result.changes !== 1) throw new Error('execution is missing or not awaiting approval')
  const execution = readExecution(subject, executionId)
  if (!execution) throw new Error('approved execution disappeared')
  return execution
}

function hasComputeApproval(
  subject: DatabaseSync,
  request: Extract<MetadataWorkerRequest, { operation: 'compute-approval-check' }>,
): boolean {
  return Boolean(subject.prepare(`
    SELECT 1 FROM compute_approvals
    WHERE project_id = ? AND node_id = ? AND code_digest = ? AND environment_digest = ?
  `).get(request.projectId, request.nodeId, request.codeDigest, request.environmentDigest))
}

function grantComputeApproval(
  subject: DatabaseSync,
  request: Extract<MetadataWorkerRequest, { operation: 'compute-approval-grant' }>,
): void {
  subject.prepare(`
    INSERT OR IGNORE INTO compute_approvals (
      project_id, node_id, code_digest, environment_digest, approved_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    request.projectId,
    request.nodeId,
    request.codeDigest,
    request.environmentDigest,
    request.approvedAt,
  )
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

  if (version === 1 || version === 2 || version === 3) {
    subject.exec('BEGIN IMMEDIATE')
    try {
      subject.exec(`
        ${version === 1 ? `
          DROP INDEX IF EXISTS node_executions_cache_success;
          CREATE INDEX node_executions_cache_success
            ON node_executions(project_id, canvas_branch, node_id, cache_key, finished_at DESC)
            WHERE status = 'succeeded';
        ` : ''}
        ${version <= 2 ? `CREATE TABLE compute_approvals (
          project_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          code_digest TEXT NOT NULL,
          environment_digest TEXT NOT NULL,
          approved_at TEXT NOT NULL,
          PRIMARY KEY (project_id, node_id, code_digest, environment_digest)
        );` : ''}
        ${hasTableColumn(subject, 'node_bindings', 'canvas_project_dir')
          ? '' : "ALTER TABLE node_bindings ADD COLUMN canvas_project_dir TEXT NOT NULL DEFAULT '.';"}
        ${hasTableColumn(subject, 'node_bindings', 'file_identity')
          ? '' : 'ALTER TABLE node_bindings ADD COLUMN file_identity TEXT;'}
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
        canvas_project_dir TEXT NOT NULL,
        node_id TEXT NOT NULL,
        root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
        mode TEXT NOT NULL CHECK (mode IN ('fs-authoritative', 'canvas-authoritative', 'bidirectional')),
        base_digest TEXT,
        canvas_digest TEXT,
        disk_digest TEXT,
        state TEXT NOT NULL CHECK (state IN ('clean', 'canvas-dirty', 'disk-dirty', 'conflict', 'missing')),
        file_identity TEXT,
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

      CREATE TABLE compute_approvals (
        project_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        code_digest TEXT NOT NULL,
        environment_digest TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        PRIMARY KEY (project_id, node_id, code_digest, environment_digest)
      );

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

function hasTableColumn(subject: DatabaseSync, table: string, column: string): boolean {
  return subject.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => row.name === column)
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
