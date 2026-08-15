import path from 'node:path'
import type { CanvasCommand } from '../src/canvas/commands.js'
import { canvasBranchStorageId } from './canvasBranch.js'
import {
  CanvasCommandStore,
  type CanvasEnvelope,
} from './canvasCommandStore.js'
import {
  canonicalizePotentialPath,
  createProjectScope,
  isPathWithin,
} from './permissions.js'
import { parseCanvasBranch, ProtocolError } from './protocol.js'

export interface CanvasCommandStoreManagerOptions {
  projectRoot: string
  acquireProjectLease: (projectDir: string) => Promise<string>
  now?: () => number
}

/** Resolves safe project/branch storage while sharing the daemon's process lease. */
export class CanvasCommandStoreManager {
  readonly #projectRoot: string
  readonly #acquireProjectLease: (projectDir: string) => Promise<string>
  readonly #now: () => number
  readonly #stores = new Map<string, CanvasCommandStore>()
  #closed = false

  constructor(options: CanvasCommandStoreManagerOptions) {
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#acquireProjectLease = options.acquireProjectLease
    this.#now = options.now ?? Date.now
  }

  async get(projectDir: string, branch: string): Promise<CanvasEnvelope> {
    return (await this.#resolve(projectDir, branch)).get()
  }

  async readRevision(
    projectDir: string,
    branch: string,
    revision: number,
  ): Promise<CanvasEnvelope['document'] | null> {
    return (await this.#resolve(projectDir, branch)).readRevision(revision)
  }

  async hasSnapshot(projectDir: string, branch: string): Promise<boolean> {
    return (await this.#resolve(projectDir, branch)).hasSnapshot()
  }

  async commit(
    projectDir: string,
    branch: string,
    baseRevision: number,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolve(projectDir, branch)).commit(baseRevision, mutationId, command)
  }

  /** Daemon-only latest-revision commit for trusted settlement commands. */
  async commitLatest(
    projectDir: string,
    branch: string,
    mutationId: string,
    command: CanvasCommand,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolve(projectDir, branch)).commitLatest(mutationId, command)
  }

  async setLastCheckpoint(
    projectDir: string,
    branch: string,
    expectedRevision: number,
    commit: string,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolve(projectDir, branch))
      .setLastCheckpoint(expectedRevision, commit)
  }

  async materialize(
    projectDir: string,
    branch: string,
    document: CanvasEnvelope['document'],
    checkpoint: string,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolve(projectDir, branch)).materialize(document, checkpoint)
  }

  async applyCheckpoint(
    projectDir: string,
    branch: string,
    document: CanvasEnvelope['document'],
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelope> {
    return (await this.#resolve(projectDir, branch))
      .applyCheckpoint(document, checkpoint, expectedRevision)
  }

  /** Returns the same canonical, leased project directory used by Canvas stores. */
  async acquireProjectLease(projectDir: string): Promise<string> {
    this.#assertOpen()
    const canonicalProjectDir = await this.#acquireProjectLease(projectDir)
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: canonicalProjectDir,
    })
    this.#assertOpen()
    return scope.projectDir
  }

  /** Drains and forgets every cached branch store for a fenced project. */
  async drainAndEvictProject(projectDir: string): Promise<void> {
    this.#assertOpen()
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir,
    })
    const prefix = `${scope.projectDir}\0`
    const stores = [...this.#stores.entries()]
      .filter(([key]) => key.startsWith(prefix))
    await Promise.all(stores.map(([, store]) => store.drain()))
    for (const [key, store] of stores) {
      if (this.#stores.get(key) === store) this.#stores.delete(key)
    }
  }

  close(): void {
    this.#closed = true
    this.#stores.clear()
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
  }

  async #resolve(projectDir: string, requestedBranch: string): Promise<CanvasCommandStore> {
    this.#assertOpen()
    const branch = parseCanvasBranch(requestedBranch)
    const canonicalProjectDir = await this.acquireProjectLease(projectDir)
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: canonicalProjectDir,
    })
    const branchDirectory = path.resolve(
      scope.projectDir,
      '.gg',
      'runtime',
      'canvas',
      canvasBranchStorageId(branch),
    )
    const filePath = path.join(branchDirectory, 'snapshot.json')
    const revisionDirectory = path.join(branchDirectory, 'revisions')
    await Promise.all([
      assertManagedCanvasPath(scope.ggDir, filePath),
      assertManagedCanvasPath(scope.ggDir, revisionDirectory),
    ])

    const key = `${scope.projectDir}\0${branch}`
    let store = this.#stores.get(key)
    if (!store) {
      store = new CanvasCommandStore(branch, {
        filePath,
        revisionDirectory,
        now: this.#now,
      })
      this.#stores.set(key, store)
    }
    return store
  }
}

async function assertManagedCanvasPath(ggDir: string, filePath: string): Promise<void> {
  const [canonicalGgDir, canonicalFilePath] = await Promise.all([
    canonicalizePotentialPath(ggDir),
    canonicalizePotentialPath(filePath),
  ])
  if (
    canonicalGgDir !== ggDir
    || canonicalFilePath !== filePath
    || !isPathWithin(ggDir, filePath)
    || !isPathWithin(canonicalGgDir, canonicalFilePath)
  ) {
    throw new ProtocolError(
      'unsafe Canvas snapshot path escapes the project .gg directory',
      'unsafe_managed_path',
      403,
    )
  }
}
