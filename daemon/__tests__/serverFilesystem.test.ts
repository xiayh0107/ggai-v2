import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canvasNodeGeometry, canvasNodeTypeRef } from '../../src/canvas/model.js'
import { createDaemonServer } from '../server.js'

test('filesystem HTTP API keeps paths daemon-only and binds through a Canvas command', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-server-fs-')))
  const files = path.join(root, 'sources')
  await mkdir(files)
  await writeFile(path.join(files, 'README.md'), 'from disk', 'utf8')
  const daemon = createDaemonServer({ projectRoot: root })
  t.after(async () => {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`
  const types = await (await fetch(`${baseUrl}/canvas/node-types`)).json() as {
    nodeTypes: Array<{ id: string; digest: string }>
  }
  assert.ok(types.nodeTypes.some((type) => type.id === 'compute'))
  assert.ok(types.nodeTypes.every((type) => /^[0-9a-f]{64}$/u.test(type.digest)))
  assert.equal((await fetch(
    `${baseUrl}/graph-plans/plan_${'a'.repeat(64)}?projectDir=.&branch=main`,
  )).status, 404)
  const rootResponse = await fetch(`${baseUrl}/workspace/roots?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Sources', path: files }),
  })
  const rootBody = await rootResponse.json() as { root: { rootId: string } }
  assert.equal(rootResponse.status, 201)
  assert.equal(JSON.stringify(rootBody).includes(files), false)
  const tree = await (await fetch(
    `${baseUrl}/filesystem/tree?projectDir=.&rootId=${rootBody.root.rootId}&relativePath=&limit=100`,
  )).json() as { entries: Array<{ relativePath: string }> }
  assert.deepEqual(tree.entries.map((entry) => entry.relativePath), ['README.md'])

  const create = await fetch(`${baseUrl}/canvas/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', baseRevision: 0, mutationId: 'create-file-node',
      command: {
        type: 'CreateNode',
        node: {
          id: 'file-node', typeRef: canvasNodeTypeRef('file'),
          ...canvasNodeGeometry({ x: 0, y: 0, w: 320, h: 200, z: 1 }),
          title: 'README', text: 'stale',
          payload: { rootId: rootBody.root.rootId, relativePath: 'README.md' },
          artifactRefs: [], origin: { kind: 'user' },
        },
      },
    }),
  })
  assert.equal(create.status, 200, await create.text())
  const boundResponse = await fetch(`${baseUrl}/filesystem/bindings?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', baseRevision: 1, mutationId: 'bind-readme', nodeId: 'file-node',
      rootId: rootBody.root.rootId, relativePath: 'README.md', kind: 'file',
      mode: 'fs-authoritative',
    }),
  })
  const bound = await boundResponse.json() as {
    binding: { bindingId: string; state: string }
    canvas: { document: { nodes: Array<{ bindingId?: string; text?: string }> } }
  }
  assert.equal(boundResponse.status, 201, JSON.stringify(bound))
  assert.equal(bound.canvas.document.nodes[0]?.bindingId, bound.binding.bindingId)
  assert.equal(bound.canvas.document.nodes[0]?.text, 'from disk')
  assert.equal(JSON.stringify(bound).includes(files), false)

  const traversal = await fetch(
    `${baseUrl}/filesystem/tree?projectDir=.&rootId=${rootBody.root.rootId}&relativePath=..%2Foutside`,
  )
  assert.equal(traversal.status, 400)
})
