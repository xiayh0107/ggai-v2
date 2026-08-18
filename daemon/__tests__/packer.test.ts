import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CanvasDocument } from '../../src/canvas/model.js'
import { artifactRunDir } from '../artifactPaths.js'
import { listArtifactSnapshot, prepareRunContext } from '../packer.js'
import { BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT } from '../pluginCapabilities.js'
import type { CreateRunRequest } from '../protocol.js'
import {
  resolvedTaskSkillCapabilityDigest,
  type ResolvedTaskSkill,
  type ResolvedTaskRunRequest,
} from '../taskRunTypes.js'

function request(nodeId: string, prompt: string, text: string): CreateRunRequest {
  return {
    nodeId,
    agentId: 'codex',
    prompt,
    projectDir: '.',
    canvasSnapshot: {
      nodes: [{
        id: nodeId,
        type: 'text',
        x: 0,
        y: 0,
        w: 320,
        h: 120,
        title: nodeId,
        text,
        instruction: { phase: 'idle', prompt, attachments: [], sources: [], open: true },
        payload: {},
      }],
      edges: [],
      plugins: [{
        id: 'text',
        label: 'Text',
        description: 'Text output',
        instruction: { placeholder: 'Write something', actions: ['GENERIC_UI_FALLBACK'] },
      }],
    },
  }
}

test('run-scoped context isolates concurrent runs and keeps single-node L2 content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-packer-'))
  try {
    const [first, second] = await Promise.all([
      prepareRunContext(request('node_a', 'PROMPT_A', 'SOURCE_A'), root, 'run-a'),
      prepareRunContext(request('node_b', 'PROMPT_B', 'SOURCE_B'), root, 'run-b'),
    ])

    assert.notEqual(first.contextFile, second.contextFile)
    const [firstText, secondText] = await Promise.all([
      readFile(first.contextFile, 'utf8'),
      readFile(second.contextFile, 'utf8'),
    ])
    assert.match(firstText, /PROMPT_A/)
    assert.match(firstText, /SOURCE_A/)
    assert.match(firstText, /\.gg\/context\/runs\/run-a\/pack\.md/)
    assert.doesNotMatch(firstText, /Treat `\.gg\/context\/pack\.md` as the source of truth/)
    assert.doesNotMatch(firstText, /PROMPT_B|SOURCE_B/)
    assert.match(secondText, /PROMPT_B/)
    assert.match(secondText, /SOURCE_B/)
    assert.doesNotMatch(secondText, /PROMPT_A|SOURCE_A/)
    assert.match(firstText, new RegExp(escapeRegExp(`${first.artifactDir}${path.sep}`), 'u'))
    assert.doesNotMatch(firstText, /deliverables only under `artifacts\/node_a\//u)
    assert.equal(first.pack.sourceContents.node_a?.text, 'SOURCE_A')
    assert.equal(second.pack.sourceContents.node_b?.text, 'SOURCE_B')
    const pluginContract = await readFile(
      path.join(root, '.gg/context/runs/run-a/skills/text.md'),
      'utf8',
    )
    assert.match(pluginContract, /Text output/)
    assert.match(pluginContract, /Instruction hint: Write something/)
    assert.doesNotMatch(pluginContract, /GENERIC_UI_FALLBACK|Suggested actions/u)
    assert.match(firstText, /\.ggai\/run-result\.json/u)
    assert.match(firstText, /"schemaVersion": 1/u)
    assert.match(firstText, /"suggestedActions": \[/u)
    assert.match(firstText, /exactly this schema and no additional properties/u)
    assert.doesNotMatch(firstText, /GENERIC_UI_FALLBACK/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy payload fallback keeps only real same-node artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-packer-legacy-'))
  try {
    const legacyDir = path.join(root, 'artifacts', 'node_legacy')
    const otherDir = path.join(root, 'artifacts', 'node_other')
    await Promise.all([
      mkdir(legacyDir, { recursive: true }),
      mkdir(otherDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(legacyDir, 'legacy.txt'), 'legacy\n', 'utf8'),
      writeFile(path.join(otherDir, 'secret.txt'), 'other node\n', 'utf8'),
      writeFile(path.join(root, 'outside.txt'), 'outside\n', 'utf8'),
    ])
    await symlink(path.join(root, 'outside.txt'), path.join(legacyDir, 'escape.txt'))

    const input = request('node_legacy', 'USE_LEGACY', 'SOURCE')
    input.canvasSnapshot.nodes[0].payload = {
      artifactFiles: [
        'artifacts/node_legacy/missing.txt',
        'artifacts/node_other/secret.txt',
        'artifacts/node_legacy/escape.txt',
      ],
    }
    const prepared = await prepareRunContext(input, root, 'run-legacy')
    const content = prepared.pack.sourceContents.node_legacy
    const expected = ['artifacts/node_legacy/legacy.txt']

    assert.deepEqual(content?.artifactFiles, expected)
    assert.deepEqual(content?.payload?.artifactFiles, expected)
    const rendered = await readFile(prepared.contextFile, 'utf8')
    assert.match(rendered, /artifacts\/node_legacy\/legacy\.txt/u)
    assert.doesNotMatch(rendered, /missing\.txt|secret\.txt|escape\.txt/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy artifact directory symlinks are never scanned', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-packer-symlink-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-packer-outside-'))
  try {
    await mkdir(path.join(root, 'artifacts'), { recursive: true })
    await writeFile(path.join(outside, 'secret.txt'), 'outside\n', 'utf8')
    await symlink(outside, path.join(root, 'artifacts', 'node_link'), 'dir')

    await assert.rejects(
      prepareRunContext(request('node_link', 'NO_ESCAPE', 'SOURCE'), root, 'run-link'),
      /artifact collection root is not a real project artifact directory/u,
    )
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  }
})

test('a managed source worktree gets source context without redirecting artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-packer-source-'))
  try {
    const sourceProjectDir = path.join(root, '.gg', 'source-worktrees', 'worktree-id')
    await mkdir(sourceProjectDir, { recursive: true })

    const prepared = await prepareRunContext(
      request('node_source', 'EDIT_SOURCE', 'SOURCE_INPUT'),
      root,
      'run-source',
      sourceProjectDir,
    )
    const rendered = await readFile(prepared.contextFile, 'utf8')
    const artifactDir = prepared.artifactDir

    assert.equal(prepared.pack.projectDir, sourceProjectDir)
    assert.match(rendered, new RegExp(escapeRegExp(prepared.contextFile), 'u'))
    assert.match(rendered, new RegExp(escapeRegExp(`${artifactDir}${path.sep}`), 'u'))
    assert.doesNotMatch(rendered, /deliverables only under `artifacts\/node_source\//u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-packer-control-'))
  try {
    const artifactDir = artifactRunDir(root, 'main', 'run-control', 'node-control')
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
