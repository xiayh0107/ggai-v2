import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
  BUILTIN_ARTIFACT_CLAIM_REGISTRY,
  BUILTIN_ARTIFACT_PLUGIN_IDS,
  canonicalArtifactClaimRegistrations,
  inspectArtifactCapabilitySnapshotRequest,
  type ArtifactClaimRegistration,
} from '../src/plugins/artifactContracts.js'
import {
  BUILTIN_NODE_CONTEXT_PLUGIN_IDS,
  BUILTIN_NODE_CONTEXT_POLICY_REGISTRY,
} from '../src/plugins/contextContracts.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'
import {
  inspectProjectionPluginContracts,
  type ProjectionPluginContract,
} from './projectionPlan.js'

const CAPABILITY_DIGEST_DOMAIN = 'ggai.projection-plugin-capabilities.v2'
const MAX_CAPABILITY_SNAPSHOT_BYTES = 4 * 1024 * 1024

export interface ProjectionPluginCapabilitySnapshot {
  schemaVersion: 2
  digest: string
  plugins: ProjectionPluginContract[]
}

export type ProjectionPluginCapabilitySnapshotInspection =
  | { status: 'valid'; snapshot: ProjectionPluginCapabilitySnapshot }
  | { status: 'invalid'; reason: string }

/**
 * Resolves untrusted browser claims into the complete immutable run contract.
 * Built-ins are daemon-owned and the generic `file` capability is the only
 * registration allowed to claim otherwise-unknown artifacts.
 */
export function resolveProjectionPluginCapabilitySnapshot(
  value: unknown,
): ProjectionPluginCapabilitySnapshot {
  const inspection = inspectArtifactCapabilitySnapshotRequest(value)
  if (inspection.status !== 'valid') {
    throw new TypeError(`plugin capability snapshot is invalid: ${inspection.reason}`)
  }
  for (const plugin of inspection.snapshot.plugins) {
    if (BUILTIN_NODE_CONTEXT_PLUGIN_IDS.has(plugin.id)) {
      throw new TypeError(`built-in plugin capability cannot be replaced: ${plugin.id}`)
    }
    if (plugin.acceptsUnknown) {
      throw new TypeError(`community artifact capability cannot accept unknown files: ${plugin.id}`)
    }
  }
  const registrations = canonicalArtifactClaimRegistrations([
    ...builtinPluginCapabilityRegistrations(),
    ...inspection.snapshot.plugins,
  ])
  const plugins = registrations.map(toProjectionPlugin)
  const digest = projectionPluginCapabilityDigest(plugins)
  return {
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    digest,
    plugins,
  }
}

export function inspectProjectionPluginCapabilitySnapshot(
  value: unknown,
): ProjectionPluginCapabilitySnapshotInspection {
  try {
    if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'digest', 'plugins'])
      || value.schemaVersion !== ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION
      || !isCapabilityDigest(value.digest)) {
      throw new TypeError('capability snapshot envelope is invalid')
    }
    const pluginInspection = inspectProjectionPluginContracts(value.plugins)
    if (pluginInspection.status !== 'valid') throw new TypeError(pluginInspection.reason)
    if (pluginInspection.plugins.every((plugin) => plugin.nodeContext === undefined)) {
      return inspectLegacyProjectionPluginCapabilitySnapshot(value, pluginInspection.plugins)
    }
    const community = projectionPluginsToCommunityRegistrations(pluginInspection.plugins)
    const expected = resolveProjectionPluginCapabilitySnapshot({
      schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      plugins: community,
    })
    if (value.digest !== expected.digest
      || JSON.stringify(pluginInspection.plugins) !== JSON.stringify(expected.plugins)) {
      throw new TypeError('capability snapshot is not canonical or its digest does not match')
    }
    return { status: 'valid', snapshot: expected }
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'capability snapshot is invalid',
    }
  }
}

/** Read-only compatibility for immutable snapshots written before Node context policies. */
function inspectLegacyProjectionPluginCapabilitySnapshot(
  value: Record<string, unknown>,
  plugins: ProjectionPluginContract[],
): ProjectionPluginCapabilitySnapshotInspection {
  try {
    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
    for (const builtin of BUILTIN_ARTIFACT_CLAIM_REGISTRY) {
      const actual = byId.get(builtin.id)
      const expected = toProjectionPlugin(
        canonicalArtifactClaimRegistrations([builtin])[0]!,
      )
      if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(`legacy built-in artifact capability changed or missing: ${builtin.id}`)
      }
    }
    for (const plugin of plugins) {
      if (BUILTIN_NODE_CONTEXT_PLUGIN_IDS.has(plugin.id)
        && !BUILTIN_ARTIFACT_PLUGIN_IDS.has(plugin.id)) {
        throw new TypeError(`legacy snapshot attempted to replace a built-in plugin: ${plugin.id}`)
      }
      if (!BUILTIN_ARTIFACT_PLUGIN_IDS.has(plugin.id) && plugin.acceptsUnknown) {
        throw new TypeError(`community artifact capability cannot accept unknown files: ${plugin.id}`)
      }
    }
    const expectedDigest = projectionPluginCapabilityDigest(plugins)
    if (value.digest !== expectedDigest) {
      throw new TypeError('legacy capability snapshot digest does not match')
    }
    return {
      status: 'valid',
      snapshot: {
        schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
        digest: expectedDigest,
        plugins,
      },
    }
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'legacy capability snapshot is invalid',
    }
  }
}

