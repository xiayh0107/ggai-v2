import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { RunClosePayload } from '../protocol.js'
import { RunArtifactStore } from '../runArtifactStorage.js'
import { RunLogStore } from '../runLogs.js'
import { createDaemonServer } from '../server.js'

test('artifact catalog HTTP route requires explicit project scope and returns a strict empty page', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-artifact-catalog-http-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  const daemon = createDaemonServer({ projectRoot: root })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  const missingScope = await fetch(`${baseUrl}/artifact-catalog`)
  assert.equal(missingScope.status, 400)
  assert.deepEqual(await missingScope.json(), {
    error: {
      code: 'project_dir_required',
      message: 'projectDir is required for the artifact catalog',
    },
  })

  const response = await fetch(`${baseUrl}/artifact-catalog?projectDir=.`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    schemaVersion: 2,
    artifacts: [],
    truncated: false,
    partial: false,
    nextCursor: null,
  })

  const invalidCursor = await fetch(
    `${baseUrl}/artifact-catalog?projectDir=.&cursor=not-json`,
  )
  assert.equal(invalidCursor.status, 400)
  assert.deepEqual(await invalidCursor.json(), {
    error: {
      code: 'invalid_artifact_catalog_cursor',
      message: 'artifact catalog cursor is invalid or no longer available',
    },
  })
})

test('artifact catalog HTTP route pages verified partial resources that remain previewable', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-artifact-catalog-page-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })

  const runId = 'run-catalog-partial'
  const artifactStore = new RunArtifactStore(root, 'main')
  const location = await artifactStore.prepareRun(runId)
  await writeFile(path.join(location.absoluteFilesRoot, 'a.txt'), 'alpha', 'utf8')
  await writeFile(path.join(location.absoluteFilesRoot, 'b.txt'), 'bravo', 'utf8')
  const closed = await artifactStore.closeRun(runId, { complete: false })
  const close: RunClosePayload = {
    runId,
    status: 'cancelled',
    sessionId: null,
    artifacts: closed.manifest.entries.map((entry) => entry.relativePath),
    artifactsComplete: false,
    artifactManifest: closed.manifest,
  }
  const logs = new RunLogStore(root)
  const running = {
    runId,
    taskId: 'task-catalog-partial',
    nodeId: 'task-catalog-partial',
    agentId: 'codex',
    canvasBranch: 'main',
    status: 'running' as const,
    startedAt: 1,
    sessionId: null,
  }
  await logs.start(running)
  await logs.append(runId, { id: 1, event: 'close', data: close })
  await logs.finish({ ...running, status: 'cancelled', finishedAt: 2 })

  const daemon = createDaemonServer({ projectRoot: root })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  const firstResponse = await fetch(`${baseUrl}/artifact-catalog?projectDir=.&limit=1`)
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json() as {
    artifacts: Array<{ runId: string; artifactId: string; relativePath: string }>
    partial: boolean
    truncated: boolean
    nextCursor: string | null
  }
  assert.equal(first.partial, true)
  assert.equal(first.truncated, true)
  assert.equal(first.artifacts.length, 1)
  assert.ok(first.nextCursor)

  const artifact = first.artifacts[0]!
  const preview = await fetch(
    `${baseUrl}/runs/${artifact.runId}/artifacts/${artifact.artifactId}?projectDir=.`,
  )
  assert.equal(preview.status, 200)
  assert.equal(await preview.text(), artifact.relativePath === 'a.txt' ? 'alpha' : 'bravo')

  const secondResponse = await fetch(
    `${baseUrl}/artifact-catalog?projectDir=.&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  )
  assert.equal(secondResponse.status, 200)
  const second = await secondResponse.json() as {
    artifacts: Array<{ artifactId: string }>
    partial: boolean
    truncated: boolean
    nextCursor: string | null
  }
  assert.equal(second.partial, true)
  assert.equal(second.truncated, false)
  assert.equal(second.nextCursor, null)
  assert.equal(second.artifacts.length, 1)
  assert.notEqual(second.artifacts[0]?.artifactId, artifact.artifactId)
})
