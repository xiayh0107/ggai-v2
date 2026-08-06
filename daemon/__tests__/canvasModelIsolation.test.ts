import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { CanvasModelMode } from '../canvasModelMode.js'
import { createDaemonServer } from '../server.js'

async function withDaemon(
  mode: CanvasModelMode,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), `ggai-model-${mode}-`))
  const daemon = createDaemonServer({ projectRoot: root, canvasModel: mode })
  try {
    await new Promise<void>((resolve, reject) => {
      daemon.server.once('error', reject)
      daemon.server.listen(0, '127.0.0.1', resolve)
    })
    const address = daemon.server.address() as AddressInfo
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('V1 mode advertises its actual schema and rejects every V2 write path', async () => {
  await withDaemon('v1', async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/health`)).json() as {
      capabilities: { canvasModelV1: boolean; canvasModelV2: boolean }
      canvas: { model: string; schemaVersion: number; resetRequired: boolean }
    }
    assert.deepEqual(health.capabilities, { canvasModelV1: true, canvasModelV2: false })
    assert.deepEqual(health.canvas, { model: 'v1', schemaVersion: 1, resetRequired: false })

    const canvas = await fetch(`${baseUrl}/canvas/v2`)
    assert.equal(canvas.status, 409)
    assert.equal((await canvas.json() as { error: { code: string } }).error.code, 'canvas_model_mismatch')

    const run = await fetch(`${baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        runId: 'run-v2-rejected',
        taskId: 'task-v2-rejected',
        agentId: 'codex',
        canvasBranch: 'main',
        baseRevision: 0,
        prompt: 'must not run',
        attachments: [],
        materializationPolicy: 'auto',
      }),
    })
    assert.equal(run.status, 409)
    assert.equal((await run.json() as { error: { code: string } }).error.code, 'canvas_model_mismatch')
  })
})

test('V2 mode rejects legacy canvas, path artifact, and snapshot Run APIs', async () => {
  await withDaemon('v2', async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/health`)).json() as {
      capabilities: { canvasModelV1: boolean; canvasModelV2: boolean }
      canvas: { model: string; schemaVersion: number }
    }
    assert.deepEqual(health.capabilities, { canvasModelV1: false, canvasModelV2: true })
    assert.equal(health.canvas.model, 'v2')
    assert.equal(health.canvas.schemaVersion, 2)

    for (const route of ['/canvas', '/canvas/history', '/artifacts?path=artifacts/a.txt']) {
      const response = await fetch(`${baseUrl}${route}`)
      assert.equal(response.status, 409, route)
      assert.equal(
        (await response.json() as { error: { code: string } }).error.code,
        'canvas_model_mismatch',
      )
    }

    const legacyRun = await fetch(`${baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(legacyRun.status, 409)
    assert.equal(
      (await legacyRun.json() as { error: { code: string } }).error.code,
      'canvas_model_mismatch',
    )

    const sharedHistory = await fetch(`${baseUrl}/runs?limit=1`)
    assert.equal(sharedHistory.status, 200)
    const legacyFilteredHistory = await fetch(`${baseUrl}/runs?nodeId=node-legacy`)
    assert.equal(legacyFilteredHistory.status, 409)
  })
})
