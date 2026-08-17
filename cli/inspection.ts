import type { CanvasDocument, CanvasEntityRef } from '../src/canvas/model.js'
import type { WorkspaceProjectClient } from '../src/workspace/projectClient.js'
import type { HeadlessCanvasClient } from './canvasClient.js'
import { CliCommandError } from './output.js'
import { resolveHeadlessProject } from './run.js'

export interface InspectionRequest {
  project: string
  branch: string
}

export interface InspectionDependencies {
  projects: Pick<WorkspaceProjectClient, 'list' | 'open'>
  canvas: Pick<HeadlessCanvasClient, 'getCanvas'>
  fetch: typeof globalThis.fetch
  daemonUrl: string
}

export async function inspectCanvas(request: InspectionRequest, dependencies: InspectionDependencies) {
  const project = await resolveHeadlessProject(request.project, dependencies.projects)
  const opened = await dependencies.projects.open(project.id)
  const canvas = await dependencies.canvas.getCanvas({
    projectDir: opened.projectDir,
    branch: request.branch,
  })
  return {
    project: { id: opened.id, title: opened.title },
    projectDir: opened.projectDir,
    branch: canvas.branch,
    revision: canvas.revision,
    document: canvas.document,
  }
}

export async function inspectNode(
  request: InspectionRequest & { nodeId: string; debugLayout: boolean },
  dependencies: InspectionDependencies,
) {
  const canvas = await inspectCanvas(request, dependencies)
  const node = canvas.document.nodes.find((entry) => entry.id === request.nodeId)
  if (!node) throw new CliCommandError('node_not_found', `node not found: ${request.nodeId}`, 5)
  const task = node.homeTaskId
    ? canvas.document.tasks.find((entry) => entry.id === node.homeTaskId) ?? null
    : null
  const artifacts = await Promise.all(node.artifactRefs.map(async (ref) => {
    const url = new URL(
      `/runs/${encodeURIComponent(ref.runId)}/artifacts/${encodeURIComponent(ref.artifactId)}/metadata`,
      `${dependencies.daemonUrl}/`,
    )
    url.searchParams.set('projectDir', canvas.projectDir)
    const response = await dependencies.fetch(url, { headers: { Accept: 'application/json' } })
    const value = await response.json() as unknown
    if (!response.ok || !isArtifactMetadata(value, ref.runId, ref.artifactId)) {
      throw new CliCommandError('artifact_unavailable', `artifact unavailable: ${ref.artifactId}`, 5)
    }
    return value
  }))
  return {
    project: canvas.project,
    branch: canvas.branch,
    revision: canvas.revision,
    node: {
      id: node.id,
      type: node.type,
      title: node.title,
      text: node.text ?? null,
      payload: node.payload ?? null,
      homeTask: task ? { id: task.id, title: task.title } : null,
      origin: node.origin,
      artifacts,
      ...(request.debugLayout ? { frame: node.frame } : {}),
    },
  }
}

export function canvasTreeText(input: Awaited<ReturnType<typeof inspectCanvas>>): string {
  const lines = [`Canvas ${input.branch} · revision ${input.revision}`, '', 'Tasks']
  for (const task of input.document.tasks) {
    lines.push(`├─ ${task.title}  [${task.id}]`, `│  goal: ${task.goal}`)
    const outputs = input.document.nodes.filter((node) => node.homeTaskId === task.id)
    if (outputs.length === 0) lines.push('│  └─ no outputs')
    for (const node of outputs) {
      lines.push(`│  └─ ${node.type} · ${node.title}  [${node.id}] · ${node.artifactRefs.length} artifact(s)`)
    }
  }
  const topLevel = input.document.nodes.filter((node) => !node.homeTaskId)
  if (topLevel.length > 0) {
    lines.push('', 'Top-level Nodes')
    for (const node of topLevel) lines.push(`├─ ${node.type} · ${node.title}  [${node.id}]`)
  }
  if (input.document.collections.length > 0) {
    lines.push('', 'Collections')
    for (const collection of input.document.collections) {
      const count = input.document.tasks.filter((task) => task.collectionId === collection.id).length
        + input.document.nodes.filter((node) => node.collectionId === collection.id).length
      lines.push(`├─ ${collection.title}  [${collection.id}] · ${count} item(s)`)
    }
  }
  return lines.join('\n')
}

