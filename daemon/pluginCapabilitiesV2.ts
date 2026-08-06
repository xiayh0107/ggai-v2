import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION_V2,
  BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2,
  BUILTIN_ARTIFACT_PLUGIN_IDS_V2,
  canonicalArtifactClaimRegistrationsV2,
  inspectArtifactCapabilitySnapshotRequestV2,
  type ArtifactClaimRegistrationV2,
} from '../src/plugins/artifactContracts.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'
import {
  inspectProjectionPluginContractsV2,
  type ProjectionPluginContractV2,
} from './projectionPlanV2.js'

const CAPABILITY_DIGEST_DOMAIN_V2 = 'ggai.projection-plugin-capabilities.v2'
const MAX_CAPABILITY_SNAPSHOT_BYTES_V2 = 4 * 1024 * 1024

export interface ProjectionPluginCapabilitySnapshotV2 {
  schemaVersion: 2
  digest: string
  plugins: ProjectionPluginContractV2[]
}

export type ProjectionPluginCapabilitySnapshotInspectionV2 =
  | { status: 'valid'; snapshot: ProjectionPluginCapabilitySnapshotV2 }
  | { status: 'invalid'; reason: string }

/**
 * Resolves untrusted browser claims into the complete immutable run contract.
 * Built-ins are daemon-owned and the generic `file` capability is the only
 * registration allowed to claim otherwise-unknown artifacts.
 */
export function resolveProjectionPluginCapabilitySnapshotV2(
  value: unknown,
): ProjectionPluginCapabilitySnapshotV2 {
  const inspection = inspectArtifactCapabilitySnapshotRequestV2(value)
  if (inspection.status !== 'valid') {
    throw new TypeError(`plugin capability snapshot is invalid: ${inspection.reason}`)
  }
  for (const plugin of inspection.snapshot.plugins) {
    if (BUILTIN_ARTIFACT_PLUGIN_IDS_V2.has(plugin.id)) {
      throw new TypeError(`built-in artifact capability cannot be replaced: ${plugin.id}`)
    }
    if (plugin.acceptsUnknown) {
      throw new TypeError(`community artifact capability cannot accept unknown files: ${plugin.id}`)
    }
  }
  const registrations = canonicalArtifactClaimRegistrationsV2([
    ...BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2,
    ...inspection.snapshot.plugins,
  ])
  const plugins = registrations.map(toProjectionPlugin)
  const digest = projectionPluginCapabilityDigestV2(plugins)
  return {
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION_V2,
    digest,
    plugins,
  }
}

export function inspectProjectionPluginCapabilitySnapshotV2(
  value: unknown,
): ProjectionPluginCapabilitySnapshotInspectionV2 {
  try {
    if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'digest', 'plugins'])
      || value.schemaVersion !== ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION_V2
      || !isCapabilityDigest(value.digest)) {
      throw new TypeError('capability snapshot envelope is invalid')
    }
    const pluginInspection = inspectProjectionPluginContractsV2(value.plugins)
    if (pluginInspection.status !== 'valid') throw new TypeError(pluginInspection.reason)
    const community = projectionPluginsToCommunityRegistrations(pluginInspection.plugins)
    const expected = resolveProjectionPluginCapabilitySnapshotV2({
      schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION_V2,
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

export function projectionPluginCapabilityDigestV2(
  plugins: readonly ProjectionPluginContractV2[],
): string {
  return createHash('sha256')
    .update(`${CAPABILITY_DIGEST_DOMAIN_V2}\0`, 'utf8')
    .update(JSON.stringify({
      schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION_V2,
      plugins,
    }), 'utf8')
    .digest('hex')
}

export const BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2 =
  resolveProjectionPluginCapabilitySnapshotV2({
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION_V2,
    plugins: [],
  })

/** Content-addressed, project-local capability snapshots used by accepted runs. */
export class ProjectionPluginCapabilityStoreV2 {
  readonly projectDir: string
  readonly rootDir: string

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.rootDir = path.join(this.projectDir, '.gg', 'runtime', 'plugin-capabilities-v2')
  }

  async register(value: unknown): Promise<ProjectionPluginCapabilitySnapshotV2> {
    const snapshot = resolveProjectionPluginCapabilitySnapshotV2(value)
    return this.#persist(snapshot)
  }

  /** Revalidates and durably pins a daemon-resolved snapshot before Run acceptance. */
  async pin(value: unknown): Promise<ProjectionPluginCapabilitySnapshotV2> {
    const inspection = inspectProjectionPluginCapabilitySnapshotV2(value)
    if (inspection.status !== 'valid') {
      throw new TypeError(`plugin capability snapshot is invalid: ${inspection.reason}`)
    }
    return this.#persist(inspection.snapshot)
  }

  async #persist(
    snapshot: ProjectionPluginCapabilitySnapshotV2,
  ): Promise<ProjectionPluginCapabilitySnapshotV2> {
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
  async get(digest: string): Promise<ProjectionPluginCapabilitySnapshotV2 | null> {
    assertCapabilityDigest(digest)
    if (!await this.#assertSafeRoot(false)) return null
    const filePath = this.#snapshotPath(digest)
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CAPABILITY_SNAPSHOT_BYTES_V2) {
        throw new Error('capability snapshot is not a safe bounded file')
      }
      const source = await readFileNoFollow(filePath)
      if (Buffer.byteLength(source, 'utf8') > MAX_CAPABILITY_SNAPSHOT_BYTES_V2) {
        throw new Error('capability snapshot exceeds the supported size')
      }
      const inspection = inspectProjectionPluginCapabilitySnapshotV2(JSON.parse(source))
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
  ): Promise<ProjectionPluginCapabilitySnapshotV2> {
    if (!digest) return structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2)
    try {
      return await this.get(digest)
        ?? structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2)
    } catch {
      return structuredClone(BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT_V2)
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
  plugins: readonly ProjectionPluginContractV2[],
): ArtifactClaimRegistrationV2[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  for (const builtin of BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2) {
    const actual = byId.get(builtin.id)
    const canonicalBuiltin = canonicalArtifactClaimRegistrationsV2([builtin])[0]
    const expected = canonicalBuiltin ? toProjectionPlugin(canonicalBuiltin) : undefined
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new TypeError(`built-in artifact capability was changed or removed: ${builtin.id}`)
    }
  }
  return plugins
    .filter((plugin) => !BUILTIN_ARTIFACT_PLUGIN_IDS_V2.has(plugin.id))
    .map((plugin) => {
      if (plugin.acceptsUnknown) {
        throw new TypeError(`community artifact capability cannot accept unknown files: ${plugin.id}`)
      }
      return { id: plugin.id, artifactClaims: plugin.artifactRules }
    })
}

function toProjectionPlugin(
  registration: ArtifactClaimRegistrationV2,
): ProjectionPluginContractV2 {
  return {
    id: registration.id,
    artifactRules: registration.artifactClaims,
    ...(registration.acceptsUnknown ? { acceptsUnknown: true } : {}),
  }
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
