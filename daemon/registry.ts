import {
  installBuiltinAgentTransportPlugins,
  type AgentRuntimeDiagnosticSnapshot,
  type AgentRuntimeOptions,
} from './agentRuntime.js'
import { AgentTransportRegistry } from './transport/registry.js'

export type AgentRegistryOptions = AgentRuntimeOptions

const EMPTY_RUNTIME_ID = '@ggai/empty-agent-runtime'

/**
 * Provider-neutral daemon facade. An omitted constructor argument creates an
 * empty registry; builtin transports mount only when a composition root passes
 * an explicit options object (including `{}`).
 */
export class AgentRegistry extends AgentTransportRegistry {
  readonly #runtime

  constructor(options?: AgentRegistryOptions) {
    super()
    this.#runtime = options === undefined
      ? null
      : installBuiltinAgentTransportPlugins(this, options)
  }

  runtimeDiagnostics(): AgentRuntimeDiagnosticSnapshot {
    if (this.#runtime) return this.#runtime.diagnostics()
    return Object.freeze({
      schemaVersion: 1,
      profile: Object.freeze({
        schemaVersion: 1,
        id: EMPTY_RUNTIME_ID,
        version: '1.0.0',
        bundles: Object.freeze([]),
      }),
      plugins: Object.freeze([]),
      services: Object.freeze([]),
      eventFailures: Object.freeze([]),
      agentTransports: Object.freeze(this.snapshot()),
    })
  }

  dispose(): Promise<void> {
    return this.#runtime?.dispose() ?? Promise.resolve()
  }
}
