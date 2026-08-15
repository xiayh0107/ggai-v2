import { createAcpxAgentTransportPlugin } from './plugins/agentTransport/acpx.js'
import { createCodexAgentTransportPlugin } from './plugins/agentTransport/codex.js'
import { CapabilityPluginHost } from './runtime/pluginHost.js'
import {
  AGENT_TRANSPORT_REGISTRY_SERVICE,
  AgentTransportRegistry,
} from './transport/registry.js'

export interface AgentRuntimeOptions {
  acpxAgents?: string[]
  codexCommand?: string
  acpxCommand?: string
  acpxApprovalMode?: 'approve-all' | 'approve-reads' | 'deny-all'
}

export function installBuiltinAgentTransportPlugins(
  registry: AgentTransportRegistry,
  options: AgentRuntimeOptions = {},
): CapabilityPluginHost {
  const host = new CapabilityPluginHost()
  host.services.provide(
    AGENT_TRANSPORT_REGISTRY_SERVICE,
    registry,
    '@ggai/agent-runtime',
  )
  host.mountSync(createCodexAgentTransportPlugin({ command: options.codexCommand }))
  if ((options.acpxAgents?.length ?? 0) > 0) {
    host.mountSync(createAcpxAgentTransportPlugin({
      agents: options.acpxAgents ?? [],
      command: options.acpxCommand,
      approvalMode: options.acpxApprovalMode,
    }))
  }
  return host
}
