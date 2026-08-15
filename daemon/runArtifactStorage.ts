import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  artifactManifestDigest,
  buildArtifactManifest,
  inspectArtifactManifest,
  isArtifactControlRelativePath,
  isTemporaryArtifactRelativePath,
  MAX_ARTIFACT_MANIFEST_ENTRIES,
  normalizeArtifactRelativePath,
  type ArtifactManifestEntry,
  type ArtifactManifestFileCandidate,
  type ArtifactManifest,
} from './artifactManifest.js'
import { atomicWriteText, isNodeError } from './atomic-file.js'
import { canvasBranchStorageId } from './canvasBranch.js'
import { parseCanvasBranch, parseRunId } from './protocol.js'

export const RUN_ARTIFACT_MANIFEST_RELATIVE_PATH = '.ggai/artifact-manifest.v1.json'
export const MAX_RUN_ARTIFACT_DIRECTORIES = 2_000
export const MAX_RUN_ARTIFACT_DEPTH = 64
export const MAX_RUN_ARTIFACT_MANIFEST_BYTES = 4 * 1024 * 1024

export interface RunArtifactLocation {
  canvasBranch: string
  branchStorageId: string
  runId: string
  projectRelativeRunRoot: string
  projectRelativeFilesRoot: string
  absoluteRunRoot: string
  absoluteFilesRoot: string
  absoluteManifestPath: string
}

export interface ExcludedRunArtifact {
  relativePath: string
  reason: 'control' | 'temporary' | 'symlink' | 'foreign' | 'unsupported' | 'limit'
}

export interface CloseRunArtifactsOptions {
  /** False when the run collector itself knows its output snapshot was incomplete. */
  complete?: boolean
}

export interface ClosedRunArtifacts {
  location: RunArtifactLocation
  manifest: ArtifactManifest
  manifestDigest: string
  excluded: ExcludedRunArtifact[]
}

export interface RunArtifactLookup extends ArtifactManifestEntry {
  canvasBranch: string
  branchStorageId: string
  runId: string
  projectRelativePath: string
  absolutePath: string
  manifestDigest: string
}

/**
 * Opens a previously looked-up artifact without following a final symlink and
 * revalidates its closed-manifest size and digest on that exact descriptor.
 * The caller owns the returned handle and must close it.
 *
 * `lookup()` intentionally remains metadata-only for context packing and
 * projection. HTTP delivery must call this immediately before writing response
 * headers, then stream from this same handle rather than reopening by path.
 */
export async function openVerifiedRunArtifactFile(
  artifact: Pick<
    RunArtifactLookup,
    'absolutePath' | 'size' | 'contentDigest'
  >,
): Promise<FileHandle> {
  return openStableArtifactFile(undefined, artifact.absolutePath, artifact)
}

export interface PluginArtifactClaim {
  pluginId: string
  extensions?: string[]
  mediaTypes?: string[]
  priority?: number
}

export interface PluginArtifactMatch {
  pluginId: string
  priority: number
  specificity: number
}

/** Deterministic, data-only plugin claim selection for manifest entries. */
export class PluginArtifactClaimRegistry {
  readonly #claims: PluginArtifactClaim[]

