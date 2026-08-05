import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { AgentDescriptor } from './protocol.js'
import { AcpxTransport } from './transport/acpx.js'
import { CodexTransport } from './transport/codex.js'
import type { AgentProcessTransport } from './transport/types.js'

interface ProbeResult {
  found: boolean
  code: number | null
  output: string
  binaryPath?: string
}

const PROBE_CACHE_MS = 5_000

function resolveExecutable(command: string): string | undefined {
  const hasPathSeparator = command.includes('/') || command.includes('\\')
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : ['']
  const directories = hasPathSeparator
    ? ['']
    : (process.env.PATH ?? '').split(path.delimiter)
  const baseCommand = hasPathSeparator ? path.resolve(command) : command

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = hasPathSeparator
        ? `${baseCommand}${extension}`
        : path.resolve(directory || '.', `${baseCommand}${extension}`)
      try {
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        try {
          return realpathSync(candidate)
        } catch {
          return candidate
        }
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined
}

async function runProbe(command: string, args: string[], timeoutMs = 4_000): Promise<ProbeResult> {
  const binaryPath = resolveExecutable(command)
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn(binaryPath ?? command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, binaryPath })
    }
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-16_384)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({ found: error.code !== 'ENOENT', code: null, output: error.message })
    })
    child.once('close', (code) => finish({ found: true, code, output: output.trim() }))
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ found: true, code: null, output: 'probe timed out' })
    }, timeoutMs)
    timer.unref()
  })
}

function lastUsefulLine(output: string): string | undefined {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
}

function missingOptions(output: string, required: string[]): string[] {
  const tokens = new Set(output.match(/--?[A-Za-z0-9][A-Za-z0-9-]*/gu) ?? [])
  return required.filter((option) => !tokens.has(option))
}

function compatibilityError(
  probes: ProbeResult[],
  requirements: Array<{ label: string; options: string[] }>,
): string | undefined {
  const failed = probes.find((probe) => probe.code !== 0)
  if (failed) return failed.output || 'capability probe failed'
  const missing = probes.flatMap((probe, index) =>
    missingOptions(probe.output, requirements[index]?.options ?? [])
      .map((option) => `${requirements[index]?.label ?? 'CLI'} ${option}`))
  return missing.length > 0 ? `missing required CLI capabilities: ${missing.join(', ')}` : undefined
}

export interface AgentRegistryOptions {
  acpxAgents?: string[]
  codexCommand?: string
  acpxCommand?: string
  acpxApprovalMode?: 'approve-all' | 'approve-reads' | 'deny-all'
}

export class AgentRegistry {
  readonly #codexCommand: string
  readonly #acpxCommand: string
  readonly #acpxApprovalFlag: '--approve-all' | '--approve-reads' | '--deny-all'
  readonly #acpxAgents: string[]
  readonly #acpxAgentIds: Set<string>
  readonly #codex: CodexTransport
  readonly #acpx: AcpxTransport
  #cachedProbe: { expiresAt: number; descriptors: AgentDescriptor[] } | null = null
  #probeInFlight: Promise<AgentDescriptor[]> | null = null

