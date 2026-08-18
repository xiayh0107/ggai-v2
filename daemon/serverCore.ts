import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { CanvasCommandError, type CanvasCommand } from '../src/canvas/commands.js'
import type { CanvasDocument } from '../src/canvas/model.js'
import {
  CUSTOM_NODE_MANIFEST_SCHEMA_VERSION,
  isCustomNodeManifest,
  validateCustomNodeManifest,
  type CustomNodeManifest,
} from '../src/node-studio/model.js'
import {
  SKILL_ASSET_SCHEMA_VERSION,
  canonicalSkillAssetRefs,
  isNodeTypeId,
  isSkillId,
} from '../src/skills/contracts.js'
import {
  CanvasMutationReuseError,
  CanvasRevisionConflictError,
  CanvasSnapshotError,
} from './canvasCommandStore.js'
import { CanvasCommandStoreManager } from './canvasCommandStoreManager.js'
import { CapabilityExecutionScopes } from './capabilityScopes.js'
import {
  parseCanvasConflictRecoveryRequest,
  parseCanvasCommandRequest,
  type CanvasCommandWire,
  type OrdinaryCanvasCommand,
} from './canvasCommandProtocol.js'
import {
  autoMaterializeProjectionPlan,
  commitProjectionPlanCommand,
  type CanvasProjectionCommitter,
  ProjectionPlanUnavailableError,
  trustedCanvasCommandFromPlan,
} from './canvasProjectionCoordinator.js'
import { CanvasGitError } from './canvasGit.js'
import { readExactFileBytes } from './atomic-file.js'
import { PermissionPolicyError } from './permissions.js'
import {
  ProjectionPluginCapabilityStore,
  browserCommunityProjectionClaims,
  resolveProjectionPluginCapabilitySnapshot,
  type ProjectionPluginCapabilitySnapshot,
} from './pluginCapabilities.js'
import {
  workspaceProjectionContributionSnapshot,
} from './projectionContributions.js'
import {
  parseCanvasBranch,
  parsePermissionDecision,
  parseRunId,
  ProtocolError,
  type RunClosePayload,
  type RunSummary,
  type RunStreamMessage,
} from './protocol.js'
import { ProjectLeaseManager } from './projectLease.js'
import {
  ProjectCatalog,
  ProjectCatalogError,
  projectDescriptorFromCanvasEnvelope,
} from './projectCatalog.js'
import { AgentRegistry } from './registry.js'
import type { ServiceReader } from './runtime/services.js'
import { SKILL_RESOLVER_SERVICE, type SkillResolver } from './skills/contracts.js'
import { NodeDefinitionCatalog } from './nodeDefinitionCatalog.js'
import {
  SkillAssetCatalog,
  SkillAssetConflictError,
} from './skillAssets.js'
import {
  openVerifiedRunArtifactFile,
  type RunArtifactLookup,
} from './runArtifactStorage.js'
import { RunManager } from './runs.js'
import {
  parseRunIntent,
  parseTaskId,
  TaskRunProtocolError,
  type RunIntent,
} from './taskRunProtocol.js'
import {
  type NodeStudioRunRequest,
} from './taskRunTypes.js'
import { resolveRunIntentSkills } from './taskRunSkills.js'
import { resolveRunIntentAttachments } from './taskRunAttachments.js'
import { installWorkspaceCapabilityProviders } from './workspaceRuntime.js'
import { TaskSessionsCorruptionError } from './taskSessions.js'
import {
  WorkspaceVersionManager,
  WorkspaceVersioningError,
  type WorkspaceMergeExpectation,
} from './workspaceVersioning.js'
import {
  ArtifactCatalogCursorError,
  listArtifactCatalog,
  MAX_ARTIFACT_CATALOG_LIMIT,
} from './artifactCatalog.js'
import { TaskRunPreflightService } from './taskRunPreflight.js'
import { MetadataStore } from './metadataStore.js'
import { NodeExecutionError, NodeExecutionService } from './nodeExecutions.js'
import { AssetAssemblyExecutor } from './assetRasterizer.js'
import { ComputeExecutor } from './computeExecutor.js'
import { FilesystemService, FilesystemServiceError } from './filesystemService.js'
import { MAX_FILESYSTEM_TREE_PAGE } from '../src/filesystem/contracts.js'
import {
  createHttpRouter,
  type HttpRoute,
  type HttpRouteContext,
} from './http/router.js'
import { createHealthRoute } from './http/routes/health.js'
import { createRuntimeRoute } from './http/routes/runtime.js'
import { createTaskRunPreflightRoute } from './http/routes/taskRunPreflight.js'
import { createTaskRunReproducibilityRoute } from './http/routes/taskRunReproducibility.js'

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
  workspaceVersionManager?: WorkspaceVersionManager
  canvasCommandStoreManager?: CanvasCommandStoreManager
  projectLeaseManager?: ProjectLeaseManager
  projectCatalog?: ProjectCatalog
  nodeDefinitionCatalog?: NodeDefinitionCatalog
  skillAssetCatalog?: SkillAssetCatalog
  capabilityExecutionScopes?: CapabilityExecutionScopes
  metadataStore?: MetadataStore
  nodeExecutionService?: NodeExecutionService
  computeExecutor?: ComputeExecutor
}

export interface DaemonServer {
  server: Server
  registry: AgentRegistry
  runs: RunManager
  versions: WorkspaceVersionManager
  canvas: CanvasCommandStoreManager
  projects: ProjectCatalog
  nodeDefinitions: NodeDefinitionCatalog
  skillAssets: SkillAssetCatalog
  workspaceCapabilities: ServiceReader
  executions: NodeExecutionService
  compute: ComputeExecutor
  filesystem: FilesystemService
  close(): Promise<void>
}

