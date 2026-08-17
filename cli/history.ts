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
