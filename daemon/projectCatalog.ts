import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import {
  blankProjectCanvasInitializationMarker,
  assertCanvasReady,
  ensureCanvasReady,
} from './canvasInitialization.js'
import {
  parseCanvasEnvelopeSnapshot,
  type CanvasEnvelope,
} from './canvasCommandStore.js'
import { canvasBranchStorageId } from './canvasBranch.js'
import { atomicWriteText, isNodeError } from './atomic-file.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'

export const PROJECT_CATALOG_SCHEMA_VERSION = 1
export const MAX_PROJECT_TITLE_LENGTH = 120

const PROJECT_ID_PATTERN = /^project_[0-9a-f]{32}$/u
const PROJECT_DELETE_TOMBSTONE_PATTERN = /^\.deleting-(project_[0-9a-f]{32})$/u
const MAX_PROJECT_RECORDS = 10_000
const MAX_PROJECT_CATALOG_BYTES = 4 * 1024 * 1024
const MAX_CANVAS_SNAPSHOT_BYTES = 64 * 1024 * 1024
const EMPTY_SUMMARY: WorkspaceProjectSummary = {
  taskCount: 0,
  nodeCount: 0,
  collectionCount: 0,
}

export interface WorkspaceProjectSummary {
  taskCount: number
  nodeCount: number
  collectionCount: number
}

export interface ProjectCatalogRecord {
  id: string
  title: string
  projectDir: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
}

export interface WorkspaceProjectDescriptor extends ProjectCatalogRecord {
  state: 'ready' | 'unavailable'
  summary: WorkspaceProjectSummary | null
}

interface ProjectCatalogDocument {
  schemaVersion: 1
  projects: ProjectCatalogRecord[]
}

export type ProjectCatalogErrorCode =
  | 'invalid_project_title'
  | 'invalid_project_id'
  | 'project_not_found'
  | 'project_title_conflict'
  | 'project_unavailable'
  | 'project_catalog_corrupt'
  | 'unsafe_workspace_catalog'
  | 'daemon_shutting_down'

export class ProjectCatalogError extends Error {
  readonly code: ProjectCatalogErrorCode
  readonly status: number

  constructor(code: ProjectCatalogErrorCode, message: string, status = 409, cause?: unknown) {
    super(message, { cause })
    this.name = 'ProjectCatalogError'
    this.code = code
    this.status = status
  }
}

export interface ProjectCatalogOptions {
  now?: () => number
  idFactory?: () => string
}

/**
 * Daemon-owned registry for explicit workspace projects.
 *
 * It never discovers directories. Registry mutations are serialized in-process,
 * fsynced, and atomically replaced. The server additionally fences mutations
 * with the workspace control lease so separate daemon processes cannot overwrite it.
 */
export class ProjectCatalog {
  readonly projectRoot: string
  readonly workspaceDir: string
  readonly projectsDir: string
  readonly filePath: string

  readonly #now: () => number
  readonly #idFactory: () => string
  #operationTail: Promise<void> = Promise.resolve()
  #closing = false