export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const registry = options.registry ?? new AgentRegistry()
  const projects = options.projectCatalog ?? new ProjectCatalog(options.projectRoot)
  const nodeDefinitions = options.nodeDefinitionCatalog ?? new NodeDefinitionCatalog(options.projectRoot)
  const skillAssets = options.skillAssetCatalog ?? new SkillAssetCatalog(options.projectRoot)
  const metadata = options.metadataStore ?? new MetadataStore(options.projectRoot)
  const ownsMetadata = options.metadataStore === undefined
  const executions = options.nodeExecutionService ?? new NodeExecutionService(metadata)
  const compute = options.computeExecutor ?? new ComputeExecutor()
  if (!options.nodeExecutionService) {
    executions.executors.register(new AssetAssemblyExecutor())
    executions.executors.register(compute)
  } else if (options.computeExecutor) {
    executions.executors.register(compute)
  }
  if (projects.projectRoot !== path.resolve(options.projectRoot)) {
    throw new TypeError('projectCatalog and daemon server must share a project root')
  }
  if (nodeDefinitions.projectRoot !== path.resolve(options.projectRoot)) {
    throw new TypeError('nodeDefinitionCatalog and daemon server must share a project root')
  }
  if (skillAssets.projectRoot !== path.resolve(options.projectRoot)) {
    throw new TypeError('skillAssetCatalog and daemon server must share a project root')
  }
  const capabilityExecutionScopes = options.capabilityExecutionScopes
    ?? new CapabilityExecutionScopes(registry.runtimeServices)
  const ownsCapabilityExecutionScopes = options.capabilityExecutionScopes === undefined
  const workspaceCapabilities = capabilityExecutionScopes
    .workspace(options.projectRoot)
    .services
  if (ownsCapabilityExecutionScopes) {
    installWorkspaceCapabilityProviders(
      capabilityExecutionScopes.workspace(options.projectRoot),
      { skillCatalog: skillAssets },
    )
  }
  const projectLeases = options.projectLeaseManager ?? new ProjectLeaseManager({
    projectRoot: options.projectRoot,
  })
  const canvas = options.canvasCommandStoreManager ?? new CanvasCommandStoreManager({
    projectRoot: options.projectRoot,
    acquireProjectLease: (projectDir) => projectLeases.acquire(projectDir),
  })
  const versions = options.workspaceVersionManager ?? new WorkspaceVersionManager({
    projectRoot: options.projectRoot,
    canvasStoreManager: canvas,
  })
  if (options.workspaceVersionManager && versions.canvases !== canvas) {
    throw new TypeError('workspaceVersionManager and canvasCommandStoreManager must share a store')
  }
  const filesystem = new FilesystemService(metadata, canvas)
  const projectionCanvases = workspaceProjectionCommitter(versions)
  const runs = options.runManager ?? new RunManager({
    projectRoot: options.projectRoot,
    registry,
    capabilityScopes: capabilityExecutionScopes,
    capabilityProfile: () => registry.runtimeDiagnostics().profile,
    acquireProjectLease: (projectDir) => canvas.acquireProjectLease(projectDir),
    resolveSourceProjectDir: async ({ projectDir, canvasBranch, taskOwned, studioOwned }) => {
      if (!taskOwned && !studioOwned) return null
      if (taskOwned) await versions.sourceExecutionProjectDir(projectDir, canvasBranch)
      return null
    },
    onProjectionPlanReady: ({ plan, projectDir, canvasBranch }) =>
      autoMaterializeProjectionPlan({
        canvases: projectionCanvases,
        projectDir,
        branch: canvasBranch,
        plan,
      }).then(() => undefined),
  })
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  const sockets = new Set<Socket>()
  const lifecycle = { closing: false }
  const taskRunPreflight = new TaskRunPreflightService({
    registry,
    runs,
    versions,
    skillAssets,
    skillResolver: () => {
      const resolver = workspaceCapabilities.get(SKILL_RESOLVER_SERVICE)
      const provider = workspaceCapabilities.ownerOf(SKILL_RESOLVER_SERVICE)
      if (!resolver || !provider) throw new Error('Workspace Skill Resolver is unavailable')
      return { resolver, provider }
    },
    projectionContributions: () => workspaceProjectionContributionSnapshot(
      workspaceCapabilities,
    ),
  })
  const domainRouter = createHttpRouter([
    createHealthRoute(),
    createRuntimeRoute(),
    createTaskRunPreflightRoute(),
    createTaskRunReproducibilityRoute(),
  ])
  let closePromise: Promise<void> | null = null

  const server = createServer((request, response) => {
    void route(request, response, {
      projectRoot: options.projectRoot,
      registry,
      runs,
      canvas,
      versions,
      projects,
      nodeDefinitions,
      skillAssets,
      workspaceCapabilities,
      projectLeases,
      projectionCanvases,
      allowedOrigins,
      lifecycle,
      taskRunPreflight,
      executions,
      compute,
      filesystem,
    }, domainRouter)
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
    versions,
    canvas,
    projects,
    nodeDefinitions,
    skillAssets,
    workspaceCapabilities,
    executions,
    compute,
    filesystem,
    close() {
      closePromise ??= filesystem.close().then(() => closeDaemonServer(
        server,
        sockets,
        runs,
        registry,
        versions,
        canvas,
        projects,
        projectLeases,
        lifecycle,
        capabilityExecutionScopes,
        ownsCapabilityExecutionScopes,
        metadata,
        ownsMetadata,
      ))
      return closePromise
    },
  }
}

