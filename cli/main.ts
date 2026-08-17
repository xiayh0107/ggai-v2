import {
  WorkspaceProjectClient,
  WorkspaceProjectProtocolError,
  WorkspaceProjectRequestError,
  type WorkspaceProject,
} from '../src/workspace/projectClient.js'
import { TaskRunPreflightClient } from '../src/agent/taskRunPreflightClient.js'
import { TaskRunHttpClient } from '../src/agent/taskRunHttpClient.js'
import type { CanvasAgentEvent } from '../src/agent/types.js'
import {
  executeHeadlessRun,
  type HeadlessRunRequest,
  type HeadlessRunResult,
} from './run.js'
import { HeadlessCanvasClient } from './canvasClient.js'
import {
  CliCommandError,
  CliUsageError,
  writeError,
  writeResult,
  type CliIo,
} from './output.js'

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7380'

export const CLI_HELP = [
  'Usage: gg [--daemon-url URL] [--json] <command>',
  '',
  'Commands:',
  '  doctor                  Check daemon health and Canvas capability',
  '  project list            List daemon-managed Workspace projects',
  '  project create <title>  Create a daemon-managed Workspace project',
  '  run <prompt> --project P [--wait]  Create a Task and start a Run',
  '',
  'Global options:',
  '  --daemon-url URL        Daemon base URL (default http://127.0.0.1:7380)',
  '  --json                  Emit a stable JSON envelope',
  '  -h, --help              Show help',
].join('\n')

export interface RunCliOptions {
  io: CliIo
  fetch?: typeof globalThis.fetch
  environment?: NodeJS.ProcessEnv
}

interface ParsedCli {
  daemonUrl: string
  json: boolean
  args: string[]
  help: boolean
}

export async function runCli(argv: readonly string[], options: RunCliOptions): Promise<number> {
  let parsed: ParsedCli
  try {
    parsed = parseCli(argv, options.environment ?? process.env)
  } catch (error) {
    const failure = cliFailure(error)
    writeError(options.io, argv.includes('--json'), failure.error)
    if (failure.help) options.io.stderr(`\n${CLI_HELP}\n`)
    return failure.exitCode
  }
  if (parsed.help || parsed.args.length === 0) {
    options.io.stdout(`${CLI_HELP}\n`)
    return 0
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
  try {
    if (parsed.args[0] === 'doctor') {
      exactArgs(parsed.args, 1, 'doctor does not accept positional arguments')
      const health = await daemonHealth(parsed.daemonUrl, fetchImplementation)
      writeResult(
        options.io,
        parsed.json,
        'doctor',
        health,
        `Daemon ready · Canvas schema ${health.canvasSchemaVersion}\nProject root: ${health.projectRoot}`,
      )
      return 0
    }
    if (parsed.args[0] === 'project') {
      return await runProjectCommand(parsed, options.io, fetchImplementation)
    }
    if (parsed.args[0] === 'run') {
      const request = parseRunRequest(parsed.args, options.environment ?? process.env)
      const result = await executeHeadlessRun(request, {
        projects: new WorkspaceProjectClient({
          baseUrl: parsed.daemonUrl,
          fetch: fetchImplementation,
        }),
        canvas: new HeadlessCanvasClient({
          baseUrl: parsed.daemonUrl,
          fetch: fetchImplementation,
        }),
        preflight: new TaskRunPreflightClient({
          baseUrl: parsed.daemonUrl,
          fetch: fetchImplementation,
        }),
        runs: new TaskRunHttpClient({
          baseUrl: parsed.daemonUrl,
          fetch: fetchImplementation,
        }),
        uuid: () => globalThis.crypto.randomUUID(),
        now: () => Date.now(),
        onEvent: (runId, event) => writeRunEvent(options.io, parsed.json, runId, event),
      })
      writeResult(options.io, parsed.json, 'run', result, runResultText(result))
      return result.status === 'error' || result.status === 'interrupted' ? 6 : 0
    }
    throw new CliUsageError(`unknown command: ${parsed.args[0]}`)
  } catch (error) {
    const failure = cliFailure(error)
    writeError(options.io, parsed.json, failure.error)
    if (failure.help) options.io.stderr(`\n${CLI_HELP}\n`)
    return failure.exitCode
  }
}

async function runProjectCommand(
  parsed: ParsedCli,
  io: CliIo,
  fetchImplementation: typeof globalThis.fetch,
): Promise<number> {
  const subcommand = parsed.args[1]
  const client = new WorkspaceProjectClient({
    baseUrl: parsed.daemonUrl,
    fetch: fetchImplementation,
  })
  if (subcommand === 'list') {
    exactArgs(parsed.args, 2, 'project list does not accept positional arguments')
    const projects = await client.list()
    writeResult(io, parsed.json, 'project.list', { projects }, projectListText(projects))
    return 0
  }
  if (subcommand === 'create') {
    const title = parsed.args.slice(2).join(' ').trim()
    if (!title) throw new CliUsageError('project create requires a title')
    const project = await client.create(title)
    writeResult(
      io,
      parsed.json,
      'project.create',
      { project },
      `Created ${project.title} (${project.id})`,
    )
    return 0
  }
  throw new CliUsageError(subcommand
    ? `unknown project command: ${subcommand}`
    : 'project requires list or create')
}

function parseCli(argv: readonly string[], environment: NodeJS.ProcessEnv): ParsedCli {
  let daemonUrl = environment.GGAI_DAEMON_URL ?? DEFAULT_DAEMON_URL
  let json = false
  let help = false
  const args: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--json') json = true
    else if (argument === '--daemon-url') daemonUrl = argv[++index] ?? ''
    else if (argument === '--help' || argument === '-h') help = true
    else args.push(argument)
  }
  if (!daemonUrl.trim()) throw new CliUsageError('--daemon-url requires a value')
  let normalized: URL
  try {
    normalized = new URL(daemonUrl)
  } catch {
    throw new CliUsageError('--daemon-url must be an absolute URL')
  }
  if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
    throw new CliUsageError('--daemon-url must use http or https')
  }
  return { daemonUrl: normalized.toString().replace(/\/$/u, ''), json, args, help }
}

