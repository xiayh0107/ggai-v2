import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canvasNodeGeometry, canvasNodeTypeRef } from '../../src/canvas/model.js'
import { createDaemonServer } from '../server.js'

test('instance HTTP workflow captures, previews, conflicts, resolves, and detaches atomically', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-server-instances-')))
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
  const command = async (baseRevision: number, mutationId: string, canvasCommand: unknown) => {
    const response = await fetch(`${baseUrl}/canvas/commands?projectDir=.`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'main', baseRevision, mutationId, command: canvasCommand }),
    })
    return response
  }
  const group = {
    id: 'source-group', typeRef: canvasNodeTypeRef('group'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 480, h: 300, z: 1 }),
    title: 'Group', payload: {}, artifactRefs: [], origin: { kind: 'user' },
  }
  assert.equal((await command(0, 'create-group', { type: 'CreateNode', node: group })).status, 200)
  const text = {
    id: 'source-text', typeRef: canvasNodeTypeRef('text'),
    ...canvasNodeGeometry({ x: 20, y: 40, w: 320, h: 180, z: 2 }),
    title: 'Text', text: 'A', payload: {}, artifactRefs: [], origin: { kind: 'user' },
  }
  assert.equal((await command(1, 'create-text', { type: 'CreateNode', node: text })).status, 200)
  assert.equal((await command(2, 'reparent-text', {
    type: 'ReparentNodes', nodeIds: ['source-text'], parentId: 'source-group',
  })).status, 200)

  const definitionResponse = await fetch(`${baseUrl}/node-tree-definitions?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', rootNodeId: 'source-group', definitionId: 'card-template',
      title: 'Card', expectedRevision: 0,
      overrideAllowlist: [{ nodeId: 'source-text', field: 'text' }],
      exposedPorts: [{
        key: 'content', nodeId: 'source-text', port: 'content', direction: 'output',
        schema: 'ggai://value/text',
      }],
    }),
  })
  const definition = await definitionResponse.json() as {
    definition: { definitionId: string; revision: number; digest: string }
  }
  assert.equal(definitionResponse.status, 201, JSON.stringify(definition))
  const instanceResponse = await fetch(`${baseUrl}/instances?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', baseRevision: 3, mutationId: 'create-instance',
      nodeId: 'instance-card', definitionId: definition.definition.definitionId,
      revision: 1, overrides: { 'node-0001:text': 'Override' }, x: 600, y: 100,
    }),
  })
  assert.equal(instanceResponse.status, 201, await instanceResponse.text())
  const resolved = await (await fetch(
    `${baseUrl}/instances/instance-card/resolved?projectDir=.&branch=main`,
  )).json() as { resolved: { nodes: Array<{ text?: string }> } }
  assert.ok(resolved.resolved.nodes.some((node) => node.text === 'Override'))

  assert.equal((await command(4, 'edit-source', {
    type: 'UpdateNodeContent', nodeId: 'source-text', patch: { text: 'B' },
  })).status, 200)
  const revision2Response = await fetch(`${baseUrl}/node-tree-definitions?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', rootNodeId: 'source-group', definitionId: 'card-template',
      title: 'Card v2', expectedRevision: 1,
      overrideAllowlist: [{ nodeId: 'source-text', field: 'text' }],
      exposedPorts: [],
    }),
  })
  assert.equal(revision2Response.status, 201, await revision2Response.text())
  const preview = await (await fetch(
    `${baseUrl}/instances/instance-card/update-preview?projectDir=.&branch=main&revision=2`,
  )).json() as { preview: { conflicts: Array<{ code: string }> } }
  assert.deepEqual(preview.preview.conflicts, [
    { code: 'exposed-port-removed', key: 'output:content' },
  ])
  const update = await fetch(`${baseUrl}/instances/instance-card/update?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', baseRevision: 5, mutationId: 'update-instance',
      targetRevision: 2, accept: true,
    }),
  })
  assert.equal(update.status, 409)

  const detach = await command(5, 'detach-instance', {
    type: 'DetachInstance', nodeId: 'instance-card',
  })
  const detached = await detach.json() as {
    document: { nodes: Array<{ id: string; typeRef: { id: string }; instanceRef?: unknown; text?: string }> }
  }
  assert.equal(detach.status, 200, JSON.stringify(detached))
  assert.equal(detached.document.nodes.find((node) => node.id === 'instance-card')?.typeRef.id, 'group')
  assert.equal(detached.document.nodes.some((node) => node.instanceRef), false)
  assert.ok(detached.document.nodes.some((node) => node.text === 'Override'))

  const forged = await command(6, 'forge-instance', {
    type: 'CreateNode',
    node: {
      ...group,
      id: 'forged-instance',
      instanceRef: definition.definition,
    },
  })
  assert.equal(forged.status, 400)
})