interface RouteContext extends HttpRouteContext {
  projectRoot: string
  registry: AgentRegistry
  runs: RunManager
  canvas: CanvasCommandStoreManager
  versions: WorkspaceVersionManager
  projects: ProjectCatalog
  nodeDefinitions: NodeDefinitionCatalog
  skillAssets: SkillAssetCatalog
  workspaceCapabilities: ServiceReader
  projectLeases: ProjectLeaseManager
  projectionCanvases: CanvasProjectionCommitter
  allowedOrigins: Set<string>
  lifecycle: { closing: boolean }
  executions: NodeExecutionService
  compute: ComputeExecutor
  filesystem: FilesystemService
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  domainRouter: HttpRoute,
): Promise<void> {
  if (await domainRouter(request, response, context)) return
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
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID, Range',
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
        canvas: true,
        pluginArtifactCapabilities: true,
        nodeSkills: true,
      },
      canvas: {
        schemaVersion: 3,
        initializationRequired: false,
      },
      projectRoot: context.projectRoot,
    })
    return
  }

  if (request.method === 'GET' && pathname === '/runtime/compute') {
    writeJson(response, 200, {
      schemaVersion: 1,
      ...await context.compute.diagnostics(),
      presets: ['python-3.13', 'node-24'],
    })
    return
  }

  if (request.method === 'GET' && pathname === '/workspace/roots') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, {
      schemaVersion: 1,
      roots: await context.filesystem.listRoots(operationalProjectId(projectDir)),
    })
    return
  }

  if (request.method === 'POST' && pathname === '/workspace/roots') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, ['displayName', 'path'])) {
      throw new ProtocolError('workspace root body is invalid', 'invalid_workspace_root', 400)
    }
    writeJson(response, 201, {
      schemaVersion: 1,
      root: await context.filesystem.createRoot({
        projectId: operationalProjectId(projectDir),
        displayName: requiredBodyString(body, 'displayName', 120),
        requestedPath: requiredBodyString(body, 'path', 4_096),
      }),
    })
    return
  }

  if (request.method === 'GET' && pathname === '/filesystem/tree') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const rootId = singleQueryParameter(url, 'rootId')
    if (!rootId) throw new ProtocolError('rootId is required', 'invalid_workspace_root', 400)
    writeJson(response, 200, {
      schemaVersion: 1,
      ...await context.filesystem.tree({
        projectId: operationalProjectId(projectDir),
        rootId,
        relativePath: singleQueryParameter(url, 'relativePath') ?? '',
        cursor: singleQueryParameter(url, 'cursor'),
        limit: optionalIntegerQuery(url, 'limit', { min: 1, max: MAX_FILESYSTEM_TREE_PAGE }),
      }),
    })
    return
  }

  if (request.method === 'POST' && pathname === '/filesystem/bindings') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, [
      'branch', 'baseRevision', 'mutationId', 'nodeId', 'rootId', 'relativePath', 'kind', 'mode',
    ])) throw new ProtocolError('filesystem binding body is invalid', 'invalid_filesystem_binding', 400)
    const branch = parseCanvasBranch(requiredBodyString(body, 'branch', 200))
    const baseRevision = requiredBodySafeInteger(body, 'baseRevision', {
      min: 0, max: Number.MAX_SAFE_INTEGER,
    })
    const mutationId = requiredBodyString(body, 'mutationId', 200)
    const nodeId = parseTaskId(requiredBodyString(body, 'nodeId', 200))
    const latest = (await context.versions.getCanvas(projectDir, branch)).canvas
    const leasedProjectDir = await context.canvas.acquireProjectLease(projectDir)
    const created = await context.filesystem.createBinding({
      projectId: operationalProjectId(projectDir),
      canvasProjectDir: leasedProjectDir,
      canvasBranch: branch,
      document: latest.document,
      nodeId,
      rootId: requiredBodyString(body, 'rootId', 200),
      relativePath: requiredBodyString(body, 'relativePath', 4_096),
      kind: body.kind === 'file' || body.kind === 'directory'
        ? body.kind : (() => { throw new ProtocolError('binding kind is invalid') })(),
      mode: body.mode === 'fs-authoritative'
        || body.mode === 'canvas-authoritative'
        || body.mode === 'bidirectional'
        ? body.mode : (() => { throw new ProtocolError('binding mode is invalid') })(),
    })
    let committed
    try {
      const parsed = parseCanvasCommandRequest({
        branch, baseRevision, mutationId, command: created.command,
      })
      committed = (await context.versions.commitCanvas(
        projectDir, parsed.branch, parsed.baseRevision, parsed.mutationId,
        parsed.command as OrdinaryCanvasCommand,
      )).canvas
    } catch (error) {
      await context.filesystem.deleteBinding(created.binding.bindingId).catch(() => undefined)
      throw error
    }
    const binding = await context.filesystem.reconcile(
      created.binding.bindingId,
      operationalProjectId(projectDir),
    ).catch(() => created.binding)
    const reconciledCanvas = (await context.versions.getCanvas(projectDir, branch)).canvas
    writeJson(response, 201, {
      schemaVersion: 1,
      binding,
      canvas: reconciledCanvas.revision >= committed.revision ? reconciledCanvas : committed,
    })
    return
  }

  const filesystemSaveMatch = pathname.match(/^\/filesystem\/bindings\/([^/]+)\/save$/u)
  if (filesystemSaveMatch && request.method === 'POST') {
    const bindingId = parseTaskId(decodeURIComponent(filesystemSaveMatch[1]!))
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, [])) throw new ProtocolError('filesystem save body must be empty')
    const document = (await context.versions.getCanvas(projectDir, branch)).canvas.document
    writeJson(response, 200, {
      schemaVersion: 1,
      binding: await context.filesystem.save({
        projectId: operationalProjectId(projectDir), bindingId, document,
      }),
    })
    return
  }

  const filesystemBindingMatch = pathname.match(/^\/filesystem\/bindings\/([^/]+)$/u)
  if (filesystemBindingMatch && request.method === 'GET') {
    const bindingId = parseTaskId(decodeURIComponent(filesystemBindingMatch[1]!))
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, {
      schemaVersion: 1,
      binding: await context.filesystem.getBinding(
        bindingId, operationalProjectId(projectDir),
      ),
    })
    return
  }

  if (request.method === 'GET' && pathname === '/filesystem/conflicts') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, {
      schemaVersion: 1,
      conflicts: await context.filesystem.listConflicts(operationalProjectId(projectDir)),
    })
    return
  }

  if (request.method === 'GET' && pathname === '/projects') {
    // First read bootstraps projects.json, so it participates in the same
    // cross-process writer fence as later catalog mutations.
    await context.canvas.acquireProjectLease('.')
    writeJson(response, 200, {
      schemaVersion: 1,
      projects: await context.projects.list(),
    })
    return
  }

  if (request.method === 'GET' && pathname === '/node-definitions') {
    await context.canvas.acquireProjectLease('.')
    writeJson(response, 200, {
      schemaVersion: 1,
      definitions: await context.nodeDefinitions.list(),
    })
    return
  }

  if (request.method === 'GET' && pathname === '/skill-assets') {
    await context.canvas.acquireProjectLease('.')
    writeJson(response, 200, await context.skillAssets.list())
    return
  }

  if (request.method === 'POST' && pathname === '/skill-assets/import') {
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, ['sourcePath', 'skillId', 'expectedRevision'])) {
      throw new ProtocolError('skill import body has an invalid envelope', 'invalid_skill_asset', 400)
    }
    await context.canvas.acquireProjectLease('.')
    try {
      const asset = await context.skillAssets.import({
        sourcePath: requiredBodyString(body, 'sourcePath', 4_096),
        skillId: requiredSkillId(body.skillId, 'skillId'),
        expectedRevision: requiredBodySafeInteger(body, 'expectedRevision', {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        }),
      })
      writeJson(response, 200, { schemaVersion: SKILL_ASSET_SCHEMA_VERSION, asset })
    } catch (error) {
      throw skillAssetProtocolError(error)
    }
    return
  }

  const skillAssetMatch = pathname.match(/^\/skill-assets\/([^/]+)$/u)
  if (skillAssetMatch && request.method === 'DELETE') {
    const skillId = requiredSkillIdFromPath(skillAssetMatch[1])
    await context.canvas.acquireProjectLease('.')
    try {
      if (!await context.skillAssets.archive(skillId)) {
        throw new ProtocolError('skill asset was not found', 'skill_asset_not_found', 404)
      }
      writeJson(response, 200, {
        schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
        archivedSkillId: skillId,
      })
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw skillAssetProtocolError(error)
    }
    return
  }

  const typeSkillBindingMatch = pathname.match(/^\/skill-bindings\/types\/([^/]+)$/u)
  if (typeSkillBindingMatch && request.method === 'PUT') {
    const nodeType = requiredNodeTypeFromPath(typeSkillBindingMatch[1])
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, ['schemaVersion', 'expectedRevision', 'skills'])
      || body.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION
      || !Array.isArray(body.skills)) {
      throw new ProtocolError(
        'node type skill binding body has an invalid envelope',
        'invalid_skill_binding',
        400,
      )
    }
    await context.canvas.acquireProjectLease('.')
    try {
      const binding = await context.skillAssets.updateTypeBindings({
        nodeType,
        expectedRevision: requiredBodySafeInteger(body, 'expectedRevision', {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        }),
        skills: canonicalSkillAssetRefs(body.skills),
      })
      writeJson(response, 200, { schemaVersion: SKILL_ASSET_SCHEMA_VERSION, binding })
    } catch (error) {
      throw skillAssetProtocolError(error)
    }
    return
  }

  const nodeDefinitionMatch = pathname.match(/^\/node-definitions\/([^/]+)$/u)
  if (nodeDefinitionMatch && request.method === 'PUT') {
    const definitionId = nodeDefinitionIdFromPath(nodeDefinitionMatch[1])
    const body = requestObject(await readJson(request))
    if (body.id !== definitionId) {
      throw new ProtocolError(
        'node definition body must match the URL id',
        'invalid_node_definition',
        400,
      )
    }
    await context.canvas.acquireProjectLease('.')
    try {
      const definition = await context.nodeDefinitions.upsert(body)
      writeJson(response, 200, { schemaVersion: 1, definition })
    } catch (error) {
      throw new ProtocolError(
        error instanceof Error ? error.message : 'node definition could not be saved',
        error instanceof Error && error.message.includes('revision conflict')
          ? 'node_definition_conflict'
          : 'invalid_node_definition',
        error instanceof Error && error.message.includes('revision conflict') ? 409 : 400,
      )
    }
    return
  }

  if (nodeDefinitionMatch && request.method === 'DELETE') {
    const definitionId = nodeDefinitionIdFromPath(nodeDefinitionMatch[1])
    await context.canvas.acquireProjectLease('.')
    try {
      const deleted = await context.nodeDefinitions.delete(definitionId)
      if (!deleted) {
        throw new ProtocolError('node definition was not found', 'node_definition_not_found', 404)
      }
      writeJson(response, 200, { schemaVersion: 1, deletedId: definitionId })
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError(
        error instanceof Error ? error.message : 'node definition could not be deleted',
        'node_definition_delete_denied',
        409,
      )
    }
    return
  }

  if (request.method === 'POST' && pathname === '/node-studio/runs') {
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, ['requirement', 'definition'])) {
      throw new ProtocolError(
        'node studio run body must contain only requirement and definition',
        'invalid_node_studio_run',
        400,
      )
    }
    const requirement = requiredBodyString(body, 'requirement', 20_000).trim()
    if (!requirement) {
      throw new ProtocolError('node requirement cannot be empty', 'invalid_node_studio_run', 400)
    }
    if (!isCustomNodeManifest(body.definition)) {
      throw new ProtocolError('current node definition is malformed', 'invalid_node_studio_run', 400)
    }
    const definition = structuredClone(body.definition)
    const definitionErrors = validateCustomNodeManifest(definition)
    if (definitionErrors.length > 0) {
      throw new ProtocolError(definitionErrors.join('; '), 'invalid_node_studio_run', 400)
    }
    const nodeId = nodeStudioAgentNodeId(definition.id)
    const runId = `studio-${randomUUID()}`
    const studioRequest: NodeStudioRunRequest = {
      executionKind: 'node-studio',
      baseDefinitionId: definition.id,
      baseDefinitionRevision: definition.revision,
      runId,
      nodeId,
      agentId: 'codex',
      prompt: nodeStudioAgentPrompt(requirement, definition),
      projectDir: '.',
      canvasBranch: 'node-studio',
      automationMode: 'confirm',
      canvasSnapshot: {
        nodes: [{
          id: nodeId,
          type: 'code',
          x: 0,
          y: 0,
          w: 360,
          h: 240,
          title: `节点定义：${definition.label}`,
          instruction: {
            phase: 'idle',
            prompt: requirement,
            attachments: [],
            sources: [],
            open: false,
          },
          payload: {},
        }],
        edges: [],
        plugins: [{
          id: 'code',
          label: '代码',
          description: '结构化文本与代码产物',
        }],
      },
    }
    const run = await context.runs.create(studioRequest)
    writeJson(response, 202, { schemaVersion: 1, runId: run.runId, status: run.status })
    return
  }

  const nodeStudioRunMatch = pathname.match(/^\/node-studio\/runs\/([^/]+)$/u)
  if (nodeStudioRunMatch && request.method === 'GET') {
    const runId = runIdFromPath(nodeStudioRunMatch[1])
    const summary = await context.runs.getPersisted(runId, '.')
    if (!isNodeStudioRunSummary(summary)) {
      throw new ProtocolError('node studio run was not found', 'node_studio_run_not_found', 404)
    }
    const page = await context.runs.readRunLog(runId, '.', { limit: 2_000 })
    const progress = latestNodeStudioProgress(page?.entries ?? [])
    if (summary.status !== 'done') {
      writeJson(response, 200, {
        schemaVersion: 1,
        runId,
        status: summary.status,
        ...(progress ? { progress } : {}),
        ...(summary.error ? { error: summary.error } : {}),
      })
      return
    }
    try {
      const definition = await readNodeStudioCandidate(
        context.runs,
        summary,
        await context.runs.readTerminalClose(runId, '.'),
        await context.nodeDefinitions.list(),
      )
      writeJson(response, 200, {
        schemaVersion: 1,
        runId,
        status: 'done',
        definition,
      })
    } catch (error) {
      writeJson(response, 200, {
        schemaVersion: 1,
        runId,
        status: 'error',
        error: error instanceof Error ? error.message : 'Agent 返回的节点定义无效',
      })
    }
    return
  }

  const nodeStudioCancelMatch = pathname.match(/^\/node-studio\/runs\/([^/]+)\/cancel$/u)
  if (nodeStudioCancelMatch && request.method === 'POST') {
    await readOptionalJson(request)
    const runId = runIdFromPath(nodeStudioCancelMatch[1])
    const run = context.runs.get(runId)
    if (!isNodeStudioRunSummary(run)) {
      throw new ProtocolError('node studio run is not active', 'node_studio_run_not_active', 409)
    }
    if (!await context.runs.cancel(runId)) {
      throw new ProtocolError('node studio run is not active', 'node_studio_run_not_active', 409)
    }
    writeJson(response, 200, { schemaVersion: 1, runId, status: 'cancelled' })
    return
  }

  if (request.method === 'POST' && pathname === '/projects') {
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, ['title'])) {
      throw new ProtocolError(
        'project creation body must contain only title',
        'invalid_project_request',
        400,
      )
    }
    // The workspace control lease is the cross-process writer fence for the
    // daemon-owned catalog. The workspace root is not itself a Project.
    await context.canvas.acquireProjectLease('.')
    const project = await context.projects.create(body.title)
    writeJson(response, 201, { schemaVersion: 1, project })
    return
  }

  const projectDeleteMatch = pathname.match(/^\/projects\/([^/]+)$/u)
  if (request.method === 'DELETE' && projectDeleteMatch) {
    const projectId = projectIdFromPath(projectDeleteMatch[1])
    // The workspace control lease fences catalog mutation across daemon processes. The
    // child lifecycle gates below then prevent cached Canvas/Run state from
    // racing or resurrecting the managed directory during physical deletion.
    await context.canvas.acquireProjectLease('.')
    const record = await context.projects.requireReady(projectId)
    let runProjectDir: string | null = null
    let versionProjectDir: string | null = null
    let maintenanceProjectDir: string | null = null
    let deleted = false
    try {
      runProjectDir = await context.runs.beginProjectDeletion(record.projectDir)
      versionProjectDir = await context.versions.beginProjectDeletion(record.projectDir)
      maintenanceProjectDir = await context.projectLeases.beginMaintenance(record.projectDir)
      if (
        runProjectDir !== versionProjectDir
        || runProjectDir !== maintenanceProjectDir
      ) {
        throw new ProjectCatalogError(
          'project_unavailable',
          `Workspace project ${projectId} changed while deletion was starting`,
          409,
        )
      }

      await context.canvas.drainAndEvictProject(maintenanceProjectDir)
      context.runs.evictProject(maintenanceProjectDir)
      await context.projectLeases.releaseForMaintenance(maintenanceProjectDir)
      const removed = await context.projects.delete(projectId)
      deleted = true
      writeJson(response, 200, {
        schemaVersion: 1,
        deletedProjectId: removed.id,
      })
      return
    } finally {
      if (versionProjectDir) {
        context.versions.finishProjectDeletion(versionProjectDir, deleted)
      }
      if (runProjectDir) context.runs.endProjectDeletion(runProjectDir)
      if (maintenanceProjectDir) {
        context.projectLeases.endMaintenance(maintenanceProjectDir)
      }
    }
  }

  const projectOpenMatch = pathname.match(/^\/projects\/([^/]+)\/open$/u)
  if (request.method === 'POST' && projectOpenMatch) {
    const projectId = projectIdFromPath(projectOpenMatch[1])
    // Opening mutates lastOpenedAt, so fence the shared catalog before any
    // project-specific lease is accepted.
    await context.canvas.acquireProjectLease('.')
    const record = await context.projects.requireReady(projectId)
    await context.canvas.acquireProjectLease(record.projectDir)
    let canvas: Awaited<ReturnType<WorkspaceVersionManager['getCanvas']>>['canvas']
    try {
      canvas = (await context.versions.getCanvas(record.projectDir, 'main')).canvas
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProjectCatalogError(
        'project_unavailable',
        `Workspace project ${projectId} could not be opened`,
        409,
        error,
      )
    }
    const opened = await context.projects.markOpened(projectId)
    writeJson(response, 200, {
      schemaVersion: 1,
      project: projectDescriptorFromCanvasEnvelope(opened, canvas),
    })
    return
  }

  if (request.method === 'GET' && pathname === '/canvas') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const initial = (await context.versions.getCanvas(projectDir, branch)).canvas
    await context.runs.reconcileProjectionPlansForCanvasTasks(
      projectDir,
      branch,
      initial.document.tasks.map((task) => task.id),
    )
    // Interrupted-run recovery may have materialized a plan while the Task set
    // was being reconciled. Return the post-recovery durable revision.
    writeJson(response, 200, (await context.versions.getCanvas(projectDir, branch)).canvas)
    return
  }

  if (request.method === 'POST' && pathname === '/canvas/commands') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const parsed = parseCanvasCommandRequest(await readJson(request))
    if (isTrustedPlanWireCommand(parsed.command)) {
      writeJson(response, 200, await commitProjectionPlanCommand({
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
    const command = parsed.command as OrdinaryCanvasCommand
    const commit = () => context.versions.commitCanvas(
      projectDir,
      parsed.branch,
      parsed.baseRevision,
      parsed.mutationId,
      command,
    ).then((result) => result.canvas)
    if (!isTaskDestructiveCanvasCommand(command)) {
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

    const envelope = (await context.versions.getCanvas(projectDir, parsed.branch)).canvas
    if (envelope.revision !== parsed.baseRevision) {
      // Preserve command-store replay and conflict semantics. A command that
      // cannot mutate this revision does not need a Task mutation lease. An
      // exact lost-ack replay still repairs any post-commit plan settlement.
      writeJson(response, 200, await commitAndReconcile())
      return
    }
    const taskIds = destructiveTaskIds(command, envelope.document)
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
    const parsed = parseCanvasConflictRecoveryRequest(await readJson(request))
    const settledPlanIds = new Set<string>()
    const mutations: Array<{ mutationId: string; command: CanvasCommand }> = []
    for (const mutation of parsed.mutations) {
      if (!isTrustedPlanWireCommand(mutation.command)) {
        mutations.push({
          mutationId: mutation.mutationId,
          command: mutation.command as OrdinaryCanvasCommand,
        })
        continue
      }
      const record = await context.runs.getProjectionPlanRecord(
        mutation.command.planId,
        projectDir,
        parsed.sourceBranch,
      )
      if (!record) {
        throw new ProjectionPlanUnavailableError(mutation.command.planId, 'missing')
      }
      mutations.push({
        mutationId: mutation.mutationId,
        command: trustedCanvasCommandFromPlan(record.plan, mutation.command),
      })
      if (mutation.command.type !== 'MaterializeProjectionPlan') {
        settledPlanIds.add(mutation.command.planId)
      }
    }
    const result = await context.runs.withIdleBranches(
      projectDir,
      [parsed.sourceBranch, parsed.newBranch],
      () => context.versions.saveConflictBranch(projectDir, {
        sourceBranch: parsed.sourceBranch,
        newBranch: parsed.newBranch,
        baseRevision: parsed.baseRevision,
        mutations,
      }),
    )
    if (!result.ok) {
      throw new WorkspaceVersioningError(result.error.code, result.error.message)
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
    const lockedBranches = [fromBranch ?? 'main', name]
    const result = await context.runs.withIdleBranches(
      projectDir,
      lockedBranches,
      () => context.versions.createBranch(projectDir, { name, fromBranch }),
    )
    writeJson(response, 200, result)
    return
  }

  if (request.method === 'DELETE' && pathname === '/canvas/branches') {
    throw new ProtocolError(
      'Canvas branch deletion is not available; history remains recoverable',
      'canvas_branch_delete_unsupported',
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
    writeJson(response, 200, await context.versions.history(projectDir, options))
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
      () => context.versions.previewMerge(projectDir, { sourceBranch, targetBranch }),
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

  if (request.method === 'PUT' && pathname === '/plugin-capabilities') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    let snapshot: ProjectionPluginCapabilitySnapshot
    try {
      snapshot = await context.projectLeases.withProjectOperation(
        projectDir,
        async (leasedProjectDir) => new ProjectionPluginCapabilityStore(leasedProjectDir)
          .register(
            await readJson(request),
            workspaceProjectionContributionSnapshot(context.workspaceCapabilities),
          ),
      )
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
      schemaVersion: 3,
      digest: snapshot.digest,
      pluginCount: snapshot.plugins.length,
    })
    return
  }

  const nodeExecutionsMatch = pathname.match(/^\/nodes\/([^/]+)\/executions$/u)
  if (nodeExecutionsMatch && request.method === 'POST') {
    const nodeId = parseTaskId(decodeURIComponent(nodeExecutionsMatch[1]!))
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, ['force']) || typeof body.force !== 'boolean') {
      throw new ProtocolError('execution body must contain only force', 'invalid_execution_request', 400)
    }
    const canvas = (await context.versions.getCanvas(projectDir, branch)).canvas
    const leasedProjectDir = await context.canvas.acquireProjectLease(projectDir)
    const execution = await context.executions.start({
      projectId: operationalProjectId(projectDir),
      projectDir: leasedProjectDir,
      canvasBranch: branch,
      document: canvas.document,
      nodeId,
      force: body.force,
    })
    writeJson(response, ['queued', 'awaiting-approval', 'running'].includes(execution.status) ? 202 : 200, {
      schemaVersion: 1,
      execution,
    })
    return
  }
  if (nodeExecutionsMatch && request.method === 'GET') {
    const nodeId = parseTaskId(decodeURIComponent(nodeExecutionsMatch[1]!))
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    writeJson(response, 200, {
      schemaVersion: 1,
      executions: await context.executions.list(operationalProjectId(projectDir), branch, nodeId),
    })
    return
  }

  const executionOutputsMatch = pathname.match(/^\/executions\/([^/]+)\/outputs$/u)
  if (executionOutputsMatch && request.method === 'GET') {
    const executionId = parseTaskId(decodeURIComponent(executionOutputsMatch[1]!))
    const outputs = await context.executions.outputs(executionId)
    if (!outputs) throw new NodeExecutionError('execution_not_found', 'Execution does not exist', 404)
    writeJson(response, 200, { schemaVersion: 1, executionId, outputs })
    return
  }

  const executionApprovalMatch = pathname.match(/^\/executions\/([^/]+)\/approval$/u)
  if (executionApprovalMatch && request.method === 'POST') {
    const executionId = parseTaskId(decodeURIComponent(executionApprovalMatch[1]!))
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const branch = parseCanvasBranch(singleQueryParameter(url, 'branch') ?? 'main')
    const body = requestObject(await readJson(request))
    if (!hasExactBodyKeys(body, ['approve']) || body.approve !== true) {
      throw new ProtocolError('approval body must contain approve: true', 'invalid_execution_approval', 400)
    }
    const canvas = (await context.versions.getCanvas(projectDir, branch)).canvas
    const leasedProjectDir = await context.canvas.acquireProjectLease(projectDir)
    const execution = await context.executions.approve({
      executionId,
      projectId: operationalProjectId(projectDir),
      projectDir: leasedProjectDir,
      canvasBranch: branch,
      document: canvas.document,
    })
    writeJson(response, 202, { schemaVersion: 1, execution })
    return
  }

  const nodeProvenanceMatch = pathname.match(/^\/nodes\/([^/]+)\/provenance$/u)
  if (nodeProvenanceMatch && request.method === 'GET') {
    const nodeId = parseTaskId(decodeURIComponent(nodeProvenanceMatch[1]!))
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    writeJson(response, 200, {
      schemaVersion: 1,
      records: await context.executions.provenance(operationalProjectId(projectDir), nodeId),
    })
    return
  }

  if (request.method === 'POST' && pathname === '/runs') {
    const raw = await readJson(request)
    const intent = parseRunIntentForServer(raw)
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const capabilityDigest = optionalPluginCapabilityDigest(url)
    const browserClaims = capabilityDigest
      ? browserCommunityProjectionClaims(
          await loadPluginCapabilitiesForRun(context, projectDir, capabilityDigest),
        )
      : { schemaVersion: 2 as const, plugins: [] }
    const pluginCapabilities = resolveProjectionPluginCapabilitySnapshot(
      browserClaims,
      workspaceProjectionContributionSnapshot(context.workspaceCapabilities),
    )
    assertServerOpen(context)
    const envelope = (await context.versions.getCanvas(
      projectDir,
      intent.canvasBranch,
    )).canvas
    if (envelope.revision !== intent.baseRevision) {
      throw new CanvasRevisionConflictError(envelope.revision)
    }
    if (!envelope.document.tasks.some((task) => task.id === intent.taskId)) {
      throw new ProtocolError('task does not exist at the requested revision', 'task_not_found', 404)
    }
    const resolvedAttachments = await resolveRunIntentAttachments(
      intent,
      envelope.document,
      context.runs,
      projectDir,
      pluginCapabilities,
    )
    const skillResolver = requireWorkspaceSkillResolver(context.workspaceCapabilities)
    const resolvedSkills = await resolveRunIntentSkills(
      intent,
      envelope.document,
      context.skillAssets,
      skillResolver.resolver,
      skillResolver.provider,
    )
    const run = await context.runs.create({
      ...intent,
      projectDir,
      canvasDocument: structuredClone(envelope.document),
      resolvedArtifactAttachments: resolvedAttachments.artifacts,
      resolvedNodeAttachments: resolvedAttachments.nodes,
      resolvedSkills: resolvedSkills.skills,
      skillCapabilityDigest: resolvedSkills.digest,
      skillResolverCapabilityDigest: resolvedSkills.resolverDigest,
      skillResolverProvider: resolvedSkills.resolverProvider,
      pluginCapabilities,
      automationMode: 'confirm',
    }, {
      validateReserved: async () => {
        const current = (await context.versions.getCanvas(
          projectDir,
          intent.canvasBranch,
        )).canvas
        if (current.revision !== intent.baseRevision) {
          throw new CanvasRevisionConflictError(current.revision)
        }
        if (!current.document.tasks.some((task) => task.id === intent.taskId)) {
          throw new ProtocolError(
            'task does not exist at the requested revision',
            'task_not_found',
            404,
          )
        }
        const currentResolver = requireWorkspaceSkillResolver(context.workspaceCapabilities)
        const currentPluginCapabilities = resolveProjectionPluginCapabilitySnapshot(
          browserClaims,
          workspaceProjectionContributionSnapshot(context.workspaceCapabilities),
        )
        const [currentAttachments, currentSkills] = await Promise.all([
          resolveRunIntentAttachments(
            intent,
            current.document,
            context.runs,
            projectDir,
            currentPluginCapabilities,
          ),
          resolveRunIntentSkills(
            intent,
            current.document,
            context.skillAssets,
            currentResolver.resolver,
            currentResolver.provider,
          ),
        ])
        if (currentPluginCapabilities.digest !== pluginCapabilities.digest
          || JSON.stringify(currentAttachments) !== JSON.stringify(resolvedAttachments)
          || currentSkills.digest !== resolvedSkills.digest
          || currentSkills.resolverDigest !== resolvedSkills.resolverDigest
          || currentSkills.resolverProvider !== resolvedSkills.resolverProvider
          || JSON.stringify(currentSkills.skills) !== JSON.stringify(resolvedSkills.skills)) {
          throw new ProtocolError(
            'Task Run inputs changed before acceptance; retry from the current Canvas state',
            'run_inputs_changed',
            409,
          )
        }
      },
    })
    await context.executions.recordTaskRun({
      projectId: operationalProjectId(projectDir),
      taskId: intent.taskId,
      runId: run.runId,
      agentId: intent.agentId,
    }).catch(() => undefined)
    writeJson(response, 202, { runId: run.runId })
    return
  }

  if (request.method === 'GET' && pathname === '/runs') {
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    if (singleQueryParameter(url, 'nodeId') !== undefined) {
      throw new ProtocolError(
        'nodeId is not a supported Run history filter',
        'invalid_run_history_filter',
        400,
      )
    }
    const rawTaskId = singleQueryParameter(url, 'taskId')
    const taskId = rawTaskId === undefined ? undefined : parseTaskId(rawTaskId)
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

  if (request.method === 'GET' && pathname === '/artifact-catalog') {
    const projectDir = singleQueryParameter(url, 'projectDir')
    if (projectDir === undefined) {
      throw new ProtocolError(
        'projectDir is required for the artifact catalog',
        'project_dir_required',
        400,
      )
    }
    const rawBranch = singleQueryParameter(url, 'branch')
    const canvasBranch = rawBranch === undefined ? undefined : parseCanvasBranch(rawBranch)
    const limit = optionalIntegerQuery(url, 'limit', {
      min: 1,
      max: MAX_ARTIFACT_CATALOG_LIMIT,
    })
    const cursor = singleQueryParameter(url, 'cursor')
    try {
      writeJson(response, 200, await listArtifactCatalog(context.runs, projectDir, {
        ...(canvasBranch ? { canvasBranch } : {}),
        ...(limit ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }))
    } catch (error) {
      if (error instanceof ArtifactCatalogCursorError) {
        throw new ProtocolError(error.message, 'invalid_artifact_catalog_cursor', 400)
      }
      throw error
    }
    return
  }

  const runArtifactMetadataMatch = pathname.match(
    /^\/runs\/([^/]+)\/artifacts\/([^/]+)\/metadata$/,
  )
  if (request.method === 'GET' && runArtifactMetadataMatch) {
    const runId = runIdFromPath(runArtifactMetadataMatch[1])
    const artifactId = artifactIdFromPath(runArtifactMetadataMatch[2])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const artifact = await lookupVerifiedRunArtifact(context.runs, {
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
  if ((request.method === 'GET' || request.method === 'HEAD') && runArtifactMatch) {
    const runId = runIdFromPath(runArtifactMatch[1])
    const artifactId = artifactIdFromPath(runArtifactMatch[2])
    const projectDir = singleQueryParameter(url, 'projectDir') ?? '.'
    const artifact = await lookupVerifiedRunArtifact(context.runs, {
      runId,
      artifactId,
      projectDir,
    })
    await streamRunArtifact(request, response, artifact)
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
      'Canvas run logs are durable execution records and cannot be deleted independently',
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

async function lookupVerifiedRunArtifact(
  runs: RunManager,
  input: { runId: string; artifactId: string; projectDir: string },
): Promise<RunArtifactLookup> {
  let artifact: RunArtifactLookup | null
  try {
    artifact = await runs.lookupRunArtifact(input.runId, input.artifactId, input.projectDir)
  } catch {
    throw new ProtocolError(
      'artifact no longer matches its closed manifest',
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

async function loadPluginCapabilitiesForRun(
  context: RouteContext,
  projectDir: string,
  digest: string,
): Promise<ProjectionPluginCapabilitySnapshot> {
  const leasedProjectDir = await context.canvas.acquireProjectLease(projectDir)
  let snapshot: ProjectionPluginCapabilitySnapshot | null
  try {
    snapshot = await new ProjectionPluginCapabilityStore(leasedProjectDir).get(digest)
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

function projectIdFromPath(value: string | undefined): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value ?? '')
  } catch {
    throw new ProtocolError('project id contains invalid URL encoding', 'invalid_project_id', 400)
  }
  if (!/^project_[0-9a-f]{32}$/u.test(decoded)) {
    throw new ProtocolError('workspace project id is invalid', 'invalid_project_id', 400)
  }
  return decoded
}

function nodeDefinitionIdFromPath(value: string | undefined): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value ?? '')
  } catch {
    throw new ProtocolError(
      'node definition id contains invalid URL encoding',
      'invalid_node_definition',
      400,
    )
  }
  if (!/^@local\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(decoded)) {
    throw new ProtocolError('node definition id is invalid', 'invalid_node_definition', 400)
  }
  return decoded
}

function requiredSkillIdFromPath(value: string | undefined): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value ?? '')
  } catch {
    throw new ProtocolError('skill id contains invalid URL encoding', 'invalid_skill_asset', 400)
  }
  return requiredSkillId(decoded, 'skillId')
}

function requiredNodeTypeFromPath(value: string | undefined): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value ?? '')
  } catch {
    throw new ProtocolError('node type contains invalid URL encoding', 'invalid_skill_binding', 400)
  }
  if (!isNodeTypeId(decoded)) {
    throw new ProtocolError('node type is invalid', 'invalid_skill_binding', 400)
  }
  return decoded
}

function requiredSkillId(value: unknown, label: string): string {
  if (!isSkillId(value)) {
    throw new ProtocolError(`${label} is invalid`, 'invalid_skill_asset', 400)
  }
  return value
}

function skillAssetProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error
  if (error instanceof SkillAssetConflictError) {
    return new ProtocolError(error.message, 'skill_asset_conflict', 409)
  }
  return new ProtocolError(
    error instanceof Error ? error.message : 'skill asset operation failed',
    'invalid_skill_asset',
    400,
  )
}

function nodeStudioAgentNodeId(definitionId: string): string {
  const digest = createHash('sha256').update(definitionId).digest('hex').slice(0, 24)
  return `node-studio-${digest}`
}

function isNodeStudioRunSummary(value: RunSummary | null): value is RunSummary & {
  runKind: 'node-studio'
  baseDefinitionId: string
  baseDefinitionRevision: number
} {
  return value !== null
    && value.taskId === undefined
    && value.runKind === 'node-studio'
    && typeof value.baseDefinitionId === 'string'
    && /^@local\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.baseDefinitionId)
    && Number.isSafeInteger(value.baseDefinitionRevision)
    && Number(value.baseDefinitionRevision) >= 0
}

