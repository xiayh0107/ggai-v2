import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
  BUILTIN_ARTIFACT_CLAIM_REGISTRY,
  MAX_ARTIFACT_PLUGIN_REGISTRATIONS,
  canonicalArtifactClaimRegistrations,
  inspectArtifactCapabilitySnapshotRequest,
  type ArtifactCapabilitySnapshotRequest,
  type ArtifactClaimRegistration,
} from '../src/plugins/artifactContracts.js'
import {
  BUILTIN_NODE_CONTEXT_PLUGIN_IDS,
  BUILTIN_NODE_CONTEXT_POLICY_REGISTRY,
} from '../src/plugins/contextContracts.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'
import {
  createProjectionContributionSnapshot,
  inspectProjectionContributionSnapshot,
  type ProjectionContributionRecord,
} from './projectionContributions.js'
import {
  inspectProjectionPluginContracts,
  type ProjectionPluginContract,
} from './projectionPlan.js'

const CAPABILITY_DIGEST_DOMAIN = 'ggai.projection-plugin-capabilities.v3'
const BUILTIN_PROJECTION_VERSION = '1.0.0'
const MAX_CAPABILITY_SNAPSHOT_BYTES = 4 * 1024 * 1024

export type ProjectionCapabilitySource =
  | { kind: 'builtin'; version: string }
  | { kind: 'runtime-plugin'; providerId: string; providerVersion: string }
  | { kind: 'browser-community' }

export interface ProjectionPluginCapability {
  pluginId: string
  source: ProjectionCapabilitySource
  artifactRules: ProjectionPluginContract['artifactRules']
  nodeContext?: ProjectionPluginContract['nodeContext']
  acceptsUnknown?: boolean
}

/** The only projection capability snapshot accepted by a new Run. */
export interface ProjectionPluginCapabilitySnapshot {
  schemaVersion: 3
  digest: string
  plugins: ProjectionPluginCapability[]
}

export type ProjectionPluginCapabilitySnapshotInspection =
  | { status: 'valid'; snapshot: ProjectionPluginCapabilitySnapshot }
  | { status: 'invalid'; reason: string }

const EMPTY_RUNTIME_CONTRIBUTIONS = createProjectionContributionSnapshot([])

/**
 * Merges daemon-protected builtins, trusted runtime contributions, and
 * untrusted browser community claims into one canonical Run-fixed snapshot.
 */
export function resolveProjectionPluginCapabilitySnapshot(
  browserClaims: unknown,
  runtimeContributions: unknown = EMPTY_RUNTIME_CONTRIBUTIONS,
): ProjectionPluginCapabilitySnapshot {
  const browserInspection = inspectArtifactCapabilitySnapshotRequest(browserClaims)
  if (browserInspection.status !== 'valid') {
    throw new TypeError(`plugin capability snapshot is invalid: ${browserInspection.reason}`)
  }
  const runtimeInspection = inspectProjectionContributionSnapshot(runtimeContributions)
  if (runtimeInspection.status !== 'valid') {
    throw new TypeError(`runtime projection contributions are invalid: ${runtimeInspection.reason}`)
  }

  for (const plugin of browserInspection.snapshot.plugins) {
    if (BUILTIN_NODE_CONTEXT_PLUGIN_IDS.has(plugin.id)) {
      throw new TypeError(`built-in plugin capability cannot be replaced: ${plugin.id}`)
    }
    if (plugin.acceptsUnknown) {
      throw new TypeError(`community artifact capability cannot accept unknown files: ${plugin.id}`)
    }
  }

  const plugins = [
    ...builtinPluginCapabilityRegistrations().map((registration) =>
      toProjectionCapability(registration, {
        kind: 'builtin',
        version: BUILTIN_PROJECTION_VERSION,
      })),
    ...runtimeInspection.snapshot.contributions.map(runtimeContributionToCapability),
    ...browserInspection.snapshot.plugins.map((registration) =>
      toProjectionCapability(registration, { kind: 'browser-community' })),
  ].sort((left, right) => left.pluginId.localeCompare(right.pluginId))

  if (plugins.length > MAX_ARTIFACT_PLUGIN_REGISTRATIONS) {
    throw new TypeError('projection capability snapshot exceeds the supported plugin bound')
  }

  const ids = new Set<string>()
  for (const plugin of plugins) {
    if (ids.has(plugin.pluginId)) {
      throw new TypeError(`projection capability claim conflicts for plugin: ${plugin.pluginId}`)
    }
    ids.add(plugin.pluginId)
    if (plugin.source.kind !== 'builtin' && plugin.acceptsUnknown) {
      throw new TypeError(`only a built-in may accept unknown artifacts: ${plugin.pluginId}`)
    }
  }

  return {
    schemaVersion: 3,
    digest: projectionPluginCapabilityDigest(plugins),
    plugins,
  }
}

