import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { parseCreateRunRequest, ProtocolError, type RunSummary } from '../protocol.js'
import { artifactRunRelativeDir } from '../artifactPaths.js'
import { AgentRegistry } from '../registry.js'
import { RunLogStore } from '../runLogs.js'
import { createDaemonServer, type DaemonServer } from '../server.js'

const execFileAsync = promisify(execFile)

interface TestDaemon {
  root: string
  baseUrl: string
  daemon: DaemonServer
  close(): Promise<void>
}

async function startTestDaemon(allowedOrigins: string[] = []): Promise<TestDaemon> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-daemon-'))
  const fakeCodex = path.join(root, 'fake-codex.mjs')
  await writeFile(fakeCodex, FAKE_CODEX, 'utf8')
  await chmod(fakeCodex, 0o755)
  const registry = new AgentRegistry({
    codexCommand: fakeCodex,
    acpxCommand: path.join(root, 'missing-acpx'),
    acpxAgents: ['codex'],
  })
  const daemon = createDaemonServer({
    projectRoot: root,
    registry,
    allowedOrigins,
    canvasModel: 'v2',
    allowCanvasModelMixingForTests: true,
  })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  return {
    root,
    daemon,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await daemon.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('configured development origins remain exact', async () => {
  const fixture = await startTestDaemon(['http://localhost:7100'])
  try {
    const allowed = await fetch(`${fixture.baseUrl}/health`, {
      headers: { Origin: 'http://localhost:7100' },
    })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:7100')

    const denied = await fetch(`${fixture.baseUrl}/health`, {
      headers: { Origin: 'http://localhost:7101' },
    })
    assert.equal(denied.status, 403)
  } finally {
    await fixture.close()
  }
})

test('Canvas V2 command API persists reducer commands with CAS', async () => {
  const fixture = await startTestDaemon()
  try {
    const health = await (await fetch(`${fixture.baseUrl}/health`)).json() as {
      capabilities?: { canvasModelV2?: boolean }
    }
    assert.equal(health.capabilities?.canvasModelV2, true)

    const emptyResponse = await fetch(`${fixture.baseUrl}/canvas/v2?branch=main`)
    assert.equal(emptyResponse.status, 200)
    const empty = await emptyResponse.json() as { revision: number; document: { tasks: unknown[] } }
    assert.equal(empty.revision, 0)
    assert.deepEqual(empty.document.tasks, [])

    const commandBody = {
      branch: 'main',
      baseRevision: 0,
      mutationId: 'create-task-1',
      command: {
        type: 'CreateTask',
        task: {
          id: 'task-1',
          title: 'Scatter plot',
          goal: 'Create a classic scatter plot',
          anchor: { x: 120, y: 160 },
          origin: { kind: 'user' },
        },
      },
    }
    const committedResponse = await fetch(`${fixture.baseUrl}/canvas/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commandBody),
    })
    const committedText = await committedResponse.text()
    assert.equal(committedResponse.status, 200, committedText)
    const committed = JSON.parse(committedText) as {
      revision: number
      document: { tasks: Array<{ id: string }> }
    }
    assert.equal(committed.revision, 1)
    assert.equal(committed.document.tasks[0]?.id, 'task-1')

    const conflict = await fetch(`${fixture.baseUrl}/canvas/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...commandBody,
        mutationId: 'create-task-2',
        command: {
          ...commandBody.command,
          task: { ...commandBody.command.task, id: 'task-2' },
        },
      }),
    })
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json() as {
      error: { code: string; currentRevision: number }
    }).error.currentRevision, 1)

    const forgedPlan = await fetch(`${fixture.baseUrl}/canvas/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'main',
        baseRevision: 1,
        mutationId: 'forged-plan',
        command: {
          type: 'MaterializeProjectionPlan',
          planId: `plan_${'a'.repeat(64)}`,
          nodes: [{ id: 'forged' }],
        },
      }),
    })
    assert.equal(forgedPlan.status, 400)
  } finally {
    await fixture.close()
  }
})

test('Canvas V2 HTTP retries remain exactly once after an intervening mutation', async () => {
  const fixture = await startTestDaemon()
  const post = (body: unknown) => fetch(`${fixture.baseUrl}/canvas/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const create = await post({
      branch: 'main',
      baseRevision: 0,
      mutationId: 'exact-create',
      command: {
        type: 'CreateTask',
        task: {
          id: 'task-exact',
          title: 'Exactly once',
          goal: 'Do not repeat movement',
          anchor: { x: 100, y: 120 },
          origin: { kind: 'user' },
        },
      },
    })
    assert.equal(create.status, 200, await create.text())
    const moveBody = {
      branch: 'main',
      baseRevision: 1,
      mutationId: 'exact-move',
      command: {
        type: 'MoveEntities',
        entities: [{ kind: 'task', id: 'task-exact' }],
        dx: 25,
        dy: 10,
      },
    }
    const firstMove = await post(moveBody)
    assert.equal(firstMove.status, 200, await firstMove.text())

    const intervening = await post({
      branch: 'main',
      baseRevision: 2,
      mutationId: 'exact-update',
      command: {
        type: 'UpdateTaskGoal',
        taskId: 'task-exact',
        goal: 'An intervening command advanced the branch',
      },
    })
    assert.equal(intervening.status, 200, await intervening.text())

    const retry = await post({ ...moveBody, baseRevision: 3 })
    const retryText = await retry.text()
    assert.equal(retry.status, 200, retryText)
    const envelope = JSON.parse(retryText) as {
      revision: number
      document: { tasks: Array<{ anchor: { x: number; y: number } }> }
    }
    assert.equal(envelope.revision, 3)
    assert.deepEqual(envelope.document.tasks[0]?.anchor, { x: 125, y: 130 })
  } finally {
    await fixture.close()
  }
})

