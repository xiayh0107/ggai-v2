import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artifactIdForManifest,
  artifactManifestDigest,
  artifactProjectPath,
  buildArtifactManifest,
  inspectArtifactManifest,
  type ArtifactManifestFileCandidate,
} from '../artifactManifest.js'
import {
  buildProjectionPlan,
  inspectProjectionPluginContracts,
  inspectProjectionPlan,
  MAX_ARTIFACT_RULES_PER_PLUGIN,
  MAX_AUTO_MATERIALIZED_OUTPUTS,
  type ProjectionPluginContract,
  type ProjectionRunStatus,
} from '../projectionPlan.js'
import {
  inspectRunOutcome,
  MAX_RUN_OUTPUT_HINTS,
  MAX_RUN_TASK_PROPOSALS,
} from '../../src/agent/outcome.js'
import { BUILTIN_PROJECTION_PLUGIN_CONTRACTS } from '../projectionPlugins.js'

const branchHash = 'a'.repeat(64)
const contentDigest = 'c'.repeat(64)

function actions() {
  return [
    { id: 'explain', label: 'Explain result', prompt: 'Explain the generated result.' },
    { id: 'revise', label: 'Revise result', prompt: 'Revise the generated result.' },
  ]
}

function file(
  relativePath: string,
  mediaType = 'application/octet-stream',
  ownerRunId = 'run-1',
  overrides: Partial<ArtifactManifestFileCandidate> = {},
): ArtifactManifestFileCandidate {
  return {
    ownerRunId,
    relativePath,
    kind: 'file',
    temporary: false,
    mediaType,
    size: 100,
    contentDigest,
    ...overrides,
  }
}

function manifest(complete = true) {
  return buildArtifactManifest({
    runId: 'run-1',
    complete,
    files: [
      file('preview.png', 'image/png', 'run-1', { size: 2_048 }),
      file('source/plot.R', 'text/plain', 'run-1', { size: 512 }),
      file('notes.bin', 'application/octet-stream', 'run-1', { size: 16 }),
    ],
  })
}

function plugins(): ProjectionPluginContract[] {
  return [
    {
      id: 'code',
      artifactRules: [{ extensions: ['.r'], mediaTypes: ['text/x-r'], priority: 10 }],
    },
    {
      id: 'image',
      artifactRules: [{ extensions: ['.png'], mediaTypes: ['image/*'], priority: 10 }],
    },
    { id: 'file', artifactRules: [], acceptsUnknown: true },
  ]
}

function validOutcome() {
  return {
    schemaVersion: 2,
    suggestedActions: actions(),
    outputs: [
      {
        key: 'source',
        path: 'source/plot.R',
        pluginId: 'code',
        role: 'primary',
        title: 'plot.R',
      },
      {
        key: 'preview',
        path: 'preview.png',
        pluginId: 'image',
        role: 'primary',
        derivedFrom: ['source'],
      },
    ],
    taskProposals: [
      {
        key: 'annotate',
        title: 'Annotate the plot',
        prompt: 'Add labels to important points.',
        inputOutputKeys: ['preview'],
        dependsOn: [],
      },
      {
        key: 'publish',
        title: 'Publish the plot',
        prompt: 'Prepare the annotated plot for publication.',
        inputOutputKeys: ['preview'],
        dependsOn: ['annotate'],
      },
    ],
  }
}

