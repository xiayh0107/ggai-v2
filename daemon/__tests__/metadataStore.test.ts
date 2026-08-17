import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { METADATA_SCHEMA_VERSION, MINIMUM_SQLITE_VERSION } from '../metadataProtocol.js'
import { MetadataStore } from '../metadataStore.js'

test('metadata authority initializes the exact WAL schema in its worker', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-metadata-')))
  const store = new MetadataStore(root)
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })

  const diagnostics = await store.open()
  assert.equal(diagnostics.schemaVersion, METADATA_SCHEMA_VERSION)
  assert.equal(diagnostics.journalMode, 'wal')
  assert.equal(diagnostics.integrity, 'ok')
  assert.ok(compareVersions(diagnostics.sqliteVersion, MINIMUM_SQLITE_VERSION) >= 0)

  await store.close()
  const database = new DatabaseSync(store.databasePath, { readOnly: true })
  try {
    assert.equal(scalarNumber(database, 'PRAGMA user_version'), METADATA_SCHEMA_VERSION)
    assert.deepEqual(tableNames(database), [
      'compute_approvals',
      'execution_outputs',
      'node_bindings',
      'node_executions',
      'provenance_activities',
      'provenance_agents',
      'provenance_entities',
      'provenance_relations',
      'sync_conflicts',
      'workspace_roots',
    ])
  } finally {
    database.close()
  }

  const mode = (await lstat(store.databasePath)).mode & 0o777
  assert.equal(mode, 0o600)
})

test('metadata backups are serialized by the worker and remain readable', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-metadata-backup-')))
  const store = new MetadataStore(root)
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })

  await store.open()
  const [diagnostics, backupPath] = await Promise.all([
    store.diagnostics(),
    store.backup(new Date('2026-08-17T12:00:00.000Z')),
  ])
  assert.equal(diagnostics.integrity, 'ok')
  assert.match(path.basename(backupPath), /^index-20260817120000000-[0-9a-f-]+\.sqlite$/u)
  assert.equal((await lstat(backupPath)).mode & 0o777, 0o600)

  const backup = new DatabaseSync(backupPath, { readOnly: true })
  try {
    assert.equal(scalarNumber(backup, 'PRAGMA user_version'), METADATA_SCHEMA_VERSION)
    assert.equal(scalarString(backup, 'PRAGMA quick_check'), 'ok')
  } finally {
    backup.close()
  }
})

test('metadata schema 2 upgrades atomically with digest-bound compute approvals', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-metadata-v2-')))
  const first = new MetadataStore(root)
  t.after(async () => {
    await first.close()
    await rm(root, { recursive: true, force: true })
  })
  await first.open()
  await first.close()
  const old = new DatabaseSync(first.databasePath)
  old.exec('DROP TABLE compute_approvals; PRAGMA user_version = 2;')
  old.close()

  const upgraded = new MetadataStore(root)
  await upgraded.open()
  assert.equal((await upgraded.diagnostics()).schemaVersion, METADATA_SCHEMA_VERSION)
  assert.equal(await upgraded.hasComputeApproval({
    projectId: 'project', nodeId: 'node', codeDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64),
  }), false)
  await upgraded.grantComputeApproval({
    projectId: 'project', nodeId: 'node', codeDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64),
    approvedAt: '2026-08-17T00:00:00.000Z',
  })
  assert.equal(await upgraded.hasComputeApproval({
    projectId: 'project', nodeId: 'node', codeDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64),
  }), true)
  await upgraded.close()
})

test('metadata schema 3 adds filesystem reconciliation identity without rebuilding data', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-metadata-v3-')))
  const first = new MetadataStore(root)
  t.after(async () => {
    await first.close()
    await rm(root, { recursive: true, force: true })
  })
  await first.open()
  await first.close()
  const old = new DatabaseSync(first.databasePath)
  old.exec(`
    DROP TABLE sync_conflicts;
    DROP TABLE node_bindings;
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
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX sync_conflicts_open ON sync_conflicts(binding_id, created_at DESC)
      WHERE state = 'open';
    PRAGMA user_version = 3;
  `)
  old.close()
  const upgraded = new MetadataStore(root)
  await upgraded.open()
  await upgraded.close()
  const verified = new DatabaseSync(first.databasePath, { readOnly: true })
  const columns = verified.prepare('PRAGMA table_info(node_bindings)').all()
    .map((row) => String(row.name))
  verified.close()
  assert.ok(columns.includes('canvas_project_dir'))
  assert.ok(columns.includes('file_identity'))
})

test('metadata authority rejects a symlinked runtime root', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-metadata-symlink-')))
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-metadata-outside-')))
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  })
  await mkdir(path.join(root, '.gg'), { recursive: true })
  await symlink(outside, path.join(root, '.gg', 'runtime'))

  const store = new MetadataStore(root)
  await assert.rejects(store.open(), /resolve|symlink|runtime root/iu)
  await store.close()
})

function tableNames(database: DatabaseSync): string[] {
  return database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => String(row.name))
}

function scalarNumber(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get()
  assert.ok(row)
  const value = Object.values(row)[0]
  if (typeof value !== 'number') throw new TypeError('expected numeric SQLite scalar')
  return value
}

function scalarString(database: DatabaseSync, sql: string): string {
  const row = database.prepare(sql).get()
  assert.ok(row)
  const value = Object.values(row)[0]
  if (typeof value !== 'string') throw new TypeError('expected string SQLite scalar')
  return value
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