function nodeStudioAgentPrompt(
  requirement: string,
  current: CustomNodeManifest,
): string {
  const candidateExample = {
    schemaVersion: CUSTOM_NODE_MANIFEST_SCHEMA_VERSION,
    id: current.id,
    label: current.label,
    description: current.description,
    contentKind: current.contentKind,
    icon: current.icon,
    defaultWidth: current.defaultWidth,
    initialPayloadSchema: current.initialPayloadSchema,
    initialPayload: current.initialPayload,
    placeholder: current.placeholder,
    actions: current.actions,
    containment: current.containment,
    ports: current.ports,
    ...(current.execution ? { execution: current.execution } : {}),
    exporters: current.exporters,
    agent: current.agent,
    emptyTitle: current.emptyTitle,
    emptyDescription: current.emptyDescription,
    sampleTitle: current.sampleTitle,
    sampleContent: current.sampleContent,
  }
  return [
    '你是 GGAI 节点设计 Agent。请把用户需求转换为安全的声明式节点定义。',
    '只设计节点的声明式内容模板、端口、子节点策略、执行/导出 capability 和快捷指令；平台拥有外壳、Task、Run、Edge 与权限。',
    '禁止生成或建议执行 JavaScript、TypeScript、TSX、HTML、CSS、shell、外部 URL 或 Canvas command。',
    '最终必须在本次 artifact 目录根部写入 node-definition.json，UTF-8 JSON，且只能包含示例中的字段。',
    'contentKind 与 icon 只能是 text、image、table、card；defaultWidth 必须是 280–640 的整数；actions 最多 6 个；所有 schema id 必须使用 ggai://。',
    'execution 只能声明 capability/policy 名称，不能包含命令、镜像、路径、环境变量或 secrets。',
    'id 必须是 @local/kebab-case，不能使用内置节点 id。不要写 revision、installed、updatedAt。',
    '',
    '当前定义：',
    '```json',
    JSON.stringify(candidateExample, null, 2),
    '```',
    '',
    `用户需求：${requirement}`,
    '',
    '请根据需求修改必要字段，保留未被要求改变的合理部分。除 node-definition.json 和运行控制文件外不要创建其他交付物。',
  ].join('\n')
}

