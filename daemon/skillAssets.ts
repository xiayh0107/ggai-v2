import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import {
  SKILL_ASSET_SCHEMA_VERSION,
  canonicalSkillAssetRef,
  canonicalSkillAssetRefs,
  isNodeTypeId,
  isSkillId,
  type NodeTypeSkillBindings,
  type SkillAssetRef,
  type SkillAssetSummary,
} from '../src/skills/contracts.js'
import { atomicWriteText, isNodeError, readExactFileBytes } from './atomic-file.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'

const CATALOG_SCHEMA_VERSION = 1 as const
const MAX_SKILL_ASSETS = 1_000
const MAX_TYPE_BINDINGS = 1_000
const MAX_CATALOG_BYTES = 32 * 1024 * 1024
const MAX_SKILL_FILES = 256
const MAX_SKILL_FILE_BYTES = 1024 * 1024
const MAX_SKILL_TOTAL_BYTES = 4 * 1024 * 1024
export const MAX_RUN_SKILL_ASSETS = 32
export const MAX_RUN_SKILL_BYTES = 8 * 1024 * 1024

interface StoredSkillFile {
  relativePath: string
  size: number
  digest: string
}

interface StoredSkillAsset extends Omit<SkillAssetSummary, 'archived'> {
  files: StoredSkillFile[]
}

interface SkillAssetDocument {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION
  assets: StoredSkillAsset[]
  archivedSkillIds: string[]
  typeBindings: NodeTypeSkillBindings[]
}

export interface ImportSkillAssetInput {
  sourcePath: string
  skillId: string
  expectedRevision: number
}

export interface UpdateNodeTypeSkillBindingsInput {
  nodeType: string
  expectedRevision: number
  skills: SkillAssetRef[]
}

export interface ResolvedSkillAssetFile extends StoredSkillFile {
  contentBase64: string
}

export interface ResolvedSkillAsset {
  ref: SkillAssetRef
  title: string
  description: string
  entrypoint: 'SKILL.md'
  files: ResolvedSkillAssetFile[]
}

export interface SkillAssetCatalogSnapshot {
  schemaVersion: typeof SKILL_ASSET_SCHEMA_VERSION
  assets: SkillAssetSummary[]
  typeBindings: NodeTypeSkillBindings[]
}

export class SkillAssetConflictError extends Error {
  readonly currentRevision: number

  constructor(currentRevision: number) {
    super(`skill asset revision conflict; current revision is ${currentRevision}`)
    this.name = 'SkillAssetConflictError'
    this.currentRevision = currentRevision
  }
}

/**
 * Workspace-owned skill assets. Installing a revision transfers ownership of
 * its source directory into `.gg/workspace`; accepted revisions are immutable.
 */
