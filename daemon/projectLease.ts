import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { isNodeError } from './atomic-file.js'
import {
  canonicalizePotentialPath,
  createProjectScope,
  isPathWithin,
  type ProjectScope,
} from './permissions.js'
import { ProtocolError } from './protocol.js'

const PROJECT_MAINTENANCE_LOCK_RELATIVE = '.gg/canvas-maintenance.lock'
const PROJECT_DAEMON_LEASE_RELATIVE = '.gg/runtime/canvas-daemon.lock'
const PROJECT_DAEMON_LEASE_RECOVERY_RELATIVE = '.gg/runtime/canvas-daemon.recovery'
const WORKSPACE_MAINTENANCE_LOCK_RELATIVE = '.gg/workspace/runtime/maintenance.lock'
const WORKSPACE_DAEMON_LEASE_RELATIVE = '.gg/workspace/runtime/daemon.lock'
const WORKSPACE_DAEMON_LEASE_RECOVERY_RELATIVE = '.gg/workspace/runtime/daemon.recovery'
const LEASE_RECOVERY_RETRY_MS = 10
const LEASE_RECOVERY_ATTEMPTS = 100

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
  readonly #maintenanceProjects = new Set<string>()
  readonly #activeProjectOperations = new Map<string, number>()
  readonly #projectIdleWaiters = new Map<string, Set<() => void>>()
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
    if (this.#maintenanceProjects.has(scope.projectDir)) {
      throw new ProtocolError(
        'workspace project is being deleted',
        'project_busy',
        409,
      )
    }
    await assertManagedPath(scope, daemonLeaseRelative(scope))
    await this.#projectLease(scope)
    this.#assertOpen()
    if (this.#maintenanceProjects.has(scope.projectDir)) {
      throw new ProtocolError(
        'workspace project is being deleted',
        'project_busy',
        409,
      )
    }
    return scope.projectDir
  }

  /**
   * Fences new project-scoped work while an existing project's stores drain.
   * The caller must pair this with endMaintenance, including on failure.
   */
  async beginMaintenance(projectDir: string): Promise<string> {
    this.#assertOpen()
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir,
    })
    if (this.#maintenanceProjects.has(scope.projectDir)) {
      throw new ProtocolError('workspace project is busy', 'project_busy', 409)
    }
    this.#maintenanceProjects.add(scope.projectDir)
    try {
      await assertManagedPath(scope, daemonLeaseRelative(scope))
      await this.#projectLease(scope)
      await this.#waitForProjectIdle(scope.projectDir)
      this.#assertOpen()
      return scope.projectDir
    } catch (error) {
      this.#maintenanceProjects.delete(scope.projectDir)
      throw error
    }
  }

  /** Releases this daemon's child-project lease while maintenance remains fenced. */
  async releaseForMaintenance(projectDir: string): Promise<void> {
    const canonicalProjectDir = path.resolve(projectDir)
    if (!this.#maintenanceProjects.has(canonicalProjectDir)) {
      throw new TypeError('project maintenance must be active before releasing its lease')
    }
    const lease = this.#leases.get(canonicalProjectDir)
    if (!lease) return
    this.#leases.delete(canonicalProjectDir)
    await releaseProjectLease(await lease)
  }

  endMaintenance(projectDir: string): void {
    this.#maintenanceProjects.delete(path.resolve(projectDir))
  }

  /** Tracks a direct project-scoped operation that is not owned by a cached store. */
  async withProjectOperation<T>(
    projectDir: string,
    operation: (canonicalProjectDir: string) => Promise<T>,
  ): Promise<T> {
    const canonicalProjectDir = await this.acquire(projectDir)
    if (this.#maintenanceProjects.has(canonicalProjectDir)) {
      throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
    }
    this.#activeProjectOperations.set(
      canonicalProjectDir,
      (this.#activeProjectOperations.get(canonicalProjectDir) ?? 0) + 1,
    )
    try {
      if (this.#maintenanceProjects.has(canonicalProjectDir)) {
        throw new ProtocolError('workspace project is being deleted', 'project_busy', 409)
      }
      return await operation(canonicalProjectDir)
    } finally {
      const remaining = (this.#activeProjectOperations.get(canonicalProjectDir) ?? 1) - 1
      if (remaining <= 0) {
        this.#activeProjectOperations.delete(canonicalProjectDir)
        const waiters = this.#projectIdleWaiters.get(canonicalProjectDir)
        this.#projectIdleWaiters.delete(canonicalProjectDir)
        for (const resolve of waiters ?? []) resolve()
      } else {
        this.#activeProjectOperations.set(canonicalProjectDir, remaining)
      }
    }
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
      const leaseRelative = daemonLeaseRelative(scope)
      const filePath = path.resolve(scope.projectDir, leaseRelative)
      lease = assertManagedPath(scope, leaseRelative)
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

  #waitForProjectIdle(projectDir: string): Promise<void> {
    if ((this.#activeProjectOperations.get(projectDir) ?? 0) === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let waiters = this.#projectIdleWaiters.get(projectDir)
      if (!waiters) {
        waiters = new Set()
        this.#projectIdleWaiters.set(projectDir, waiters)
      }
      waiters.add(resolve)
    })
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
  for (let attempt = 0; attempt < LEASE_RECOVERY_ATTEMPTS; attempt += 1) {
    if (await leaseRecoveryActive(scope)) {
      await delay(LEASE_RECOVERY_RETRY_MS)
      continue
    }
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
        await assertNoLeaseRecovery(scope)
        await assertNoCanvasMaintenance(scope)
      } catch (error) {
        const linkedOwner = await readLeaseOwner(filePath)
        if (linkedOwner?.token === token) await rm(filePath, { force: true })
        await syncDirectory(directory)
        if (error instanceof ProtocolError && error.code === 'daemon_lease_recovery_active') {
          await delay(LEASE_RECOVERY_RETRY_MS)
          continue
        }
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
      if (await recoverStaleProjectLease(filePath, scope)) continue
      await delay(LEASE_RECOVERY_RETRY_MS)
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      await syncDirectory(directory).catch(() => undefined)
    }
  }
  throw new ProtocolError('could not acquire the canvas daemon lease', 'daemon_instance_active', 409)
}

