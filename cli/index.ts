#!/usr/bin/env node
import process from 'node:process'
import { ensureDaemonAvailable } from './daemon.js'
import { runCli } from './main.js'

const exitCode = await runCli(process.argv.slice(2), {
  io: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  environment: process.env,
  ensureDaemon: (input) => ensureDaemonAvailable({
    ...input,
    onStarted: (url) => process.stderr.write(`[daemon] started ${url}\n`),
  }),
})
process.exitCode = exitCode
