import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canvasNodeGeometry, canvasNodeTypeRef } from '../../src/canvas/model.js'
import { ComputeExecutor } from '../computeExecutor.js'
import type { ContainerRunRequest, ContainerRuntime } from '../computeRuntime.js'
import { createDaemonServer } from '../server.js'

test('compute HTTP flow exposes capability, requires approval, and never accepts code in execution request', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-server-compute-')))
  const runtime = new HttpFakeRuntime()
  const compute = new ComputeExecutor({
    runtime: async () => runtime,
    diagnostics: async () => ({ available: true, provider: 'docker' }),
  })
  const daemon = createDaemonServer({ projectRoot: root, computeExecutor: compute })
  t.after(async () => {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`
  const diagnostics = await (await fetch(`${baseUrl}/runtime/compute`)).json() as {
    available: boolean
    provider: string
  }
  assert.deepEqual(diagnostics, {
    schemaVersion: 1, available: true, provider: 'docker', presets: ['python-3.13', 'node-24'],
  })
  const create = await fetch(`${baseUrl}/canvas/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', baseRevision: 0, mutationId: 'create-compute',
      command: {
        type: 'CreateNode',
        node: {
          id: 'compute-node', typeRef: canvasNodeTypeRef('compute'),
          ...canvasNodeGeometry({ x: 0, y: 0, w: 420, h: 240, z: 1 }),
          title: 'Compute',
          payload: {
            runtime: 'node-24', code: 'console.log(1)', timeoutMs: 30_000,
            memoryMb: 512, cpus: 1, pids: 64,
          },
          artifactRefs: [], origin: { kind: 'user' },
        },
      },
    }),
  })
  assert.equal(create.status, 200, await create.text())
  const forged = await fetch(`${baseUrl}/nodes/compute-node/executions?projectDir=.&branch=main`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: false, code: 'forged' }),
  })
  assert.equal(forged.status, 400)
  const startedResponse = await fetch(`${baseUrl}/nodes/compute-node/executions?projectDir=.&branch=main`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: false }),
  })
  const started = await startedResponse.json() as { execution: { executionId: string; status: string } }
  assert.equal(startedResponse.status, 202)
  assert.equal(started.execution.status, 'awaiting-approval')
  assert.equal(runtime.runs, 0)
  const approval = await fetch(
    `${baseUrl}/executions/${started.execution.executionId}/approval?projectDir=.&branch=main`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    },
  )
  assert.equal(approval.status, 202, await approval.text())
  let status = 'running'
  for (let attempt = 0; attempt < 100 && status === 'running'; attempt += 1) {
    const history = await (await fetch(
      `${baseUrl}/nodes/compute-node/executions?projectDir=.&branch=main`,
    )).json() as { executions: Array<{ status: string }> }
    status = history.executions[0]?.status ?? 'missing'
    if (status === 'running') await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(status, 'succeeded')
  assert.equal(runtime.runs, 1)
})

class HttpFakeRuntime implements ContainerRuntime {
  readonly id = 'docker' as const
  readonly binaryPath = '/fake/docker'
  runs = 0
  async run(request: ContainerRunRequest) {
    assert.ok(request.args.includes('--read-only'))
    this.runs += 1
  }
  async copyFrom(name: string, source: string, destination: string) {
    assert.ok(name.startsWith('ggai-execution_'))
    assert.equal(source, '/outputs/.')
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'result.json'), '{}', 'utf8')
    await writeFile(path.join(destination, 'execution-result.json'), JSON.stringify({
      schemaVersion: 1, outputs: { result: [{ path: 'result.json' }] },
    }), 'utf8')
  }
  async remove() {}
}
