#!/usr/bin/env node
import process from 'node:process'
import { AgentRegistry } from './registry.js'
import { createDaemonServer } from './server.js'
import { DAEMON_HELP, parseDaemonConfig } from './startupOptions.js'

async function main(): Promise<void> {
  const config = parseDaemonConfig(process.argv.slice(2))
  if (!config) {
    console.log(DAEMON_HELP)
    return
  }
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
    console.log('Canvas: ready')
  })

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await daemon.close()
  }
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
