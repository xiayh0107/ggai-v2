import { createAcpxAgentTransportPlugin } from './plugins/agentTransport/acpx.js'
import { createCodexAgentTransportPlugin } from './plugins/agentTransport/codex.js'
import {
  CAPABILITY_PROFILE_SCHEMA_VERSION,
  inspectCapabilityProfile,
  mountCapabilityProfileSync,
  type CapabilityBundle,
  type CapabilityProfile,
  type CapabilityProfileSnapshot,
} from './runtime/composition.js'
import {
  inspectCapabilityRuntime,
  type CapabilityRuntimeDiagnosticSnapshot,
} from './runtime/diagnostics.js'
import {
  CapabilityPluginHost,
  type SynchronousCapabilityPlugin,
} from './runtime/pluginHost.js'
import type { ServiceScope } from './runtime/services.js'
import {
  AGENT_TRANSPORT_REGISTRY_SERVICE,
  AgentTransportRegistry,
  type AgentTransportProviderSnapshot,
} from './transport/registry.js'

export interface AgentRuntimeOptions {
  acpxAgents?: string[]
  codexCommand?: string
  acpxCommand?: string
  acpxApprovalMode?: 'approve-all' | 'approve-reads' | 'deny-all'
}

export interface AgentRuntimeDiagnosticSnapshot extends CapabilityRuntimeDiagnosticSnapshot {
  readonly agentTransports: readonly AgentTransportProviderSnapshot[]
}

export interface AgentRuntimeInstallation {
  readonly host: CapabilityPluginHost
  readonly services: ServiceScope
  readonly profile: CapabilityProfileSnapshot
  diagnostics(): AgentRuntimeDiagnosticSnapshot
  dispose(): Promise<void>
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

export function createEmptyAgentRuntimeProfile(): CapabilityProfile<SynchronousCapabilityPlugin> {
  return {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    id: '@ggai/empty-agent-runtime',
    version: '1.0.0',
    bundles: [],
  }
}

export function installBuiltinAgentTransportPlugins(
  registry: AgentTransportRegistry,
  options: AgentRuntimeOptions = {},
): AgentRuntimeInstallation {
  return installAgentRuntime(registry, createBuiltinAgentRuntimeProfile(options))
}

export function installEmptyAgentRuntime(
  registry: AgentTransportRegistry,
): AgentRuntimeInstallation {
  return installAgentRuntime(registry, createEmptyAgentRuntimeProfile())
}

function installAgentRuntime(
  registry: AgentTransportRegistry,
  profile: CapabilityProfile<SynchronousCapabilityPlugin>,
): AgentRuntimeInstallation {
  const host = new CapabilityPluginHost()
  host.services.provide(
    AGENT_TRANSPORT_REGISTRY_SERVICE,
    registry,
    '@ggai/agent-runtime',
  )
  const profileSnapshot = inspectCapabilityProfile(profile)
  const unmountProfile = mountCapabilityProfileSync(host, profile)
  let disposePromise: Promise<void> | null = null
  return {
    host,
    services: host.services,
    profile: profileSnapshot,
    diagnostics: () => Object.freeze({
      ...inspectCapabilityRuntime(host, profileSnapshot),
      agentTransports: Object.freeze(registry.snapshot()),
    }),
    dispose() {
      disposePromise ??= disposeAgentRuntime(unmountProfile, host)
      return disposePromise
    },
  }
}

async function disposeAgentRuntime(
  unmountProfile: () => void | Promise<void>,
  host: CapabilityPluginHost,
): Promise<void> {
  const errors: unknown[] = []
  try {
    await unmountProfile()
  } catch (error) {
    errors.push(error)
  }
  try {
    await host.dispose()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Agent runtime disposal failed')
  }
}
