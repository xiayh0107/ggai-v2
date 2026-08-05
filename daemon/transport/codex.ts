import { lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { ChildProcessPool } from './process.js'
import {
  TransportError,
  type AgentProcessTransport,
  type TransportRunOptions,
  type TransportRunResult,
} from './types.js'

export interface CodexTransportOptions {
  command?: string
  sandbox?: 'read-only' | 'workspace-write'
}

export class CodexTransport implements AgentProcessTransport {
  readonly kind = 'codex' as const
  readonly #command: string
  readonly #sandbox: 'read-only' | 'workspace-write'
  readonly #pool = new ChildProcessPool()

  constructor(options: CodexTransportOptions = {}) {
    this.#command = options.command ?? 'codex'
    this.#sandbox = options.sandbox ?? 'workspace-write'
  }

  async run(options: TransportRunOptions): Promise<TransportRunResult> {
    const agentCwd = options.sourceProjectDir
      ?? path.join(options.projectDir, '.gg', 'runs', options.runId)
    const artifactDir = options.artifactDir
    await mkdir(artifactDir, { recursive: true })
    if (options.sourceProjectDir) await assertExistingSourceWorktree(agentCwd)
    else await mkdir(agentCwd, { recursive: true })
    const args = [
      'exec',
      '--json',
      '--color',
      'never',
      '--sandbox',
      this.#sandbox,
      '--skip-git-repo-check',
      '-C',
      agentCwd,
      '--add-dir',
      artifactDir,
    ]
    if (options.sessionId) {
      assertSafeCliArgument(options.sessionId, 'Codex session id')
      args.push('resume', options.sessionId, '-')
    }
    else args.push('-')

    const result = await this.#pool.spawn({
      runId: options.runId,
      command: this.#command,
      args,
      cwd: agentCwd,
      stdin: [
        `Project root (read-only): ${JSON.stringify(options.projectDir)}`,
        ...(options.sourceProjectDir
          ? [`Source worktree (writable): ${JSON.stringify(options.sourceProjectDir)}`]
          : []),
        `Context file (read-only): ${JSON.stringify(options.contextFile)}`,
        `Writable artifact directory: ${JSON.stringify(artifactDir)}`,
        options.prompt,
      ].join('\n'),
      signal: options.signal,
      onEvent: options.onEvent,
      onSessionId: options.onSessionId,
    })
    return { sessionId: result.sessionId ?? options.sessionId }
  }

  async cancel(runId: string): Promise<boolean> {
    if (!this.#pool.has(runId)) return false
    const stopped = await this.#pool.cancelAndWait(runId)
    if (!stopped) {
      throw new TransportError('Codex process tree termination could not be confirmed', 'cancel_unconfirmed')
    }
    return true
  }
}

async function assertExistingSourceWorktree(sourceProjectDir: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(sourceProjectDir)
  } catch {
    throw new TransportError(
      'managed source worktree disappeared before Codex could start',
      'source_worktree_unavailable',
    )
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TransportError(
      'managed source worktree is not a safe directory',
      'source_worktree_unavailable',
    )
  }
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
