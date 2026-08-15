import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createDaemonServer } from '../server.js'

async function withDaemon(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-canvas-contract-'))
  const daemon = createDaemonServer({ projectRoot: root })
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

test('daemon health and version routes have one fixed Canvas contract', async () => {
  await withDaemon(async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/health`)).json() as {
      capabilities: {
        canvas: boolean
        pluginArtifactCapabilities: boolean
        nodeSkills: boolean
      }
      canvas: { schemaVersion: number; initializationRequired: boolean }
    }
    assert.deepEqual(health.capabilities, {
      canvas: true,
      pluginArtifactCapabilities: true,
      nodeSkills: true,
    })
    assert.deepEqual(health.canvas, {
      schemaVersion: 2,
      initializationRequired: false,
    })

    const canvas = await fetch(`${baseUrl}/canvas?branch=main`)
    assert.equal(canvas.status, 200)
    assert.equal((await canvas.json() as { document: { schemaVersion: number } })
      .document.schemaVersion, 2)

    const history = await fetch(`${baseUrl}/canvas/history?branch=main`)
    assert.equal(history.status, 200)
    assert.equal((await history.json() as { ok: boolean }).ok, true)
  })
})

test('retired write, artifact path, source, preference, and session routes stay absent', async () => {
  await withDaemon(async (baseUrl) => {
    const requests: Array<[string, RequestInit | undefined]> = [
      ['/canvas', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }],
      ['/canvas/source', undefined],
      ['/canvas/source/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }],
      ['/canvas/source/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }],
      ['/canvas/preferences', undefined],
      ['/canvas/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }],
      ['/artifacts?path=artifacts/a.txt', undefined],
      ['/sessions?nodeId=node-legacy', undefined],
    ]
    for (const [route, init] of requests) {
      const response = await fetch(`${baseUrl}${route}`, init)
      assert.equal(response.status, 404, `${init?.method ?? 'GET'} ${route}`)
      assert.equal(
        (await response.json() as { error: { code: string } }).error.code,
        'not_found',
      )
    }
  })
})

test('legacy snapshot Runs and node-scoped Run history are explicitly gone', async () => {
  await withDaemon(async (baseUrl) => {
    const legacyRun = await fetch(`${baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-legacy',
        agentId: 'codex',
        prompt: 'must not run',
        canvasSnapshot: { nodes: [], edges: [], plugins: [] },
      }),
    })
    assert.equal(legacyRun.status, 410)
    assert.equal(
      (await legacyRun.json() as { error: { code: string } }).error.code,
      'legacy_api_removed',
    )

    const legacyFilteredHistory = await fetch(`${baseUrl}/runs?nodeId=node-legacy`)
    assert.equal(legacyFilteredHistory.status, 410)
    assert.equal(
      (await legacyFilteredHistory.json() as { error: { code: string } }).error.code,
      'legacy_api_removed',
    )

    const runLogDeletion = await fetch(`${baseUrl}/runs/old-run/log`, { method: 'DELETE' })
    assert.equal(runLogDeletion.status, 405)
    assert.equal(
      (await runLogDeletion.json() as { error: { code: string } }).error.code,
      'run_log_delete_unsupported',
    )
  })
})
