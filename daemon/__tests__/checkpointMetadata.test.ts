import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCheckpointMetadata,
  type LoadedCheckpointRunSummary,
} from '../checkpointMetadata.js'
import type { CanvasDocumentV1, RunSummary } from '../protocol.js'

function document(): CanvasDocumentV1 {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'node-b',
        type: 'text',
        x: 0,
        y: 0,
        w: 320,
        h: 120,
        title: 'B',
        instruction: { phase: 'done', prompt: '', attachments: [], sources: [], open: false },
        payload: {
          artifactFiles: [
            'artifacts/node-b/z.txt',
            '../secret.txt',
            'artifacts/node-b/a.txt',
            'artifacts/node-b/a.txt',
            'artifacts/node-a/wrong-owner.txt',
          ],
        },
      },
      {
        id: 'node-a',
        type: 'text',
        x: 0,
        y: 0,
        w: 320,
        h: 120,
        title: 'A',
        instruction: { phase: 'idle', prompt: '', attachments: [], sources: [], open: true },
        payload: { artifactFiles: ['artifacts/node-a/result.txt'] },
      },
    ],
    edges: [],
    everCreated: true,
    generationByNodeId: {},
    latestRunByNodeId: {
      'node-a': 'run-a',
      'node-b': 'run-b',
    },
    runRefsByNodeId: {
      'node-a': { runId: 'run-a', lastEventId: 3, previousPhase: 'idle' },
    },
  }
}

function summary(runId: string, nodeId: string): RunSummary {
  return {
    runId,
    nodeId,
    agentId: 'codex',
    canvasBranch: 'main',
    status: 'done',
    startedAt: 100,
    finishedAt: 200,
    sessionId: 'sensitive-session-id',
    error: 'raw tool failure text must not enter Git',
    logAvailable: true,
  }
}

test('builds deterministic safe manifests and deduplicated sanitized run summaries', async () => {
  const requested: string[] = []
  const metadata = await buildCheckpointMetadata({
    projectDir: '/project',
    branch: 'main',
    document: document(),
    loadRunSummary: async ({ projectDir, runId }) => {
      requested.push(runId)
      return {
        projectDir,
        summary: summary(runId, runId === 'run-a' ? 'node-a' : 'node-b'),
      }
    },
  })

  assert.deepEqual(requested, ['run-a', 'run-b'])
  assert.deepEqual(metadata.artifacts, [{
    version: 1,
    nodeId: 'node-a',
    paths: ['artifacts/node-a/result.txt'],
    totalSafePaths: 1,
    truncated: false,
  }, {
    version: 1,
    nodeId: 'node-b',
    paths: ['artifacts/node-b/a.txt', 'artifacts/node-b/z.txt'],
    totalSafePaths: 2,
    truncated: false,
  }])
  assert.deepEqual(metadata.artifactIndex, {
    version: 1,
    kind: 'artifact-manifests',
    referencedNodes: 2,
    includedNodes: 2,
    referencedPaths: 3,
    includedPaths: 3,
    invalidPaths: 2,
    complete: false,
    truncated: false,
  })
  assert.deepEqual(metadata.runIndex, {
    version: 1,
    kind: 'run-summaries',
    referenced: 2,
    attempted: 2,
    included: 2,
    rejected: 0,
    complete: true,
    truncated: false,
  })
  assert.equal('sessionId' in metadata.runs[0]!, false)
  assert.equal('error' in metadata.runs[0]!, false)
  assert.deepEqual(metadata.runs.map((run) => run.runId), ['run-a', 'run-b'])
})

test('accepts only matching project, branch, node, and run while normalizing legacy main', async () => {
  const candidates = new Map<string, LoadedCheckpointRunSummary | null>([
    ['run-a', {
      projectDir: '/project',
      summary: { ...summary('run-a', 'node-a'), canvasBranch: undefined },
    }],
    ['run-b', {
      projectDir: '/other-project',
      summary: summary('run-b', 'node-b'),
    }],
  ])
  const metadata = await buildCheckpointMetadata({
    projectDir: '/project',
    branch: 'main',
    document: document(),
    loadRunSummary: async ({ runId }) => candidates.get(runId) ?? null,
  })

  assert.deepEqual(metadata.runs.map((run) => ({
    runId: run.runId,
    canvasBranch: run.canvasBranch,
  })), [{ runId: 'run-a', canvasBranch: 'main' }])
  assert.deepEqual(metadata.runIndex, {
    version: 1,
    kind: 'run-summaries',
    referenced: 2,
    attempted: 2,
    included: 1,
    rejected: 1,
    complete: false,
    truncated: false,
  })
})

test('bounds loader concurrency and marks run/artifact truncation explicitly', async () => {
  const subject = document()
  subject.latestRunByNodeId = {
    'node-a': 'run-c',
    'node-b': 'run-a',
  }
  subject.runRefsByNodeId = {
    'node-a': { runId: 'run-b', lastEventId: 0, previousPhase: 'idle' },
  }
  subject.nodes[0]!.payload = {
    artifactFiles: [
      'artifacts/node-b/a.txt',
      'artifacts/node-b/b.txt',
      'artifacts/node-b/c.txt',
    ],
  }

  let active = 0
  let peak = 0
  const loaded: string[] = []
  const metadata = await buildCheckpointMetadata({
    projectDir: '/project',
    branch: 'main',
    document: subject,
    limits: {
      maxReferencedRuns: 2,
      runLoadConcurrency: 1,
      maxArtifactPathsPerNode: 2,
      maxArtifactPaths: 2,
      maxArtifactPathBytes: 1_000,
    },
    loadRunSummary: async ({ projectDir, runId }) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      loaded.push(runId)
      active -= 1
      const nodeId = runId === 'run-a' ? 'node-b' : 'node-a'
      return { projectDir, summary: summary(runId, nodeId) }
    },
  })

  assert.equal(peak, 1)
  assert.deepEqual(loaded, ['run-a', 'run-b'])
  assert.deepEqual(metadata.runIndex, {
    version: 1,
    kind: 'run-summaries',
    referenced: 3,
    attempted: 2,
    included: 2,
    rejected: 0,
    complete: false,
    truncated: true,
  })
  assert.equal(metadata.artifactIndex.referencedPaths, 4)
  assert.equal(metadata.artifactIndex.includedPaths, 2)
  assert.equal(metadata.artifactIndex.complete, false)
  assert.equal(metadata.artifactIndex.truncated, true)
  assert.equal(metadata.artifacts.some((manifest) => manifest.truncated), true)
})

test('loader failures degrade metadata completeness without rejecting the checkpoint build', async () => {
  const metadata = await buildCheckpointMetadata({
    projectDir: '/project',
    branch: 'main',
    document: document(),
    loadRunSummary: async ({ runId }) => {
      if (runId === 'run-a') throw new Error('corrupt summary')
      return null
    },
  })

  assert.deepEqual(metadata.runs, [])
  assert.equal(metadata.runIndex.rejected, 2)
  assert.equal(metadata.runIndex.complete, false)
  assert.equal(metadata.runIndex.truncated, false)
})
