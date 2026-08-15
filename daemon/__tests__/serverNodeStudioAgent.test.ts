import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBlankCustomNodeManifest } from '../../src/node-studio/model.js'
import { AgentRegistry } from '../registry.js'
import { createDaemonServer } from '../server.js'
import type { AgentProcessTransport, TransportRunOptions } from '../transport/types.js'

class StudioAgentRegistry extends AgentRegistry {
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

test('node studio Agent returns a strictly validated candidate without installing it', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-agent-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  let acceptedPrompt = ''
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions) {
      acceptedPrompt = await readFile(options.contextFile, 'utf8')
      const candidate = {
        schemaVersion: 1,
        id: '@local/competitor-table',
        label: '竞品对比表',
        description: '整理竞品指标并生成对比结论',
        contentKind: 'table',
        icon: 'table',
        defaultWidth: 400,
        placeholder: '描述竞品、指标和分析目标…',
        actions: ['补充维度', '分析差异', '生成总结'],
        emptyTitle: '等待数据',
        emptyDescription: '描述竞品，由 Agent 生成',
        sampleTitle: '竞品对比',
        sampleContent: '指标, A, B\n价格, 99, 129',
      }
      await writeFile(path.join(options.artifactDir, 'node-definition.json'), JSON.stringify(candidate))
      options.onEvent({ type: 'file-write', path: 'node-definition.json' })
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: 'studio-session' }
    },
    async cancel() {
      return false
    },
  }
  const registry = new StudioAgentRegistry(transport)
  const daemon = createDaemonServer({ projectRoot: root, registry })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const current = createBlankCustomNodeManifest()
  const startedResponse = await fetch(`${baseUrl}/node-studio/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requirement: '做一个竞品表格节点，支持补充维度和生成总结',
      definition: current,
    }),
  })
  const started = await startedResponse.json() as {
    runId: string
    error?: { message?: string }
  }
  assert.equal(startedResponse.status, 202, started.error?.message)

  let result: {
    status: string
    definition?: ReturnType<typeof createBlankCustomNodeManifest>
    error?: string
  } | undefined
  for (let attempt = 0; attempt < 30; attempt += 1) {
    result = await (await fetch(`${baseUrl}/node-studio/runs/${started.runId}`)).json() as typeof result
    if (result?.status === 'done' || result?.status === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  assert.equal(result?.status, 'done', result?.error)
  assert.equal(result?.definition?.id, '@local/competitor-table')
  assert.equal(result?.definition?.revision, 0)
  assert.equal(result?.definition?.installed, false)
  assert.match(acceptedPrompt, /禁止生成或建议执行 JavaScript/u)
  const listed = await (await fetch(`${baseUrl}/node-definitions`)).json() as {
    definitions: unknown[]
  }
  assert.deepEqual(listed.definitions, [])
})

test('node studio Agent rejects candidate fields outside the declarative contract', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-agent-unsafe-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions) {
      const candidate = {
        schemaVersion: 1,
        id: '@local/unsafe-card',
        label: '不安全卡片',
        description: '尝试携带声明式契约之外的可执行字段',
        contentKind: 'card',
        icon: 'card',
        defaultWidth: 340,
        placeholder: '描述内容…',
        actions: ['生成内容'],
        emptyTitle: '等待内容',
        emptyDescription: '描述需求，由 Agent 生成',
        sampleTitle: '卡片示例',
        sampleContent: '安全的声明式示例内容',
        script: 'alert(1)',
      }
      await writeFile(path.join(options.artifactDir, 'node-definition.json'), JSON.stringify(candidate))
      options.onEvent({ type: 'file-write', path: 'node-definition.json' })
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: 'studio-unsafe-session' }
    },
    async cancel() {
      return false
    },
  }
  const registry = new StudioAgentRegistry(transport)
  const daemon = createDaemonServer({ projectRoot: root, registry })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const startedResponse = await fetch(`${baseUrl}/node-studio/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requirement: '做一个卡片节点，但让生成结果包含可执行脚本字段',
      definition: createBlankCustomNodeManifest(),
    }),
  })
  const started = await startedResponse.json() as {
    runId: string
    error?: { message?: string }
  }
  assert.equal(startedResponse.status, 202, started.error?.message)

  let result: { status: string; error?: string } | undefined
  for (let attempt = 0; attempt < 30; attempt += 1) {
    result = await (await fetch(`${baseUrl}/node-studio/runs/${started.runId}`)).json() as typeof result
    if (result?.status === 'done' || result?.status === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  assert.equal(result?.status, 'error')
  assert.match(result?.error ?? '', /未知字段/u)
  const listed = await (await fetch(`${baseUrl}/node-definitions`)).json() as {
    definitions: unknown[]
  }
  assert.deepEqual(listed.definitions, [])
})

