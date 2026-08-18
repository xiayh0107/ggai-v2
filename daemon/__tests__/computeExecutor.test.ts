import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canvasNodeGeometry, canvasNodeTypeRef, emptyCanvasDocument } from '../../src/canvas/model.js'
import { ComputeExecutor } from '../computeExecutor.js'
import type {
  ContainerRunRequest,
  ContainerRuntime,
  ContainerRuntimeDiagnostics,
} from '../computeRuntime.js'
import { ContainerRuntimeError } from '../computeRuntime.js'
import { MetadataStore } from '../metadataStore.js'
import { NodeExecutionService } from '../nodeExecutions.js'

test('compute requires digest approval and emits artifacts through a hardened container spec', async (t) => {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-compute-')))
  const metadata = new MetadataStore(projectDir)
  const runtime = new FakeRuntime()
  const executor = new ComputeExecutor(new FakeRuntimeSource(runtime))
  const service = new NodeExecutionService(metadata)
  service.executors.register(executor)
  t.after(async () => {
    await metadata.close()
    await rm(projectDir, { recursive: true, force: true })
  })
  const document = emptyCanvasDocument()
  document.nodes.push({
    id: 'compute-node',
    typeRef: canvasNodeTypeRef('compute'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 420, h: 240, z: 1 }),
    title: 'Compute',
    payload: computePayload('print(1)'),
    artifactRefs: [],
    origin: { kind: 'user' },
  })
  const startInput = {
    projectId: 'project-compute', projectDir, canvasBranch: 'main', document,
    nodeId: 'compute-node', force: false,
  }
  const pending = await service.start(startInput)
  assert.equal(pending.status, 'awaiting-approval')
  assert.equal(runtime.runs.length, 0)
  const approved = await service.approve({
    executionId: pending.executionId,
    projectId: startInput.projectId,
    projectDir,
    canvasBranch: 'main',
    document,
  })
  assert.equal(approved.status, 'running')
  const terminal = await waitForExecution(service, approved.executionId)
  assert.equal(terminal.status, 'succeeded')
  assert.equal(terminal.outputs.result?.[0]?.kind, 'artifact')
  assert.equal(runtime.runs.length, 1)
  const args = runtime.runs[0]!.args
  for (const pair of [
    ['--network', 'none'], ['--user'], ['--cap-drop', 'ALL'],
    ['--security-opt', 'no-new-privileges=true'], ['--read-only'],
    ['--cpus', '1'], ['--memory', '512m'], ['--pids-limit', '64'],
  ]) assertArgsContain(args, pair)
  assert.ok(args.some((value) => value.startsWith('python@sha256:')))
  assert.ok(args.includes('/outputs:rw,noexec,nosuid,nodev,size=268435456'))

  const approvedAgain = await service.start({ ...startInput, force: true })
  assert.equal(approvedAgain.status, 'running')
  await waitForExecution(service, approvedAgain.executionId)
  document.nodes[0]!.payload = computePayload('print(2)')
  const changed = await service.start({ ...startInput, force: true })
  assert.equal(changed.status, 'awaiting-approval')
})

test('compute fails closed when neither container runtime is available', async () => {
  const executor = new ComputeExecutor({
    runtime: async () => null,
    diagnostics: async (): Promise<ContainerRuntimeDiagnostics> => ({
      available: false, provider: null, reason: 'none',
    }),
  })
  const document = emptyCanvasDocument()
  const node = {
    id: 'compute-node', typeRef: canvasNodeTypeRef('compute'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 420, h: 240, z: 1 }),
    title: 'Compute', payload: computePayload('print(1)'), artifactRefs: [],
    origin: { kind: 'user' as const },
  }
  document.nodes.push(node)
  await assert.rejects(executor.execute({
    executionId: 'execution-unavailable', artifactRunId: 'execution-artifacts-unavailable',
    projectDir: process.cwd(), canvasBranch: 'main', document, node, inputs: {},
    signal: new AbortController().signal,
  }), /capability is unavailable/u)
})

test('compute rejects undeclared files, symlinks, and hardlinks from the output boundary', async (t) => {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-compute-output-')))
  t.after(() => rm(projectDir, { recursive: true, force: true }))
  const document = emptyCanvasDocument()
  const node = {
    id: 'compute-node', typeRef: canvasNodeTypeRef('compute'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 420, h: 240, z: 1 }),
    title: 'Compute', payload: computePayload('print(1)'), artifactRefs: [],
    origin: { kind: 'user' as const },
  }
  document.nodes.push(node)
  for (const mode of ['undeclared', 'symlink', 'hardlink'] as const) {
    const executor = new ComputeExecutor(new FakeRuntimeSource(new FakeRuntime(mode)))
    await assert.rejects(executor.execute({
      executionId: `execution-${mode}`,
      artifactRunId: `execution-artifacts-${mode}`,
      projectDir, canvasBranch: 'main', document, node, inputs: {},
      signal: new AbortController().signal,
    }), /exact output manifest|unsafe filesystem entry/u)
  }
})

