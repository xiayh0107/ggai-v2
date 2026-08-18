import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_COMPUTE_OUTPUT_BYTES,
  MAX_COMPUTE_RESULT_BYTES,
  parseComputeNodePayload,
  parseComputeResultSidecar,
  type ComputeNodePayload,
  type ComputeRuntimePresetId,
} from '../src/compute/contracts.js'
import type { ValueRef } from '../src/execution/contracts.js'
import { atomicWriteBytes, atomicWriteText, readExactFileBytes } from './atomic-file.js'
import type { ContainerRuntime, ContainerRuntimeDiagnostics } from './computeRuntime.js'
import { MacContainerRuntimeProvider } from './computeRuntime.js'
import type { NodeExecutor, NodeExecutorInput } from './nodeExecutions.js'
import { openVerifiedRunArtifactFile, RunArtifactStore } from './runArtifactStorage.js'

const RESULT_SIDECAR = 'execution-result.json'
const PRESETS: Record<ComputeRuntimePresetId, {
  image: string
  environmentDigest: string
  command: (code: string) => string[]
}> = {
  'python-3.13': {
    image: 'python@sha256:ffb752e139c0a19692a43af8d8523b274222dd68eebad5d583b45c2201c6e30a',
    environmentDigest: 'ffb752e139c0a19692a43af8d8523b274222dd68eebad5d583b45c2201c6e30a',
    command: (code) => ['python', '-c', code],
  },
  'node-24': {
    image: 'node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03',
    environmentDigest: '3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03',
    command: (code) => ['node', '--input-type=module', '--eval', code],
  },
}

export interface ComputeRuntimeSource {
  runtime(): Promise<ContainerRuntime | null>
  diagnostics(): Promise<ContainerRuntimeDiagnostics>
}

export class ComputeExecutor implements NodeExecutor {
  readonly id = 'container-compute'
  readonly environmentDigest = 'd9d9b44ecb3e71dab74f436fa1bbf078dad584220065176b1023cb54f487e7c7'
  readonly requiresApproval = true
  readonly #runtimes: ComputeRuntimeSource

  constructor(runtimes: ComputeRuntimeSource = new MacContainerRuntimeProvider()) {
    this.#runtimes = runtimes
  }

  supports(nodeTypeId: string): boolean {
    return nodeTypeId === 'compute'
  }

  environmentDigestFor(input: NodeExecutorInput['node']): string {
    return PRESETS[parseComputeNodePayload(input.payload).runtime].environmentDigest
  }

  diagnostics(): Promise<ContainerRuntimeDiagnostics> {
    return this.#runtimes.diagnostics()
  }

  async execute(input: NodeExecutorInput): Promise<Record<string, ValueRef[]>> {
    if (!input.projectDir) throw new TypeError('compute execution requires a trusted project directory')
    const runtime = await this.#runtimes.runtime()
    if (!runtime) throw new Error('container compute capability is unavailable')
    const payload = parseComputeNodePayload(input.node.payload)
    const preset = PRESETS[payload.runtime]
    const uid = process.getuid?.()
    const gid = process.getgid?.()
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid === 0) {
      throw new Error('container compute requires a non-root daemon user')
    }
    const store = new RunArtifactStore(input.projectDir, input.canvasBranch)
    const location = await store.prepareRun(input.artifactRunId)
    const privateRoot = path.join(location.absoluteRunRoot, '.ggai', 'inputs')
    if (/[,\r\n]/u.test(privateRoot)) throw new Error('compute input mount path is unsupported')
    const inputFilesRoot = path.join(privateRoot, 'files')
    await mkdir(inputFilesRoot, { recursive: true, mode: 0o700 })
    await stageInputs(input, inputFilesRoot, privateRoot)
    await chmod(privateRoot, 0o755)
    await chmod(inputFilesRoot, 0o755)
    const containerName = `ggai-${input.executionId}`.slice(0, 120)
    try {
      if (input.signal.aborted) throw input.signal.reason ?? new Error('compute execution cancelled')
      await runtime.run({
        containerName,
        args: containerArgs(payload, preset, privateRoot, String(uid), String(gid)),
        timeoutMs: payload.timeoutMs,
        signal: input.signal,
      })
      if (input.signal.aborted) throw input.signal.reason ?? new Error('compute execution cancelled')
      await runtime.copyFrom(containerName, '/outputs/.', location.absoluteFilesRoot)
    } finally {
      await runtime.remove(containerName).catch(() => undefined)
      await rm(privateRoot, { recursive: true, force: true })
    }
    const sidecarPath = path.join(location.absoluteFilesRoot, RESULT_SIDECAR)
    try {
      const sidecar = await readResultSidecar(location.absoluteFilesRoot)
      if (Object.keys(sidecar.outputs).some((port) => port !== 'result')) {
        throw new Error('compute sidecar may declare only the result output port')
      }
      await unlink(sidecarPath)
      const closed = await store.closeRun(input.artifactRunId)
      if (!closed.manifest.complete || closed.excluded.length > 0) {
        throw new Error('compute output contains an unsafe filesystem entry')
      }
      const totalBytes = closed.manifest.entries.reduce((sum, entry) => sum + entry.size, 0)
      if (totalBytes > MAX_COMPUTE_OUTPUT_BYTES) throw new Error('compute output exceeds byte limit')
      const declared = new Set(Object.values(sidecar.outputs).flat().map((item) => item.path))
      if (declared.size !== closed.manifest.entries.length
        || closed.manifest.entries.some((entry) => !declared.has(entry.relativePath))) {
        throw new Error('execution-result sidecar does not declare the exact output manifest')
      }
      return Object.fromEntries(Object.entries(sidecar.outputs).map(([port, items]) => [
        port,
        items.map((item): ValueRef => {
          const entry = closed.manifest.entries.find((candidate) => candidate.relativePath === item.path)
          if (!entry) throw new Error(`declared compute output is missing: ${item.path}`)
          return { kind: 'artifact', runId: input.artifactRunId, artifactId: entry.artifactId }
        }),
      ]))
    } catch (error) {
      await rm(sidecarPath, { force: true }).catch(() => undefined)
      await store.closeRun(input.artifactRunId, { complete: false }).catch(() => undefined)
      throw error
    }
  }
}