  constructor(options: AgentRegistryOptions = {}) {
    const codexCommand = options.codexCommand ?? 'codex'
    const acpxCommand = options.acpxCommand ?? 'acpx'
    // Freeze PATH/relative-path resolution once. Probes and runs must execute
    // the exact same binary even though transports use a different cwd.
    this.#codexCommand = resolveExecutable(codexCommand) ?? codexCommand
    this.#acpxCommand = resolveExecutable(acpxCommand) ?? acpxCommand
    this.#acpxApprovalFlag = `--${options.acpxApprovalMode ?? 'approve-reads'}`
    this.#acpxAgents = [...new Set(options.acpxAgents ?? [])]
    for (const agent of this.#acpxAgents) assertConfiguredAgent(agent)
    this.#acpxAgentIds = new Set(this.#acpxAgents.map((agent) => `acpx:${agent}`))
    this.#codex = new CodexTransport({ command: this.#codexCommand })
    this.#acpx = new AcpxTransport({
      command: this.#acpxCommand,
      approvalMode: options.acpxApprovalMode,
    })
  }

  async probe(): Promise<AgentDescriptor[]> {
    if (this.#cachedProbe && this.#cachedProbe.expiresAt > Date.now()) {
      return cloneDescriptors(this.#cachedProbe.descriptors)
    }
    if (this.#probeInFlight) return cloneDescriptors(await this.#probeInFlight)

    this.#probeInFlight = this.#probeFresh()
    try {
      const descriptors = await this.#probeInFlight
      this.#cachedProbe = { expiresAt: Date.now() + PROBE_CACHE_MS, descriptors }
      return cloneDescriptors(descriptors)
    } finally {
      this.#probeInFlight = null
    }
  }

  async #probeFresh(): Promise<AgentDescriptor[]> {
    const [codexVersion, acpxVersion] = await Promise.all([
      runProbe(this.#codexCommand, ['--version']),
      this.#acpxAgents.length > 0
        ? runProbe(this.#acpxCommand, ['--version'])
        : Promise.resolve(null),
    ])
    const descriptors: AgentDescriptor[] = []

    if (codexVersion.found) {
      const [login, execHelp, resumeHelp] = codexVersion.code === 0
        ? await Promise.all([
            runProbe(this.#codexCommand, ['login', 'status']),
            runProbe(this.#codexCommand, ['exec', '--help']),
            runProbe(this.#codexCommand, ['exec', 'resume', '--help']),
          ])
        : [null, null, null]
      const incompatibility = execHelp && resumeHelp
        ? compatibilityError(
            [execHelp, resumeHelp],
            [
              {
                label: 'codex exec',
                options: ['--json', '--color', '--sandbox', '--cd', '--add-dir', '--skip-git-repo-check'],
              },
              { label: 'codex exec resume', options: ['--json'] },
            ],
          )
        : undefined
      const authenticated = login?.code === 0 && /logged in|authenticated/i.test(login.output)
      descriptors.push({
        id: 'codex',
        label: 'Codex',
        transport: 'codex',
        available: codexVersion.code === 0 && incompatibility === undefined,
        authStatus: authenticated ? 'authenticated' : login?.code === 0 ? 'unknown' : 'unauthenticated',
        version: codexVersion.code === 0 ? lastUsefulLine(codexVersion.output) : undefined,
        binaryPath: codexVersion.binaryPath,
        detail: codexVersion.code === 0 ? incompatibility : codexVersion.output,
        models: [],
      })
    }

    // acpx is experimental. Do not execute a binary found on PATH until the
    // operator explicitly opts in to at least one adapter.
    if (!acpxVersion) return descriptors

    const acpxHelp = acpxVersion.code === 0
      ? await runProbe(this.#acpxCommand, ['--help'])
      : null
    const acpxIncompatibility = acpxHelp
      ? compatibilityError(
          [acpxHelp],
          [{
            label: 'acpx',
            options: [
              '--cwd',
              '--format',
              '--json-strict',
              '--non-interactive-permissions',
              this.#acpxApprovalFlag,
            ],
          }],
        )
      : undefined

    const adapterProbes = acpxVersion.code === 0 && acpxIncompatibility === undefined
      ? await Promise.all(this.#acpxAgents.map(async (agent) => {
          const [prompt, ensure, cancel] = await Promise.all([
            runProbe(this.#acpxCommand, [agent, 'prompt', '--help']),
            runProbe(this.#acpxCommand, [agent, 'sessions', 'ensure', '--help']),
            runProbe(this.#acpxCommand, [agent, 'cancel', '--help']),
          ])
          return { agent, prompt, ensure, cancel }
        }))
      : []
    const probesByAgent = new Map(adapterProbes.map((probe) => [probe.agent, probe]))

    for (const agent of this.#acpxAgents) {
      const adapterProbe = probesByAgent.get(agent)
      const adapterIncompatibility = adapterProbe
        ? compatibilityError(
            [adapterProbe.prompt, adapterProbe.ensure, adapterProbe.cancel],
            [
              { label: `acpx ${agent} prompt`, options: ['-s'] },
              { label: `acpx ${agent} sessions ensure`, options: ['--name'] },
              { label: `acpx ${agent} cancel`, options: ['-s'] },
            ],
          )
        : undefined
      const incompatibility = acpxIncompatibility ?? adapterIncompatibility
      descriptors.push({
        id: `acpx:${agent}`,
        label: agent,
        transport: 'acpx',
        available: acpxVersion.found && acpxVersion.code === 0 && incompatibility === undefined,
        authStatus: acpxVersion.code === 0 ? 'unknown' : 'not-applicable',
        version: acpxVersion.code === 0 ? lastUsefulLine(acpxVersion.output) : undefined,
        binaryPath: acpxVersion.binaryPath,
        detail: acpxVersion.code === 0
          ? incompatibility
          : acpxVersion.found ? acpxVersion.output : 'acpx is not installed',
        models: [],
      })
    }
    return descriptors
  }

  resolve(agentId: string): AgentProcessTransport | null {
    if (agentId === 'codex') return this.#codex
    if (this.#acpxAgentIds.has(agentId)) return this.#acpx
    return null
  }
}

function assertConfiguredAgent(agent: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u.test(agent)
    || agent.includes('..')
    || agent.includes('//')
  ) {
    throw new Error(`invalid configured acpx agent id: ${agent}`)
  }
}

function cloneDescriptors(descriptors: AgentDescriptor[]): AgentDescriptor[] {
  return descriptors.map((descriptor) => ({ ...descriptor, models: [...descriptor.models] }))
}
