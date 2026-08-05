import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { canvasGitEntityFileName } from '../canvasGit.js'
import { emptyCanvasDocument } from '../canvasStore.js'
import type { CanvasDocumentV1, RunSummary } from '../protocol.js'
import { RunLogStore } from '../runLogs.js'
import { WorkspaceVersionManager } from '../workspaceVersioning.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ggai-checkpoint-metadata-'))
  temporaryDirectories.push(directory)
  return directory
}

function summary(): RunSummary {
  return {
    runId: 'run-good',
    nodeId: 'node-1',
    agentId: 'codex',
    canvasBranch: 'main',
    status: 'done',
    startedAt: 100,
    finishedAt: 200,
    sessionId: 'private-session',
    error: 'private tool failure details',
    logAvailable: true,
  }
}

function document(): CanvasDocumentV1 {
  return {
    ...emptyCanvasDocument(),
    everCreated: true,
    nodes: [{
      id: 'node-1',
      type: 'text',
      x: 0,
      y: 0,
      w: 320,
      h: 120,
      title: 'One',
      instruction: {
        phase: 'done',
        prompt: '',
        attachments: [],
        sources: [],
        open: false,
      },
      payload: {
        artifactFiles: [
          'artifacts/node-1/result.txt',
          '../outside.txt',
        ],
      },
    }, {
      id: 'node-2',
      type: 'text',
      x: 400,
      y: 0,
      w: 320,
      h: 120,
      title: 'Two',
      instruction: {
        phase: 'idle',
        prompt: '',
        attachments: [],
        sources: [],
        open: true,
      },
      payload: {},
    }],
    latestRunByNodeId: {
      'node-1': 'run-good',
      'node-2': 'run-missing',
    },
  }
}

test('workspace checkpoints persist sanitized metadata indexes without raw run logs', async () => {
  const projectDir = await temporaryProject()
  const runLogs = new RunLogStore(projectDir)
  await runLogs.start(summary())
  await runLogs.append('run-good', {
    id: 1,
    event: 'agent-event',
    data: { type: 'thinking', text: 'raw event text must stay outside Canvas Git' },
  })
  await runLogs.finish(summary())

  const versions = new WorkspaceVersionManager({ projectRoot: projectDir })
  try {
    await versions.saveCanvas('.', 'main', {
      baseRevision: 0,
      mutationId: 'metadata-save',
      changeKind: 'run-completed',
      document: document(),
    })
    const checkpoint = await versions.manualCheckpoint('.', 'main', 'metadata')
    assert.equal(checkpoint.ok, true)

    const repository = path.join(projectDir, '.gg', 'canvas-state')
    const runIndex = JSON.parse(await readFile(
      path.join(repository, 'runs', 'index.json'),
      'utf8',
    )) as Record<string, unknown>
    assert.deepEqual(runIndex, {
      version: 1,
      kind: 'run-summaries',
      referenced: 2,
      attempted: 2,
      included: 1,
      rejected: 1,
      complete: false,
      truncated: false,
    })

    const persistedRun = JSON.parse(await readFile(
      path.join(repository, 'runs', canvasGitEntityFileName('run-good')),
      'utf8',
    )) as Record<string, unknown>
    assert.equal(persistedRun.runId, 'run-good')
    assert.equal(persistedRun.canvasBranch, 'main')
    assert.equal('sessionId' in persistedRun, false)
    assert.equal('error' in persistedRun, false)

    const artifactIndex = JSON.parse(await readFile(
      path.join(repository, 'artifacts', 'index.json'),
      'utf8',
    )) as Record<string, unknown>
    assert.deepEqual(artifactIndex, {
      version: 1,
      kind: 'artifact-manifests',
      referencedNodes: 1,
      includedNodes: 1,
      referencedPaths: 1,
      includedPaths: 1,
      invalidPaths: 1,
      complete: false,
      truncated: false,
    })
    const manifest = JSON.parse(await readFile(
      path.join(repository, 'artifacts', canvasGitEntityFileName('node-1')),
      'utf8',
    )) as Record<string, unknown>
    assert.deepEqual(manifest.paths, ['artifacts/node-1/result.txt'])

    const gitRunFiles = await readdir(path.join(repository, 'runs'))
    assert.deepEqual(gitRunFiles.sort(), [
      'index.json',
      canvasGitEntityFileName('run-good'),
    ].sort())
    const gitRunText = await Promise.all(gitRunFiles.map((file) =>
      readFile(path.join(repository, 'runs', file), 'utf8')))
    assert.equal(gitRunText.some((text) => text.includes('raw event text')), false)
    assert.equal(gitRunText.some((text) => text.includes('private tool failure')), false)
  } finally {
    await versions.close()
  }
})
