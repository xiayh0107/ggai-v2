import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { ChildProcessPool } from './process.js'
import {
  abortError,
  TransportError,
  type AgentProcessTransport,
  type TransportRunOptions,
  type TransportRunResult,
} from './types.js'

const COOPERATIVE_CANCEL_COMMAND_MS = 1_500
const COOPERATIVE_CANCEL_FORCE_KILL_MS = 500
const COOPERATIVE_CANCEL_DETACH_MS = 500
const COOPERATIVE_CANCEL_GRACE_MS = 1_500
const CLIENT_STOP_CONFIRM_MS = 6_000
const POST_CLIENT_STOP_CANCEL_DELAY_MS = 100

interface ActiveAcpxRun {
  agent: string
  sessionName: string
  projectDir: string
  phase: 'ensuring' | 'prompting'
  cancelRequested: boolean
  settled: Promise<void>
  resolveSettled: () => void
  cancelPromise?: Promise<boolean>
}

export interface AcpxTransportOptions {
  command?: string
  /** acpx confines approved operations to --cwd; this is the phase-one non-interactive mode. */
  approvalMode?: 'approve-all' | 'approve-reads' | 'deny-all'
}

function sessionName(nodeId: string, agentId: string): string {
  const digest = createHash('sha256').update(`${nodeId}\0${agentId}`).digest('hex').slice(0, 16)
  return `ggai-${digest}`
}

export class AcpxTransport implements AgentProcessTransport {
  readonly kind = 'acpx' as const
  readonly supportsInteractivePermissions = false
  readonly #command: string
  readonly #approvalFlag: '--approve-all' | '--approve-reads' | '--deny-all'
  readonly #pool = new ChildProcessPool()
  readonly #activeRuns = new Map<string, ActiveAcpxRun>()
  readonly #activeSessionScopes = new Map<string, string>()

  constructor(options: AcpxTransportOptions = {}) {
    this.#command = options.command ?? 'acpx'
    // Writes/commands must be an explicit operator choice until the ACP SDK
    // permission round-trip is implemented.
    this.#approvalFlag = `--${options.approvalMode ?? 'approve-reads'}`
  }

  async run(options: TransportRunOptions): Promise<TransportRunResult> {
    const agent = options.agentId.startsWith('acpx:')
      ? options.agentId.slice('acpx:'.length)
      : options.agentId
    assertSafeCliArgument(agent, 'acpx agent id')
    const workspaceDir = options.sourceProjectDir ?? options.projectDir
    // `approve-all` grants terminal execution as well as filesystem writes in
    // acpx. Never apply it to the user's checkout unless that canvas branch has
    // an explicitly managed source worktree.
    const approvalFlag = !options.sourceProjectDir && this.#approvalFlag === '--approve-all'
      ? '--approve-reads'
      : this.#approvalFlag
    const persistentName = options.sessionId ?? sessionName(options.nodeId, agent)
    assertSafeCliArgument(persistentName, 'acpx session id')
    const globalArgs = [
      '--cwd',
      workspaceDir,
      '--format',
      'json',
      '--json-strict',
    ]
    const promptArgs = [
      ...globalArgs,
      '--non-interactive-permissions',
      'fail',
      approvalFlag,
      agent,
      'prompt',
      '-s',
      persistentName,
      options.prompt,
    ]

    if (this.#activeRuns.has(options.runId)) {
      throw new TransportError(`run ${options.runId} is already active`, 'duplicate_run')
    }
    const sessionScope = JSON.stringify([workspaceDir, agent, persistentName])
    const sessionOwner = this.#activeSessionScopes.get(sessionScope)
    if (sessionOwner) {
      throw new TransportError(
        `acpx session ${persistentName} is already active in run ${sessionOwner}`,
        'session_busy',
      )
    }
    let resolveSettled: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    const active: ActiveAcpxRun = {
      agent,
      sessionName: persistentName,
      projectDir: workspaceDir,
      phase: 'ensuring',
      cancelRequested: false,
      settled,
      resolveSettled,
    }
    this.#activeRuns.set(options.runId, active)
    this.#activeSessionScopes.set(sessionScope, options.runId)

    // Named acpx sessions are explicit: `prompt` does not create a missing
    // session. Ensure it idempotently before sending the prompt, then resume by
    // the same stable name. Raw adapter ids must never replace that durable key.
    try {
      await this.#pool.spawn({
        runId: options.runId,
        command: this.#command,
        args: [...globalArgs, agent, 'sessions', 'ensure', '--name', persistentName],
        cwd: workspaceDir,
        signal: options.signal,
        onEvent: () => undefined,
        onSessionId: () => undefined,
      })
      active.phase = 'prompting'
      if (active.cancelRequested || options.signal.aborted) throw abortError()