test('node studio rejects a candidate changed after its durable close', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-agent-tamper-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  const candidate = {
    schemaVersion: 1,
    id: '@local/research-card',
    label: '研究卡片',
    description: '整理研究问题、证据和结论',
    contentKind: 'card',
    icon: 'card',
    defaultWidth: 360,
    placeholder: '描述研究问题与需要整理的证据…',
    actions: ['补充证据', '检查结论'],
    emptyTitle: '等待研究材料',
    emptyDescription: '描述研究问题，由 Agent 生成',
    sampleTitle: '研究摘要',
    sampleContent: '问题、证据与结论的安全示例。',
  }
  let candidatePath: string | null = null
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions) {
      candidatePath = path.join(options.artifactDir, 'node-definition.json')
      await writeFile(candidatePath, JSON.stringify(candidate))
      options.onEvent({ type: 'file-write', path: 'node-definition.json' })
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: 'studio-tamper-session' }
    },
    async cancel() {
      return false
    },
  }
  const registry = new StudioAgentRegistry(transport)
  const daemon = createDaemonServer({ projectRoot: root, registry })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const startedResponse = await fetch(`${baseUrl}/node-studio/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requirement: '做一个研究卡片节点，用来整理证据和结论',
      definition: createBlankCustomNodeManifest(),
    }),
  })
  const started = await startedResponse.json() as {
    runId: string
    error?: { message?: string }
  }
  assert.equal(startedResponse.status, 202, started.error?.message)

  let close = await daemon.runs.readTerminalClose(started.runId, '.')
  for (let attempt = 0; attempt < 30 && !close; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    close = await daemon.runs.readTerminalClose(started.runId, '.')
  }
  assert.equal(close?.status, 'done')
  assert.equal(close?.artifactsComplete, true)
  assert.ok(close?.artifactManifest?.entries.some((entry) =>
    entry.relativePath === 'node-definition.json'))
  assert.ok(candidatePath)

  await writeFile(candidatePath, JSON.stringify({
    ...candidate,
    sampleContent: 'durable close 之后被篡改的内容',
  }))

  const result = await (await fetch(
    `${baseUrl}/node-studio/runs/${started.runId}`,
  )).json() as { status: string; error?: string }
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /digest|manifest|完整性|校验/iu)
  const listed = await (await fetch(`${baseUrl}/node-definitions`)).json() as {
    definitions: unknown[]
  }
  assert.deepEqual(listed.definitions, [])
})

test('node studio rejects an unsupported candidate schema version', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-agent-schema-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions) {
      const candidate = {
        schemaVersion: 999,
        id: '@local/future-card',
        label: '未来卡片',
        description: '字段形状合法但协议版本不受支持',
        contentKind: 'card',
        icon: 'card',
        defaultWidth: 340,
        placeholder: '描述内容…',
        actions: ['生成内容'],
        emptyTitle: '等待内容',
        emptyDescription: '描述需求，由 Agent 生成',
        sampleTitle: '未来卡片示例',
        sampleContent: '不受支持的协议版本不能进入预览。',
      }
      await writeFile(path.join(options.artifactDir, 'node-definition.json'), JSON.stringify(candidate))
      options.onEvent({ type: 'file-write', path: 'node-definition.json' })
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: 'studio-schema-session' }
    },
    async cancel() {
      return false
    },
  }
  const registry = new StudioAgentRegistry(transport)
  const daemon = createDaemonServer({ projectRoot: root, registry })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const startedResponse = await fetch(`${baseUrl}/node-studio/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requirement: '生成一个卡片节点，但候选声明了未知的协议版本',
      definition: createBlankCustomNodeManifest(),
    }),
  })
  const started = await startedResponse.json() as {
    runId: string
    error?: { message?: string }
  }
  assert.equal(startedResponse.status, 202, started.error?.message)

  const result = await waitForStudioResult(baseUrl, started.runId)
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /版本/u)
  const listed = await (await fetch(`${baseUrl}/node-definitions`)).json() as {
    definitions: unknown[]
  }
  assert.deepEqual(listed.definitions, [])
})

