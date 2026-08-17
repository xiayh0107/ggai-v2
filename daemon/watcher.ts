import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { CanvasAgentEvent } from '../src/agent/types.js'
import {
  isArtifactControlPath,
  isSafeArtifactReference,
} from './artifactPaths.js'

export interface ArtifactWatcher {
  close(): Promise<void>
}

export interface WatchArtifactsOptions {
  projectDir: string
  nodeId: string
  canvasBranch: string
  runId: string
  /** Daemon-authored immutable Run files root. */
  projectRelativeRoot: string
  onEvent: (event: Extract<CanvasAgentEvent, { type: 'file-write' }>) => void
  onError?: (error: Error) => void
}

function posixPath(value: string): string {
  return value.split(path.sep).join('/')
}

/** Start before spawning the Agent so even very fast writes are observed. */
export async function watchArtifacts(options: WatchArtifactsOptions): Promise<ArtifactWatcher> {
  const relativeRoot = options.projectRelativeRoot
  if (!isSafeArtifactReference(relativeRoot)) {
    throw new TypeError('artifact watcher root is not a safe project artifact path')
  }
  const absoluteRoot = path.resolve(options.projectDir, ...relativeRoot.split('/'))
  const watcher: FSWatcher = chokidar.watch(relativeRoot, {
    cwd: options.projectDir,
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    ignorePermissionErrors: true,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 50,
    },
    ignored: (candidatePath) => {
      const absolute = path.isAbsolute(candidatePath)
        ? path.resolve(candidatePath)
        : path.resolve(options.projectDir, candidatePath)
      const relative = path.relative(absoluteRoot, absolute)
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? isArtifactControlPath(relative)
        : false
    },
    atomic: true,
  })

  let closed = false
  let ready = false
  let settleReady: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const readyPromise = new Promise<void>((resolve, reject) => {
    settleReady = resolve
    rejectReady = reject
  })

  const emit = (changedPath: string) => {
    const normalized = posixPath(changedPath)
    const expectedPrefix = `${posixPath(relativeRoot)}/`
    if (!normalized.startsWith(expectedPrefix) || normalized.endsWith('/')) return
    if (isArtifactControlPath(normalized.slice(expectedPrefix.length))) return
    options.onEvent({ type: 'file-write', path: normalized, nodeId: options.nodeId })
  }

  watcher
    .on('add', emit)
    .on('change', emit)
    .on('ready', () => {
      ready = true
      settleReady?.()
    })
    .on('error', (value: unknown) => {
      const error = value instanceof Error ? value : new Error(String(value))
      if (!ready) rejectReady?.(error)
      options.onError?.(error)
    })

  try {
    await readyPromise
  } catch (error) {
    await watcher.close()
    throw error
  }

  return {
    async close() {
      if (closed) return
      closed = true
      await watcher.close()
    },
  }
}