test('V2 plugin capability handshake pins strict data before accepting a Run', async () => {
  const fixture = await startTestDaemon()
  const headers = { 'Content-Type': 'application/json' }
  try {
    const capabilityResponse = await fetch(`${fixture.baseUrl}/plugin-capabilities/v2`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        plugins: [{
          id: '@community/notebook',
          artifactClaims: [{ extensions: ['.ipynb'] }],
        }],
      }),
    })
    const capabilityText = await capabilityResponse.text()
    assert.equal(capabilityResponse.status, 200, capabilityText)
    const capability = JSON.parse(capabilityText) as {
      schemaVersion: number
      digest: string
      pluginCount: number
    }
    assert.equal(capability.schemaVersion, 2)
    assert.match(capability.digest, /^[0-9a-f]{64}$/u)
    assert.ok(capability.pluginCount > 6)

    const override = await fetch(`${fixture.baseUrl}/plugin-capabilities/v2`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        plugins: [{ id: 'image', artifactClaims: [{ extensions: ['.evil'] }] }],
      }),
    })
    assert.equal(override.status, 400)
    assert.equal((await override.json() as { error: { code: string } }).error.code,
      'invalid_plugin_capabilities')

    const forged = await fetch(`${fixture.baseUrl}/plugin-capabilities/v2`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        plugins: [],
        nodes: [{ id: 'forged', x: 10, y: 20, payload: { unsafe: true } }],
      }),
    })
    assert.equal(forged.status, 400)

    const created = await fetch(`${fixture.baseUrl}/canvas/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        branch: 'main',
        baseRevision: 0,
        mutationId: 'create-plugin-task',
        command: {
          type: 'CreateTask',
          task: {
            id: 'task-plugin-capabilities',
            title: 'Plugin capability task',
            goal: 'Produce a plugin-owned artifact',
            anchor: { x: 100, y: 100 },
            origin: { kind: 'user' },
          },
        },
      }),
    })
    assert.equal(created.status, 200, await created.text())

    const intent = {
      schemaVersion: 2,
      runId: 'run-plugin-capabilities',
      taskId: 'task-plugin-capabilities',
      agentId: 'codex',
      canvasBranch: 'main',
      baseRevision: 1,
      prompt: 'Generate output using the fixed plugin registry.',
      attachments: [],
      materializationPolicy: 'auto',
    }
    const missing = await fetch(
      `${fixture.baseUrl}/runs?pluginCapabilityDigest=${'f'.repeat(64)}`,
      { method: 'POST', headers, body: JSON.stringify({ ...intent, runId: 'run-missing-capability' }) },
    )
    assert.equal(missing.status, 409)
    assert.equal((await missing.json() as { error: { code: string } }).error.code,
      'plugin_capabilities_not_found')
    assert.equal(await new RunLogStore(fixture.root).summary('run-missing-capability'), null)

    const accepted = await fetch(
      `${fixture.baseUrl}/runs?pluginCapabilityDigest=${capability.digest}`,
      { method: 'POST', headers, body: JSON.stringify(intent) },
    )
    assert.equal(accepted.status, 202, await accepted.text())
    await waitFor(async () =>
      (await fixture.daemon.runs.getPersisted(intent.runId))?.status === 'done')
    assert.equal(
      (await fixture.daemon.runs.getPersisted(intent.runId))?.pluginCapabilityDigest,
      capability.digest,
    )
    assert.match(
      await readFile(path.join(
        fixture.root,
        '.gg',
        'context',
        'runs',
        intent.runId,
        'pack.md',
      ), 'utf8'),
      /@community\/notebook/u,
    )

    const runLogs = new RunLogStore(fixture.root)
    await waitFor(async () =>
      Boolean((await runLogs.terminalClose(intent.runId))?.artifactManifest?.entries[0]))
    const terminal = await runLogs.terminalClose(intent.runId)
    const artifact = terminal?.artifactManifest?.entries[0]
    assert.ok(artifact)
    const metadataResponse = await fetch(
      `${fixture.baseUrl}/runs/${intent.runId}/artifacts/${artifact.artifactId}/metadata`,
    )
    assert.equal(metadataResponse.status, 200)
    assert.deepEqual(await metadataResponse.json(), {
      schemaVersion: 2,
      runId: intent.runId,
      artifactId: artifact.artifactId,
      mediaType: artifact.mediaType,
      size: artifact.size,
      contentDigest: artifact.contentDigest,
    })

    const snapshotPath = path.join(
      fixture.root,
      '.gg',
      'runtime',
      'plugin-capabilities-v2',
      `${capability.digest}.json`,
    )
    await writeFile(snapshotPath, '{damaged snapshot\n', 'utf8')
    const damaged = await fetch(
      `${fixture.baseUrl}/runs?pluginCapabilityDigest=${capability.digest}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...intent, runId: 'run-damaged-capability' }),
      },
    )
    assert.equal(damaged.status, 409)
    assert.equal((await damaged.json() as { error: { code: string } }).error.code,
      'plugin_capabilities_unavailable')
    assert.equal(await new RunLogStore(fixture.root).summary('run-damaged-capability'), null)
  } finally {
    await fixture.close()
  }
})

function runBody(nodeId: string, prompt: string): Record<string, unknown> {
  return {
    nodeId,
    agentId: 'codex',
    prompt,
    projectDir: '.',
    canvasSnapshot: {
      nodes: [{
        id: nodeId,
        type: 'text',
        x: 0,
        y: 0,
        w: 320,
        h: 120,
        title: 'Result',
        instruction: { phase: 'idle', prompt, attachments: [], sources: [], open: true },
        payload: {},
      }],
      edges: [],
      plugins: [{
        id: 'text',
        label: 'Text',
        description: 'Writes text artifacts',
        instruction: { placeholder: 'Write something', actions: ['Draft'] },
        initialPayload: {},
      }],
    },
  }
}

async function createRun(baseUrl: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const responseText = await response.text()
  assert.equal(response.status, 202, responseText)
  const payload = JSON.parse(responseText) as { runId: string }
  return payload.runId
}