export function inspectProjectionPluginCapabilitySnapshot(
  value: unknown,
): ProjectionPluginCapabilitySnapshotInspection {
  try {
    if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'digest', 'plugins'])
      || value.schemaVersion !== 3
      || !isCapabilityDigest(value.digest)
      || !Array.isArray(value.plugins)) {
      throw new TypeError('capability snapshot v3 envelope is invalid')
    }
    const browserPlugins: ArtifactClaimRegistration[] = []
    const runtimeRecords: ProjectionContributionRecord[] = []
    for (const [index, candidate] of value.plugins.entries()) {
      const plugin = parseProjectionCapability(candidate, index)
      const registration = capabilityToRegistration(plugin)
      if (plugin.source.kind === 'browser-community') browserPlugins.push(registration)
      if (plugin.source.kind === 'runtime-plugin') {
        runtimeRecords.push({
          providerId: plugin.source.providerId,
          providerVersion: plugin.source.providerVersion,
          ...registration,
        })
      }
    }
    const expected = resolveProjectionPluginCapabilitySnapshot({
      schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      plugins: browserPlugins,
    }, createProjectionContributionSnapshot(runtimeRecords))
    if (value.digest !== expected.digest
      || JSON.stringify(value) !== JSON.stringify(expected)) {
      throw new TypeError('capability snapshot v3 is not canonical or its digest does not match')
    }
    return { status: 'valid', snapshot: expected }
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'capability snapshot v3 is invalid',
    }
  }
}

export function projectionPluginCapabilityDigest(
  plugins: readonly ProjectionPluginCapability[],
): string {
  return createHash('sha256')
    .update(`${CAPABILITY_DIGEST_DOMAIN}\0`, 'utf8')
    .update(JSON.stringify({ schemaVersion: 3, plugins }), 'utf8')
    .digest('hex')
}

export function projectionPluginContracts(
  snapshot: ProjectionPluginCapabilitySnapshot,
): ProjectionPluginContract[] {
  return snapshot.plugins.map((plugin) => ({
    id: plugin.pluginId,
    artifactRules: structuredClone(plugin.artifactRules),
    ...(plugin.nodeContext ? { nodeContext: structuredClone(plugin.nodeContext) } : {}),
    ...(plugin.acceptsUnknown ? { acceptsUnknown: true } : {}),
  }))
}

/** Extracts only browser-owned declarations so live runtime providers can be refreshed. */
export function browserCommunityProjectionClaims(
  snapshot: ProjectionPluginCapabilitySnapshot,
): ArtifactCapabilitySnapshotRequest {
  return {
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    plugins: snapshot.plugins
      .filter((plugin) => plugin.source.kind === 'browser-community')
      .map(capabilityToRegistration),
  }
}

export const BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT =
  resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    plugins: [],
  })

