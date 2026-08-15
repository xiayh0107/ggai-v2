import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { CanvasCommandStoreManager } from '../canvasCommandStoreManager.js'
import { ProjectCatalog } from '../projectCatalog.js'

const PROJECT_ID = 'project_0123456789abcdef0123456789abcdef'

test('a catalog-created project opens as an empty Canvas without a root migration step', async () => {
  const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-canvas-catalog-')))
  const catalog = new ProjectCatalog(projectRoot, { idFactory: () => PROJECT_ID })
  const manager = new CanvasCommandStoreManager({
    projectRoot,
    acquireProjectLease: async (requested) => realpath(
      path.isAbsolute(requested) ? requested : path.resolve(projectRoot, requested),
    ),
  })
  try {
    const created = await catalog.create('新项目')

    const envelope = await manager.get(created.projectDir, 'main')
    assert.equal(envelope.revision, 0)
    assert.equal(envelope.lastCheckpoint, null)
    assert.deepEqual(envelope.document, {
      schemaVersion: 2,
      nodes: [],
      tasks: [],
      collections: [],
      edges: [],
      receipts: [],
      everCreated: false,
    })
  } finally {
    manager.close()
    await catalog.close()
    await rm(projectRoot, { recursive: true, force: true })
  }
})
