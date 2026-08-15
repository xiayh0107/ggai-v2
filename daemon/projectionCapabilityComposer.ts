import { createHash } from 'node:crypto'
import type { ArtifactClaimRegistration } from '../src/plugins/artifactContracts.js'
import {
  ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
} from '../src/plugins/artifactContracts.js'
import { BUILTIN_NODE_CONTEXT_PLUGIN_IDS } from '../src/plugins/contextContracts.js'
import {
  BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
  inspectProjectionPluginCapabilitySnapshot,
  resolveProjectionPluginCapabilitySnapshot,
  type ProjectionPluginCapabilitySnapshot,
} from './pluginCapabilities.js'
import {
  inspectProjectionContributionSnapshot,
  type ProjectionContributionRecord,
  type ProjectionContributionSnapshot,
  type ProjectionContributionRegistry,
} from './projectionContributions.js'
import type { ProjectionPluginContract } from './projectionPlan.js'

export const PROJECTION_CAPABILITY_PROVENANCE_SCHEMA_VERSION = 1 as const
const PROVENANCE_DIGEST_DOMAIN = 'ggai.projection-capability-provenance.v1'
const DIGEST = /^[0-9a-f]{64}$/u
const PLUGIN_ID = /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u
const PROVIDER_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

export type ProjectionCapabilitySourceKind = 'builtin' | 'runtime' | 'community'

export interface ProjectionCapabilitySourceRecord {
  readonly pluginId: string
  readonly kind: ProjectionCapabilitySourceKind
  readonly providerId: string | null
}

export interface ProjectionCapabilityProvenanceSnapshot {
  readonly schemaVersion: typeof PROJECTION_CAPABILITY_PROVENANCE_SCHEMA_VERSION
  readonly classificationDigest: string
  readonly runtimeContributions: ProjectionContributionSnapshot
  readonly sources: readonly ProjectionCapabilitySourceRecord[]
  readonly digest: string
}

export interface ProjectionCapabilityComposition {
  readonly capabilities: ProjectionPluginCapabilitySnapshot
  readonly provenance: ProjectionCapabilityProvenanceSnapshot
}

export type ProjectionCapabilityProvenanceInspection =
  | { readonly status: 'valid'; readonly snapshot: ProjectionCapabilityProvenanceSnapshot }
  | { readonly status: 'invalid'; readonly reason: string }

/**
 * Combines daemon-owned builtins, trusted Runtime contributions, and the
 * browser's already-validated community declarations. Executable renderers and
 * Canvas authority never cross this data-only boundary.
 */
export class ProjectionCapabilityComposer {
  readonly #runtime: ProjectionContributionRegistry

  constructor(runtime: ProjectionContributionRegistry) {
    this.#runtime = runtime
  }

  compose(
    current: ProjectionPluginCapabilitySnapshot | undefined,
  ): ProjectionCapabilityComposition {
    const base = requireCapabilitySnapshot(
      current ?? BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
    )
    const runtime = this.#runtime.snapshot()
    const runtimeById = new Map(runtime.contributions.map((record) => [record.id, record]))
    const expectedRuntimePlugins = runtimePluginContracts(runtime.contributions)
    const baseById = new Map(base.plugins.map((plugin) => [plugin.id, plugin]))

    for (const [id, expected] of expectedRuntimePlugins) {
      const existing = baseById.get(id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(expected)) {
        throw new TypeError(
          `community projection capability conflicts with Runtime provider: ${id}`,
        )
      }
    }

    const community = base.plugins
      .filter((plugin) => !BUILTIN_NODE_CONTEXT_PLUGIN_IDS.has(plugin.id))
      .filter((plugin) => !runtimeById.has(plugin.id))
      .map(projectionPluginToRegistration)
    const runtimeRegistrations = runtime.contributions.map(stripProvider)
    const capabilities = resolveProjectionPluginCapabilitySnapshot({
      schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      plugins: [...community, ...runtimeRegistrations],
    })
    const sources = capabilities.plugins.map((plugin): ProjectionCapabilitySourceRecord => {
      if (BUILTIN_NODE_CONTEXT_PLUGIN_IDS.has(plugin.id)) {
        return {
          pluginId: plugin.id,
          kind: 'builtin',
          providerId: '@ggai/projection-core',
        }
      }
      const runtimeRecord = runtimeById.get(plugin.id)
      if (runtimeRecord) {
        return {
          pluginId: plugin.id,
          kind: 'runtime',
          providerId: runtimeRecord.providerId,
        }
      }
      return { pluginId: plugin.id, kind: 'community', providerId: null }
    })
    return Object.freeze({
      capabilities,
      provenance: createProjectionCapabilityProvenanceSnapshot({
        classificationDigest: capabilities.digest,
        runtimeContributions: runtime,
        sources,
      }),
    })
  }
}

export function createProjectionCapabilityProvenanceSnapshot(input: {
  classificationDigest: string
  runtimeContributions: ProjectionContributionSnapshot
  sources: readonly ProjectionCapabilitySourceRecord[]
}): ProjectionCapabilityProvenanceSnapshot {
  if (!DIGEST.test(input.classificationDigest)) {
    throw new TypeError('projection classification digest is invalid')
  }
  const runtimeInspection = inspectProjectionContributionSnapshot(input.runtimeContributions)
  if (runtimeInspection.status !== 'valid') {
    throw new TypeError(
      `projection Runtime contribution snapshot is invalid: ${runtimeInspection.reason}`,
    )
  }
  const runtimeContributions = runtimeInspection.snapshot
  const sources = canonicalSources(input.sources)
  assertRuntimeSources(runtimeContributions.contributions, sources)
  const body = {
    schemaVersion: PROJECTION_CAPABILITY_PROVENANCE_SCHEMA_VERSION,
    classificationDigest: input.classificationDigest,
    runtimeContributions,
    sources,
  }
  return deepFreeze({
    ...body,
    digest: createHash('sha256')
      .update(`${PROVENANCE_DIGEST_DOMAIN}\0`, 'utf8')
      .update(JSON.stringify(body), 'utf8')
      .digest('hex'),
  })
}