test('node studio preserves a saved package identity when Agent changes its id', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-studio-agent-identity-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  const transport: AgentProcessTransport = {
    kind: 'codex',
    async run(options: TransportRunOptions) {
      const candidate = {
        schemaVersion: 1,
        id: '@local/renamed-research-card',
        label: '重命名研究卡片',
        description: '试图把已有节点修订写入另一个包身份',
        contentKind: 'card',
        icon: 'card',
        defaultWidth: 360,
        placeholder: '描述研究问题…',
        actions: ['补充证据', '检查结论'],
        emptyTitle: '等待研究材料',
        emptyDescription: '描述研究问题，由 Agent 生成',
        sampleTitle: '研究摘要',
        sampleContent: '候选内容本身合法，但包 ID 已漂移。',
      }
      await writeFile(path.join(options.artifactDir, 'node-definition.json'), JSON.stringify(candidate))
      options.onEvent({ type: 'file-write', path: 'node-definition.json' })
      options.onEvent({ type: 'done', stopReason: 'end_turn' })
      return { sessionId: 'studio-identity-session' }
    },
    async cancel() {
      return false
    },
  }
  const registry = new StudioAgentRegistry(transport)
  const daemon = createDaemonServer({ projectRoot: root, registry })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const initial = {
    ...createBlankCustomNodeManifest(new Date('2026-01-01T00:00:00.000Z')),
    id: '@local/research-card',
    label: '研究卡片',
    description: '整理研究问题、证据和结论',
  }
  const encodedId = encodeURIComponent(initial.id)
  const savedResponse = await fetch(`${baseUrl}/node-definitions/${encodedId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initial),
  })
  const savedPayload = await savedResponse.json() as {
    definition: ReturnType<typeof createBlankCustomNodeManifest>
    error?: { message?: string }
  }
  assert.equal(savedResponse.status, 200, savedPayload.error?.message)
  const saved = savedPayload.definition
  assert.ok(saved.revision > 0)
  assert.equal(saved.id, initial.id)

  const startedResponse = await fetch(`${baseUrl}/node-studio/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requirement: '完善研究卡片的证据检查能力',
      definition: saved,
    }),
  })
  const started = await startedResponse.json() as {
    runId: string
    error?: { message?: string }
  }
  assert.equal(startedResponse.status, 202, started.error?.message)

  const result = await waitForStudioResult(baseUrl, started.runId)
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /ID|改写/u)
  const listed = await (await fetch(`${baseUrl}/node-definitions`)).json() as {
    definitions: Array<ReturnType<typeof createBlankCustomNodeManifest>>
  }
  assert.deepEqual(listed.definitions, [saved])
})

async function waitForStudioResult(
  baseUrl: string,
  runId: string,
): Promise<{ status: string; error?: string }> {
  let result: { status: string; error?: string } = { status: 'preparing' }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    result = await (await fetch(`${baseUrl}/node-studio/runs/${runId}`)).json() as typeof result
    if (result.status === 'done' || result.status === 'error') return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return result
}