export type GraphFormat = 'ascii' | 'mermaid' | 'dot' | 'json'

export function canvasGraph(
  document: CanvasDocument,
  format: GraphFormat,
): string | { entities: Array<{ ref: CanvasEntityRef; label: string }>; edges: CanvasDocument['edges'] } {
  const entities = [
    ...document.tasks.map((task) => ({ ref: { kind: 'task' as const, id: task.id }, label: `Task · ${task.title}` })),
    ...document.nodes.map((node) => ({ ref: { kind: 'node' as const, id: node.id }, label: `${node.type} · ${node.title}` })),
  ]
  if (format === 'json') return { entities, edges: document.edges }
  const key = (ref: CanvasEntityRef) => `${ref.kind}:${ref.id}`
  const labels = new Map(entities.map((entity) => [key(entity.ref), entity.label]))
  if (format === 'ascii') {
    if (document.edges.length === 0) return 'No edges'
    return document.edges.map((edge) =>
      `[${labels.get(key(edge.from)) ?? key(edge.from)}]\n  └─ ${edge.relation} / context:${edge.contextRole} → [${labels.get(key(edge.to)) ?? key(edge.to)}]`).join('\n')
  }
  const ids = new Map(entities.map((entity, index) => [key(entity.ref), `e${index + 1}`]))
  if (format === 'mermaid') {
    return [
      'flowchart LR',
      ...entities.map((entity) => `  ${ids.get(key(entity.ref))}["${escapeLabel(entity.label)}"]`),
      ...document.edges.map((edge) =>
        `  ${ids.get(key(edge.from))} -->|${edge.relation} / ${edge.contextRole}| ${ids.get(key(edge.to))}`),
    ].join('\n')
  }
  return [
    'digraph Canvas {',
    '  rankdir=LR;',
    ...entities.map((entity) => `  ${ids.get(key(entity.ref))} [label="${escapeLabel(entity.label)}"];`),
    ...document.edges.map((edge) =>
      `  ${ids.get(key(edge.from))} -> ${ids.get(key(edge.to))} [label="${edge.relation} / ${edge.contextRole}"];`),
    '}',
  ].join('\n')
}

export function nodeText(input: Awaited<ReturnType<typeof inspectNode>>): string {
  const node = input.node
  const lines = [
    `Node ${node.title}`,
    `  id:      ${node.id}`,
    `  type:    ${node.type}`,
    `  task:    ${node.homeTask ? `${node.homeTask.title} (${node.homeTask.id})` : 'top-level'}`,
    `  origin:  ${node.origin.kind}`,
  ]
  if (node.text) lines.push('', ...node.text.split(/\r?\n/u).slice(0, 12).map((line) => `  ${line}`))
  if (node.artifacts.length > 0) {
    lines.push('', '  artifacts:')
    for (const artifact of node.artifacts) {
      lines.push(
        `    ${artifact.artifactId}`,
        `    ${artifact.mediaType} · ${formatBytes(artifact.size)}`,
        `    sha256 ${artifact.contentDigest.slice(0, 16)}…`,
      )
    }
  }
  const frame = 'frame' in node ? node.frame : undefined
  if (frame) lines.push('', `  frame:   x=${frame.x} y=${frame.y} w=${frame.w} h=${frame.h} z=${frame.z}`)
  return lines.join('\n')
}

function isArtifactMetadata(
  value: unknown,
  runId: string,
  artifactId: string,
): value is {
  schemaVersion: 2
  runId: string
  artifactId: string
  mediaType: string
  size: number
  contentDigest: string
} {
  return isRecord(value)
    && value.schemaVersion === 2
    && value.runId === runId
    && value.artifactId === artifactId
    && typeof value.mediaType === 'string'
    && Number.isSafeInteger(value.size)
    && typeof value.contentDigest === 'string'
    && /^[0-9a-f]{64}$/u.test(value.contentDigest)
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\r\n]+/gu, ' ')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
