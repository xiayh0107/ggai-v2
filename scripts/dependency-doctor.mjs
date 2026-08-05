import { spawnSync } from 'node:child_process'
import process from 'node:process'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function summary(result) {
  return (result.stdout || result.stderr || '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
}

console.log(`Node.js: ${process.version}`)

const npmVersion = run(npmCommand, ['--version'])
if (npmVersion.status !== 0) {
  console.error('npm: unavailable')
  process.exitCode = 1
} else {
  console.log(`npm: ${summary(npmVersion)}`)
}

const registry = run(npmCommand, ['config', 'get', 'registry'])
console.log(`npm registry: ${registry.status === 0 ? summary(registry) : 'unavailable'}`)

const dependencyTree = run(npmCommand, ['ls', '--all'])
if (dependencyTree.status !== 0) {
  console.error('npm dependency tree: invalid')
  console.error((dependencyTree.stderr || dependencyTree.stdout).trim())
  process.exitCode = 1
} else {
  console.log('npm dependency tree: valid')
}

const agents = [
  { command: 'codex', args: ['--version'], authArgs: ['login', 'status'], label: 'Codex' },
  { command: 'acpx', args: ['--version'], label: 'acpx' },
]

let availableAgents = 0
for (const agent of agents) {
  const probe = run(agent.command, agent.args)
  if (probe.status !== 0) {
    console.log(`${agent.label}: not installed (optional)`)
    continue
  }

  availableAgents += 1
  const locator = run(process.platform === 'win32' ? 'where.exe' : 'which', [agent.command])
  const binaryPath = locator.status === 0 ? summary(locator) : agent.command
  console.log(`${agent.label}: ${summary(probe) || 'available'} (${binaryPath})`)

  if (agent.authArgs) {
    const auth = run(agent.command, agent.authArgs)
    console.log(`${agent.label} auth: ${auth.status === 0 ? summary(auth) || 'authenticated' : 'not authenticated'}`)
  }
}

if (availableAgents === 0) {
  console.error('No Agent CLI is available; install and authenticate Codex or install acpx')
  process.exitCode = 1
}
