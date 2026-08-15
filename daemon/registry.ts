import {
  installBuiltinAgentTransportPlugins,
  installEmptyAgentRuntime,
  type AgentRuntimeDiagnosticSnapshot,
  type AgentRuntimeOptions,
} from './agentRuntime.js'
import type { ServiceScope } from './runtime/services.js'
import { AgentTransportRegistry } from './transport/registry.js'

export type AgentRegistryOptions = AgentRuntimeOptions

/**
 * Provider-neutral daemon facade. An omitted constructor argument creates an
 * empty profile; builtin transports mount only when a composition root passes
 * an explicit options object (including `{}`).
 */
export class AgentRegistry extends AgentTransportRegistry {
  readonly #runtime

  constructor(options?: AgentRegistryOptions) {
    super()
    this.#runtime = options === undefined
      ? installEmptyAgentRuntime(this)
      : installBuiltinAgentTransportPlugins(this, options)
  }

  get runtimeServices(): ServiceScope {
    return this.#runtime.services
  }

  runtimeDiagnostics(): AgentRuntimeDiagnosticSnapshot {
    return this.#runtime.diagnostics()
  }

  dispose(): Promise<void> {
    return this.#runtime.dispose()
  }
}
