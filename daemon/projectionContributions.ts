import { createHash } from 'node:crypto'
import {
  BUILTIN_ARTIFACT_CLAIM_REGISTRY,
  canonicalArtifactClaimRegistrations,
  type ArtifactClaimRegistration,
} from '../src/plugins/artifactContracts.js'
import { BUILTIN_NODE_CONTEXT_POLICY_REGISTRY } from '../src/plugins/contextContracts.js'
import type { Disposer } from './runtime/effects.js'
import { defineService, type ServiceReader } from './runtime/services.js'

export const PROJECTION_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION = 1 as const
const SNAPSHOT_DIGEST_DOMAIN = 'ggai.projection-contributions.v1'
const PROVIDER_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const MAX_PROVIDERS = 128
const MAX_CONTRIBUTIONS = 512
const RESERVED_PROJECTION_CAPABILITY_IDS = new Set([
  ...BUILTIN_ARTIFACT_CLAIM_REGISTRY.map(({ id }) => id),
  ...BUILTIN_NODE_CONTEXT_POLICY_REGISTRY.map(({ id }) => id),
])

export type ProjectionContribution = ArtifactClaimRegistration

export interface ProjectionContributionRecord extends ProjectionContribution {
  readonly providerId: string
  readonly providerVersion: string
}

export interface ProjectionContributionSnapshot {
  readonly schemaVersion: typeof PROJECTION_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION
  readonly digest: string
  readonly contributions: readonly ProjectionContributionRecord[]
}

export type ProjectionContributionSnapshotInspection =
  | { readonly status: 'valid'; readonly snapshot: ProjectionContributionSnapshot }
  | { readonly status: 'invalid'; readonly reason: string }

interface RegisteredProvider {
  readonly id: string
  readonly version: string
  readonly contributions: readonly ProjectionContribution[]
}

export const PROJECTION_CONTRIBUTION_REGISTRY_SERVICE =
  defineService<ProjectionContributionRegistry>('ggai.projection-contributions.v1')

/** Absence of optional runtime providers is the canonical empty contribution set. */
export function workspaceProjectionContributionSnapshot(
  services: ServiceReader,
): ProjectionContributionSnapshot {
  return services.get(PROJECTION_CONTRIBUTION_REGISTRY_SERVICE)?.snapshot()
    ?? createProjectionContributionSnapshot([])
}

/**
 * Trusted runtime providers may contribute data-only projection declarations.
 * The registry owns no renderer, Canvas command, ArtifactManifest, or plan writer.
 */
export class ProjectionContributionRegistry {
  readonly #providers = new Map<string, RegisteredProvider>()
  readonly #claims = new Map<string, RegisteredProvider>()

  register(
    providerId: string,
    providerVersion: string,
    contributions: readonly ProjectionContribution[],
  ): Disposer {
    assertProviderId(providerId)
    assertProviderVersion(providerVersion)
    if (this.#providers.has(providerId)) {
      throw new Error(`projection contribution provider already exists: ${providerId}`)
    }
    if (this.#providers.size >= MAX_PROVIDERS) {
      throw new Error(`projection contribution registry exceeds ${MAX_PROVIDERS} providers`)
    }
    const canonical = canonicalContributions(contributions)
    const total = [...this.#providers.values()].reduce(
      (count, provider) => count + provider.contributions.length,
      canonical.length,
    )
    if (total > MAX_CONTRIBUTIONS) {
      throw new Error(`projection contribution registry exceeds ${MAX_CONTRIBUTIONS} entries`)
    }
    for (const contribution of canonical) {
      const existing = this.#claims.get(contribution.id)
      if (existing) {
        throw new Error(
          `projection contribution ${contribution.id} is already owned by ${existing.id}`,
        )
      }
    }

    const provider: RegisteredProvider = {
      id: providerId,
      version: providerVersion,
      contributions: Object.freeze(canonical),
    }
    this.#providers.set(providerId, provider)
    for (const contribution of canonical) this.#claims.set(contribution.id, provider)

    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#providers.get(providerId) === provider) this.#providers.delete(providerId)
      for (const contribution of canonical) {
        if (this.#claims.get(contribution.id) === provider) this.#claims.delete(contribution.id)
      }
    }
  }

  snapshot(): ProjectionContributionSnapshot {
    const records = [...this.#providers.values()].flatMap((provider) =>
      provider.contributions.map((contribution) => ({
        providerId: provider.id,
        providerVersion: provider.version,
        ...structuredClone(contribution),
      })))
    return createProjectionContributionSnapshot(records)
  }
}

