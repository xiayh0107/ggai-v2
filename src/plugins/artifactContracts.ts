/**
 * Serializable manifest-backed artifact capabilities shared by browser plugin registration
 * and the local daemon. Keep this module data-only: it must never import a
 * renderer, React, canvas commands, or executable plugin hooks.
 */
import {
  inspectNodeContextPolicy,
  type NodeContextPolicy,
} from './contextContracts.js'

export const MAX_ARTIFACT_PLUGIN_REGISTRATIONS = 500
export const MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN = 32
export const MAX_ARTIFACT_CLAIM_MATCHERS_PER_RULE = 64

export interface ArtifactClaimRule {
  extensions?: string[]
  mediaTypes?: string[]
  priority?: number
}

export interface ArtifactClaimRegistration {
  id: string
  artifactClaims: ArtifactClaimRule[]
  /** Optional deterministic Node-to-Agent projection. */
  nodeContext?: NodeContextPolicy
  /** Explicit generic-file opt-in. It never outranks a typed claim. */
  acceptsUnknown?: boolean
}

export const ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION = 2

/**
 * Browser-to-daemon data contract. It contains claims only; executable hooks,
 * renderers and canvas authority can never be represented by this shape.
 */
export interface ArtifactCapabilitySnapshotRequest {
  schemaVersion: 2
  plugins: ArtifactClaimRegistration[]
}

export type ArtifactCapabilitySnapshotRequestInspection =
  | { status: 'valid'; snapshot: ArtifactCapabilitySnapshotRequest }
  | { status: 'invalid'; reason: string }

export type ArtifactClaimRegistryInspection =
  | { status: 'valid'; registrations: ArtifactClaimRegistration[] }
  | { status: 'invalid'; reason: string }

export type BuiltinArtifactPluginId =
  | 'code'
  | 'image'
  | 'pdf'
  | 'table'
  | 'text'
  | 'file'

export function inspectArtifactClaimRegistry(
  value: unknown,
): ArtifactClaimRegistryInspection {
  try {
    return { status: 'valid', registrations: parseRegistrations(value) }
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'artifact claim registry is invalid',
    }
  }
}

export function defineArtifactClaimRegistry(
  value: unknown,
): readonly ArtifactClaimRegistration[] {
  const inspection = inspectArtifactClaimRegistry(value)
  if (inspection.status !== 'valid') {
    throw new TypeError(`artifact claim registry is invalid: ${inspection.reason}`)
  }
  return inspection.registrations
}

export function inspectArtifactCapabilitySnapshotRequest(
  value: unknown,
): ArtifactCapabilitySnapshotRequestInspection {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'plugins'])
    || value.schemaVersion !== ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION) {
    return { status: 'invalid', reason: 'artifact capability snapshot envelope is invalid' }
  }
  const inspection = inspectArtifactClaimRegistry(value.plugins)
  if (inspection.status !== 'valid') return inspection
  return {
    status: 'valid',
    snapshot: {
      schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      plugins: canonicalArtifactClaimRegistrations(inspection.registrations),
    },
  }
}

