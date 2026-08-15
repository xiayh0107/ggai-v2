import type { AgentTransportCatalog } from './transport/types.js'

export const GENERATION_SERVICE_PREFLIGHT_SCHEMA_VERSION = 1 as const

export type GenerationServicePreflightState =
  | 'ready'
  | 'not-found'
  | 'not-authenticated'
  | 'unavailable'
  | 'probe-failed'

export type GenerationServicePreflightIssueCode =
  | 'generation_service_not_found'
  | 'generation_service_not_authenticated'
  | 'generation_service_unavailable'
  | 'generation_service_probe_failed'

export interface GenerationServicePreflightReport {
  readonly schemaVersion: typeof GENERATION_SERVICE_PREFLIGHT_SCHEMA_VERSION
  readonly agentId: string
  readonly state: GenerationServicePreflightState
  readonly ready: boolean
  readonly retryable: boolean
  readonly issue?: {
    readonly code: GenerationServicePreflightIssueCode
  }
}

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u

/**
 * Product-facing readiness projection for a single configured generation
 * service. It deliberately omits provider ids, executable paths, versions,
 * capability digests and raw probe diagnostics.
 */
export async function inspectGenerationServicePreflight(
  catalog: AgentTransportCatalog,
  agentId: string,
): Promise<GenerationServicePreflightReport> {
  assertAgentId(agentId)
  let descriptors
  try {
    descriptors = await catalog.probe()
  } catch {
    return report(agentId, 'probe-failed', 'generation_service_probe_failed')
  }

  const descriptor = descriptors.find((candidate) => candidate.id === agentId)
  if (!descriptor) {
    return report(agentId, 'not-found', 'generation_service_not_found')
  }
  if (descriptor.available) {
    return Object.freeze({
      schemaVersion: GENERATION_SERVICE_PREFLIGHT_SCHEMA_VERSION,
      agentId,
      state: 'ready',
      ready: true,
      retryable: false,
    })
  }
  if (descriptor.authStatus === 'unauthenticated') {
    return report(
      agentId,
      'not-authenticated',
      'generation_service_not_authenticated',
    )
  }
  return report(agentId, 'unavailable', 'generation_service_unavailable')
}

function report(
  agentId: string,
  state: Exclude<GenerationServicePreflightState, 'ready'>,
  code: GenerationServicePreflightIssueCode,
): GenerationServicePreflightReport {
  return Object.freeze({
    schemaVersion: GENERATION_SERVICE_PREFLIGHT_SCHEMA_VERSION,
    agentId,
    state,
    ready: false,
    retryable: true,
    issue: Object.freeze({ code }),
  })
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID.test(agentId) || agentId.includes('..') || agentId.includes('//')) {
    throw new TypeError('agentId is invalid')
  }
}