  constructor(claims: readonly PluginArtifactClaim[]) {
    if (!Array.isArray(claims) || claims.length > 500) {
      throw new TypeError('plugin artifact claims exceed the supported bound')
    }
    const pluginIds = new Set<string>()
    this.#claims = claims.map((claim, index) => {
      const validated = validateClaim(claim, index)
      if (pluginIds.has(validated.pluginId)) {
        throw new TypeError(`claims[${index}].pluginId is duplicated`)
      }
      pluginIds.add(validated.pluginId)
      return validated
    })
  }

  matches(entry: ArtifactManifestEntry): PluginArtifactMatch[] {
    const extension = path.posix.extname(entry.relativePath).toLowerCase()
    return this.#claims.flatMap((claim) => {
      const extensionMatch = claim.extensions?.includes(extension) ?? false
      const mediaTypeMatch = claim.mediaTypes?.some((matcher) =>
        matcher.endsWith('/*')
          ? entry.mediaType.startsWith(matcher.slice(0, -1))
          : matcher === entry.mediaType) ?? false
      if (!extensionMatch && !mediaTypeMatch) return []
      return [{
        pluginId: claim.pluginId,
        priority: claim.priority ?? 0,
        specificity: extensionMatch && mediaTypeMatch ? 2 : 1,
      }]
    }).sort((left, right) =>
      right.priority - left.priority
      || right.specificity - left.specificity
      || left.pluginId.localeCompare(right.pluginId))
  }

  select(entry: ArtifactManifestEntry): PluginArtifactMatch | undefined {
    return this.matches(entry)[0]
  }
}

/**
 * Run-owned artifact storage scoped to one project and one logical branch.
 *
 * Physical output paths are always:
 * `artifacts/.branches/<branch-hash>/<runId>/files/<relative-path>`.
 */
export class RunArtifactStore {
  readonly projectDir: string
  readonly canvasBranch: string
  readonly branchStorageId: string

  #operationTail: Promise<void> = Promise.resolve()

  constructor(projectDir: string, canvasBranch: string) {
    if (typeof projectDir !== 'string' || projectDir.trim().length === 0) {
      throw new TypeError('projectDir must be a non-empty string')
    }
    this.projectDir = path.resolve(projectDir)
    this.canvasBranch = parseCanvasBranch(canvasBranch)
    this.branchStorageId = canvasBranchStorageId(this.canvasBranch)
  }

  location(runId: string): RunArtifactLocation {
    const parsedRunId = parseRunId(runId)
    const projectRelativeRunRoot = path.posix.join(
      'artifacts',
      '.branches',
      this.branchStorageId,
      parsedRunId,
    )
    const projectRelativeFilesRoot = path.posix.join(projectRelativeRunRoot, 'files')
    const absoluteRunRoot = resolveProjectRelative(this.projectDir, projectRelativeRunRoot)
    const absoluteFilesRoot = path.join(absoluteRunRoot, 'files')
    return {
      canvasBranch: this.canvasBranch,
      branchStorageId: this.branchStorageId,
      runId: parsedRunId,
      projectRelativeRunRoot,
      projectRelativeFilesRoot,
      absoluteRunRoot,
      absoluteFilesRoot,
      absoluteManifestPath: path.join(
        absoluteRunRoot,
        ...RUN_ARTIFACT_MANIFEST_RELATIVE_PATH.split('/'),
      ),
    }
  }

  async prepareRun(runId: string): Promise<RunArtifactLocation> {
    return this.#runExclusive(async () => this.#prepareRun(runId))
  }