export function inspectProjectionCapabilityProvenanceSnapshot(
  value: unknown,
): ProjectionCapabilityProvenanceInspection {
  try {
    if (!isRecord(value) || !hasExactKeys(value, [
      'schemaVersion',
      'classificationDigest',
      'runtimeContributions',
      'sources',
      'digest',
    ]) || value.schemaVersion !== PROJECTION_CAPABILITY_PROVENANCE_SCHEMA_VERSION
      || typeof value.classificationDigest !== 'string'
      || !Array.isArray(value.sources)
      || typeof value.digest !== 'string') {
      throw new TypeError('projection capability provenance envelope is invalid')
    }
    const expected = createProjectionCapabilityProvenanceSnapshot({
      classificationDigest: value.classificationDigest,
      runtimeContributions: value.runtimeContributions as ProjectionContributionSnapshot,
      sources: value.sources as ProjectionCapabilitySourceRecord[],
    })
    if (!DIGEST.test(value.digest) || value.digest !== expected.digest) {
      throw new TypeError('projection capability provenance digest does not match')
    }
    if (JSON.stringify(value) !== JSON.stringify(expected)) {
      throw new TypeError('projection capability provenance is not canonical')
    }
    return { status: 'valid', snapshot: expected }
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'projection provenance is invalid',
    }
  }
}

function runtimePluginContracts(
  records: readonly ProjectionContributionRecord[],
): Map<string, ProjectionPluginContract> {
  if (records.length === 0) return new Map()
  const resolved = resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    plugins: records.map(stripProvider),
  })
  const ids = new Set(records.map((record) => record.id))
  return new Map(resolved.plugins
    .filter((plugin) => ids.has(plugin.id))
    .map((plugin) => [plugin.id, plugin]))
}

function projectionPluginToRegistration(
  plugin: ProjectionPluginContract,
): ArtifactClaimRegistration {
  return {
    id: plugin.id,
    artifactClaims: structuredClone(plugin.artifactRules),
    ...(plugin.nodeContext ? { nodeContext: structuredClone(plugin.nodeContext) } : {}),
    ...(plugin.acceptsUnknown ? { acceptsUnknown: true } : {}),
  }
}

function stripProvider(
  record: ProjectionContributionRecord,
): ArtifactClaimRegistration {
  const registration = structuredClone(record) as ProjectionContributionRecord
  delete (registration as Partial<ProjectionContributionRecord>).providerId
  return registration
}

function requireCapabilitySnapshot(
  value: ProjectionPluginCapabilitySnapshot,
): ProjectionPluginCapabilitySnapshot {
  const inspection = inspectProjectionPluginCapabilitySnapshot(value)
  if (inspection.status !== 'valid') {
    throw new TypeError(`projection capability snapshot is invalid: ${inspection.reason}`)
  }
  return inspection.snapshot
}

function canonicalSources(
  value: readonly ProjectionCapabilitySourceRecord[],
): ProjectionCapabilitySourceRecord[] {
  const byId = new Map<string, ProjectionCapabilitySourceRecord>()
  for (const source of value) {
    if (!isRecord(source)
      || !hasExactKeys(source, ['pluginId', 'kind', 'providerId'])
      || typeof source.pluginId !== 'string'
      || (source.kind !== 'builtin' && source.kind !== 'runtime' && source.kind !== 'community')
      || (source.providerId !== null && typeof source.providerId !== 'string')) {
      throw new TypeError('projection capability source is invalid')
    }
    if (!PLUGIN_ID.test(source.pluginId)
      || source.pluginId.includes('..')
      || source.pluginId.includes('//')) {
      throw new TypeError(`projection capability source id is invalid: ${source.pluginId}`)
    }
    if (source.kind === 'community' && source.providerId !== null) {
      throw new TypeError(`community projection source cannot name a Runtime provider: ${source.pluginId}`)
    }
    if (source.kind !== 'community'
      && (source.providerId === null || !PROVIDER_ID.test(source.providerId))) {
      throw new TypeError(`projection source provider is invalid: ${source.pluginId}`)
    }
    if (byId.has(source.pluginId)) {
      throw new TypeError(`duplicate projection capability source: ${source.pluginId}`)
    }
    byId.set(source.pluginId, {
      pluginId: source.pluginId,
      kind: source.kind,
      providerId: source.providerId,
    })
  }
  return [...byId.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId))
}

function assertRuntimeSources(
  runtime: readonly ProjectionContributionRecord[],
  sources: readonly ProjectionCapabilitySourceRecord[],
): void {
  const byId = new Map(sources.map((source) => [source.pluginId, source]))
  for (const contribution of runtime) {
    const source = byId.get(contribution.id)
    if (!source
      || source.kind !== 'runtime'
      || source.providerId !== contribution.providerId) {
      throw new TypeError(
        `Runtime projection contribution lacks matching provenance: ${contribution.id}`,
      )
    }
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
