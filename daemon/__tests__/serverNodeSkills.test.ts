import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunCapabilityReceiptStore } from '../capabilityReceipt.js'
import { CapabilityExecutionScopes } from '../capabilityScopes.js'
import { AgentRegistry } from '../registry.js'
import { createDaemonServer } from '../server.js'
import type { AgentProcessTransport, TransportRunOptions } from '../transport/types.js'

class NodeSkillAgentRegistry extends AgentRegistry {
  readonly transport: AgentProcessTransport

  constructor(transport: AgentProcessTransport) {
    super({ codexCommand: '/definitely/not-used' })
    this.transport = transport
  }

  override resolve(agentId: string): AgentProcessTransport | null {
    return agentId === 'codex' ? this.transport : null
  }

  override async probe() {
    return [{
      id: 'codex',
      label: 'Codex',
      transport: 'codex' as const,
      available: true,
      authStatus: 'authenticated' as const,
      models: [],
    }]
  }
}

async function createSkillSource(parent: string, name: string, instruction: string): Promise<string> {
  const directory = path.join(parent, name)
  await mkdir(directory)
  await writeFile(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${instruction}`,
    '---',
    `# ${name}`,
    '',
    instruction,
    '',
  ].join('\n'))
  return directory
}

test('accepted Runs pin and expose effective type plus instance Node skills', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-run-')))
  const sources = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-source-')))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  const typeSource = await createSkillSource(
    sources,
    'image-direction',
    'Apply the workspace image direction.',
  )
  const nodeSource = await createSkillSource(
    sources,
    'product-photography',
    'Use the product photography constraints for this Node only.',
  )
  let acceptedPack = ''
  let acceptedSkillFiles: string[] = []
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions) {
      acceptedPack = await readFile(options.contextFile, 'utf8')
      const skillRoot = path.join(path.dirname(options.contextFile), 'skills')
      const directories = (await readdir(skillRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      acceptedSkillFiles = await Promise.all(directories.map((directory) =>
        readFile(path.join(skillRoot, directory, 'SKILL.md'), 'utf8')))
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: 'node-skills-session' }
    },
    async cancel() {
      return false
    },
  }
  const daemon = createDaemonServer({
    projectRoot: root,
    registry: new NodeSkillAgentRegistry(transport),
  })
  t.after(async () => {
    await daemon.close()
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(sources, { recursive: true, force: true }),
    ])
  })

  const typeAsset = await daemon.skillAssets.import({
    sourcePath: typeSource,
    skillId: '@workspace/image-direction',
    expectedRevision: 0,
  })
  const nodeAsset = await daemon.skillAssets.import({
    sourcePath: nodeSource,
    skillId: '@workspace/product-photography',
    expectedRevision: 0,
  })
  const typeRef = {
    skillId: typeAsset.skillId,
    revision: typeAsset.revision,
    digest: typeAsset.digest,
  }
  const nodeRef = {
    skillId: nodeAsset.skillId,
    revision: nodeAsset.revision,
    digest: nodeAsset.digest,
  }
  await daemon.skillAssets.updateTypeBindings({
    nodeType: 'image',
    expectedRevision: 0,
    skills: [typeRef],
  })

  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const commit = async (baseRevision: number, mutationId: string, command: unknown) => {
    const response = await fetch(`${baseUrl}/canvas/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'main', baseRevision, mutationId, command }),
    })
    assert.equal(response.status, 200, await response.text())
  }
  await commit(0, 'create-skilled-task', {
    type: 'CreateTask',
    task: {
      id: 'task-skilled-image',
      title: 'Generate campaign image',
      goal: 'Use the Node-specific capabilities',
      anchor: { x: 100, y: 100 },
      origin: { kind: 'user' },
    },
  })
  await commit(1, 'create-skilled-node', {
    type: 'CreateNode',
    node: {
      id: 'node-skilled-image',
      type: 'image',
      frame: { x: 100, y: 100, w: 320, h: 320, z: 1 },
      title: 'Campaign image',
      artifactRefs: [],
      homeTaskId: 'task-skilled-image',
      skillBindings: { inheritType: true, skills: [nodeRef] },
      origin: { kind: 'user' },
    },
  })

  const response = await fetch(`${baseUrl}/runs?projectDir=.`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 2,
      runId: 'run-skilled-image',
      taskId: 'task-skilled-image',
      agentId: 'codex',
      canvasBranch: 'main',
      baseRevision: 2,
      prompt: 'Create the campaign image.',
      attachments: [],
      materializationPolicy: 'auto',
    }),
  })
  assert.equal(response.status, 202, await response.text())
  await waitFor(() => daemon.runs.get('run-skilled-image')?.status === 'done')

  assert.match(acceptedPack, /Node-bound skills authorized for this run/u)
  assert.match(acceptedPack, /image-direction/u)
  assert.match(acceptedPack, /product-photography/u)
  assert.equal(acceptedSkillFiles.length, 2)
  assert.ok(acceptedSkillFiles.some((content) => content.includes('workspace image direction')))
  assert.ok(acceptedSkillFiles.some((content) => content.includes('this Node only')))
  const summary = daemon.runs.get('run-skilled-image')
  assert.match(summary?.skillCapabilityDigest ?? '', /^[0-9a-f]{64}$/u)
  const receipt = await new RunCapabilityReceiptStore(root).get('run-skilled-image')
  const resolverCapability = receipt?.semanticCapabilities.find(
    ({ key }) => key === 'ggai.skill-resolver.v1',
  )
  assert.equal(resolverCapability?.provider, '@ggai/workspace-skill-resolver')
  assert.match(resolverCapability?.digest ?? '', /^[0-9a-f]{64}$/u)
})

test('Task Run fails closed when its Workspace SkillResolver capability is missing', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-missing-')))
  let transportStarted = false
  const registry = new NodeSkillAgentRegistry({
    kind: 'codex',
    async run() {
      transportStarted = true
      return { sessionId: null }
    },
    async cancel() {
      return false
    },
  })
  const scopes = new CapabilityExecutionScopes(registry.runtimeServices)
  const daemon = createDaemonServer({
    projectRoot: root,
    registry,
    capabilityExecutionScopes: scopes,
  })
  t.after(async () => {
    await daemon.runs.close()
    await scopes.dispose()
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const canvasResponse = await fetch(`${baseUrl}/canvas/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main',
      baseRevision: 0,
      mutationId: 'create-missing-resolver-task',
      command: {
        type: 'CreateTask',
        task: {
          id: 'task-missing-resolver',
          title: 'Missing resolver',
          goal: 'Fail before transport',
          anchor: { x: 0, y: 0 },
          origin: { kind: 'user' },
        },
      },
    }),
  })
  assert.equal(canvasResponse.status, 200, await canvasResponse.text())

  const response = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 2,
      runId: 'run-missing-resolver',
      taskId: 'task-missing-resolver',
      agentId: 'codex',
      canvasBranch: 'main',
      baseRevision: 1,
      prompt: 'This must not start.',
      attachments: [],
      materializationPolicy: 'auto',
    }),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json() as { error?: { code?: string } }).error?.code,
    'run_skill_unavailable')
  assert.equal(transportStarted, false)
  assert.equal(await daemon.runs.getPersisted('run-missing-resolver'), null)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error('timed out waiting for Task Run')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