export class SkillAssetCatalog {
  readonly projectRoot: string
  readonly rootDir: string
  readonly assetsDir: string
  readonly filePath: string
  #operationTail: Promise<void> = Promise.resolve()

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot)
    this.rootDir = path.join(this.projectRoot, '.gg', 'workspace', 'skills')
    this.assetsDir = path.join(this.rootDir, 'assets')
    this.filePath = path.join(this.rootDir, 'catalog.json')
  }

  list(): Promise<SkillAssetCatalogSnapshot> {
    return this.#exclusive(async () => this.#publicSnapshot(await this.#read()))
  }

  import(input: ImportSkillAssetInput): Promise<SkillAssetSummary> {
    return this.#exclusive(async () => {
      validateImportInput(input)
      const document = await this.#read()
      const latestRevision = document.assets.reduce(
        (latest, asset) => asset.skillId === input.skillId
          ? Math.max(latest, asset.revision)
          : latest,
        0,
      )
      if (latestRevision !== input.expectedRevision) {
        throw new SkillAssetConflictError(latestRevision)
      }

      const snapshot = await readExternalSkill(input.sourcePath)
      const revision = latestRevision + 1
      const importedAt = new Date().toISOString()
      const stored: StoredSkillAsset = {
        schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
        skillId: input.skillId,
        revision,
        digest: snapshot.digest,
        title: snapshot.title,
        description: snapshot.description,
        entrypoint: 'SKILL.md',
        fileCount: snapshot.files.length,
        totalBytes: snapshot.totalBytes,
        importedAt,
        files: snapshot.files.map(({ relativePath, size, digest }) => ({
          relativePath,
          size,
          digest,
        })),
      }
      if (document.assets.length >= MAX_SKILL_ASSETS) {
        throw new TypeError(`skill asset catalog exceeds ${MAX_SKILL_ASSETS} revisions`)
      }
      await this.#adoptSnapshot(snapshot, async () => {
        await this.#write({
          ...document,
          assets: [...document.assets, stored],
          archivedSkillIds: document.archivedSkillIds.filter((id) => id !== input.skillId),
        })
      })
      return { ...stored, archived: false }
    })
  }

  archive(skillId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      if (!isSkillId(skillId)) throw new TypeError('skillId is invalid')
      const document = await this.#read()
      if (!document.assets.some((asset) => asset.skillId === skillId)) return false
      if (document.archivedSkillIds.includes(skillId)) return true
      await this.#write({
        ...document,
        archivedSkillIds: [...document.archivedSkillIds, skillId].sort((left, right) =>
          left.localeCompare(right)),
      })
      return true
    })
  }

  updateTypeBindings(
    input: UpdateNodeTypeSkillBindingsInput,
  ): Promise<NodeTypeSkillBindings> {
    return this.#exclusive(async () => {
      if (!isNodeTypeId(input.nodeType)) throw new TypeError('nodeType is invalid')
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new TypeError('expectedRevision must be a non-negative safe integer')
      }
      const skills = canonicalSkillAssetRefs(input.skills)
      const document = await this.#read()
      const current = document.typeBindings.find((binding) => binding.nodeType === input.nodeType)
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        throw new SkillAssetConflictError(current?.revision ?? 0)
      }
      requireStoredRefs(document, skills)
      if (!current && document.typeBindings.length >= MAX_TYPE_BINDINGS) {
        throw new TypeError(`skill type binding catalog exceeds ${MAX_TYPE_BINDINGS} entries`)
      }
      const next: NodeTypeSkillBindings = {
        schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
        nodeType: input.nodeType,
        revision: input.expectedRevision + 1,
        skills,
        updatedAt: new Date().toISOString(),
      }
      await this.#write({
        ...document,
        typeBindings: [
          ...document.typeBindings.filter((binding) => binding.nodeType !== input.nodeType),
          next,
        ].sort((left, right) => left.nodeType.localeCompare(right.nodeType)),
      })
      return structuredClone(next)
    })
  }

  typeBindings(nodeTypes: readonly string[]): Promise<Map<string, SkillAssetRef[]>> {
    return this.#exclusive(async () => {
      const requested = new Set(nodeTypes)
      const document = await this.#read()
      return new Map(document.typeBindings
        .filter((binding) => requested.has(binding.nodeType))
        .map((binding) => [binding.nodeType, structuredClone(binding.skills)] as const))
    })
  }

  resolve(refs: readonly SkillAssetRef[]): Promise<ResolvedSkillAsset[]> {
    return this.#exclusive(async () => {
      const canonical = canonicalSkillAssetRefs(refs)
      if (canonical.length > MAX_RUN_SKILL_ASSETS) {
        throw new TypeError(`a Run can use at most ${MAX_RUN_SKILL_ASSETS} skills`)
      }
      const document = await this.#read()
      const records = requireStoredRefs(document, canonical)
      let totalBytes = 0
      const resolved: ResolvedSkillAsset[] = []
      for (const record of records) {
        totalBytes += record.totalBytes
        if (totalBytes > MAX_RUN_SKILL_BYTES) {
          throw new TypeError(`Run skills exceed ${MAX_RUN_SKILL_BYTES} bytes`)
        }
        resolved.push(await this.#readStoredAsset(record))
      }
      return resolved
    })
  }

  async #adoptSnapshot(
    snapshot: ExternalSkillSnapshot,
    commit: () => Promise<void>,
  ): Promise<void> {
    await this.#assertSafeRoot(true)
    await mkdir(this.assetsDir, { recursive: true, mode: 0o700 })
    await assertRealDirectory(this.assetsDir, 'skill asset blob directory')
    if (isPathWithin(this.rootDir, snapshot.sourceDir)) {
      throw new TypeError('skill source is already inside managed skill storage')
    }
    if (isPathWithin(snapshot.sourceDir, this.projectRoot)) {
      throw new TypeError('skill source cannot contain the project root')
    }

    const target = this.#assetDirectory(snapshot.digest)
    let targetExists = false
    try {
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new TypeError('stored skill asset target is not a real directory')
      }
      await this.#verifyPersistedSnapshot(snapshot)
      targetExists = true
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }

    const adoptedDirectory = targetExists
      ? path.join(this.assetsDir, `.adopting-${process.pid}-${randomUUID()}`)
      : target
    try {
      try {
        await rename(snapshot.sourceDir, adoptedDirectory)
      } catch (error) {
        if (isNodeError(error, 'EXDEV')) {
          throw new TypeError(
            'skill source must be on the same filesystem as the workspace asset store',
            { cause: error },
          )
        }
        throw error
      }

      const adoptedSnapshot = await readExternalSkill(adoptedDirectory)
      if (adoptedSnapshot.digest !== snapshot.digest) {
        throw new TypeError('skill source changed while ownership was transferred')
      }
      if (!targetExists) await this.#verifyPersistedSnapshot(adoptedSnapshot)
      await commit()
    } catch (error) {
      try {
        await rename(adoptedDirectory, snapshot.sourceDir)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'skill installation failed and its source directory could not be restored',
        )
      }
      throw error
    }

    // Identical bytes may already be owned by another immutable revision. In
    // that case the moved source has served only as the verified adoption
    // candidate and can be discarded after the catalog commit succeeds.
    if (targetExists) await rm(adoptedDirectory, { recursive: true, force: true })
  }

  async #verifyPersistedSnapshot(snapshot: ExternalSkillSnapshot): Promise<void> {
    const directory = this.#assetDirectory(snapshot.digest)
    await assertRealDirectory(directory, 'stored skill asset')
    const verified: Array<{ relativePath: string; content: Buffer }> = []
    for (const expected of snapshot.files) {
      const filePath = path.join(directory, ...expected.relativePath.split('/'))
      const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== expected.size) {
          throw new TypeError('stored skill asset collision failed its manifest check')
        }
        const content = await readExactFileBytes(handle, info.size, MAX_SKILL_FILE_BYTES)
        if (digestBuffer(content) !== expected.digest) {
          throw new TypeError('stored skill asset collision failed its digest check')
        }
        verified.push({ relativePath: expected.relativePath, content })
      } finally {
        await handle.close()
      }
    }
    if (skillSnapshotDigest(verified) !== snapshot.digest) {
      throw new TypeError('stored skill asset collision failed its snapshot check')
    }
  }

  async #readStoredAsset(record: StoredSkillAsset): Promise<ResolvedSkillAsset> {
    await this.#assertSafeRoot(false)
    const directory = this.#assetDirectory(record.digest)
    await assertRealDirectory(directory, 'stored skill asset')
    const files: ResolvedSkillAssetFile[] = []
    for (const expected of record.files) {
      const filePath = path.join(directory, ...expected.relativePath.split('/'))
      const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== expected.size || info.size > MAX_SKILL_FILE_BYTES) {
          throw new TypeError('stored skill asset file no longer matches its manifest')
        }
        const content = await readExactFileBytes(handle, info.size, MAX_SKILL_FILE_BYTES)
        if (digestBuffer(content) !== expected.digest) {
          throw new TypeError('stored skill asset file failed its digest check')
        }
        files.push({ ...expected, contentBase64: content.toString('base64') })
      } finally {
        await handle.close()
      }
    }
    if (skillSnapshotDigest(files.map((file) => ({
      relativePath: file.relativePath,
      content: Buffer.from(file.contentBase64, 'base64'),
    }))) !== record.digest) {
      throw new TypeError('stored skill asset snapshot digest does not match')
    }
    return {
      ref: {
        skillId: record.skillId,
        revision: record.revision,
        digest: record.digest,
      },
      title: record.title,
      description: record.description,
      entrypoint: 'SKILL.md',
      files,
    }
  }

  async #read(): Promise<SkillAssetDocument> {
    if (!await this.#assertSafeRoot(false)) return emptyDocument()
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_CATALOG_BYTES) {
        throw new TypeError('skill asset catalog is not a safe bounded file')
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(
        await readExactFileBytes(handle, info.size, MAX_CATALOG_BYTES),
      )
      return parseDocument(JSON.parse(raw))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return emptyDocument()
      if (error instanceof SyntaxError) {
        throw new TypeError('skill asset catalog is invalid JSON', { cause: error })
      }
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async #write(document: SkillAssetDocument): Promise<void> {
    const parsed = parseDocument(document)
    const raw = `${JSON.stringify(parsed, null, 2)}\n`
    if (Buffer.byteLength(raw, 'utf8') > MAX_CATALOG_BYTES) {
      throw new TypeError('skill asset catalog exceeds the supported size')
    }
    await this.#assertSafeRoot(true)
    await atomicWriteText(this.filePath, raw)
    await this.#assertSafeRoot(false)
  }

  #publicSnapshot(document: SkillAssetDocument): SkillAssetCatalogSnapshot {
    const archived = new Set(document.archivedSkillIds)
    return {
      schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
      assets: document.assets.map((asset) => ({
        schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
        skillId: asset.skillId,
        revision: asset.revision,
        digest: asset.digest,
        title: asset.title,
        description: asset.description,
        entrypoint: 'SKILL.md',
        fileCount: asset.fileCount,
        totalBytes: asset.totalBytes,
        importedAt: asset.importedAt,
        archived: archived.has(asset.skillId),
      })),
      typeBindings: structuredClone(document.typeBindings),
    }
  }

  #assetDirectory(digest: string): string {
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError('skill digest is invalid')
    return path.join(this.assetsDir, digest)
  }

  async #assertSafeRoot(create: boolean): Promise<boolean> {
    const canonicalProject = await realpath(this.projectRoot)
    const expectedRoot = path.join(canonicalProject, '.gg', 'workspace', 'skills')
    const expectedFile = path.join(expectedRoot, 'catalog.json')
    const expectedAssets = path.join(expectedRoot, 'assets')
    const canonicalRoot = await canonicalizePotentialPath(this.rootDir)
    const canonicalFile = await canonicalizePotentialPath(this.filePath)
    const canonicalAssets = await canonicalizePotentialPath(this.assetsDir)
    if (canonicalRoot !== expectedRoot
      || canonicalFile !== expectedFile
      || canonicalAssets !== expectedAssets
      || !isPathWithin(canonicalProject, canonicalRoot)
      || !isPathWithin(canonicalRoot, canonicalFile)
      || !isPathWithin(canonicalRoot, canonicalAssets)) {
      throw new TypeError('skill asset catalog path resolves through a symlink')
    }
    if (create) await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    try {
      await assertRealDirectory(this.rootDir, 'skill asset catalog root')
      return true
    } catch (error) {
      if (!create && isNodeError(error, 'ENOENT')) return false
      throw error
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

interface ExternalSkillFile {
  relativePath: string
  size: number
  digest: string
  content: Buffer
}

interface ExternalSkillSnapshot {
  sourceDir: string
  digest: string
  title: string
  description: string
  totalBytes: number
  files: ExternalSkillFile[]
}

async function readExternalSkill(sourcePath: string): Promise<ExternalSkillSnapshot> {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.length > 4_096) {
    throw new TypeError('sourcePath must be a bounded absolute path')
  }
  const selected = await lstat(sourcePath)
  if (selected.isSymbolicLink()) {
    throw new TypeError('skill source cannot be a symbolic link')
  }
  const canonical = await realpath(sourcePath)
  const info = await lstat(canonical)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError('skill source must be a real directory containing SKILL.md')
  }
  const sourceDir = canonical
  await assertRealDirectory(sourceDir, 'skill source')
  const files: ExternalSkillFile[] = []
  await collectExternalSkillFiles(sourceDir, sourceDir, files)
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const entry = files.find((file) => file.relativePath === 'SKILL.md')
  if (!entry) throw new TypeError('skill source must contain SKILL.md at its root')
  const skillMarkdown = new TextDecoder('utf-8', { fatal: true }).decode(entry.content)
  const metadata = skillMetadata(skillMarkdown)
  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  return {
    sourceDir,
    digest: skillSnapshotDigest(files),
    title: metadata.title,
    description: metadata.description,
    totalBytes,
    files,
  }
}

