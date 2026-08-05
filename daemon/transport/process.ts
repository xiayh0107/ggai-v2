import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CanvasAgentEvent } from '../../src/agent/types.js'
import { AgentEventTranslator } from '../translator.js'
import { abortError, TransportError } from './types.js'

const MAX_STDERR = 64 * 1024
const MAX_STDOUT_BYTES = 32 * 1024 * 1024
const DEFAULT_FORCE_KILL_AFTER_MS = 5_000
const DEFAULT_FORCE_KILL_CONFIRM_MS = 1_000
const PROCESS_TREE_POLL_MS = 25

export interface ChildProcessPoolOptions {
  forceKillAfterMs?: number
  forceKillConfirmMs?: number
}

export interface SpawnAgentOptions {
  runId: string
  command: string
  args: string[]
  cwd: string
  stdin?: string
  signal: AbortSignal
  onEvent: (event: CanvasAgentEvent) => void
  onSessionId: (sessionId: string) => void
}

export interface SpawnAgentResult {
  sessionId: string | null
}

export class ChildProcessPool {
  readonly #children = new Map<string, ChildProcessWithoutNullStreams>()
  readonly #terminations = new WeakMap<ChildProcessWithoutNullStreams, Promise<boolean>>()
  readonly #forceKillAfterMs: number
  readonly #forceKillConfirmMs: number

  constructor(options: ChildProcessPoolOptions = {}) {
    this.#forceKillAfterMs = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS
    this.#forceKillConfirmMs = options.forceKillConfirmMs ?? DEFAULT_FORCE_KILL_CONFIRM_MS
  }

  async spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
    if (options.signal.aborted) throw abortError()
    if (this.#children.has(options.runId)) {
      throw new TransportError(`run ${options.runId} already has a child process`, 'duplicate_run')
    }

    const translator = new AgentEventTranslator({ onSessionId: options.onSessionId })
    let stderr = ''
    let spawnError: Error | null = null
    let outputLimitError: TransportError | null = null
    let cancelled = false
    let stdoutBytes = 0

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0' },
      shell: false,
      // A separate POSIX process group lets cancellation reach grandchildren
      // (shells, MCP servers, language tools), not only the direct CLI process.
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#children.set(options.runId, child)

    const emit = (events: CanvasAgentEvent[]) => {
      for (const event of events) options.onEvent(event)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!outputLimitError) {
          outputLimitError = new TransportError(
            `Agent stdout exceeded ${MAX_STDOUT_BYTES} bytes`,
            'output_limit_exceeded',
          )
          void this.#terminate(child)
        }
        return
      }
      emit(translator.push(chunk, 'stdout'))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR)
    })
    child.once('error', (error) => {
      spawnError = error
    })

    const onAbort = () => {
      cancelled = true
      void this.#terminate(child)
    }
    options.signal.addEventListener('abort', onAbort, { once: true })

    if (options.stdin !== undefined) {
      child.stdin.on('error', () => {
        // The close/error path below reports the actionable process failure.
      })
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }))
    })

    // A wrapper/leader can close before its process-group descendants. Do not
    // release the run id or report a terminal state until an in-flight tree
    // termination has crossed the full boundary.
    const termination = this.#terminations.get(child)
    if (termination && !await termination && !outputLimitError) {
      outputLimitError = new TransportError(
        'Agent process tree termination could not be confirmed',
        'termination_unconfirmed',
      )
    }

    options.signal.removeEventListener('abort', onAbort)
    this.#children.delete(options.runId)
    emit(translator.flush('stdout'))

    if (cancelled || options.signal.aborted) throw abortError()
    if (outputLimitError) throw outputLimitError
    if (spawnError) {
      const error = spawnError as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        throw new TransportError(`Agent CLI not found: ${options.command}`, 'command_not_found')
      }
      throw new TransportError(error.message, 'spawn_failed')
    }
    if (result.code !== 0) {
      const diagnostic = stderr.trim() || `process exited with ${result.signal ?? `code ${result.code}`}`
      throw new TransportError(diagnostic, 'process_failed')
    }

    return { sessionId: translator.sessionId }
  }

  async cancel(runId: string): Promise<boolean> {
    const child = this.#children.get(runId)
    if (!child) return false
    void this.#terminate(child)
    return true
  }

  has(runId: string): boolean {
    return this.#children.has(runId)
  }

  async cancelAndWait(runId: string): Promise<boolean> {
    const child = this.#children.get(runId)
    if (!child) return false
    return this.#terminate(child)
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#children.values()].map((child) => this.#terminate(child)))
    this.#children.clear()
  }

  #terminate(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    const existing = this.#terminations.get(child)
    if (existing) return existing
    const termination = this.#terminateProcessTree(child)
    this.#terminations.set(child, termination)
    return termination
  }

  async #terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    if (process.platform === 'win32') {
      // Node's child.kill() does not terminate a Windows process tree.
      if (child.pid !== undefined) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
        await waitForProcessClose(killer, this.#forceKillAfterMs + this.#forceKillConfirmMs)
      } else {
        child.kill('SIGTERM')
      }
      return waitForProcessClose(child, this.#forceKillConfirmMs)
    }

    signalProcessGroup(child, 'SIGTERM')
    if (child.pid === undefined) return waitForProcessClose(child, this.#forceKillAfterMs)
    if (await waitForProcessGroupExit(child.pid, this.#forceKillAfterMs)) return true

    // The group may outlive its leader, so kill and confirm the full boundary,
    // not only the direct child process.
    signalProcessGroup(child, 'SIGKILL')
    return waitForProcessGroupExit(child.pid, this.#forceKillConfirmMs)
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false
    await delay(Math.min(PROCESS_TREE_POLL_MS, Math.max(1, deadline - Date.now())))
  }
  return true
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function waitForProcessClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onClose)
      resolve(result)
    }
    const onClose = () => finish(true)
    child.once('close', onClose)
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return
      // Fall back to the direct child for platforms/runtimes without group kill.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Cancellation is best-effort; the close/exit path remains authoritative.
  }
}