  constructor(projectRoot: string, options: ProjectCatalogOptions = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
      throw new TypeError('projectRoot must be a non-empty string')
    }
    this.projectRoot = path.resolve(projectRoot)
    this.workspaceDir = path.join(this.projectRoot, '.gg', 'workspace')
    this.projectsDir = path.join(this.workspaceDir, 'projects')
    this.filePath = path.join(this.workspaceDir, 'projects.json')
    this.#now = options.now ?? Date.now
    this.#idFactory = options.idFactory
      ?? (() => `project_${randomBytes(16).toString('hex')}`)
  }

  list(): Promise<WorkspaceProjectDescriptor[]> {
    return this.#runExclusive(async () => {
      const document = await this.#readDocument()
      const projects = await Promise.all(document.projects.map((record) => this.#describe(record)))
      return projects.sort(compareProjectDescriptors)
    })
  }

  create(titleInput: unknown): Promise<WorkspaceProjectDescriptor> {
    return this.#runExclusive(async () => {
      const title = parseProjectTitle(titleInput)
      const document = await this.#readDocument()
      if (document.projects.some((record) => sameTitle(record.title, title))) {
        throw new ProjectCatalogError(
          'project_title_conflict',
          `A workspace project named "${title}" already exists`,
          409,
        )
      }

      const id = await this.#newProjectId(document)
      const projectDir = managedProjectDir(id)
      const finalPath = path.join(this.projectRoot, ...projectDir.split('/'))
      const stagingPath = path.join(this.workspaceDir, `.staging-${id}-${randomUUID()}`)
      const timestamp = this.#timestamp()
      const record: ProjectCatalogRecord = {
        id,
        title,
        projectDir,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: null,
      }
      let moved = false
      let persisted = false

      try {
        await this.#prepareWorkspace(true)
        await mkdir(stagingPath, { mode: 0o700 })
        await assertRealDirectory(stagingPath, this.workspaceDir)
        const markerPath = path.join(stagingPath, '.gg', 'canvas-model.json')
        await atomicWriteText(
          markerPath,
          `${JSON.stringify(blankProjectCanvasInitializationMarker(id, timestamp), null, 2)}\n`,
        )
        await assertCanvasReady(stagingPath)
        await rename(stagingPath, finalPath)
        moved = true
        await this.#requireReadyProjectDirectory(record)

        const next: ProjectCatalogDocument = {
          schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
          projects: [...document.projects, record],
        }
        await this.#writeDocument(next)
        persisted = true
        return await this.#describe(record)
      } catch (error) {
        if (!persisted && moved) {
          await rm(finalPath, { recursive: true, force: true }).catch(() => undefined)
        }
        if (!moved) await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    })
  }

  delete(idInput: unknown): Promise<ProjectCatalogRecord> {
    return this.#runExclusive(async () => {
      const id = parseProjectId(idInput)
      const document = await this.#readDocument()
      const record = requiredRecord(document, id)
      const projectPath = path.join(this.projectRoot, ...record.projectDir.split('/'))
      const tombstonePath = this.#deleteTombstonePath(id)

      try {
        await this.#requireReadyProjectDirectory(record)
        await assertPathMissing(tombstonePath)
      } catch (error) {
        throw new ProjectCatalogError(
          'project_unavailable',
          `Workspace project ${id} cannot be deleted safely`,
          409,
          error,
        )
      }

      try {
        await rename(projectPath, tombstonePath)
      } catch (error) {
        throw new ProjectCatalogError(
          'project_unavailable',
          `Workspace project ${id} cannot be moved into deletion quarantine`,
          409,
          error,
        )
      }
      let catalogPersisted = false
      try {
        await this.#requireReadyManagedProjectDirectory(id, tombstonePath)
        const next: ProjectCatalogDocument = {
          schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
          projects: document.projects.filter((candidate) => candidate.id !== id),
        }
        await this.#writeDocument(next)
        catalogPersisted = true
      } catch (error) {
        try {
          await rename(tombstonePath, projectPath)
          await this.#requireReadyProjectDirectory(record)
        } catch (rollbackError) {
          throw new ProjectCatalogError(
            'project_unavailable',
            `Workspace project ${id} deletion failed and could not be rolled back immediately`,
            409,
            new AggregateError([error, rollbackError]),
          )
        }
        throw error
      }

      if (catalogPersisted) {
        // Once the catalog no longer contains the record, cleanup is
        // restart-safe: #readDocument will retry a leftover tombstone.
        await rm(tombstonePath, { recursive: true, force: false }).catch(() => undefined)
      }
      return structuredClone(record)
    })
  }

  requireReady(idInput: unknown): Promise<ProjectCatalogRecord> {
    return this.#runExclusive(async () => {
      const id = parseProjectId(idInput)
      const document = await this.#readDocument()
      const record = requiredRecord(document, id)
      try {
        await this.#requireReadyProjectDirectory(record)
      } catch (error) {
        throw new ProjectCatalogError(
          'project_unavailable',
          `Workspace project ${id} is unavailable`,
          409,
          error,
        )
      }
      return structuredClone(record)
    })
  }

  markOpened(idInput: unknown): Promise<ProjectCatalogRecord> {
    return this.#runExclusive(async () => {
      const id = parseProjectId(idInput)
      const document = await this.#readDocument()
      const existing = requiredRecord(document, id)
      const opened: ProjectCatalogRecord = {
        ...existing,
        lastOpenedAt: this.#timestamp(),
      }
      const next: ProjectCatalogDocument = {
        schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
        projects: document.projects.map((record) => record.id === id ? opened : record),
      }
      await this.#writeDocument(next)
      return structuredClone(opened)
    })
  }

  async close(): Promise<void> {
    this.#closing = true
    await this.#operationTail
  }

  async #describe(record: ProjectCatalogRecord): Promise<WorkspaceProjectDescriptor> {
    try {
      const projectDir = await this.#requireReadyProjectDirectory(record)
      const snapshot = await readMainCanvasSummary(projectDir)
      return {
        ...structuredClone(record),
        updatedAt: latestTimestamp(record.updatedAt, snapshot.updatedAt),
        state: 'ready',
        summary: snapshot.summary,
      }
    } catch {
      return {
        ...structuredClone(record),
        state: 'unavailable',
        summary: null,
      }
    }
  }

  async #readDocument(): Promise<ProjectCatalogDocument> {
    await this.#prepareWorkspace(true)
    let source: string
    try {
      const info = await lstat(this.filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROJECT_CATALOG_BYTES) {
        throw new TypeError('workspace project catalog must be a bounded regular file')
      }
      source = await readTextNoFollow(this.filePath)
      if (Buffer.byteLength(source, 'utf8') > MAX_PROJECT_CATALOG_BYTES) {
        throw new TypeError('workspace project catalog exceeds the supported size')
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        if (error instanceof ProjectCatalogError) throw error
        throw new ProjectCatalogError(
          'project_catalog_corrupt',
          'Workspace project catalog cannot be read safely',
          409,
          error,
        )
      }
      const initial = this.#initialDocument()
      await this.#writeDocument(initial)
      await this.#recoverInterruptedDeletes(initial)
      return initial
    }

    let document: ProjectCatalogDocument
    try {
      document = parseCatalogDocument(JSON.parse(source) as unknown)
    } catch (error) {
      throw new ProjectCatalogError(
        'project_catalog_corrupt',
        'Workspace project catalog is invalid and requires operator repair',
        409,
        error,
      )
    }
    await this.#recoverInterruptedDeletes(document)
    return document
  }

  async #writeDocument(document: ProjectCatalogDocument): Promise<void> {
    const canonical = parseCatalogDocument(structuredClone(document))
    await this.#prepareWorkspace(true)
    await assertOptionalRegularFile(this.filePath)
    await atomicWriteText(this.filePath, `${JSON.stringify(canonical, null, 2)}\n`)
    await assertOptionalRegularFile(this.filePath)
  }

  #initialDocument(): ProjectCatalogDocument {
    return {
      schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
      projects: [],
    }
  }

  async #newProjectId(document: ProjectCatalogDocument): Promise<string> {
    const existing = new Set(document.projects.map((record) => record.id))
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = parseManagedProjectId(this.#idFactory())
      if (existing.has(id)) continue
      const target = path.join(this.projectsDir, id)
      try {
        await lstat(target)
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return id
        throw error
      }
    }
    throw new ProjectCatalogError(
      'project_catalog_corrupt',
      'Could not allocate a unique workspace project id',
      409,
    )
  }

  async #requireReadyProjectDirectory(record: ProjectCatalogRecord): Promise<string> {
    const expected = path.join(this.projectRoot, ...record.projectDir.split('/'))
    await assertRealDirectory(expected, this.projectsDir)
    const marker = await ensureCanvasReady(expected, record.id)
    assertManagedProjectMarker(record.id, marker)
    return expected
  }

  async #requireReadyManagedProjectDirectory(id: string, candidate: string): Promise<void> {
    await assertRealDirectory(candidate, this.projectsDir)
    const marker = await assertCanvasReady(candidate)
    assertManagedProjectMarker(id, marker)
  }

  #deleteTombstonePath(id: string): string {
    return path.join(this.projectsDir, `.deleting-${parseManagedProjectId(id)}`)
  }

  async #recoverInterruptedDeletes(document: ProjectCatalogDocument): Promise<void> {
    const records = new Map(document.projects.map((record) => [record.id, record]))
    const entries = await readdir(this.projectsDir, { withFileTypes: true })
    const tombstones = entries
      .map((entry) => ({ entry, match: PROJECT_DELETE_TOMBSTONE_PATTERN.exec(entry.name) }))
      .filter((candidate): candidate is {
        entry: (typeof entries)[number]
        match: RegExpExecArray
      } => candidate.match !== null)
      .sort((left, right) => left.entry.name.localeCompare(right.entry.name))

    for (const { entry, match } of tombstones) {
      const id = parseManagedProjectId(match[1])
      const tombstonePath = path.join(this.projectsDir, entry.name)
      const record = records.get(id)
      try {
        await this.#requireReadyManagedProjectDirectory(id, tombstonePath)
        if (!record) {
          await rm(tombstonePath, { recursive: true, force: false })
          continue
        }

        const projectPath = path.join(this.projectRoot, ...record.projectDir.split('/'))
        await assertPathMissing(projectPath)
        await rename(tombstonePath, projectPath)
        try {
          await this.#requireReadyProjectDirectory(record)
        } catch (error) {
          await rename(projectPath, tombstonePath).catch(() => undefined)
          throw error
        }
      } catch (error) {
        throw new ProjectCatalogError(
          'unsafe_workspace_catalog',
          `Interrupted deletion for workspace project ${id} cannot be recovered safely`,
          403,
          error,
        )
      }
    }
  }

  async #prepareWorkspace(create: boolean): Promise<void> {
    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(this.projectRoot)
    } catch (error) {
      throw new ProjectCatalogError(
        'unsafe_workspace_catalog',
        'Workspace project root cannot be resolved safely',
        403,
        error,
      )
    }
    if (canonicalRoot !== this.projectRoot) {
      throw new ProjectCatalogError(
        'unsafe_workspace_catalog',
        'Workspace project root must not contain symlink components',
        403,
      )
    }

    for (const candidate of [this.workspaceDir, this.projectsDir, this.filePath]) {
      const canonical = await canonicalizePotentialPath(candidate)
      if (canonical !== candidate || !isPathWithin(this.projectRoot, candidate)) {
        throw new ProjectCatalogError(
          'unsafe_workspace_catalog',
          'Workspace project catalog path resolves through a symlink',
          403,
        )
      }
    }
    if (create) await mkdir(this.projectsDir, { recursive: true, mode: 0o700 })
    if (create) {
      await assertRealDirectory(this.workspaceDir, this.projectRoot)
      await assertRealDirectory(this.projectsDir, this.workspaceDir)
    }
  }

  #timestamp(): string {
    const value = this.#now()
    if (!Number.isFinite(value)) throw new TypeError('Project catalog clock returned an invalid time')
    return new Date(value).toISOString()
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new ProjectCatalogError(
        'daemon_shutting_down',
        'daemon is shutting down',
        503,
      ))
    }
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export function projectDescriptorFromCanvasEnvelope(
  record: ProjectCatalogRecord,
  envelope: CanvasEnvelope,
): WorkspaceProjectDescriptor {
  return {
    ...structuredClone(record),
    updatedAt: latestTimestamp(record.updatedAt, envelope.updatedAt),
    state: 'ready',
    summary: {
      taskCount: envelope.document.tasks.length,
      nodeCount: envelope.document.nodes.length,
      collectionCount: envelope.document.collections.length,
    },
  }
}