/** Content-addressed current snapshots. */
export class ProjectionPluginCapabilityStore {
  readonly projectDir: string
  readonly rootDir: string

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.rootDir = path.join(this.projectDir, '.gg', 'runtime', 'plugin-capabilities')
  }

  async register(
    browserClaims: unknown,
    runtimeContributions: unknown = EMPTY_RUNTIME_CONTRIBUTIONS,
  ): Promise<ProjectionPluginCapabilitySnapshot> {
    return this.#persist(resolveProjectionPluginCapabilitySnapshot(
      browserClaims,
      runtimeContributions,
    ))
  }

  /** Revalidates and durably pins a daemon-resolved v3 snapshot before acceptance. */
  async pin(value: unknown): Promise<ProjectionPluginCapabilitySnapshot> {
    const inspection = inspectProjectionPluginCapabilitySnapshot(value)
    if (inspection.status !== 'valid') {
      throw new TypeError(`plugin capability snapshot is invalid: ${inspection.reason}`)
    }
    return this.#persist(inspection.snapshot)
  }

  async #persist(
    snapshot: ProjectionPluginCapabilitySnapshot,
  ): Promise<ProjectionPluginCapabilitySnapshot> {
    await this.#assertSafeRoot(this.rootDir, 'plugin-capabilities', true)
    const target = this.#snapshotPath(this.rootDir, snapshot.digest)
    const existing = await this.get(snapshot.digest)
    if (existing) return existing

    const temporary = path.join(this.rootDir, `.tmp-${process.pid}-${randomUUID()}`)
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await link(temporary, target).catch((error: unknown) => {
        if (!isNodeError(error, 'EEXIST')) throw error
      })
    } finally {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
    const stored = await this.get(snapshot.digest)
    if (!stored) throw new Error('capability snapshot was not durably registered')
    return stored
  }

  /** Strict live lookup. New Runs can load only v3 snapshots. */
  async get(digest: string): Promise<ProjectionPluginCapabilitySnapshot | null> {
    return this.#readSnapshot(
      this.rootDir,
      'plugin-capabilities',
      digest,
      inspectProjectionPluginCapabilitySnapshot,
    )
  }

  /** Crash recovery revalidates the same current snapshot format. */
  async recover(
    digest: string | undefined,
  ): Promise<ProjectionPluginCapabilitySnapshot> {
    if (!digest) return structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT)
    const snapshot = await this.get(digest)
    if (!snapshot) throw new Error(`pinned plugin capability snapshot is missing: ${digest}`)
    return snapshot
  }

  async #readSnapshot<T extends ProjectionPluginCapabilitySnapshot>(
    rootDir: string,
    leaf: string,
    digest: string,
    inspect: (value: unknown) =>
      | { status: 'valid'; snapshot: T }
      | { status: 'invalid'; reason: string },
  ): Promise<T | null> {
    assertCapabilityDigest(digest)
    if (!await this.#assertSafeRoot(rootDir, leaf, false)) return null
    const filePath = this.#snapshotPath(rootDir, digest)
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CAPABILITY_SNAPSHOT_BYTES) {
        throw new Error('capability snapshot is not a safe bounded file')
      }
      const source = await readFileNoFollow(filePath)
      if (Buffer.byteLength(source, 'utf8') > MAX_CAPABILITY_SNAPSHOT_BYTES) {
        throw new Error('capability snapshot exceeds the supported size')
      }
      const inspection = inspect(JSON.parse(source))
      if (inspection.status !== 'valid') {
        throw new Error(`stored capability snapshot is invalid: ${inspection.reason}`)
      }
      if (inspection.snapshot.digest !== digest) {
        throw new Error('stored capability snapshot belongs to another digest')
      }
      return inspection.snapshot
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  #snapshotPath(rootDir: string, digest: string): string {
    assertCapabilityDigest(digest)
    return path.join(rootDir, `${digest}.json`)
  }

  async #assertSafeRoot(
    rootDir: string,
    leaf: string,
    create: boolean,
  ): Promise<string | null> {
    const canonicalProject = await canonicalizePotentialPath(this.projectDir)
    const expectedRoot = path.join(canonicalProject, '.gg', 'runtime', leaf)
    const canonicalRoot = await canonicalizePotentialPath(rootDir)
    if (canonicalRoot !== expectedRoot || !isPathWithin(canonicalProject, canonicalRoot)) {
      throw new Error('unsafe plugin capability root: path resolves through a symlink')
    }
    if (create) await mkdir(rootDir, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(rootDir)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('unsafe plugin capability root: expected a real directory')
      }
      return canonicalRoot
    } catch (error) {
      if (!create && isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }
}

