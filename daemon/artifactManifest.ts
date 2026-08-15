import { createHash } from 'node:crypto'
import path from 'node:path'
import { isSafeArtifactReference } from './artifactPaths.js'
import { parseRunId } from './protocol.js'

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1
export const MAX_ARTIFACT_MANIFEST_ENTRIES = 500
export const MAX_ARTIFACT_MEDIA_TYPE_LENGTH = 200
export const MAX_ARTIFACT_BYTES = Number.MAX_SAFE_INTEGER

/**
 * Daemon-side collection evidence. Collection-only trust metadata is removed
 * before an entry is put in the persisted manifest.
 */
export interface ArtifactManifestFileCandidate {
  ownerRunId: string
  relativePath: string
  kind: 'file' | 'symbolic-link' | 'other'
  temporary: boolean
  mediaType?: string
  size: number
  contentDigest: string
}

/** Exactly one regular file underneath `<runRoot>/files/`. */
export interface ArtifactManifestEntry {
  artifactId: string
  relativePath: string
  mediaType: string
  size: number
  contentDigest: string
}

/**
 * A daemon-authored, run-owned artifact inventory.
 *
 * Entries are relative to the authoritative `<runRoot>/files` directory held
 * by the run record. Filesystem roots are deliberately not persisted here.
 */
export interface ArtifactManifest {
  version: 1
  runId: string
  complete: boolean
  entries: ArtifactManifestEntry[]
}

export interface BuildArtifactManifestInput {
  runId: string
  complete: boolean
  files: readonly ArtifactManifestFileCandidate[]
}

export type ArtifactManifestInspection =
  | { status: 'valid'; manifest: ArtifactManifest }
  | { status: 'invalid'; reason: string }

export function buildArtifactManifest(input: BuildArtifactManifestInput): ArtifactManifest {
  const runId = parseRunId(input.runId)
  if (typeof input.complete !== 'boolean') throw new TypeError('complete must be a boolean')
  if (!Array.isArray(input.files) || input.files.length > MAX_ARTIFACT_MANIFEST_ENTRIES) {
    throw new TypeError('artifact manifest has too many candidates')
  }

  const seenPaths = new Set<string>()
  const entries: ArtifactManifestEntry[] = []
  for (const [index, candidate] of input.files.entries()) {
    const ownerRunId = parseRunId(candidate.ownerRunId)
    const relativePath = normalizeArtifactRelativePath(candidate.relativePath)
    if (candidate.kind !== 'file'
      && candidate.kind !== 'symbolic-link'
      && candidate.kind !== 'other') throw new TypeError(`files[${index}].kind is invalid`)
    if (typeof candidate.temporary !== 'boolean') {
      throw new TypeError(`files[${index}].temporary is invalid`)
    }

    // These sources never become entries. A symbolic link is excluded even
    // when it resolves inside filesRoot so it cannot later retarget elsewhere.
    if (ownerRunId !== runId
      || candidate.kind !== 'file'
      || candidate.temporary
      || isArtifactControlRelativePath(relativePath)
      || isTemporaryArtifactRelativePath(relativePath)) continue

    if (seenPaths.has(relativePath)) throw new TypeError(`files[${index}].relativePath is duplicated`)
    seenPaths.add(relativePath)
    if (!Number.isSafeInteger(candidate.size)
      || candidate.size < 0
      || candidate.size > MAX_ARTIFACT_BYTES) {
      throw new TypeError(`files[${index}].size is invalid`)
    }
    const mediaType = normalizeMediaType(candidate.mediaType)
    if (!isSha256(candidate.contentDigest)) {
      throw new TypeError(`files[${index}].contentDigest is invalid`)
    }
    entries.push({
      artifactId: artifactIdForManifest(runId, relativePath),
      relativePath,
      mediaType,
      size: candidate.size,
      contentDigest: candidate.contentDigest,
    })
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  const unsigned = {
    version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    runId,
    complete: input.complete,
    entries,
  } as const
  return unsigned
}

export function inspectArtifactManifest(value: unknown): ArtifactManifestInspection {
  if (!isExactRecord(value, [
    'version',
    'runId',
    'complete',
    'entries',
  ])) return invalid('artifact manifest has an invalid envelope')
  if (value.version !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    return invalid('artifact manifest version is unsupported')
  }
  if (!Array.isArray(value.entries)) return invalid('artifact manifest entries must be an array')

  try {
    if (typeof value.runId !== 'string'
      || typeof value.complete !== 'boolean') return invalid('artifact manifest fields are invalid')

    const candidates: ArtifactManifestFileCandidate[] = value.entries.map((candidate, index) => {
      if (!isExactRecord(candidate, [
        'artifactId',
        'relativePath',
        'mediaType',
        'size',
        'contentDigest',
      ])) throw new TypeError(`entries[${index}] is invalid`)
      if (typeof candidate.artifactId !== 'string'
        || typeof candidate.relativePath !== 'string'
        || typeof candidate.mediaType !== 'string'
        || typeof candidate.size !== 'number'
        || typeof candidate.contentDigest !== 'string') {
        throw new TypeError(`entries[${index}] fields are invalid`)
      }
      return {
        ownerRunId: value.runId as string,
        relativePath: candidate.relativePath,
        kind: 'file',
        temporary: false,
        mediaType: candidate.mediaType,
        size: candidate.size,
        contentDigest: candidate.contentDigest,
      }
    })
    const rebuilt = buildArtifactManifest({
      runId: value.runId,
      complete: value.complete,
      files: candidates,
    })
    if (JSON.stringify(rebuilt.entries) !== JSON.stringify(value.entries)) {
      return invalid('artifact manifest entries are not canonical')
    }
    return { status: 'valid', manifest: rebuilt }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'artifact manifest is invalid')
  }
}

