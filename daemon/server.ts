import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { CanvasCommandError } from '../src/canvas-v2/commands.js'
import type { CanvasDocumentV2 } from '../src/canvas-v2/model.js'
import type { CanvasModelMode } from './canvasModelMode.js'
import { isArtifactControlPath } from './artifactPaths.js'
import {
  CanvasCorruptionError,
  CanvasMutationReuseError,
  CanvasRevisionConflictError,
  CanvasStoreManager,
} from './canvasStore.js'
import {
  CanvasMutationReuseV2Error,
  CanvasRevisionConflictV2Error,
  CanvasSnapshotV2Error,
} from './canvasCommandStoreV2.js'
import { CanvasCommandStoreV2Manager } from './canvasCommandStoreV2Manager.js'
import {
  parseCanvasCommandRequestV2,
  type CanvasCommandWireV2,
  type OrdinaryCanvasCommandV2,
} from './canvasCommandProtocolV2.js'
import {
  autoMaterializeProjectionPlanV2,
  commitProjectionPlanCommandV2,
  ProjectionPlanUnavailableV2Error,
} from './canvasProjectionCoordinatorV2.js'
import { isPathWithin, PermissionPolicyError, resolveProjectDir } from './permissions.js'
import {
  parseCanvasBranch,
  parseCreateRunRequest,
  parseNodeId,
  parsePermissionDecision,
  parsePutCanvasRequest,
  parseRunId,
  ProtocolError,
  type RunStreamMessage,
} from './protocol.js'
import { AgentRegistry } from './registry.js'
import type { RunArtifactLookupV2 } from './runArtifactStorageV2.js'
import { RunManager } from './runs.js'
import { SessionsCorruptionError } from './sessions.js'
import {
  parseRunIntentV2,
  parseTaskIdV2,
  TaskRunProtocolV2Error,
  type RunIntentV2,
} from './taskRunProtocolV2.js'
import {
  isResolvedTaskRunRequestV2,
  type ResolvedArtifactAttachmentV2,
} from './taskRunTypesV2.js'
import { TaskSessionsV2CorruptionError } from './taskSessionsV2.js'
import { WorkspacePreferencesManager } from './preferences.js'
import {
  WorkspaceVersionManager,
  type WorkspaceMergeExpectation,
} from './workspaceVersioning.js'

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
  canvasStoreManager?: CanvasStoreManager
  workspaceVersionManager?: WorkspaceVersionManager
  preferencesManager?: WorkspacePreferencesManager
  canvasCommandStoreV2Manager?: CanvasCommandStoreV2Manager
  canvasModel?: CanvasModelMode
  /** Existing cross-model integration suites only; never set from the CLI. */
  allowCanvasModelMixingForTests?: boolean
}

export interface DaemonServer {
  server: Server
  registry: AgentRegistry
  runs: RunManager
  canvases: CanvasStoreManager
  versions: WorkspaceVersionManager
  preferences: WorkspacePreferencesManager
  canvasV2: CanvasCommandStoreV2Manager
  canvasModel: CanvasModelMode
  close(): Promise<void>
}

