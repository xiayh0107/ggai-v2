import {
  installBuiltinAgentTransportPlugins,
  type AgentRuntimeDiagnosticSnapshot,
  type AgentRuntimeOptions,
} from './agentRuntime.js'
import { AgentTransportRegistry } from './transport/registry.js'

export type AgentRegistryOptions = AgentRuntimeOptions

/**
 * Backwards-compatible daemon facade. The registry itself is provider-neutral;
 * built-in transports are mounted through the CapabilityPluginHost.
 */
export class AgentRegistry extends AgentTransportRegistry {
  readonly #runtime

  constructor(options: AgentRegistryOptions = {}) {
    super()
    this.#runtime = installBuiltinAgentTransportPlugins(this, options)
  }

  runtimeDiagnostics(): AgentRuntimeDiagnosticSnapshot {
    return this.#runtime.diagnostics()
  }

  dispose(): Promise<void> {
    return this.#runtime.dispose()
  }
}