test('RunIntent V2 executes only against the exact persisted Canvas revision', async () => {
  const fixture = await startTestDaemon()
  try {
    const command = await fetch(`${fixture.baseUrl}/canvas/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'main',
        baseRevision: 0,
        mutationId: 'create-task-run-v2',
        command: {
          type: 'CreateTask',
          task: {
            id: 'task-server-v2',
            title: 'Server V2 task',
            goal: 'Use the durable task revision',
            anchor: { x: 100, y: 120 },
            origin: { kind: 'user' },
          },
        },
      }),
    })
    assert.equal(command.status, 200, await command.text())

    const intent = {
      schemaVersion: 2,
      runId: 'server-task-run-v2',
      taskId: 'task-server-v2',
      agentId: 'codex',
      canvasBranch: 'main',
      baseRevision: 1,
      prompt: 'SERVER_V2_PROMPT',
      attachments: [],
      materializationPolicy: 'auto',
    }
    const stale = await fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...intent, runId: 'server-task-run-stale', baseRevision: 0 }),
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), {
      error: {
        code: 'canvas_v2_revision_conflict',
        message: 'Canvas V2 revision changed; current revision is 1',
        currentRevision: 1,
      },
    })

    const forgedSnapshot = await fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...intent, canvasSnapshot: { nodes: [], edges: [] } }),
    })
    assert.equal(forgedSnapshot.status, 400)
    assert.equal((await forgedSnapshot.json() as { error: { code: string } }).error.code,
      'invalid_run_intent_v2')

    const accepted = await fetch(`${fixture.baseUrl}/runs?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    })
    assert.equal(accepted.status, 202, await accepted.text())
    await waitFor(async () => fixture.daemon.runs.get(intent.runId)?.status === 'done')

    const summaryResponse = await fetch(`${fixture.baseUrl}/runs/${intent.runId}`)
    assert.equal(summaryResponse.status, 200)
    const summary = await summaryResponse.json() as RunSummary
    assert.equal(summary.taskId, 'task-server-v2')
    assert.equal(summary.nodeId, 'task-server-v2')

    let logPage: {
      entries: Array<{
        event: string
        data: Record<string, unknown>
      }>
    } | undefined
    await waitFor(async () => {
      const log = await fetch(`${fixture.baseUrl}/runs/${intent.runId}/log`)
      if (!log.ok) return false
      logPage = await log.json() as typeof logPage
      return logPage?.entries.some((entry) => entry.event === 'close') ?? false
    })
    assert.ok(logPage)
    const fileWrite = logPage.entries.find((entry) =>
      entry.event === 'agent-event' && entry.data.type === 'file-write')?.data
    assert.match(
      typeof fileWrite?.path === 'string' ? fileWrite.path : '',
      /\/server-task-run-v2\/files\/output\.txt$/u,
    )
    const close = logPage.entries.find((entry) => entry.event === 'close')?.data as {
      artifacts: string[]
      artifactsComplete: boolean
      outcome?: unknown
      suggestedActions: unknown[]
      artifactManifest: {
        version: number
        runId: string
        complete: boolean
        entries: Array<{
          artifactId: string
          relativePath: string
          mediaType: string
        }>
      }
      projectionPlan: {
        planId: string
        runId: string
        taskId: string
        status: string
        outputs: Array<{ pluginId: string; artifactRefs: Array<{ artifactId: string }> }>
        taskProposals: unknown[]
      }
    }
    assert.equal(close.artifactsComplete, true)
    assert.equal(close.artifactManifest.version, 1)
    assert.equal(close.artifactManifest.runId, intent.runId)
    assert.equal(close.artifactManifest.complete, true)
    assert.deepEqual(close.artifactManifest.entries.map((entry) => entry.relativePath), [
      'output.txt',
    ])
    assert.match(close.artifacts[0] ?? '', /\/server-task-run-v2\/files\/output\.txt$/u)
    assert.equal(close.outcome, undefined)
    assert.deepEqual(close.suggestedActions, [])
    assert.equal(close.projectionPlan.runId, intent.runId)
    assert.equal(close.projectionPlan.taskId, intent.taskId)
    assert.equal(close.projectionPlan.status, 'complete')
    assert.equal(close.projectionPlan.outputs[0]?.pluginId, 'text')
    assert.deepEqual(close.projectionPlan.taskProposals, [])
    const pendingPlanResponse = await fetch(
      `${fixture.baseUrl}/projection-plans/${close.projectionPlan.planId}?projectDir=.&branch=main`,
    )
    const pendingPlanText = await pendingPlanResponse.text()
    assert.equal(pendingPlanResponse.status, 200, pendingPlanText)
    assert.deepEqual(JSON.parse(pendingPlanText), {
      plan: close.projectionPlan,
      suggestedActions: close.suggestedActions,
    })
    let materializedCanvas: {
      revision: number
      document: {
        nodes: Array<{ type: string; artifactRefs: Array<{ artifactId: string }> }>
        receipts: Array<{ kind: string; planId: string }>
      }
    } | undefined
    await waitFor(async () => {
      const canvasResponse = await fetch(`${fixture.baseUrl}/canvas/v2?branch=main`)
      if (!canvasResponse.ok) return false
      materializedCanvas = await canvasResponse.json() as typeof materializedCanvas
      return materializedCanvas?.document.receipts.some((receipt) =>
        receipt.kind === 'materialization'
        && receipt.planId === close.projectionPlan.planId) ?? false
    })
    assert.ok(materializedCanvas)
    assert.equal(materializedCanvas.revision, 2)
    assert.equal(materializedCanvas.document.nodes.length, 1)
    assert.equal(materializedCanvas.document.nodes[0]?.type, 'text')
    assert.equal(
      materializedCanvas.document.nodes[0]?.artifactRefs[0]?.artifactId,
      close.artifactManifest.entries[0]?.artifactId,
    )
    const materializationReplay = await fetch(`${fixture.baseUrl}/canvas/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'main',
        baseRevision: materializedCanvas.revision,
        mutationId: 'replay-materialization-v2',
        command: {
          type: 'MaterializeProjectionPlan',
          planId: close.projectionPlan.planId,
        },
      }),
    })
    const replayText = await materializationReplay.text()
    assert.equal(materializationReplay.status, 200, replayText)
    assert.equal((JSON.parse(replayText) as { revision: number }).revision, 2)
    const foreignBranchPlan = await fetch(
      `${fixture.baseUrl}/projection-plans/${close.projectionPlan.planId}?projectDir=.&branch=other`,
    )
    assert.equal(foreignBranchPlan.status, 404)
    const artifactEntry = close.artifactManifest.entries[0]!
    const artifactResponse = await fetch(
      `${fixture.baseUrl}/runs/${intent.runId}/artifacts/${artifactEntry.artifactId}`,
    )
    assert.equal(artifactResponse.status, 200)
    assert.equal(artifactResponse.headers.get('content-type'), 'text/plain')
    assert.match(artifactResponse.headers.get('etag') ?? '', /^"sha256-[0-9a-f]{64}"$/u)
    assert.equal(await artifactResponse.text(), 'created by fake codex\n')
    const rawPathResponse = await fetch(
      `${fixture.baseUrl}/artifacts?path=${encodeURIComponent(close.artifacts[0]!)}`,
    )
    assert.equal(rawPathResponse.status, 403)

    const attachmentTask = await fetch(`${fixture.baseUrl}/canvas/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'main',
        baseRevision: materializedCanvas.revision,
        mutationId: 'create-attachment-task-v2',
        command: {
          type: 'CreateTask',
          task: {
            id: 'task-attachment-v2',
            title: 'Attachment task',
            goal: 'Read a verified prior artifact',
            anchor: { x: 500, y: 120 },
            origin: { kind: 'user' },
          },
        },
      }),
    })
    const attachmentTaskText = await attachmentTask.text()
    assert.equal(attachmentTask.status, 200, attachmentTaskText)
    const attachmentTaskRevision = (JSON.parse(attachmentTaskText) as { revision: number }).revision
    const attachmentIntent = {
      ...intent,
      runId: 'server-task-run-attachment-v2',
      taskId: 'task-attachment-v2',
      baseRevision: attachmentTaskRevision,
      prompt: 'USE_VERIFIED_ATTACHMENT',
      attachments: [{
        kind: 'artifact',
        runId: intent.runId,
        artifactId: artifactEntry.artifactId,
      }],
    }
    const missingAttachment = await fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...attachmentIntent,
        runId: 'server-task-run-missing-attachment-v2',
        attachments: [{
          kind: 'artifact',
          runId: intent.runId,
          artifactId: `artifact_${'f'.repeat(64)}`,
        }],
      }),
    })
    assert.equal(missingAttachment.status, 404)
    const attached = await fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attachmentIntent),
    })
    assert.equal(attached.status, 202, await attached.text())
    await waitFor(async () =>
      fixture.daemon.runs.get(attachmentIntent.runId)?.status === 'done')
    const attachmentPack = await readFile(path.join(
      fixture.root,
      '.gg',
      'context',
      'runs',
      attachmentIntent.runId,
      'pack.md',
    ), 'utf8')
    assert.match(attachmentPack, /Verified read-only artifact attachments/u)
    assert.match(attachmentPack, new RegExp(artifactEntry.artifactId, 'u'))
    assert.match(attachmentPack, /server-task-run-v2\/files\/output\.txt/u)

    const pack = await readFile(
      path.join(fixture.root, '.gg', 'context', 'runs', intent.runId, 'pack.md'),
      'utf8',
    )
    assert.match(pack, /Use the durable task revision/u)
    assert.match(pack, /SERVER_V2_PROMPT/u)
    assert.doesNotMatch(pack, /canvasSnapshot/u)

    const history = await fetch(`${fixture.baseUrl}/runs?taskId=task-server-v2`)
    assert.equal(history.status, 200)
    assert.equal((await history.json() as { runs: RunSummary[] }).runs[0]?.runId, intent.runId)
  } finally {
    await fixture.close()
  }
})

