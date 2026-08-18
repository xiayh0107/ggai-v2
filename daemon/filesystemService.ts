import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { CanvasDocument } from '../src/canvas/model.js'
import {
  filesystemTextKind,
  MAX_BOUND_TEXT_BYTES,
  MAX_FILESYSTEM_TREE_PAGE,
  validFilesystemRelativePath,
  type FilesystemBinding,
  type FilesystemBindingMode,
  type FilesystemConflict,
  type FilesystemTreeEntry,
  type WorkspaceRoot,
} from '../src/filesystem/contracts.js'
import type {
  StoredFilesystemBinding,
  StoredWorkspaceRoot,
} from './metadataProtocol.js'
import type { MetadataStore } from './metadataStore.js'
import type { CanvasCommandStoreManager } from './canvasCommandStoreManager.js'

const MAX_HASHED_FILE_BYTES = 1024 * 1024 * 1024

export class FilesystemServiceError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'FilesystemServiceError'
    this.code = code
    this.status = status
  }
}

export class FilesystemService {
  readonly #metadata: MetadataStore
  readonly #canvas: CanvasCommandStoreManager
  readonly #watchers = new Map<string, FSWatcher>()
  readonly #watcherReady = new Map<string, Promise<void>>()
  #closed = false

  constructor(metadata: MetadataStore, canvas: CanvasCommandStoreManager) {
    this.#metadata = metadata
    this.#canvas = canvas
  }

