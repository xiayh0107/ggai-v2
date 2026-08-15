import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunCapabilityReceiptStore } from '../capabilityReceipt.js'
import { CapabilityExecutionScopes } from '../capabilityScopes.js'
import { BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT } from '../pluginCapabilities.js'
import type { RunStreamMessage, RunSummary } from '../protocol.js'
import {
  installRunCapabilityReceiptIntegration,
  type CapabilityReceiptRunManager,
} from '../runCapabilityIntegration.js'
import { CAPABILITY_PROFILE_SCHEMA_VERSION } from '../runtime/composition.js'
import { ServiceScope } from '../runtime/services.js'
import {
  EMPTY_SKILL_CAPABILITY_DIGEST,
  type ResolvedTaskRunRequest,
} from '../taskRunTypes.js'
import type { RunCreationOptions } from '../runs.js'

const profile = {
  schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
  id: '@ggai/test-runtime',
  version: '1.0.0',
  bundles: [],
} as const

test('Run reservation pins a capability receipt and releases its Run scope on close', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-run-receipt-')))
  const parent = new ServiceScope({ label: 'test-runtime' })
  const scopes = new CapabilityExecutionScopes(parent)
  let listener: ((message: RunStreamMessage & { readonly id: number }) => void) | undefined
  const manager: CapabilityReceiptRunManager = {
    async create(request, options: RunCreationOptions = {}): Promise<RunSummary> {
      await options.validateReserved?.()
      assert.ok(await new RunCapabilityReceiptStore(root).get(request.runId ?? ''))
      return summary(request.runId ?? '', request.agentId)
    },
    subscribe(_runId, next) {
      listener = next
      return {
        history: [],
        closed: false,
        replayGap: false,
        unsubscribe() {
          listener = undefined
        },
      }
    },
  }
  const uninstall = installRunCapabilityReceiptIntegration(manager, {
    projectRoot: root,
    scopes,
    profile,
    agentProvider: () => '@ggai/agent-transport-test',
  })
  t.after(async () => {
    await uninstall()
    await scopes.dispose()
    await parent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  const request = resolvedTaskRequest('receipt-run')
  await manager.create(request)
  const receipt = await new RunCapabilityReceiptStore(root).get('receipt-run')
  assert.ok(receipt)
  assert.deepEqual(
    receipt.semanticCapabilities.map(({ key, provider, digest }) => ({ key, provider, digest })),
    [
      {
        key: 'ggai.agent-selection.v1',
        provider: '@ggai/agent-transport-test',
        digest: receipt.semanticCapabilities[0]?.digest,
      },
      {
        key: 'ggai.node-projection.v2',
        provider: '@ggai/projection-capability-authority',
        digest: BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT.digest,
      },
      {
        key: 'ggai.run-skills.v1',
        provider: '@ggai/skill-asset-authority',
        digest: EMPTY_SKILL_CAPABILITY_DIGEST,
      },
    ],
  )
  assert.equal(scopes.snapshot().workspaces[0]?.runs.length, 1)

  listener?.({
    id: 1,
    event: 'close',
    data: {
      runId: 'receipt-run',
      status: 'done',
      sessionId: null,
      artifacts: [],
      artifactsComplete: true,
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(scopes.snapshot().workspaces[0]?.runs.length, 0)
})

test('missing semantic provider fails before the wrapped Run is accepted', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-run-receipt-deny-')))
  const parent = new ServiceScope({ label: 'test-runtime' })
  const scopes = new CapabilityExecutionScopes(parent)
  let accepted = false
  const manager: CapabilityReceiptRunManager = {
    async create(request, options: RunCreationOptions = {}): Promise<RunSummary> {
      await options.validateReserved?.()
      accepted = true
      return summary(request.runId ?? '', request.agentId)
    },
    subscribe() {
      return null
    },
  }
  const uninstall = installRunCapabilityReceiptIntegration(manager, {
    projectRoot: root,
    scopes,
    profile,
    agentProvider: () => undefined,
  })
  t.after(async () => {
    await uninstall()
    await scopes.dispose()
    await parent.dispose()
    await rm(root, { recursive: true, force: true })
  })

  await assert.rejects(manager.create(resolvedTaskRequest('denied-run')), /Agent provider/u)
  assert.equal(accepted, false)
  assert.equal(await new RunCapabilityReceiptStore(root).get('denied-run'), null)
  assert.equal(scopes.snapshot().workspaces[0]?.runs.length, 0)
})

function resolvedTaskRequest(runId: string): ResolvedTaskRunRequest {
  return {
    schemaVersion: 2,
    runId,
    taskId: 'task-1',
    agentId: 'codex',
    canvasBranch: 'main',
    baseRevision: 1,
    prompt: 'Create an artifact',
    attachments: [],
    materializationPolicy: 'auto',
    projectDir: '.',
    canvasDocument: {
      schemaVersion: 2,
      tasks: [],
      nodes: [],
      edges: [],
      collections: [],
      receipts: [],
      everCreated: false,
    },
    resolvedArtifactAttachments: [],
    resolvedNodeAttachments: [],
    resolvedSkills: [],
    skillCapabilityDigest: EMPTY_SKILL_CAPABILITY_DIGEST,
    pluginCapabilities: BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
    automationMode: 'confirm',
  }
}

function summary(runId: string, agentId: string): RunSummary {
  return {
    runId,
    nodeId: 'task-1',
    agentId,
    canvasBranch: 'main',
    status: 'preparing',
    startedAt: 1,
    sessionId: null,
  }
}