test('RunIntent V2 resolves readable artifacts from pinned full edges only', async () => {
  const fixture = await startTestDaemon()
  type CanvasEnvelope = {
    revision: number
    document: {
      nodes: Array<{
        id: string
        homeTaskId?: string
        artifactRefs: Array<{ runId: string; artifactId: string }>
      }>
      receipts: Array<{ kind: string; planId: string }>
    }
  }
  type TaskClose = {
    projectionPlan: { planId: string }
    artifactManifest: {
      entries: Array<{
        artifactId: string
        relativePath: string
      }>
    }
  }

  const canvas = async (): Promise<CanvasEnvelope> => {
    const response = await fetch(`${fixture.baseUrl}/canvas/v2?projectDir=.&branch=main`)
    assert.equal(response.status, 200)
    return await response.json() as CanvasEnvelope
  }
  const commit = async (mutationId: string, command: Record<string, unknown>) => {
    const current = await canvas()
    const response = await fetch(`${fixture.baseUrl}/canvas/commands?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'main',
        baseRevision: current.revision,
        mutationId,
        command,
      }),
    })
    const responseText = await response.text()
    assert.equal(response.status, 200, responseText)
    return JSON.parse(responseText) as CanvasEnvelope
  }
  const runTask = async (taskId: string, runId: string): Promise<{
    close: TaskClose
    pack: string
    canvas: CanvasEnvelope
  }> => {
    const current = await canvas()
    const response = await fetch(`${fixture.baseUrl}/runs?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        runId,
        taskId,
        agentId: 'codex',
        canvasBranch: 'main',
        baseRevision: current.revision,
        prompt: `execute ${taskId}`,
        attachments: [],
        materializationPolicy: 'auto',
      }),
    })
    assert.equal(response.status, 202, await response.text())

    let close: TaskClose | undefined
    await waitFor(async () => {
      const log = await fetch(`${fixture.baseUrl}/runs/${runId}/log?projectDir=.`)
      if (!log.ok) return false
      const page = await log.json() as {
        entries: Array<{ event: string; data: unknown }>
      }
      close = page.entries.find((entry) => entry.event === 'close')?.data as TaskClose | undefined
      return Boolean(close?.projectionPlan?.planId)
    })
    let settledCanvas: CanvasEnvelope | undefined
    await waitFor(async () => {
      settledCanvas = await canvas()
      return settledCanvas.document.receipts.some((receipt) =>
        receipt.kind === 'materialization'
        && receipt.planId === close?.projectionPlan.planId)
    })
    return {
      close: close!,
      pack: await readFile(path.join(
        fixture.root,
        '.gg',
        'context',
        'runs',
        runId,
        'pack.md',
      ), 'utf8'),
      canvas: settledCanvas!,
    }
  }
  const createDerivedTask = async (
    taskId: string,
    source: { kind: 'node' | 'task'; id: string },
    contextRole: 'full' | 'summary' | 'none',
  ) => commit(`create-${taskId}`, {
    type: 'CreateDerivedTaskFromSelection',
    task: {
      id: taskId,
      title: taskId,
      goal: `derive from ${source.kind} using ${contextRole} context`,
      anchor: { x: 400, y: 200 },
      origin: { kind: 'user' },
    },
    sources: [{
      entity: source,
      relation: 'source',
      contextRole,
    }],
  })

  try {
    await commit('create-context-source-task', {
      type: 'CreateTask',
      task: {
        id: 'task-context-source',
        title: 'Context source',
        goal: 'Create a source artifact',
        anchor: { x: 100, y: 100 },
        origin: { kind: 'user' },
      },
    })
    const source = await runTask('task-context-source', 'run-context-source')
    const sourceArtifact = source.close.artifactManifest.entries[0]!
    const sourceNode = source.canvas.document.nodes.find((node) =>
      node.homeTaskId === 'task-context-source'
      && node.artifactRefs.some((artifact) => artifact.artifactId === sourceArtifact.artifactId))
    assert.ok(sourceNode)

    await createDerivedTask(
      'task-context-node-full',
      { kind: 'node', id: sourceNode.id },
      'full',
    )
    const nodeFull = await runTask('task-context-node-full', 'run-context-node-full')
    assert.match(nodeFull.pack, /Verified read-only artifact attachments/u)
    assert.match(nodeFull.pack, new RegExp(sourceArtifact.artifactId, 'u'))
    assert.match(nodeFull.pack, /run-context-source\/files\/output\.txt/u)

    await createDerivedTask(
      'task-context-node-summary',
      { kind: 'node', id: sourceNode.id },
      'summary',
    )
    const nodeSummary = await runTask('task-context-node-summary', 'run-context-node-summary')
    assert.doesNotMatch(nodeSummary.pack, /Verified read-only artifact attachments/u)
    assert.doesNotMatch(nodeSummary.pack, new RegExp(sourceArtifact.artifactId, 'u'))
    assert.match(nodeSummary.pack, /"contextRole": "summary"/u)

    await createDerivedTask(
      'task-context-task-full',
      { kind: 'task', id: 'task-context-source' },
      'full',
    )
    const taskFull = await runTask('task-context-task-full', 'run-context-task-full')
    assert.match(taskFull.pack, /Verified read-only artifact attachments/u)
    assert.match(taskFull.pack, new RegExp(sourceArtifact.artifactId, 'u'))
    assert.match(taskFull.pack, /"outputs": \[/u)
    assert.match(taskFull.pack, new RegExp(`"id": "${sourceNode.id}"`, 'u'))

    const sourceLookup = await fixture.daemon.runs.lookupRunArtifact(
      'run-context-source',
      sourceArtifact.artifactId,
      '.',
    )
    assert.ok(sourceLookup)
    await rm(sourceLookup.absolutePath)

    await createDerivedTask(
      'task-context-missing-summary',
      { kind: 'node', id: sourceNode.id },
      'summary',
    )
    const missingSummary = await runTask(
      'task-context-missing-summary',
      'run-context-missing-summary',
    )
    assert.match(missingSummary.pack, /"contextRole": "summary"/u)
    assert.doesNotMatch(missingSummary.pack, /Verified read-only artifact attachments/u)

    await createDerivedTask(
      'task-context-missing-full',
      { kind: 'node', id: sourceNode.id },
      'full',
    )
    const current = await canvas()
    const unavailable = await fetch(`${fixture.baseUrl}/runs?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        runId: 'run-context-missing-full',
        taskId: 'task-context-missing-full',
        agentId: 'codex',
        canvasBranch: 'main',
        baseRevision: current.revision,
        prompt: 'must not run without the authorized artifact',
        attachments: [],
        materializationPolicy: 'auto',
      }),
    })
    const unavailableBody = await unavailable.json() as { error: { code: string } }
    assert.equal(unavailable.status, 409)
    assert.equal(unavailableBody.error.code, 'context_artifact_unavailable')
    assert.equal(fixture.daemon.runs.get('run-context-missing-full'), null)
  } finally {
    await fixture.close()
  }
})

function ssePayloads(source: string, eventName: string): unknown[] {
  return source.split(/\r?\n\r?\n/).flatMap((block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith('event: '))?.slice(7)
    if (event !== eventName) return []
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n')
    return data ? [JSON.parse(data) as unknown] : []
  })
}

test('HTTP/SSE run persists context, artifacts, and resumable sessions', async () => {
  const fixture = await startTestDaemon()
  try {
    const denied = await fetch(`${fixture.baseUrl}/agents`, {
      headers: { Origin: 'https://malicious.example' },
    })
    assert.equal(denied.status, 403)

    const agentsResponse = await fetch(`${fixture.baseUrl}/agents`)
    assert.equal(agentsResponse.status, 200)
    const agents = await agentsResponse.json() as {
      agents: Array<{ id: string; available: boolean; binaryPath?: string }>
    }
    const codexAgent = agents.agents.find((agent) => agent.id === 'codex')
    assert.equal(codexAgent?.available, true)
    assert.equal(codexAgent?.binaryPath, await realpath(path.join(fixture.root, 'fake-codex.mjs')))

    const runId = await createRun(fixture.baseUrl, runBody('node_1', 'Create a verified artifact.'))
    const artifactPath = `${artifactRunRelativeDir('main', runId, 'node_1')}/output.txt`
    const artifactAbsolute = path.join(fixture.root, ...artifactPath.split('/'))
    const eventsResponse = await fetch(`${fixture.baseUrl}/runs/${runId}/events`)
    assert.equal(eventsResponse.status, 200)
    assert.match(eventsResponse.headers.get('content-type') ?? '', /text\/event-stream/)
    const eventStream = await eventsResponse.text()

    const agentEvents = ssePayloads(eventStream, 'agent-event') as Array<Record<string, unknown>>
    assert.ok(agentEvents.some((event) => event.type === 'file-write'
      && event.path === artifactPath
      && event.nodeId === 'node_1'))
    assert.ok(agentEvents.some((event) => event.type === 'done' && event.stopReason === 'end_turn'))
    assert.deepEqual(ssePayloads(eventStream, 'close').at(-1), {
      runId,
      status: 'done',
      sessionId: 'thread-test-1',
      artifacts: [artifactPath],
      artifactsComplete: true,
    })

    assert.equal(await readFile(artifactAbsolute, 'utf8'), 'created by fake codex\n')
    const renderedContext = await readFile(path.join(fixture.root, '.gg/context/pack.md'), 'utf8')
    assert.match(renderedContext, /Create a verified artifact\./)
    assert.ok(renderedContext.includes(`${path.dirname(artifactAbsolute)}${path.sep}`))
    assert.doesNotMatch(renderedContext, /deliverables only under `artifacts\/node_1\//u)
    assert.match(await readFile(path.join(fixture.root, '.gg/skills/text.md'), 'utf8'), /Writes text artifacts/)

    const artifactUrl = new URL('/artifacts', fixture.baseUrl)
    artifactUrl.searchParams.set('projectDir', '.')
    artifactUrl.searchParams.set('path', artifactPath)
    const artifact = await fetch(artifactUrl)
    assert.equal(artifact.status, 200)
    assert.match(artifact.headers.get('content-type') ?? '', /^text\/plain/u)
    assert.equal(await artifact.text(), 'created by fake codex\n')

    const controlUrl = new URL(artifactUrl)
    controlUrl.searchParams.set(
      'path',
      `${path.posix.dirname(artifactPath)}/.ggai/run-result.json`,
    )
    const controlResponse = await fetch(controlUrl)
    assert.equal(controlResponse.status, 403)
    assert.equal(
      ((await controlResponse.json()) as { error: { code: string } }).error.code,
      'artifact_forbidden',
    )

    const traversalUrl = new URL(artifactUrl)
    traversalUrl.searchParams.set('path', '../fake-codex.mjs')
    assert.equal((await fetch(traversalUrl)).status, 403)

    const artifactDirectory = path.dirname(artifactAbsolute)
    await symlink(fakeCodexPath(fixture.root), path.join(artifactDirectory, 'escape.txt'))
    const escapeUrl = new URL(artifactUrl)
    escapeUrl.searchParams.set('path', `${artifactRunRelativeDir('main', runId, 'node_1')}/escape.txt`)
    assert.equal((await fetch(escapeUrl)).status, 403)

    await writeFile(
      path.join(artifactDirectory, 'oversized.txt'),
      Buffer.alloc(1024 * 1024 + 1),
    )
    const oversizedTextUrl = new URL(artifactUrl)
    oversizedTextUrl.searchParams.set(
      'path',
      `${artifactRunRelativeDir('main', runId, 'node_1')}/oversized.txt`,
    )
    assert.equal((await fetch(oversizedTextUrl)).status, 413)

    const sessionsResponse = await fetch(`${fixture.baseUrl}/sessions?nodeId=node_1`)
    assert.equal(sessionsResponse.status, 200)
    const sessions = await sessionsResponse.json() as { sessions: Array<{ sessionId: string }> }
    assert.equal(sessions.sessions[0]?.sessionId, 'thread-test-1')
    const stored = JSON.parse(await readFile(path.join(fixture.root, '.gg/sessions.json'), 'utf8')) as object
    assert.equal(Object.keys(stored).length, 1)

    const traversal = await fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...runBody('node_2', 'No'), projectDir: '..' }),
    })
    assert.equal(traversal.status, 403)
  } finally {
    await fixture.close()
  }
})