  async createRoot(input: {
    projectId: string
    displayName: string
    requestedPath: string
  }): Promise<WorkspaceRoot> {
    this.#assertOpen()
    if (process.platform !== 'darwin') {
      throw new FilesystemServiceError('filesystem_provider_unavailable', 'macOS filesystem provider is unavailable', 503)
    }
    if (typeof input.displayName !== 'string' || input.displayName.trim().length < 1
      || input.displayName.length > 120 || typeof input.requestedPath !== 'string') {
      throw new FilesystemServiceError('invalid_workspace_root', 'Workspace root input is invalid', 400)
    }
    const requested = path.resolve(input.requestedPath)
    const canonicalPath = await realpath(requested).catch(() => {
      throw new FilesystemServiceError('workspace_root_missing', 'Workspace root does not exist', 404)
    })
    const info = await lstat(requested)
    if (canonicalPath !== requested || !info.isDirectory() || info.isSymbolicLink()) {
      throw new FilesystemServiceError('unsafe_workspace_root', 'Workspace root must be a real directory', 403)
    }
    const existing = (await this.#metadata.listWorkspaceRoots(input.projectId))
      .find((root) => root.canonicalPath === canonicalPath)
    if (existing) {
      await this.#ensureWatcher(existing)
      return publicRoot(existing)
    }
    const root = await this.#metadata.createWorkspaceRoot({
      rootId: `root_${randomUUID()}`,
      projectId: input.projectId,
      displayName: input.displayName.trim(),
      canonicalPath,
      platformProvider: 'macos',
      createdAt: new Date().toISOString(),
    })
    await this.#ensureWatcher(root)
    return publicRoot(root)
  }

  async listRoots(projectId: string): Promise<WorkspaceRoot[]> {
    this.#assertOpen()
    const roots = await this.#metadata.listWorkspaceRoots(projectId)
    await Promise.all(roots.map((root) => this.#ensureWatcher(root)))
    return roots.map(publicRoot)
  }

  async tree(input: {
    projectId: string
    rootId: string
    relativePath: string
    cursor?: string
    limit?: number
  }): Promise<{ entries: FilesystemTreeEntry[]; nextCursor: string | null }> {
    const root = await this.#rootForProject(input.rootId, input.projectId)
    const relativePath = parseRelativePath(input.relativePath, true)
    const directory = await resolveExistingWithinRoot(root.canonicalPath, relativePath)
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new FilesystemServiceError('not_a_directory', 'Filesystem tree target is not a directory', 400)
    }
    const limit = input.limit ?? MAX_FILESYSTEM_TREE_PAGE
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILESYSTEM_TREE_PAGE) {
      throw new FilesystemServiceError('invalid_tree_limit', 'Filesystem tree limit is invalid', 400)
    }
    const after = input.cursor ? decodeCursor(input.cursor, root.rootId, relativePath) : null
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right))
    const page = paginateFilesystemNames(names, after, limit)
    const entries = await Promise.all(page.map(async (name): Promise<FilesystemTreeEntry> => {
      const absolutePath = path.join(directory, name)
      const entryInfo = await lstat(absolutePath)
      const childRelative = relativePath ? `${relativePath}/${name}` : name
      return {
        name,
        relativePath: childRelative,
        kind: entryInfo.isSymbolicLink() ? 'symlink'
          : entryInfo.isDirectory() ? 'directory'
            : entryInfo.isFile() ? 'file' : 'other',
        size: entryInfo.size,
        modifiedAt: entryInfo.mtime.toISOString(),
      }
    }))
    return {
      entries,
      nextCursor: page.length > 0 && names.some((name) => name.localeCompare(page.at(-1)!) > 0)
        ? encodeCursor(root.rootId, relativePath, page.at(-1)!)
        : null,
    }
  }

  async createBinding(input: {
    projectId: string
    canvasProjectDir: string
    canvasBranch: string
    document: CanvasDocument
    nodeId: string
    rootId: string
    relativePath: string
    kind: 'file' | 'directory'
    mode: FilesystemBindingMode
  }): Promise<{ binding: FilesystemBinding; command: { type: 'BindNodeToFilesystem'; nodeId: string; bindingId: string } }> {
    const root = await this.#rootForProject(input.rootId, input.projectId)
    const relativePath = parseRelativePath(input.relativePath, false)
    const absolutePath = await resolveExistingWithinRoot(root.canonicalPath, relativePath)
    const info = await lstat(absolutePath)
    if (info.isSymbolicLink()
      || (input.kind === 'file' ? !info.isFile() : !info.isDirectory())) {
      throw new FilesystemServiceError('binding_kind_mismatch', 'Filesystem binding target kind is invalid', 400)
    }
    if (!['fs-authoritative', 'canvas-authoritative', 'bidirectional'].includes(input.mode)) {
      throw new FilesystemServiceError('invalid_binding_mode', 'Filesystem binding mode is invalid', 400)
    }
    if (input.kind === 'directory' && input.mode !== 'fs-authoritative') {
      throw new FilesystemServiceError('unsupported_binding_mode', 'Directories are read-only filesystem bindings', 400)
    }
    if (input.mode === 'bidirectional' && !filesystemTextKind(relativePath)) {
      throw new FilesystemServiceError(
        'unsupported_bidirectional_type',
        'Bidirectional binding supports only UTF-8 text, Markdown, JSON, CSV, and code',
        400,
      )
    }
    const node = input.document.nodes.find((candidate) => candidate.id === input.nodeId)
    if (!node) throw new FilesystemServiceError('node_not_found', 'Canvas node does not exist', 404)
    const disk = input.kind === 'file' ? await readStableFile(absolutePath, filesystemTextKind(relativePath)) : null
    const canvasDigest = input.kind === 'file' && filesystemTextKind(relativePath)
      ? digestText(node.text ?? '') : null
    const diskDigest = disk?.digest ?? null
    const binding = await this.#metadata.createFilesystemBinding({
      bindingId: `binding_${randomUUID()}`,
      projectId: input.projectId,
      canvasBranch: input.canvasBranch,
      canvasProjectDir: input.canvasProjectDir,
      nodeId: input.nodeId,
      rootId: input.rootId,
      relativePath,
      kind: input.kind,
      mode: input.mode,
      baseDigest: diskDigest,
      canvasDigest,
      diskDigest,
      state: canvasDigest === null || canvasDigest === diskDigest
        ? 'clean'
        : input.mode === 'fs-authoritative' ? 'disk-dirty' : 'canvas-dirty',
      fileIdentity: fileIdentity(info),
      echoToken: null,
      updatedAt: new Date().toISOString(),
    })
    await this.#ensureWatcher(root)
    return {
      binding: publicBinding(binding),
      command: { type: 'BindNodeToFilesystem', nodeId: input.nodeId, bindingId: binding.bindingId },
    }
  }

  async save(input: {
    projectId: string
    bindingId: string
    document: CanvasDocument
  }): Promise<FilesystemBinding> {
    const binding = await this.#bindingForProject(input.bindingId, input.projectId)
    if (binding.kind !== 'file' || binding.mode === 'fs-authoritative'
      || !filesystemTextKind(binding.relativePath)) {
      throw new FilesystemServiceError('binding_is_read_only', 'Filesystem binding cannot save Canvas content', 403)
    }
    const node = input.document.nodes.find((candidate) => candidate.id === binding.nodeId)
    if (!node || node.bindingId !== binding.bindingId) {
      throw new FilesystemServiceError('binding_not_attached', 'Filesystem binding is not attached to its node', 409)
    }
    const root = await this.#rootForProject(binding.rootId, input.projectId)
    const absolutePath = await resolveExistingWithinRoot(root.canonicalPath, binding.relativePath)
    const text = node.text ?? ''
    const canvasDigest = digestText(text)
    const disk = await readStableFile(absolutePath, true)
    if (disk.digest !== binding.baseDigest && disk.digest !== canvasDigest) {
      await this.#recordConflict(binding, canvasDigest, disk.digest)
      throw new FilesystemServiceError('filesystem_conflict', 'Disk and Canvas both changed from the binding base')
    }
    await this.#metadata.updateFilesystemBinding(binding.bindingId, {
      canvasDigest,
      diskDigest: disk.digest,
      echoToken: canvasDigest,
      state: 'canvas-dirty',
      updatedAt: new Date().toISOString(),
    })
    try {
      const written = await atomicCasWriteText(absolutePath, text, disk.digest, binding.bindingId)
      return publicBinding(await this.#metadata.updateFilesystemBinding(binding.bindingId, {
        baseDigest: canvasDigest,
        canvasDigest,
        diskDigest: canvasDigest,
        fileIdentity: written.identity,
        echoToken: canvasDigest,
        state: 'clean',
        updatedAt: new Date().toISOString(),
      }))
    } catch (error) {
      await this.#metadata.updateFilesystemBinding(binding.bindingId, {
        echoToken: null,
        state: 'conflict',
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined)
      throw error
    }
  }

  listConflicts(projectId: string): Promise<FilesystemConflict[]> {
    return this.#metadata.listFilesystemConflicts(projectId, true)
  }

  async getBinding(bindingId: string, projectId: string): Promise<FilesystemBinding> {
    return publicBinding(await this.#bindingForProject(bindingId, projectId))
  }

  deleteBinding(bindingId: string): Promise<boolean> {
    return this.#metadata.deleteFilesystemBinding(bindingId)
  }

  async reconcile(bindingId: string, projectId: string): Promise<FilesystemBinding> {
    const binding = await this.#bindingForProject(bindingId, projectId)
    const root = await this.#rootForProject(binding.rootId, projectId)
    await this.#reconcileBinding(root, binding)
    const updated = await this.#bindingForProject(bindingId, projectId)
    return publicBinding(updated)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const watchers = [...this.#watchers.values()]
    this.#watchers.clear()
    this.#watcherReady.clear()
    await Promise.allSettled(watchers.map((watcher) => watcher.close()))
  }

  async #ensureWatcher(root: StoredWorkspaceRoot): Promise<void> {
    if (this.#closed) return
    const existing = this.#watcherReady.get(root.rootId)
    if (existing) return existing
    const watcher = chokidar.watch(root.canonicalPath, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
    })
    watcher.on('all', (event, changedPath) => {
      if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) return
      void this.#onFilesystemEvent(root, changedPath).catch(() => undefined)
      setTimeout(() => {
        void this.#reconcileKnownBindings(root).catch(() => undefined)
      }, 50).unref()
    })
    const ready = new Promise<void>((resolve, reject) => {
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    })
    this.#watchers.set(root.rootId, watcher)
    this.#watcherReady.set(root.rootId, ready)
    await ready
  }

  async #onFilesystemEvent(root: StoredWorkspaceRoot, changedPath: string): Promise<void> {
    const reportedPath = path.resolve(changedPath)
    const absolutePath = await realpath(reportedPath).catch(() => reportedPath)
    if (!isWithin(root.canonicalPath, absolutePath)) return
    let relativePath = path.relative(root.canonicalPath, absolutePath).split(path.sep).join('/')
    if (!validFilesystemRelativePath(relativePath)) return
    const bindings = await this.#metadata.listFilesystemBindingsForRoot(root.rootId)
    const info = await lstat(absolutePath).catch(() => null)
    if (info && !info.isSymbolicLink()) {
      const identity = fileIdentity(info)
      if (bindings.some((binding) => binding.fileIdentity === identity)) {
        relativePath = await actualRelativePathForIdentity(
          root.canonicalPath, absolutePath, identity,
        ) ?? relativePath
      }
      const renamed = bindings.find((binding) =>
        binding.fileIdentity === identity && binding.relativePath !== relativePath)
      if (renamed) {
        const oldPath = path.join(root.canonicalPath, ...renamed.relativePath.split('/'))
        if (!await lstat(oldPath).then(() => true, () => false)) {
          await this.#metadata.updateFilesystemBinding(renamed.bindingId, {
            relativePath,
            fileIdentity: identity,
            updatedAt: new Date().toISOString(),
          })
          renamed.relativePath = relativePath
        }
      }
    }
    const current = await this.#metadata.listFilesystemBindingsForRoot(root.rootId)
    await Promise.all(current
      .filter((binding) => binding.relativePath === relativePath)
      .map((binding) => this.#reconcileBinding(root, binding)))
  }

  async #reconcileBinding(root: StoredWorkspaceRoot, binding: StoredFilesystemBinding): Promise<void> {
    const absolutePath = path.join(root.canonicalPath, ...binding.relativePath.split('/'))
    const info = await lstat(absolutePath).catch(() => null)
    if (!info || info.isSymbolicLink()) {
      await this.#metadata.updateFilesystemBinding(binding.bindingId, {
        diskDigest: null,
        echoToken: null,
        state: 'missing',
        updatedAt: new Date().toISOString(),
      })
      return
    }
    if (binding.kind === 'directory') {
      await this.#metadata.updateFilesystemBinding(binding.bindingId, {
        fileIdentity: fileIdentity(info), state: 'clean', updatedAt: new Date().toISOString(),
      })
      return
    }
    const textBinding = filesystemTextKind(binding.relativePath)
    const disk = await readStableFile(absolutePath, textBinding)
    if (binding.echoToken === disk.digest) {
      await this.#metadata.updateFilesystemBinding(binding.bindingId, {
        baseDigest: disk.digest, canvasDigest: disk.digest, diskDigest: disk.digest,
        fileIdentity: fileIdentity(info), echoToken: null, state: 'clean',
        updatedAt: new Date().toISOString(),
      })
      return
    }
    if (!textBinding) {
      await this.#metadata.updateFilesystemBinding(binding.bindingId, {
        baseDigest: disk.digest, diskDigest: disk.digest, fileIdentity: fileIdentity(info),
        state: 'clean', updatedAt: new Date().toISOString(),
      })
      return
    }
    const envelope = await this.#canvas.get(binding.canvasProjectDir, binding.canvasBranch)
    const node = envelope.document.nodes.find((candidate) => candidate.id === binding.nodeId)
    if (!node || node.bindingId !== binding.bindingId) return
    const canvasDigest = digestText(node.text ?? '')
    if (binding.mode === 'fs-authoritative') {
      await this.#applyDiskText(binding, disk.text!, disk.digest, canvasDigest)
      return
    }
    if (binding.mode === 'canvas-authoritative') {
      if (canvasDigest === disk.digest) {
        await this.#metadata.updateFilesystemBinding(binding.bindingId, {
          baseDigest: disk.digest, canvasDigest, diskDigest: disk.digest,
          fileIdentity: fileIdentity(info), state: 'clean', updatedAt: new Date().toISOString(),
        })
      } else if (disk.digest === binding.baseDigest) {
        await this.#metadata.updateFilesystemBinding(binding.bindingId, {
          canvasDigest, diskDigest: disk.digest, fileIdentity: fileIdentity(info),
          state: 'canvas-dirty', updatedAt: new Date().toISOString(),
        })
      } else {
        await this.#recordConflict(binding, canvasDigest, disk.digest)
      }
      return
    }
    if (canvasDigest === binding.baseDigest) {
      await this.#applyDiskText(binding, disk.text!, disk.digest, canvasDigest)
      return
    }
    if (disk.digest === binding.baseDigest) {
      await this.#metadata.updateFilesystemBinding(binding.bindingId, {
        canvasDigest, diskDigest: disk.digest, fileIdentity: fileIdentity(info),
        state: canvasDigest === disk.digest ? 'clean' : 'canvas-dirty',
        updatedAt: new Date().toISOString(),
      })
      return
    }
    if (canvasDigest === disk.digest) {
      await this.#metadata.updateFilesystemBinding(binding.bindingId, {
        baseDigest: disk.digest, canvasDigest, diskDigest: disk.digest,
        fileIdentity: fileIdentity(info), state: 'clean', updatedAt: new Date().toISOString(),
      })
      return
    }
    await this.#recordConflict(binding, canvasDigest, disk.digest)
  }

  async #reconcileKnownBindings(root: StoredWorkspaceRoot): Promise<void> {
    const bindings = await this.#metadata.listFilesystemBindingsForRoot(root.rootId)
    for (const binding of bindings) {
      const reportedPath = path.join(root.canonicalPath, ...binding.relativePath.split('/'))
      let info = await lstat(reportedPath).catch(() => null)
      let actualRelative: string | null = null
      if (binding.fileIdentity) {
        actualRelative = await actualRelativePathForIdentity(
          root.canonicalPath, reportedPath, binding.fileIdentity,
        )
      }
      if (actualRelative && actualRelative !== binding.relativePath) {
        binding.relativePath = actualRelative
        await this.#metadata.updateFilesystemBinding(binding.bindingId, {
          relativePath: actualRelative,
          updatedAt: new Date().toISOString(),
        })
        info = await lstat(path.join(root.canonicalPath, ...actualRelative.split('/'))).catch(() => null)
      }
      if (!info || binding.fileIdentity === null || fileIdentity(info) === binding.fileIdentity) {
        await this.#reconcileBinding(root, binding)
      }
    }
  }

  async #applyDiskText(
    binding: StoredFilesystemBinding,
    text: string,
    diskDigest: string,
    canvasDigest: string,
  ): Promise<void> {
    if (canvasDigest !== diskDigest) {
      await this.#canvas.commitLatest(
        binding.canvasProjectDir,
        binding.canvasBranch,
        `fs-sync-${binding.bindingId}-${diskDigest.slice(0, 20)}`,
        { type: 'UpdateNodeContent', nodeId: binding.nodeId, patch: { text } },
      )
    }
    await this.#metadata.updateFilesystemBinding(binding.bindingId, {
      baseDigest: diskDigest,
      canvasDigest: diskDigest,
      diskDigest,
      echoToken: null,
      state: 'clean',
      updatedAt: new Date().toISOString(),
    })
  }

  async #recordConflict(
    binding: StoredFilesystemBinding,
    canvasDigest: string,
    diskDigest: string,
  ): Promise<void> {
    const existing = (await this.#metadata.listFilesystemConflicts(binding.projectId, true))
      .find((conflict) => conflict.bindingId === binding.bindingId
        && conflict.canvasDigest === canvasDigest && conflict.diskDigest === diskDigest)
    if (!existing) {
      await this.#metadata.createFilesystemConflict({
        conflictId: `conflict_${randomUUID()}`,
        bindingId: binding.bindingId,
        baseDigest: binding.baseDigest,
        canvasDigest,
        diskDigest,
        state: 'open',
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      })
    }
    await this.#metadata.updateFilesystemBinding(binding.bindingId, {
      canvasDigest,
      diskDigest,
      echoToken: null,
      state: 'conflict',
      updatedAt: new Date().toISOString(),
    })
  }

  async #rootForProject(rootId: string, projectId: string): Promise<StoredWorkspaceRoot> {
    const root = await this.#metadata.getWorkspaceRoot(rootId)
    if (!root) throw new FilesystemServiceError('workspace_root_not_found', 'Workspace root does not exist', 404)
    if (root.projectId !== projectId) throw new FilesystemServiceError('workspace_root_scope_mismatch', 'Workspace root belongs to another project', 403)
    return root
  }

  async #bindingForProject(bindingId: string, projectId: string): Promise<StoredFilesystemBinding> {
    const binding = await this.#metadata.getFilesystemBinding(bindingId)
    if (!binding) throw new FilesystemServiceError('binding_not_found', 'Filesystem binding does not exist', 404)
    if (binding.projectId !== projectId) throw new FilesystemServiceError('binding_scope_mismatch', 'Filesystem binding belongs to another project', 403)
    return binding
  }

  #assertOpen(): void {
    if (this.#closed) throw new FilesystemServiceError('filesystem_service_closed', 'Filesystem service is closed', 503)
  }
}