test('RunOutcome permits empty actions and multiple primary outputs with bounded DAGs', () => {
  const valid = { ...validOutcome(), suggestedActions: [] }
  const inspected = inspectRunOutcome(valid)
  assert.equal(inspected.status, 'valid')
  if (inspected.status === 'valid') {
    assert.deepEqual(inspected.outcome.suggestedActions, [])
    assert.deepEqual(inspected.outcome.outputs.map((output) => output.role), [
      'primary',
      'primary',
    ])
    assert.deepEqual(inspected.outcome.outputs[0]?.derivedFrom, [])
    assert.deepEqual(inspected.outcome.taskProposals[0]?.dependsOn, [])
    assert.deepEqual(inspected.outcome.taskProposals[0]?.inputOutputKeys, ['preview'])
  }

  const optionalDependencies = validOutcome()
  delete (optionalDependencies.taskProposals[0] as { dependsOn?: string[] }).dependsOn
  const optionalInspection = inspectRunOutcome(optionalDependencies)
  assert.equal(optionalInspection.status, 'valid')
  if (optionalInspection.status === 'valid') {
    assert.deepEqual(optionalInspection.outcome.taskProposals[0]?.dependsOn, [])
  }

  assert.equal(inspectRunOutcome({
    ...valid,
    outputs: [
      { key: 'a', path: 'a.txt', pluginId: 'file', role: 'primary', derivedFrom: ['b'] },
      { key: 'b', path: 'b.txt', pluginId: 'file', role: 'primary', derivedFrom: ['a'] },
    ],
  }).status, 'invalid')
  assert.equal(inspectRunOutcome({
    ...valid,
    taskProposals: [
      { key: 'a', title: 'A', prompt: 'Task A', inputOutputKeys: [], dependsOn: ['b'] },
      { key: 'b', title: 'B', prompt: 'Task B', inputOutputKeys: [], dependsOn: ['a'] },
    ],
  }).status, 'invalid')
  assert.equal(inspectRunOutcome({
    ...valid,
    outputs: [{
      key: 'too-many-parents',
      path: 'result.txt',
      pluginId: 'file',
      role: 'supporting',
      derivedFrom: Array.from({ length: 9 }, (_, index) => `parent-${index}`),
    }],
  }).status, 'invalid')
  assert.equal(inspectRunOutcome({
    ...valid,
    suggestedActions: Array.from({ length: 6 }, (_, index) => ({
      id: `action-${index}`,
      label: `Action ${index}`,
      prompt: `Do action ${index}.`,
    })),
  }).status, 'invalid')
  assert.equal(inspectRunOutcome({
    ...valid,
    outputs: Array.from({ length: MAX_RUN_OUTPUT_HINTS + 1 }, (_, index) => ({
      key: `output-${index}`,
      path: `output-${index}.txt`,
      pluginId: 'file',
      role: 'supporting',
    })),
  }).status, 'invalid')
  assert.equal(inspectRunOutcome({
    ...valid,
    taskProposals: Array.from({ length: MAX_RUN_TASK_PROPOSALS + 1 }, (_, index) => ({
      key: `task-${index}`,
      title: `Task ${index}`,
      prompt: `Perform task ${index}.`,
      inputOutputKeys: [],
      dependsOn: [],
    })),
  }).status, 'invalid')
})

test('RunOutcome rejects Agent-authored authority, layout, payload, edge, and command fields', () => {
  const rootFields = [
    'runId',
    'taskId',
    'nodeId',
    'collectionId',
    'x',
    'payload',
    'edges',
    'command',
    'autoRun',
    'materialize',
  ]
  for (const field of rootFields) {
    assert.equal(inspectRunOutcome({ ...validOutcome(), [field]: 'forbidden' }).status, 'invalid')
  }

  for (const field of [
    'id',
    'nodeId',
    'x',
    'y',
    'payload',
    'edge',
    'command',
    'autoRun',
    'materialize',
  ]) {
    const outcome = validOutcome()
    outcome.outputs[0] = { ...outcome.outputs[0], [field]: 'forbidden' }
    assert.equal(inspectRunOutcome(outcome).status, 'invalid')
  }

  for (const field of [
    'id',
    'taskId',
    'collectionId',
    'x',
    'payload',
    'edge',
    'command',
    'autoRun',
  ]) {
    const outcome = validOutcome()
    outcome.taskProposals[0] = { ...outcome.taskProposals[0], [field]: 'forbidden' }
    assert.equal(inspectRunOutcome(outcome).status, 'invalid')
  }
})