/** Stable ordering keeps capability digests independent from plugin load order. */
export function canonicalArtifactClaimRegistrations(
  registrations: readonly ArtifactClaimRegistration[],
): ArtifactClaimRegistration[] {
  const inspection = inspectArtifactClaimRegistry(registrations)
  if (inspection.status !== 'valid') {
    throw new TypeError(`artifact claim registry is invalid: ${inspection.reason}`)
  }
  return inspection.registrations
    .map((registration) => ({
      id: registration.id,
      artifactClaims: registration.artifactClaims
        .map((claim) => ({
          ...(claim.extensions
            ? { extensions: [...claim.extensions].sort((left, right) => left.localeCompare(right)) }
            : {}),
          ...(claim.mediaTypes
            ? { mediaTypes: [...claim.mediaTypes].sort((left, right) => left.localeCompare(right)) }
            : {}),
          ...(claim.priority !== undefined ? { priority: claim.priority } : {}),
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ...(registration.nodeContext
        ? { nodeContext: structuredClone(registration.nodeContext) }
        : {}),
      ...(registration.acceptsUnknown ? { acceptsUnknown: true } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function parseRegistrations(value: unknown): ArtifactClaimRegistration[] {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_PLUGIN_REGISTRATIONS) {
    throw new TypeError('artifact claim registrations exceed the supported bound')
  }
  const ids = new Set<string>()
  return value.map((candidate, pluginIndex) => {
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, ['id', 'artifactClaims', 'nodeContext', 'acceptsUnknown'])) {
      throw new TypeError(`registrations[${pluginIndex}] has unsupported properties`)
    }
    if (!isPluginId(candidate.id) || ids.has(candidate.id)) {
      throw new TypeError(`registrations[${pluginIndex}].id is invalid or duplicated`)
    }
    ids.add(candidate.id)
    if (!Array.isArray(candidate.artifactClaims)
      || candidate.artifactClaims.length > MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN) {
      throw new TypeError(`registrations[${pluginIndex}].artifactClaims is invalid`)
    }
    if (candidate.acceptsUnknown !== undefined && typeof candidate.acceptsUnknown !== 'boolean') {
      throw new TypeError(`registrations[${pluginIndex}].acceptsUnknown is invalid`)
    }
    const nodeContext = candidate.nodeContext === undefined
      ? undefined
      : inspectNodeContextPolicy(candidate.nodeContext)
    if (nodeContext?.status === 'invalid') {
      throw new TypeError(`registrations[${pluginIndex}].nodeContext is invalid: ${nodeContext.reason}`)
    }
    return {
      id: candidate.id,
      artifactClaims: candidate.artifactClaims.map((claim, claimIndex) =>
        parseClaim(claim, pluginIndex, claimIndex)),
      ...(nodeContext?.status === 'valid' ? { nodeContext: nodeContext.policy } : {}),
      ...(candidate.acceptsUnknown ? { acceptsUnknown: true } : {}),
    }
  })
}

function parseClaim(
  value: unknown,
  pluginIndex: number,
  claimIndex: number,
): ArtifactClaimRule {
  const label = `registrations[${pluginIndex}].artifactClaims[${claimIndex}]`
  if (!isRecord(value)) throw new TypeError(`${label} is invalid`)
  if (!hasOnlyKeys(value, ['extensions', 'mediaTypes', 'priority'])) {
    throw new TypeError(`${label} has unsupported properties`)
  }
  if (value.extensions !== undefined && !Array.isArray(value.extensions)) {
    throw new TypeError(`${label}.extensions is invalid`)
  }
  if (value.mediaTypes !== undefined && !Array.isArray(value.mediaTypes)) {
    throw new TypeError(`${label}.mediaTypes is invalid`)
  }
  const extensions = (value.extensions ?? []) as unknown[]
  const mediaTypes = (value.mediaTypes ?? []) as unknown[]
  if (extensions.length > MAX_ARTIFACT_CLAIM_MATCHERS_PER_RULE
    || mediaTypes.length > MAX_ARTIFACT_CLAIM_MATCHERS_PER_RULE
    || extensions.length + mediaTypes.length === 0
    || !extensions.every((extension) =>
      typeof extension === 'string' && /^\.[a-z0-9][a-z0-9.+_-]{0,31}$/u.test(extension))
    || !mediaTypes.every((mediaType) =>
      typeof mediaType === 'string' && isMediaTypeMatcher(mediaType))
    || new Set(extensions).size !== extensions.length
    || new Set(mediaTypes).size !== mediaTypes.length) {
    throw new TypeError(`${label} matchers are invalid`)
  }
  const priority = value.priority ?? 0
  if (typeof priority !== 'number'
    || !Number.isSafeInteger(priority)
    || priority < -1_000
    || priority > 1_000) {
    throw new TypeError(`${label}.priority is invalid`)
  }
  return {
    ...(extensions.length > 0 ? { extensions: [...extensions] as string[] } : {}),
    ...(mediaTypes.length > 0 ? { mediaTypes: [...mediaTypes] as string[] } : {}),
    ...(priority !== 0 ? { priority } : {}),
  }
}

function isPluginId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 160
    && /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
    && !value.includes('..')
    && !value.includes('//')
}

function isMediaTypeMatcher(value: string): boolean {
  return /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

export const BUILTIN_ARTIFACT_CLAIM_REGISTRY = defineArtifactClaimRegistry([
  {
    id: 'code',
    artifactClaims: [{
      extensions: [
        '.r', '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.java',
        '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts', '.c', '.h',
        '.cc', '.cpp', '.hpp', '.cs', '.fs', '.fsx', '.scala', '.sh', '.bash',
        '.zsh', '.fish', '.sql', '.html', '.css', '.scss', '.sass', '.less',
        '.vue', '.svelte', '.lua', '.pl', '.ex', '.exs', '.erl', '.hrl',
      ],
      mediaTypes: [
        'text/x-r', 'text/x-python', 'text/javascript', 'application/javascript',
        'application/typescript', 'text/x-java-source', 'text/x-c', 'text/x-c++',
        'text/x-shellscript', 'application/sql', 'text/html', 'text/css',
      ],
      priority: 20,
    }],
  },
  {
    id: 'image',
    artifactClaims: [{
      extensions: [
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp',
        '.tif', '.tiff', '.ico',
      ],
      mediaTypes: ['image/*'],
      priority: 20,
    }],
  },
  {
    id: 'pdf',
    artifactClaims: [{
      extensions: ['.pdf'],
      mediaTypes: ['application/pdf'],
      priority: 20,
    }],
  },
  {
    id: 'table',
    artifactClaims: [{
      extensions: ['.csv', '.tsv', '.xls', '.xlsx', '.ods', '.parquet', '.arrow', '.feather'],
      mediaTypes: [
        'text/csv', 'text/tab-separated-values', 'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.apache.parquet',
        'application/vnd.apache.arrow.file',
      ],
      priority: 20,
    }],
  },
  {
    id: 'text',
    artifactClaims: [{
      extensions: ['.txt', '.md', '.markdown', '.rst', '.adoc', '.tex', '.log'],
      mediaTypes: ['text/*'],
      priority: 5,
    }],
  },
  {
    id: 'file',
    artifactClaims: [],
    acceptsUnknown: true,
  },
])

export const BUILTIN_ARTIFACT_PLUGIN_IDS: ReadonlySet<string> = new Set(
  BUILTIN_ARTIFACT_CLAIM_REGISTRY.map(({ id }) => id),
)

/** Returns a mutable copy suitable for one browser-side NodePlugin declaration. */
export function artifactClaimsForBuiltin(
  id: BuiltinArtifactPluginId,
): ArtifactClaimRule[] {
  const registration = BUILTIN_ARTIFACT_CLAIM_REGISTRY.find((candidate) => candidate.id === id)
  if (!registration) throw new TypeError(`unknown built-in artifact plugin: ${id}`)
  return registration.artifactClaims.map((claim) => ({
    ...(claim.extensions ? { extensions: [...claim.extensions] } : {}),
    ...(claim.mediaTypes ? { mediaTypes: [...claim.mediaTypes] } : {}),
    ...(claim.priority !== undefined ? { priority: claim.priority } : {}),
  }))
}
