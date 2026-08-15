import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { CapabilityProfileSnapshot } from './runtime/composition.js'
import type { ServiceProviderSnapshot } from './runtime/services.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'

export const RUN_CAPABILITY_RECEIPT_SCHEMA_VERSION = 1 as const
const RECEIPT_DIGEST_DOMAIN = 'ggai.run-capability-receipt.v1'
const PROFILE_DIGEST_DOMAIN = 'ggai.capability-profile-snapshot.v1'
const MAX_RECEIPT_BYTES = 1024 * 1024
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u
const CAPABILITY_KEY = /^ggai\.[a-z0-9][a-z0-9.-]*\.v[1-9][0-9]*$/u
const DIGEST = /^[0-9a-f]{64}$/u

export interface SemanticCapabilityReceipt {
  readonly key: string
  readonly provider: string
  readonly digest: string
}

export interface RunCapabilityReceipt {
  readonly schemaVersion: typeof RUN_CAPABILITY_RECEIPT_SCHEMA_VERSION
  readonly runId: string
  readonly profile: CapabilityProfileSnapshot
  readonly profileDigest: string
  readonly services: readonly ServiceProviderSnapshot[]
  readonly semanticCapabilities: readonly SemanticCapabilityReceipt[]
  readonly digest: string
}

export type RunCapabilityReceiptInspection =
  | { readonly status: 'valid'; readonly receipt: RunCapabilityReceipt }
  | { readonly status: 'invalid'; readonly reason: string }

export function createRunCapabilityReceipt(input: {
  runId: string
  profile: CapabilityProfileSnapshot
  services: readonly ServiceProviderSnapshot[]
  semanticCapabilities?: readonly SemanticCapabilityReceipt[]
}): RunCapabilityReceipt {
  assertRunId(input.runId)
  const profile = cloneJson(input.profile)
  const services = canonicalServices(input.services)
  const semanticCapabilities = canonicalSemanticCapabilities(
    input.semanticCapabilities ?? [],
  )
  const profileDigest = digestJson(PROFILE_DIGEST_DOMAIN, profile)
  const body = {
    schemaVersion: RUN_CAPABILITY_RECEIPT_SCHEMA_VERSION,
    runId: input.runId,
    profile,
    profileDigest,
    services,
    semanticCapabilities,
  }
  return deepFreeze({
    ...body,
    digest: digestJson(RECEIPT_DIGEST_DOMAIN, body),
  })
}

export function inspectRunCapabilityReceipt(value: unknown): RunCapabilityReceiptInspection {
  try {
    if (!isRecord(value) || !hasExactKeys(value, [
      'schemaVersion',
      'runId',
      'profile',
      'profileDigest',
      'services',
      'semanticCapabilities',
      'digest',
    ])) {
      throw new TypeError('capability receipt envelope is invalid')
    }
    if (value.schemaVersion !== RUN_CAPABILITY_RECEIPT_SCHEMA_VERSION
      || typeof value.runId !== 'string'
      || !Array.isArray(value.services)
      || !Array.isArray(value.semanticCapabilities)
      || !isRecord(value.profile)
      || typeof value.profileDigest !== 'string'
      || typeof value.digest !== 'string') {
      throw new TypeError('capability receipt fields are invalid')
    }
    const expected = createRunCapabilityReceipt({
      runId: value.runId,
      profile: value.profile as unknown as CapabilityProfileSnapshot,
      services: value.services as unknown as ServiceProviderSnapshot[],
      semanticCapabilities: value.semanticCapabilities as unknown as SemanticCapabilityReceipt[],
    })
    if (!DIGEST.test(value.profileDigest) || value.profileDigest !== expected.profileDigest) {
      throw new TypeError('capability profile digest does not match')
    }
    if (!DIGEST.test(value.digest) || value.digest !== expected.digest) {
      throw new TypeError('capability receipt digest does not match')
    }
    if (JSON.stringify(value) !== JSON.stringify(expected)) {
      throw new TypeError('capability receipt is not canonical')
    }
    return { status: 'valid', receipt: expected }
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'capability receipt is invalid',
    }
  }
}