test('artifact reader rejects an artifacts root symlinked outside the project', async () => {
  const fixture = await startTestDaemon()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-artifacts-outside-'))
  try {
    const project = path.join(fixture.root, 'nested-project')
    await mkdir(project)
    await writeFile(path.join(outside, 'secret.txt'), 'must not be exposed\n', 'utf8')
    await symlink(outside, path.join(project, 'artifacts'), 'dir')

    const artifactUrl = new URL('/artifacts', fixture.baseUrl)
    artifactUrl.searchParams.set('projectDir', 'nested-project')
    artifactUrl.searchParams.set('path', 'artifacts/secret.txt')
    assert.equal((await fetch(artifactUrl)).status, 403)
  } finally {
    await fixture.close()
    await rm(outside, { recursive: true, force: true })
  }
})

test('sessions endpoint rejects a managed .gg directory symlink without reading outside', async () => {
  const fixture = await startTestDaemon()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-sessions-outside-'))
  try {
    await writeFile(
      path.join(outside, 'sessions.json'),
      JSON.stringify({
        'main:outside-node:codex': {
          sessionId: 'outside-secret-session',
          createdAt: 1,
          lastActiveAt: 1,
        },
      }),
      'utf8',
    )
    await symlink(outside, path.join(fixture.root, '.gg'), 'dir')

    const response = await fetch(`${fixture.baseUrl}/sessions?projectDir=.`)
    assert.equal(response.status, 403)
    const payload = await response.json() as { error: { code: string } }
    assert.equal(payload.error.code, 'unsafe_managed_path')
  } finally {
    await fixture.close()
    await rm(outside, { recursive: true, force: true })
  }
})

test('a pre-existing immutable artifact run symlink is rejected before transport starts', async () => {
  const fixture = await startTestDaemon()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-artifact-run-outside-'))
  try {
    const runId = 'artifact-symlink-run'
    const nodeId = 'node_artifact_symlink'
    const relativeRoot = artifactRunRelativeDir('main', runId, nodeId)
    const absoluteRoot = path.join(fixture.root, ...relativeRoot.split('/'))
    await mkdir(path.dirname(absoluteRoot), { recursive: true })
    await writeFile(path.join(outside, 'sentinel.txt'), 'unchanged\n', 'utf8')
    await symlink(outside, absoluteRoot, 'dir')

    const response = await fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...runBody(nodeId, 'NO_ESCAPE'), runId }),
    })
    assert.equal(response.status, 403)
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'unsafe_managed_path',
    )
    assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'unchanged\n')
  } finally {
    await fixture.close()
    await rm(outside, { recursive: true, force: true })
  }
})

test('auto mode checkpoints safe source worktree changes after a successful branch run', async () => {
  const fixture = await startTestDaemon()
  try {
    await git(fixture.root, ['init', '-b', 'main'])
    await git(fixture.root, ['add', 'fake-codex.mjs'])
    await git(fixture.root, [
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '--no-gpg-sign', '-m', 'initial',
    ])

    const boundResponse = await fetch(`${fixture.baseUrl}/canvas/source/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', branch: 'main' }),
    })
    assert.equal(boundResponse.status, 200)
    const bound = await boundResponse.json() as {
      ok: boolean
      value: { projectDir: string; head: string }
    }
    assert.equal(bound.ok, true)
    const initialHead = bound.value.head

    const preferences = await fetch(`${fixture.baseUrl}/canvas/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', automationMode: 'auto' }),
    })
    assert.equal(preferences.status, 200)

    const runId = await createRun(
      fixture.baseUrl,
      runBody('node_auto_source', 'WRITE_SOURCE and checkpoint it.'),
    )
    const events = await fetch(`${fixture.baseUrl}/runs/${runId}/events`)
    assert.equal(events.status, 200)
    await events.text()

    let currentHead = initialHead
    await waitFor(async () => {
      const source = await fetch(`${fixture.baseUrl}/canvas/source?projectDir=.`)
        .then((response) => response.json()) as {
          status: string
          branches: Array<{ logicalBranch: string; dirty: boolean; head: string }>
        }
      const main = source.branches.find((branch) => branch.logicalBranch === 'main')
      currentHead = main?.head ?? initialHead
      return source.status === 'ready' && main?.dirty === false && currentHead !== initialHead
    })

    const subject = (await git(bound.value.projectDir, ['log', '-1', '--pretty=%s'])).trim()
    assert.match(subject, /^ggai\(run\): Result \[/u)
    assert.match(currentHead, /^[0-9a-f]{40,64}$/u)
    assert.equal(
      (await readFile(path.join(bound.value.projectDir, 'src', 'auto.txt'), 'utf8')).trim(),
      bound.value.projectDir,
    )
    await assert.rejects(readFile(path.join(fixture.root, 'src', 'auto.txt'), 'utf8'), {
      code: 'ENOENT',
    })
  } finally {
    await fixture.close()
  }
})

