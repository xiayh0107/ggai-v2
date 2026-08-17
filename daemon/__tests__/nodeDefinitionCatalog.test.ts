import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NodeDefinitionCatalog } from '../nodeDefinitionCatalog.js'
import { createBlankCustomNodeManifest } from '../../src/node-studio/model.js'

test('node definition catalog appends immutable revisions and survives restart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = new NodeDefinitionCatalog(root)
  const first = await catalog.upsert({
    ...createBlankCustomNodeManifest(new Date('2026-01-01T00:00:00.000Z')),
    id: '@local/research-card',
  })
  assert.equal(first.revision, 1)
  const second = await catalog.upsert({
    ...first,
    label: '研究卡片',
    installed: true,
  })
  assert.equal(second.revision, 2)
  assert.deepEqual((await new NodeDefinitionCatalog(root).list()).map((item) => item.revision), [1, 2])
  const snapshots = await catalog.listSnapshots()
  assert.deepEqual(snapshots.map((item) => item.id), [
    '@local/research-card@1',
    '@local/research-card@2',
  ])
  assert.ok(snapshots.every((item) => /^[0-9a-f]{64}$/u.test(item.digest)))
  await assert.rejects(() => catalog.upsert(first), /revision conflict/u)
  await assert.rejects(() => catalog.delete(first.id), /cannot be deleted/u)
})

test('node definition catalog refuses to follow a catalog symlink', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-outside-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const catalog = new NodeDefinitionCatalog(root)
  await catalog.upsert({ ...createBlankCustomNodeManifest(), id: '@local/safe-card' })
  await rm(catalog.filePath)
  const outsideFile = path.join(outside, 'definitions.json')
  await writeFile(outsideFile, '{"schemaVersion":1,"definitions":[]}\n')
  await symlink(outsideFile, catalog.filePath)
  await assert.rejects(() => catalog.list())
})

test('node definition catalog refuses a workspace parent symlink', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-outside-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  await symlink(outside, path.join(root, '.gg', 'workspace'))
  const catalog = new NodeDefinitionCatalog(root)

  await assert.rejects(() => catalog.upsert({
    ...createBlankCustomNodeManifest(),
    id: '@local/unsafe-parent',
  }), /symlink/u)
  await assert.rejects(() => catalog.list(), /symlink/u)
})