test('container wall-time exhaustion becomes an immutable timed-out execution', async (t) => {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-compute-timeout-')))
  const metadata = new MetadataStore(projectDir)
  const runtime = new FakeRuntime()
  runtime.run = async () => {
    throw new ContainerRuntimeError('timed-out', 'limit reached')
  }
  const service = new NodeExecutionService(metadata)
  service.executors.register(new ComputeExecutor(new FakeRuntimeSource(runtime)))
  t.after(async () => {
    await metadata.close()
    await rm(projectDir, { recursive: true, force: true })
  })
  const document = emptyCanvasDocument()
  document.nodes.push({
    id: 'compute-timeout', typeRef: canvasNodeTypeRef('compute'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 420, h: 240, z: 1 }),
    title: 'Timeout', payload: computePayload('while True: pass'), artifactRefs: [],
    origin: { kind: 'user' },
  })
  const pending = await service.start({
    projectId: 'project-timeout', projectDir, canvasBranch: 'main', document,
    nodeId: 'compute-timeout', force: false,
  })
  await service.approve({
    executionId: pending.executionId, projectId: 'project-timeout', projectDir,
    canvasBranch: 'main', document,
  })
  assert.equal((await waitForExecution(service, pending.executionId)).status, 'timed-out')
})

test('cancelling compute waits for the runtime boundary and records cancellation', async (t) => {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-compute-cancel-')))
  const metadata = new MetadataStore(projectDir)
  const runtime = new FakeRuntime()
  runtime.run = async (request) => await new Promise<void>((_resolve, reject) => {
    if (request.signal.aborted) {
      reject(new Error('stopped'))
      return
    }
    request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
  })
  const service = new NodeExecutionService(metadata)
  service.executors.register(new ComputeExecutor(new FakeRuntimeSource(runtime)))
  t.after(async () => {
    await metadata.close()
    await rm(projectDir, { recursive: true, force: true })
  })
  const document = emptyCanvasDocument()
  document.nodes.push({
    id: 'compute-cancel', typeRef: canvasNodeTypeRef('compute'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 420, h: 240, z: 1 }),
    title: 'Cancel', payload: computePayload('while True: pass'), artifactRefs: [],
    origin: { kind: 'user' },
  })
  const pending = await service.start({
    projectId: 'project-cancel', projectDir, canvasBranch: 'main', document,
    nodeId: 'compute-cancel', force: false,
  })
  await service.approve({
    executionId: pending.executionId, projectId: 'project-cancel', projectDir,
    canvasBranch: 'main', document,
  })
  assert.equal(service.cancel(pending.executionId), true)
  assert.equal((await waitForExecution(service, pending.executionId)).status, 'cancelled')
  assert.ok(runtime.removals > 0)
})

class FakeRuntimeSource {
  readonly #runtime: ContainerRuntime
  constructor(runtime: ContainerRuntime) { this.#runtime = runtime }
  async runtime() { return this.#runtime }
  async diagnostics(): Promise<ContainerRuntimeDiagnostics> {
    return { available: true, provider: 'docker' }
  }
}

class FakeRuntime implements ContainerRuntime {
  readonly id = 'docker' as const
  readonly binaryPath = '/fake/docker'
  readonly runs: ContainerRunRequest[] = []
  removals = 0
  readonly #mode: 'valid' | 'undeclared' | 'symlink' | 'hardlink'
  constructor(mode: 'valid' | 'undeclared' | 'symlink' | 'hardlink' = 'valid') {
    this.#mode = mode
  }
  async run(request: ContainerRunRequest) { this.runs.push(structuredCloneRequest(request)) }
  async copyFrom(_containerName: string, _sourcePath: string, destination: string) {
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'result.txt'), 'ok\n', 'utf8')
    await writeFile(path.join(destination, 'execution-result.json'), JSON.stringify({
      schemaVersion: 1,
      outputs: { result: [{ path: 'result.txt' }, ...(this.#mode === 'symlink'
        ? [{ path: 'link.txt' }]
        : this.#mode === 'hardlink' ? [{ path: 'alias.txt' }] : [])] },
    }), 'utf8')
    if (this.#mode === 'undeclared') {
      await writeFile(path.join(destination, 'extra.txt'), 'not declared', 'utf8')
    } else if (this.#mode === 'symlink') {
      await symlink('result.txt', path.join(destination, 'link.txt'))
    } else if (this.#mode === 'hardlink') {
      await link(path.join(destination, 'result.txt'), path.join(destination, 'alias.txt'))
    }
  }
  async remove() { this.removals += 1 }
}

function structuredCloneRequest(request: ContainerRunRequest): ContainerRunRequest {
  return { ...request, args: [...request.args] }
}

function computePayload(code: string) {
  return {
    runtime: 'python-3.13', code, timeoutMs: 30_000, memoryMb: 512, cpus: 1, pids: 64,
  }
}

function assertArgsContain(args: string[], values: string[]): void {
  if (values.length === 1) assert.ok(args.includes(values[0]!))
  else assert.ok(args.some((_, index) => values.every((expected, offset) =>
    args[index + offset] === expected)))
}

async function waitForExecution(service: NodeExecutionService, executionId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await service.get(executionId)
    if (execution && ['succeeded', 'failed', 'cancelled', 'timed-out'].includes(execution.status)) {
      return execution
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('execution did not settle')
}
