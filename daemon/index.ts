#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { AgentRegistry } from './registry.js'
import { createDaemonServer } from './server.js'

interface DaemonConfig {
  host: '127.0.0.1'
  port: number
  projectRoot: string
  allowedOrigins: string[]
  acpxAgents: string[]
  acpxApprovalMode: 'approve-all' | 'approve-reads' | 'deny-all'
  codexCommand: string
  acpxCommand: string
}

function parseConfig(argv: string[]): DaemonConfig {
  let port = Number(process.env.GGAI_DAEMON_PORT ?? 7380)
  let projectRoot = process.env.GGAI_PROJECT_ROOT ?? process.cwd()
  const allowedOrigins = (process.env.GGAI_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  // acpx is pre-1.0 and its public CLI cannot revoke a queued request by id
  // across an unclean daemon restart. Keep it an explicit operator opt-in.
  const acpxAgents = (process.env.GGAI_ACPX_AGENTS ?? '')
    .split(',')
    .map((agent) => agent.trim())
    .filter(Boolean)
  let acpxApprovalMode = parseAcpxApprovalMode(
    process.env.GGAI_ACPX_APPROVAL_MODE ?? 'approve-reads',
  )
  let codexCommand = process.env.GGAI_CODEX_COMMAND ?? 'codex'
  let acpxCommand = process.env.GGAI_ACPX_COMMAND ?? 'acpx'

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
    } else if (argument === '--help' || argument === '-h') {
      console.log([
        'Usage: ggai-daemon [--port 7380] [--project-root DIR] [--allow-origin ORIGIN]',
        '                   [--acpx-agent ID] [--acpx-approval approve-reads|deny-all|approve-all]',
        '                   [--codex-command FILE] [--acpx-command FILE]',
        '',
        'The server always binds to 127.0.0.1.',
        'acpx adapters are experimental and disabled until --acpx-agent is provided.',
      ].join('\n'))
      process.exit(0)
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

const config = parseConfig(process.argv.slice(2))
const registry = new AgentRegistry({
  acpxAgents: config.acpxAgents,
  acpxApprovalMode: config.acpxApprovalMode,
  codexCommand: config.codexCommand,
  acpxCommand: config.acpxCommand,
})
const daemon = createDaemonServer({ ...config, registry })

daemon.server.listen(config.port, config.host, () => {
  console.log(`GGAI daemon listening on http://${config.host}:${config.port}`)
  console.log(`Project root: ${config.projectRoot}`)
})

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  await daemon.close()
}
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