/** Project-local immutable receipt storage keyed by accepted Run identity. */
export class RunCapabilityReceiptStore {
  readonly projectDir: string
  readonly rootDir: string

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.rootDir = path.join(this.projectDir, '.gg', 'runtime', 'capability-receipts-v1')
  }

  async pin(value: unknown): Promise<RunCapabilityReceipt> {
    const inspection = inspectRunCapabilityReceipt(value)
    if (inspection.status !== 'valid') {
      throw new TypeError(`Run capability receipt is invalid: ${inspection.reason}`)
    }
    const receipt = inspection.receipt
    await this.#assertSafeRoot(true)
    const existing = await this.get(receipt.runId)
    if (existing) {
      if (existing.digest !== receipt.digest) {
        throw new Error(`Run capability receipt already exists with another digest: ${receipt.runId}`)
      }
      return existing
    }

    const temporary = path.join(this.rootDir, `.tmp-${process.pid}-${randomUUID()}`)
    const target = this.#receiptPath(receipt.runId)
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
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

    const stored = await this.get(receipt.runId)
    if (!stored) throw new Error('Run capability receipt was not durably registered')
    if (stored.digest !== receipt.digest) {
      throw new Error(`Run capability receipt raced with another digest: ${receipt.runId}`)
    }
    return stored
  }

  async get(runId: string): Promise<RunCapabilityReceipt | null> {
    assertRunId(runId)
    if (!await this.#assertSafeRoot(false)) return null
    const filePath = this.#receiptPath(runId)
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) {
        throw new Error('stored capability receipt is not a safe bounded file')
      }
      const source = await readFileNoFollow(filePath)
      if (Buffer.byteLength(source, 'utf8') > MAX_RECEIPT_BYTES) {
        throw new Error('stored capability receipt exceeds the supported size')
      }
      const inspection = inspectRunCapabilityReceipt(JSON.parse(source) as unknown)
      if (inspection.status !== 'valid') {
        throw new Error(`stored capability receipt is invalid: ${inspection.reason}`)
      }
      if (inspection.receipt.runId !== runId) {
        throw new Error('stored capability receipt belongs to another Run')
      }
      return inspection.receipt
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  #receiptPath(runId: string): string {
    assertRunId(runId)
    return path.join(this.rootDir, `${runId}.json`)
  }

  async #assertSafeRoot(create: boolean): Promise<string | null> {
    const canonicalProject = await canonicalizePotentialPath(this.projectDir)
    const expectedRoot = path.join(
      canonicalProject,
      '.gg',
      'runtime',
      'capability-receipts-v1',
    )
    const canonicalRoot = await canonicalizePotentialPath(this.rootDir)
    if (canonicalRoot !== expectedRoot || !isPathWithin(canonicalProject, canonicalRoot)) {
      throw new Error('unsafe capability receipt root: path resolves through a symlink')
    }
    if (create) await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(this.rootDir)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('unsafe capability receipt root: expected a real directory')
      }
      return canonicalRoot
    } catch (error) {
      if (!create && isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }
}

function canonicalServices(
  services: readonly ServiceProviderSnapshot[],
): ServiceProviderSnapshot[] {
  const byId = new Map<string, ServiceProviderSnapshot>()
  for (const service of services) {
    if (!isRecord(service) || typeof service.id !== 'string' || typeof service.owner !== 'string') {
      throw new TypeError('capability service receipt is invalid')
    }
    if (!CAPABILITY_KEY.test(service.id)) {
      throw new TypeError(`invalid capability service key: ${service.id}`)
    }
    assertBoundedText(service.owner, 'capability service owner')
    if (byId.has(service.id)) throw new TypeError(`duplicate capability service key: ${service.id}`)
    byId.set(service.id, { id: service.id, owner: service.owner })
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function canonicalSemanticCapabilities(
  capabilities: readonly SemanticCapabilityReceipt[],
): SemanticCapabilityReceipt[] {
  const byKey = new Map<string, SemanticCapabilityReceipt>()
  for (const capability of capabilities) {
    if (!isRecord(capability)
      || typeof capability.key !== 'string'
      || typeof capability.provider !== 'string'
      || typeof capability.digest !== 'string') {
      throw new TypeError('semantic capability receipt is invalid')
    }
    if (!CAPABILITY_KEY.test(capability.key)) {
      throw new TypeError(`invalid semantic capability key: ${capability.key}`)
    }
    assertBoundedText(capability.provider, 'semantic capability provider')
    if (!DIGEST.test(capability.digest)) {
      throw new TypeError(`invalid semantic capability digest: ${capability.key}`)
    }
    if (byKey.has(capability.key)) {
      throw new TypeError(`duplicate semantic capability key: ${capability.key}`)
    }
    byKey.set(capability.key, {
      key: capability.key,
      provider: capability.provider,
      digest: capability.digest,
    })
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function digestJson(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\0`, 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex')
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new TypeError(`invalid Run capability receipt id: ${runId}`)
}

function assertBoundedText(value: string, label: string): void {
  if (!value || value.length > 240 || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })) {
    throw new TypeError(`${label} is invalid`)
  }
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
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
