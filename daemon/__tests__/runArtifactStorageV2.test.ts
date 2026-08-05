import assert from 'node:assert/strict'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { artifactIdForV1 } from '../artifactManifestV2.js'
import {
  PluginArtifactClaimRegistryV2,
  RunArtifactStoreV2,
} from '../runArtifactStorageV2.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-run-artifacts-v2-'))
  temporaryDirectories.push(directory)
  return realpath(directory)
}

test('uses the run-owned branch path and closes a verified canonical manifest', async () => {
  const projectDir = await temporaryProject()
  const store = new RunArtifactStoreV2(projectDir, 'main')
  const location = await store.prepareRun('run-1')
  assert.equal(
    location.projectRelativeFilesRoot,
    `artifacts/.branches/${location.branchStorageId}/run-1/files`,
  )
  assert.equal(location.absoluteFilesRoot, path.join(
    projectDir,
    'artifacts',
    '.branches',
    location.branchStorageId,
    'run-1',
    'files',
  ))

  await mkdir(path.join(location.absoluteFilesRoot, 'source'), { recursive: true })
  await writeFile(path.join(location.absoluteFilesRoot, 'preview.png'), 'png-content', 'utf8')
  await writeFile(path.join(location.absoluteFilesRoot, 'source', 'plot.R'), 'plot(1:3)', 'utf8')
  await writeFile(path.join(location.absoluteFilesRoot, 'scratch.tmp'), 'temporary', 'utf8')
  await mkdir(path.join(location.absoluteFilesRoot, '.ggai'), { recursive: true })
  await writeFile(
    path.join(location.absoluteFilesRoot, '.ggai', 'agent-control.json'),
    '{}',
    'utf8',
  )

  const closed = await store.closeRun('run-1')
  assert.equal(closed.manifest.complete, true)
  assert.deepEqual(closed.manifest.entries.map((entry) => entry.relativePath), [
    'preview.png',
    'source/plot.R',
  ])
  assert.deepEqual(closed.manifest.entries.map((entry) => entry.mediaType), [
    'image/png',
    'text/x-r',
  ])
  assert.equal(
    closed.manifest.entries[0]?.artifactId,
    artifactIdForV1('run-1', 'preview.png'),
  )
  assert.match(closed.manifestDigest, /^[0-9a-f]{64}$/u)
  assert.deepEqual(closed.excluded, [
    { relativePath: '.ggai', reason: 'control' },
    { relativePath: 'scratch.tmp', reason: 'temporary' },
  ])
  assert.deepEqual(await store.manifest('run-1'), closed.manifest)

  const persisted = JSON.parse(await readFile(location.absoluteManifestPath, 'utf8')) as unknown
  assert.deepEqual(persisted, closed.manifest)
})

test('lookup verifies content and returns branch-isolated metadata', async () => {
  const projectDir = await temporaryProject()
  const main = new RunArtifactStoreV2(projectDir, 'main')
  const feature = new RunArtifactStoreV2(projectDir, 'feature/a')
  const mainLocation = await main.prepareRun('run-shared')
  const featureLocation = await feature.prepareRun('run-shared')
  await writeFile(path.join(mainLocation.absoluteFilesRoot, 'result.txt'), 'main', 'utf8')
  await writeFile(path.join(featureLocation.absoluteFilesRoot, 'result.txt'), 'feature', 'utf8')
  const mainClosed = await main.closeRun('run-shared')
  const featureClosed = await feature.closeRun('run-shared')
  const artifactId = artifactIdForV1('run-shared', 'result.txt')

  assert.equal(mainClosed.manifest.entries[0]?.artifactId, artifactId)
  assert.equal(featureClosed.manifest.entries[0]?.artifactId, artifactId)
  const mainLookup = await main.lookup('run-shared', artifactId)
  const featureLookup = await feature.lookup('run-shared', artifactId)
  assert.equal(mainLookup?.canvasBranch, 'main')
  assert.equal(featureLookup?.canvasBranch, 'feature/a')
  assert.notEqual(mainLookup?.branchStorageId, featureLookup?.branchStorageId)
  assert.equal(mainLookup?.absolutePath, path.join(mainLocation.absoluteFilesRoot, 'result.txt'))
  assert.equal(featureLookup?.absolutePath, path.join(featureLocation.absoluteFilesRoot, 'result.txt'))
  assert.notEqual(mainLookup?.contentDigest, featureLookup?.contentDigest)
  assert.equal(await feature.lookup('run-shared', `artifact_${'f'.repeat(64)}`), undefined)
  assert.equal(await main.lookup('missing-run', artifactId), undefined)
})