function parseCatalogDocument(value: unknown): ProjectCatalogDocument {
  if (!isExactRecord(value, ['schemaVersion', 'projects']) || value.schemaVersion !== 1) {
    throw new TypeError('workspace project catalog envelope is invalid')
  }
  if (!Array.isArray(value.projects) || value.projects.length > MAX_PROJECT_RECORDS) {
    throw new TypeError('workspace project catalog projects are invalid')
  }
  const projects = value.projects.map(parseCatalogRecord)
  const ids = new Set<string>()
  const directories = new Set<string>()
  for (const record of projects) {
    if (ids.has(record.id) || directories.has(record.projectDir)) {
      throw new TypeError('workspace project catalog contains duplicate identities')
    }
    ids.add(record.id)
    directories.add(record.projectDir)
  }
  return {
    schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
    projects: projects.map((record) => structuredClone(record)),
  }
}

function parseCatalogRecord(value: unknown): ProjectCatalogRecord {
  if (!isExactRecord(value, [
    'id',
    'title',
    'projectDir',
    'createdAt',
    'updatedAt',
    'lastOpenedAt',
  ])) throw new TypeError('workspace project record has an invalid shape')
  const id = parseManagedProjectId(value.id)
  const title = parseProjectTitle(value.title)
  if (value.title !== title) throw new TypeError('workspace project title is not canonical')
  const projectDir = value.projectDir
  const expected = managedProjectDir(id)
  if (projectDir !== expected) throw new TypeError('workspace project path does not match its id')
  const createdAt = parseTimestamp(value.createdAt, 'createdAt')
  const updatedAt = parseTimestamp(value.updatedAt, 'updatedAt')
  const lastOpenedAt = value.lastOpenedAt === null
    ? null
    : parseTimestamp(value.lastOpenedAt, 'lastOpenedAt')
  if (Date.parse(updatedAt) < Date.parse(createdAt)
    || (lastOpenedAt !== null && Date.parse(lastOpenedAt) < Date.parse(createdAt))) {
    throw new TypeError('workspace project timestamps are inconsistent')
  }
  return { id, title, projectDir, createdAt, updatedAt, lastOpenedAt }
}

