import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { canvasNodeGeometry, canvasNodeTypeRef } from '../../src/canvas/model.js'
import { CanvasCommandStoreManager } from '../canvasCommandStoreManager.js'
import { FilesystemService, paginateFilesystemNames } from '../filesystemService.js'
import { MetadataStore } from '../metadataStore.js'

test('workspace roots stay opaque and tree listing is cursor-bounded', async (t) => {
  const harness = await filesystemHarness(t)
  for (let index = 0; index < 250; index += 1) {
    await writeFile(path.join(harness.filesRoot, `file-${String(index).padStart(3, '0')}.txt`), '', 'utf8')
  }
  const root = await harness.service.createRoot({
    projectId: harness.projectId, displayName: 'Sources', requestedPath: harness.filesRoot,
  })
  assert.equal('canonicalPath' in root, false)
  assert.equal(JSON.stringify(root).includes(harness.filesRoot), false)
  const first = await harness.service.tree({
    projectId: harness.projectId, rootId: root.rootId, relativePath: '', limit: 100,
  })
  assert.equal(first.entries.length, 100)
  assert.ok(first.nextCursor)
  const second = await harness.service.tree({
    projectId: harness.projectId, rootId: root.rootId, relativePath: '',
    cursor: first.nextCursor!, limit: 100,
  })
  assert.equal(second.entries.length, 100)
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.relativePath)).size, 200)
  await assert.rejects(harness.service.tree({
    projectId: harness.projectId, rootId: root.rootId, relativePath: '../escape',
  }), /relative path/u)
})

test('100k lazy names produce one 100-item page without Canvas materialization', () => {
  const names = Array.from({ length: 100_000 }, (_, index) =>
    `item-${String(index).padStart(6, '0')}`)
  const page = paginateFilesystemNames(names, 'item-049999', 100)
  assert.equal(page.length, 100)
  assert.equal(page[0], 'item-050000')
  assert.equal(page.at(-1), 'item-050099')
})

test('fs-authoritative binding updates Canvas and follows an inode-preserving rename', async (t) => {
  const harness = await filesystemHarness(t)
  const filePath = path.join(harness.filesRoot, 'notes.md')
  await writeFile(filePath, 'disk A', 'utf8')
  const root = await harness.service.createRoot({
    projectId: harness.projectId, displayName: 'Sources', requestedPath: harness.filesRoot,
  })
  const created = await createNode(harness.canvas, 'file-node', 'canvas stale')
  const binding = await harness.service.createBinding({
    projectId: harness.projectId,
    canvasProjectDir: harness.projectRoot,
    canvasBranch: 'main',
    document: created.document,
    nodeId: 'file-node',
    rootId: root.rootId,
    relativePath: 'notes.md',
    kind: 'file',
    mode: 'fs-authoritative',
  })
  await harness.canvas.commit(
    '.', 'main', created.revision, 'bind-file-node', binding.command,
  )
  const synced = await harness.service.reconcile(binding.binding.bindingId, harness.projectId)
  assert.equal(synced.state, 'clean')
  assert.equal((await harness.canvas.get('.', 'main')).document.nodes[0]?.text, 'disk A')

  await rename(filePath, path.join(harness.filesRoot, 'Notes.md'))
  await waitFor(async () => (await harness.metadata.getFilesystemBinding(binding.binding.bindingId))
    ?.relativePath === 'Notes.md')
  assert.equal((await harness.metadata.getFilesystemBinding(binding.binding.bindingId))?.state, 'clean')
  await rm(path.join(harness.filesRoot, 'Notes.md'))
  await waitFor(async () => (await harness.metadata.getFilesystemBinding(binding.binding.bindingId))
    ?.state === 'missing')
})