export function artifactIdForManifest(runId: string, relativePath: string): string {
  const parsedRunId = parseRunId(runId)
  const normalizedRelativePath = normalizeArtifactRelativePath(relativePath)
  if (isArtifactControlRelativePath(normalizedRelativePath)
    || isTemporaryArtifactRelativePath(normalizedRelativePath)) {
    throw new TypeError('relativePath is not an artifact file')
  }
  return `artifact_${createHash('sha256')
    .update(parsedRunId, 'utf8')
    .update('\0', 'utf8')
    .update(normalizedRelativePath, 'utf8')
    .digest('hex')}`
}

export function artifactProjectPath(
  runFilesRoot: string,
  entry: Pick<ArtifactManifestEntry, 'relativePath'>,
): string {
  if (!isSafeArtifactReference(runFilesRoot)
    || !runFilesRoot.endsWith('/files')) {
    throw new TypeError('runFilesRoot must be the authoritative run root/files path')
  }
  const relativePath = normalizeArtifactRelativePath(entry.relativePath)
  if (isArtifactControlRelativePath(relativePath)
    || isTemporaryArtifactRelativePath(relativePath)) {
    throw new TypeError('artifact entry is not a durable artifact file')
  }
  const resolved = path.posix.join(runFilesRoot, relativePath)
  if (!isSafeArtifactReference(resolved)
    || !resolved.startsWith(`${runFilesRoot}/`)) {
    throw new TypeError('artifact entry escapes filesRoot')
  }
  return resolved
}

/** Independent content digest used when binding a manifest to a projection plan. */
export function artifactManifestDigest(manifest: ArtifactManifest): string {
  const inspection = inspectArtifactManifest(manifest)
  if (inspection.status !== 'valid') {
    throw new TypeError(`artifact manifest is invalid: ${inspection.reason}`)
  }
  return digestJson('ggai-artifact-manifest-v1', inspection.manifest)
}

export function normalizeArtifactRelativePath(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 4_096
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || value.includes('//')
    || path.posix.normalize(value) !== value
    || value.split('/').some((segment) =>
      segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError('relativePath is unsafe')
  }
  return value
}

export function isArtifactControlRelativePath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment.toLowerCase() === '.ggai')
}

export function isTemporaryArtifactRelativePath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase()
  return basename === '.ds_store'
    || basename.startsWith('.tmp-')
    || basename.startsWith('.temp-')
    || basename.startsWith('~$')
    || basename.endsWith('~')
    || /\.(?:tmp|temp|part|partial|crdownload|download)$/u.test(basename)
}

function normalizeMediaType(value: string | undefined): string {
  if (value === undefined) return 'application/octet-stream'
  if (value.length === 0
    || value.length > MAX_ARTIFACT_MEDIA_TYPE_LENGTH
    || value !== value.trim().toLowerCase()
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value)) {
    throw new TypeError('mediaType is invalid')
  }
  return value
}

function digestJson(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\0`, 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex')
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function invalid(reason: string): { status: 'invalid'; reason: string } {
  return { status: 'invalid', reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
