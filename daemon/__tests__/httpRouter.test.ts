import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRunCapabilityReceipt, RunCapabilityReceiptStore } from '../capabilityReceipt.js'
import { AgentRegistry } from '../registry.js'
import { RunLogStore } from '../runLogs.js'
import { createDaemonServer } from '../server.js'

test('bounded HTTP routes preserve health and expose runtime diagnostics', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-http-router-')))
  const registry = new AgentRegistry({ codexCommand: '/definitely/missing/codex' })
  const daemon = createDaemonServer({ projectRoot: root, registry })
  t.after(async () => {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  await listen(daemon.server)
  const port = addressPort(daemon.server.address())

  const health = await getJson(port, '/health')
  assert.equal(health.status, 200)
  assert.deepEqual(health.body, {
    status: 'ok',
    version: 1,
    capabilities: {
      canvas: true,
      pluginArtifactCapabilities: true,
      nodeSkills: true,
    },
    canvas: { schemaVersion: 2, initializationRequired: false },
    projectRoot: root,
  })

  const runtime = await getJson(port, '/runtime')
  assert.equal(runtime.status, 200)
  assert.equal((runtime.body as { profile?: { id?: string } }).profile?.id,
    '@ggai/default-agent-runtime')

  const delegated = await getJson(port, '/projects')
  assert.equal(delegated.status, 200)
  assert.deepEqual(delegated.body, {
    schemaVersion: 1,
    projects: [],
  })

  const invalidPreflight = await requestJson(port, '/task-runs/preflight', 'POST', {
    taskId: 'task-1',
    agentId: 'codex',
    canvasBranch: 'main',
    baseRevision: 0,
    attachments: [],
    providerId: '@private/provider',
  })
  assert.equal(invalidPreflight.status, 400)
  assert.deepEqual(invalidPreflight.body, {
    error: {
      code: 'invalid_task_run_preflight',
      message: 'Task Run preflight request has unsupported fields',
    },
  })

  const missingReproducibility = await getJson(
    port,
    '/task-runs/missing-run/reproducibility',
  )
  assert.equal(missingReproducibility.status, 404)
  assert.deepEqual(missingReproducibility.body, {
    error: { code: 'task_run_not_found', message: 'Task Run does not exist' },
  })
})

test('new routes preserve the localhost CORS boundary', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-http-cors-')))
  const daemon = createDaemonServer({ projectRoot: root })
  t.after(async () => {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  await listen(daemon.server)
  const response = await getJson(addressPort(daemon.server.address()), '/runtime', {
    Origin: 'https://untrusted.example',
  })
  assert.equal(response.status, 403)
  assert.deepEqual(response.body, {
    error: { code: 'origin_denied', message: 'request origin is not allowed' },
  })
})

test('Task Run reproducibility route exposes only the friendly verified read model', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-http-repro-')))
  const runId = 'run-reproducible'
  const receipt = createRunCapabilityReceipt({
    runId,
    profile: {
      schemaVersion: 1,
      id: '@ggai/default-agent-runtime',
      version: '1.0.0',
      bundles: [],
    },
    services: [],
  })
  await new RunCapabilityReceiptStore(root).pin(receipt)
  await new RunLogStore(root).start({
    runId,
    taskId: 'task-reproducible',
    nodeId: 'task-reproducible',
    agentId: 'codex',
    canvasBranch: 'main',
    capabilityReceiptDigest: receipt.digest,
    reproducibilitySnapshot: {
      generationService: 'Codex',
      skillCount: 3,
      attachmentCount: 2,
      capabilityProfileLabel: '默认生成环境',
    },
    status: 'done',
    startedAt: 1,
    finishedAt: 2,
    sessionId: null,
  })
  const daemon = createDaemonServer({ projectRoot: root })
  t.after(async () => {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  await listen(daemon.server)

  const response = await getJson(
    addressPort(daemon.server.address()),
    `/task-runs/${runId}/reproducibility`,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    runId,
    reproducible: true,
    generationService: 'Codex',
    skills: { count: 3 },
    attachments: { count: 2 },
    capabilityProfile: { label: '默认生成环境' },
  })
  assert.equal(JSON.stringify(response.body).includes(receipt.digest), false)
})

function listen(server: ReturnType<typeof createDaemonServer>['server']): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function addressPort(address: string | AddressInfo | null): number {
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port')
  return address.port
}

function getJson(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          })
        } catch (error) {
          reject(error)
        }
      })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

function requestJson(
  port: number,
  pathname: string,
  method: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          })
        } catch (error) {
          reject(error)
        }
      })
    })
    outgoing.once('error', reject)
    outgoing.end(payload)
  })
}