test('an active branch run blocks manual source checkpoint mutations', async () => {
  const fixture = await startTestDaemon()
  try {
    await git(fixture.root, ['init', '-b', 'main'])
    await git(fixture.root, ['add', 'fake-codex.mjs'])
    await git(fixture.root, [
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '--no-gpg-sign', '-m', 'initial',
    ])
    const binding = await fetch(`${fixture.baseUrl}/canvas/source/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: '.', branch: 'main' }),
    })
    assert.equal(binding.status, 200)

    const runId = await createRun(
      fixture.baseUrl,
      runBody('node_branch_lease', 'WAIT_FOR_CANCEL'),
    )
    await waitFor(async () => fixture.daemon.runs.get(runId)?.status === 'running')
    const checkpoint = await fetch(`${fixture.baseUrl}/canvas/source/checkpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectDir: '.',
        branch: 'main',
        runId: 'manual-overlap',
        nodeTitle: 'Must not checkpoint',
      }),
    })
    assert.equal(checkpoint.status, 409)
    assert.equal(
      ((await checkpoint.json()) as { error: { code: string } }).error.code,
      'branch_busy',
    )
    const cancel = await fetch(`${fixture.baseUrl}/runs/${runId}/cancel`, { method: 'POST' })
    assert.equal(cancel.status, 200)
  } finally {
    await fixture.close()
  }
})

function fakeCodexPath(root: string): string {
  return path.join(root, 'fake-codex.mjs')
}

test('cancel terminates the child and closes the SSE stream as cancelled', async () => {
  const fixture = await startTestDaemon()
  try {
    const runId = await createRun(fixture.baseUrl, runBody('node_cancel', 'WAIT_FOR_CANCEL'))
    const streamPromise = fetch(`${fixture.baseUrl}/runs/${runId}/events`).then((response) => response.text())
    await waitFor(async () => {
      const response = await fetch(`${fixture.baseUrl}/runs/${runId}`)
      const summary = await response.json() as { status: string }
      return summary.status === 'running'
    })

    const cancel = await fetch(`${fixture.baseUrl}/runs/${runId}/cancel`, { method: 'POST' })
    assert.equal(cancel.status, 200)
    const afterCancel = await fetch(`${fixture.baseUrl}/runs/${runId}`).then((response) => response.json()) as {
      status: string
    }
    assert.equal(afterCancel.status, 'cancelled')
    const eventStream = await streamPromise
    const close = ssePayloads(eventStream, 'close').at(-1) as {
      runId: string
      status: string
      sessionId: string | null
    }
    assert.equal(close.runId, runId)
    assert.equal(close.status, 'cancelled')
    // Cancelling before the CLI's first JSONL line is a valid race, so the id may still be null.
    assert.ok(close.sessionId === null || close.sessionId === 'thread-test-1')
    const agentEvents = ssePayloads(eventStream, 'agent-event') as Array<Record<string, unknown>>
    assert.ok(agentEvents.some((event) => event.type === 'done' && event.stopReason === 'cancelled'))
  } finally {
    await fixture.close()
  }
})

test('client run ids are idempotent and the same node cannot run concurrently', async () => {
  const fixture = await startTestDaemon()
  try {
    const request = { ...runBody('node_serial', 'WAIT_FOR_CANCEL'), runId: 'client-run-1' }
    const runId = await createRun(fixture.baseUrl, request)
    assert.equal(runId, 'client-run-1')

    const retry = await createRun(fixture.baseUrl, request)
    assert.equal(retry, runId)

    const competing = await fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...runBody('node_serial', 'another prompt'), runId: 'client-run-2' }),
    })
    assert.equal(competing.status, 409)
    const payload = await competing.json() as { error: { code: string } }
    assert.equal(payload.error.code, 'node_run_active')

    const otherAgent = await fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...runBody('node_serial', 'other agent'),
        agentId: 'acpx:codex',
        runId: 'client-run-3',
      }),
    })
    assert.equal(otherAgent.status, 409)

    const branchRunId = await createRun(fixture.baseUrl, {
      ...runBody('node_serial', 'WAIT_FOR_CANCEL'),
      canvasBranch: 'experiment/concurrent',
      runId: 'client-run-branch',
    })
    assert.equal(branchRunId, 'client-run-branch')
    await waitFor(async () =>
      fixture.daemon.runs.get(runId)?.sessionId === 'thread-test-1'
      && fixture.daemon.runs.get(branchRunId)?.sessionId === 'thread-test-1')

    await Promise.all([
      fetch(`${fixture.baseUrl}/runs/${runId}/cancel`, { method: 'POST' }),
      fetch(`${fixture.baseUrl}/runs/${branchRunId}/cancel`, { method: 'POST' }),
    ])
    const mainSessions = await fetch(
      `${fixture.baseUrl}/sessions?nodeId=node_serial&branch=main`,
    ).then((response) => response.json()) as { sessions: Array<{ canvasBranch: string }> }
    const branchSessions = await fetch(
      `${fixture.baseUrl}/sessions?nodeId=node_serial&branch=experiment%2Fconcurrent`,
    ).then((response) => response.json()) as { sessions: Array<{ canvasBranch: string }> }
    assert.deepEqual(mainSessions.sessions.map((session) => session.canvasBranch), ['main'])
    assert.deepEqual(
      branchSessions.sessions.map((session) => session.canvasBranch),
      ['experiment/concurrent'],
    )
  } finally {
    await fixture.close()
  }
})

test('same-node runs on different branches keep immutable artifacts isolated', async () => {
  const fixture = await startTestDaemon()
  try {
    const [mainRunId, featureRunId] = await Promise.all([
      createRun(fixture.baseUrl, {
        ...runBody('node_shared_artifact', 'ARTIFACT_CONTENT_A'),
        canvasBranch: 'main',
        runId: 'artifact-main-run',
      }),
      createRun(fixture.baseUrl, {
        ...runBody('node_shared_artifact', 'ARTIFACT_CONTENT_B'),
        canvasBranch: 'feature/artifacts',
        runId: 'artifact-feature-run',
      }),
    ])
    const [mainEvents, featureEvents] = await Promise.all([
      fetch(`${fixture.baseUrl}/runs/${mainRunId}/events`).then((response) => response.text()),
      fetch(`${fixture.baseUrl}/runs/${featureRunId}/events`).then((response) => response.text()),
    ])
    const mainClose = ssePayloads(mainEvents, 'close').at(-1) as { artifacts: string[] }
    const featureClose = ssePayloads(featureEvents, 'close').at(-1) as { artifacts: string[] }
    const mainPath = mainClose.artifacts[0]
    const featurePath = featureClose.artifacts[0]

    assert.ok(mainPath)
    assert.ok(featurePath)
    assert.notEqual(mainPath, featurePath)
    assert.equal(
      await readFile(path.join(fixture.root, ...mainPath.split('/')), 'utf8'),
      'artifact A\n',
    )
    assert.equal(
      await readFile(path.join(fixture.root, ...featurePath.split('/')), 'utf8'),
      'artifact B\n',
    )
    assert.deepEqual(
      (ssePayloads(mainEvents, 'agent-event') as Array<{ type?: string; path?: string }>)
        .filter((event) => event.type === 'file-write')
        .map((event) => event.path),
      [mainPath],
    )
    assert.deepEqual(
      (ssePayloads(featureEvents, 'agent-event') as Array<{ type?: string; path?: string }>)
        .filter((event) => event.type === 'file-write')
        .map((event) => event.path),
      [featurePath],
    )
  } finally {
    await fixture.close()
  }
})

test('transport file events from another immutable run are discarded', async () => {
  const fixture = await startTestDaemon()
  try {
    const runId = await createRun(fixture.baseUrl, {
      ...runBody('node_forged_artifact', 'FORGE_FOREIGN_ARTIFACT'),
      runId: 'artifact-owner-run',
    })
    const eventStream = await fetch(`${fixture.baseUrl}/runs/${runId}/events`)
      .then((response) => response.text())
    const expected = `${artifactRunRelativeDir('main', runId, 'node_forged_artifact')}/output.txt`
    const writes = (ssePayloads(eventStream, 'agent-event') as Array<{
      type?: string
      path?: string
    }>).filter((event) => event.type === 'file-write')

    assert.deepEqual(writes.map((event) => event.path), [expected])
    assert.deepEqual(
      (ssePayloads(eventStream, 'close').at(-1) as { artifacts: string[] }).artifacts,
      [expected],
    )
  } finally {
    await fixture.close()
  }
})