function requiredRecord(document: ProjectCatalogDocument, id: string): ProjectCatalogRecord {
  const record = document.projects.find((candidate) => candidate.id === id)
  if (!record) {
    throw new ProjectCatalogError(
      'project_not_found',
      `Workspace project ${id} was not found`,
      404,
    )
  }
  return record
}

function parseProjectTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProjectCatalogError('invalid_project_title', 'Project title must be a string', 400)
  }
  const title = value.trim().normalize('NFC')
  if (
    title.length === 0
    || title.length > MAX_PROJECT_TITLE_LENGTH
    || hasControlCharacter(title)
  ) {
    throw new ProjectCatalogError(
      'invalid_project_title',
      `Project title must contain 1-${MAX_PROJECT_TITLE_LENGTH} printable characters`,
      400,
    )
  }
  return title
}

function parseProjectId(value: unknown): string {
  try {
    return parseManagedProjectId(value)
  } catch (error) {
    if (error instanceof ProjectCatalogError) throw error
    throw new ProjectCatalogError('invalid_project_id', 'Workspace project id is invalid', 400, error)
  }
}

function parseManagedProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new ProjectCatalogError('invalid_project_id', 'Workspace project id is invalid', 400)
  }
  return value
}

function managedProjectDir(id: string): string {
  const managedId = parseManagedProjectId(id)
  return `.gg/workspace/projects/${managedId}`
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} is not a timestamp`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} is not a canonical timestamp`)
  }
  return value
}

