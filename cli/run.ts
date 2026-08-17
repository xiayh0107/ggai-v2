import type { CanvasAgentEvent } from '../src/agent/types.js'
import type {
  TaskRunClosePayload,
  TaskRunHttpClient,
} from '../src/agent/taskRunHttpClient.js'
import type { TaskRunPreflightClient } from '../src/agent/taskRunPreflightClient.js'
import type { CanvasCommand } from '../src/canvas/commands.js'
import type { CanvasDocument, CanvasTask } from '../src/canvas/model.js'
import type { WorkspaceProjectClient, WorkspaceProject } from '../src/workspace/projectClient.js'
import { CliCommandError } from './output.js'
import type { HeadlessCanvasClient } from './canvasClient.js'

export interface HeadlessRunRequest {
  project: string
  prompt: string
  branch: string
  agentId: string
  wait: boolean
}

export interface HeadlessRunArtifact {
  artifactId: string
  relativePath: string
  mediaType: string
  size: number
  contentDigest: string
}

export interface HeadlessRunResult {
  project: { id: string; title: string }
  taskId: string
  runId: string
  status: 'started' | TaskRunClosePayload['status']
  artifacts: HeadlessRunArtifact[]
}

export interface HeadlessRunDependencies {
  projects: Pick<WorkspaceProjectClient, 'list' | 'open'>
  canvas: Pick<HeadlessCanvasClient, 'getCanvas' | 'executeCommand'>
  preflight: Pick<TaskRunPreflightClient, 'check'>
  runs: Pick<TaskRunHttpClient,
    | 'registerPluginCapabilities'
    | 'createTaskRun'
    | 'attachRun'
    | 'resolvePermission'
  >
  uuid: () => string
  now: () => number
  onEvent: (runId: string, event: CanvasAgentEvent) => void
}

export async function executeHeadlessRun(
  request: HeadlessRunRequest,
  dependencies: HeadlessRunDependencies,
): Promise<HeadlessRunResult> {
  const project = await resolveProject(request.project, dependencies.projects)
  const opened = await dependencies.projects.open(project.id)
  if (opened.state !== 'ready') {
    throw new CliCommandError('project_unavailable', `project ${opened.title} is unavailable`, 5)
  }
  const scope = { projectDir: opened.projectDir, branch: request.branch }
  const before = await dependencies.canvas.getCanvas(scope)
  const taskId = `task-${dependencies.uuid()}`
  const mutationId = `mutation-${dependencies.uuid()}`
  const task: CanvasTask = {
    id: taskId,
    title: taskTitle(request.prompt),
    goal: request.prompt,
    anchor: nextTaskAnchor(before.document),
    origin: { kind: 'user' },
  }
  const command: CanvasCommand = { type: 'CreateTask', task }
  const accepted = await dependencies.canvas.executeCommand(scope, {
    branch: request.branch,
    baseRevision: before.revision,
    initialBaseRevision: before.revision,
    mutationId,
    command,
    createdAt: dependencies.now(),
  })
  const preflight = await dependencies.preflight.check({
    projectDir: opened.projectDir,
    taskId,
    agentId: request.agentId,
    canvasBranch: request.branch,
    baseRevision: accepted.revision,
    attachments: [],
  })
  if (preflight.status === 'blocked') {
    throw new CliCommandError(
      'preflight_blocked',
      preflight.issues.map((issue) => issue.message).join('; '),
      5,
    )
  }
  const capability = await dependencies.runs.registerPluginCapabilities(
    opened.projectDir,
    { schemaVersion: 2, plugins: [] },
  )
  const runId = `run-${dependencies.uuid()}`
  await dependencies.runs.createTaskRun({
    schemaVersion: 2,
    runId,
    taskId,
    agentId: request.agentId,
    canvasBranch: request.branch,
    baseRevision: accepted.revision,
    prompt: request.prompt,
    attachments: [],
    materializationPolicy: 'auto',
  }, opened.projectDir, undefined, capability.digest)

  const identity = { project: { id: opened.id, title: opened.title }, taskId, runId }
  if (!request.wait) return { ...identity, status: 'started', artifacts: [] }

  const permissionResolutions: Promise<void>[] = []
  const stream = await dependencies.runs.attachRun(runId, {
    projectDir: opened.projectDir,
    onEvent: (event) => {
      dependencies.onEvent(runId, event)
      if (event.type === 'permission-request') {
        permissionResolutions.push(dependencies.runs.resolvePermission(event.id, {
          decision: 'deny',
          reason: 'gg run denies permissions until an explicit CLI policy is selected',
        }))
      }
    },
  })
  await Promise.all(permissionResolutions)
  return {
    ...identity,
    status: stream.close.status,
    artifacts: stream.close.artifactManifest?.entries.map((entry) => ({ ...entry })) ?? [],
  }
}

async function resolveProject(
  selector: string,
  projects: Pick<WorkspaceProjectClient, 'list'>,
): Promise<WorkspaceProject> {
  const entries = await projects.list()
  const byId = entries.find((project) => project.id === selector)
  if (byId) return byId
  const byTitle = entries.filter((project) => project.title === selector)
  if (byTitle.length === 1) return byTitle[0]!
  if (byTitle.length > 1) {
    throw new CliCommandError(
      'project_ambiguous',
      `multiple projects are titled ${selector}; use the opaque project id`,
      5,
    )
  }
  throw new CliCommandError('project_not_found', `project not found: ${selector}`, 5)
}

function nextTaskAnchor(document: CanvasDocument): { x: number; y: number } {
  if (document.tasks.length === 0) return { x: 120, y: 120 }
  return {
    x: 120,
    y: Math.max(...document.tasks.map((task) => task.anchor.y)) + 420,
  }
}

function taskTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim()
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}…`
}
