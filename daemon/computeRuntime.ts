import { spawn } from 'node:child_process'
import { runProbe } from './transport/probe.js'

const MAX_RUNTIME_DIAGNOSTIC_BYTES = 64 * 1024

export type ContainerRuntimeId = 'docker' | 'podman'

export interface ContainerRunRequest {
  containerName: string
  args: string[]
  timeoutMs: number
  signal: AbortSignal
}

export interface ContainerRuntime {
  readonly id: ContainerRuntimeId
  readonly binaryPath: string
  run(request: ContainerRunRequest): Promise<void>
  copyFrom(containerName: string, sourcePath: string, destination: string): Promise<void>
  remove(containerName: string): Promise<void>
}

export interface ContainerRuntimeDiagnostics {
  available: boolean
  provider: ContainerRuntimeId | null
  reason?: string
}

export class ContainerRuntimeError extends Error {
  readonly code: 'timed-out' | 'runtime-failed'
  constructor(code: 'timed-out' | 'runtime-failed', message: string) {
    super(message)
    this.name = 'ContainerRuntimeError'
    this.code = code
  }
}

export class MacContainerRuntimeProvider {
  #runtime: Promise<ContainerRuntime | null> | null = null
  #diagnostic: ContainerRuntimeDiagnostics | null = null

  runtime(): Promise<ContainerRuntime | null> {
    this.#runtime ??= this.#detect()
    return this.#runtime
  }

  async diagnostics(): Promise<ContainerRuntimeDiagnostics> {
    await this.runtime()
    return structuredClone(this.#diagnostic ?? { available: false, provider: null })
  }

  async #detect(): Promise<ContainerRuntime | null> {
    if (process.platform !== 'darwin') {
      this.#diagnostic = { available: false, provider: null, reason: 'macOS is the only enabled provider' }
      return null
    }
    const attempts: string[] = []
    for (const candidate of [
      { id: 'docker' as const, command: 'docker', args: ['version', '--format', '{{.Server.Version}}'] },
      { id: 'podman' as const, command: 'podman', args: ['info', '--format', 'json'] },
    ]) {
      const probe = await runProbe(candidate.command, candidate.args, 4_000)
      if (probe.found && probe.code === 0 && probe.binaryPath) {
        this.#diagnostic = { available: true, provider: candidate.id }
        return new CliContainerRuntime(candidate.id, probe.binaryPath)
      }
      attempts.push(`${candidate.id}: ${probe.output || 'not installed'}`)
    }
    this.#diagnostic = {
      available: false,
      provider: null,
      reason: attempts.join('; ').slice(0, 1_000),
    }
    return null
  }
}

export class CliContainerRuntime implements ContainerRuntime {
  readonly id: ContainerRuntimeId
  readonly binaryPath: string

  constructor(id: ContainerRuntimeId, binaryPath: string) {
    this.id = id
    this.binaryPath = binaryPath
  }

  async run(request: ContainerRunRequest): Promise<void> {
    await runCli(this.binaryPath, ['run', '--name', request.containerName, ...request.args], {
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      onStop: () => this.remove(request.containerName),
    })
  }

  copyFrom(containerName: string, sourcePath: string, destination: string): Promise<void> {
    return runCli(this.binaryPath, ['cp', `${containerName}:${sourcePath}`, destination], {
      signal: new AbortController().signal,
      timeoutMs: 30_000,
    })
  }

  remove(containerName: string): Promise<void> {
    return runCli(this.binaryPath, ['rm', '--force', containerName], {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      ignoreFailure: true,
    })
  }
}

async function runCli(
  binaryPath: string,
  args: string[],
  options: {
    signal: AbortSignal
    timeoutMs: number
    onStop?: () => Promise<void>
    ignoreFailure?: boolean
  },
): Promise<void> {
  if (options.signal.aborted) throw options.signal.reason ?? new Error('container operation cancelled')
  const child = spawn(binaryPath, args, {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0' },
  })
  let diagnostic = ''
  const append = (chunk: Buffer) => {
    diagnostic = `${diagnostic}${chunk.toString('utf8')}`.slice(-MAX_RUNTIME_DIAGNOSTIC_BYTES)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await options.onStop?.().catch(() => undefined)
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    } else child.kill('SIGKILL')
  }
  const onAbort = () => void stop()
  options.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => void stop(), options.timeoutMs)
  timer.unref()
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
  })
  if (options.signal.aborted) throw options.signal.reason ?? new Error('container operation cancelled')
  if (stopped) {
    throw new ContainerRuntimeError('timed-out', `container operation timed out after ${options.timeoutMs}ms`)
  }
  if (result.code !== 0 && !options.ignoreFailure) {
    throw new ContainerRuntimeError(
      'runtime-failed',
      diagnostic.trim() || `container CLI exited with ${result.signal ?? result.code}`,
    )
  }
}
