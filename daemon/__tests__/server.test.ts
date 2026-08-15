import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { RunSummary } from '../protocol.js'
import { AgentRegistry } from '../registry.js'
import { RunLogStore } from '../runLogs.js'
import { createDaemonServer, type DaemonServer } from '../server.js'

interface TestDaemon {
  root: string
  baseUrl: string
  daemon: DaemonServer
  close(): Promise<void>
}

async function startTestDaemon(
  allowedOrigins: string[] = [],
): Promise<TestDaemon> {
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

test('Run history endpoints never expose persisted legacy summaries', async () => {
  const fixture = await startTestDaemon()
  try {
    const logs = new RunLogStore(fixture.root)
    await logs.start({
      runId: 'legacy-history-run',
      nodeId: 'node-legacy',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'done',
      startedAt: 300,
      finishedAt: 301,
      sessionId: null,
    })
    await logs.start({
      runId: 'task-history-run',
      taskId: 'task-history',
      nodeId: 'task-history',
      agentId: 'codex',
      canvasBranch: 'main',
      status: 'done',
      startedAt: 200,
      finishedAt: 201,
      sessionId: null,
    })

    const history = await fetch(`${fixture.baseUrl}/runs?limit=1`)
    assert.equal(history.status, 200)
    assert.deepEqual(
      (await history.json() as { runs: Array<{ runId: string }> }).runs.map((run) => run.runId),
      ['task-history-run'],
    )
    assert.equal((await fetch(`${fixture.baseUrl}/runs/legacy-history-run`)).status, 404)
    assert.equal((await fetch(`${fixture.baseUrl}/runs/legacy-history-run/log`)).status, 404)
  } finally {
    await fixture.close()
  }
})

test('Canvas command API persists reducer commands with CAS', async () => {
  const fixture = await startTestDaemon()
  try {
    const health = await (await fetch(`${fixture.baseUrl}/health`)).json() as {
      capabilities?: { canvas?: boolean }
    }
    assert.equal(health.capabilities?.canvas, true)

    const emptyResponse = await fetch(`${fixture.baseUrl}/canvas?branch=main`)
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

test('Canvas HTTP retries remain exactly once after an intervening mutation', async () => {
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

test('plugin capability handshake pins strict data before accepting a Run', async () => {
  const fixture = await startTestDaemon()
  const headers = { 'Content-Type': 'application/json' }
  try {
    const capabilityResponse = await fetch(`${fixture.baseUrl}/plugin-capabilities`, {
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

    const override = await fetch(`${fixture.baseUrl}/plugin-capabilities`, {
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

    const forged = await fetch(`${fixture.baseUrl}/plugin-capabilities`, {
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

test('RunIntent executes only against the exact persisted Canvas revision', async () => {
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
            title: 'Server task',
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
      prompt: 'SERVER_PROMPT',
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
        code: 'canvas_revision_conflict',
        message: 'Canvas revision changed; current revision is 1',
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
      'invalid_run_intent')

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
          size: number
          contentDigest: string
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

    const rejectedLogDeletion = await fetch(
      `${fixture.baseUrl}/runs/${intent.runId}/log?projectDir=.`,
      { method: 'DELETE' },
    )
    assert.equal(rejectedLogDeletion.status, 405)
    assert.deepEqual(await rejectedLogDeletion.json(), {
      error: {
        code: 'run_log_delete_unsupported',
        message: 'Canvas run logs are durable execution records and cannot be deleted independently',
      },
    })
    const retainedLog = await fetch(
      `${fixture.baseUrl}/runs/${intent.runId}/log?projectDir=.`,
    )
    assert.equal(retainedLog.status, 200)
    const retainedLogPage = await retainedLog.json() as typeof logPage
    const retainedClose = retainedLogPage?.entries.find((entry) => entry.event === 'close')?.data
    assert.deepEqual(retainedClose, close)
    const retainedPlanResponse = await fetch(
      `${fixture.baseUrl}/projection-plans/${close.projectionPlan.planId}?projectDir=.&branch=main`,
    )
    assert.equal(retainedPlanResponse.status, 200)
    assert.deepEqual(await retainedPlanResponse.json(), {
      plan: close.projectionPlan,
      suggestedActions: close.suggestedActions,
    })
    const retainedArtifact = close.artifactManifest.entries[0]!
    const retainedManifestEntryResponse = await fetch(
      `${fixture.baseUrl}/runs/${intent.runId}/artifacts/${retainedArtifact.artifactId}/metadata`,
    )
    assert.equal(retainedManifestEntryResponse.status, 200)
    assert.deepEqual(await retainedManifestEntryResponse.json(), {
      schemaVersion: 2,
      runId: intent.runId,
      artifactId: retainedArtifact.artifactId,
      mediaType: retainedArtifact.mediaType,
      size: retainedArtifact.size,
      contentDigest: retainedArtifact.contentDigest,
    })
    let materializedCanvas: {
      revision: number
      document: {
        nodes: Array<{ type: string; artifactRefs: Array<{ artifactId: string }> }>
        receipts: Array<{ kind: string; planId: string }>
      }
    } | undefined
    await waitFor(async () => {
      const canvasResponse = await fetch(`${fixture.baseUrl}/canvas?branch=main`)
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
    assert.equal(rawPathResponse.status, 404)
    assert.equal(
      (await rawPathResponse.json() as { error: { code: string } }).error.code,
      'not_found',
    )

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
    assert.match(pack, /SERVER_PROMPT/u)
    assert.doesNotMatch(pack, /canvasSnapshot/u)

    const history = await fetch(`${fixture.baseUrl}/runs?taskId=task-server-v2`)
    assert.equal(history.status, 200)
    assert.equal((await history.json() as { runs: RunSummary[] }).runs[0]?.runId, intent.runId)
  } finally {
    await fixture.close()
  }
})

test('Run context applies one pinned Node policy to edges and explicit attachments', async () => {
  const fixture = await startTestDaemon()
  const headers = { 'Content-Type': 'application/json' }
  const commit = async (
    baseRevision: number,
    mutationId: string,
    command: Record<string, unknown>,
  ): Promise<number> => {
    const response = await fetch(`${fixture.baseUrl}/canvas/commands?projectDir=.`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ branch: 'main', baseRevision, mutationId, command }),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    return (JSON.parse(text) as { revision: number }).revision
  }
  try {
    const registrationResponse = await fetch(
      `${fixture.baseUrl}/plugin-capabilities?projectDir=.`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          schemaVersion: 2,
          plugins: [{
            id: '@community/semantic',
            artifactClaims: [],
            nodeContext: {
              schemaVersion: 1,
              summary: { textMaxChars: 2, payloadFields: ['visible'] },
              full: { textMaxChars: 4, payloadFields: ['visible'], artifactRefs: 'none' },
            },
          }],
        }),
      },
    )
    const registrationText = await registrationResponse.text()
    assert.equal(registrationResponse.status, 200, registrationText)
    const registration = JSON.parse(registrationText) as { digest: string }

    let revision = await commit(0, 'create-context-policy-source', {
      type: 'CreateNode',
      node: {
        id: 'node-context-policy-source',
        type: '@community/semantic',
        frame: { x: 100, y: 100, w: 320, h: 180, z: 1 },
        title: 'Semantic source',
        text: 'abcdef',
        payload: { visible: 'keep', secret: 'omit' },
        artifactRefs: [],
        origin: { kind: 'user' },
      },
    })
    revision = await commit(revision, 'create-context-policy-task', {
      type: 'CreateTask',
      task: {
        id: 'task-context-policy',
        title: 'Use semantic source',
        goal: 'Use only the plugin-declared semantic Node fields',
        anchor: { x: 500, y: 100 },
        origin: { kind: 'user' },
      },
    })
    revision = await commit(revision, 'connect-context-policy-source', {
      type: 'CreateEdges',
      edges: [{
        id: 'edge-context-policy-source',
        from: { kind: 'node', id: 'node-context-policy-source' },
        to: { kind: 'task', id: 'task-context-policy' },
        relation: 'source',
        contextRole: 'full',
        origin: { kind: 'user' },
      }],
    })

    const runId = 'run-context-policy'
    const accepted = await fetch(
      `${fixture.baseUrl}/runs?projectDir=.&pluginCapabilityDigest=${registration.digest}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          schemaVersion: 2,
          runId,
          taskId: 'task-context-policy',
          agentId: 'codex',
          canvasBranch: 'main',
          baseRevision: revision,
          prompt: 'Use the semantic source.',
          attachments: [{ kind: 'node', nodeId: 'node-context-policy-source' }],
          materializationPolicy: 'auto',
        }),
      },
    )
    assert.equal(accepted.status, 202, await accepted.text())
    await waitFor(async () => (await fixture.daemon.runs.getPersisted(runId))?.status === 'done')

    const pack = JSON.parse(await readFile(path.join(
      fixture.root,
      '.gg',
      'context',
      'runs',
      runId,
      'pack.json',
    ), 'utf8')) as {
      schemaVersion: number
      inputs: Array<{
        text: string | null
        payload: Record<string, unknown> | null
        artifactRefs: unknown[]
        contextProjection: {
          policySource: string
          artifactRefs: { omittedByPolicy: number }
        }
      }>
      explicitNodeAttachments: {
        nodes: Array<{
          text?: string
          payload?: Record<string, unknown>
          artifactRefs: unknown[]
          contextProjection: {
            policySource: string
            artifactRefs: { omittedByPolicy: number }
          }
        }>
      }
      verifiedArtifactAttachments: unknown[]
    }
    assert.equal(pack.schemaVersion, 3)
    assert.deepEqual(pack.inputs[0]?.text, 'abcd')
    assert.deepEqual(pack.inputs[0]?.payload, { visible: 'keep' })
    assert.deepEqual(pack.inputs[0]?.artifactRefs, [])
    assert.deepEqual(pack.verifiedArtifactAttachments, [])
    assert.equal(pack.inputs[0]?.contextProjection.policySource, 'plugin')
    assert.equal(pack.inputs[0]?.contextProjection.artifactRefs.omittedByPolicy, 0)
    assert.equal(pack.explicitNodeAttachments.nodes[0]?.text, 'abcd')
    assert.deepEqual(pack.explicitNodeAttachments.nodes[0]?.payload, { visible: 'keep' })
    assert.deepEqual(pack.explicitNodeAttachments.nodes[0]?.artifactRefs, [])
    assert.equal(
      pack.explicitNodeAttachments.nodes[0]?.contextProjection.policySource,
      'plugin',
    )
    assert.equal(
      pack.explicitNodeAttachments.nodes[0]?.contextProjection.artifactRefs.omittedByPolicy,
      0,
    )
    assert.doesNotMatch(JSON.stringify(pack), /secret/u)
  } finally {
    await fixture.close()
  }
})

test('RunIntent resolves readable artifacts from pinned full edges only', async () => {
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
    const response = await fetch(`${fixture.baseUrl}/canvas?projectDir=.&branch=main`)
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
  }> => runTaskWithAttachments(taskId, runId, [])
  const runTaskWithAttachments = async (
    taskId: string,
    runId: string,
    attachments: Array<
      | { kind: 'node'; nodeId: string }
      | { kind: 'artifact'; runId: string; artifactId: string }
    >,
    afterAccepted?: () => Promise<void>,
  ): Promise<{
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
        attachments,
        materializationPolicy: 'auto',
      }),
    })
    assert.equal(response.status, 202, await response.text())
    await afterAccepted?.()

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

    const outputSlotNodeId = 'node-community-review-slot'
    await commit('create-community-review-slot', {
      type: 'CreateNode',
      node: {
        id: outputSlotNodeId,
        type: '@community/review',
        frame: { x: 460, y: 100, w: 320, h: 220, z: 2 },
        title: 'Community review slot',
        payload: {},
        artifactRefs: [],
        origin: { kind: 'user' },
      },
    })
    await commit('connect-source-to-community-review-slot', {
      type: 'CreateEdges',
      edges: [{
        id: 'edge-community-source-slot',
        from: { kind: 'node', id: sourceNode.id },
        to: { kind: 'node', id: outputSlotNodeId },
        relation: 'source',
        contextRole: 'full',
        origin: { kind: 'user' },
      }],
    })
    const promotedSlotCanvas = await commit('promote-community-review-slot', {
      type: 'CreateTaskForOutputSlot',
      task: {
        id: 'task-context-output-slot',
        title: 'Review the source through a community output slot',
        goal: 'Review the source artifact',
        anchor: { x: 420, y: 80 },
        origin: { kind: 'user' },
      },
      nodeId: outputSlotNodeId,
    })
    assert.ok(promotedSlotCanvas.document.nodes.find((node) =>
      node.id === outputSlotNodeId)?.homeTaskId === 'task-context-output-slot')
    const promotedInput = await runTask(
      'task-context-output-slot',
      'run-context-output-slot',
    )
    const promotedPackJson = JSON.parse(await readFile(path.join(
      fixture.root,
      '.gg',
      'context',
      'runs',
      'run-context-output-slot',
      'pack.json',
    ), 'utf8')) as {
      inputs: Array<{
        ref: { kind: string; id: string }
        contextRole: string
        artifactRefs?: Array<{ runId: string; artifactId: string }>
      }>
      explicitNodeAttachments: { nodes: unknown[] }
      verifiedArtifactAttachments: Array<{ runId: string; artifactId: string }>
    }
    assert.equal(promotedPackJson.inputs.length, 1)
    assert.deepEqual(promotedPackJson.inputs[0]?.ref, {
      kind: 'node',
      id: sourceNode.id,
    })
    assert.equal(promotedPackJson.inputs[0]?.contextRole, 'full')
    assert.deepEqual(promotedPackJson.inputs[0]?.artifactRefs, [{
      runId: 'run-context-source',
      artifactId: sourceArtifact.artifactId,
    }])
    assert.deepEqual(promotedPackJson.explicitNodeAttachments.nodes, [])
    assert.equal(promotedPackJson.verifiedArtifactAttachments.length, 1)
    assert.equal(promotedPackJson.verifiedArtifactAttachments[0]?.runId, 'run-context-source')
    assert.equal(
      promotedPackJson.verifiedArtifactAttachments[0]?.artifactId,
      sourceArtifact.artifactId,
    )
    assert.match(promotedInput.pack, /Verified read-only artifact attachments/u)
    assert.match(promotedInput.pack, new RegExp(sourceArtifact.artifactId, 'u'))

    await commit('update-explicit-node-attachment-content', {
      type: 'UpdateNodeContent',
      nodeId: sourceNode.id,
      patch: {
        title: 'Explicit Node input',
        text: `PINNED_EXPLICIT_NODE_CONTENT\n${'x'.repeat(150_000)}NODE_TEXT_TAIL`,
        payload: {
          heading: 'PINNED_NODE_PAYLOAD',
          italic: `${'y'.repeat(150_000)}NODE_PAYLOAD_TAIL`,
        },
      },
    })
    const copiedNodeId = 'node-explicit-shared-artifact-copy'
    await commit('duplicate-explicit-node-shared-artifact', {
      type: 'DuplicateNode',
      sourceNodeId: sourceNode.id,
      newNodeId: copiedNodeId,
      offset: { x: 40, y: 40 },
      title: 'Copied explicit Node input',
    })
    await commit('create-explicit-node-attachment-task', {
      type: 'CreateTask',
      task: {
        id: 'task-explicit-node-attachment',
        title: 'Explicit Node attachment',
        goal: 'Use the explicitly selected Node snapshot',
        anchor: { x: 400, y: 20 },
        origin: { kind: 'user' },
      },
    })

    const beforeExplicitRun = await canvas()
    const missingNode = await fetch(`${fixture.baseUrl}/runs?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        runId: 'run-explicit-node-missing',
        taskId: 'task-explicit-node-attachment',
        agentId: 'codex',
        canvasBranch: 'main',
        baseRevision: beforeExplicitRun.revision,
        prompt: 'must reject a missing Node',
        attachments: [{ kind: 'node', nodeId: 'node-does-not-exist' }],
        materializationPolicy: 'auto',
      }),
    })
    assert.equal(missingNode.status, 404)
    assert.equal((await missingNode.json() as { error: { code: string } }).error.code,
      'attachment_not_found')
    assert.equal(fixture.daemon.runs.get('run-explicit-node-missing'), null)

    const forgedNodePath = await fetch(`${fixture.baseUrl}/runs?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        runId: 'run-explicit-node-forged-path',
        taskId: 'task-explicit-node-attachment',
        agentId: 'codex',
        canvasBranch: 'main',
        baseRevision: beforeExplicitRun.revision,
        prompt: 'must reject browser-provided paths',
        attachments: [{
          kind: 'node',
          nodeId: sourceNode.id,
          path: '/etc/passwd',
        }],
        materializationPolicy: 'auto',
      }),
    })
    assert.equal(forgedNodePath.status, 400)
    assert.equal((await forgedNodePath.json() as { error: { code: string } }).error.code,
      'invalid_run_intent')

    const explicit = await runTaskWithAttachments(
      'task-explicit-node-attachment',
      'run-explicit-node-attachment',
      [{ kind: 'node', nodeId: sourceNode.id }, {
        kind: 'node',
        nodeId: copiedNodeId,
      }, {
        kind: 'artifact',
        runId: 'run-context-source',
        artifactId: sourceArtifact.artifactId,
      }],
      async () => {
        await commit('mutate-node-after-run-acceptance', {
          type: 'UpdateNodeContent',
          nodeId: sourceNode.id,
          patch: {
            text: 'MUTATED_AFTER_RUN_ACCEPTANCE',
            payload: { heading: 'MUTATED_AFTER_RUN_ACCEPTANCE' },
          },
        })
      },
    )
    assert.match(explicit.pack, /Explicit node attachments for this run/u)
    assert.match(explicit.pack, /PINNED_EXPLICIT_NODE_CONTENT/u)
    assert.match(explicit.pack, /PINNED_NODE_PAYLOAD/u)
    assert.doesNotMatch(explicit.pack, /MUTATED_AFTER_RUN_ACCEPTANCE/u)
    assert.doesNotMatch(explicit.pack, /NODE_TEXT_TAIL|NODE_PAYLOAD_TAIL/u)
    const explicitPackJson = JSON.parse(await readFile(path.join(
      fixture.root,
      '.gg',
      'context',
      'runs',
      'run-explicit-node-attachment',
      'pack.json',
    ), 'utf8')) as {
      explicitNodeAttachments: {
        canvasRevision: number
        nodes: Array<{
          id: string
          artifactRefs: Array<{ runId: string; artifactId: string }>
          truncation: { text: boolean; payload: boolean }
        }>
      }
      verifiedArtifactAttachments: Array<{ runId: string; artifactId: string }>
    }
    assert.equal(explicitPackJson.explicitNodeAttachments.canvasRevision, beforeExplicitRun.revision)
    assert.deepEqual(explicitPackJson.explicitNodeAttachments.nodes[0]?.artifactRefs, [{
      runId: 'run-context-source',
      artifactId: sourceArtifact.artifactId,
    }])
    assert.deepEqual(
      explicitPackJson.explicitNodeAttachments.nodes.map((node) => node.id),
      [sourceNode.id, copiedNodeId],
    )
    assert.deepEqual(explicitPackJson.explicitNodeAttachments.nodes[1]?.artifactRefs, [{
      runId: 'run-context-source',
      artifactId: sourceArtifact.artifactId,
    }])
    assert.deepEqual(explicitPackJson.explicitNodeAttachments.nodes[0]?.truncation, {
      text: true,
      payload: true,
    })
    assert.equal(explicitPackJson.verifiedArtifactAttachments.filter((artifact) =>
      artifact.runId === 'run-context-source'
      && artifact.artifactId === sourceArtifact.artifactId).length, 1)
    const explicitOutput = explicit.close.artifactManifest.entries[0]
    assert.ok(explicitOutput)
    const explicitOutputLookup = await fixture.daemon.runs.lookupRunArtifact(
      'run-explicit-node-attachment',
      explicitOutput.artifactId,
      '.',
    )
    assert.ok(explicitOutputLookup)
    assert.equal(
      await readFile(explicitOutputLookup.absolutePath, 'utf8'),
      'received explicit node attachment\n',
    )

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

    await commit('create-bad-explicit-node-attachment-task', {
      type: 'CreateTask',
      task: {
        id: 'task-bad-explicit-node-attachment',
        title: 'Bad explicit Node attachment',
        goal: 'Must fail closed for an unavailable Node artifact',
        anchor: { x: 800, y: 20 },
        origin: { kind: 'user' },
      },
    })
    const beforeBadNodeAttachment = await canvas()
    const badNodeArtifact = await fetch(`${fixture.baseUrl}/runs?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        runId: 'run-bad-explicit-node-attachment',
        taskId: 'task-bad-explicit-node-attachment',
        agentId: 'codex',
        canvasBranch: 'main',
        baseRevision: beforeBadNodeAttachment.revision,
        prompt: 'must not run without every Node artifact',
        attachments: [{ kind: 'node', nodeId: sourceNode.id }],
        materializationPolicy: 'auto',
      }),
    })
    assert.equal(badNodeArtifact.status, 409)
    assert.equal((await badNodeArtifact.json() as { error: { code: string } }).error.code,
      'node_attachment_artifact_unavailable')
    assert.equal(fixture.daemon.runs.get('run-bad-explicit-node-attachment'), null)

    const beforeForeignNode = await canvas()
    const foreignArtifactId = `artifact_${'e'.repeat(64)}`
    const foreignPlanId = `plan_${'e'.repeat(64)}`
    const foreignNodeCanvas = await fixture.daemon.canvas.commit(
      '.',
      'main',
      beforeForeignNode.revision,
      'trusted-foreign-artifact-test-fixture',
      {
        type: 'MaterializeProjectionPlan',
        plan: {
          schemaVersion: 2,
          taskId: 'task-bad-explicit-node-attachment',
          planId: foreignPlanId,
          runId: 'run-without-a-closed-manifest',
          status: 'complete',
          manifestDigest: 'e'.repeat(64),
          outputs: [{
            key: 'foreign-artifact',
            pluginId: 'file',
            role: 'primary',
            title: 'Foreign artifact identity',
            artifactRefs: [{
              runId: 'run-without-a-closed-manifest',
              artifactId: foreignArtifactId,
            }],
            derivedFrom: [],
            materialize: true,
          }],
          taskProposals: [],
          warnings: [],
          digest: 'f'.repeat(64),
        },
      },
    )
    const foreignNode = foreignNodeCanvas.document.nodes.find((node) =>
      node.artifactRefs.some((artifact) => artifact.artifactId === foreignArtifactId))
    assert.ok(foreignNode)
    const foreignNodeArtifact = await fetch(`${fixture.baseUrl}/runs?projectDir=.`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        runId: 'run-foreign-explicit-node-attachment',
        taskId: 'task-bad-explicit-node-attachment',
        agentId: 'codex',
        canvasBranch: 'main',
        baseRevision: foreignNodeCanvas.revision,
        prompt: 'must not trust a foreign Run identity from Canvas content',
        attachments: [{ kind: 'node', nodeId: foreignNode.id }],
        materializationPolicy: 'auto',
      }),
    })
    assert.equal(foreignNodeArtifact.status, 409)
    assert.equal((await foreignNodeArtifact.json() as { error: { code: string } }).error.code,
      'node_attachment_artifact_unavailable')
    assert.equal(fixture.daemon.runs.get('run-foreign-explicit-node-attachment'), null)

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

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met before timeout')
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
  const artifactContents = pack.includes('PINNED_EXPLICIT_NODE_CONTENT')
    ? 'received explicit node attachment\\n'
    : pack.includes('ARTIFACT_CONTENT_A')
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