test('plugin projection claims are strict serializable data and fallback ranking is deterministic', () => {
  const inspection = inspectProjectionPluginContracts([{
    id: 'image',
    artifactRules: [{ extensions: ['.png'], mediaTypes: ['image/*'], priority: 0 }],
    acceptsUnknown: false,
  }])
  assert.equal(inspection.status, 'valid')
  if (inspection.status === 'valid') {
    assert.deepEqual(inspection.plugins, [{
      id: 'image',
      artifactRules: [{ extensions: ['.png'], mediaTypes: ['image/*'] }],
    }])
  }

  assert.equal(inspectProjectionPluginContracts([{
    id: 'image',
    artifactRules: [{ extensions: ['.png'] }],
    materializer: () => undefined,
  }]).status, 'invalid')
  assert.equal(inspectProjectionPluginContracts([{
    id: 'image',
    artifactRules: [{ extensions: ['.PNG'] }],
  }]).status, 'invalid')
  assert.equal(inspectProjectionPluginContracts([
    { id: 'image', artifactRules: [{ extensions: ['.png'] }] },
    { id: 'image', artifactRules: [{ extensions: ['.jpg'] }] },
  ]).status, 'invalid')
  assert.equal(inspectProjectionPluginContracts([{
    id: 'image',
    artifactRules: Array.from(
      { length: MAX_ARTIFACT_RULES_PER_PLUGIN + 1 },
      () => ({ extensions: ['.png'] }),
    ),
  }]).status, 'invalid')

  const fallbackManifest = buildArtifactManifest({
    runId: 'run-fallback',
    complete: true,
    files: [file('preview.png', 'image/png', 'run-fallback')],
  })
  const first = buildProjectionPlan({
    taskId: 'task-fallback',
    runId: 'run-fallback',
    runStatus: 'done',
    manifest: fallbackManifest,
    plugins: [
      { id: 'z-image', artifactRules: [{ mediaTypes: ['image/*'], priority: 10 }] },
      { id: 'generic', artifactRules: [], acceptsUnknown: true },
      { id: 'a-image', artifactRules: [{ extensions: ['.png'], priority: 10 }] },
    ],
  })
  const second = buildProjectionPlan({
    taskId: 'task-fallback',
    runId: 'run-fallback',
    runStatus: 'done',
    manifest: fallbackManifest,
    plugins: [
      { id: 'a-image', artifactRules: [{ extensions: ['.png'], priority: 10 }] },
      { id: 'generic', artifactRules: [], acceptsUnknown: true },
      { id: 'z-image', artifactRules: [{ mediaTypes: ['image/*'], priority: 10 }] },
    ],
  })
  assert.equal(first.plan.outputs[0]?.pluginId, 'a-image')
  assert.equal(first.plan.digest, second.plan.digest)
})

test('built-in projection claims are serializable, include R, and retain a generic fallback', () => {
  const inspection = inspectProjectionPluginContracts(
    structuredClone(BUILTIN_PROJECTION_PLUGIN_CONTRACTS),
  )
  assert.equal(inspection.status, 'valid')
  if (inspection.status !== 'valid') return
  const code = inspection.plugins.find((plugin) => plugin.id === 'code')
  const generic = inspection.plugins.find((plugin) => plugin.id === 'file')
  assert.ok(code?.artifactRules.some((rule) => rule.extensions?.includes('.r')))
  assert.equal(generic?.acceptsUnknown, true)
  assert.equal(JSON.parse(JSON.stringify(inspection.plugins)).length, 6)
})