async function collectExternalSkillFiles(
  root: string,
  directory: string,
  files: ExternalSkillFile[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.' || entry.name === '..' || entry.name.includes('\0')) {
      throw new TypeError('skill source contains an invalid path component')
    }
    const absolute = path.join(directory, entry.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new TypeError('skill source cannot contain symbolic links')
    if (info.isDirectory()) {
      await collectExternalSkillFiles(root, absolute, files)
      continue
    }
    if (!info.isFile()) throw new TypeError('skill source can contain only regular files')
    if (files.length >= MAX_SKILL_FILES) {
      throw new TypeError(`skill source exceeds ${MAX_SKILL_FILES} files`)
    }
    if (info.size > MAX_SKILL_FILE_BYTES) {
      throw new TypeError(`skill source file exceeds ${MAX_SKILL_FILE_BYTES} bytes`)
    }
    const relativePath = path.relative(root, absolute).split(path.sep).join('/')
    if (!isSafeRelativeFilePath(relativePath)) throw new TypeError('skill source path is invalid')
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== info.size) {
        throw new TypeError('skill source changed while it was imported')
      }
      const content = await readExactFileBytes(handle, opened.size, MAX_SKILL_FILE_BYTES)
      files.push({
        relativePath,
        size: content.byteLength,
        digest: digestBuffer(content),
        content,
      })
    } finally {
      await handle.close()
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_SKILL_TOTAL_BYTES) {
      throw new TypeError(`skill source exceeds ${MAX_SKILL_TOTAL_BYTES} bytes`)
    }
  }
}

