import type { AgentDescriptor } from '../protocol.js'
import type { Disposer } from '../runtime/effects.js'
import { defineService } from '../runtime/services.js'
import type {
  AgentProcessTransport,
  AgentTransportCatalog,
} from './types.js'

const PROBE_CACHE_MS = 5_000
const PROVIDER_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u

export interface AgentTransportProvider {
  readonly id: string
  readonly agentIds: readonly string[]
  probe(): Promise<AgentDescriptor[]>
  resolve(agentId: string): AgentProcessTransport | null
}

export interface AgentTransportProviderSnapshot {
  readonly id: string
  readonly agentIds: readonly string[]
}

interface RegisteredProvider {
  readonly id: string
  readonly provider: AgentTransportProvider
  readonly agentIds: string[]
}

interface ProbeFlight {
  readonly revision: number
  readonly promise: Promise<AgentDescriptor[]>
}

export const AGENT_TRANSPORT_REGISTRY_SERVICE =
  defineService<AgentTransportRegistry>('ggai.agent-transports.v1')

export class AgentTransportRegistry implements AgentTransportCatalog {
  readonly #providers = new Map<string, RegisteredProvider>()
  readonly #claims = new Map<string, RegisteredProvider>()
  #cachedProbe: { revision: number; expiresAt: number; descriptors: AgentDescriptor[] } | null = null
  #probeInFlight: ProbeFlight | null = null
  #revision = 0

  register(provider: AgentTransportProvider): Disposer {
    const agentIds = assertProvider(provider)
    const providerId = provider.id
    if (this.#providers.has(providerId)) {
      throw new Error(`agent transport provider is already registered: ${providerId}`)
    }
    for (const agentId of agentIds) {
      const existing = this.#claims.get(agentId)
      if (existing) {
        throw new Error(
          `agent id ${agentId} is already claimed by provider ${existing.provider.id}`,
        )
      }
    }

    const registration: RegisteredProvider = { id: providerId, provider, agentIds }
    this.#providers.set(providerId, registration)
    for (const agentId of agentIds) this.#claims.set(agentId, registration)
    this.#invalidateProbe()

    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#providers.get(providerId) === registration) this.#providers.delete(providerId)
      for (const agentId of agentIds) {
        if (this.#claims.get(agentId) === registration) this.#claims.delete(agentId)
      }
      this.#invalidateProbe()
    }
  }

  snapshot(): AgentTransportProviderSnapshot[] {
    return [...this.#providers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, agentIds }) => Object.freeze({
        id,
        agentIds: Object.freeze([...agentIds].sort((left, right) => left.localeCompare(right))),
      }))
  }

  async probe(): Promise<AgentDescriptor[]> {
    const revision = this.#revision
    if (
      this.#cachedProbe
      && this.#cachedProbe.revision === revision
      && this.#cachedProbe.expiresAt > Date.now()
    ) {
      return cloneDescriptors(this.#cachedProbe.descriptors)
    }
    if (this.#probeInFlight?.revision === revision) {
      return cloneDescriptors(await this.#probeInFlight.promise)
    }

    const providers = [...this.#providers.values()]
    const flight: ProbeFlight = {
      revision,
      promise: this.#probeFresh(providers),
    }
    this.#probeInFlight = flight
    try {
      const descriptors = await flight.promise
      if (this.#revision === revision) {
        this.#cachedProbe = {
          revision,
          expiresAt: Date.now() + PROBE_CACHE_MS,
          descriptors,
        }
      }
      return cloneDescriptors(descriptors)
    } finally {
      if (this.#probeInFlight === flight) this.#probeInFlight = null
    }
  }

  resolve(agentId: string): AgentProcessTransport | null {
    const registration = this.#claims.get(agentId)
    if (!registration) return null
    const transport = registration.provider.resolve(agentId)
    if (!transport) {
      throw new Error(
        `provider ${registration.id} did not resolve claimed agent ${agentId}`,
      )
    }
    return transport
  }

  #invalidateProbe(): void {
    this.#revision += 1
    this.#cachedProbe = null
  }

  async #probeFresh(providers: RegisteredProvider[]): Promise<AgentDescriptor[]> {
    const batches = await Promise.all(
      providers.map(async (registration) => ({
        registration,
        descriptors: await registration.provider.probe(),
      })),
    )
    const descriptors: AgentDescriptor[] = []
    const seen = new Set<string>()
    for (const batch of batches) {
      const claims = new Set(batch.registration.agentIds)
      for (const descriptor of batch.descriptors) {
        if (!claims.has(descriptor.id)) {
          throw new Error(
            `provider ${batch.registration.id} reported undeclared agent ${descriptor.id}`,
          )
        }
        if (seen.has(descriptor.id)) {
          throw new Error(`duplicate agent descriptor returned for ${descriptor.id}`)
        }
        seen.add(descriptor.id)
        descriptors.push(descriptor)
      }
    }
    return descriptors
  }
}

function assertProvider(provider: AgentTransportProvider): string[] {
  if (!PROVIDER_ID.test(provider.id)) {
    throw new TypeError(`invalid agent transport provider id: ${provider.id}`)
  }
  if (provider.agentIds.length === 0) {
    throw new TypeError(`agent transport provider has no agent ids: ${provider.id}`)
  }
  const unique = new Set<string>()
  for (const agentId of provider.agentIds) {
    if (!AGENT_ID.test(agentId) || agentId.includes('..') || agentId.includes('//')) {
      throw new TypeError(`invalid agent id for ${provider.id}: ${agentId}`)
    }
    if (unique.has(agentId)) {
      throw new TypeError(`duplicate agent id for ${provider.id}: ${agentId}`)
    }
    unique.add(agentId)
  }
  return [...unique]
}

function cloneDescriptors(descriptors: AgentDescriptor[]): AgentDescriptor[] {
  return descriptors.map((descriptor) => ({ ...descriptor, models: [...descriptor.models] }))
}
