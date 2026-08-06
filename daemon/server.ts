import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { CanvasCommandError, type CanvasCommandV2 } from '../src/canvas-v2/commands.js'
import type { CanvasDocumentV2 } from '../src/canvas-v2/model.js'
import {
  compileTaskContextV2,
  taskContextArtifactRefsV2,
} from '../src/agent/contextV2.js'
import {
  CanvasMutationReuseV2Error,
  CanvasRevisionConflictV2Error,
  CanvasSnapshotV2Error,
} from './canvasCommandStoreV2.js'
import { CanvasCommandStoreV2Manager } from './canvasCommandStoreV2Manager.js'
import {
  parseCanvasConflictRecoveryRequestV2,
  parseCanvasCommandRequestV2,
  type CanvasCommandWireV2,
  type OrdinaryCanvasCommandV2,
} from './canvasCommandProtocolV2.js'
import {
  autoMaterializeProjectionPlanV2,
  commitProjectionPlanCommandV2,
  type CanvasProjectionCommitterV2,
  ProjectionPlanUnavailableV2Error,
  trustedCanvasCommandFromPlanV2,
} from './canvasProjectionCoordinatorV2.js'
import { CanvasGitV2Error } from './canvasGitV2.js'
import { PermissionPolicyError } from './permissions.js'
import {
  BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2,
  ProjectionPluginCapabilityStoreV2,
  type ProjectionPluginCapabilitySnapshotV2,
} from './pluginCapabilitiesV2.js'
import {
  parseCanvasBranch,
  parsePermissionDecision,
  parseRunId,
  ProtocolError,
  type RunStreamMessage,
} from './protocol.js'
import { ProjectLeaseManager } from './projectLease.js'
import { AgentRegistry } from './registry.js'
import type { RunArtifactLookupV2 } from './runArtifactStorageV2.js'
import { RunManager } from './runs.js'
import {
  parseRunIntentV2,
  parseTaskIdV2,
  TaskRunProtocolV2Error,
  type RunIntentV2,
} from './taskRunProtocolV2.js'
import type { ResolvedArtifactAttachmentV2 } from './taskRunTypesV2.js'
import { TaskSessionsV2CorruptionError } from './taskSessionsV2.js'
import {
  WorkspaceVersionManagerV2,
  WorkspaceVersioningV2Error,
  type WorkspaceMergeExpectationV2,
} from './workspaceVersioningV2.js'

const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024
const SSE_HEARTBEAT_MS = 15_000
const MAX_SSE_BUFFER_BYTES = 512 * 1024
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
const MAX_TEXT_ARTIFACT_BYTES = 1 * 1024 * 1024
const DEFAULT_BROWSER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
])

export interface DaemonServerOptions {
  projectRoot: string
  allowedOrigins?: string[]
  registry?: AgentRegistry
  runManager?: RunManager
  workspaceVersionManagerV2?: WorkspaceVersionManagerV2
  canvasCommandStoreV2Manager?: CanvasCommandStoreV2Manager
  projectLeaseManager?: ProjectLeaseManager
}

export interface DaemonServer {
  server: Server
  registry: AgentRegistry
  runs: RunManager
  versionsV2: WorkspaceVersionManagerV2
  canvasV2: CanvasCommandStoreV2Manager
  close(): Promise<void>
}

