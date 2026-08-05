import { describe, expect, it } from 'vitest'
import {
  compileTaskContextV2,
  renderTaskContextPromptV2,
} from './contextV2'
import {
  emptyCanvasDocumentV2,
  type CanvasDocumentV2,
  type CanvasEdgeContextRoleV2,
  type CanvasEntityRef,
  type CanvasNodeV2,
  type CanvasTaskV2,
} from '../canvas-v2/model'

function task(id: string, goal = `${id} goal`): CanvasTaskV2 {
  return {
    id,
    title: `${id} title`,
    goal,
    anchor: { x: 0, y: 0 },
    origin: { kind: 'user' },
  }
}

function node(id: string): CanvasNodeV2 {
  return {
    id,
    type: 'code',
    frame: { x: 0, y: 0, w: 320, h: 180, z: 1 },
    title: `${id} title`,
    text: `${id} secret text`,
    payload: { source: id, hidden: true },
    artifactRefs: [{
      runId: 'run-1',
      artifactId: `artifact_${'a'.repeat(64)}`,
    }],
    origin: { kind: 'user' },
  }
}

function edge(
  id: string,
  from: CanvasEntityRef,
  to: CanvasEntityRef,
  contextRole: CanvasEdgeContextRoleV2,
) {
  return {
    id,
    from,
    to,
    relation: 'source' as const,
    contextRole,
    origin: { kind: 'user' as const },
  }
}

function documentWithTarget(): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
  document.tasks.push(task('target'))
  return document
}

describe('Task Context V2', () => {
  it('includes full Node content, trims summary Nodes, and excludes none edges', () => {
    const document = documentWithTarget()
    document.nodes.push(node('full'), node('summary'), node('none'))
    document.edges.push(
      edge('edge-full', { kind: 'node', id: 'full' }, { kind: 'task', id: 'target' }, 'full'),
      edge(
        'edge-summary',
        { kind: 'node', id: 'summary' },
        { kind: 'task', id: 'target' },
        'summary',
      ),
      edge('edge-none', { kind: 'node', id: 'none' }, { kind: 'task', id: 'target' }, 'none'),
    )

    const pack = compileTaskContextV2({
      document,
      taskId: 'target',
      runFilesDirectory: 'artifacts/run-1/files',
    })
    const full = pack.inputs[0]
    const summary = pack.inputs[1]

    expect(full).toMatchObject({
      kind: 'node',
      contextRole: 'full',
      text: 'full secret text',
      payload: { source: 'full', hidden: true },
    })
    expect(full).toHaveProperty('artifactRefs')
    expect(summary).toEqual({
      kind: 'node',
      ref: { kind: 'node', id: 'summary' },
      relation: 'source',
      contextRole: 'summary',
      title: 'summary title',
      type: 'code',
    })
    expect(JSON.stringify(pack)).not.toContain('none secret text')
    expect(pack.graph.entities.map((entity) => entity.ref.id)).not.toContain('none')

    const prompt = renderTaskContextPromptV2(pack)
    expect(prompt).toContain('artifacts/run-1/files')
    expect(prompt).toContain('.ggai/run-result.json')
    expect(prompt).toContain('RunOutcomeV2')
    expect(prompt).toContain('Never declare or invent Canvas entity IDs, coordinates, payloads')
    expect(prompt).toContain('Do not start it or request an auto-run')
  })

  it('represents an incoming Task endpoint with title and bounded goal summary', () => {
    const document = documentWithTarget()
    document.tasks.push(task('source-task', 'g'.repeat(1_200)))
    document.edges.push(edge(
      'edge-task',
      { kind: 'task', id: 'source-task' },
      { kind: 'task', id: 'target' },
      'full',
    ))

    const pack = compileTaskContextV2({ document, taskId: 'target' })

    expect(pack.inputs).toHaveLength(1)
    expect(pack.inputs[0]).toMatchObject({
      kind: 'task',
      ref: { kind: 'task', id: 'source-task' },
      title: 'source-task title',
      contextRole: 'full',
    })
    expect(pack.inputs[0]).toHaveProperty('goalSummary')
    expect((pack.inputs[0] as { goalSummary: string }).goalSummary.length).toBe(1_000)
    expect(pack.inputs[0]).not.toHaveProperty('anchor')
    expect(pack.inputs[0]).not.toHaveProperty('origin')
  })

  it('keeps direct inputs separate from a bounded relevant graph and never leaks unrelated nodes', () => {
    const document = documentWithTarget()
    document.nodes.push(node('direct'), node('upstream'), node('unrelated'))
    document.edges.push(
      edge(
        'edge-direct',
        { kind: 'node', id: 'direct' },
        { kind: 'task', id: 'target' },
        'summary',
      ),
      edge(
        'edge-upstream',
        { kind: 'node', id: 'upstream' },
        { kind: 'node', id: 'direct' },
        'full',
      ),
    )

    const pack = compileTaskContextV2({ document, taskId: 'target' })

    expect(pack.inputs.map((input) => input.ref.id)).toEqual(['direct'])
    expect(pack.graph.entities.map((entity) => entity.ref.id)).toEqual([
      'target',
      'direct',
      'upstream',
    ])
    expect(JSON.stringify(pack)).not.toContain('unrelated')

    const bounded = compileTaskContextV2({
      document,
      taskId: 'target',
      limits: { maxDepth: 1 },
    })
    expect(bounded.graph.entities.map((entity) => entity.ref.id)).toEqual(['target', 'direct'])
    expect(bounded.truncated).toBe(true)
  })

  it('terminates on a relevant Task cycle without duplicating entities or edges', () => {
    const document = documentWithTarget()
    document.tasks.push(task('cycle-task'))
    document.edges.push(
      edge(
        'edge-to-target',
        { kind: 'task', id: 'cycle-task' },
        { kind: 'task', id: 'target' },
        'summary',
      ),
      edge(
        'edge-back',
        { kind: 'task', id: 'target' },
        { kind: 'task', id: 'cycle-task' },
        'summary',
      ),
    )

    const pack = compileTaskContextV2({ document, taskId: 'target' })

    expect(pack.inputs.map((input) => input.ref.id)).toEqual(['cycle-task'])
    expect(pack.graph.entities.map((entity) => entity.ref.id)).toEqual(['target', 'cycle-task'])
    expect(pack.graph.edges).toHaveLength(2)
    expect(pack.graph.truncated).toBe(false)
  })
})