function latestNodeStudioProgress(entries: Array<RunStreamMessage & { id: number }>): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.event !== 'agent-event') continue
    const event = entry.data
    if (event.type === 'thinking' || event.type === 'text-delta') return event.text.slice(-500)
    if (event.type === 'tool-call') return `正在使用 ${event.name}`
    if (event.type === 'file-write') return `正在写入 ${path.posix.basename(event.path)}`
    if (event.type === 'permission-request') return `等待确认：${event.action}`
    if (event.type === 'error') return event.message
  }
  return undefined
}

async function readNodeStudioCandidate(
  runs: RunManager,
  summary: RunSummary & {
    runKind: 'node-studio'
    baseDefinitionId: string
    baseDefinitionRevision: number
  },
  close: RunClosePayload | null,
  definitions: CustomNodeManifest[],
): Promise<CustomNodeManifest> {
  const runId = summary.runId
  if (!close
    || close.runId !== runId
    || close.status !== 'done'
    || close.artifactsComplete !== true
    || !close.artifactManifest
    || close.artifactManifest.runId !== runId
    || close.artifactManifest.complete !== true) {
    throw new Error('Agent 运行尚未形成完整、可信的结果')
  }
  const candidates = close.artifactManifest.entries.filter((entry) =>
    entry.relativePath === 'node-definition.json')
  if (candidates.length !== 1) {
    throw new Error('Agent 没有生成 node-definition.json')
  }
  const entry = candidates[0]!
  const artifact = await runs.lookupRunArtifact(runId, entry.artifactId, '.')
  if (!artifact
    || artifact.runId !== runId
    || artifact.relativePath !== 'node-definition.json'
    || artifact.contentDigest !== entry.contentDigest
    || artifact.size !== entry.size) {
    throw new Error('Agent 返回的节点定义未通过产物完整性校验')
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null
  let raw: string
  try {
    handle = await open(artifact.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size !== artifact.size
      || metadata.size > 256 * 1024) {
      throw new Error('Agent 返回的节点定义文件无效或过大')
    }
    const bytes = await readExactFileBytes(handle, metadata.size, 256 * 1024)
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.contentDigest) {
      throw new Error('Agent 返回的节点定义在验证后发生变化')
    }
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    await handle?.close().catch(() => undefined)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('Agent 返回的节点定义不是有效 JSON', { cause: error })
  }
  const candidate = parseNodeStudioCandidate(parsed)
  if (summary.baseDefinitionRevision > 0 && candidate.id !== summary.baseDefinitionId) {
    throw new Error('已保存节点的 ID 不能由 Agent 改写')
  }
  if (summary.baseDefinitionRevision === 0
    && candidate.id !== summary.baseDefinitionId
    && definitions.some((definition) => definition.id === candidate.id)) {
    throw new Error('Agent 候选不能改写另一个已有节点包')
  }
  const manifest: CustomNodeManifest = {
    ...candidate,
    revision: summary.baseDefinitionRevision,
    installed: false,
    updatedAt: new Date().toISOString(),
  }
  const errors = validateCustomNodeManifest(manifest)
  if (errors.length > 0) throw new Error(`Agent 返回的节点定义未通过校验：${errors.join('; ')}`)
  return manifest
}