export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const registry = options.registry ?? new AgentRegistry()
  const projectLeases = options.projectLeaseManager ?? new ProjectLeaseManager({
    projectRoot: options.projectRoot,
  })
  const canvasV2 = options.canvasCommandStoreV2Manager ?? new CanvasCommandStoreV2Manager({
    projectRoot: options.projectRoot,
    acquireProjectLease: (projectDir) => projectLeases.acquire(projectDir),
  })
  const versionsV2 = options.workspaceVersionManagerV2 ?? new WorkspaceVersionManagerV2({
    projectRoot: options.projectRoot,
    canvasStoreManager: canvasV2,
  })
  if (options.workspaceVersionManagerV2 && versionsV2.canvases !== canvasV2) {
    throw new TypeError('workspaceVersionManagerV2 and canvasCommandStoreV2Manager must share a store')
  }
  const projectionCanvases = workspaceProjectionCommitterV2(versionsV2)
  const runs = options.runManager ?? new RunManager({
    projectRoot: options.projectRoot,
    registry,
    acquireProjectLease: (projectDir) => canvasV2.acquireProjectLease(projectDir),
    resolveSourceProjectDir: async ({ projectDir, canvasBranch, taskOwned }) => {
      if (!taskOwned) {
        throw new ProtocolError(
          'legacy snapshot Runs are not supported by the Canvas V2 daemon',
          'legacy_api_removed',
          410,
        )
      }
      await versionsV2.sourceExecutionProjectDir(projectDir, canvasBranch)
      return null
    },
    onProjectionPlanReady: ({ plan, projectDir, canvasBranch }) =>
      autoMaterializeProjectionPlanV2({
        canvases: projectionCanvases,
        projectDir,
        branch: canvasBranch,
        plan,
      }).then(() => undefined),
  })
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  const sockets = new Set<Socket>()
  const lifecycle = { closing: false }
  let closePromise: Promise<void> | null = null

  const server = createServer((request, response) => {
    void route(request, response, {
      projectRoot: options.projectRoot,
      registry,
      runs,
      canvasV2,
      versionsV2,
      projectionCanvases,
      allowedOrigins,
      lifecycle,
    })
      .catch((error: unknown) => writeError(response, error))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  return {
    server,
    registry,
    runs,
    versionsV2,
    canvasV2,
    close() {
      closePromise ??= closeDaemonServer(
        server,
        sockets,
        runs,
        versionsV2,
        canvasV2,
        projectLeases,
        lifecycle,
      )
      return closePromise
    },
  }
}

interface RouteContext {
  projectRoot: string
  registry: AgentRegistry
  runs: RunManager
  canvasV2: CanvasCommandStoreV2Manager
  versionsV2: WorkspaceVersionManagerV2
  projectionCanvases: CanvasProjectionCommitterV2
  allowedOrigins: Set<string>
  lifecycle: { closing: boolean }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  setSecurityHeaders(response)
  assertServerOpen(context)
  const origin = request.headers.origin
  if (!isAllowedOrigin(origin, context.allowedOrigins)) {
    throw new ProtocolError('request origin is not allowed', 'origin_denied', 403)
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
      'Access-Control-Max-Age': '600',
    })
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname

  if (request.method === 'GET' && pathname === '/health') {
    writeJson(response, 200, {
      status: 'ok',
      version: 1,
      capabilities: {
        canvasModelV1: false,
        canvasModelV2: true,
        pluginArtifactCapabilitiesV2: true,
      },
      canvas: {
        model: 'v2',
        schemaVersion: 2,
        resetRequired: false,
      },
      projectRoot: context.projectRoot,
    })
    return
  }

  if (request.method === 'GET' && pathname === '/canvas/v2') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const initial = (await context.versionsV2.getCanvas(projectDir, branch)).canvas
    await context.runs.reconcileProjectionPlansForCanvasTasks(
      projectDir,
      branch,
      initial.document.tasks.map((task) => task.id),
    )
    // Interrupted-run recovery may have materialized a plan while the Task set
    // was being reconciled. Return the post-recovery durable revision.
    writeJson(response, 200, (await context.versionsV2.getCanvas(projectDir, branch)).canvas)
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/commands') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const parsed = parseCanvasCommandRequestV2(await readJson(request))
    if (isTrustedPlanWireCommand(parsed.command)) {
      writeJson(response, 200, await commitProjectionPlanCommandV2({
        canvases: context.projectionCanvases,
        plans: context.runs,
        projectDir,
        branch: parsed.branch,
        baseRevision: parsed.baseRevision,
        mutationId: parsed.mutationId,
        command: parsed.command,
      }))
      return
    }
    const command = parsed.command as OrdinaryCanvasCommandV2
    const commit = () => context.versionsV2.commitCanvas(
      projectDir,
      parsed.branch,
      parsed.baseRevision,
      parsed.mutationId,
      command,
    ).then((result) => result.canvas)
    if (!isTaskDestructiveCanvasCommandV2(command)) {
      writeJson(response, 200, await commit())
      return
    }

    const commitAndReconcile = async () => {
      const committed = await commit()
      await context.runs.reconcileProjectionPlansForCanvasTasks(
        projectDir,
        parsed.branch,
        committed.document.tasks.map((task) => task.id),
      )
      return committed
    }

    const envelope = (await context.versionsV2.getCanvas(projectDir, parsed.branch)).canvas
    if (envelope.revision !== parsed.baseRevision) {
      // Preserve command-store replay and conflict semantics. A command that
      // cannot mutate this revision does not need a Task mutation lease. An
      // exact lost-ack replay still repairs any post-commit plan settlement.
      writeJson(response, 200, await commitAndReconcile())
      return
    }
    const taskIds = destructiveTaskIdsV2(command, envelope.document)
    const result = taskIds.length === 0
      ? await commitAndReconcile()
      : await context.runs.withIdleTasks(
          projectDir,
          parsed.branch,
          taskIds,
          commitAndReconcile,
        )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/conflicts') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const parsed = parseCanvasConflictRecoveryRequestV2(await readJson(request))
    const settledPlanIds = new Set<string>()
    const mutations: Array<{ mutationId: string; command: CanvasCommandV2 }> = []
    for (const mutation of parsed.mutations) {
      if (!isTrustedPlanWireCommand(mutation.command)) {
        mutations.push({
          mutationId: mutation.mutationId,
          command: mutation.command as OrdinaryCanvasCommandV2,
        })
        continue
      }
      const record = await context.runs.getProjectionPlanRecord(
        mutation.command.planId,
        projectDir,
        parsed.sourceBranch,
      )
      if (!record) {
        throw new ProjectionPlanUnavailableV2Error(mutation.command.planId, 'missing')
      }
      mutations.push({
        mutationId: mutation.mutationId,
        command: trustedCanvasCommandFromPlanV2(record.plan, mutation.command),
      })
      if (mutation.command.type !== 'MaterializeProjectionPlan') {
        settledPlanIds.add(mutation.command.planId)
      }
    }
    const result = await context.runs.withIdleBranches(
      projectDir,
      [parsed.sourceBranch, parsed.newBranch],
      () => context.versionsV2.saveConflictBranch(projectDir, {
        sourceBranch: parsed.sourceBranch,
        newBranch: parsed.newBranch,
        baseRevision: parsed.baseRevision,
        mutations,
      }),
    )
    if (!result.ok) {
      throw new WorkspaceVersioningV2Error(result.error.code, result.error.message)
    }
    for (const planId of settledPlanIds) {
      await context.runs.dismissProjectionPlan(planId, projectDir, parsed.sourceBranch)
    }
    writeJson(response, 201, {
      sourceBranch: result.value.sourceBranch,
      newBranch: result.value.branch.name,
      baseRevision: result.value.baseRevision,
      canvas: result.value.canvas,
    })
    return
  }

  if (request.method === 'GET' && pathname === '/agents') {
    writeJson(response, 200, { agents: await context.registry.probe() })
    return
  }

  if (request.method === 'GET' && pathname === '/canvas/status') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, await context.versionsV2.status(projectDir))
    return
  }

  if (request.method === 'GET' && pathname === '/canvas/branches') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, await context.versionsV2.listBranches(projectDir))
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/branches') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const name = parseCanvasBranch(requiredBodyString(body, 'name'))
    const fromBranch = body.fromBranch === undefined
      ? undefined
      : parseCanvasBranch(body.fromBranch)
    assertServerOpen(context)
    const lockedBranches = [fromBranch ?? 'main', name]
    const result = await context.runs.withIdleBranches(
      projectDir,
      lockedBranches,
      () => context.versionsV2.createBranch(projectDir, { name, fromBranch }),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'DELETE' && pathname === '/canvas/branches') {
    throw new ProtocolError(
      'Canvas V2 branch deletion is not available; history remains recoverable',
      'canvas_v2_branch_delete_unsupported',
      405,
    )
  }

  if (request.method === 'GET' && pathname === '/canvas/history') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const cursor = singleQueryParameter(url, 'cursor')
    const limit = optionalIntegerQuery(url, 'limit', { min: 1, max: 100 })
    const options = {
      branch,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    }
    writeJson(response, 200, await context.versionsV2.history(projectDir, options))
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/checkpoints') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const branch = parseCanvasBranch(requiredBodyString(body, 'branch'))
    const reason = optionalBodyString(body, 'reason') ?? 'manual'
    assertServerOpen(context)
    writeJson(response, 200, await context.versionsV2.manualCheckpoint(projectDir, branch, reason))
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/restores') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const sourceBranch = parseCanvasBranch(requiredBodyString(body, 'sourceBranch'))
    const newBranch = parseCanvasBranch(requiredBodyString(body, 'newBranch'))
    const checkpoint = requiredBodyString(body, 'checkpoint')
    assertServerOpen(context)
    const result = await context.runs.withIdleBranches(
      projectDir,
      [sourceBranch, newBranch],
      () => context.versionsV2.restoreAsNewBranch(projectDir, {
        sourceBranch,
        newBranch,
        checkpoint,
      }),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/merges/preview') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const sourceBranch = parseCanvasBranch(requiredBodyString(body, 'sourceBranch'))
    const targetBranch = parseCanvasBranch(requiredBodyString(body, 'targetBranch'))
    assertServerOpen(context)
    const result = await context.runs.withIdleBranches(
      projectDir,
      [sourceBranch, targetBranch],
      () => context.versionsV2.previewMerge(projectDir, { sourceBranch, targetBranch }),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/merges') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const sourceBranch = parseCanvasBranch(requiredBodyString(body, 'sourceBranch'))
    const targetBranch = parseCanvasBranch(requiredBodyString(body, 'targetBranch'))
    const confirmed = requiredBodyBoolean(body, 'confirmed')
    const expected = parseWorkspaceMergeExpectationV2(body.expected)
    assertServerOpen(context)
    const result = await context.runs.withIdleBranches(
      projectDir,
      [sourceBranch, targetBranch],
      () => context.versionsV2.executeMerge(projectDir, {
        sourceBranch,
        targetBranch,
        confirmed,
        expected,
      }),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'PUT' && pathname === '/plugin-capabilities/v2') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const leasedProjectDir = await context.canvasV2.acquireProjectLease(projectDir)
    let snapshot: ProjectionPluginCapabilitySnapshotV2
    try {
      snapshot = await new ProjectionPluginCapabilityStoreV2(leasedProjectDir)
        .register(await readJson(request))
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ProtocolError(error.message, 'invalid_plugin_capabilities', 400)
      }
      throw new ProtocolError(
        `plugin capabilities could not be persisted: ${error instanceof Error
          ? error.message
          : String(error)}`,
        'plugin_capabilities_unavailable',
        409,
      )
    }
    writeJson(response, 200, {
      schemaVersion: 2,
      digest: snapshot.digest,
      pluginCount: snapshot.plugins.length,
    })
    return
  }

  if (request.method === 'POST' && pathname === '/runs') {
    const raw = await readJson(request)
    if (!isRunIntentV2Candidate(raw)) {
      throw new ProtocolError(
        'legacy snapshot Runs were removed; POST /runs requires RunIntent V2',
        'legacy_api_removed',
        410,
      )
    }
    const intent = parseRunIntentV2ForServer(raw)
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const capabilityDigest = optionalPluginCapabilityDigest(url)
    const pluginCapabilities = capabilityDigest
      ? await loadPluginCapabilitiesForRunV2(context, projectDir, capabilityDigest)
      : structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2)
    assertServerOpen(context)
    const envelope = (await context.versionsV2.getCanvas(
      projectDir,
      intent.canvasBranch,
    )).canvas
    if (envelope.revision !== intent.baseRevision) {
      throw new CanvasRevisionConflictV2Error(envelope.revision)
    }
    if (!envelope.document.tasks.some((task) => task.id === intent.taskId)) {
      throw new ProtocolError('task does not exist at the requested revision', 'task_not_found', 404)
    }
    const resolvedArtifactAttachments = await resolveRunIntentAttachments(
      intent,
      envelope.document,
      context.runs,
      projectDir,
    )
    const run = await context.runs.create({
      ...intent,
      projectDir,
      canvasDocument: structuredClone(envelope.document),
      resolvedArtifactAttachments,
      pluginCapabilities,
      automationMode: 'confirm',
    }, {
      validateReserved: async () => {
        const current = (await context.versionsV2.getCanvas(
          projectDir,
          intent.canvasBranch,
        )).canvas
        if (current.revision !== intent.baseRevision) {
          throw new CanvasRevisionConflictV2Error(current.revision)
        }
        if (!current.document.tasks.some((task) => task.id === intent.taskId)) {
          throw new ProtocolError(
            'task does not exist at the requested revision',
            'task_not_found',
            404,
          )
        }
      },
    })
    writeJson(response, 202, { runId: run.runId })
    return
  }

  if (request.method === 'GET' && pathname === '/runs') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    if (singleQueryParameter(url, 'nodeId') !== undefined) {
      throw new ProtocolError(
        'node-scoped Run history was removed; use taskId',
        'legacy_api_removed',
        410,
      )
    }
    const rawTaskId = singleQueryParameter(url, 'taskId')
    const taskId = rawTaskId === undefined ? undefined : parseTaskIdV2(rawTaskId)
    const rawBranch = singleQueryParameter(url, 'branch')
    const canvasBranch = rawBranch === undefined ? undefined : parseCanvasBranch(rawBranch)
    const limit = optionalIntegerQuery(url, 'limit', { min: 1, max: 2_000 })
    const runs = await context.runs.listRunHistory(projectDir, {
      taskId,
      taskOwned: true,
      canvasBranch,
      limit,
    })
    writeJson(response, 200, { runs })
    return
  }

  const runArtifactMetadataMatch = pathname.match(
    /^\/runs\/([^/]+)\/artifacts\/([^/]+)\/metadata$/,
  )
  if (request.method === 'GET' && runArtifactMetadataMatch) {
    const runId = runIdFromPath(runArtifactMetadataMatch[1])
    const artifactId = artifactIdFromPath(runArtifactMetadataMatch[2])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const artifact = await lookupVerifiedRunArtifactV2(context.runs, {
      runId,
      artifactId,
      projectDir,
    })
    writeJson(response, 200, {
      schemaVersion: 2,
      runId: artifact.runId,
      artifactId: artifact.artifactId,
      mediaType: artifact.mediaType,
      size: artifact.size,
      contentDigest: artifact.contentDigest,
    })
    return
  }

  const runArtifactMatch = pathname.match(/^\/runs\/([^/]+)\/artifacts\/([^/]+)$/)
  if (request.method === 'GET' && runArtifactMatch) {
    const runId = runIdFromPath(runArtifactMatch[1])
    const artifactId = artifactIdFromPath(runArtifactMatch[2])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const artifact = await lookupVerifiedRunArtifactV2(context.runs, {
      runId,
      artifactId,
      projectDir,
    })
    await streamRunArtifactV2(response, artifact)
    return
  }

  const projectionPlanMatch = pathname.match(/^\/projection-plans\/([^/]+)$/)
  if (request.method === 'GET' && projectionPlanMatch) {
    const planId = projectionPlanIdFromPath(projectionPlanMatch[1])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const settlement = await context.runs.getPendingProjectionPlan(planId, projectDir, branch)
    if (!settlement) {
      throw new ProtocolError(
        'pending projection plan not found',
        'projection_plan_not_found',
        404,
      )
    }
    writeJson(response, 200, settlement)
    return
  }

  const eventMatch = pathname.match(/^\/runs\/([^/]+)\/events$/)
  if (request.method === 'GET' && eventMatch) {
    const runId = runIdFromPath(eventMatch[1])
    const active = context.runs.get(runId)
    if (!active?.taskId) throw new ProtocolError('run not found', 'run_not_found', 404)
    streamRunEvents(request, response, context.runs, runId)
    return
  }

  const cancelMatch = pathname.match(/^\/runs\/([^/]+)\/cancel$/)
  if (request.method === 'POST' && cancelMatch) {
    await readOptionalJson(request)
    const runId = runIdFromPath(cancelMatch[1])
    if (!context.runs.get(runId)?.taskId) {
      throw new ProtocolError('run is missing or already finished', 'run_not_active', 409)
    }
    const accepted = await context.runs.cancel(runId)
    if (!accepted) throw new ProtocolError('run is missing or already finished', 'run_not_active', 409)
    writeJson(response, 200, { runId, status: context.runs.get(runId)?.status ?? 'cancelled' })
    return
  }

  const logMatch = pathname.match(/^\/runs\/([^/]+)\/log$/)
  if (request.method === 'GET' && logMatch) {
    const runId = runIdFromPath(logMatch[1])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    if (!(await context.runs.getPersisted(runId, projectDir))?.taskId) {
      throw new ProtocolError('run not found', 'run_not_found', 404)
    }
    const afterEventId = optionalIntegerQuery(url, 'afterEventId', {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    })
    const limit = optionalIntegerQuery(url, 'limit', { min: 1, max: 2_000 })
    const page = await context.runs.readRunLog(runId, projectDir, { afterEventId, limit })
    if (!page) throw new ProtocolError('run not found', 'run_not_found', 404)
    writeJson(response, 200, page)
    return
  }
  if (request.method === 'DELETE' && logMatch) {
    const runId = runIdFromPath(logMatch[1])
    const active = context.runs.get(runId)
    if (active && !['done', 'error', 'cancelled', 'interrupted'].includes(active.status)) {
      throw new ProtocolError(
        'cannot delete the log of an active run',
        'run_log_active',
        409,
      )
    }
    throw new ProtocolError(
      'Canvas V2 run logs are durable execution records and cannot be deleted independently',
      'run_log_delete_unsupported',
      405,
    )
  }

  const runMatch = pathname.match(/^\/runs\/([^/]+)$/)
  if (request.method === 'GET' && runMatch) {
    const runId = runIdFromPath(runMatch[1])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const run = await context.runs.getPersisted(runId, projectDir)
    if (!run?.taskId) throw new ProtocolError('run not found', 'run_not_found', 404)
    writeJson(response, 200, run)
    return
  }

  const permissionMatch = pathname.match(/^\/permissions\/([^/]+)$/)
  if (request.method === 'POST' && permissionMatch) {
    parsePermissionDecision(await readJson(request))
    const permissionId = decodeURIComponent(permissionMatch[1] ?? '')
    const pending = context.runs.resolvePermission(permissionId)
    if (!pending) throw new ProtocolError('permission request not found', 'permission_not_found', 404)
    throw new ProtocolError(
      'this transport resolves permissions non-interactively; interactive forwarding requires the ACP SDK transport',
      'permission_bridge_unavailable',
      501,
    )
  }

  throw new ProtocolError('route not found', 'not_found', 404)
}

