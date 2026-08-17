import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { applyCanvasCommand } from '../../src/canvas/commands.js'
import { canvasOrderKey, emptyCanvasDocument, type CanvasDocument, type CanvasNode } from '../../src/canvas/model.js'
import { InstanceService } from '../instanceService.js'
import { NodeTreeCatalog } from '../nodeTreeCatalog.js'
import { builtinNodeTypeSnapshots } from '../nodeTypeSnapshots.js'

test('definition revisions are immutable and instances resolve pinned overrides without copying base nodes', async (t) => {
  const { service, catalog } = await harness(t)
  const source = sourceDocument('A')
  const definition = await service.capture({
    document: source,
    rootNodeId: 'group',
    definitionId: 'card-template',
    title: 'Card',
    expectedRevision: 0,
    overrideAllowlist: [{ nodeId: 'text', field: 'text' }],
    exposedPorts: [{
      key: 'content', nodeId: 'text', port: 'content', direction: 'output',
      schema: 'ggai://value/text',
    }],
  })
  assert.equal(definition.revision, 1)
  assert.match(definition.digest, /^[0-9a-f]{64}$/u)
  assert.deepEqual(definition.nodes.map((node) => node.key), ['root', 'node-0001'])
  const instance = await service.createInstanceNode({
    nodeId: 'instance-card', definitionId: 'card-template', revision: 1,
    overrides: { 'node-0001:text': 'Override' }, x: 100, y: 200,
  })
  const document = emptyCanvasDocument()
  document.nodes.push(instance)
  assert.equal(document.nodes.length, 1)
  const resolved = await service.resolveDocument(document)
  assert.equal(resolved.nodes.length, 2)
  assert.equal(resolved.nodes.find((node) => node.typeRef.id === 'text')?.text, 'Override')
  assert.equal(resolved.nodes.find((node) => node.id === instance.id)?.transform.matrix[4], 100)

  source.nodes.find((node) => node.id === 'text')!.text = 'B'
  const revision2 = await service.capture({
    document: source,
    rootNodeId: 'group', definitionId: 'card-template', title: 'Card v2',
    expectedRevision: 1,
    overrideAllowlist: [{ nodeId: 'text', field: 'text' }],
    exposedPorts: [],
  })
  assert.equal(revision2.revision, 2)
  const pinned = await catalog.get('card-template', 1)
  assert.equal(pinned?.nodes.find((node) => node.key === 'node-0001')?.text, 'A')
  const preview = await service.previewUpdate(instance, 2)
  assert.deepEqual(preview.conflicts, [
    { code: 'exposed-port-removed', key: 'output:content' },
  ])
  const revision3 = await service.capture({
    document: source,
    rootNodeId: 'group', definitionId: 'card-template', title: 'Card v3',
    expectedRevision: 2,
    overrideAllowlist: [{ nodeId: 'text', field: 'text' }],
    exposedPorts: [{
      key: 'content', nodeId: 'text', port: 'content', direction: 'output',
      schema: 'ggai://value/text',
    }],
  })
  assert.equal((await service.previewUpdate(instance, 3)).conflicts.length, 0)
  assert.equal((await service.updateInstanceNode(instance, 3)).instanceRef?.digest, revision3.digest)
})

