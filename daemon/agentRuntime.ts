import { createAcpxAgentTransportPlugin } from './plugins/agentTransport/acpx.js'
import { createCodexAgentTransportPlugin } from './plugins/agentTransport/codex.js'
import {
  CAPABILITY_PROFILE_SCHEMA_VERSION,
  mountCapabilityProfileSync,
  type CapabilityBundle,
  type CapabilityProfile,
} from './runtime/composition.js'
import {
  CapabilityPluginHost,
  type SynchronousCapabilityPlugin,
} from './runtime/pluginHost.js'
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

export function createBuiltinAgentRuntimeProfile(
  options: AgentRuntimeOptions = {},
): CapabilityProfile<SynchronousCapabilityPlugin> {
  const bundles: CapabilityBundle<SynchronousCapabilityPlugin>[] = [{
    id: '@ggai/codex-transport-bundle',
    version: '1.0.0',
    plugins: [createCodexAgentTransportPlugin({ command: options.codexCommand })],
  }]
  if ((options.acpxAgents?.length ?? 0) > 0) {
    bundles.push({
      id: '@ggai/acpx-transport-bundle',
      version: '1.0.0',
      plugins: [createAcpxAgentTransportPlugin({
        agents: options.acpxAgents ?? [],
        command: options.acpxCommand,
        approvalMode: options.acpxApprovalMode,
      })],
    })
  }
  return {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    id: '@ggai/default-agent-runtime',
    version: '1.0.0',
    bundles,
  }
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
  mountCapabilityProfileSync(host, createBuiltinAgentRuntimeProfile(options))
  return host
}