export function projectionPluginCapabilityDigest(
  plugins: readonly ProjectionPluginContract[],
): string {
  return createHash('sha256')
    .update(`${CAPABILITY_DIGEST_DOMAIN}\0`, 'utf8')
    .update(JSON.stringify({
      schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      plugins,
    }), 'utf8')
    .digest('hex')
}

export const BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT =
  resolveProjectionPluginCapabilitySnapshot({
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    plugins: [],
  })

/** Content-addressed, project-local capability snapshots used by accepted runs. */
export class ProjectionPluginCapabilityStore {
  readonly projectDir: string
  readonly rootDir: string

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.rootDir = path.join(this.projectDir, '.gg', 'runtime', 'plugin-capabilities-v2')
  }

  async register(value: unknown): Promise<ProjectionPluginCapabilitySnapshot> {
    const snapshot = resolveProjectionPluginCapabilitySnapshot(value)
    return this.#persist(snapshot)
  }

  /** Revalidates and durably pins a daemon-resolved snapshot before Run acceptance. */
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
    await this.#assertSafeRoot(true)
    const target = this.#snapshotPath(snapshot.digest)
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

  /** Strict live lookup. Missing or damaged requested snapshots are not substituted. */
  async get(digest: string): Promise<ProjectionPluginCapabilitySnapshot | null> {
    assertCapabilityDigest(digest)
    if (!await this.#assertSafeRoot(false)) return null
    const filePath = this.#snapshotPath(digest)
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CAPABILITY_SNAPSHOT_BYTES) {
        throw new Error('capability snapshot is not a safe bounded file')
      }
      const source = await readFileNoFollow(filePath)
      if (Buffer.byteLength(source, 'utf8') > MAX_CAPABILITY_SNAPSHOT_BYTES) {
        throw new Error('capability snapshot exceeds the supported size')
      }
      const inspection = inspectProjectionPluginCapabilitySnapshot(JSON.parse(source))
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

  /** Crash recovery only: missing/corrupt historical state safely loses community claims. */
  async recover(
    digest: string | undefined,
  ): Promise<ProjectionPluginCapabilitySnapshot> {
    if (!digest) return structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT)
    try {
      return await this.get(digest)
        ?? structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT)
    } catch {
      return structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT)
    }
  }

  #snapshotPath(digest: string): string {
    assertCapabilityDigest(digest)
    return path.join(this.rootDir, `${digest}.json`)
  }

  async #assertSafeRoot(create: boolean): Promise<string | null> {
    const canonicalProject = await canonicalizePotentialPath(this.projectDir)
    const expectedRoot = path.join(canonicalProject, '.gg', 'runtime', 'plugin-capabilities-v2')
    const canonicalRoot = await canonicalizePotentialPath(this.rootDir)
    if (canonicalRoot !== expectedRoot || !isPathWithin(canonicalProject, canonicalRoot)) {
      throw new Error('unsafe plugin capability root: path resolves through a symlink')
    }
    if (create) await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(this.rootDir)
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

function projectionPluginsToCommunityRegistrations(
  plugins: readonly ProjectionPluginContract[],
): ArtifactClaimRegistration[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  for (const builtin of builtinPluginCapabilityRegistrations()) {
    const actual = byId.get(builtin.id)
    const canonicalBuiltin = canonicalArtifactClaimRegistrations([builtin])[0]
    const expected = canonicalBuiltin ? toProjectionPlugin(canonicalBuiltin) : undefined
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new TypeError(`built-in plugin capability was changed or removed: ${builtin.id}`)
    }
  }
  return plugins
    .filter((plugin) => !BUILTIN_NODE_CONTEXT_PLUGIN_IDS.has(plugin.id))
    .map((plugin) => {
      if (plugin.acceptsUnknown) {
        throw new TypeError(`community artifact capability cannot accept unknown files: ${plugin.id}`)
      }
      return {
        id: plugin.id,
        artifactClaims: plugin.artifactRules,
        ...(plugin.nodeContext ? { nodeContext: plugin.nodeContext } : {}),
      }
    })
}

function toProjectionPlugin(
  registration: ArtifactClaimRegistration,
): ProjectionPluginContract {
  return {
    id: registration.id,
    artifactRules: registration.artifactClaims,
    ...(registration.nodeContext ? { nodeContext: registration.nodeContext } : {}),
    ...(registration.acceptsUnknown ? { acceptsUnknown: true } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