export function createProjectionContributionSnapshot(
  records: readonly ProjectionContributionRecord[],
): ProjectionContributionSnapshot {
  const contributions = canonicalContributionRecords(records)
  const body = {
    schemaVersion: PROJECTION_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION,
    contributions,
  }
  return deepFreeze({
    ...body,
    digest: createHash('sha256')
      .update(`${SNAPSHOT_DIGEST_DOMAIN}\0`, 'utf8')
      .update(JSON.stringify(body), 'utf8')
      .digest('hex'),
  })
}

export function inspectProjectionContributionSnapshot(
  value: unknown,
): ProjectionContributionSnapshotInspection {
  try {
    if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'digest', 'contributions'])
      || value.schemaVersion !== PROJECTION_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION
      || typeof value.digest !== 'string'
      || !Array.isArray(value.contributions)) {
      throw new TypeError('projection contribution snapshot envelope is invalid')
    }
    const expected = createProjectionContributionSnapshot(
      value.contributions as unknown as ProjectionContributionRecord[],
    )
    if (value.digest !== expected.digest) {
      throw new TypeError('projection contribution snapshot digest does not match')
    }
    if (JSON.stringify(value) !== JSON.stringify(expected)) {
      throw new TypeError('projection contribution snapshot is not canonical')
    }
    return { status: 'valid', snapshot: expected }
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'projection contribution snapshot is invalid',
    }
  }
}

function canonicalContributionRecords(
  records: readonly ProjectionContributionRecord[],
): ProjectionContributionRecord[] {
  const providers = new Set<string>()
  const providerVersions = new Map<string, string>()
  const ids = new Set<string>()
  const grouped = new Map<string, ProjectionContribution[]>()
  for (const record of records) {
    if (!isRecord(record)
      || typeof record.providerId !== 'string'
      || typeof record.providerVersion !== 'string') {
      throw new TypeError('projection contribution record is invalid')
    }
    assertProviderId(record.providerId)
    assertProviderVersion(record.providerVersion)
    const priorVersion = providerVersions.get(record.providerId)
    if (priorVersion !== undefined && priorVersion !== record.providerVersion) {
      throw new TypeError(`projection provider has multiple versions: ${record.providerId}`)
    }
    providerVersions.set(record.providerId, record.providerVersion)
    providers.add(record.providerId)
    const { providerId, providerVersion, ...registration } = record
    const canonical = canonicalContributions([
      registration as ProjectionContribution,
    ])[0]!
    if (ids.has(canonical.id)) {
      throw new TypeError(`duplicate projection contribution id: ${canonical.id}`)
    }
    ids.add(canonical.id)
    const groupKey = `${providerId}\0${providerVersion}`
    const entries = grouped.get(groupKey) ?? []
    entries.push(canonical)
    grouped.set(groupKey, entries)
  }
  if (providers.size > MAX_PROVIDERS || ids.size > MAX_CONTRIBUTIONS) {
    throw new TypeError('projection contribution snapshot exceeds supported limits')
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([providerKey, contributions]) => {
      const separator = providerKey.indexOf('\0')
      const providerId = providerKey.slice(0, separator)
      const providerVersion = providerKey.slice(separator + 1)
      return contributions
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((contribution) => ({
        providerId,
        providerVersion,
        ...structuredClone(contribution),
      }))
    })
}

function canonicalContributions(
  contributions: readonly ProjectionContribution[],
): ProjectionContribution[] {
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw new TypeError('projection contribution provider must declare at least one entry')
  }
  for (const contribution of contributions) assertContributionAuthority(contribution)
  const canonical = canonicalArtifactClaimRegistrations(contributions)
  const ids = new Set<string>()
  for (const contribution of canonical) {
    if (ids.has(contribution.id)) {
      throw new TypeError(`duplicate projection contribution id: ${contribution.id}`)
    }
    ids.add(contribution.id)
    assertContributionAuthority(contribution)
  }
  return canonical.map((contribution) => structuredClone(contribution))
}

function assertContributionAuthority(value: unknown): void {
  if (!isRecord(value)) return
  if (typeof value.id === 'string' && RESERVED_PROJECTION_CAPABILITY_IDS.has(value.id)) {
    throw new TypeError(`runtime contribution cannot replace builtin capability: ${value.id}`)
  }
  if (value.acceptsUnknown === true) {
    const label = typeof value.id === 'string' ? value.id : 'unknown contribution'
    throw new TypeError(`runtime contribution cannot accept unknown artifacts: ${label}`)
  }
}

function assertProviderId(providerId: string): void {
  if (!PROVIDER_ID.test(providerId)) {
    throw new TypeError(`invalid projection contribution provider id: ${providerId}`)
  }
}

function assertProviderVersion(providerVersion: string): void {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(providerVersion)) {
    throw new TypeError(`invalid projection contribution provider version: ${providerVersion}`)
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
