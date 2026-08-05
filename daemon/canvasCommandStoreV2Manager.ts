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

  async commit(
    projectDir: string,
    branch: string,
    baseRevision: number,
    mutationId: string,
    command: CanvasCommandV2,
  ): Promise<CanvasEnvelopeV2> {
    return (await this.#resolve(projectDir, branch)).commit(baseRevision, mutationId, command)
  }

  close(): void {
    this.#closed = true
    this.#stores.clear()
  }

  async #resolve(projectDir: string, requestedBranch: string): Promise<CanvasCommandStoreV2> {
    if (this.#closed) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
    const branch = parseCanvasBranch(requestedBranch)
    const canonicalProjectDir = await this.#acquireProjectLease(projectDir)
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: canonicalProjectDir,
    })
    const filePath = path.resolve(
      scope.projectDir,
      '.gg',
      'runtime',
      'canvas-v2',
      canvasBranchStorageId(branch),
      'snapshot.json',
    )
    await assertManagedCanvasV2Path(scope.ggDir, filePath)

    const key = `${scope.projectDir}\0${branch}`
    let store = this.#stores.get(key)
    if (!store) {
      store = new CanvasCommandStoreV2(branch, { filePath, now: this.#now })
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