async function lookupVerifiedRunArtifactV2(
  runs: RunManager,
  input: { runId: string; artifactId: string; projectDir: string },
): Promise<RunArtifactLookupV2> {
  let artifact: RunArtifactLookupV2 | null
  try {
    artifact = await runs.lookupRunArtifact(input.runId, input.artifactId, input.projectDir)
  } catch (error) {
    throw new ProtocolError(
      `artifact failed its closed-manifest integrity check: ${error instanceof Error
        ? error.message
        : String(error)}`,
      'artifact_integrity_error',
      409,
    )
  }
  if (!artifact) throw new ProtocolError('artifact not found', 'artifact_not_found', 404)
  return artifact
}

function optionalPluginCapabilityDigest(url: URL): string | undefined {
  const value = singleQueryParameter(url, 'pluginCapabilityDigest')
  if (value === undefined) return undefined
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new ProtocolError(
      'pluginCapabilityDigest is invalid',
      'invalid_plugin_capability_digest',
      400,
    )
  }
  return value
}

async function loadPluginCapabilitiesForRunV2(
  context: RouteContext,
  projectDir: string,
  digest: string,
): Promise<ProjectionPluginCapabilitySnapshotV2> {
  const leasedProjectDir = await context.canvasV2.acquireProjectLease(projectDir)
  let snapshot: ProjectionPluginCapabilitySnapshotV2 | null
  try {
    snapshot = await new ProjectionPluginCapabilityStoreV2(leasedProjectDir).get(digest)
  } catch (error) {
    throw new ProtocolError(
      `plugin capability snapshot failed verification: ${error instanceof Error
        ? error.message
        : String(error)}`,
      'plugin_capabilities_unavailable',
      409,
    )
  }
  if (!snapshot) {
    throw new ProtocolError(
      'plugin capability snapshot was not registered for this project',
      'plugin_capabilities_not_found',
      409,
    )
  }
  return snapshot
}