function skillMetadata(source: string): { title: string; description: string } {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? ''
  const name = frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim().replace(/^['"]|['"]$/gu, '')
  const description = frontmatter.match(/^description:\s*(.+)$/mu)?.[1]
    ?.trim().replace(/^['"]|['"]$/gu, '')
  const heading = source.match(/^#\s+(.+)$/mu)?.[1]?.trim()
  const firstParagraph = source
    .replace(/^---[\s\S]*?---(?:\r?\n|$)/u, '')
    .split(/\r?\n\s*\r?\n/u)
    .map((part) => part.replace(/^#+\s+.*$/gmu, '').trim())
    .find(Boolean)
  return {
    title: boundedText(name || heading || 'Imported skill', 160),
    description: boundedText(description || firstParagraph || 'User-managed Node capability', 1_000),
  }
}

function skillSnapshotDigest(
  files: readonly { relativePath: string; content: Buffer }[],
): string {
  const hash = createHash('sha256').update('ggai.skill-asset.v1\0', 'utf8')
  for (const file of files) {
    hash.update(`${Buffer.byteLength(file.relativePath, 'utf8')}:`, 'utf8')
    hash.update(file.relativePath, 'utf8')
    hash.update(`:${file.content.byteLength}:`, 'utf8')
    hash.update(file.content)
  }
  return hash.digest('hex')
}

function digestBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function requireStoredRefs(
  document: SkillAssetDocument,
  refs: readonly SkillAssetRef[],
): StoredSkillAsset[] {
  return refs.map((raw) => {
    const ref = canonicalSkillAssetRef(raw)
    const record = document.assets.find((asset) =>
      asset.skillId === ref.skillId && asset.revision === ref.revision)
    if (!record || record.digest !== ref.digest) {
      throw new TypeError(`skill asset is unavailable or changed: ${ref.skillId}@${ref.revision}`)
    }
    return record
  })
}

function parseDocument(value: unknown): SkillAssetDocument {
  if (!isExactRecord(value, ['schemaVersion', 'assets', 'archivedSkillIds', 'typeBindings'])
    || value.schemaVersion !== CATALOG_SCHEMA_VERSION
    || !Array.isArray(value.assets)
    || value.assets.length > MAX_SKILL_ASSETS
    || !Array.isArray(value.archivedSkillIds)
    || !Array.isArray(value.typeBindings)
    || value.typeBindings.length > MAX_TYPE_BINDINGS) {
    throw new TypeError('skill asset catalog has an invalid envelope')
  }
  const assets = value.assets.map(parseStoredAsset)
  const keys = assets.map((asset) => `${asset.skillId}\0${asset.revision}`)
  if (new Set(keys).size !== keys.length) throw new TypeError('skill asset revisions are duplicated')
  const archivedSkillIds = value.archivedSkillIds.map((id) => {
    if (!isSkillId(id)) throw new TypeError('archived skill id is invalid')
    return id
  })
  if (new Set(archivedSkillIds).size !== archivedSkillIds.length) {
    throw new TypeError('archived skill ids are duplicated')
  }
  const typeBindings = value.typeBindings.map(parseTypeBinding)
  if (new Set(typeBindings.map((binding) => binding.nodeType)).size !== typeBindings.length) {
    throw new TypeError('node type skill bindings are duplicated')
  }
  const lookupDocument: SkillAssetDocument = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    assets,
    archivedSkillIds,
    typeBindings: [],
  }
  for (const binding of typeBindings) requireStoredRefs(lookupDocument, binding.skills)
  return { schemaVersion: CATALOG_SCHEMA_VERSION, assets, archivedSkillIds, typeBindings }
}

function parseStoredAsset(value: unknown): StoredSkillAsset {
  if (!isExactRecord(value, [
    'schemaVersion', 'skillId', 'revision', 'digest', 'title', 'description',
    'entrypoint', 'fileCount', 'totalBytes', 'importedAt', 'files',
  ]) || value.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION
    || value.entrypoint !== 'SKILL.md'
    || typeof value.title !== 'string' || value.title.length === 0 || value.title.length > 160
    || typeof value.description !== 'string' || value.description.length > 1_000
    || !Number.isSafeInteger(value.fileCount) || (value.fileCount as number) < 1
    || !Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 1
    || typeof value.importedAt !== 'string' || !Number.isFinite(Date.parse(value.importedAt))
    || !Array.isArray(value.files) || value.files.length !== value.fileCount) {
    throw new TypeError('stored skill asset is invalid')
  }
  const ref = canonicalSkillAssetRef({
    skillId: value.skillId,
    revision: value.revision,
    digest: value.digest,
  })
  const files = value.files.map(parseStoredFile)
  if (new Set(files.map((file) => file.relativePath)).size !== files.length
    || files.reduce((total, file) => total + file.size, 0) !== value.totalBytes
    || !files.some((file) => file.relativePath === 'SKILL.md')) {
    throw new TypeError('stored skill asset file manifest is invalid')
  }
  return {
    schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
    ...ref,
    title: value.title,
    description: value.description,
    entrypoint: 'SKILL.md',
    fileCount: value.fileCount as number,
    totalBytes: value.totalBytes as number,
    importedAt: new Date(value.importedAt).toISOString(),
    files,
  }
}

function parseStoredFile(value: unknown): StoredSkillFile {
  if (!isExactRecord(value, ['relativePath', 'size', 'digest'])
    || typeof value.relativePath !== 'string'
    || !isSafeRelativeFilePath(value.relativePath)
    || !Number.isSafeInteger(value.size) || (value.size as number) < 0
    || (value.size as number) > MAX_SKILL_FILE_BYTES
    || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    throw new TypeError('stored skill asset file is invalid')
  }
  return { relativePath: value.relativePath, size: value.size as number, digest: value.digest }
}

function parseTypeBinding(value: unknown): NodeTypeSkillBindings {
  if (!isExactRecord(value, [
    'schemaVersion', 'nodeType', 'revision', 'skills', 'updatedAt',
  ]) || value.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION
    || !isNodeTypeId(value.nodeType)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new TypeError('node type skill binding is invalid')
  }
  return {
    schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
    nodeType: value.nodeType,
    revision: value.revision as number,
    skills: canonicalSkillAssetRefs(value.skills),
    updatedAt: new Date(value.updatedAt).toISOString(),
  }
}

function validateImportInput(value: ImportSkillAssetInput): void {
  if (!value || typeof value !== 'object'
    || !isSkillId(value.skillId)
    || typeof value.sourcePath !== 'string'
    || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision < 0) {
    throw new TypeError('skill import request is invalid')
  }
}

function emptyDocument(): SkillAssetDocument {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    assets: [],
    archivedSkillIds: [],
    typeBindings: [],
  }
}

function isSafeRelativeFilePath(value: string): boolean {
  return value.length > 0
    && value.length <= 1_024
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

async function assertRealDirectory(value: string, label: string): Promise<void> {
  const info = await lstat(value)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError(`${label} must be a real directory`)
  }
}

function boundedText(value: string, max: number): string {
  const normalized = value.trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
