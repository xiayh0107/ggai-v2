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
