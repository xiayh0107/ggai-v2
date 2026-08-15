import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDaemonServer } from '../server.js'

test('Canvas HTTP routes coordinate commands, history, restore, and semantic merge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-server-versioning-v2-'))
  const daemon = createDaemonServer({ projectRoot: root })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const initialStatus = await getJson(baseUrl, '/canvas/status?projectDir=.') as {
      versioning: { state: string }
    }
    assert.equal(initialStatus.versioning.state, 'uninitialized')

    const created = await command(baseUrl, {
      branch: 'main',
      baseRevision: 0,
      mutationId: 'create-main-versioned-task',
      command: createTask('task-main-versioned', 'Main versioned task'),
    })
    assert.equal(created.revision, 1)

    const checkpoint = await postJson(baseUrl, '/canvas/checkpoints', {
      projectDir: '.',
      branch: 'main',
      reason: 'server-contract',
    }) as VersionOperation<{ checkpoint: { commit: string } }>
    assert.equal(checkpoint.ok, true)
    assert.match(checkpoint.value?.checkpoint.commit ?? '', /^[0-9a-f]{40,64}$/u)
    const firstCommit = checkpoint.value!.checkpoint.commit

    const branches = await getJson(baseUrl, '/canvas/branches?projectDir=.') as
      VersionOperation<Array<{ name: string }>>
    assert.equal(branches.ok, true)
    assert.deepEqual(branches.value?.map((branch) => branch.name), ['main'])

    const feature = await postJson(baseUrl, '/canvas/branches', {
      projectDir: '.',
      name: 'feature/server-v2',
      fromBranch: 'main',
    }) as VersionOperation<{ canvas: { revision: number } }>
    assert.equal(feature.ok, true)
    assert.equal(feature.value?.canvas.revision, 1)

    const featureCanvas = await getJson(
      baseUrl,
      '/canvas?projectDir=.&branch=feature%2Fserver-v2',
    ) as { revision: number; document: { tasks: Array<{ id: string }> } }
    assert.equal(featureCanvas.revision, 1)
    assert.equal(featureCanvas.document.tasks[0]?.id, 'task-main-versioned')

    await command(baseUrl, {
      branch: 'feature/server-v2',
      baseRevision: featureCanvas.revision,
      mutationId: 'create-feature-versioned-task',
      command: createTask('task-feature-versioned', 'Feature versioned task'),
    })

    const preview = await postJson(baseUrl, '/canvas/merges/preview', {
      projectDir: '.',
      sourceBranch: 'feature/server-v2',
      targetBranch: 'main',
    }) as VersionOperation<{
      state: string
      expectation: {
        sourceCommit: string
        targetCommit: string
        sourceRevision: number
        targetRevision: number
      }
    }>
    assert.equal(preview.ok, true)
    assert.equal(preview.value?.state, 'ready')
    assert.deepEqual(Object.keys(preview.value?.expectation ?? {}).sort(), [
      'sourceCommit',
      'sourceRevision',
      'targetCommit',
      'targetRevision',
    ])

    const merged = await postJson(baseUrl, '/canvas/merges', {
      projectDir: '.',
      sourceBranch: 'feature/server-v2',
      targetBranch: 'main',
      confirmed: true,
      expected: preview.value!.expectation,
    }) as VersionOperation<{
      state: string
      canvasEnvelope?: { document: { tasks: Array<{ id: string }> } }
    }>
    assert.equal(merged.ok, true)
    assert.equal(merged.value?.state, 'merged')
    assert.deepEqual(
      merged.value?.canvasEnvelope?.document.tasks.map((task) => task.id).sort(),
      ['task-feature-versioned', 'task-main-versioned'],
    )

    const restored = await postJson(baseUrl, '/canvas/restores', {
      projectDir: '.',
      sourceBranch: 'main',
      checkpoint: firstCommit,
      newBranch: 'restore/server-v2',
    }) as VersionOperation<{
      canvas: { document: { tasks: Array<{ id: string }> } }
    }>
    assert.equal(restored.ok, true)
    assert.deepEqual(
      restored.value?.canvas.document.tasks.map((task) => task.id),
      ['task-main-versioned'],
    )

    const history = await getJson(
      baseUrl,
      '/canvas/history?projectDir=.&branch=main&limit=20',
    ) as VersionOperation<{ entries: Array<{ commit: string }> }>
    assert.equal(history.ok, true)
    assert.ok((history.value?.entries.length ?? 0) >= 2)

    const sourceRoute = await fetch(`${baseUrl}/canvas/source?projectDir=.`)
    assert.equal(sourceRoute.status, 404)
    assert.equal(
      (await sourceRoute.json() as { error: { code: string } }).error.code,
      'not_found',
    )

    const deletion = await fetch(`${baseUrl}/canvas/branches`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', branch: 'feature/server-v2' }),
    })
    assert.equal(deletion.status, 405)
  } finally {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Canvas HTTP conflict recovery replays a durable journal into an isolated branch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-server-conflict-v2-'))
  const daemon = createDaemonServer({ projectRoot: root })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    await command(baseUrl, {
      branch: 'main',
      baseRevision: 0,
      mutationId: 'conflict-create-task',
      command: createTask('task-conflict', 'Original'),
    })
    await command(baseUrl, {
      branch: 'main',
      baseRevision: 1,
      mutationId: 'conflict-remote-goal',
      command: {
        type: 'UpdateTaskGoal',
        taskId: 'task-conflict',
        goal: 'remote goal',
      },
    })

    const recoveryBody = {
      sourceBranch: 'main',
      newBranch: 'conflict/local-goal',
      baseRevision: 1,
      mutations: [{
        mutationId: 'conflict-local-goal',
        command: {
          type: 'UpdateTaskGoal',
          taskId: 'task-conflict',
          goal: 'local goal',
        },
      }],
    }
    const recovered = await fetch(`${baseUrl}/canvas/conflicts?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recoveryBody),
    })
    const recoveredText = await recovered.text()
    assert.equal(recovered.status, 201, recoveredText)
    const recoveredBody = JSON.parse(recoveredText) as {
      sourceBranch: string
      newBranch: string
      baseRevision: number
      canvas: { revision: number; document: { tasks: Array<{ goal: string }> } }
    }
    assert.equal(recoveredBody.sourceBranch, 'main')
    assert.equal(recoveredBody.newBranch, 'conflict/local-goal')
    assert.equal(recoveredBody.baseRevision, 1)
    assert.equal(recoveredBody.canvas.document.tasks[0]?.goal, 'local goal')

    const source = await getJson(baseUrl, '/canvas?projectDir=.&branch=main') as {
      document: { tasks: Array<{ goal: string }> }
    }
    assert.equal(source.document.tasks[0]?.goal, 'remote goal')

    const retry = await fetch(`${baseUrl}/canvas/conflicts?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recoveryBody),
    })
    assert.equal(retry.status, 201, await retry.text())

    const forgedSnapshot = await fetch(`${baseUrl}/canvas/conflicts?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...recoveryBody,
        newBranch: 'conflict/forged-snapshot',
        canvasSnapshot: { schemaVersion: 2 },
      }),
    })
    assert.equal(forgedSnapshot.status, 400)

    const invalid = await fetch(`${baseUrl}/canvas/conflicts?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...recoveryBody,
        newBranch: 'conflict/invalid-command',
        mutations: [{
          mutationId: 'conflict-invalid-command',
          command: {
            type: 'UpdateTaskGoal',
            taskId: 'task-missing',
            goal: 'must fail before branch creation',
          },
        }],
      }),
    })
    assert.equal(invalid.status, 409)

    const branches = await getJson(baseUrl, '/canvas/branches?projectDir=.') as
      VersionOperation<Array<{ name: string }>>
    assert.deepEqual(
      branches.value?.map((branch) => branch.name).sort(),
      ['conflict/local-goal', 'main'],
    )
  } finally {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  }
})

interface VersionOperation<T> {
  ok: boolean
  partial: boolean
  value?: T
  error?: { code: string; message: string }
  versioning: { state: string }
}

function createTask(id: string, title: string) {
  return {
    type: 'CreateTask',
    task: {
      id,
      title,
      goal: `${title} goal`,
      anchor: { x: 100, y: 120 },
      origin: { kind: 'user' },
    },
  }
}

async function command(baseUrl: string, body: unknown): Promise<{
  revision: number
  document: { tasks: Array<{ id: string }> }
}> {
  const response = await fetch(`${baseUrl}/canvas/commands?projectDir=.`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return JSON.parse(text) as {
    revision: number
    document: { tasks: Array<{ id: string }> }
  }
}

async function getJson(baseUrl: string, pathname: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return JSON.parse(text) as unknown
}

async function postJson(baseUrl: string, pathname: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return JSON.parse(text) as unknown
}
