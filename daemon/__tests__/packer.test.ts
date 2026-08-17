import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CanvasDocument } from '../../src/canvas/model.js'
import { listArtifactSnapshot, prepareRunContext } from '../packer.js'
import { RunArtifactStore } from '../runArtifactStorage.js'
import { BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT } from '../pluginCapabilities.js'
import {
  resolvedTaskSkillCapabilityDigest,
  type ResolvedTaskSkill,
  type ResolvedTaskRunRequest,
} from '../taskRunTypes.js'

test('Task Run packs bounded full-edge outputs with daemon-verified artifact paths', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-packer-task-v2-'))
  const root = await realpath(temporaryRoot)
  const artifactId = `artifact_${'a'.repeat(64)}`
  const digest = 'b'.repeat(64)
  const document: CanvasDocument = {
    schemaVersion: 3,
    nodes: [{
      id: 'node-prior-output',
      typeRef: { id: 'image', revision: 1, digest: '0000000000000000000000000000000000000000000000000000000000000000' },
      parentId: null,
      orderKey: (1).toString(36).padStart(12, '0'),
      bounds: { w: 320, h: 240 },
      transform: { matrix: [1, 0, 0, 1, 20, 20] },
      title: 'Prior plot',
      text: 'User-selected plot notes',
      payload: { palette: 'viridis' },
      artifactRefs: [{ runId: 'run-prior', artifactId }],
      homeTaskId: 'task-prior',
      origin: { kind: 'user' },
    }],
    tasks: [{
      id: 'task-prior',
      title: 'Prior task',
      goal: 'Create the original plot',
      anchor: { x: 20, y: 20 },
      origin: { kind: 'user' },
    }, {
      id: 'task-derived',
      title: 'Derived task',
      goal: 'Adjust the plot colors',
      anchor: { x: 500, y: 20 },
      origin: { kind: 'user' },
    }],
    collections: [],
    edges: [{
      id: 'edge-prior-derived',
      from: { kind: 'task', id: 'task-prior' },
      to: { kind: 'task', id: 'task-derived' },
      relation: 'source',
      contextRole: 'full',
      origin: { kind: 'user' },
    }],
    receipts: [],
    everCreated: true,
  }
  const verifiedPath = 'artifacts/.branches/main/run-prior/files/prior.png'
  const skillMarkdown = Buffer.from('# Image direction\n\nUse a restrained visual hierarchy.\n')
  const skillFileDigest = createHash('sha256').update(skillMarkdown).digest('hex')
  const skillDigest = createHash('sha256')
    .update('ggai.skill-asset.v1\0', 'utf8')
    .update(`${Buffer.byteLength('SKILL.md', 'utf8')}:SKILL.md:${skillMarkdown.byteLength}:`, 'utf8')
    .update(skillMarkdown)
    .digest('hex')
  const resolvedSkills: ResolvedTaskSkill[] = [{
    ref: { skillId: '@workspace/image-direction', revision: 2, digest: skillDigest },
    title: 'Image direction',
    description: 'Use the project image direction.',
    entrypoint: 'SKILL.md',
    files: [{
      relativePath: 'SKILL.md',
      size: skillMarkdown.byteLength,
      digest: skillFileDigest,
      contentBase64: skillMarkdown.toString('base64'),
    }],
    sources: [{ kind: 'node', nodeId: 'node-prior-output', nodeType: 'image', role: 'attachment' }],
  }]
  const input: ResolvedTaskRunRequest = {
    schemaVersion: 2,
    runId: 'run-derived',
    taskId: 'task-derived',
    agentId: 'codex',
    canvasBranch: 'main',
    baseRevision: 7,
    prompt: 'Adjust the plot colors',
    attachments: [],
    materializationPolicy: 'auto',
    projectDir: '.',
    canvasDocument: document,
    resolvedArtifactAttachments: [{
      runId: 'run-prior',
      artifactId,
      projectRelativePath: verifiedPath,
      mediaType: 'image/png',
      size: 42,
      contentDigest: digest,
    }],
    resolvedNodeAttachments: [{
      id: 'node-prior-output',
      title: 'Prior plot',
      type: 'image',
      text: 'User-selected plot notes',
      artifactRefs: [{ runId: 'run-prior', artifactId }],
      contextProjection: {
        policySource: 'plugin',
        text: { sourceChars: 24, includedChars: 24, truncated: false },
        payload: { sourceFields: 1, includedFields: [], omittedFields: 1 },
        artifactRefs: {
          source: 1,
          included: 1,
          omittedByPolicy: 0,
          omittedByBudget: 0,
        },
      },
      truncation: { text: false, payload: false },
    }],
    pluginCapabilities: BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
    resolvedSkills,
    skillCapabilityDigest: resolvedTaskSkillCapabilityDigest(resolvedSkills),
    skillResolverCapabilityDigest: 'a'.repeat(64),
    skillResolverProvider: '@ggai/test-skill-resolver',
    automationMode: 'confirm',
  }

  try {
    const prepared = await prepareRunContext(input, root, input.runId)
    const rendered = await readFile(prepared.contextFile, 'utf8')
    const json = JSON.parse(await readFile(
      path.join(root, '.gg', 'context', 'runs', input.runId, 'pack.json'),
      'utf8',
    )) as {
      inputs: Array<{ outputs?: Array<{ artifactRefs: unknown[] }> }>
      explicitNodeAttachments: {
        canvasRevision: number
        nodes: Array<{
          id: string
          text?: string
          payload?: Record<string, unknown>
          artifactRefs: unknown[]
          contextProjection: unknown
          truncation: { text: boolean; payload: boolean }
        }>
      }
      verifiedArtifactAttachments: Array<{ projectRelativePath: string; contentDigest: string }>
      pluginCapabilities: { digest: string; plugins: Array<{ pluginId: string }> }
      skillCapabilities: { digest: string; skills: Array<{ title: string; directory: string }> }
    }

    assert.deepEqual(json.inputs[0]?.outputs?.[0]?.artifactRefs, [{
      runId: 'run-prior',
      artifactId,
    }])
    assert.deepEqual(json.explicitNodeAttachments, {
      canvasRevision: 7,
      nodes: [{
        id: 'node-prior-output',
        title: 'Prior plot',
        type: 'image',
        text: 'User-selected plot notes',
        artifactRefs: [{ runId: 'run-prior', artifactId }],
        contextProjection: {
          policySource: 'plugin',
          text: { sourceChars: 24, includedChars: 24, truncated: false },
          payload: { sourceFields: 1, includedFields: [], omittedFields: 1 },
          artifactRefs: {
            source: 1,
            included: 1,
            omittedByPolicy: 0,
            omittedByBudget: 0,
          },
        },
        truncation: { text: false, payload: false },
      }],
    })
    assert.deepEqual(json.verifiedArtifactAttachments, [{
      runId: 'run-prior',
      artifactId,
      projectRelativePath: verifiedPath,
      mediaType: 'image/png',
      size: 42,
      contentDigest: digest,
    }])
    assert.equal(
      json.pluginCapabilities.digest,
      BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT.digest,
    )
    assert.ok(json.pluginCapabilities.plugins.some(({ pluginId }) => pluginId === 'file'))
    assert.match(rendered, /Fixed plugin capabilities for this run/u)
    assert.match(rendered, /Explicit node attachments for this run/u)
    assert.match(rendered, /persisted Canvas revision 7/u)
    assert.match(rendered, /User-selected plot notes/u)
    assert.match(rendered, new RegExp(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT.digest, 'u'))
    assert.match(rendered, /Verified read-only artifact attachments/u)
    assert.match(rendered, new RegExp(artifactId, 'u'))
    assert.match(rendered, new RegExp(verifiedPath.replaceAll('.', '\\.'), 'u'))
    assert.match(rendered, /Node-bound skills authorized for this run/u)
    assert.match(rendered, /Image direction/u)
    assert.equal(json.skillCapabilities.skills[0]?.title, 'Image direction')
    assert.equal(
      await readFile(path.join(
        root,
        '.gg',
        'context',
        'runs',
        input.runId,
        'skills',
        json.skillCapabilities.skills[0]?.directory ?? '',
        'SKILL.md',
      ), 'utf8'),
      skillMarkdown.toString('utf8'),
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('terminal artifact snapshots exclude private .ggai control metadata', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-packer-control-')))
  try {
    const artifactDir = (await new RunArtifactStore(root, 'main').prepareRun('run-control'))
      .absoluteFilesRoot
    await mkdir(path.join(artifactDir, '.ggai'), { recursive: true })
    await Promise.all([
      writeFile(path.join(artifactDir, 'output.txt'), 'deliverable\n', 'utf8'),
      writeFile(path.join(artifactDir, '.ggai', 'run-result.json'), '{}\n', 'utf8'),
    ])

    assert.deepEqual(
      await listArtifactSnapshot(root, 'node-control', {
        canvasBranch: 'main',
        runId: 'run-control',
      }),
      {
        files: [path.relative(root, path.join(artifactDir, 'output.txt')).split(path.sep).join('/')],
        complete: true,
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
