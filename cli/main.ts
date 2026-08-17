import {
  WorkspaceProjectClient,
  WorkspaceProjectProtocolError,
  WorkspaceProjectRequestError,
  type WorkspaceProject,
} from '../src/workspace/projectClient.js'
import {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
