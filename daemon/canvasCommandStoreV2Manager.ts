import path from 'node:path'
import type { CanvasCommandV2 } from '../src/canvas-v2/commands.js'
import { canvasBranchStorageId } from './canvasStore.js'
import {
  CanvasCommandStoreV2,
  type CanvasEnvelopeV2,
} from './canvasCommandStoreV2.js'
import {
  canonicalizePotentialPath,
  createProjectScope,
  isPathWithin,
} from './permissions.js'
import { parseCanvasBranch, ProtocolError } from './protocol.js'

export interface CanvasCommandStoreV2ManagerOptions {
  projectRoot: string
  acquireProjectLease: (projectDir: string) => Promise<string>
  now?: () => number
}

/** Resolves safe project/branch storage while sharing the daemon's process lease. */
export class CanvasCommandStoreV2Manager {
  readonly #projectRoot: string
  readonly #acquireProjectLease: (projectDir: string) => Promise<string>
  readonly #now: () => number
  readonly #stores = new Map<string, CanvasCommandStoreV2>()
  #closed = false

  constructor(options: CanvasCommandStoreV2ManagerOptions) {
    this.#projectRoot = path.resolve(options.projectRoot)
    this.#acquireProjectLease = options.acquireProjectLease
    this.#now = options.now ?? Date.now
  }

  async get(projectDir: string, branch: string): Promise<CanvasEnvelopeV2> {
    return (await this.#resolve(projectDir, branch)).get()
  }

  async readRevision(
    projectDir: string,
    branch: string,
    revision: number,
  ): Promise<CanvasEnvelopeV2['document'] | null> {
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
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2> {
    return (await this.#resolve(projectDir, branch)).commit(baseRevision, mutationId, command)
  }

  /** Daemon-only latest-revision commit for trusted settlement commands. */
  async commitLatest(
    projectDir: string,
    branch: string,
    mutationId: string,
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2> {
    return (await this.#resolve(projectDir, branch)).commitLatest(mutationId, command)
  }

  async setLastCheckpoint(
    projectDir: string,
    branch: string,
    expectedRevision: number,
    commit: string,
  ): Promise<CanvasEnvelopeV2> {
    return (await this.#resolve(projectDir, branch))
      .setLastCheckpoint(expectedRevision, commit)
  }

  async materialize(
    projectDir: string,
    branch: string,
    document: CanvasEnvelopeV2['document'],
    checkpoint: string,
  ): Promise<CanvasEnvelopeV2> {
    return (await this.#resolve(projectDir, branch)).materialize(document, checkpoint)
  }

  async applyCheckpoint(
    projectDir: string,
    branch: string,
    document: CanvasEnvelopeV2['document'],
    checkpoint: string,
    expectedRevision: number,
  ): Promise<CanvasEnvelopeV2> {
    return (await this.#resolve(projectDir, branch))
      .applyCheckpoint(document, checkpoint, expectedRevision)
  }

  /** Returns the same canonical, leased project directory used by V2 stores. */
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

  close(): void {
    this.#closed = true
    this.#stores.clear()
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
  }

  async #resolve(projectDir: string, requestedBranch: string): Promise<CanvasCommandStoreV2> {
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
      'canvas-v2',
      canvasBranchStorageId(branch),
    )
    const filePath = path.join(branchDirectory, 'snapshot.json')
    const revisionDirectory = path.join(branchDirectory, 'revisions')
    await Promise.all([
      assertManagedCanvasV2Path(scope.ggDir, filePath),
      assertManagedCanvasV2Path(scope.ggDir, revisionDirectory),
    ])

    const key = `${scope.projectDir}\0${branch}`
    let store = this.#stores.get(key)
    if (!store) {
      store = new CanvasCommandStoreV2(branch, {
        filePath,
        revisionDirectory,
        now: this.#now,
      })
      this.#stores.set(key, store)
    }
    return store
  }
}

async function assertManagedCanvasV2Path(ggDir: string, filePath: string): Promise<void> {
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
      'unsafe Canvas V2 snapshot path escapes the project .gg directory',
      'unsafe_managed_path',
      403,
    )
  }
}