test('built-in claim priority normalizes uppercase extensions and preserves unknown files', () => {
  const runId = 'run-built-in-routing'
  const routingManifest = buildArtifactManifest({
    runId,
    complete: true,
    files: [
      file('source/analysis.R', 'text/plain', runId),
      file('opaque.custom', 'application/octet-stream', runId),
    ],
  })
  const result = buildProjectionPlan({
    taskId: 'task-built-in-routing',
    runId,
    runStatus: 'done',
    manifest: routingManifest,
    plugins: BUILTIN_PROJECTION_PLUGIN_CONTRACTS,
  })
  const pluginByTitle = new Map(result.plan.outputs.map((output) => [output.title, output.pluginId]))

  assert.equal(pluginByTitle.get('analysis.R'), 'code')
  assert.equal(pluginByTitle.get('opaque.custom'), 'file')
  assert.equal(result.diagnostics.length, 0)
})

test('different outputs may safely share one verified artifact reference', () => {
  const sharedManifest = buildArtifactManifest({
    runId: 'run-shared',
    complete: true,
    files: [file('preview.png', 'image/png', 'run-shared')],
  })
  const sharedOutcome = {
    schemaVersion: 2,
    suggestedActions: [],
    outputs: [
      { key: 'preview', path: 'preview.png', pluginId: 'image', role: 'primary' },
      { key: 'thumbnail', path: 'preview.png', pluginId: 'thumbnail', role: 'supporting' },
    ],
    taskProposals: [],
  }
  assert.equal(inspectRunOutcome(sharedOutcome).status, 'valid')

  const result = buildProjectionPlan({
    taskId: 'task-shared',
    runId: 'run-shared',
    runStatus: 'done',
    manifest: sharedManifest,
    plugins: [
      { id: 'image', artifactRules: [{ extensions: ['.png'] }] },
      { id: 'thumbnail', artifactRules: [{ mediaTypes: ['image/*'] }] },
      { id: 'file', artifactRules: [], acceptsUnknown: true },
    ],
    outcome: sharedOutcome,
  })

  assert.equal(result.usedFallback, false)
  assert.equal(result.plan.outputs.length, 2)
  assert.equal(
    result.plan.outputs[0]?.artifactRefs[0]?.artifactId,
    result.plan.outputs[1]?.artifactRefs[0]?.artifactId,
  )
  assert.equal(inspectProjectionPlan(result.plan).status, 'valid')
})

test('a run-fixed custom Node claim materializes without granting Agent Canvas authority', () => {
  const runId = 'run-custom-node'
  const customPluginId = '@local/research-card@4'
  const customManifest = buildArtifactManifest({
    runId,
    complete: true,
    files: [file('research.md', 'text/markdown', runId)],
  })
  const result = buildProjectionPlan({
    taskId: 'task-custom-node',
    runId,
    runStatus: 'done',
    manifest: customManifest,
    plugins: [
      { id: customPluginId, artifactRules: [{ extensions: ['.md'], mediaTypes: ['text/*'] }] },
      { id: 'file', artifactRules: [], acceptsUnknown: true },
    ],
    outcome: {
      schemaVersion: 2,
      suggestedActions: [],
      outputs: [{
        key: 'research-card',
        path: 'research.md',
        pluginId: customPluginId,
        role: 'primary',
      }],
      taskProposals: [],
    },
  })

  assert.equal(result.usedFallback, false)
  assert.equal(result.plan.outputs[0]?.pluginId, customPluginId)
  assert.equal(result.plan.outputs[0]?.materialize, true)
  assert.equal('nodeId' in result.plan.outputs[0]!, false)
  assert.equal('frame' in result.plan.outputs[0]!, false)
  assert.equal('payload' in result.plan.outputs[0]!, false)
  assert.equal(inspectProjectionPlan(result.plan).status, 'valid')
})

