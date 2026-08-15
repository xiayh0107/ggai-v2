#!/usr/bin/env node
import process from 'node:process'
import { DaemonApplication } from './application.js'
import { DAEMON_HELP, parseDaemonConfig } from './startupOptions.js'

async function main(): Promise<void> {
  const config = parseDaemonConfig(process.argv.slice(2))
  if (!config) {
    console.log(DAEMON_HELP)
    return
  }
  const application = new DaemonApplication(config)
  if (config.operation === 'dump-runtime') {
    console.log(JSON.stringify(application.runtimeDiagnostics(), null, 2))
    await application.close()
    return
  }
  if (config.operation === 'runtime-doctor') {
    const report = await application.runtimeDoctor()
    console.log(JSON.stringify(report, null, 2))
    await application.close()
    if (report.status !== 'ok') process.exitCode = 1
    return
  }

  await application.listen()
  console.log(`GGAI daemon listening on http://${config.host}:${config.port}`)
  console.log(`Project root: ${config.projectRoot}`)
  console.log('Canvas: ready')

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await application.close()
  }
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
