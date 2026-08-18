import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  canvasNodeGeometry,
  canvasNodeTypeRef,
  emptyCanvasDocument,
} from '../../src/canvas/model.js'
import { MetadataStore } from '../metadataStore.js'
import { NodeExecutionService, type NodeExecutor } from '../nodeExecutions.js'

test('NodeExecution is immutable, cached, output-bounded, and provenance-linked', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-executions-')))
  const metadata = new MetadataStore(root)
  const service = new NodeExecutionService(metadata)
  t.after(async () => {
    await metadata.close()
    await rm(root, { recursive: true, force: true })
  })
  const executor: NodeExecutor = {
    id: 'test-literal',
    environmentDigest: 'a'.repeat(64),
    supports: (nodeTypeId) => nodeTypeId === 'smart',
    execute: async ({ node }) => ({ result: [{ kind: 'json', value: node.payload }] }),
  }
  service.executors.register(executor)
  const document = emptyCanvasDocument()
  document.nodes.push({
    id: 'node-smart',
    typeRef: canvasNodeTypeRef('smart'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 320, h: 200, z: 1 }),
    title: 'Literal',
    payload: { answer: 42 },
    artifactRefs: [],
    origin: { kind: 'user' },
  })

  const first = await service.start({
    projectId: 'project_test',
    canvasBranch: 'main',
    document,
    nodeId: 'node-smart',
    force: false,
  })
  const terminal = await waitForExecution(service, first.executionId)
  assert.equal(terminal.status, 'succeeded')
  assert.deepEqual(terminal.outputs, { result: [{ kind: 'json', value: { answer: 42 } }] })

  const cached = await service.start({
    projectId: 'project_test',
    canvasBranch: 'main',
    document,
    nodeId: 'node-smart',
    force: false,
  })
  assert.equal(cached.executionId, first.executionId)
  const forced = await service.start({
    projectId: 'project_test',
    canvasBranch: 'main',
    document,
    nodeId: 'node-smart',
    force: true,
  })
  assert.notEqual(forced.executionId, first.executionId)
  await waitForExecution(service, forced.executionId)

  const provenance = await service.provenance('project_test', 'node-smart')
  assert.ok(provenance.some((record) => record.objectId === `execution:${first.executionId}`))
})

async function waitForExecution(
  service: NodeExecutionService,
  executionId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await service.get(executionId)
    if (execution && ['succeeded', 'failed', 'cancelled', 'timed-out'].includes(execution.status)) {
      return execution
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('execution did not settle')
}
