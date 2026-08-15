import type { SynchronousCapabilityPlugin } from '../../runtime/pluginHost.js'
import {
  compatibilityError,
  lastUsefulLine,
  resolveExecutable,
  runProbe,
} from '../../transport/probe.js'
import {
  AGENT_TRANSPORT_REGISTRY_SERVICE,
  type AgentTransportProvider,
} from '../../transport/registry.js'
import { AcpxTransport } from '../../transport/acpx.js'

export interface AcpxAgentTransportPluginOptions {
  agents: string[]
  command?: string
  approvalMode?: 'approve-all' | 'approve-reads' | 'deny-all'
}

export function createAcpxAgentTransportPlugin(
  options: AcpxAgentTransportPluginOptions,
): SynchronousCapabilityPlugin {
  const agents = [...new Set(options.agents)]
  for (const agent of agents) assertConfiguredAgent(agent)
  const agentIds = agents.map((agent) => `acpx:${agent}`)
  const command = resolveExecutable(options.command ?? 'acpx') ?? options.command ?? 'acpx'
  const approvalFlag = `--${options.approvalMode ?? 'approve-reads'}` as const
  const transport = new AcpxTransport({ command, approvalMode: options.approvalMode })
  const provider: AgentTransportProvider = {
    id: '@ggai/agent-transport-acpx',
    agentIds,
    async probe() {
      const version = await runProbe(command, ['--version'])
      const help = version.code === 0 ? await runProbe(command, ['--help']) : null
      const incompatibility = help
        ? compatibilityError(
            [help],
            [{
              label: 'acpx',
              options: [
                '--cwd',
                '--format',
                '--json-strict',
                '--non-interactive-permissions',
                approvalFlag,
              ],
            }],
          )
        : undefined
      const adapterProbes = version.code === 0 && incompatibility === undefined
        ? await Promise.all(agents.map(async (agent) => {
            const [prompt, ensure, cancel] = await Promise.all([
              runProbe(command, [agent, 'prompt', '--help']),
              runProbe(command, [agent, 'sessions', 'ensure', '--help']),
              runProbe(command, [agent, 'cancel', '--help']),
            ])
            return { agent, prompt, ensure, cancel }
          }))
        : []
      const probesByAgent = new Map(adapterProbes.map((probe) => [probe.agent, probe]))
      return agents.map((agent) => {
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
        const detail = incompatibility ?? adapterIncompatibility
        return {
          id: `acpx:${agent}`,
          label: agent,
          transport: 'acpx' as const,
          available: version.found && version.code === 0 && detail === undefined,
          authStatus: version.code === 0 ? 'unknown' as const : 'not-applicable' as const,
          version: version.code === 0 ? lastUsefulLine(version.output) : undefined,
          binaryPath: version.binaryPath,
          detail: version.code === 0
            ? detail
            : version.found ? version.output : 'acpx is not installed',
          models: [],
        }
      })
    },
    resolve(agentId) {
      return agentIds.includes(agentId) ? transport : null
    },
  }

  return {
    manifest: {
      id: '@ggai/agent-transport-acpx',
      version: '1.0.0',
      apiVersion: 1,
      displayName: 'acpx transport',
    },
    activate(context) {
      return context.require(AGENT_TRANSPORT_REGISTRY_SERVICE).register(provider)
    },
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