test('error and cancellation terminal snapshots stay inside their immutable run', async () => {
  const fixture = await startTestDaemon()
  try {
    const errorRunId = await createRun(fixture.baseUrl, {
      ...runBody('node_error_artifact', 'WRITE_THEN_ERROR'),
      runId: 'artifact-error-run',
    })
    const errorEvents = await fetch(`${fixture.baseUrl}/runs/${errorRunId}/events`)
      .then((response) => response.text())
    const errorArtifact = `${artifactRunRelativeDir('main', errorRunId, 'node_error_artifact')}/output.txt`
    assert.deepEqual(ssePayloads(errorEvents, 'close').at(-1), {
      runId: errorRunId,
      status: 'error',
      sessionId: 'thread-test-1',
      artifacts: [errorArtifact],
      artifactsComplete: true,
    })

    const cancelRunId = await createRun(fixture.baseUrl, {
      ...runBody('node_cancel_artifact', 'WRITE_THEN_WAIT'),
      runId: 'artifact-cancel-run',
    })
    const cancelArtifact = `${artifactRunRelativeDir('main', cancelRunId, 'node_cancel_artifact')}/output.txt`
    await waitFor(async () => readFile(
      path.join(fixture.root, ...cancelArtifact.split('/')),
      'utf8',
    ).then(() => true).catch(() => false))
    const cancellation = await fetch(`${fixture.baseUrl}/runs/${cancelRunId}/cancel`, { method: 'POST' })
    assert.equal(cancellation.status, 200)
    const cancelEvents = await fetch(`${fixture.baseUrl}/runs/${cancelRunId}/events`)
      .then((response) => response.text())
    assert.deepEqual(ssePayloads(cancelEvents, 'close').at(-1), {
      runId: cancelRunId,
      status: 'cancelled',
      sessionId: 'thread-test-1',
      artifacts: [cancelArtifact],
      artifactsComplete: true,
    })
  } finally {
    await fixture.close()
  }
})

test('terminal protocol errors close an exit-zero run as error', async () => {
  const fixture = await startTestDaemon()
  try {
    const runId = await createRun(fixture.baseUrl, runBody('node_error', 'JSON_ERROR'))
    const response = await fetch(`${fixture.baseUrl}/runs/${runId}/events`)
    const eventStream = await response.text()
    const agentEvents = ssePayloads(eventStream, 'agent-event') as Array<Record<string, unknown>>
    assert.ok(agentEvents.some((event) => event.type === 'error' && event.message === 'synthetic failure'))
    assert.ok(agentEvents.some((event) => event.type === 'done' && event.stopReason === 'error'))
    const close = ssePayloads(eventStream, 'close').at(-1) as { status: string }
    assert.equal(close.status, 'error')
  } finally {
    await fixture.close()
  }
})