function runIdFromPath(value: string | undefined): string {
  try {
    return parseRunId(decodeURIComponent(value ?? ''))
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError('runId contains invalid URL encoding')
  }
}

function artifactIdFromPath(value: string | undefined): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value ?? '')
  } catch {
    throw new ProtocolError('artifactId contains invalid URL encoding')
  }
  if (!/^artifact_[0-9a-f]{64}$/u.test(decoded)) {
    throw new ProtocolError('artifactId is invalid')
  }
  return decoded
}

function projectionPlanIdFromPath(value: string | undefined): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value ?? '')
  } catch {
    throw new ProtocolError('planId contains invalid URL encoding')
  }
  if (!/^plan_[0-9a-f]{64}$/u.test(decoded)) {
    throw new ProtocolError('planId is invalid')
  }
  return decoded
}

function singleQueryParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name)
  if (values.length > 1) throw new ProtocolError(`${name} must be provided at most once`)
  return values[0]
}

function requestObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError('request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function optionalBodyString(
  body: Record<string, unknown>,
  name: string,
  maxLength = 500,
): string | undefined {
  const value = body[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ProtocolError(
      `${name} must be a non-empty string of at most ${maxLength} characters`,
    )
  }
  return value
}

function requiredBodyString(body: Record<string, unknown>, name: string): string {
  const value = optionalBodyString(body, name)
  if (value === undefined) throw new ProtocolError(`${name} is required`)
  return value
}

