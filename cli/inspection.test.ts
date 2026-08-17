import { describe, expect, it, vi } from 'vitest'
import { canvasNodeGeometry, canvasNodeTypeRef, emptyCanvasDocument } from '../src/canvas/model'
import {
  canvasGraph,
  canvasTreeText,
  inspectCanvas,
  inspectNode,
  nodeText,
} from './inspection'

describe('CLI Canvas inspection', () => {
  it('renders Task/Node trees and graph exchange formats', async () => {
    const document = fixtureDocument()
    const result = await inspectCanvas({ project: 'demo', branch: 'main' }, dependencies(document))

    expect(canvasTreeText(result)).toContain('text · Result Node')
    expect(canvasGraph(document, 'ascii')).toContain('produced / context:full')
    expect(canvasGraph(document, 'mermaid')).toContain('flowchart LR')
    expect(canvasGraph(document, 'dot')).toContain('digraph Canvas')
    expect(canvasGraph(document, 'json')).toMatchObject({ edges: [{ relation: 'produced' }] })
  })

  it('renders Node metadata without layout unless debug is explicit', async () => {
    const document = fixtureDocument()
    const normal = await inspectNode({
      project: 'demo',
      branch: 'main',
      nodeId: 'node-1',
      debugLayout: false,
    }, dependencies(document))
    expect(normal.node).not.toHaveProperty('layout')
    expect(nodeText(normal)).toContain('image/png · 2.0 KiB')

    const debug = await inspectNode({
      project: 'demo',
      branch: 'main',
      nodeId: 'node-1',
      debugLayout: true,
    }, dependencies(document))
    expect(nodeText(debug)).toContain('matrix:  [1, 0, 0, 1, 160, 220]')
  })
})

function fixtureDocument() {
  const document = emptyCanvasDocument()
  document.tasks.push({
    id: 'task-1',
    title: 'Demo Task',
    goal: 'Create result',
    anchor: { x: 120, y: 120 },
    origin: { kind: 'user' },
  })
  document.nodes.push({
    id: 'node-1',
    typeRef: canvasNodeTypeRef('text'),
    ...canvasNodeGeometry({ x: 160, y: 220, w: 400, h: 256, z: 1 }),
    title: 'Result Node',
    text: 'Hello',
    artifactRefs: [{ runId: 'run-1', artifactId: `artifact_${'a'.repeat(64)}` }],
    homeTaskId: 'task-1',
    origin: { kind: 'agent-output', taskId: 'task-1', runId: 'run-1', planId: `plan_${'b'.repeat(64)}`, outputKey: 'result' },
  })
  document.edges.push({
    id: 'edge-1',
    from: { kind: 'task', id: 'task-1' },
    to: { kind: 'node', id: 'node-1' },
    relation: 'produced',
    contextRole: 'full',
    origin: { kind: 'user' },
  })
  return document
}

function dependencies(document: ReturnType<typeof fixtureDocument>) {
  return {
    projects: {
      list: vi.fn(async () => [project()]),
      open: vi.fn(async () => project()),
    },
    canvas: {
      getCanvas: vi.fn(async () => ({
        branch: 'main', revision: 20, updatedAt: '2026-08-17T00:00:00.000Z', lastMutationId: null, document,
      })),
    },
    daemonUrl: 'http://daemon.test',
    fetch: vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      runId: 'run-1',
      artifactId: `artifact_${'a'.repeat(64)}`,
      mediaType: 'image/png',
      size: 2048,
      contentDigest: 'c'.repeat(64),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch,
  }
}

function project() {
  return {
    id: 'project_11111111111111111111111111111111',
    title: 'demo',
    projectDir: '.gg/workspace/projects/project_11111111111111111111111111111111',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    lastOpenedAt: null,
    state: 'ready' as const,
    summary: { taskCount: 1, nodeCount: 1, collectionCount: 0 },
  }
}
