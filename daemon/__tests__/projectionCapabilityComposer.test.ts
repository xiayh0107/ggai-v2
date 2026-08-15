import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION } from '../../src/plugins/artifactContracts.js'
import {
  ProjectionCapabilityComposer,
  inspectProjectionCapabilityProvenanceSnapshot,
} from '../projectionCapabilityComposer.js'
import { ProjectionCapabilityProvenanceStore } from '../projectionProvenanceStore.js'
import { ProjectionContributionRegistry } from '../projectionContributions.js'
import { resolveProjectionPluginCapabilitySnapshot } from '../pluginCapabilities.js'

const REPORT_RULE = {
  extensions: ['.report'],
  mediaTypes: ['text/plain'],
  priority: 10,
}
const NOTE_RULE = {
  extensions: ['.note'],
  mediaTypes: ['text/plain'],
  priority: 5,
}

test('composer activates Runtime data contributions and records source provenance', () => {
  const runtime = new ProjectionContributionRegistry()
  runtime.register('@fixture/report-provider', [{
    id: '@fixture/report',
    artifactClaims: [REPORT_RULE],
  }])
  const community = resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    plugins: [{
      id: '@fixture/note',
      artifactClaims: [NOTE_RULE],
    }],
  })
  const composer = new ProjectionCapabilityComposer(runtime)
  const first = composer.compose(community)
  const second = composer.compose(first.capabilities)

  assert.equal(first.capabilities.plugins.some(({ id }) => id === '@fixture/report'), true)
  assert.equal(first.capabilities.plugins.some(({ id }) => id === '@fixture/note'), true)
  assert.deepEqual(first, second)
  assert.equal(first.provenance.classificationDigest, first.capabilities.digest)
  assert.equal(first.provenance.sources.find(({ pluginId }) =>
    pluginId === '@fixture/report')?.kind, 'runtime')
  assert.equal(first.provenance.sources.find(({ pluginId }) =>
    pluginId === '@fixture/report')?.providerId, '@fixture/report-provider')
  assert.equal(first.provenance.sources.find(({ pluginId }) =>
    pluginId === '@fixture/note')?.kind, 'community')
  assert.equal(inspectProjectionCapabilityProvenanceSnapshot(first.provenance).status, 'valid')
})

test('Runtime and community declarations cannot silently disagree on one capability id', () => {
  const runtime = new ProjectionContributionRegistry()
  runtime.register('@fixture/report-provider', [{
    id: '@fixture/report',
    artifactClaims: [REPORT_RULE],
  }])
  const conflicting = resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    plugins: [{
      id: '@fixture/report',
      artifactClaims: [{ ...REPORT_RULE, priority: 99 }],
    }],
  })
  assert.throws(
    () => new ProjectionCapabilityComposer(runtime).compose(conflicting),
    /conflicts with Runtime provider/u,
  )
})

test('projection provenance is content-addressed and independently revalidated', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-projection-provenance-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = new ProjectionContributionRegistry()
  runtime.register('@fixture/report-provider', [{
    id: '@fixture/report',
    artifactClaims: [REPORT_RULE],
  }])
  const composition = new ProjectionCapabilityComposer(runtime).compose(undefined)
  const store = new ProjectionCapabilityProvenanceStore(root)

  const pinned = await store.pin(composition.provenance)
  assert.equal(pinned.digest, composition.provenance.digest)
  assert.deepEqual(await store.get(pinned.digest), pinned)
  assert.deepEqual(await store.pin(composition.provenance), pinned)
})
