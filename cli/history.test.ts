import { describe, expect, it, vi } from 'vitest'
import {
  listHeadlessRunArtifacts,
  readHeadlessRunHistory,
  summarizeHeadlessRunHistory,
} from './history'

describe('gg durable Run inspection', () => {
  it('reads paginated logs and extracts verified manifest entries', async () => {
    const getRunLog = vi.fn()
      .mockResolvedValueOnce({
        entries: [{
          id: 1,
          event: 'agent-event',
          data: { type: 'thinking', text: 'working' },
        }],
        nextEventId: 1,
      })
      .mockResolvedValueOnce({
        entries: [{
          id: 2,
          event: 'close',
          data: {
            runId: 'run-1',
            status: 'done',
            sessionId: null,
            artifacts: ['plot.png'],
            artifactsComplete: true,
            artifactManifest: {
              version: 1,
              runId: 'run-1',
              complete: true,
              entries: [{
                artifactId: `artifact_${'a'.repeat(64)}`,
                relativePath: 'plot.png',
                mediaType: 'image/png',
                size: 42,
                contentDigest: 'b'.repeat(64),
              }],
            },
          },
        }],
        nextEventId: null,
      })
    const dependencies = {
      projects: {
        list: vi.fn(async () => [project()]),
        open: vi.fn(async () => project()),
      },
      runs: { getRunLog },
    }

    const history = await readHeadlessRunHistory({ project: 'demo', runId: 'run-1' }, dependencies)
    expect(history.entries.map((entry) => entry.event)).toEqual(['agent-event', 'close'])
    expect(summarizeHeadlessRunHistory(history.entries, false)).toEqual([
      { id: 1, kind: 'thinking', message: 'working' },
      { id: 2, kind: 'done', message: 'done · 1 artifact(s)' },
    ])

    getRunLog.mockClear()
    getRunLog.mockResolvedValueOnce({ entries: history.entries, nextEventId: null })
    const artifacts = await listHeadlessRunArtifacts(
      { project: 'demo', runId: 'run-1' },
      dependencies,
    )
    expect(artifacts.artifacts).toHaveLength(1)
    expect(artifacts.artifacts[0]?.relativePath).toBe('plot.png')
  })
})

function project() {
  return {
    id: 'project_11111111111111111111111111111111',
    title: 'demo',
    projectDir: '.gg/workspace/projects/project_11111111111111111111111111111111',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    lastOpenedAt: null,
    state: 'ready' as const,
    summary: { taskCount: 0, nodeCount: 0, collectionCount: 0 },
  }
}