  async closeRun(
    runId: string,
    options: CloseRunArtifactsOptions = {},
  ): Promise<ClosedRunArtifacts> {
    return this.#runExclusive(async () => {
      const location = await this.#prepareRun(runId)
      const scan = await enumerateRunFiles(location)
      const manifest = buildArtifactManifest({
        runId: location.runId,
        complete: (options.complete ?? true) && scan.complete,
        files: scan.files,
      })
      const manifestDigest = artifactManifestDigest(manifest)
      const existing = await readManifestFile(location.absoluteManifestPath)
      if (existing) {
        const existingDigest = artifactManifestDigest(existing)
        if (existingDigest !== manifestDigest) {
          throw new Error(`Run artifact manifest is already closed for ${location.runId}`)
        }
        return {
          location,
          manifest: existing,
          manifestDigest: existingDigest,
          excluded: scan.excluded,
        }
      }
      await atomicWriteText(
        location.absoluteManifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
      return { location, manifest, manifestDigest, excluded: scan.excluded }
    })
  }

  async manifest(runId: string): Promise<ArtifactManifest | undefined> {
    return this.#runExclusive(async () => {
      const location = this.location(runId)
      try {
        await assertPreparedLocation(this.projectDir, location, false)
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return undefined
        throw error
      }
      const manifest = await readManifestFile(location.absoluteManifestPath)
      if (manifest && manifest.runId !== location.runId) {
        throw new Error('Artifact manifest belongs to a foreign run')
      }
      return manifest
    })
  }

  async lookup(runId: string, artifactId: string): Promise<RunArtifactLookup | undefined> {
    return this.#runExclusive(async () => {
      const location = this.location(runId)
      if (!/^artifact_[0-9a-f]{64}$/u.test(artifactId)) {
        throw new TypeError('artifactId is invalid')
      }
      try {
        await assertPreparedLocation(this.projectDir, location, false)
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return undefined
        throw error
      }
      const manifest = await readManifestFile(location.absoluteManifestPath)
      if (!manifest) return undefined
      if (manifest.runId !== location.runId) {
        throw new Error('Artifact manifest belongs to a foreign run')
      }
      const entry = manifest.entries.find((candidate) => candidate.artifactId === artifactId)
      if (!entry) return undefined
      const absolutePath = resolveFilesRelative(location.absoluteFilesRoot, entry.relativePath)
      await verifyManifestEntry(location.absoluteFilesRoot, absolutePath, entry)
      return {
        canvasBranch: this.canvasBranch,
        branchStorageId: this.branchStorageId,
        runId: location.runId,
        ...entry,
        projectRelativePath: path.posix.join(
          location.projectRelativeFilesRoot,
          entry.relativePath,
        ),
        absolutePath,
        manifestDigest: artifactManifestDigest(manifest),
      }
    })
  }

  async #prepareRun(runId: string): Promise<RunArtifactLocation> {
    const location = this.location(runId)
    await assertPreparedLocation(this.projectDir, location, true)
    return location
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

interface ArtifactScan {
  files: ArtifactManifestFileCandidate[]
  excluded: ExcludedRunArtifact[]
  complete: boolean
}

async function enumerateRunFiles(location: RunArtifactLocation): Promise<ArtifactScan> {
  const files: ArtifactManifestFileCandidate[] = []
  const excluded: ExcludedRunArtifact[] = []
  let complete = true
  let visitedDirectories = 0

  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_RUN_ARTIFACT_DEPTH) {
      complete = false
      excluded.push({ relativePath: prefix, reason: 'limit' })
      return
    }
    visitedDirectories += 1
    if (visitedDirectories > MAX_RUN_ARTIFACT_DIRECTORIES) {
      complete = false
      excluded.push({ relativePath: prefix || '.', reason: 'limit' })
      return
    }
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = normalizeArtifactRelativePath(
        prefix ? `${prefix}/${entry.name}` : entry.name,
      )
      if (isArtifactControlRelativePath(relativePath)) {
        excluded.push({ relativePath, reason: 'control' })
        continue
      }
      if (isTemporaryArtifactRelativePath(relativePath)) {
        excluded.push({ relativePath, reason: 'temporary' })
        continue
      }
      const absolutePath = resolveFilesRelative(location.absoluteFilesRoot, relativePath)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink() || entry.isSymbolicLink()) {
        complete = false
        excluded.push({ relativePath, reason: 'symlink' })
        continue
      }
      if (info.isDirectory() && entry.isDirectory()) {
        const canonical = await realpath(absolutePath)
        if (canonical !== absolutePath) {
          complete = false
          excluded.push({ relativePath, reason: 'foreign' })
          continue
        }
        await visit(absolutePath, relativePath, depth + 1)
        continue
      }
      if (!info.isFile() || !entry.isFile()) {
        complete = false
        excluded.push({ relativePath, reason: 'unsupported' })
        continue
      }
      if (info.nlink !== 1) {
        complete = false
        excluded.push({ relativePath, reason: 'foreign' })
        continue
      }
      if (files.length >= MAX_ARTIFACT_MANIFEST_ENTRIES) {
        complete = false
        excluded.push({ relativePath, reason: 'limit' })
        continue
      }
      const contentDigest = await digestStableFile(
        location.absoluteFilesRoot,
        absolutePath,
        info,
      )
      files.push({
        ownerRunId: location.runId,
        relativePath,
        kind: 'file',
        temporary: false,
        mediaType: inferMediaType(relativePath),
        size: info.size,
        contentDigest,
      })
    }
  }

  await visit(location.absoluteFilesRoot, '', 0)
  return { files, excluded, complete }
}