function sameTitle(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}

function compareProjectDescriptors(
  left: WorkspaceProjectDescriptor,
  right: WorkspaceProjectDescriptor,
): number {
  const leftActivity = left.lastOpenedAt ?? left.updatedAt
  const rightActivity = right.lastOpenedAt ?? right.updatedAt
  return rightActivity.localeCompare(leftActivity)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id)
}

async function readMainCanvasSummary(projectDir: string): Promise<{
  updatedAt: string
  summary: WorkspaceProjectSummary
}> {
  const filePath = path.join(
    projectDir,
    '.gg',
    'runtime',
    'canvas',
    canvasBranchStorageId('main'),
    'snapshot.json',
  )
  const canonical = await canonicalizePotentialPath(filePath)
  if (canonical !== filePath || !isPathWithin(projectDir, filePath)) {
    throw new TypeError('Canvas main snapshot path is unsafe')
  }
  let source: string
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CANVAS_SNAPSHOT_BYTES) {
      throw new TypeError('Canvas main snapshot is not a bounded regular file')
    }
    source = await readTextNoFollow(filePath)
    if (Buffer.byteLength(source, 'utf8') > MAX_CANVAS_SNAPSHOT_BYTES) {
      throw new TypeError('Canvas main snapshot exceeds the supported size')
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return { updatedAt: '1970-01-01T00:00:00.000Z', summary: { ...EMPTY_SUMMARY } }
    }
    throw error
  }
  const envelope = parseCanvasEnvelopeSnapshot(source, 'main')
  return {
    updatedAt: envelope.updatedAt,
    summary: {
      taskCount: envelope.document.tasks.length,
      nodeCount: envelope.document.nodes.length,
      collectionCount: envelope.document.collections.length,
    },
  }
}

async function assertRealDirectory(candidate: string, parent: string): Promise<void> {
  const info = await lstat(candidate)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError(`Expected a real directory: ${candidate}`)
  }
  const canonical = await realpath(candidate)
  if (canonical !== candidate || !isPathWithin(parent, canonical)) {
    throw new TypeError(`Directory resolves outside its managed parent: ${candidate}`)
  }
}

async function assertOptionalRegularFile(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ProjectCatalogError(
        'unsafe_workspace_catalog',
        'Workspace project catalog must be a regular file',
        403,
      )
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
}

async function assertPathMissing(candidate: string): Promise<void> {
  try {
    await lstat(candidate)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  throw new TypeError(`Expected path to be absent: ${candidate}`)
}

function assertManagedProjectMarker(
  id: string,
  marker: Awaited<ReturnType<typeof assertCanvasReady>>,
): void {
  if (
    !marker
    || !('initializedFrom' in marker)
    || (marker.initializedFrom !== 'blank-project' && marker.initializedFrom !== 'schema-reset')
    || marker.projectId !== id
  ) {
    throw new TypeError('Managed project marker identity does not match the catalog')
  }
}

async function readTextNoFollow(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function latestTimestamp(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}