      // Only expose/persist the name after acpx confirmed that the session exists.
      options.onSessionId(persistentName)
      await this.#pool.spawn({
        runId: options.runId,
        command: this.#command,
        args: promptArgs,
        cwd: workspaceDir,
        signal: options.signal,
        onEvent: options.onEvent,
        onSessionId: () => undefined,
      })
      if (active.cancelRequested) throw abortError()
      return { sessionId: persistentName }
    } finally {
      active.resolveSettled()
      // A cancelling run keeps its session lease through the post-close IPC
      // cancel, otherwise a successor could start and be cancelled by its
      // predecessor's cleanup.
      if (active.cancelPromise) await active.cancelPromise.catch(() => undefined)
      if (this.#activeRuns.get(options.runId) === active) this.#activeRuns.delete(options.runId)
      if (this.#activeSessionScopes.get(sessionScope) === options.runId) {
        this.#activeSessionScopes.delete(sessionScope)
      }
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const active = this.#activeRuns.get(runId)
    if (!active) return this.#pool.cancel(runId)
    if (active.cancelPromise) return active.cancelPromise
    active.cancelRequested = true
    const cancellation = this.#cancelActiveRun(runId, active)
    active.cancelPromise = cancellation
    return cancellation
  }

  async #cancelActiveRun(runId: string, active: ActiveAcpxRun): Promise<boolean> {
    // No ACP session is guaranteed to exist while ensure is in flight.
    if (active.phase === 'ensuring') {
      if (!this.#pool.has(runId)) return false
      const stopped = await this.#pool.cancelAndWait(runId)
      if (!stopped) {
        throw new TransportError('acpx session ensure process could not be stopped', 'cancel_unconfirmed')
      }
      return true
    }

    const requested = await requestCooperativeCancel(this.#command, active)
    if (requested && await settlesWithin(active.settled, COOPERATIVE_CANCEL_GRACE_MS)) {
      return true
    }
    const processTreeStopped = this.#pool.has(runId)
      ? await this.#pool.cancelAndWait(runId)
      : true
    // The first cancel can be a successful no-op when the prompt client has
    // forked but has not registered with a persistent queue owner yet. Once the
    // client is stopped it cannot enqueue later; cancel the named session again
    // to catch work already handed to an owner outside this process group.
    const clientStopped = await settlesWithin(active.settled, CLIENT_STOP_CONFIRM_MS)
    if (!processTreeStopped || !clientStopped) {
      throw new TransportError(
        `acpx prompt client did not stop for ${active.sessionName}`,
        'cancel_unconfirmed',
      )
    }
    await delay(POST_CLIENT_STOP_CANCEL_DELAY_MS)
    const finalRequested = await requestCooperativeCancel(this.#command, active)
    if (!finalRequested) {
      throw new TransportError(
        `acpx session cancellation could not be confirmed for ${active.sessionName}`,
        'cancel_unconfirmed',
      )
    }
    return true
  }
}

async function requestCooperativeCancel(command: string, active: ActiveAcpxRun): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let forceKillTimer: NodeJS.Timeout | undefined
    let detachTimer: NodeJS.Timeout | undefined
    const child = spawn(command, [
      '--cwd', active.projectDir,
      '--format', 'json',
      '--json-strict',
      active.agent,
      'cancel',
      '-s', active.sessionName,
    ], {
      cwd: active.projectDir,
      env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0' },
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (detachTimer) clearTimeout(detachTimer)
      resolve(result)
    }
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(!timedOut && code === 0))
    const timer = setTimeout(() => {
      timedOut = true
      signalHelper(child, 'SIGTERM')
      forceKillTimer = setTimeout(() => {
        signalHelper(child, 'SIGKILL')
        detachTimer = setTimeout(() => {
          // A pathological wrapper must not keep the daemon alive forever.
          child.unref()
          finish(false)
        }, COOPERATIVE_CANCEL_DETACH_MS)
      }, COOPERATIVE_CANCEL_FORCE_KILL_MS)
    }, COOPERATIVE_CANCEL_COMMAND_MS)
  })
}

function signalHelper(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The close/error path or final unref completes the bounded cleanup.
  }
}

async function settlesWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function assertSafeCliArgument(value: string, label: string): void {
  if (value.startsWith('-') || hasControlCharacters(value)) {
    throw new Error(`${label} contains unsupported characters`)
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}
