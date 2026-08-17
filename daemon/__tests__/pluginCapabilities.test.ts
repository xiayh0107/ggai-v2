import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
  ProjectionPluginCapabilityStore,
  inspectLegacyProjectionPluginCapabilitySnapshot,
  inspectProjectionPluginCapabilitySnapshot,
  legacyProjectionPluginCapabilityDigest,
  resolveProjectionPluginCapabilitySnapshot,
} from '../pluginCapabilities.js'
import { createProjectionContributionSnapshot } from '../projectionContributions.js'
import {
  BUILTIN_ARTIFACT_CLAIM_REGISTRY,
  canonicalArtifactClaimRegistrations,
} from '../../src/plugins/artifactContracts.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-plugin-capabilities-'))
  temporaryDirectories.push(directory)
  return directory
}

test('resolves canonical browser claims while protecting built-ins and generic file', () => {
  const snapshot = resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: 2,
    plugins: [{
      id: '@community/notebook',
      artifactClaims: [{ extensions: ['.ipynb'], mediaTypes: ['application/x-ipynb+json'] }],
      nodeContext: {
        schemaVersion: 1,
        summary: { textMaxChars: 400, payloadFields: ['kernel'] },
        full: { textMaxChars: 50_000, payloadFields: ['kernel'], artifactRefs: 'all' },
      },
    }],
  }, createProjectionContributionSnapshot([{
    providerId: '@runtime/report-provider',
    providerVersion: '2.1.0',
    id: '@runtime/report',
    artifactClaims: [{ extensions: ['.report'] }],
  }]))
  assert.match(snapshot.digest, /^[0-9a-f]{64}$/u)
  assert.equal(snapshot.schemaVersion, 3)
  assert.ok(snapshot.plugins.some((plugin) => plugin.pluginId === '@community/notebook'))
  assert.deepEqual(
    snapshot.plugins.find((plugin) => plugin.pluginId === '@community/notebook')?.nodeContext,
    {
      schemaVersion: 1,
      summary: { textMaxChars: 400, payloadFields: ['kernel'] },
      full: { textMaxChars: 50_000, payloadFields: ['kernel'], artifactRefs: 'all' },
    },
  )
  assert.deepEqual(
    snapshot.plugins.filter((plugin) => plugin.acceptsUnknown).map((plugin) => plugin.pluginId),
    ['file'],
  )
  assert.deepEqual(
    snapshot.plugins.find((plugin) => plugin.pluginId === '@runtime/report')?.source,
    {
      kind: 'runtime-plugin',
      providerId: '@runtime/report-provider',
      providerVersion: '2.1.0',
    },
  )
  assert.deepEqual(inspectProjectionPluginCapabilitySnapshot(snapshot), {
    status: 'valid',
    snapshot,
  })

  assert.throws(() => resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: 2,
    plugins: [{ id: 'image', artifactClaims: [{ extensions: ['.evil'] }] }],
  }), /built-in plugin capability cannot be replaced/u)
  assert.throws(() => resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: 2,
    plugins: [{
      id: 'web',
      artifactClaims: [],
      nodeContext: {
        schemaVersion: 1,
        summary: { textMaxChars: 1, payloadFields: [] },
        full: { textMaxChars: 1, payloadFields: [], artifactRefs: 'none' },
      },
    }],
  }), /built-in plugin capability cannot be replaced/u)
  assert.throws(() => resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: 2,
    plugins: [{ id: '@community/catch-all', artifactClaims: [], acceptsUnknown: true }],
  }), /cannot accept unknown files/u)
})

test('digest is independent from browser registration and matcher order', () => {
  const left = resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: 2,
    plugins: [
      { id: '@z/last', artifactClaims: [{ extensions: ['.z', '.a'] }] },
      { id: '@a/first', artifactClaims: [{ mediaTypes: ['text/z', 'text/a'] }] },
    ],
  })
  const right = resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: 2,
    plugins: [
      { id: '@a/first', artifactClaims: [{ mediaTypes: ['text/a', 'text/z'] }] },
      { id: '@z/last', artifactClaims: [{ extensions: ['.a', '.z'] }] },
    ],
  })
  assert.deepEqual(right, left)
})

test('runtime and browser claims with the same plugin id fail closed', () => {
  assert.throws(() => resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: 2,
    plugins: [{ id: '@shared/report', artifactClaims: [{ extensions: ['.browser'] }] }],
  }, createProjectionContributionSnapshot([{
    providerId: '@runtime/provider',
    providerVersion: '1.0.0',
    id: '@shared/report',
    artifactClaims: [{ extensions: ['.runtime'] }],
  }])), /claim conflicts/u)
})

test('keeps immutable pre-context-policy snapshots readable with compatibility semantics', () => {
  const legacyPlugins = canonicalArtifactClaimRegistrations([
    ...BUILTIN_ARTIFACT_CLAIM_REGISTRY,
    { id: '@community/legacy', artifactClaims: [{ extensions: ['.legacy'] }] },
  ]).map((registration) => ({
    id: registration.id,
    artifactRules: registration.artifactClaims,
    ...(registration.acceptsUnknown ? { acceptsUnknown: true } : {}),
  }))
  const legacy = {
    schemaVersion: 2 as const,
    digest: legacyProjectionPluginCapabilityDigest(legacyPlugins),
    plugins: legacyPlugins,
  }

  assert.deepEqual(inspectLegacyProjectionPluginCapabilitySnapshot(legacy), {
    status: 'valid',
    snapshot: legacy,
  })
})

test('persists immutable content-addressed snapshots and detects tampering', async () => {
  const projectDir = await temporaryProject()
  const store = new ProjectionPluginCapabilityStore(projectDir)
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
  assert.deepEqual(await store.recover(snapshot.digest), BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT)
})

test('recovery ignores retired versioned capability directories', async () => {
  const projectDir = await temporaryProject()
  const store = new ProjectionPluginCapabilityStore(projectDir)
  const retiredRoot = path.join(projectDir, '.gg', 'runtime', 'plugin-capabilities-v2')
  await mkdir(retiredRoot, { recursive: true })
  await writeFile(
    path.join(retiredRoot, `${'a'.repeat(64)}.json`),
    '{}\n',
    'utf8',
  )

  assert.equal(await store.get('a'.repeat(64)), null)
  assert.deepEqual(
    await store.recover('a'.repeat(64)),
    BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
  )
})

test('strict lookup rejects unsafe roots while recovery degrades to built-ins', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  await mkdir(path.join(projectDir, '.gg', 'runtime'), { recursive: true })
  await symlink(outside, path.join(projectDir, '.gg', 'runtime', 'plugin-capabilities'))
  const store = new ProjectionPluginCapabilityStore(projectDir)

  await assert.rejects(store.register({ schemaVersion: 2, plugins: [] }), /unsafe/u)
  assert.deepEqual(
    await store.recover('a'.repeat(64)),
    BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
  )
})