function requiredBodyBoolean(body: Record<string, unknown>, name: string): boolean {
  const value = body[name]
  if (typeof value !== 'boolean') throw new ProtocolError(`${name} must be a boolean`)
  return value
}

function parseWorkspaceMergeExpectationV2(value: unknown): WorkspaceMergeExpectationV2 {
  const expected = requestObject(value)
  const allowed = new Set([
    'sourceCommit',
    'targetCommit',
    'sourceRevision',
    'targetRevision',
  ])
  if (Object.keys(expected).some((key) => !allowed.has(key))) {
    throw new ProtocolError('Canvas V2 merge expectation has unsupported properties')
  }
  return {
    sourceCommit: requiredCommit(expected, 'sourceCommit'),
    targetCommit: requiredCommit(expected, 'targetCommit'),
    sourceRevision: requiredNonNegativeInteger(expected, 'sourceRevision'),
    targetRevision: requiredNonNegativeInteger(expected, 'targetRevision'),
  }
}

function requiredCommit(body: Record<string, unknown>, name: string): string {
  const commit = requiredBodyString(body, name)
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new ProtocolError(`${name} must be a full lowercase Git commit ID`)
  }
  return commit
}

function requiredNonNegativeInteger(body: Record<string, unknown>, name: string): number {
  const value = body[name]
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ProtocolError(`${name} must be a non-negative integer`)
  }
  return Number(value)
}