function containerArgs(
  payload: ComputeNodePayload,
  preset: (typeof PRESETS)[ComputeRuntimePresetId],
  inputRoot: string,
  uid: string,
  gid: string,
): string[] {
  return [
    '--pull', 'missing',
    '--network', 'none',
    '--read-only',
    '--user', `${uid}:${gid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true',
    '--cpus', String(payload.cpus),
    '--memory', `${payload.memoryMb}m`,
    '--pids-limit', String(payload.pids),
    '--mount', `type=bind,src=${inputRoot},dst=/inputs,readonly`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864',
    '--tmpfs', `/outputs:rw,noexec,nosuid,nodev,size=${MAX_COMPUTE_OUTPUT_BYTES}`,
    '--workdir', '/tmp',
    '--env', 'HOME=/tmp',
    preset.image,
    ...preset.command(payload.code),
  ]
}

async function stageInputs(
  input: NodeExecutorInput,
  filesRoot: string,
  privateRoot: string,
): Promise<void> {
  let totalBytes = 0
  let artifactIndex = 0
  const manifest = structuredClone(input.inputs) as Record<string, ValueRef[]>
  for (const values of Object.values(manifest)) {
    for (const value of values) {
      if (value.kind !== 'artifact') continue
      const artifact = await new RunArtifactStore(input.projectDir!, input.canvasBranch)
        .lookup(value.runId, value.artifactId)
      if (!artifact) throw new Error('compute input artifact does not exist')
      totalBytes += artifact.size
      if (totalBytes > MAX_COMPUTE_OUTPUT_BYTES) throw new Error('compute inputs exceed byte limit')
      const handle = await openVerifiedRunArtifactFile(artifact)
      try {
        const bytes = await readExactFileBytes(handle, artifact.size, MAX_COMPUTE_OUTPUT_BYTES)
        const fileName = String(artifactIndex).padStart(4, '0')
        await atomicWriteBytes(path.join(filesRoot, fileName), bytes)
        Object.assign(value, { containerPath: `/inputs/files/${fileName}` })
      } finally {
        await handle.close()
      }
      artifactIndex += 1
    }
  }
  await atomicWriteText(path.join(privateRoot, 'input.json'), `${JSON.stringify(manifest)}\n`)
}

async function readResultSidecar(filesRoot: string) {
  const filePath = path.join(filesRoot, RESULT_SIDECAR)
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_COMPUTE_RESULT_BYTES) {
    throw new Error('execution-result sidecar is not a trusted regular file')
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const bytes = await readExactFileBytes(handle, info.size, MAX_COMPUTE_RESULT_BYTES)
    return parseComputeResultSidecar(JSON.parse(bytes.toString('utf8')))
  } finally {
    await handle.close()
  }
}
