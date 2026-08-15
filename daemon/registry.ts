import {
  installBuiltinAgentTransportPlugins,
  type AgentRuntimeOptions,
} from './agentRuntime.js'
import { AgentTransportRegistry } from './transport/registry.js'

export type AgentRegistryOptions = AgentRuntimeOptions

/**
 * Backwards-compatible daemon facade. The registry itself is provider-neutral;
 * built-in transports are mounted through the CapabilityPluginHost.
 */
export class AgentRegistry extends AgentTransportRegistry {
  readonly #plugins

  constructor(options: AgentRegistryOptions = {}) {
    super()
    this.#plugins = installBuiltinAgentTransportPlugins(this, options)
  }

  dispose(): Promise<void> {
    return this.#plugins.dispose()
  }
}