function optionalIntegerQuery(
  url: URL,
  name: string,
  range: { min: number; max: number },
): number | undefined {
  const raw = singleQueryParameter(url, name)
  if (raw === undefined) return undefined
  if (!/^\d+$/u.test(raw)) {
    throw new ProtocolError(`${name} must be an integer`)
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new ProtocolError(`${name} must be between ${range.min} and ${range.max}`)
  }
  return parsed
}

function assertServerOpen(context: RouteContext): void {
  if (context.lifecycle.closing) {
    throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
  }
}

function workspaceProjectionCommitterV2(
  versions: WorkspaceVersionManagerV2,
): CanvasProjectionCommitterV2 {
  return {
    get: (projectDir, branch) => versions
      .getCanvas(projectDir, branch)
      .then((result) => result.canvas),
    commit: (projectDir, branch, baseRevision, mutationId, command) => versions
      .commitCanvas(projectDir, branch, baseRevision, mutationId, command)
      .then((result) => result.canvas),
    commitLatest: (projectDir, branch, mutationId, command) => versions
      .commitLatestCanvas(projectDir, branch, mutationId, command)
      .then((result) => result.canvas),
  }
}

async function closeDaemonServer(
  server: Server,
  sockets: Set<Socket>,
  runs: RunManager,
  versionsV2: WorkspaceVersionManagerV2,
  canvasV2: CanvasCommandStoreV2Manager,
  projectLeases: ProjectLeaseManager,
  lifecycle: { closing: boolean },
): Promise<void> {
  lifecycle.closing = true
  const serverClosed = new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((error) => error ? reject(error) : resolve())
    server.closeIdleConnections()
  })

  try {
    // Runs emit their final durable close before versioning and leases close.
    await runs.close()
    await serverClosed
    await versionsV2.close()
  } finally {
    canvasV2.close()
    await projectLeases.close()
    // Runs have emitted their terminal close frames; do not let a stuck client
    // connection keep process shutdown alive indefinitely.
    for (const socket of sockets) socket.destroy()
    await serverClosed
  }
}