function parseNodeStudioCandidate(value: unknown): Omit<
  CustomNodeManifest,
  'revision' | 'installed' | 'updatedAt'
> {
  const body = requestObject(value)
  const keys = [
    'schemaVersion', 'id', 'label', 'description', 'contentKind', 'icon', 'defaultWidth',
    'initialPayloadSchema', 'initialPayload', 'placeholder', 'actions', 'containment', 'ports',
    'exporters', 'agent', 'emptyTitle', 'emptyDescription', 'sampleTitle', 'sampleContent',
    ...(body.execution === undefined ? [] : ['execution']),
  ] as const
  if (!hasExactBodyKeys(body, keys)) throw new Error('Agent 返回的节点定义包含未知字段')
  if (body.schemaVersion !== CUSTOM_NODE_MANIFEST_SCHEMA_VERSION) {
    throw new Error('Agent 返回了不支持的节点定义版本')
  }
  const contentKind = body.contentKind
  const icon = body.icon
  if (!['text', 'image', 'table', 'card'].includes(String(contentKind))
    || !['text', 'image', 'table', 'card'].includes(String(icon))) {
    throw new Error('Agent 返回了不支持的内容模板')
  }
  if (!Array.isArray(body.actions) || !body.actions.every((action) => typeof action === 'string')
    || !Array.isArray(body.ports)
    || !Array.isArray(body.exporters)
    || !body.exporters.every((exporter) => typeof exporter === 'string')) {
    throw new Error('Agent 返回的数组字段无效')
  }
  return {
    schemaVersion: CUSTOM_NODE_MANIFEST_SCHEMA_VERSION,
    id: requiredBodyString(body, 'id', 160),
    label: requiredBodyString(body, 'label', 80),
    description: requiredBodyString(body, 'description', 500),
    contentKind: contentKind as CustomNodeManifest['contentKind'],
    icon: icon as CustomNodeManifest['icon'],
    defaultWidth: requiredBodySafeInteger(body, 'defaultWidth', { min: 280, max: 640 }),
    initialPayloadSchema: requiredBodyString(body, 'initialPayloadSchema', 240),
    initialPayload: structuredClone(requestObject(body.initialPayload)),
    placeholder: requiredBodyString(body, 'placeholder', 500),
    actions: [...body.actions],
    containment: structuredClone(requestObject(body.containment)) as unknown as CustomNodeManifest['containment'],
    ports: structuredClone(body.ports) as CustomNodeManifest['ports'],
    ...(body.execution === undefined
      ? {}
      : { execution: structuredClone(requestObject(body.execution)) as unknown as NonNullable<CustomNodeManifest['execution']> }),
    exporters: [...body.exporters],
    agent: structuredClone(requestObject(body.agent)) as unknown as CustomNodeManifest['agent'],
    emptyTitle: requiredBodyString(body, 'emptyTitle', 120),
    emptyDescription: requiredBodyString(body, 'emptyDescription', 240),
    sampleTitle: requiredBodyString(body, 'sampleTitle', 120),
    sampleContent: requiredBodyString(body, 'sampleContent', 10_000),
  }
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

function hasExactBodyKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(body).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
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

function requiredBodyString(
  body: Record<string, unknown>,
  name: string,
  maxLength = 500,
): string {
  const value = optionalBodyString(body, name, maxLength)
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
  const allowed = new Set([
    'sourceCommit',
    'targetCommit',
    'sourceRevision',
    'targetRevision',
  ])
  if (Object.keys(expected).some((key) => !allowed.has(key))) {
    throw new ProtocolError('Canvas merge expectation has unsupported properties')
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

function requiredBodySafeInteger(
  body: Record<string, unknown>,
  name: string,
  range: { min: number; max: number },
): number {
  const value = body[name]
  if (!Number.isSafeInteger(value)
    || Number(value) < range.min
    || Number(value) > range.max) {
    throw new ProtocolError(`${name} must be an integer from ${range.min} to ${range.max}`)
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

function requireWorkspaceSkillResolver(services: ServiceReader): {
  resolver: SkillResolver
  provider: string
} {
  const resolver = services.get(SKILL_RESOLVER_SERVICE)
  const provider = services.ownerOf(SKILL_RESOLVER_SERVICE)
  if (!resolver || !provider) {
    throw new ProtocolError(
      'Workspace Skill Resolver capability is unavailable',
      'run_skill_unavailable',
      409,
    )
  }
  return { resolver, provider }
}

function workspaceProjectionCommitter(
  versions: WorkspaceVersionManager,
): CanvasProjectionCommitter {
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
  registry: AgentRegistry,
  versions: WorkspaceVersionManager,
  canvas: CanvasCommandStoreManager,
  projects: ProjectCatalog,
  projectLeases: ProjectLeaseManager,
  lifecycle: { closing: boolean },
  capabilityExecutionScopes: CapabilityExecutionScopes,
  ownsCapabilityExecutionScopes: boolean,
  metadata: MetadataStore,
  ownsMetadata: boolean,
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
    if (ownsCapabilityExecutionScopes) await capabilityExecutionScopes.dispose()
    await registry.dispose()
    await serverClosed
    await versions.close()
    await projects.close()
  } finally {
    canvas.close()
    await projectLeases.close()
    if (ownsMetadata) await metadata.close()
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

async function streamRunArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  artifact: RunArtifactLookup,
): Promise<void> {
  const previewLimit = isTextMediaType(artifact.mediaType)
    ? MAX_TEXT_ARTIFACT_BYTES
    : MAX_ARTIFACT_BYTES
  if (artifact.size > previewLimit) {
    throw new ProtocolError('artifact is too large to preview', 'artifact_too_large', 413)
  }
  let handle: Awaited<ReturnType<typeof openVerifiedRunArtifactFile>>
  try {
    // Reopen with O_NOFOLLOW and re-hash on this exact descriptor. The path may
    // have been replaced after lookup(), so no response headers are committed
    // until this second, descriptor-bound verification succeeds.
    handle = await openVerifiedRunArtifactFile(artifact)
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      throw new ProtocolError('artifact not found', 'artifact_not_found', 404)
    }
    throw new ProtocolError(
      'artifact no longer matches its closed manifest',
      'artifact_integrity_error',
      409,
    )
  }
  try {
    const requestedRange = parseArtifactByteRange(request.headers.range, artifact.size)
    const commonHeaders = {
      'Content-Type': artifact.mediaType,
      'Cache-Control': 'private, immutable',
      ETag: `"sha256-${artifact.contentDigest}"`,
      'Accept-Ranges': 'bytes',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, ETag',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    }
    if (requestedRange === 'unsatisfiable') {
      response.writeHead(416, {
        ...commonHeaders,
        'Content-Range': `bytes */${artifact.size}`,
        'Content-Length': 0,
      })
      response.end()
      return
    }

    const start = requestedRange?.start ?? 0
    const end = requestedRange?.end ?? Math.max(0, artifact.size - 1)
    const contentLength = requestedRange ? end - start + 1 : artifact.size
    response.writeHead(requestedRange ? 206 : 200, {
      ...commonHeaders,
      'Content-Length': contentLength,
      ...(requestedRange
        ? { 'Content-Range': `bytes ${start}-${end}/${artifact.size}` }
        : {}),
    })
    if (request.method === 'HEAD' || contentLength === 0) {
      response.end()
      return
    }

    // FileHandle#createReadStream reuses `handle.fd`; it never resolves or
    // reopens artifact.absolutePath. Replacing the directory entry now cannot
    // redirect the bytes delivered by this response.
    const stream = handle.createReadStream({
      autoClose: false,
      start,
      end,
    })
    await pipeline(stream, response)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

type ArtifactByteRange = { start: number; end: number }

function parseArtifactByteRange(
  value: string | string[] | undefined,
  size: number,
): ArtifactByteRange | 'unsatisfiable' | null {
  if (value === undefined) return null
  if (Array.isArray(value) || size === 0) return 'unsatisfiable'
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return 'unsatisfiable'

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable'
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || requestedEnd < start
    || start >= size) return 'unsatisfiable'
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || mediaType === 'application/json'
    || mediaType === 'application/xml'
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function operationalProjectId(projectDir: string): string {
  return `project-scope-${createHash('sha256').update(path.resolve(projectDir)).digest('hex')}`
}

function parseRunIntentForServer(value: unknown): RunIntent {
  try {
    return parseRunIntent(value)
  } catch (error) {
    if (error instanceof TaskRunProtocolError) {
      throw new ProtocolError(error.message, 'invalid_run_intent', 400)
    }
    throw error
  }
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
  if (error instanceof NodeExecutionError) {
    writeJson(response, error.status, {
      error: { code: error.code, message: error.message },
    })
    return
  }
  if (error instanceof FilesystemServiceError) {
    writeJson(response, error.status, {
      error: { code: error.code, message: error.message },
    })
    return
  }
  if (error instanceof ProjectCatalogError) {
    writeJson(response, error.status, {
      error: { code: error.code, message: error.message },
    })
    return
  }
  if (error instanceof PermissionPolicyError) {
    writeJson(response, 403, { error: { code: error.code.toLowerCase(), message: error.message } })
    return
  }
  if (error instanceof TaskSessionsCorruptionError) {
    writeJson(response, 409, {
      error: {
        code: 'task_sessions_corrupt',
        message: error.message,
        recovery: error.recovery,
      },
    })
    return
  }
  if (error instanceof CanvasGitError) {
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
  if (error instanceof WorkspaceVersioningError) {
    writeJson(response, 409, {
      error: { code: error.code, message: error.message },
    })
    return
  }
  if (error instanceof ProjectionPlanUnavailableError) {
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
      error: { code: `canvas_${error.code}`, message: error.message },
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
  if (error instanceof CanvasSnapshotError) {
    writeJson(response, 409, {
      error: {
        code: 'canvas_corrupt',
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
  command: CanvasCommandWire,
): command is Extract<CanvasCommandWire, {
  type: 'MaterializeProjectionPlan' | 'AcceptTaskProposals' | 'DismissPlan'
}> {
  return command.type === 'MaterializeProjectionPlan'
    || command.type === 'AcceptTaskProposals'
    || command.type === 'DismissPlan'
}

function isTaskDestructiveCanvasCommand(
  command: OrdinaryCanvasCommand,
): command is Extract<OrdinaryCanvasCommand, {
  type: 'DeleteNode' | 'DeleteTask' | 'DeleteTaskAndViews' | 'DeleteCollectionAndContents'
}> {
  return command.type === 'DeleteNode'
    || command.type === 'DeleteTask'
    || command.type === 'DeleteTaskAndViews'
    || command.type === 'DeleteCollectionAndContents'
}

function destructiveTaskIds(
  command: Extract<OrdinaryCanvasCommand, {
    type: 'DeleteNode' | 'DeleteTask' | 'DeleteTaskAndViews' | 'DeleteCollectionAndContents'
  }>,
  document: CanvasDocument,
): string[] {
  if (command.type === 'DeleteNode') {
    const node = document.nodes.find((entry) => entry.id === command.nodeId)
    if (!node?.homeTaskId) return []
    return document.nodes.some((entry) =>
      entry.id !== node.id && entry.homeTaskId === node.homeTaskId)
      ? []
      : [node.homeTaskId]
  }
  if (command.type === 'DeleteTask' || command.type === 'DeleteTaskAndViews') {
    return [command.taskId]
  }
  return document.tasks
    .filter((task) => task.collectionId === command.collectionId)
    .map((task) => task.id)
}