function parseProjectionCapability(
  value: unknown,
  index: number,
): ProjectionPluginCapability {
  if (!isRecord(value)
    || !hasExactOptionalKeys(
      value,
      ['pluginId', 'source', 'artifactRules'],
      ['nodeContext', 'acceptsUnknown'],
    )
    || typeof value.pluginId !== 'string'
    || !isRecord(value.source)) {
    throw new TypeError(`plugins[${index}] is invalid`)
  }
  const registrationInspection = inspectProjectionPluginContracts([{
    id: value.pluginId,
    artifactRules: value.artifactRules,
    ...(value.nodeContext !== undefined ? { nodeContext: value.nodeContext } : {}),
    ...(value.acceptsUnknown !== undefined ? { acceptsUnknown: value.acceptsUnknown } : {}),
  }])
  if (registrationInspection.status !== 'valid') {
    throw new TypeError(`plugins[${index}] is invalid: ${registrationInspection.reason}`)
  }
  const contract = registrationInspection.plugins[0]!
  let source: ProjectionCapabilitySource
  if (hasExactKeys(value.source, ['kind', 'version'])
    && value.source.kind === 'builtin'
    && typeof value.source.version === 'string') {
    source = { kind: 'builtin', version: value.source.version }
  } else if (hasExactKeys(value.source, ['kind', 'providerId', 'providerVersion'])
    && value.source.kind === 'runtime-plugin'
    && typeof value.source.providerId === 'string'
    && typeof value.source.providerVersion === 'string') {
    source = {
      kind: 'runtime-plugin',
      providerId: value.source.providerId,
      providerVersion: value.source.providerVersion,
    }
  } else if (hasExactKeys(value.source, ['kind'])
    && value.source.kind === 'browser-community') {
    source = { kind: 'browser-community' }
  } else {
    throw new TypeError(`plugins[${index}].source is invalid`)
  }
  return {
    pluginId: contract.id,
    source,
    artifactRules: contract.artifactRules,
    ...(contract.nodeContext ? { nodeContext: contract.nodeContext } : {}),
    ...(contract.acceptsUnknown ? { acceptsUnknown: true } : {}),
  }
}

function toProjectionCapability(
  registration: ArtifactClaimRegistration,
  source: ProjectionCapabilitySource,
): ProjectionPluginCapability {
  const canonical = canonicalArtifactClaimRegistrations([registration])[0]!
  return {
    pluginId: canonical.id,
    source: structuredClone(source),
    artifactRules: canonical.artifactClaims,
    ...(canonical.nodeContext ? { nodeContext: canonical.nodeContext } : {}),
    ...(canonical.acceptsUnknown ? { acceptsUnknown: true } : {}),
  }
}

function runtimeContributionToCapability(
  contribution: ProjectionContributionRecord,
): ProjectionPluginCapability {
  const { providerId, providerVersion, ...registration } = contribution
  return toProjectionCapability(registration, {
    kind: 'runtime-plugin',
    providerId,
    providerVersion,
  })
}

function capabilityToRegistration(
  plugin: ProjectionPluginCapability,
): ArtifactClaimRegistration {
  return {
    id: plugin.pluginId,
    artifactClaims: structuredClone(plugin.artifactRules),
    ...(plugin.nodeContext ? { nodeContext: structuredClone(plugin.nodeContext) } : {}),
    ...(plugin.acceptsUnknown ? { acceptsUnknown: true } : {}),
  }
}

function builtinPluginCapabilityRegistrations(): ArtifactClaimRegistration[] {
  const registrations = new Map<string, ArtifactClaimRegistration>()
  for (const artifact of BUILTIN_ARTIFACT_CLAIM_REGISTRY) {
    registrations.set(artifact.id, structuredClone(artifact))
  }
  for (const context of BUILTIN_NODE_CONTEXT_POLICY_REGISTRY) {
    const existing = registrations.get(context.id)
    registrations.set(context.id, {
      id: context.id,
      artifactClaims: existing?.artifactClaims ?? [],
      nodeContext: structuredClone(context.nodeContext),
      ...(existing?.acceptsUnknown ? { acceptsUnknown: true } : {}),
    })
  }
  return [...registrations.values()]
}

function assertCapabilityDigest(value: unknown): asserts value is string {
  if (!isCapabilityDigest(value)) throw new TypeError('plugin capability digest is invalid')
}

function isCapabilityDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

async function readFileNoFollow(filePath: string): Promise<string> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(filePath, constants.O_RDONLY | noFollow)
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasExactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
