import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canvasSnapshotPath } from '../canvasStore.js'
import { createDaemonServer, type DaemonServer } from '../server.js'
import type { WorkspaceMergeExpectation } from '../workspaceVersioning.js'

interface Fixture {
  root: string
  baseUrl: string
  daemon: DaemonServer
  close(): Promise<void>
}

async function startDaemon(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-canvas-http-'))
  const daemon = createDaemonServer({ projectRoot: root })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  return {
    root,
    baseUrl: `http://127.0.0.1:${address.port}`,
    daemon,
    async close() {
      await daemon.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function document(title = 'Persistent node') {
  return {
    schemaVersion: 1,
    nodes: [{
      id: 'node_1',
      type: 'text',
      x: 0,
      y: 0,
      w: 320,
      h: 120,
      title,
      instruction: {
        phase: 'done',
        prompt: '',
        attachments: [],
        sources: [],
        open: false,
      },
      payload: {},
    }],
    edges: [],
    everCreated: true,
    generationByNodeId: {
      node_1: {
        epoch: 1,
        current: { key: 'finishing', kind: 'finishing', label: '完成' },
        recent: [],
        log: [{ kind: 'info', text: 'done (end_turn)' }],
      },
    },
    latestRunByNodeId: {},
    runRefsByNodeId: {},
  }
}

test('GET/PUT canvas persists state and reports compact revision conflicts', async () => {
  const fixture = await startDaemon()
  try {
    const canvasUrl = `${fixture.baseUrl}/canvas?projectDir=.&branch=main`
    const initial = await fetch(canvasUrl)
    assert.equal(initial.status, 200)
    const empty = await initial.json() as { revision: number; document: { nodes: unknown[] } }
    assert.equal(empty.revision, 0)
    assert.deepEqual(empty.document.nodes, [])

    const request = {
      baseRevision: 0,
      mutationId: 'mutation-http-1',
      changeKind: 'autosave',
      document: document(),
    }
    const savedResponse = await fetch(canvasUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    const savedText = await savedResponse.text()
    assert.equal(savedResponse.status, 200, savedText)
    const saved = JSON.parse(savedText) as { revision: number; document: ReturnType<typeof document> }
    assert.equal(saved.revision, 1)
    assert.equal(saved.document.nodes[0]?.title, 'Persistent node')
    assert.equal(saved.document.generationByNodeId.node_1?.log[0]?.text, 'done (end_turn)')

    const loaded = await fetch(canvasUrl).then((response) => response.json()) as typeof saved
    assert.deepEqual(loaded, saved)
    const onDisk = JSON.parse(await readFile(canvasSnapshotPath(fixture.root, 'main'), 'utf8')) as {
      revision: number
    }
    assert.equal(onDisk.revision, 1)

    const conflict = await fetch(canvasUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, mutationId: 'mutation-http-2' }),
    })
    assert.equal(conflict.status, 409)
    const conflictBody = await conflict.json() as {
      error: { code: string; currentRevision: number }
    }
    assert.deepEqual(conflictBody, {
      error: {
        code: 'canvas_revision_conflict',
        message: 'Canvas revision changed; current revision is 1',
        currentRevision: 1,
      },
    })
  } finally {
    await fixture.close()
  }
})

test('canvas endpoint validates schema, branch, project scope, and CORS methods', async () => {
  const fixture = await startDaemon()
  try {
    const preflight = await fetch(`${fixture.baseUrl}/canvas`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    })
    assert.equal(preflight.status, 204)
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PUT/u)
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /DELETE/u)

    const invalid = await fetch(`${fixture.baseUrl}/canvas`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 0,
        mutationId: 'invalid-1',
        changeKind: 'autosave',
        document: { ...document(), schemaVersion: 2 },
      }),
    })
    assert.equal(invalid.status, 400)

    assert.equal((await fetch(`${fixture.baseUrl}/canvas?branch=../escape`)).status, 400)
    assert.equal((await fetch(`${fixture.baseUrl}/canvas?projectDir=..`)).status, 403)
  } finally {
    await fixture.close()
  }
})

test('daemon close also gates the canvas manager', async () => {
  const fixture = await startDaemon()
  try {
    await fixture.daemon.close()
    await assert.rejects(
      fixture.daemon.canvases.get('.', 'main'),
      /shutting down/,
    )
  } finally {
    await fixture.close()
  }
})

