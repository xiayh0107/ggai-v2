import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunArtifactStore } from '../runArtifactStorage.js'
import { RunLogStore } from '../runLogs.js'
import { createDaemonServer, type DaemonServer } from '../server.js'

interface ArtifactServerFixture {
  root: string
  baseUrl: string
  daemon: DaemonServer
  runId: string
  artifactId: string
  artifactPath: string
  close(): Promise<void>
}

async function startArtifactServer(): Promise<ArtifactServerFixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-artifact-stream-http-')))
  await mkdir(path.join(root, '.gg'), { recursive: true })

  const runId = 'run-stream-secure'
  const store = new RunArtifactStore(root, 'main')
  const location = await store.prepareRun(runId)
  const artifactPath = path.join(location.absoluteFilesRoot, 'result.txt')
  await writeFile(artifactPath, '0123456789', 'utf8')
  const closed = await store.closeRun(runId)
  const artifactId = closed.manifest.entries[0]!.artifactId
  await new RunLogStore(root).start({
    runId,
    taskId: 'task-stream-secure',
    nodeId: 'task-stream-secure',
    agentId: 'codex',
    canvasBranch: 'main',
    status: 'done',
    startedAt: 1,
    finishedAt: 2,
    sessionId: null,
  })

  const daemon = createDaemonServer({ projectRoot: root })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  return {
    root,
    daemon,
    runId,
    artifactId,
    artifactPath,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await daemon.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('artifact streaming preserves HEAD and single byte-range behavior', async () => {
  const fixture = await startArtifactServer()
  const url = `${fixture.baseUrl}/runs/${fixture.runId}/artifacts/${fixture.artifactId}`
  try {
    const head = await fetch(url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), '10')
    assert.equal(head.headers.get('accept-ranges'), 'bytes')
    assert.equal(await head.text(), '')

    const range = await fetch(url, { headers: { Range: 'bytes=2-5' } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), 'bytes 2-5/10')
    assert.equal(range.headers.get('content-length'), '4')
    assert.equal(await range.text(), '2345')

    const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } })
    assert.equal(suffix.status, 206)
    assert.equal(await suffix.text(), '789')

    const unsatisfiable = await fetch(url, { headers: { Range: 'bytes=20-30' } })
    assert.equal(unsatisfiable.status, 416)
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10')
    assert.equal(await unsatisfiable.text(), '')
  } finally {
    await fixture.close()
  }
})

test('artifact lookup does not expose filesystem paths when integrity verification fails', async () => {
  const fixture = await startArtifactServer()
  const url = `${fixture.baseUrl}/runs/${fixture.runId}/artifacts/${fixture.artifactId}`
  try {
    const outsidePath = path.join(fixture.root, 'outside.txt')
    await writeFile(outsidePath, 'abcdefghij', 'utf8')
    await rm(fixture.artifactPath)
    await symlink(outsidePath, fixture.artifactPath)

    const response = await fetch(url)
    assert.equal(response.status, 409)
    const body = await response.json() as { error: { code: string; message: string } }
    assert.deepEqual(body, {
      error: {
        code: 'artifact_integrity_error',
        message: 'artifact no longer matches its closed manifest',
      },
    })
    assert.equal(body.error.message.includes(fixture.root), false)
  } finally {
    await fixture.close()
  }
})

for (const replacement of ['symlink', 'regular-file'] as const) {
  test(`artifact streaming fails closed when ${replacement} replaces the path after lookup`, async () => {
    const fixture = await startArtifactServer()
    const url = `${fixture.baseUrl}/runs/${fixture.runId}/artifacts/${fixture.artifactId}`
    const originalLookup = fixture.daemon.runs.lookupRunArtifact.bind(fixture.daemon.runs)
    let raced = false
    fixture.daemon.runs.lookupRunArtifact = async (runId, artifactId, projectDir) => {
      const artifact = await originalLookup(runId, artifactId, projectDir)
      if (artifact && !raced) {
        raced = true
        await rm(artifact.absolutePath)
        if (replacement === 'symlink') {
          const outsidePath = path.join(fixture.root, 'outside.txt')
          await writeFile(outsidePath, 'abcdefghij', 'utf8')
          await symlink(outsidePath, artifact.absolutePath)
        } else {
          // Same size as the manifest-bound content, but a different digest.
          await writeFile(artifact.absolutePath, 'abcdefghij', 'utf8')
        }
      }
      return artifact
    }

    try {
      const response = await fetch(url)
      assert.equal(response.status, 409)
      const body = await response.json() as { error: { code: string; message: string } }
      assert.deepEqual(body, {
        error: {
          code: 'artifact_integrity_error',
          message: 'artifact no longer matches its closed manifest',
        },
      })
      assert.equal(body.error.message.includes(fixture.root), false)
    } finally {
      await fixture.close()
    }
  })
}