function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  runs: RunManager,
  runId: string,
): void {
  const lastEventId = parseLastEventId(request.headers['last-event-id'])
  const write = (message: RunStreamMessage & { id: number }) => {
    if (response.writableEnded || response.destroyed) return
    const frame = [
      `id: ${message.id}`,
      `event: ${message.event}`,
      `data: ${JSON.stringify(message.data)}`,
      '',
      '',
    ].join('\n')
    response.write(frame)
    if (message.event === 'close') response.end()
    else if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
      // A stalled renderer must not make daemon memory grow without bound. It
      // can reconnect with Last-Event-ID while the run history is retained.
      response.destroy(new Error('SSE consumer is too slow'))
    }
  }
  const subscription = runs.subscribe(runId, write, lastEventId)
  if (!subscription) throw new ProtocolError('run not found', 'run_not_found', 404)
  if (subscription.replayGap) {
    subscription.unsubscribe()
    throw new ProtocolError('requested event history is no longer available', 'event_history_gap', 409)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  for (const message of subscription.history) write(message)
  if (subscription.closed || response.writableEnded || response.destroyed) {
    subscription.unsubscribe()
    if (!response.writableEnded && !response.destroyed) response.end()
    return
  }

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(`: heartbeat ${Date.now()}\n\n`)
  }, SSE_HEARTBEAT_MS)
  heartbeat.unref()
  const cleanup = () => {
    clearInterval(heartbeat)
    subscription.unsubscribe()
  }
  request.once('close', cleanup)
  response.once('close', cleanup)
}

