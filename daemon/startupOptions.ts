import path from 'node:path'

export type DaemonOperation = 'serve' | 'dump-runtime' | 'runtime-doctor'

export interface DaemonConfig {
  operation: DaemonOperation
  host: '127.0.0.1'
  port: number
  projectRoot: string
  allowedOrigins: string[]
  acpxAgents: string[]
  acpxApprovalMode: 'approve-all' | 'approve-reads' | 'deny-all'
  codexCommand: string
  acpxCommand: string
}

export const DAEMON_HELP = [
  'Usage: ggai-daemon [--port 7380] [--project-root DIR] [--allow-origin ORIGIN]',
  '                   [--acpx-agent ID] [--acpx-approval approve-reads|deny-all|approve-all]',
  '                   [--codex-command FILE] [--acpx-command FILE]',
  '                   [--dump-runtime | --runtime-doctor]',
  '',
  'The server always binds to 127.0.0.1 and runs Canvas.',
  'Workspace Projects are created and initialized through the daemon-owned catalog.',
  'acpx adapters are experimental and disabled until --acpx-agent is provided.',
  'Runtime diagnostics are JSON and never include service instances or credentials.',
].join('\n')

export function parseDaemonConfig(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): DaemonConfig | null {
  let operation: DaemonOperation = 'serve'
  let port = Number(environment.GGAI_DAEMON_PORT ?? 7380)
  let projectRoot = environment.GGAI_PROJECT_ROOT ?? process.cwd()
  const allowedOrigins = (environment.GGAI_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  // acpx is pre-1.0 and its public CLI cannot revoke a queued request by id
  // across an unclean daemon restart. Keep it an explicit operator opt-in.
  const acpxAgents = (environment.GGAI_ACPX_AGENTS ?? '')
    .split(',')
    .map((agent) => agent.trim())
    .filter(Boolean)
  let acpxApprovalMode = parseAcpxApprovalMode(
    environment.GGAI_ACPX_APPROVAL_MODE ?? 'approve-reads',
  )
  let codexCommand = environment.GGAI_CODEX_COMMAND ?? 'codex'
  let acpxCommand = environment.GGAI_ACPX_COMMAND ?? 'acpx'

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--port') {
      port = Number(argv[++index])
    } else if (argument === '--project-root') {
      projectRoot = argv[++index] ?? ''
    } else if (argument === '--allow-origin') {
      const origin = argv[++index]
      if (!origin) throw new Error('--allow-origin requires a value')
      allowedOrigins.push(origin)
    } else if (argument === '--acpx-agent') {
      const agent = argv[++index]
      if (!agent) throw new Error('--acpx-agent requires a value')
      acpxAgents.push(agent)
    } else if (argument === '--acpx-approval') {
      acpxApprovalMode = parseAcpxApprovalMode(argv[++index] ?? '')
    } else if (argument === '--codex-command') {
      codexCommand = parseCommand(argv[++index] ?? '', '--codex-command')
    } else if (argument === '--acpx-command') {
      acpxCommand = parseCommand(argv[++index] ?? '', '--acpx-command')
    } else if (argument === '--dump-runtime') {
      operation = selectOperation(operation, 'dump-runtime')
    } else if (argument === '--runtime-doctor') {
      operation = selectOperation(operation, 'runtime-doctor')
    } else if (argument === '--help' || argument === '-h') {
      return null
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port: ${port}`)
  }
  if (!projectRoot.trim()) throw new Error('project root must not be empty')
  codexCommand = parseCommand(codexCommand, 'Codex command')
  acpxCommand = parseCommand(acpxCommand, 'acpx command')
  return {
    operation,
    host: '127.0.0.1',
    port,
    projectRoot: path.resolve(projectRoot),
    allowedOrigins,
    acpxAgents: [...new Set(acpxAgents)],
    acpxApprovalMode,
    codexCommand,
    acpxCommand,
  }
}

function selectOperation(
  current: DaemonOperation,
  requested: Exclude<DaemonOperation, 'serve'>,
): DaemonOperation {
  if (current !== 'serve' && current !== requested) {
    throw new Error('--dump-runtime and --runtime-doctor cannot be combined')
  }
  return requested
}

function parseAcpxApprovalMode(value: string): DaemonConfig['acpxApprovalMode'] {
  if (value === 'approve-all' || value === 'approve-reads' || value === 'deny-all') return value
  throw new Error(`invalid acpx approval mode: ${value}`)
}

function parseCommand(value: string, label: string): string {
  const command = value.trim()
  if (!command || [...command].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })) {
    throw new Error(`${label} must be a non-empty command or executable path`)
  }
  return command
}
