import { createHash } from 'node:crypto'
import path from 'node:path'
import { isSafeArtifactReference } from './artifactPaths.js'
import { parseRunId } from './protocol.js'

export const ARTIFACT_MANIFEST_V1_VERSION = 1
export const MAX_ARTIFACT_MANIFEST_ENTRIES_V1 = 500
export const MAX_ARTIFACT_MEDIA_TYPE_LENGTH_V1 = 200
export const MAX_ARTIFACT_BYTES_V1 = Number.MAX_SAFE_INTEGER

/**
 * Daemon-side collection evidence. Collection-only trust metadata is removed
 * before an entry is put in the persisted manifest.
 */
export interface ArtifactManifestFileCandidateV1 {
  ownerRunId: string
  relativePath: string
  kind: 'file' | 'symbolic-link' | 'other'
  temporary: boolean
  mediaType?: string
  size: number
  contentDigest: string
}

/** Exactly one regular file underneath `<runRoot>/files/`. */
export interface ArtifactManifestEntryV1 {
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
export interface ArtifactManifestV1 {
  version: 1
  runId: string
  complete: boolean
  entries: ArtifactManifestEntryV1[]
}

export interface BuildArtifactManifestV1Input {
  runId: string
  complete: boolean
  files: readonly ArtifactManifestFileCandidateV1[]
}

export type ArtifactManifestV1Inspection =
  | { status: 'valid'; manifest: ArtifactManifestV1 }
  | { status: 'invalid'; reason: string }

export function buildArtifactManifestV1(input: BuildArtifactManifestV1Input): ArtifactManifestV1 {
  const runId = parseRunId(input.runId)
  if (typeof input.complete !== 'boolean') throw new TypeError('complete must be a boolean')
  if (!Array.isArray(input.files) || input.files.length > MAX_ARTIFACT_MANIFEST_ENTRIES_V1) {
    throw new TypeError('artifact manifest has too many candidates')
  }

  const seenPaths = new Set<string>()
  const entries: ArtifactManifestEntryV1[] = []
  for (const [index, candidate] of input.files.entries()) {
    const ownerRunId = parseRunId(candidate.ownerRunId)
    const relativePath = normalizeArtifactRelativePathV1(candidate.relativePath)
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
      || isArtifactControlRelativePathV1(relativePath)
      || isTemporaryArtifactRelativePathV1(relativePath)) continue

    if (seenPaths.has(relativePath)) throw new TypeError(`files[${index}].relativePath is duplicated`)
    seenPaths.add(relativePath)
    if (!Number.isSafeInteger(candidate.size)
      || candidate.size < 0
      || candidate.size > MAX_ARTIFACT_BYTES_V1) {
      throw new TypeError(`files[${index}].size is invalid`)
    }
    const mediaType = normalizeMediaType(candidate.mediaType)
    if (!isSha256(candidate.contentDigest)) {
      throw new TypeError(`files[${index}].contentDigest is invalid`)
    }
    entries.push({
      artifactId: artifactIdForV1(runId, relativePath),
      relativePath,
      mediaType,
      size: candidate.size,
      contentDigest: candidate.contentDigest,
    })
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  const unsigned = {
    version: ARTIFACT_MANIFEST_V1_VERSION,
    runId,
    complete: input.complete,
    entries,
  } as const
  return unsigned
}

export function inspectArtifactManifestV1(value: unknown): ArtifactManifestV1Inspection {
  if (!isExactRecord(value, [
    'version',
    'runId',
    'complete',
    'entries',
  ])) return invalid('artifact manifest has an invalid envelope')
  if (value.version !== ARTIFACT_MANIFEST_V1_VERSION) {
    return invalid('artifact manifest version is unsupported')
  }
  if (!Array.isArray(value.entries)) return invalid('artifact manifest entries must be an array')

  try {
    if (typeof value.runId !== 'string'
      || typeof value.complete !== 'boolean') return invalid('artifact manifest fields are invalid')

    const candidates: ArtifactManifestFileCandidateV1[] = value.entries.map((candidate, index) => {
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
    const rebuilt = buildArtifactManifestV1({
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

export function artifactIdForV1(runId: string, relativePath: string): string {
  const parsedRunId = parseRunId(runId)
  const normalizedRelativePath = normalizeArtifactRelativePathV1(relativePath)
  if (isArtifactControlRelativePathV1(normalizedRelativePath)
    || isTemporaryArtifactRelativePathV1(normalizedRelativePath)) {
    throw new TypeError('relativePath is not an artifact file')
  }
  return `artifact_${createHash('sha256')
    .update(parsedRunId, 'utf8')
    .update('\0', 'utf8')
    .update(normalizedRelativePath, 'utf8')
    .digest('hex')}`
}

export function artifactProjectPathV1(
  runFilesRoot: string,
  entry: Pick<ArtifactManifestEntryV1, 'relativePath'>,
): string {
  if (!isSafeArtifactReference(runFilesRoot)
    || !runFilesRoot.endsWith('/files')) {
    throw new TypeError('runFilesRoot must be the authoritative run root/files path')
  }
  const relativePath = normalizeArtifactRelativePathV1(entry.relativePath)
  if (isArtifactControlRelativePathV1(relativePath)
    || isTemporaryArtifactRelativePathV1(relativePath)) {
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
export function artifactManifestDigestV1(manifest: ArtifactManifestV1): string {
  const inspection = inspectArtifactManifestV1(manifest)
  if (inspection.status !== 'valid') {
    throw new TypeError(`artifact manifest is invalid: ${inspection.reason}`)
  }
  return digestJson('ggai-artifact-manifest-v1', inspection.manifest)
}

export function normalizeArtifactRelativePathV1(value: unknown): string {
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

export function isArtifactControlRelativePathV1(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment.toLowerCase() === '.ggai')
}

export function isTemporaryArtifactRelativePathV1(relativePath: string): boolean {
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
    || value.length > MAX_ARTIFACT_MEDIA_TYPE_LENGTH_V1
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