test('unknown overrides are rejected and detach atomically rewrites exposed external ports', async (t) => {
  const { service } = await harness(t)
  const definition = await service.capture({
    document: sourceDocument('A'), rootNodeId: 'group', definitionId: 'detach-template',
    title: 'Detach', expectedRevision: 0,
    overrideAllowlist: [{ nodeId: 'text', field: 'text' }],
    exposedPorts: [{
      key: 'content', nodeId: 'text', port: 'content', direction: 'output',
      schema: 'ggai://value/text',
    }],
  })
  await assert.rejects(service.createInstanceNode({
    nodeId: 'bad-instance', definitionId: definition.definitionId, revision: 1,
    overrides: { 'node-0001:title': 'Denied' }, x: 0, y: 0,
  }), /allowlisted/u)
  const instance = await service.createInstanceNode({
    nodeId: 'instance-detach', definitionId: definition.definitionId, revision: 1,
    overrides: { 'node-0001:text': 'Detached' }, x: 40, y: 50,
  })
  const document = emptyCanvasDocument()
  document.nodes.push(instance, node('target', 'text', null, 1, 'Target'))
  document.edges.push({
    id: 'edge-external',
    from: { kind: 'node', id: instance.id, port: 'content' },
    to: { kind: 'node', id: 'target', port: 'content-in' },
    relation: 'data', contextRole: 'none', orderKey: canvasOrderKey(0),
    origin: { kind: 'user' },
  })
  const expansion = await service.detachExpansion(document, instance.id)
  const detached = applyCanvasCommand(document, {
    type: 'DetachInstance', nodeId: instance.id, expansion,
  })
  assert.equal(detached.nodes.find((entry) => entry.id === instance.id)?.typeRef.id, 'group')
  const detachedText = detached.nodes.find((entry) => entry.text === 'Detached')!
  assert.equal(detachedText.parentId, instance.id)
  assert.deepEqual(detached.edges.find((edge) => edge.id === 'edge-external')?.from, {
    kind: 'node', id: detachedText.id, port: 'content',
  })
  assert.equal(detached.nodes.some((entry) => entry.instanceRef), false)
})

test('nested NodeTreeDefinition cycles are rejected before a revision is appended', async (t) => {
  const { service, catalog } = await harness(t)
  const definitionA = await service.capture({
    document: sourceDocument('A'), rootNodeId: 'group', definitionId: 'definition-a',
    title: 'A', expectedRevision: 0, overrideAllowlist: [], exposedPorts: [],
  })
  const instanceA = await service.createInstanceNode({
    nodeId: 'instance-a', definitionId: definitionA.definitionId, revision: 1,
    overrides: {}, x: 0, y: 0,
  })
  const documentB = emptyCanvasDocument()
  documentB.nodes.push(instanceA)
  const definitionB = await service.capture({
    document: documentB, rootNodeId: instanceA.id, definitionId: 'definition-b',
    title: 'B', expectedRevision: 0, overrideAllowlist: [], exposedPorts: [],
  })
  const instanceB = await service.createInstanceNode({
    nodeId: 'instance-b', definitionId: definitionB.definitionId, revision: 1,
    overrides: {}, x: 0, y: 0,
  })
  const cycle = emptyCanvasDocument()
  cycle.nodes.push(instanceB)
  await assert.rejects(service.capture({
    document: cycle, rootNodeId: instanceB.id, definitionId: 'definition-a',
    title: 'A2', expectedRevision: 1, overrideAllowlist: [], exposedPorts: [],
  }), /cycle/u)
  assert.equal((await catalog.get('definition-a'))?.revision, 1)
})

async function harness(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-instances-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = new NodeTreeCatalog(root)
  const service = new InstanceService(catalog, async () => builtinNodeTypeSnapshots())
  return { root, catalog, service }
}

function sourceDocument(text: string): CanvasDocument {
  const document = emptyCanvasDocument()
  document.nodes.push(
    node('group', 'group', null, 0, 'Group'),
    node('text', 'text', 'group', 0, 'Text', text),
  )
  return document
}

function node(
  id: string,
  typeId: string,
  parentId: string | null,
  order: number,
  title: string,
  text?: string,
): CanvasNode {
  const type = builtinNodeTypeSnapshots().find((candidate) => candidate.id === typeId)!
  return {
    id,
    typeRef: { id: type.id, revision: type.revision, digest: type.digest },
    parentId,
    orderKey: canvasOrderKey(order),
    bounds: { w: type.defaultWidth, h: 200 },
    transform: { matrix: [1, 0, 0, 1, order * 20, order * 30] },
    title,
    ...(text === undefined ? {} : { text }),
    payload: {}, artifactRefs: [], origin: { kind: 'user' },
  }
}
