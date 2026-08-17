import {
  decodeTaskRunLogEntry,
  type TaskRunArtifactManifestEntry,
  type TaskRunHttpClient,
} from '../src/agent/taskRunHttpClient.js'
import type { WorkspaceProjectClient } from '../src/workspace/projectClient.js'
import { resolveHeadlessProject } from './run.js'

export interface HeadlessHistoryRequest {
  project: string
  runId: string
}

export interface HeadlessHistoryDependencies {
  projects: Pick<WorkspaceProjectClient, 'list' | 'open'>
  runs: Pick<TaskRunHttpClient, 'getRunLog'>
}

export interface HeadlessLogSummaryEntry {
  id: number
  kind: 'session' | 'thinking' | 'text' | 'tool' | 'artifact' | 'permission' | 'warning' | 'done'
  message: string
}

export async function readHeadlessRunHistory(
  request: HeadlessHistoryRequest,
  dependencies: HeadlessHistoryDependencies,
) {
  const project = await resolveHeadlessProject(request.project, dependencies.projects)
  const opened = await dependencies.projects.open(project.id)
  const entries: ReturnType<typeof decodeTaskRunLogEntry>[] = []
  let cursor = 0
  while (true) {
    const page = await dependencies.runs.getRunLog(request.runId, {
      projectDir: opened.projectDir,
      afterEventId: cursor,
      limit: 2_000,
    })
    for (const raw of page.entries) {
      const entry = decodeTaskRunLogEntry(raw, request.runId)
      entries.push(entry)
      cursor = Math.max(cursor, entry.id)
    }
    if (page.nextEventId === null) break
    cursor = Math.max(cursor, page.nextEventId)
  }
  return { project: { id: opened.id, title: opened.title }, runId: request.runId, entries }
}

export async function listHeadlessRunArtifacts(
  request: HeadlessHistoryRequest,
  dependencies: HeadlessHistoryDependencies,
): Promise<{
  project: { id: string; title: string }
  runId: string
  artifacts: TaskRunArtifactManifestEntry[]
}> {
  const history = await readHeadlessRunHistory(request, dependencies)
  const close = [...history.entries].reverse().find((entry) => entry.event === 'close')
  return {
    project: history.project,
    runId: request.runId,
    artifacts: close?.event === 'close'
      ? close.data.artifactManifest?.entries.map((entry) => ({ ...entry })) ?? []
      : [],
  }
}

export function summarizeHeadlessRunHistory(
  entries: Awaited<ReturnType<typeof readHeadlessRunHistory>>['entries'],
  includeTools: boolean,
): HeadlessLogSummaryEntry[] {
  return entries.flatMap((entry): HeadlessLogSummaryEntry[] => {
    if (entry.event === 'session') {
      return [{ id: entry.id, kind: 'session', message: 'session established' }]
    }
    if (entry.event === 'close') {
      const count = entry.data.artifactManifest?.entries.length ?? 0
      return [{
        id: entry.id,
        kind: 'done',
        message: `${entry.data.status} · ${count} artifact(s)`,
      }]
    }
    const event = entry.data
    if (event.type === 'thinking') {
      return [{ id: entry.id, kind: 'thinking', message: compact(event.text, 220) }]
    }
    if (event.type === 'text-delta') return []
    if (event.type === 'tool-call') {
      const suffix = includeTools ? payloadShape(event.input) : ''
      return [{ id: entry.id, kind: 'tool', message: `${event.name}${suffix}` }]
    }
    if (event.type === 'tool-result') {
      return includeTools ? [{ id: entry.id, kind: 'tool', message: 'tool completed' }] : []
    }
    if (event.type === 'file-write') {
      const filename = event.path.replaceAll('\\', '/').split('/').at(-1) || 'output'
      return [{ id: entry.id, kind: 'artifact', message: filename }]
    }
    if (event.type === 'permission-request') {
      return [{ id: entry.id, kind: 'permission', message: event.action }]
    }
    if (event.type === 'error') {
      return [{ id: entry.id, kind: 'warning', message: compact(event.message, 220) }]
    }
    if (event.type === 'done') {
      return [{ id: entry.id, kind: 'done', message: event.stopReason }]
    }
    return []
  })
}

function payloadShape(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const fields = Object.keys(value).slice(0, 8)
  return fields.length > 0 ? ` · fields: ${fields.join(', ')}` : ''
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}
