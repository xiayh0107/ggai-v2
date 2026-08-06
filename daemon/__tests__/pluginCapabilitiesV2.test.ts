import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2,
  ProjectionPluginCapabilityStoreV2,
  inspectProjectionPluginCapabilitySnapshotV2,
  resolveProjectionPluginCapabilitySnapshotV2,
} from '../pluginCapabilitiesV2.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-plugin-capabilities-v2-'))
  temporaryDirectories.push(directory)
  return directory
}

test('resolves canonical browser claims while protecting built-ins and generic file', () => {
  const snapshot = resolveProjectionPluginCapabilitySnapshotV2({
    schemaVersion: 2,
    plugins: [{
      id: '@community/notebook',
      artifactClaims: [{ extensions: ['.ipynb'], mediaTypes: ['application/x-ipynb+json'] }],
    }],
  })
  assert.match(snapshot.digest, /^[0-9a-f]{64}$/u)
  assert.ok(snapshot.plugins.some((plugin) => plugin.id === '@community/notebook'))
  assert.deepEqual(
    snapshot.plugins.filter((plugin) => plugin.acceptsUnknown).map((plugin) => plugin.id),
    ['file'],
  )
  assert.deepEqual(inspectProjectionPluginCapabilitySnapshotV2(snapshot), {
    status: 'valid',
    snapshot,
  })

  assert.throws(() => resolveProjectionPluginCapabilitySnapshotV2({
    schemaVersion: 2,
    plugins: [{ id: 'image', artifactClaims: [{ extensions: ['.evil'] }] }],
  }), /built-in artifact capability cannot be replaced/u)
  assert.throws(() => resolveProjectionPluginCapabilitySnapshotV2({
    schemaVersion: 2,
    plugins: [{ id: '@community/catch-all', artifactClaims: [], acceptsUnknown: true }],
  }), /cannot accept unknown files/u)
})

test('digest is independent from browser registration and matcher order', () => {
  const left = resolveProjectionPluginCapabilitySnapshotV2({
    schemaVersion: 2,
    plugins: [
      { id: '@z/last', artifactClaims: [{ extensions: ['.z', '.a'] }] },
      { id: '@a/first', artifactClaims: [{ mediaTypes: ['text/z', 'text/a'] }] },
    ],
  })
  const right = resolveProjectionPluginCapabilitySnapshotV2({
    schemaVersion: 2,
    plugins: [
      { id: '@a/first', artifactClaims: [{ mediaTypes: ['text/a', 'text/z'] }] },
      { id: '@z/last', artifactClaims: [{ extensions: ['.a', '.z'] }] },
    ],
  })
  assert.deepEqual(right, left)
})

test('persists immutable content-addressed snapshots and detects tampering', async () => {
  const projectDir = await temporaryProject()
  const store = new ProjectionPluginCapabilityStoreV2(projectDir)
  const snapshot = await store.register({
    schemaVersion: 2,
    plugins: [{
      id: '@community/notebook',
      artifactClaims: [{ extensions: ['.ipynb'] }],
    }],
  })
  assert.deepEqual(await store.get(snapshot.digest), snapshot)
  assert.deepEqual(await store.register({
    schemaVersion: 2,
    plugins: [{
      id: '@community/notebook',
      artifactClaims: [{ extensions: ['.ipynb'] }],
    }],
  }), snapshot)

  const snapshotPath = path.join(store.rootDir, `${snapshot.digest}.json`)
  const persisted = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<string, unknown>
  persisted.digest = 'f'.repeat(64)
  await writeFile(snapshotPath, `${JSON.stringify(persisted)}\n`, 'utf8')
  await assert.rejects(store.get(snapshot.digest), /digest|belongs/u)
  assert.deepEqual(await store.recover(snapshot.digest), BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2)
})

test('strict lookup rejects unsafe roots while recovery degrades to built-ins', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  await mkdir(path.join(projectDir, '.gg', 'runtime'), { recursive: true })
  await symlink(outside, path.join(projectDir, '.gg', 'runtime', 'plugin-capabilities-v2'))
  const store = new ProjectionPluginCapabilityStoreV2(projectDir)

  await assert.rejects(store.register({ schemaVersion: 2, plugins: [] }), /unsafe/u)
  assert.deepEqual(
    await store.recover('a'.repeat(64)),
    BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2,
  )
})