function parseLastEventId(value: string | string[] | undefined): number {
  if (Array.isArray(value)) {
    throw new ProtocolError('Last-Event-ID must be a single non-negative integer')
  }
  if (value === undefined || value.trim() === '') return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProtocolError('Last-Event-ID must be a non-negative integer')
  }
  return parsed
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ProtocolError('Content-Type must be application/json', 'unsupported_media_type', 415)
  }
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    bytes += chunk.byteLength
    if (bytes > MAX_JSON_BODY_BYTES) {
      throw new ProtocolError('request body is too large', 'payload_too_large', 413)
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw new ProtocolError('request body is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new ProtocolError(
      `request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function readOptionalJson(request: IncomingMessage): Promise<unknown | undefined> {
  if (request.headers['content-length'] === '0' || request.headers['content-length'] === undefined) {
    return undefined
  }
  return readJson(request)
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.writableEnded) return
  const payload = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

async function streamRunArtifactV2(
  response: ServerResponse,
  artifact: RunArtifactLookupV2,
): Promise<void> {
  const previewLimit = isTextMediaType(artifact.mediaType)
    ? MAX_TEXT_ARTIFACT_BYTES
    : MAX_ARTIFACT_BYTES
  if (artifact.size > previewLimit) {
    throw new ProtocolError('artifact is too large to preview', 'artifact_too_large', 413)
  }
  const info = await stat(artifact.absolutePath).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      throw new ProtocolError('artifact not found', 'artifact_not_found', 404)
    }
    throw error
  })
  if (!info.isFile() || info.size !== artifact.size) {
    throw new ProtocolError(
      'artifact no longer matches its closed manifest',
      'artifact_integrity_error',
      409,
    )
  }
  response.writeHead(200, {
    'Content-Type': artifact.mediaType,
    'Content-Length': artifact.size,
    'Cache-Control': 'private, immutable',
    ETag: `"sha256-${artifact.contentDigest}"`,
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  })
  const stream = createReadStream(artifact.absolutePath)
  stream.once('error', () => response.destroy())
  stream.pipe(response)
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || mediaType === 'application/json'
    || mediaType === 'application/xml'
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function isRunIntentV2Candidate(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).schemaVersion === 2
}

function parseRunIntentV2ForServer(value: unknown): RunIntentV2 {
  try {
    return parseRunIntentV2(value)
  } catch (error) {
    if (error instanceof TaskRunProtocolV2Error) {
      throw new ProtocolError(error.message, 'invalid_run_intent_v2', 400)
    }
    throw error
  }
}

async function resolveRunIntentAttachments(
  intent: RunIntentV2,
  document: CanvasDocumentV2,
  runs: RunManager,
  projectDir: string,
): Promise<ResolvedArtifactAttachmentV2[]> {
  const nodeIds = new Set(document.nodes.map((node) => node.id))
  const references: Array<{
    runId: string
    artifactId: string
    authority: 'intent' | 'context-edge'
  }> = []
  const artifacts: ResolvedArtifactAttachmentV2[] = []
  for (const attachment of intent.attachments) {
    if (attachment.kind === 'node' && !nodeIds.has(attachment.nodeId)) {
      throw new ProtocolError(
        `attachment node does not exist at the requested revision: ${attachment.nodeId}`,
        'attachment_not_found',
        404,
      )
    }
    if (attachment.kind === 'artifact') {
      references.push({
        runId: attachment.runId,
        artifactId: attachment.artifactId,
        authority: 'intent',
      })
    }
  }

  // The browser cannot grant Canvas context by sending paths or a snapshot.
  // Compile semantic inputs only from the exact document revision loaded above;
  // summary/none edges contribute no artifact identities.
  const contextPack = compileTaskContextV2({ document, taskId: intent.taskId })
  references.push(...taskContextArtifactRefsV2(contextPack).map((reference) => ({
    ...reference,
    authority: 'context-edge' as const,
  })))

  const seen = new Set<string>()
  for (const reference of references) {
    const key = `${reference.runId}\0${reference.artifactId}`
    if (seen.has(key)) continue
    seen.add(key)
    const artifact = await runs.lookupRunArtifact(
      reference.runId,
      reference.artifactId,
      projectDir,
    ).catch(() => null)
    if (!artifact) {
      if (reference.authority === 'context-edge') {
        throw new ProtocolError(
          `full context edge references an unavailable artifact: ${reference.artifactId}`,
          'context_artifact_unavailable',
          409,
        )
      }
      throw new ProtocolError(
        `attachment artifact does not exist or failed verification: ${reference.artifactId}`,
        'attachment_not_found',
        404,
      )
    }
    artifacts.push({
      runId: artifact.runId,
      artifactId: artifact.artifactId,
      projectRelativePath: artifact.projectRelativePath,
      mediaType: artifact.mediaType,
      size: artifact.size,
      contentDigest: artifact.contentDigest,
    })
  }
  return artifacts
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.writableEnded) {
    if (!response.writableEnded) response.end()
    return
  }
  if (error instanceof ProtocolError) {
    writeJson(response, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof PermissionPolicyError) {
    writeJson(response, 403, { error: { code: error.code.toLowerCase(), message: error.message } })
    return
  }
  if (error instanceof TaskSessionsV2CorruptionError) {
    writeJson(response, 409, {
      error: {
        code: 'task_sessions_v2_corrupt',
        message: error.message,
        recovery: error.recovery,
      },
    })
    return
  }
  if (error instanceof CanvasGitV2Error) {
    const status = error.code === 'BRANCH_NOT_FOUND'
      || error.code === 'CHECKPOINT_NOT_FOUND'
      ? 404
      : error.code === 'GIT_UNAVAILABLE'
        ? 503
        : 409
    writeJson(response, status, {
      error: { code: error.code.toLowerCase(), message: error.message },
    })
    return
  }
  if (error instanceof WorkspaceVersioningV2Error) {
    writeJson(response, 409, {
      error: { code: error.code, message: error.message },
    })
    return
  }
  if (error instanceof ProjectionPlanUnavailableV2Error) {
    writeJson(response, error.reason === 'missing' ? 404 : 409, {
      error: {
        code: error.reason === 'missing'
          ? 'projection_plan_not_found'
          : 'projection_plan_settled',
        message: error.message,
      },
    })
    return
  }
  if (error instanceof CanvasCommandError) {
    writeJson(response, 409, {
      error: { code: `canvas_v2_${error.code}`, message: error.message },
    })
    return
  }
  if (error instanceof CanvasRevisionConflictV2Error) {
    writeJson(response, 409, {
      error: {
        code: 'canvas_v2_revision_conflict',
        message: error.message,
        currentRevision: error.currentRevision,
      },
    })
    return
  }
  if (error instanceof CanvasMutationReuseV2Error) {
    writeJson(response, 409, {
      error: { code: 'canvas_v2_mutation_reused', message: error.message },
    })
    return
  }
  if (error instanceof CanvasSnapshotV2Error) {
    writeJson(response, 409, {
      error: {
        code: 'canvas_v2_corrupt',
        message: error.message,
        filePath: error.filePath,
      },
    })
    return
  }
  const message = error instanceof Error ? error.message : 'internal daemon error'
  writeJson(response, 500, { error: { code: 'internal_error', message } })
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  // Browser development commonly uses localhost:3000 while the daemon is fixed to 127.0.0.1.
  // CORS still gates the exact origin; CORP must therefore permit that cross-origin fetch.
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
}

function isAllowedOrigin(origin: string | undefined, configured: Set<string>): boolean {
  if (!origin) return true
  return configured.has(origin) || DEFAULT_BROWSER_ORIGINS.has(origin)
}

function isTrustedPlanWireCommand(
  command: CanvasCommandWireV2,
): command is Extract<CanvasCommandWireV2, {
  type: 'MaterializeProjectionPlan' | 'AcceptTaskProposals' | 'DismissPlan'
}> {
  return command.type === 'MaterializeProjectionPlan'
    || command.type === 'AcceptTaskProposals'
    || command.type === 'DismissPlan'
}

function isTaskDestructiveCanvasCommandV2(
  command: OrdinaryCanvasCommandV2,
): command is Extract<OrdinaryCanvasCommandV2, {
  type: 'DeleteTask' | 'DeleteTaskAndViews' | 'DeleteCollectionAndContents'
}> {
  return command.type === 'DeleteTask'
    || command.type === 'DeleteTaskAndViews'
    || command.type === 'DeleteCollectionAndContents'
}

function destructiveTaskIdsV2(
  command: Extract<OrdinaryCanvasCommandV2, {
    type: 'DeleteTask' | 'DeleteTaskAndViews' | 'DeleteCollectionAndContents'
  }>,
  document: CanvasDocumentV2,
): string[] {
  if (command.type === 'DeleteTask' || command.type === 'DeleteTaskAndViews') {
    return [command.taskId]
  }
  return document.tasks
    .filter((task) => task.collectionId === command.collectionId)
    .map((task) => task.id)
}
