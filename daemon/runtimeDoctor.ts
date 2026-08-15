import type { AgentDescriptor } from './protocol.js'
import type {
  AgentRuntimeDiagnosticSnapshot,
} from './agentRuntime.js'
import type { AgentRegistry } from './registry.js'

export const RUNTIME_DOCTOR_SCHEMA_VERSION = 1 as const

export interface RuntimeDoctorReport {
  readonly schemaVersion: typeof RUNTIME_DOCTOR_SCHEMA_VERSION
  readonly status: 'ok' | 'degraded'
  readonly runtime: AgentRuntimeDiagnosticSnapshot
  readonly agents: readonly AgentDescriptor[]
  readonly problems: readonly {
    readonly code: string
    readonly message: string
  }[]
}

export async function inspectRuntimeDoctor(
  registry: AgentRegistry,
): Promise<RuntimeDoctorReport> {
  const runtime = registry.runtimeDiagnostics()
  const agents = await registry.probe()
  const problems = [
    ...runtime.eventFailures.map((failure) => ({
      code: 'runtime_event_listener_failed',
      message: `${failure.event}: ${failure.error.message}`,
    })),
    ...agents.filter((agent) => !agent.available).map((agent) => ({
      code: 'agent_transport_unavailable',
      message: `${agent.id}: ${agent.detail ?? 'transport unavailable'}`,
    })),
  ]
  return Object.freeze({
    schemaVersion: RUNTIME_DOCTOR_SCHEMA_VERSION,
    status: problems.length === 0 ? 'ok' : 'degraded',
    runtime,
    agents: Object.freeze(agents.map((agent) => ({
      ...agent,
      models: [...agent.models],
    }))),
    problems: Object.freeze(problems.map((problem) => Object.freeze(problem))),
  })
}
