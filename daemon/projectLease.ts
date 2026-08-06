import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'

import { isNodeError } from './atomic-file.js'
import {
  canonicalizePotentialPath,
  createProjectScope,
  isPathWithin,
  type ProjectScope,
} from './permissions.js'
import { ProtocolError } from './protocol.js'

const CANVAS_MAINTENANCE_LOCK_RELATIVE = '.gg/canvas-maintenance.lock'
const DAEMON_LEASE_RELATIVE = '.gg/runtime/canvas-daemon.lock'

export interface ProjectLeaseManagerOptions {
  projectRoot: string
}

interface ProjectLease {
  filePath: string
  token: string
  scope: ProjectScope
}

/** Owns the one-writer daemon lease without exposing any Canvas persistence API. */
export class ProjectLeaseManager {
  readonly #projectRoot: string
  readonly #leases = new Map<string, Promise<ProjectLease>>()
  #closing = false
  #closePromise: Promise<void> | null = null

  constructor(options: ProjectLeaseManagerOptions) {
    this.#projectRoot = path.resolve(options.projectRoot)
  }

  async acquire(projectDir: string): Promise<string> {
    this.#assertOpen()
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir,
    })
    await assertManagedPath(scope, DAEMON_LEASE_RELATIVE)
    await this.#projectLease(scope)
    this.#assertOpen()
    return scope.projectDir
  }

  close(): Promise<void> {
    this.#closing = true
    this.#closePromise ??= (async () => {
      const leases = await Promise.allSettled(this.#leases.values())
      await Promise.allSettled(leases.flatMap((entry) =>
        entry.status === 'fulfilled' ? [releaseProjectLease(entry.value)] : []))
    })()
    return this.#closePromise
  }

  #projectLease(scope: ProjectScope): Promise<ProjectLease> {
    this.#assertOpen()
    let lease = this.#leases.get(scope.projectDir)
    if (!lease) {
      const filePath = path.resolve(scope.projectDir, DAEMON_LEASE_RELATIVE)
      lease = assertManagedPath(scope, DAEMON_LEASE_RELATIVE)
        .then(() => acquireProjectLease(filePath, scope))
        .then(async (acquired) => {
          if (this.#closing) {
            await releaseProjectLease(acquired)
            throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
          }
          return acquired
        })
        .catch((error: unknown) => {
          this.#leases.delete(scope.projectDir)
          throw error
        })
      this.#leases.set(scope.projectDir, lease)
    }
    return lease
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
  }
}

async function acquireProjectLease(filePath: string, scope: ProjectScope): Promise<ProjectLease> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertManagedPath(scope, path.relative(scope.projectDir, filePath))
  await assertNoCanvasMaintenance(scope)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID()
    const temporary = `${filePath}.tmp-${process.pid}-${token}`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await link(temporary, filePath)
      try {
        await assertNoCanvasMaintenance(scope)
      } catch (error) {
        const linkedOwner = await readLeaseOwner(filePath)
        if (linkedOwner?.token === token) await rm(filePath, { force: true })
        await syncDirectory(directory)
        throw error
      }
      await syncDirectory(directory)
      return { filePath, token, scope }
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      const owner = await readLeaseOwner(filePath)
      if (owner && processIsAlive(owner.pid)) {
        throw new ProtocolError(
          `another daemon process (${owner.pid}) already owns this project`,
          'daemon_instance_active',
          409,
        )
      }
      if (!await pathExistsNoFollow(filePath)) continue
      throw new ProtocolError(
        'stale daemon lease requires explicit removal: .gg/runtime/canvas-daemon.lock',
        'daemon_lease_stale',
        409,
      )
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      await syncDirectory(directory).catch(() => undefined)
    }
  }
  throw new ProtocolError('could not acquire the canvas daemon lease', 'daemon_instance_active', 409)
}

async function assertNoCanvasMaintenance(scope: ProjectScope): Promise<void> {
  await assertManagedPath(scope, CANVAS_MAINTENANCE_LOCK_RELATIVE)
  const filePath = path.resolve(scope.projectDir, CANVAS_MAINTENANCE_LOCK_RELATIVE)
  if (!await pathExistsNoFollow(filePath)) return
  const owner = await readLeaseOwner(filePath)
  const pid = owner?.pid
  const active = pid !== undefined && processIsAlive(pid)
  throw new ProtocolError(
    active
      ? `canvas maintenance is active in process ${pid}`
      : 'stale canvas maintenance lock requires operator inspection',
    active ? 'canvas_maintenance_active' : 'canvas_maintenance_stale',
    409,
  )
}

async function releaseProjectLease(lease: ProjectLease): Promise<void> {
  const relative = path.relative(lease.scope.projectDir, lease.filePath)
  try {
    await assertManagedPath(lease.scope, relative)
    const owner = await readLeaseOwner(lease.filePath)
    if (owner?.token === lease.token) {
      await rm(lease.filePath, { force: true })
      await syncDirectory(path.dirname(lease.filePath))
    }
  } catch {
    // Never follow a replaced managed path during shutdown merely to clean a lock.
  }
}

async function readLeaseOwner(filePath: string): Promise<{ pid: number; token: string } | null> {
  try {
    const value: unknown = JSON.parse(await readTextNoFollow(filePath))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    return Number.isSafeInteger(record.pid)
      && (record.pid as number) > 0
      && typeof record.token === 'string'
      ? { pid: record.pid as number, token: record.token }
      : null
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNodeError(error, 'ESRCH')
  }
}

async function assertManagedPath(scope: ProjectScope, relativePath: string): Promise<void> {
  const lexicalTarget = path.resolve(scope.projectDir, relativePath)
  const canonicalGgDir = await canonicalizePotentialPath(scope.ggDir)
  const canonicalTarget = await canonicalizePotentialPath(lexicalTarget)
  if (
    canonicalGgDir !== scope.ggDir
    || canonicalTarget !== lexicalTarget
    || !isPathWithin(scope.ggDir, lexicalTarget)
    || !isPathWithin(canonicalGgDir, canonicalTarget)
  ) {
    throw new ProtocolError(
      `unsafe managed path ${relativePath}: path escapes the project .gg directory`,
      'unsafe_managed_path',
      403,
    )
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

async function pathExistsNoFollow(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (
      !isNodeError(error, 'EINVAL')
      && !isNodeError(error, 'ENOTSUP')
      && !isNodeError(error, 'EISDIR')
      && !isNodeError(error, 'EBADF')
    ) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