test('ArtifactManifest has canonical runRoot/files semantics and excludes unsafe sources', () => {
  const subject = buildArtifactManifest({
    runId: 'run-1',
    complete: true,
    files: [
      file('keep.png', 'image/png'),
      file('.ggai/run-result.json', 'application/json'),
      file('linked.png', 'image/png', 'run-1', { kind: 'symbolic-link' }),
      file('scratch.tmp', 'text/plain'),
      file('foreign.png', 'image/png', 'run-2'),
      file('flagged.txt', 'text/plain', 'run-1', { temporary: true }),
    ],
  })

  assert.equal(subject.version, 1)
  assert.deepEqual(Object.keys(subject).sort(), ['complete', 'entries', 'runId', 'version'])
  assert.deepEqual(subject.entries.map((entry) => entry.relativePath), ['keep.png'])
  assert.deepEqual(Object.keys(subject.entries[0] ?? {}).sort(), [
    'artifactId',
    'contentDigest',
    'mediaType',
    'relativePath',
    'size',
  ])
  assert.equal(subject.entries[0]?.artifactId, artifactIdForManifest('run-1', 'keep.png'))
  assert.equal(
    artifactProjectPath(
      `artifacts/.branches/${branchHash}/run-1/files`,
      subject.entries[0]!,
    ),
    `artifacts/.branches/${branchHash}/run-1/files/keep.png`,
  )
  assert.match(artifactManifestDigest(subject), /^[0-9a-f]{64}$/u)
  assert.equal(inspectArtifactManifest(subject).status, 'valid')

  const tampered = structuredClone(subject)
  const originalDigest = artifactManifestDigest(subject)
  tampered.entries[0]!.contentDigest = 'd'.repeat(64)
  assert.equal(inspectArtifactManifest(tampered).status, 'valid')
  assert.notEqual(artifactManifestDigest(tampered), originalDigest)

  assert.throws(() => buildArtifactManifest({
    runId: 'run-1',
    complete: true,
    files: [file('../escape.txt', 'text/plain')],
  }), /unsafe/u)
})

test('ProjectionPlan is task/run-owned and intersects hints with manifest and plugin contracts', () => {
  const outcome = {
    ...validOutcome(),
    outputs: [
      ...validOutcome().outputs,
      {
        key: 'missing',
        path: 'not-created.png',
        pluginId: 'image',
        role: 'supporting',
      },
    ],
  }
  const first = buildProjectionPlan({
    taskId: 'task-1',
    runId: 'run-1',
    runStatus: 'done',
    manifest: manifest(),
    plugins: plugins(),
    outcome,
  })
  const second = buildProjectionPlan({
    taskId: 'task-1',
    runId: 'run-1',
    runStatus: 'done',
    manifest: manifest(),
    plugins: plugins(),
    outcome,
  })

  assert.equal(first.plan.taskId, 'task-1')
  assert.equal(first.plan.runId, 'run-1')
  assert.equal(first.plan.planId, second.plan.planId)
  assert.equal(first.plan.digest, second.plan.digest)
  assert.equal(first.plan.status, 'complete')
  assert.equal('anchorNodeId' in first.plan, false)
  assert.equal('collectionId' in first.plan, false)
  assert.equal(first.usedFallback, true)
  assert.equal(first.plan.outputs.filter((output) => output.role === 'primary').length, 2)
  assert.deepEqual(first.plan.outputs[1]?.derivedFrom, ['source'])
  assert.deepEqual(first.plan.outputs[0]?.artifactRefs[0], {
    runId: 'run-1',
    artifactId: manifest().entries.find((entry) =>
      entry.relativePath === 'source/plot.R')?.artifactId,
  })
  assert.deepEqual(first.plan.taskProposals, [
    {
      key: 'annotate',
      title: 'Annotate the plot',
      prompt: 'Add labels to important points.',
      inputOutputKeys: ['preview'],
      dependsOn: [],
    },
    {
      key: 'publish',
      title: 'Publish the plot',
      prompt: 'Prepare the annotated plot for publication.',
      inputOutputKeys: ['preview'],
      dependsOn: ['annotate'],
    },
  ])
  assert.ok(first.diagnostics.some((entry) => entry.code === 'missing-artifact'))
  assert.equal(inspectProjectionPlan(first.plan).status, 'valid')

  const tampered = structuredClone(first.plan)
  tampered.outputs[0]!.artifactRefs[0]!.runId = 'run-foreign'
  assert.equal(inspectProjectionPlan(tampered).status, 'invalid')

  assert.throws(() => buildProjectionPlan({
    taskId: 'task-1',
    runId: 'run-foreign',
    runStatus: 'done',
    manifest: manifest(),
    plugins: plugins(),
    outcome,
  }), /foreign run/u)
})