/** Serializes stale-lock cleanup so a competing daemon can never remove a new owner's lease. */
async function recoverStaleProjectLease(
  filePath: string,
  scope: ProjectScope,
): Promise<boolean> {
  const recoveryRelative = daemonLeaseRecoveryRelative(scope)
  const recoveryPath = path.resolve(scope.projectDir, recoveryRelative)
  await assertManagedPath(scope, recoveryRelative)
  try {
    await mkdir(recoveryPath, { mode: 0o700 })
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return false
    throw error
  }

  try {
    const owner = await readLeaseOwner(filePath)
    if (owner && processIsAlive(owner.pid)) return false
    await rm(filePath, { force: true })
    await syncDirectory(path.dirname(filePath))
    return true
  } finally {
    await rm(recoveryPath, { recursive: true, force: true })
    await syncDirectory(path.dirname(recoveryPath)).catch(() => undefined)
  }
}

async function assertNoLeaseRecovery(scope: ProjectScope): Promise<void> {
  if (await leaseRecoveryActive(scope)) {
    throw new ProtocolError('daemon lease recovery is active', 'daemon_lease_recovery_active', 409)
  }
}

async function leaseRecoveryActive(scope: ProjectScope): Promise<boolean> {
  const recoveryRelative = daemonLeaseRecoveryRelative(scope)
  await assertManagedPath(scope, recoveryRelative)
  return pathExistsNoFollow(path.resolve(scope.projectDir, recoveryRelative))
}

async function assertNoCanvasMaintenance(scope: ProjectScope): Promise<void> {
  const maintenanceRelative = maintenanceLockRelative(scope)
  await assertManagedPath(scope, maintenanceRelative)
  const filePath = path.resolve(scope.projectDir, maintenanceRelative)
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

function isWorkspaceScope(scope: ProjectScope): boolean {
  return scope.projectDir === scope.projectRoot
}

function daemonLeaseRelative(scope: ProjectScope): string {
  return isWorkspaceScope(scope)
    ? WORKSPACE_DAEMON_LEASE_RELATIVE
    : PROJECT_DAEMON_LEASE_RELATIVE
}

function daemonLeaseRecoveryRelative(scope: ProjectScope): string {
  return isWorkspaceScope(scope)
    ? WORKSPACE_DAEMON_LEASE_RECOVERY_RELATIVE
    : PROJECT_DAEMON_LEASE_RECOVERY_RELATIVE
}

function maintenanceLockRelative(scope: ProjectScope): string {
  return isWorkspaceScope(scope)
    ? WORKSPACE_MAINTENANCE_LOCK_RELATIVE
    : PROJECT_MAINTENANCE_LOCK_RELATIVE
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