async function daemonHealth(
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<{ status: 'ok'; canvasSchemaVersion: number; projectRoot: string }> {
  const response = await fetchImplementation(new URL('/health', `${baseUrl}/`), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  const value = await response.json() as unknown
  if (!response.ok) throw new WorkspaceProjectRequestError('daemon health request failed', response.status)
  if (!isRecord(value)
    || value.status !== 'ok'
    || !isRecord(value.capabilities)
    || value.capabilities.canvas !== true
    || !isRecord(value.canvas)
    || !Number.isSafeInteger(value.canvas.schemaVersion)
    || typeof value.projectRoot !== 'string'
    || !value.projectRoot) {
    throw new WorkspaceProjectProtocolError('daemon health response is invalid')
  }
  return {
    status: 'ok',
    canvasSchemaVersion: value.canvas.schemaVersion as number,
    projectRoot: value.projectRoot,
  }
}

function projectListText(projects: readonly WorkspaceProject[]): string {
  if (projects.length === 0) return 'No projects'
  return projects.map((project) => {
    const summary = project.summary
      ? `${project.summary.taskCount} tasks · ${project.summary.nodeCount} nodes`
      : project.state
    return `${project.id}\t${project.title}\t${summary}`
  }).join('\n')
}

function exactArgs(args: readonly string[], expected: number, message: string): void {
  if (args.length !== expected) throw new CliUsageError(message)
}

function cliFailure(error: unknown): {
  exitCode: number
  help: boolean
  error: { code: string; message: string }
} {
  if (error instanceof CliUsageError) {
    return { exitCode: 2, help: true, error: { code: 'usage_error', message: error.message } }
  }
  if (error instanceof CliCommandError) {
    return {
      exitCode: error.exitCode,
      help: false,
      error: { code: error.code, message: error.message },
    }
  }
  if (error instanceof WorkspaceProjectRequestError) {
    return {
      exitCode: 4,
      help: false,
      error: { code: error.code ?? `http_${error.status}`, message: error.message },
    }
  }
  if (error instanceof WorkspaceProjectProtocolError) {
    return { exitCode: 4, help: false, error: { code: 'protocol_error', message: error.message } }
  }
  if (error instanceof TypeError) {
    return { exitCode: 3, help: false, error: { code: 'daemon_unavailable', message: error.message } }
  }
  return {
    exitCode: 1,
    help: false,
    error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) },
  }
}

export function parseRunRequest(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): HeadlessRunRequest {
  let project = ''
  let branch = 'main'
  let agentId = environment.GGAI_AGENT_ID?.trim() || 'codex'
  let wait = false
  const prompt: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--project') project = args[++index] ?? ''
    else if (argument === '--branch') branch = args[++index] ?? ''
    else if (argument === '--agent') agentId = args[++index] ?? ''
    else if (argument === '--wait') wait = true
    else if (argument.startsWith('--')) throw new CliUsageError(`unknown run option: ${argument}`)
    else prompt.push(argument)
  }
  const normalizedPrompt = prompt.join(' ').trim()
  if (!normalizedPrompt) throw new CliUsageError('run requires a prompt')
  if (!project.trim()) throw new CliUsageError('run requires --project')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u.test(branch) || branch.includes('..')) {
    throw new CliUsageError('--branch is invalid')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u.test(agentId) || agentId.includes('..')) {
    throw new CliUsageError('--agent is invalid')
  }
  return { project: project.trim(), prompt: normalizedPrompt, branch, agentId, wait }
}

function writeRunEvent(io: CliIo, json: boolean, runId: string, event: CanvasAgentEvent): void {
  const progress = runEventProgress(event)
  if (!progress) return
  if (json) {
    io.stderr(`${JSON.stringify({ schemaVersion: 1, type: 'run-event', runId, event: progress })}\n`)
  } else {
    io.stderr(`[${progress.type}] ${progress.message}\n`)
  }
}

function runEventProgress(event: CanvasAgentEvent): { type: string; message: string } | null {
  if (event.type === 'thinking') return { type: 'thinking', message: event.text }
  if (event.type === 'text-delta') return null
  if (event.type === 'tool-call') return { type: 'tool', message: event.name }
  if (event.type === 'tool-result') return { type: 'tool', message: 'completed' }
  if (event.type === 'file-write') return { type: 'artifact', message: 'output updated' }
  if (event.type === 'permission-request') {
    return { type: 'permission', message: `${event.action} denied by default` }
  }
  if (event.type === 'usage') return null
  if (event.type === 'error') return { type: 'warning', message: event.message }
  return { type: 'done', message: event.stopReason }
}

function runResultText(result: HeadlessRunResult): string {
  const lines = [
    `${result.status === 'started' ? 'Started' : 'Finished'} ${result.runId}`,
    `Task: ${result.taskId}`,
  ]
  if (result.artifacts.length > 0) {
    lines.push('Artifacts:')
    for (const artifact of result.artifacts) {
      lines.push(`  ${artifact.artifactId}\t${artifact.mediaType}\t${artifact.relativePath}`)
    }
  }
  return lines.join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