test('ProjectionPlan bounds automatic materialization while permitting multiple primary outputs', () => {
  const count = MAX_AUTO_MATERIALIZED_OUTPUTS + 3
  const manyManifest = buildArtifactManifest({
    runId: 'run-many',
    complete: true,
    files: Array.from({ length: count }, (_, index) =>
      file(`result-${index}.png`, 'image/png', 'run-many')),
  })
  const result = buildProjectionPlan({
    taskId: 'task-many',
    runId: 'run-many',
    runStatus: 'done',
    manifest: manyManifest,
    plugins: plugins(),
    outcome: {
      schemaVersion: 2,
      suggestedActions: [],
      outputs: Array.from({ length: count }, (_, index) => ({
        key: `result-${index}`,
        path: `result-${index}.png`,
        pluginId: 'image',
        role: index < 9 ? 'primary' : 'supporting',
      })),
      taskProposals: [],
    },
  })

  assert.equal(result.plan.outputs.filter((output) => output.role === 'primary').length, 9)
  assert.equal(
    result.plan.outputs.filter((output) => output.materialize).length,
    MAX_AUTO_MATERIALIZED_OUTPUTS,
  )
  assert.ok(result.plan.outputs
    .filter((output) => output.role === 'primary')
    .every((output) => output.materialize))
  assert.equal(
    result.plan.outputs.filter((output) =>
      output.role === 'supporting' && output.materialize).length,
    MAX_AUTO_MATERIALIZED_OUTPUTS - 9,
  )
  assert.equal(inspectProjectionPlan(result.plan).status, 'valid')
})

test('error, cancelled, and interrupted runs discard proposals and still produce partial plans', () => {
  for (const runStatus of ['error', 'cancelled', 'interrupted'] as ProjectionRunStatus[]) {
    const result = buildProjectionPlan({
      taskId: 'task-1',
      runId: 'run-1',
      runStatus,
      manifest: manifest(),
      plugins: plugins(),
      outcome: validOutcome(),
    })
    assert.equal(result.plan.status, 'partial')
    assert.ok(result.plan.outputs.length > 0)
    assert.deepEqual(result.plan.taskProposals, [])
    assert.deepEqual(result.suggestedActions, [])
    assert.ok(result.diagnostics.some((entry) => entry.code === 'discarded-proposals'))
    assert.equal(inspectProjectionPlan(result.plan).status, 'valid')
  }

  const incomplete = buildProjectionPlan({
    taskId: 'task-1',
    runId: 'run-1',
    runStatus: 'done',
    manifest: manifest(false),
    plugins: plugins(),
    outcome: validOutcome(),
  })
  assert.equal(incomplete.plan.status, 'partial')
  assert.deepEqual(incomplete.plan.taskProposals, [])
  assert.deepEqual(incomplete.suggestedActions, [])
})

test('invalid Agent authority fields fall back without entering the trusted plan', () => {
  const result = buildProjectionPlan({
    taskId: 'task-1',
    runId: 'run-1',
    runStatus: 'done',
    manifest: manifest(),
    plugins: plugins(),
    outcome: { ...validOutcome(), runId: 'agent-selected-run' },
  })

  assert.ok(result.diagnostics.some((entry) => entry.code === 'invalid-outcome'))
  assert.equal(result.usedFallback, true)
  assert.ok(result.plan.outputs.every((output) => output.key.startsWith('artifact-')))
  assert.deepEqual(result.plan.taskProposals, [])
  assert.equal('runId' in (result.plan.taskProposals[0] ?? {}), false)
  assert.equal(inspectProjectionPlan(result.plan).status, 'valid')
})