async function readStableFile(
  absolutePath: string,
  decodeText: boolean,
): Promise<{ digest: string; text?: string }> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_HASHED_FILE_BYTES
      || (decodeText && before.size > MAX_BOUND_TEXT_BYTES)) {
      throw new FilesystemServiceError('unsupported_bound_file', 'Bound file is unsafe or too large', 413)
    }
    let bytes: Buffer | null = null
    const hash = createHash('sha256')
    if (decodeText) {
      bytes = await readAll(handle, before.size)
      hash.update(bytes)
    } else {
      let consumed = 0
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
        const buffer = chunk as Buffer
        consumed += buffer.byteLength
        hash.update(buffer)
      }
      if (consumed !== before.size) {
        throw new FilesystemServiceError('file_changed_during_read', 'Bound file was truncated')
      }
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.dev !== before.dev || after.ino !== before.ino) {
      throw new FilesystemServiceError('file_changed_during_read', 'Bound file changed during reconciliation')
    }
    const digest = hash.digest('hex')
    if (!decodeText) return { digest }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes!)
    } catch {
      throw new FilesystemServiceError('bound_file_not_utf8', 'Bound text file is not valid UTF-8', 400)
    }
    return { digest, text }
  } finally {
    await handle.close()
  }
}

async function atomicCasWriteText(
  absolutePath: string,
  text: string,
  expectedDigest: string,
  bindingId: string,
): Promise<{ identity: string }> {
  const parent = path.dirname(absolutePath)
  if (await realpath(parent) !== parent) {
    throw new FilesystemServiceError('unsafe_binding_parent', 'Binding parent contains a symlink', 403)
  }
  const before = await readStableFile(absolutePath, true)
  if (before.digest !== expectedDigest) {
    throw new FilesystemServiceError('filesystem_cas_mismatch', 'Disk changed before Canvas save')
  }
  const currentInfo = await lstat(absolutePath)
  const temporaryPath = path.join(parent, `.ggai-${bindingId}-${randomUUID()}.tmp`)
  let handle: FileHandle | null = null
  try {
    handle = await open(temporaryPath, 'wx', currentInfo.mode & 0o777)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    if ((await readStableFile(absolutePath, true)).digest !== expectedDigest) {
      throw new FilesystemServiceError('filesystem_cas_mismatch', 'Disk changed during Canvas save')
    }
    await rename(temporaryPath, absolutePath)
    const directory = await open(parent, 'r')
    try { await directory.sync() } finally { await directory.close() }
    return { identity: fileIdentity(await lstat(absolutePath)) }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

async function readAll(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset !== size) throw new FilesystemServiceError('file_changed_during_read', 'Bound file was truncated')
  return bytes
}

async function resolveExistingWithinRoot(root: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(root, ...relativePath.split('/').filter(Boolean))
  if (!isWithin(root, candidate)) throw new FilesystemServiceError('filesystem_path_escape', 'Filesystem path escapes its root', 403)
  const canonical = await realpath(candidate).catch(() => {
    throw new FilesystemServiceError('filesystem_path_missing', 'Filesystem path does not exist', 404)
  })
  if (canonical !== candidate || !isWithin(root, canonical)) {
    throw new FilesystemServiceError('filesystem_symlink_denied', 'Filesystem path contains a symlink', 403)
  }
  return canonical
}

function parseRelativePath(value: unknown, allowEmpty: boolean): string {
  if (!validFilesystemRelativePath(value, allowEmpty)) {
    throw new FilesystemServiceError('invalid_relative_path', 'Filesystem relative path is invalid', 400)
  }
  return value
}

function publicRoot(root: StoredWorkspaceRoot): WorkspaceRoot {
  return {
    rootId: root.rootId,
    projectId: root.projectId,
    displayName: root.displayName,
    platformProvider: root.platformProvider,
    createdAt: root.createdAt,
  }
}

function publicBinding(binding: StoredFilesystemBinding): FilesystemBinding {
  return {
    bindingId: binding.bindingId,
    projectId: binding.projectId,
    canvasBranch: binding.canvasBranch,
    nodeId: binding.nodeId,
    rootId: binding.rootId,
    relativePath: binding.relativePath,
    kind: binding.kind,
    mode: binding.mode,
    baseDigest: binding.baseDigest,
    canvasDigest: binding.canvasDigest,
    diskDigest: binding.diskDigest,
    state: binding.state,
    updatedAt: binding.updatedAt,
  }
}

function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function fileIdentity(info: Stats): string {
  return `${info.dev}:${info.ino}`
}

async function actualRelativePathForIdentity(
  root: string,
  reportedPath: string,
  identity: string,
): Promise<string | null> {
  const parent = path.dirname(reportedPath)
  const names = await readdir(parent).catch(() => [])
  for (const name of names) {
    const candidate = path.join(parent, name)
    const info = await lstat(candidate).catch(() => null)
    if (info && !info.isSymbolicLink() && fileIdentity(info) === identity) {
      const relative = path.relative(root, candidate).split(path.sep).join('/')
      return validFilesystemRelativePath(relative) ? relative : null
    }
  }
  return null
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function encodeCursor(rootId: string, relativePath: string, after: string): string {
  return Buffer.from(JSON.stringify({ rootId, relativePath, after }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string, rootId: string, relativePath: string): string {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'after,relativePath,rootId'
      || record.rootId !== rootId || record.relativePath !== relativePath
      || typeof record.after !== 'string' || record.after.length > 255) throw new Error('invalid')
    return record.after
  } catch {
    throw new FilesystemServiceError('invalid_tree_cursor', 'Filesystem tree cursor is invalid', 400)
  }
}

export function paginateFilesystemNames(
  sortedNames: readonly string[],
  after: string | null,
  limit: number,
): string[] {
  const page: string[] = []
  for (const name of sortedNames) {
    if (after !== null && name.localeCompare(after) <= 0) continue
    page.push(name)
    if (page.length === limit) break
  }
  return page
}
