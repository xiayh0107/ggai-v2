import { describe, expect, it } from 'vitest'
import {
  compileTaskContext,
  renderTaskContextPrompt,
  taskContextArtifactRefs,
} from './taskContext'
import {
  emptyCanvasDocument,
  type CanvasDocument,
  type CanvasEdgeContextRole,
  type CanvasEntityRef,
  type CanvasNode,
  type CanvasTask,
} from '../canvas/model'
import { NODE_CONTEXT_POLICY_SCHEMA_VERSION } from '../plugins/contextContracts'

function task(id: string, goal = `${id} goal`): CanvasTask {
  return {
    id,
    title: `${id} title`,
    goal,
    anchor: { x: 0, y: 0 },
    origin: { kind: 'user' },
  }
}

function node(id: string): CanvasNode {
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
  contextRole: CanvasEdgeContextRole,
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

function documentWithTarget(): CanvasDocument {
  const document = emptyCanvasDocument()
  document.tasks.push(task('target'))
  return document
}

describe('Task Context', () => {
  it('declares target output-slot Node types without exposing renderer or layout state', () => {
    const document = documentWithTarget()
    const emptyImage = node('target-image')
    emptyImage.type = 'image'
    emptyImage.homeTaskId = 'target'
    delete emptyImage.text
    emptyImage.payload = {}
    emptyImage.artifactRefs = []
    const existingText = node('target-text')
    existingText.type = 'text'
    existingText.homeTaskId = 'target'
    document.nodes.push(emptyImage, existingText)

    const pack = compileTaskContext({ document, taskId: 'target' })

    expect(pack.task.outputSlots).toEqual([{
      ref: { kind: 'node', id: 'target-image' },
      title: 'target-image title',
      type: 'image',
      contentState: 'empty',
    }, {
      ref: { kind: 'node', id: 'target-text' },
      title: 'target-text title',
      type: 'text',
      contentState: 'present',
    }])
    expect(pack.task.outputSlotsTruncated).toBe(false)
    const prompt = renderTaskContextPrompt(pack)
    expect(prompt).toContain('target outputSlots are persisted type constraints')
    expect(prompt).toContain('use that slot\'s declared Node type as the output pluginId')
    expect(prompt).not.toContain('"frame"')

    const bounded = compileTaskContext({
      document,
      taskId: 'target',
      limits: { maxTaskOutputs: 1 },
    })
    expect(bounded.task.outputSlots).toHaveLength(1)
    expect(bounded.task.outputSlotsTruncated).toBe(true)
    expect(bounded.truncated).toBe(true)
  })

  it('preserves an installed custom Node runtime id as a target capability', () => {
    const document = documentWithTarget()
    const customSlot = node('target-custom')
    customSlot.type = '@local/research-card@4'
    customSlot.homeTaskId = 'target'
    delete customSlot.text
    customSlot.payload = {}
    customSlot.artifactRefs = []
    document.nodes.push(customSlot)

    const pack = compileTaskContext({ document, taskId: 'target' })
    expect(pack.task.outputSlots).toEqual([{
      ref: { kind: 'node', id: 'target-custom' },
      title: 'target-custom title',
      type: '@local/research-card@4',
      contentState: 'empty',
    }])
    expect(JSON.stringify(pack)).not.toContain('template')
    expect(JSON.stringify(pack)).not.toContain('renderer')
  })

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

    const pack = compileTaskContext({
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
    expect(full).toHaveProperty('artifactRefsTruncated', false)
    expect(summary).toMatchObject({
      kind: 'node',
      ref: { kind: 'node', id: 'summary' },
      relation: 'source',
      contextRole: 'summary',
      title: 'summary title',
      type: 'code',
      contextProjection: {
        policySource: 'compatibility',
        text: { sourceChars: 19, includedChars: 0, truncated: true },
        payload: { sourceFields: 2, includedFields: [], omittedFields: 2 },
        artifactRefs: {
          source: 1,
          included: 0,
          omittedByPolicy: 1,
          omittedByBudget: 0,
        },
      },
    })
    expect(JSON.stringify(pack)).not.toContain('none secret text')
    expect(pack.graph.entities.map((entity) => entity.ref.id)).not.toContain('none')

    const prompt = renderTaskContextPrompt(pack)
    expect(prompt).toContain('artifacts/run-1/files')
    expect(prompt).toContain('.ggai/run-result.json')
    expect(prompt).toContain('RunOutcome')
    expect(prompt).toContain('0–5 suggestedActions, at most 32 outputs, and at most 12 taskProposals')
    expect(prompt).toContain('role must be one of primary, supporting, or auxiliary')
    expect(prompt).toContain('dependsOn is optional')
    expect(prompt).toContain('if it is missing or invalid, the run may still succeed')
    expect(prompt).toContain('"schemaVersion": 2')
    expect(prompt).toContain('"path": "analysis.R"')
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

    const pack = compileTaskContext({ document, taskId: 'target' })

    expect(pack.inputs).toHaveLength(1)
    expect(pack.inputs[0]).toMatchObject({
      kind: 'task',
      ref: { kind: 'task', id: 'source-task' },
      title: 'source-task title',
      contextRole: 'full',
      outputs: [],
      outputsTruncated: false,
    })
    expect(pack.inputs[0]).toHaveProperty('goalSummary')
    expect((pack.inputs[0] as { goalSummary: string }).goalSummary.length).toBe(1_000)
    expect(pack.inputs[0]).not.toHaveProperty('anchor')
    expect(pack.inputs[0]).not.toHaveProperty('origin')
  })

  it('expands only full Task outputs and bounds daemon-resolvable artifact identities', () => {
    const document = documentWithTarget()
    document.tasks.push(task('full-task'), task('summary-task'), task('late-full-task'))
    const firstOutput = node('full-output-a')
    firstOutput.homeTaskId = 'full-task'
    const secondOutput = node('full-output-b')
    secondOutput.homeTaskId = 'full-task'
    secondOutput.artifactRefs = [{
      runId: 'run-2',
      artifactId: `artifact_${'b'.repeat(64)}`,
    }]
    const summaryOutput = node('summary-output')
    summaryOutput.homeTaskId = 'summary-task'
    summaryOutput.artifactRefs = [{
      runId: 'run-3',
      artifactId: `artifact_${'c'.repeat(64)}`,
    }]
    const emptyOutputSlot = node('empty-output-slot')
    emptyOutputSlot.homeTaskId = 'full-task'
    emptyOutputSlot.artifactRefs = []
    const lateOutput = node('late-output')
    lateOutput.homeTaskId = 'late-full-task'
    document.nodes.push(firstOutput, secondOutput, summaryOutput, emptyOutputSlot, lateOutput)
    document.edges.push(
      edge(
        'edge-full-task',
        { kind: 'task', id: 'full-task' },
        { kind: 'task', id: 'target' },
        'full',
      ),
      edge(
        'edge-summary-task',
        { kind: 'task', id: 'summary-task' },
        { kind: 'task', id: 'target' },
        'summary',
      ),
      edge(
        'edge-late-full-task',
        { kind: 'task', id: 'late-full-task' },
        { kind: 'task', id: 'target' },
        'full',
      ),
    )

    const pack = compileTaskContext({
      document,
      taskId: 'target',
      limits: { maxTaskOutputs: 1, maxArtifactRefs: 1 },
    })
    const full = pack.inputs[0]
    const summary = pack.inputs[1]
    const lateFull = pack.inputs[2]

    expect(full).toMatchObject({
      kind: 'task',
      contextRole: 'full',
      outputsTruncated: true,
      outputs: [{
        ref: { kind: 'node', id: 'full-output-a' },
        artifactRefsTruncated: false,
      }],
    })
    expect(summary).toEqual({
      kind: 'task',
      ref: { kind: 'task', id: 'summary-task' },
      relation: 'source',
      contextRole: 'summary',
      title: 'summary-task title',
      goalSummary: 'summary-task goal',
    })
    expect(lateFull).toMatchObject({
      kind: 'task',
      contextRole: 'full',
      outputs: [],
      outputsTruncated: true,
    })
    expect(taskContextArtifactRefs(pack)).toEqual(firstOutput.artifactRefs)
    expect(JSON.stringify(pack)).not.toContain(summaryOutput.artifactRefs[0]!.artifactId)
    expect(JSON.stringify(pack)).not.toContain(emptyOutputSlot.id)
    expect(pack.truncated).toBe(true)
  })

  it('marks a full Node input when its unique artifact identities exceed the context budget', () => {
    const document = documentWithTarget()
    const source = node('source')
    source.artifactRefs.push({
      runId: 'run-2',
      artifactId: `artifact_${'b'.repeat(64)}`,
    })
    document.nodes.push(source)
    document.edges.push(edge(
      'edge-source',
      { kind: 'node', id: source.id },
      { kind: 'task', id: 'target' },
      'full',
    ))

    const pack = compileTaskContext({
      document,
      taskId: 'target',
      limits: { maxArtifactRefs: 1 },
    })

    expect(pack.inputs[0]).toMatchObject({
      kind: 'node',
      contextRole: 'full',
      artifactRefs: [source.artifactRefs[0]],
      artifactRefsTruncated: true,
    })
    expect(taskContextArtifactRefs(pack)).toHaveLength(1)
    expect(pack.truncated).toBe(true)
  })

  it('applies a pinned plugin policy to full and summary Node inputs with auditable receipts', () => {
    const document = documentWithTarget()
    const full = node('full-policy')
    full.text = 'abcdef'
    full.payload = { language: 'ts', secret: 'omit' }
    const summary = node('summary-policy')
    summary.text = 'summary-text'
    summary.payload = { language: 'py', secret: 'omit' }
    document.nodes.push(full, summary)
    document.edges.push(
      edge('full-policy-edge', { kind: 'node', id: full.id }, { kind: 'task', id: 'target' }, 'full'),
      edge(
        'summary-policy-edge',
        { kind: 'node', id: summary.id },
        { kind: 'task', id: 'target' },
        'summary',
      ),
    )

    const pack = compileTaskContext({
      document,
      taskId: 'target',
      nodeContextPolicies: [{
        id: 'code',
        nodeContext: {
          schemaVersion: NODE_CONTEXT_POLICY_SCHEMA_VERSION,
          summary: { textMaxChars: 4, payloadFields: ['language'] },
          full: { textMaxChars: 3, payloadFields: ['language'], artifactRefs: 'none' },
        },
      }],
    })

    expect(pack.schemaVersion).toBe(3)
    expect(pack.inputs[0]).toMatchObject({
      kind: 'node',
      contextRole: 'full',
      text: 'abc',
      payload: { language: 'ts' },
      artifactRefs: [],
      contextProjection: {
        policySource: 'plugin',
        text: { sourceChars: 6, includedChars: 3, truncated: true },
        payload: { includedFields: ['language'], omittedFields: 1 },
        artifactRefs: { source: 1, included: 0, omittedByPolicy: 1 },
      },
    })
    expect(pack.inputs[1]).toMatchObject({
      kind: 'node',
      contextRole: 'summary',
      textSummary: 'summ',
      payloadSummary: { language: 'py' },
      contextProjection: {
        policySource: 'plugin',
        artifactRefs: { source: 1, included: 0, omittedByPolicy: 1 },
      },
    })
    expect(taskContextArtifactRefs(pack)).toEqual([])
    expect(pack.truncated).toBe(true)
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

    const pack = compileTaskContext({ document, taskId: 'target' })

    expect(pack.inputs.map((input) => input.ref.id)).toEqual(['direct'])
    expect(pack.graph.entities.map((entity) => entity.ref.id)).toEqual([
      'target',
      'direct',
      'upstream',
    ])
    expect(JSON.stringify(pack)).not.toContain('unrelated')

    const bounded = compileTaskContext({
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

    const pack = compileTaskContext({ document, taskId: 'target' })

    expect(pack.inputs.map((input) => input.ref.id)).toEqual(['cycle-task'])
    expect(pack.graph.entities.map((entity) => entity.ref.id)).toEqual(['target', 'cycle-task'])
    expect(pack.graph.edges).toHaveLength(2)
    expect(pack.graph.truncated).toBe(false)
  })
})
