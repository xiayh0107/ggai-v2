import type { CapabilityProfileSnapshot } from './composition.js'
import type { RuntimeEventFailure } from './events.js'
import type { CapabilityPluginHost, CapabilityPluginManifest } from './pluginHost.js'
import type { ServiceProviderSnapshot } from './services.js'

export const CAPABILITY_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION = 1 as const

export interface RuntimeFailureSnapshot {
  readonly event: string
  readonly listenerIndex: number
  readonly error: {
    readonly name: string
    readonly message: string
  }
}

export interface CapabilityRuntimeDiagnosticSnapshot {
  readonly schemaVersion: typeof CAPABILITY_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION
  readonly profile: CapabilityProfileSnapshot
  readonly plugins: readonly CapabilityPluginManifest[]
  readonly services: readonly ServiceProviderSnapshot[]
  readonly eventFailures: readonly RuntimeFailureSnapshot[]
}

export function inspectCapabilityRuntime(
  host: CapabilityPluginHost,
  profile: CapabilityProfileSnapshot,
): CapabilityRuntimeDiagnosticSnapshot {
  return Object.freeze({
    schemaVersion: CAPABILITY_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION,
    profile,
    plugins: Object.freeze(host.list()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((manifest) => Object.freeze({ ...manifest }))),
    services: Object.freeze(host.services.snapshot()),
    eventFailures: Object.freeze(host.eventFailures().map(snapshotFailure)),
  })
}

function snapshotFailure(failure: RuntimeEventFailure): RuntimeFailureSnapshot {
  const error = failure.error instanceof Error
    ? { name: failure.error.name, message: failure.error.message }
    : { name: 'Error', message: String(failure.error) }
  return Object.freeze({
    event: failure.event,
    listenerIndex: failure.listenerIndex,
    error: Object.freeze(error),
  })
}