test('bidirectional A-to-B and A-to-C creates an explicit conflict without timestamp LWW', async (t) => {
  const harness = await filesystemHarness(t)
  const filePath = path.join(harness.filesRoot, 'story.md')
  await writeFile(filePath, 'A', 'utf8')
  const root = await harness.service.createRoot({
    projectId: harness.projectId, displayName: 'Sources', requestedPath: harness.filesRoot,
  })
  const created = await createNode(harness.canvas, 'story-node', 'A')
  const binding = await harness.service.createBinding({
    projectId: harness.projectId,
    canvasProjectDir: harness.projectRoot,
    canvasBranch: 'main',
    document: created.document,
    nodeId: 'story-node',
    rootId: root.rootId,
    relativePath: 'story.md',
    kind: 'file',
    mode: 'bidirectional',
  })
  const attached = await harness.canvas.commit(
    '.', 'main', created.revision, 'bind-story-node', binding.command,
  )
  await harness.canvas.commit('.', 'main', attached.revision, 'edit-story-node', {
    type: 'UpdateNodeContent', nodeId: 'story-node', patch: { text: 'B' },
  })
  await writeFile(filePath, 'C', 'utf8')
  await harness.service.reconcile(binding.binding.bindingId, harness.projectId)
  const conflicts = await harness.service.listConflicts(harness.projectId)
  assert.equal(conflicts.length, 1)
  const current = await harness.canvas.get('.', 'main')
  assert.equal(current.document.nodes[0]?.text, 'B')
  assert.equal((await harness.metadata.getFilesystemBinding(binding.binding.bindingId))?.state, 'conflict')
  await assert.rejects(harness.service.save({
    projectId: harness.projectId,
    bindingId: binding.binding.bindingId,
    document: current.document,
  }), /both changed|conflict/u)
  assert.equal(await readFile(filePath, 'utf8'), 'C')
})

test('Canvas save uses digest CAS and suppresses its watcher echo', async (t) => {
  const harness = await filesystemHarness(t)
  const filePath = path.join(harness.filesRoot, 'save.ts')
  await writeFile(filePath, 'A', 'utf8')
  const root = await harness.service.createRoot({
    projectId: harness.projectId, displayName: 'Sources', requestedPath: harness.filesRoot,
  })
  const created = await createNode(harness.canvas, 'save-node', 'A')
  const binding = await harness.service.createBinding({
    projectId: harness.projectId,
    canvasProjectDir: harness.projectRoot,
    canvasBranch: 'main', document: created.document, nodeId: 'save-node',
    rootId: root.rootId, relativePath: 'save.ts', kind: 'file', mode: 'bidirectional',
  })
  const attached = await harness.canvas.commit(
    '.', 'main', created.revision, 'bind-save-node', binding.command,
  )
  const edited = await harness.canvas.commit('.', 'main', attached.revision, 'edit-save-node', {
    type: 'UpdateNodeContent', nodeId: 'save-node', patch: { text: 'B' },
  })
  const saved = await harness.service.save({
    projectId: harness.projectId,
    bindingId: binding.binding.bindingId,
    document: edited.document,
  })
  assert.equal(saved.state, 'clean')
  assert.equal(await readFile(filePath, 'utf8'), 'B')
  await waitFor(async () => (await harness.metadata.getFilesystemBinding(binding.binding.bindingId))
    ?.echoToken === null)
  assert.equal((await harness.canvas.get('.', 'main')).document.nodes[0]?.text, 'B')
})

async function filesystemHarness(t: TestContext) {
  const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-filesystem-')))
  const filesRoot = path.join(projectRoot, 'files')
  await mkdir(filesRoot)
  const metadata = new MetadataStore(projectRoot)
  const canvas = new CanvasCommandStoreManager({
    projectRoot,
    acquireProjectLease: async (requested) => realpath(
      path.isAbsolute(requested) ? requested : path.resolve(projectRoot, requested),
    ),
  })
  const service = new FilesystemService(metadata, canvas)
  t.after(async () => {
    await service.close()
    canvas.close()
    await metadata.close()
    await rm(projectRoot, { recursive: true, force: true })
  })
  return { projectRoot, filesRoot, metadata, canvas, service, projectId: 'project-filesystem' }
}

async function createNode(canvas: CanvasCommandStoreManager, nodeId: string, text: string) {
  return canvas.commit('.', 'main', 0, `create-${nodeId}`, {
    type: 'CreateNode',
    node: {
      id: nodeId,
      typeRef: canvasNodeTypeRef('file'),
      ...canvasNodeGeometry({ x: 0, y: 0, w: 320, h: 200, z: 1 }),
      title: nodeId,
      text,
      payload: { rootId: '', relativePath: '' },
      artifactRefs: [],
      origin: { kind: 'user' },
    },
  })
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