test('managed .gg symlink escapes are rejected before writing', async () => {
  const fixture = await startTestDaemon()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-outside-'))
  try {
    await symlink(outside, path.join(fixture.root, '.gg'), 'dir')
    const request = () => fetch(`${fixture.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...runBody('node_symlink', 'must not write outside'),
        runId: 'unsafe-idempotent-run',
      }),
    })
    const [response, retry] = await Promise.all([request(), request()])
    assert.equal(response.status, 403)
    assert.equal(retry.status, 403)
    const payload = await response.json() as { error: { code: string } }
    assert.equal(payload.error.code, 'unsafe_managed_path')
    const events = await fetch(`${fixture.baseUrl}/runs/unsafe-idempotent-run/events`)
    assert.equal(events.status, 404)
    await assert.rejects(readFile(path.join(outside, 'context/pack.md'), 'utf8'))
  } finally {
    await fixture.close()
    await rm(outside, { recursive: true, force: true })
  }
})

test('SSE honors Last-Event-ID and validates malformed replay cursors', async () => {
  const fixture = await startTestDaemon()
  try {
    const runId = await createRun(fixture.baseUrl, runBody('node_replay', 'Create replay data.'))
    const initial = await fetch(`${fixture.baseUrl}/runs/${runId}/events`).then((response) => response.text())
    const ids = initial.match(/^id: (\d+)$/gm)?.map((line) => Number(line.slice(4))) ?? []
    assert.ok(ids.length > 3)

    const cursor = ids[1] ?? 0
    const replay = await fetch(`${fixture.baseUrl}/runs/${runId}/events`, {
      headers: { 'Last-Event-ID': String(cursor) },
    }).then((response) => response.text())
    const replayIds = replay.match(/^id: (\d+)$/gm)?.map((line) => Number(line.slice(4))) ?? []
    assert.ok(replayIds.length > 0)
    assert.ok(replayIds.every((id) => id > cursor))

    const invalid = await fetch(`${fixture.baseUrl}/runs/${runId}/events`, {
      headers: { 'Last-Event-ID': 'not-a-number' },
    })
    assert.equal(invalid.status, 400)
  } finally {
    await fixture.close()
  }
})

test('a terminal done event cannot be rewritten to cancelled during watcher settle', async () => {
  const fixture = await startTestDaemon()
  try {
    const runId = await createRun(fixture.baseUrl, runBody('node_terminal', 'finish normally'))
    const response = await fetch(`${fixture.baseUrl}/runs/${runId}/events`)
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let stream = ''
    while (!stream.includes('"stopReason":"end_turn"')) {
      const chunk = await reader.read()
      if (chunk.done) break
      stream += decoder.decode(chunk.value, { stream: true })
    }
    assert.match(stream, /"stopReason":"end_turn"/)

    const cancel = await fetch(`${fixture.baseUrl}/runs/${runId}/cancel`, { method: 'POST' })
    // The process may still be exiting after its terminal event (200) or may
    // already be in watcher settle (409); either response waits for close.
    assert.ok(cancel.status === 200 || cancel.status === 409)
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      stream += decoder.decode(chunk.value, { stream: true })
    }
    stream += decoder.decode()
    const close = ssePayloads(stream, 'close').at(-1) as { status: string }
    assert.equal(close.status, 'done')
  } finally {
    await fixture.close()
  }
})

test('a CLI that hangs after done remains cancellable without rewriting its terminal result', async () => {
  const fixture = await startTestDaemon()
  try {
    const runId = await createRun(fixture.baseUrl, runBody('node_done_hang', 'DONE_THEN_HANG'))
    const response = await fetch(`${fixture.baseUrl}/runs/${runId}/events`)
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let stream = ''
    while (!stream.includes('"stopReason":"end_turn"')) {
      const chunk = await reader.read()
      if (chunk.done) break
      stream += decoder.decode(chunk.value, { stream: true })
    }
    assert.match(stream, /"stopReason":"end_turn"/)

    const cancel = await fetch(`${fixture.baseUrl}/runs/${runId}/cancel`, { method: 'POST' })
    assert.equal(cancel.status, 200)
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      stream += decoder.decode(chunk.value, { stream: true })
    }
    stream += decoder.decode()
    const close = ssePayloads(stream, 'close').at(-1) as { status: string }
    assert.equal(close.status, 'done')
  } finally {
    await fixture.close()
  }
})

test('persistent run history endpoints paginate, filter, fall back, and delete explicitly', async () => {
  const fixture = await startTestDaemon()
  try {
    const store = new RunLogStore(fixture.root)
    const summary: RunSummary = {
      runId: 'historic-run',
      nodeId: 'node_history',
      agentId: 'codex',
      status: 'running',
      startedAt: 100,
      sessionId: null,
    }
    await store.start(summary)
    await store.append(summary.runId, {
      id: 1,
      event: 'agent-event',
      data: { type: 'thinking', text: 'first' },
    })
    await store.append(summary.runId, {
      id: 2,
      event: 'agent-event',
      data: { type: 'text-delta', text: 'second' },
    })
    await store.append(summary.runId, {
      id: 3,
      event: 'agent-event',
      data: { type: 'done', stopReason: 'end_turn' },
    })
    await store.finish({ ...summary, status: 'done', finishedAt: 200 })

    const persisted = await fetch(`${fixture.baseUrl}/runs/historic-run?projectDir=.`)
    assert.equal(persisted.status, 200)
    assert.equal(((await persisted.json()) as RunSummary).status, 'done')

    const history = await fetch(
      `${fixture.baseUrl}/runs?projectDir=.&nodeId=node_history&limit=1`,
    )
    assert.equal(history.status, 200)
    const historyBody = await history.json() as { runs: RunSummary[] }
    assert.deepEqual(historyBody.runs.map((run) => run.runId), ['historic-run'])

    const firstPage = await fetch(
      `${fixture.baseUrl}/runs/historic-run/log?projectDir=.&afterEventId=0&limit=2`,
    )
    assert.equal(firstPage.status, 200)
    const firstBody = await firstPage.json() as {
      entries: Array<{ id: number }>
      nextEventId: number | null
    }
    assert.deepEqual(firstBody.entries.map((entry) => entry.id), [1, 2])
    assert.equal(firstBody.nextEventId, 2)

    const secondBody = await fetch(
      `${fixture.baseUrl}/runs/historic-run/log?afterEventId=2&limit=2`,
    ).then((response) => response.json()) as {
      entries: Array<{ id: number }>
      nextEventId: number | null
    }
    assert.deepEqual(secondBody.entries.map((entry) => entry.id), [3])
    assert.equal(secondBody.nextEventId, null)

    const deleted = await fetch(`${fixture.baseUrl}/runs/historic-run/log`, {
      method: 'DELETE',
    })
    assert.equal(deleted.status, 200)
    assert.deepEqual(await deleted.json(), { runId: 'historic-run', deleted: true })
    const afterDelete = await fetch(`${fixture.baseUrl}/runs/historic-run/log`)
    assert.equal(afterDelete.status, 200)
    assert.deepEqual(await afterDelete.json(), { entries: [], nextEventId: null })
    const afterDeleteSummary = await fetch(`${fixture.baseUrl}/runs/historic-run`)
      .then((response) => response.json()) as RunSummary
    assert.equal(afterDeleteSummary.logAvailable, false)

    assert.equal((await fetch(`${fixture.baseUrl}/runs/missing-run`)).status, 404)
    assert.equal((await fetch(`${fixture.baseUrl}/runs/missing-run/log`)).status, 404)
    assert.equal((await fetch(`${fixture.baseUrl}/runs?limit=0`)).status, 400)
    assert.equal((await fetch(`${fixture.baseUrl}/runs?limit=1&limit=2`)).status, 400)
    assert.equal((await fetch(`${fixture.baseUrl}/runs/historic-run/log?afterEventId=-1`)).status, 400)
    assert.equal((await fetch(`${fixture.baseUrl}/runs/historic-run?projectDir=..`)).status, 403)
  } finally {
    await fixture.close()
  }
})

test('an active run log cannot be deleted', async () => {
  const fixture = await startTestDaemon()
  try {
    const runId = await createRun(fixture.baseUrl, runBody('node_active_log', 'WAIT_FOR_CANCEL'))
    await waitFor(async () => fixture.daemon.runs.get(runId)?.status === 'running')
    const deletion = await fetch(`${fixture.baseUrl}/runs/${runId}/log`, { method: 'DELETE' })
    assert.equal(deletion.status, 409)
    assert.equal(
      ((await deletion.json()) as { error: { code: string } }).error.code,
      'run_log_active',
    )
    await fetch(`${fixture.baseUrl}/runs/${runId}/cancel`, { method: 'POST' })
  } finally {
    await fixture.close()
  }
})

test('shutdown gates new runs before cancelling the active run set', async () => {
  const fixture = await startTestDaemon()
  try {
    const closing = fixture.daemon.close()
    await assert.rejects(
      fixture.daemon.runs.create(parseCreateRunRequest(runBody('node_late', 'too late'))),
      (error: unknown) => error instanceof ProtocolError && error.code === 'daemon_shutting_down',
    )
    await closing
  } finally {
    await fixture.close()
  }
})

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met before timeout')
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })).stdout
}

const FAKE_CODEX = `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli test')
  process.exit(0)
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using test credentials')
  process.exit(0)
}
if (args[0] === 'exec' && args[1] === '--help') {
  console.log('--json --color --sandbox --cd --add-dir --skip-git-repo-check')
  process.exit(0)
}
if (args[0] === 'exec' && args[1] === 'resume' && args[2] === '--help') {
  console.log('--json')
  process.exit(0)
}

let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString('utf8')
const contextLine = prompt.split('\\n').find((line) => line.startsWith('Context file (read-only): '))
const contextFile = contextLine ? JSON.parse(contextLine.slice('Context file (read-only): '.length)) : ''
const projectLine = prompt.split('\\n').find((line) => line.startsWith('Project root (read-only): '))
const projectDir = projectLine ? JSON.parse(projectLine.slice('Project root (read-only): '.length)) : process.cwd()
const sourceLine = prompt.split('\\n').find((line) => line.startsWith('Source worktree (writable): '))
const sourceProjectDir = sourceLine ? JSON.parse(sourceLine.slice('Source worktree (writable): '.length)) : ''
const artifactLine = prompt.split('\\n').find((line) => line.startsWith('Writable artifact directory: '))
const artifactDir = artifactLine ? JSON.parse(artifactLine.slice('Writable artifact directory: '.length)) : ''
const nodeId = artifactDir ? path.basename(artifactDir) : ''
if (!nodeId) {
  console.error('missing artifact contract')
  process.exit(2)
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test-1' }))
const pack = await readFile(contextFile || path.join(projectDir, '.gg/context/pack.md'), 'utf8')
const writeOutput = async (contents) => {
  const outputPath = path.join(artifactDir, 'output.txt')
  const relative = path.relative(projectDir, outputPath).split(path.sep).join('/')
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, contents)
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: relative }] } }))
}
if (pack.includes('WRITE_SOURCE')) {
  if (!sourceProjectDir) {
    console.error('missing writable source worktree contract')
    process.exit(2)
  }
  await mkdir(path.join(sourceProjectDir, 'src'), { recursive: true })
  await writeFile(path.join(sourceProjectDir, 'src', 'auto.txt'), process.cwd() + '\\n')
}
if (pack.includes('WRITE_THEN_WAIT')) {
  await writeOutput('before cancellation\\n')
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1_000)
} else if (pack.includes('WAIT_FOR_CANCEL')) {
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1_000)
} else if (pack.includes('DONE_THEN_HANG')) {
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }))
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1_000)
} else if (pack.includes('WRITE_THEN_ERROR')) {
  await writeOutput('before error\\n')
  console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'synthetic failure' } }))
} else if (pack.includes('JSON_ERROR')) {
  console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'synthetic failure' } }))
} else {
  const outputPath = path.join(artifactDir, 'output.txt')
  const relative = path.relative(projectDir, outputPath).split(path.sep).join('/')
  if (pack.includes('FORGE_FOREIGN_ARTIFACT')) {
    const foreignPath = path.join(path.dirname(path.dirname(artifactDir)), 'foreign-run', nodeId, 'forged.txt')
    const foreignRelative = path.relative(projectDir, foreignPath).split(path.sep).join('/')
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: foreignRelative }] } }))
  }
  await mkdir(path.dirname(outputPath), { recursive: true })
  const artifactContents = pack.includes('ARTIFACT_CONTENT_A')
    ? 'artifact A\\n'
    : pack.includes('ARTIFACT_CONTENT_B')
      ? 'artifact B\\n'
      : 'created by fake codex\\n'
  await writeFile(outputPath, artifactContents)
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: relative }] } }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Finished.' } }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }))
}
`