async function assertPreparedLocation(
  projectDir: string,
  location: RunArtifactLocation,
  create: boolean,
): Promise<void> {
  const projectInfo = await lstat(projectDir)
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) {
    throw new Error('projectDir must be a real directory')
  }
  const canonicalProject = await realpath(projectDir)
  if (canonicalProject !== projectDir) throw new Error('projectDir must be canonical')

  let parent = projectDir
  for (const child of [
    'artifacts',
    '.branches',
    location.branchStorageId,
    location.runId,
    'files',
  ]) {
    const candidate = path.join(parent, child)
    await assertRealChildDirectory(parent, candidate, create)
    parent = candidate
  }
  if (parent !== location.absoluteFilesRoot) throw new Error('artifact files root is inconsistent')
  await assertRealChildDirectory(
    location.absoluteRunRoot,
    path.join(location.absoluteRunRoot, '.ggai'),
    create,
  )
}

async function assertRealChildDirectory(
  parent: string,
  candidate: string,
  create: boolean,
): Promise<void> {
  if (path.dirname(candidate) !== parent) throw new Error('artifact directory escaped its parent')
  if (create) {
    try {
      await mkdir(candidate, { mode: 0o700 })
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
    }
  }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(candidate)
  } catch (error) {
    if (!create && isNodeError(error, 'ENOENT')) throw error
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Artifact directory is not a real directory: ${candidate}`)
  }
  const [canonicalParent, canonicalCandidate] = await Promise.all([
    realpath(parent),
    realpath(candidate),
  ])
  if (canonicalCandidate !== path.join(canonicalParent, path.basename(candidate))) {
    throw new Error(`Artifact directory resolves outside its parent: ${candidate}`)
  }
}

async function readManifestFile(filePath: string): Promise<ArtifactManifest | undefined> {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_RUN_ARTIFACT_MANIFEST_BYTES) {
      throw new Error('Artifact manifest file is invalid')
    }
    const buffer = Buffer.alloc(info.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== info.size) throw new Error('Artifact manifest changed while reading')
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
    )
    const inspection = inspectArtifactManifest(parsed)
    if (inspection.status !== 'valid') {
      throw new Error(`Artifact manifest is invalid: ${inspection.reason}`)
    }
    return inspection.manifest
  } finally {
    await handle.close()
  }
}

async function verifyManifestEntry(
  filesRoot: string,
  absolutePath: string,
  entry: ArtifactManifestEntry,
): Promise<void> {
  const handle = await openStableArtifactFile(filesRoot, absolutePath, entry)
  await handle.close()
}

async function digestStableFile(
  filesRoot: string,
  absolutePath: string,
  before: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  if (!isPathWithin(filesRoot, absolutePath)) throw new Error('Artifact escaped files root')
  const canonical = await realpath(absolutePath)
  if (canonical !== absolutePath || !isPathWithin(filesRoot, canonical)) {
    throw new Error('Artifact resolves outside files root')
  }
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size) {
      throw new Error('Artifact changed before hashing')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < opened.size) {
      const length = Math.min(buffer.length, opened.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead <= 0) throw new Error('Artifact was truncated while hashing')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    if (after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Artifact changed while hashing')
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function openStableArtifactFile(
  filesRoot: string | undefined,
  absolutePath: string,
  entry: Pick<ArtifactManifestEntry, 'size' | 'contentDigest'>,
): Promise<FileHandle> {
  if (filesRoot && !isPathWithin(filesRoot, absolutePath)) {
    throw new Error('Artifact escaped files root')
  }
  const before = await lstat(absolutePath)
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size !== entry.size) {
    throw new Error('Artifact no longer matches its closed manifest')
  }
  const canonical = await realpath(absolutePath)
  if (canonical !== absolutePath || (filesRoot && !isPathWithin(filesRoot, canonical))) {
    throw new Error('Artifact resolves outside files root')
  }
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size !== entry.size) {
      throw new Error('Artifact changed before hashing')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < opened.size) {
      const length = Math.min(buffer.length, opened.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead <= 0) throw new Error('Artifact was truncated while hashing')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    if (after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('Artifact changed while hashing')
    }
    if (hash.digest('hex') !== entry.contentDigest) {
      throw new Error('Artifact content digest no longer matches its closed manifest')
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function resolveProjectRelative(projectDir: string, relativePath: string): string {
  const absolute = path.resolve(projectDir, ...relativePath.split('/'))
  if (!isPathWithin(projectDir, absolute)) throw new TypeError('Artifact path escaped projectDir')
  return absolute
}

function resolveFilesRelative(filesRoot: string, relativePath: string): string {
  const normalized = normalizeArtifactRelativePath(relativePath)
  const absolute = path.resolve(filesRoot, ...normalized.split('/'))
  if (!isPathWithin(filesRoot, absolute)) throw new TypeError('Artifact path escaped files root')
  return absolute
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function inferMediaType(relativePath: string): string {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.svg': return 'image/svg+xml'
    case '.pdf': return 'application/pdf'
    case '.json': return 'application/json'
    case '.csv': return 'text/csv'
    case '.md': return 'text/markdown'
    case '.txt':
    case '.log': return 'text/plain'
    case '.js': return 'text/javascript'
    case '.ts': return 'text/typescript'
    case '.html': return 'text/html'
    case '.css': return 'text/css'
    case '.r': return 'text/x-r'
    case '.py': return 'text/x-python'
    default: return 'application/octet-stream'
  }
}

function validateClaim(claim: PluginArtifactClaim, index: number): PluginArtifactClaim {
  if (!isRecordWithOnly(claim, ['pluginId', 'extensions', 'mediaTypes', 'priority'])) {
    throw new TypeError(`claims[${index}] has unsupported fields`)
  }
  if (!isPluginId(claim.pluginId)) throw new TypeError(`claims[${index}].pluginId is invalid`)
  const extensions = claim.extensions ?? []
  const mediaTypes = claim.mediaTypes ?? []
  if (!Array.isArray(extensions)
    || !Array.isArray(mediaTypes)
    || extensions.length + mediaTypes.length === 0
    || extensions.length > 64
    || mediaTypes.length > 64
    || !extensions.every((extension) => /^\.[a-z0-9][a-z0-9.+_-]{0,31}$/u.test(extension))
    || !mediaTypes.every((mediaType) =>
      /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/u.test(mediaType))
    || new Set(extensions).size !== extensions.length
    || new Set(mediaTypes).size !== mediaTypes.length) {
    throw new TypeError(`claims[${index}] matchers are invalid`)
  }
  const priority = claim.priority ?? 0
  if (!Number.isSafeInteger(priority) || priority < -1_000 || priority > 1_000) {
    throw new TypeError(`claims[${index}].priority is invalid`)
  }
  return {
    pluginId: claim.pluginId,
    ...(extensions.length > 0 ? { extensions: [...extensions] } : {}),
    ...(mediaTypes.length > 0 ? { mediaTypes: [...mediaTypes] } : {}),
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

function isRecordWithOnly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key))
}
