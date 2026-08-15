import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'
import {
  inspectProjectionCapabilityProvenanceSnapshot,
  type ProjectionCapabilityProvenanceSnapshot,
} from './projectionCapabilityComposer.js'

// Provenance embeds the complete final classification plus the Runtime source
// snapshot. Keep it bounded independently from either constituent format.
const MAX_PROVENANCE_BYTES = 8 * 1024 * 1024
const DIGEST = /^[0-9a-f]{64}$/u

/** Immutable, project-local storage for projection provenance snapshots. */
export class ProjectionCapabilityProvenanceStore {
  readonly projectDir: string
  readonly rootDir: string

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.rootDir = path.join(
      this.projectDir,
      '.gg',
      'runtime',
      'projection-provenance-v1',
    )
  }

  async pin(value: unknown): Promise<ProjectionCapabilityProvenanceSnapshot> {
    const inspection = inspectProjectionCapabilityProvenanceSnapshot(value)
    if (inspection.status !== 'valid') {
      throw new TypeError(`projection provenance is invalid: ${inspection.reason}`)
    }
    const snapshot = inspection.snapshot
    await this.#assertSafeRoot(true)
    const existing = await this.get(snapshot.digest)
    if (existing) return existing

    const temporary = path.join(this.rootDir, `.tmp-${process.pid}-${randomUUID()}`)
    const target = this.#snapshotPath(snapshot.digest)
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
    if (!stored) throw new Error('projection provenance was not durably registered')
    return stored
  }

  async get(digest: string): Promise<ProjectionCapabilityProvenanceSnapshot | null> {
    assertDigest(digest)
    if (!await this.#assertSafeRoot(false)) return null
    const filePath = this.#snapshotPath(digest)
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROVENANCE_BYTES) {
        throw new Error('stored projection provenance is not a safe bounded file')
      }
      const source = await readFileNoFollow(filePath)
      if (Buffer.byteLength(source, 'utf8') > MAX_PROVENANCE_BYTES) {
        throw new Error('stored projection provenance exceeds the supported size')
      }
      const inspection = inspectProjectionCapabilityProvenanceSnapshot(
        JSON.parse(source) as unknown,
      )
      if (inspection.status !== 'valid') {
        throw new Error(`stored projection provenance is invalid: ${inspection.reason}`)
      }
      if (inspection.snapshot.digest !== digest) {
        throw new Error('stored projection provenance belongs to another digest')
      }
      return inspection.snapshot
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  #snapshotPath(digest: string): string {
    assertDigest(digest)
    return path.join(this.rootDir, `${digest}.json`)
  }

  async #assertSafeRoot(create: boolean): Promise<string | null> {
    const canonicalProject = await canonicalizePotentialPath(this.projectDir)
    const expectedRoot = path.join(
      canonicalProject,
      '.gg',
      'runtime',
      'projection-provenance-v1',
    )
    const canonicalRoot = await canonicalizePotentialPath(this.rootDir)
    if (canonicalRoot !== expectedRoot || !isPathWithin(canonicalProject, canonicalRoot)) {
      throw new Error('unsafe projection provenance root: path resolves through a symlink')
    }
    if (create) await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(this.rootDir)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('unsafe projection provenance root: expected a real directory')
      }
      return canonicalRoot
    } catch (error) {
      if (!create && isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }
}

function assertDigest(value: string): void {
  if (!DIGEST.test(value)) throw new TypeError('projection provenance digest is invalid')
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
