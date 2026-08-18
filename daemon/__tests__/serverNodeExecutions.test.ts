import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canvasNodeGeometry, canvasNodeTypeRef } from '../../src/canvas/model.js'
import { createDaemonServer } from '../server.js'

test('NodeExecution HTTP routes accept identity-only requests and expose outputs/provenance', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-server-executions-')))
  const daemon = createDaemonServer({ projectRoot: root })
  t.after(async () => {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  daemon.executions.executors.register({
    id: 'test-http',
    environmentDigest: 'b'.repeat(64),
    supports: (nodeTypeId) => nodeTypeId === 'smart',
    execute: async () => ({ result: [{ kind: 'json', value: { ok: true } }] }),
  })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const create = await fetch(`${baseUrl}/canvas/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main',
      baseRevision: 0,
      mutationId: 'create-smart',
      command: {
        type: 'CreateNode',
        node: {
          id: 'node-smart',
          typeRef: canvasNodeTypeRef('smart'),
          ...canvasNodeGeometry({ x: 0, y: 0, w: 320, h: 200, z: 1 }),
          title: 'Smart',
          payload: { value: 1 },
          artifactRefs: [],
          origin: { kind: 'user' },
        },
      },
    }),
  })
  assert.equal(create.status, 200, await create.text())

  const startedResponse = await fetch(
    `${baseUrl}/nodes/node-smart/executions?projectDir=.&branch=main`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    },
  )
  const started = await startedResponse.json() as { execution: { executionId: string } }
  assert.equal(startedResponse.status, 202)
  let terminal: { status: string } | undefined
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const history = await (await fetch(
      `${baseUrl}/nodes/node-smart/executions?projectDir=.&branch=main`,
    )).json() as { executions: Array<{ status: string }> }
    terminal = history.executions[0]
    if (terminal?.status === 'succeeded') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(terminal?.status, 'succeeded')
  const outputs = await (await fetch(
    `${baseUrl}/executions/${started.execution.executionId}/outputs`,
  )).json() as { outputs: unknown }
  assert.deepEqual(outputs.outputs, { result: [{ kind: 'json', value: { ok: true } }] })
  const provenance = await (await fetch(
    `${baseUrl}/nodes/node-smart/provenance?projectDir=.`,
  )).json() as { records: unknown[] }
  assert.equal(provenance.records.length, 1)
})