test('canvas versioning routes expose branches, history, restore, source state, and preferences', async () => {
  const fixture = await startDaemon()
  try {
    const canvasUrl = `${fixture.baseUrl}/canvas?projectDir=.&branch=main`
    const saved = await fetch(canvasUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 0,
        mutationId: 'version-route-save',
        changeKind: 'node-created',
        document: document('Versioned node'),
      }),
    })
    assert.equal(saved.status, 200)

    const checkpointResponse = await fetch(`${fixture.baseUrl}/canvas/checkpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', branch: 'main', reason: 'route test' }),
    })
    assert.equal(checkpointResponse.status, 200)
    const checkpoint = await checkpointResponse.json() as {
      ok: boolean
      value: { checkpoint: { commit: string } }
    }
    assert.equal(checkpoint.ok, true)
    assert.match(checkpoint.value.checkpoint.commit, /^[0-9a-f]{40,64}$/u)

    const createResponse = await fetch(`${fixture.baseUrl}/canvas/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', name: 'feature/http', fromBranch: 'main' }),
    })
    assert.equal(createResponse.status, 200)
    const created = await createResponse.json() as { ok: boolean }
    assert.equal(created.ok, true)

    const branches = await fetch(`${fixture.baseUrl}/canvas/branches?projectDir=.`)
      .then((response) => response.json()) as {
        ok: boolean
        value: Array<{ name: string }>
      }
    assert.equal(branches.ok, true)
    assert.deepEqual(branches.value.map((entry) => entry.name).sort(), ['feature/http', 'main'])

    const history = await fetch(
      `${fixture.baseUrl}/canvas/history?projectDir=.&branch=main&limit=10`,
    ).then((response) => response.json()) as {
      ok: boolean
      value: { entries: Array<{ commit: string }> }
    }
    assert.equal(history.ok, true)
    assert.equal(history.value.entries[0]?.commit, checkpoint.value.checkpoint.commit)

    const restoreResponse = await fetch(`${fixture.baseUrl}/canvas/restores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectDir: '.',
        sourceBranch: 'main',
        checkpoint: checkpoint.value.checkpoint.commit,
        newBranch: 'restore/http',
      }),
    })
    assert.equal(restoreResponse.status, 200)
    assert.equal((await restoreResponse.json() as { ok: boolean }).ok, true)
    const restoredCanvas = await fetch(
      `${fixture.baseUrl}/canvas?projectDir=.&branch=restore%2Fhttp`,
    ).then((response) => response.json()) as { document: ReturnType<typeof document> }
    assert.equal(restoredCanvas.document.nodes[0]?.title, 'Versioned node')

    const source = await fetch(`${fixture.baseUrl}/canvas/source?projectDir=.`)
      .then((response) => response.json()) as { status: string }
    assert.equal(source.status, 'unavailable')

    const defaultPreferences = await fetch(`${fixture.baseUrl}/canvas/preferences?projectDir=.`)
      .then((response) => response.json()) as { automationMode: string }
    assert.equal(defaultPreferences.automationMode, 'confirm')
    const updatedPreferences = await fetch(`${fixture.baseUrl}/canvas/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', automationMode: 'auto' }),
    })
    assert.equal(updatedPreferences.status, 200)
    assert.equal(
      (await updatedPreferences.json() as { automationMode: string }).automationMode,
      'auto',
    )
  } finally {
    await fixture.close()
  }
})

test('canvas merge routes preview changes and require explicit execution confirmation', async () => {
  const fixture = await startDaemon()
  try {
    const mainUrl = `${fixture.baseUrl}/canvas?projectDir=.&branch=main`
    await fetch(mainUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 0,
        mutationId: 'merge-http-base',
        changeKind: 'node-created',
        document: document('Base'),
      }),
    })
    await fetch(`${fixture.baseUrl}/canvas/checkpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', branch: 'main', reason: 'merge base' }),
    })
    const created = await fetch(`${fixture.baseUrl}/canvas/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', name: 'feature/merge-http' }),
    }).then((response) => response.json()) as {
      ok: boolean
      value: { canvas: { revision: number } }
    }
    assert.ok(created.ok)
    const featureUrl = `${fixture.baseUrl}/canvas?projectDir=.&branch=feature%2Fmerge-http`
    const updatedResponse = await fetch(featureUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRevision: created.value.canvas.revision,
        mutationId: 'merge-http-feature',
        changeKind: 'node-updated',
        document: document('Feature'),
      }),
    })
    assert.equal(updatedResponse.status, 200)
    const updated = await updatedResponse.json() as { revision: number }

    const mergeBody = {
      projectDir: '.',
      sourceBranch: 'feature/merge-http',
      targetBranch: 'main',
    }
    const preview = await fetch(`${fixture.baseUrl}/canvas/merges/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mergeBody),
    }).then((response) => response.json()) as {
      ok: boolean
      value: { state: string; expectation: WorkspaceMergeExpectation }
    }
    assert.ok(preview.ok)
    assert.equal(preview.value.state, 'ready')

    const missingConfirmation = await fetch(`${fixture.baseUrl}/canvas/merges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mergeBody),
    })
    assert.equal(missingConfirmation.status, 400)

    const denied = await fetch(`${fixture.baseUrl}/canvas/merges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...mergeBody,
        confirmed: false,
        expected: preview.value.expectation,
      }),
    }).then((response) => response.json()) as { ok: boolean; error: { code: string } }
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'merge_confirmation_required')

    const changedResponse = await fetch(featureUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRevision: updated.revision,
        mutationId: 'merge-http-feature-after-preview',
        changeKind: 'node-updated',
        document: document('Feature after preview'),
      }),
    })
    assert.equal(changedResponse.status, 200)

    const stale = await fetch(`${fixture.baseUrl}/canvas/merges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...mergeBody,
        confirmed: true,
        expected: preview.value.expectation,
      }),
    }).then((response) => response.json()) as { ok: boolean; error: { code: string } }
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'merge_preview_stale')

    const refreshed = await fetch(`${fixture.baseUrl}/canvas/merges/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mergeBody),
    }).then((response) => response.json()) as {
      ok: boolean
      value: { expectation: WorkspaceMergeExpectation }
    }
    assert.ok(refreshed.ok)

    const executed = await fetch(`${fixture.baseUrl}/canvas/merges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...mergeBody,
        confirmed: true,
        expected: refreshed.value.expectation,
      }),
    }).then((response) => response.json()) as {
      ok: boolean
      value: { state: string; canvas: { merged: boolean } }
    }
    assert.ok(executed.ok)
    assert.equal(executed.value.state, 'merged')
    assert.equal(executed.value.canvas.merged, true)
    const main = await fetch(mainUrl).then((response) => response.json()) as {
      document: ReturnType<typeof document>
    }
    assert.equal(main.document.nodes[0]?.title, 'Feature after preview')
  } finally {
    await fixture.close()
  }
})