test('excludes symlinks and foreign hardlinks while marking enumeration incomplete', async () => {
  const projectDir = await temporaryProject()
  const outsideDir = await temporaryProject()
  const outsideFile = path.join(outsideDir, 'outside.txt')
  await writeFile(outsideFile, 'outside', 'utf8')
  const store = new RunArtifactStoreV2(projectDir, 'main')
  const location = await store.prepareRun('run-unsafe')
  await writeFile(path.join(location.absoluteFilesRoot, 'safe.txt'), 'safe', 'utf8')
  await symlink(outsideFile, path.join(location.absoluteFilesRoot, 'linked.txt'))
  await link(outsideFile, path.join(location.absoluteFilesRoot, 'hardlinked.txt'))

  const closed = await store.closeRun('run-unsafe')
  assert.equal(closed.manifest.complete, false)
  assert.deepEqual(closed.manifest.entries.map((entry) => entry.relativePath), ['safe.txt'])
  assert.deepEqual(closed.excluded, [
    { relativePath: 'hardlinked.txt', reason: 'foreign' },
    { relativePath: 'linked.txt', reason: 'symlink' },
  ])
})

test('closed manifests are idempotent and reject later artifact mutation', async () => {
  const projectDir = await temporaryProject()
  const store = new RunArtifactStoreV2(projectDir, 'main')
  const location = await store.prepareRun('run-closed')
  const filePath = path.join(location.absoluteFilesRoot, 'result.txt')
  await writeFile(filePath, 'first', 'utf8')
  const first = await store.closeRun('run-closed')
  const replay = await store.closeRun('run-closed')
  assert.equal(replay.manifestDigest, first.manifestDigest)

  await writeFile(filePath, 'changed', 'utf8')
  await assert.rejects(store.closeRun('run-closed'), /already closed/u)
  await assert.rejects(
    store.lookup('run-closed', first.manifest.entries[0]!.artifactId),
    /no longer matches|digest/u,
  )
})

test('rejects symlinked storage roots and never writes through them', async () => {
  const projectDir = await temporaryProject()
  const outsideDir = await temporaryProject()
  await symlink(outsideDir, path.join(projectDir, 'artifacts'))
  const store = new RunArtifactStoreV2(projectDir, 'main')

  await assert.rejects(store.prepareRun('run-escape'), /not a real directory/u)
  await assert.rejects(readFile(path.join(outsideDir, '.branches', 'missing')), /ENOENT/u)
})

test('plugin artifact claims are bounded and selected deterministically', () => {
  const registry = new PluginArtifactClaimRegistryV2([
    { pluginId: 'generic-image', mediaTypes: ['image/*'], priority: 1 },
    { pluginId: 'png-viewer', extensions: ['.png'], mediaTypes: ['image/png'], priority: 2 },
    { pluginId: 'alternate-png', extensions: ['.png'], priority: 2 },
  ])
  const entry = {
    artifactId: artifactIdForV1('run-1', 'preview.png'),
    relativePath: 'preview.png',
    mediaType: 'image/png',
    size: 10,
    contentDigest: 'a'.repeat(64),
  }

  assert.deepEqual(registry.select(entry), {
    pluginId: 'png-viewer',
    priority: 2,
    specificity: 2,
  })
  assert.deepEqual(registry.matches(entry).map((match) => match.pluginId), [
    'png-viewer',
    'alternate-png',
    'generic-image',
  ])
  assert.throws(() => new PluginArtifactClaimRegistryV2([
    { pluginId: 'unsafe', extensions: ['png'] },
  ]), /matchers/u)
  assert.throws(() => new PluginArtifactClaimRegistryV2([
    { pluginId: 'duplicate', extensions: ['.png'] },
    { pluginId: 'duplicate', mediaTypes: ['image/*'] },
  ]), /duplicated/u)
  assert.throws(() => artifactIdForV1('run-1', '../foreign.txt'), /unsafe/u)
})