export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const canvasModel = options.canvasModel ?? 'v1'
  const registry = options.registry ?? new AgentRegistry()
  const versions = options.workspaceVersionManager ?? new WorkspaceVersionManager({
    projectRoot: options.projectRoot,
    ...(options.canvasStoreManager ? { canvasStoreManager: options.canvasStoreManager } : {}),
  })
  const canvases = versions.canvases
  const canvasV2 = options.canvasCommandStoreV2Manager ?? new CanvasCommandStoreV2Manager({
    projectRoot: options.projectRoot,
    acquireProjectLease: (projectDir) => canvases.acquireProjectLease(projectDir),
  })
  const preferences = options.preferencesManager ?? new WorkspacePreferencesManager(options.projectRoot)
  const runs = options.runManager ?? new RunManager({
    projectRoot: options.projectRoot,
    registry,
    acquireProjectLease: (projectDir) => versions.canvases.acquireProjectLease(projectDir),
    resolveSourceProjectDir: ({ projectDir, canvasBranch }) =>
      versions.sourceExecutionProjectDir(projectDir, canvasBranch),
    ...(canvasModel === 'v2' || options.allowCanvasModelMixingForTests
      ? {
          onProjectionPlanReady: ({ plan, projectDir, canvasBranch }) =>
            autoMaterializeProjectionPlanV2({
              canvases: canvasV2,
              projectDir,
              branch: canvasBranch,
              plan,
            }).then(() => undefined),
        }
      : {}),
    onRunFinished: async ({ summary, request, projectDir }) => {
      if (isResolvedTaskRunRequestV2(request)) return
      if (summary.status !== 'done' || request.automationMode !== 'auto') return
      const canvasBranch = request.canvasBranch ?? 'main'
      const binding = await versions.sourceBranch(projectDir, canvasBranch)
      if (!binding.ok || !binding.value) return
      const nodeTitle = request.canvasSnapshot.nodes
        .find((node) => node.id === request.nodeId)?.title ?? request.nodeId
      // Automatic mode still cannot approve sensitive or oversized changes.
      await versions.checkpointSource(projectDir, canvasBranch, {
        runId: summary.runId,
        nodeTitle,
        allowSensitive: false,
      })
    },
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
      canvases,
      canvasV2,
      versions,
      preferences,
      allowedOrigins,
      lifecycle,
      canvasModel,
      allowCanvasModelMixingForTests: options.allowCanvasModelMixingForTests === true,
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
    canvases,
    versions,
    preferences,
    canvasV2,
    canvasModel,
    close() {
      closePromise ??= closeDaemonServer(
        server,
        sockets,
        runs,
        versions,
        preferences,
        canvasV2,
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
  canvases: CanvasStoreManager
  canvasV2: CanvasCommandStoreV2Manager
  versions: WorkspaceVersionManager
  preferences: WorkspacePreferencesManager
  allowedOrigins: Set<string>
  lifecycle: { closing: boolean }
  canvasModel: CanvasModelMode
  allowCanvasModelMixingForTests: boolean
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
        canvasModelV1: context.canvasModel === 'v1',
        canvasModelV2: context.canvasModel === 'v2',
      },
      canvas: {
        model: context.canvasModel,
        schemaVersion: context.canvasModel === 'v2' ? 2 : 1,
        resetRequired: false,
      },
      projectRoot: context.projectRoot,
    })
    return
  }

  const routeModel = canvasRouteModel(pathname)
  if (routeModel) assertCanvasModel(context, routeModel)

  if (request.method === 'GET' && pathname === '/canvas/v2') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    writeJson(response, 200, await context.canvasV2.get(projectDir, branch))
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/commands') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const parsed = parseCanvasCommandRequestV2(await readJson(request))
    if (isTrustedPlanWireCommand(parsed.command)) {
      writeJson(response, 200, await commitProjectionPlanCommandV2({
        canvases: context.canvasV2,
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
    const commit = () => context.canvasV2.commit(
      projectDir,
      parsed.branch,
      parsed.baseRevision,
      parsed.mutationId,
      command,
    )
    if (!isTaskDestructiveCanvasCommandV2(command)) {
      writeJson(response, 200, await commit())
      return
    }

    const envelope = await context.canvasV2.get(projectDir, parsed.branch)
    if (envelope.revision !== parsed.baseRevision) {
      // Preserve command-store replay and conflict semantics. A command that
      // cannot mutate this revision does not need a Task mutation lease.
      writeJson(response, 200, await commit())
      return
    }
    const taskIds = destructiveTaskIdsV2(command, envelope.document)
    const result = taskIds.length === 0
      ? await commit()
      : await context.runs.withIdleTasks(
          projectDir,
          parsed.branch,
          taskIds,
          commit,
        )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'GET' && pathname === '/agents') {
    writeJson(response, 200, { agents: await context.registry.probe() })
    return
  }

  if (request.method === 'GET' && pathname === '/canvas') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    writeJson(response, 200, (await context.versions.getCanvas(projectDir, branch)).canvas)
    return
  }

  if (request.method === 'PUT' && pathname === '/canvas') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const requestBody = parsePutCanvasRequest(await readJson(request))
    assertServerOpen(context)
    writeJson(response, 200, (await context.versions.saveCanvas(projectDir, branch, requestBody)).canvas)
    return
  }

  if (request.method === 'GET' && pathname === '/canvas/status') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, await context.versions.status(projectDir))
    return
  }

  if (request.method === 'GET' && pathname === '/canvas/branches') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, await context.versions.listBranches(projectDir))
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
    const result = await context.runs.withIdleBranches(
      projectDir,
      [fromBranch ?? 'main', name],
      () => context.versions.createBranch(projectDir, { name, fromBranch }),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'DELETE' && pathname === '/canvas/branches') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const branch = parseCanvasBranch(requiredBodyString(body, 'branch'))
    assertServerOpen(context)
    const result = await context.runs.withIdleBranches(
      projectDir,
      [branch, 'main'],
      () => context.versions.deleteBranch(projectDir, branch),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'GET' && pathname === '/canvas/history') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const cursor = singleQueryParameter(url, 'cursor')
    const limit = optionalIntegerQuery(url, 'limit', { min: 1, max: 100 })
    writeJson(response, 200, await context.versions.history(projectDir, {
      branch,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    }))
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/checkpoints') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const branch = parseCanvasBranch(requiredBodyString(body, 'branch'))
    const reason = optionalBodyString(body, 'reason') ?? 'manual'
    assertServerOpen(context)
    writeJson(response, 200, await context.versions.manualCheckpoint(projectDir, branch, reason))
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
      () => context.versions.restoreAsNewBranch(projectDir, {
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
      () => context.versions.previewMerge(projectDir, {
        sourceBranch,
        targetBranch,
      }),
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
    const expected = parseWorkspaceMergeExpectation(body.expected)
    assertServerOpen(context)
    const result = await context.runs.withIdleBranches(
      projectDir,
      [sourceBranch, targetBranch],
      () => context.versions.executeMerge(projectDir, {
        sourceBranch,
        targetBranch,
        confirmed,
        expected,
      }),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'GET' && pathname === '/canvas/source') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, await context.versions.sourceStatus(projectDir))
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/source/bind') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const branch = parseCanvasBranch(optionalBodyString(body, 'branch') ?? 'main')
    assertServerOpen(context)
    const result = await context.runs.withIdleBranches(
      projectDir,
      [branch],
      () => context.versions.bindSource(projectDir, branch),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/source/checkpoints') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    const branch = parseCanvasBranch(requiredBodyString(body, 'branch'))
    const runId = requiredBodyString(body, 'runId')
    const nodeTitle = requiredBodyString(body, 'nodeTitle')
    const allowSensitive = body.allowSensitive === undefined
      ? undefined
      : requiredBodyBoolean(body, 'allowSensitive')
    assertServerOpen(context)
    const result = await context.runs.withIdleBranches(
      projectDir,
      [branch],
      () => context.versions.checkpointSource(projectDir, branch, {
        runId,
        nodeTitle,
        ...(allowSensitive === undefined ? {} : { allowSensitive }),
      }),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'GET' && pathname === '/canvas/preferences') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    await context.canvases.acquireProjectLease(projectDir)
    writeJson(response, 200, await context.preferences.get(projectDir))
    return
  }

  if (request.method === 'PUT' && pathname === '/canvas/preferences') {
    const body = requestObject(await readJson(request))
    const projectDir = optionalBodyString(body, 'projectDir', 4_096) ?? '.'
    assertServerOpen(context)
    await context.canvases.acquireProjectLease(projectDir)
    writeJson(response, 200, await context.preferences.put(projectDir, {
      automationMode: body.automationMode,
    }))
    return
  }

  if (request.method === 'GET' && pathname === '/artifacts') {
    await streamArtifact(response, context.projectRoot, url)
    return
  }

  if (request.method === 'POST' && pathname === '/runs') {
    const raw = await readJson(request)
    if (isRunIntentV2Candidate(raw)) {
      assertCanvasModel(context, 'v2')
      const intent = parseRunIntentV2ForServer(raw)
      const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
      assertServerOpen(context)
      const envelope = await context.canvasV2.get(projectDir, intent.canvasBranch)
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
        automationMode: 'confirm',
      }, {
        validateReserved: async () => {
          const current = await context.canvasV2.get(projectDir, intent.canvasBranch)
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

    assertCanvasModel(context, 'v1')
    const parsed = parseCreateRunRequest(raw)
    const projectDir = parsed.projectDir ?? '.'
    assertServerOpen(context)
    await context.canvases.acquireProjectLease(projectDir)
    const preferences = parsed.automationMode === undefined
      ? await context.preferences.get(projectDir)
      : null
    const body = {
      ...parsed,
      canvasBranch: parsed.canvasBranch ?? 'main',
      automationMode: parsed.automationMode ?? preferences?.automationMode ?? 'confirm',
    }
    const run = await context.runs.create(body)
    writeJson(response, 202, { runId: run.runId })
    return
  }

  if (request.method === 'GET' && pathname === '/runs') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const rawNodeId = singleQueryParameter(url, 'nodeId')
    const nodeId = rawNodeId === undefined ? undefined : parseNodeId(rawNodeId)
    const rawTaskId = singleQueryParameter(url, 'taskId')
    const taskId = rawTaskId === undefined ? undefined : parseTaskIdV2(rawTaskId)
    if (nodeId !== undefined) assertCanvasModel(context, 'v1')
    if (taskId !== undefined) assertCanvasModel(context, 'v2')
    const rawBranch = singleQueryParameter(url, 'branch')
    const canvasBranch = rawBranch === undefined ? undefined : parseCanvasBranch(rawBranch)
    const limit = optionalIntegerQuery(url, 'limit', { min: 1, max: 2_000 })
    const runs = await context.runs.listRunHistory(projectDir, {
      nodeId,
      taskId,
      canvasBranch,
      limit,
    })
    writeJson(response, 200, { runs })
    return
  }

  const runArtifactMatch = pathname.match(/^\/runs\/([^/]+)\/artifacts\/([^/]+)$/)
  if (request.method === 'GET' && runArtifactMatch) {
    const runId = runIdFromPath(runArtifactMatch[1])
    const artifactId = artifactIdFromPath(runArtifactMatch[2])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    let artifact: RunArtifactLookupV2 | null
    try {
      artifact = await context.runs.lookupRunArtifact(runId, artifactId, projectDir)
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
    if (!context.runs.get(runId)) throw new ProtocolError('run not found', 'run_not_found', 404)
    streamRunEvents(request, response, context.runs, runId)
    return
  }

  const cancelMatch = pathname.match(/^\/runs\/([^/]+)\/cancel$/)
  if (request.method === 'POST' && cancelMatch) {
    await readOptionalJson(request)
    const runId = runIdFromPath(cancelMatch[1])
    const accepted = await context.runs.cancel(runId)
    if (!accepted) throw new ProtocolError('run is missing or already finished', 'run_not_active', 409)
    writeJson(response, 200, { runId, status: context.runs.get(runId)?.status ?? 'cancelled' })
    return
  }

  const logMatch = pathname.match(/^\/runs\/([^/]+)\/log$/)
  if (request.method === 'GET' && logMatch) {
    const runId = runIdFromPath(logMatch[1])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
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
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const active = context.runs.get(runId)
    if (active && !['done', 'error', 'cancelled', 'interrupted'].includes(active.status)) {
      throw new ProtocolError(
        'cannot delete the log of an active run',
        'run_log_active',
        409,
      )
    }
    const deleted = await context.runs.deleteRunLog(runId, projectDir)
    if (!deleted) throw new ProtocolError('run not found', 'run_not_found', 404)
    writeJson(response, 200, { runId, deleted: true })
    return
  }

  const runMatch = pathname.match(/^\/runs\/([^/]+)$/)
  if (request.method === 'GET' && runMatch) {
    const runId = runIdFromPath(runMatch[1])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const run = await context.runs.getPersisted(runId, projectDir)
    if (!run) throw new ProtocolError('run not found', 'run_not_found', 404)
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

  if (request.method === 'GET' && pathname === '/sessions') {
    const nodeId = url.searchParams.get('nodeId') ?? undefined
    const agentId = url.searchParams.get('agentId') ?? undefined
    const rawBranch = singleQueryParameter(url, 'branch')
    const canvasBranch = rawBranch === undefined ? undefined : parseCanvasBranch(rawBranch)
    const projectDir = url.searchParams.get('projectDir') ?? '.'
    const sessions = await context.runs.listSessions(projectDir, { canvasBranch, nodeId, agentId })
    writeJson(response, 200, { sessions })
    return
  }

  throw new ProtocolError('route not found', 'not_found', 404)
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

function parseWorkspaceMergeExpectation(value: unknown): WorkspaceMergeExpectation {
  const expected = requestObject(value)
  const canvas = requestObject(expected.canvas)
  const source = expected.source === null
    ? null
    : requestObject(expected.source)
  return {
    canvas: {
      sourceCommit: requiredCommit(canvas, 'sourceCommit'),
      targetCommit: requiredCommit(canvas, 'targetCommit'),
      sourceRevision: requiredNonNegativeInteger(canvas, 'sourceRevision'),
      targetRevision: requiredNonNegativeInteger(canvas, 'targetRevision'),
    },
    source: source
      ? {
          sourceCommit: requiredCommit(source, 'sourceCommit'),
          targetCommit: requiredCommit(source, 'targetCommit'),
        }
      : null,
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

function canvasRouteModel(pathname: string): CanvasModelMode | null {
  if (
    pathname === '/canvas/v2'
    || pathname === '/canvas/commands'
    || pathname.startsWith('/projection-plans/')
    || /^\/runs\/[^/]+\/artifacts\/[^/]+$/u.test(pathname)
  ) return 'v2'
  if (
    pathname === '/canvas'
    || pathname.startsWith('/canvas/')
    || pathname === '/artifacts'
    || pathname === '/sessions'
  ) return 'v1'
  return null
}

function assertCanvasModel(context: RouteContext, required: CanvasModelMode): void {
  if (context.allowCanvasModelMixingForTests || context.canvasModel === required) return
  throw new ProtocolError(
    `route requires Canvas ${required.toUpperCase()}, but daemon is running ${context.canvasModel.toUpperCase()}`,
    'canvas_model_mismatch',
    409,
  )
}

function assertServerOpen(context: RouteContext): void {
  if (context.lifecycle.closing) {
    throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
  }
}

async function closeDaemonServer(
  server: Server,
  sockets: Set<Socket>,
  runs: RunManager,
  versions: WorkspaceVersionManager,
  preferences: WorkspacePreferencesManager,
  canvasV2: CanvasCommandStoreV2Manager,
  lifecycle: { closing: boolean },
): Promise<void> {
  lifecycle.closing = true
  canvasV2.close()
  const serverClosed = new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((error) => error ? reject(error) : resolve())
    server.closeIdleConnections()
  })

  try {
    // Runs may perform a final branch-scoped source checkpoint. Keep
    // versioning open until all terminal hooks have settled, then wait for
    // ordinary in-flight HTTP routes before closing their managers.
    await runs.close()
    await serverClosed
    await Promise.all([versions.close(), preferences.close()])
  } finally {
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

async function streamArtifact(
  response: ServerResponse,
  projectRoot: string,
  url: URL,
): Promise<void> {
  const requestedPath = url.searchParams.get('path')
  if (!requestedPath || requestedPath.includes('\0') || path.isAbsolute(requestedPath)) {
    throw new ProtocolError('artifact path must be a non-empty relative path')
  }
  if (isArtifactControlPath(requestedPath)) {
    throw new ProtocolError(
      'artifact control metadata is not available for preview',
      'artifact_forbidden',
      403,
    )
  }
  if (/^artifacts\/\.branches\/[0-9a-f]{64}\/[A-Za-z0-9._:@-]+\/files\//u.test(
    requestedPath,
  )) {
    throw new ProtocolError(
      'run-owned artifacts must be read by runId and artifactId',
      'artifact_forbidden',
      403,
    )
  }

  const projectDir = await resolveProjectDir(projectRoot, url.searchParams.get('projectDir') ?? '.')
  const artifactRoot = path.resolve(projectDir, 'artifacts')
  const candidate = path.resolve(projectDir, requestedPath)
  if (!isPathWithin(artifactRoot, candidate)) {
    throw new ProtocolError('artifact path is outside the project artifacts directory', 'artifact_forbidden', 403)
  }

  let canonicalRoot: string
  let canonicalFile: string
  let rootInfo: Awaited<ReturnType<typeof lstat>>
  try {
    [rootInfo, canonicalRoot, canonicalFile] = await Promise.all([
      lstat(artifactRoot),
      realpath(artifactRoot),
      realpath(candidate),
    ])
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      throw new ProtocolError('artifact not found', 'artifact_not_found', 404)
    }
    throw error
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || canonicalRoot !== artifactRoot) {
    throw new ProtocolError(
      'project artifacts directory must be a real directory',
      'artifact_forbidden',
      403,
    )
  }
  if (!isPathWithin(canonicalRoot, canonicalFile)) {
    throw new ProtocolError('artifact resolves outside the project artifacts directory', 'artifact_forbidden', 403)
  }

  const info = await stat(canonicalFile)
  if (!info.isFile()) throw new ProtocolError('artifact is not a file', 'artifact_not_found', 404)
  const previewLimit = isTextArtifact(canonicalFile)
    ? MAX_TEXT_ARTIFACT_BYTES
    : MAX_ARTIFACT_BYTES
  if (info.size > previewLimit) {
    throw new ProtocolError('artifact is too large to preview', 'artifact_too_large', 413)
  }

  response.writeHead(200, {
    'Content-Type': artifactContentType(canonicalFile),
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  })
  const stream = createReadStream(canonicalFile)
  stream.once('error', () => response.destroy())
  stream.pipe(response)
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

function isTextArtifact(filename: string): boolean {
  return new Set([
    '.json', '.csv', '.md', '.txt', '.log', '.ts', '.tsx', '.js', '.jsx', '.py', '.tex',
  ]).has(path.extname(filename).toLowerCase())
}

function artifactContentType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.svg': return 'image/svg+xml'
    case '.pdf': return 'application/pdf'
    case '.json': return 'application/json; charset=utf-8'
    case '.csv': return 'text/csv; charset=utf-8'
    case '.md': return 'text/markdown; charset=utf-8'
    case '.txt':
    case '.log':
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.py':
    case '.tex': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
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
      const artifact = await runs.lookupRunArtifact(
        attachment.runId,
        attachment.artifactId,
        projectDir,
      ).catch(() => null)
      if (!artifact) {
        throw new ProtocolError(
          `attachment artifact does not exist or failed verification: ${attachment.artifactId}`,
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
  if (error instanceof SessionsCorruptionError) {
    writeJson(response, 409, {
      error: {
        code: 'sessions_corrupt',
        message: error.message,
        recovery: error.recovery,
      },
    })
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
  if (error instanceof CanvasRevisionConflictError) {
    writeJson(response, 409, {
      error: {
        code: 'canvas_revision_conflict',
        message: error.message,
        currentRevision: error.currentRevision,
      },
    })
    return
  }
  if (error instanceof CanvasMutationReuseError) {
    writeJson(response, 409, {
      error: { code: 'canvas_mutation_reused', message: error.message },
    })
    return
  }
  if (error instanceof CanvasCorruptionError) {
    writeJson(response, 409, {
      error: {
        code: 'canvas_corrupt',
        message: error.message,
        recovery: error.recovery,
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
