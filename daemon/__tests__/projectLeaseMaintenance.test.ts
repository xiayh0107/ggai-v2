import assert from 'node:assert/strict'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ProjectLeaseManager } from '../projectLease.js'
import { ProtocolError } from '../protocol.js'

test('workspace maintenance uses the workspace control lease and releases only its target', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ggai-project-maintenance-'))
  const root = await realpath(temporaryRoot)
  const manager = new ProjectLeaseManager({ projectRoot: root })
  const lockPath = path.join(root, '.gg', 'workspace', 'runtime', 'daemon.lock')

  try {
    assert.equal(await manager.acquire('.'), root)
    const started = deferred()
    const release = deferred()
    const active = manager.withProjectOperation('.', async () => {
      started.resolve()
      await release.promise
    })
    await started.promise
    let maintenanceSettled = false
    const maintenance = manager.beginMaintenance('.').then((projectDir) => {
      maintenanceSettled = true
      return projectDir
    })
    await Promise.resolve()
    assert.equal(maintenanceSettled, false)
    release.resolve()
    await active
    const projectDir = await maintenance
    await assert.rejects(
      manager.acquire('.'),
      (error: unknown) => error instanceof ProtocolError && error.code === 'project_busy',
    )

    await manager.releaseForMaintenance(projectDir)
    await assert.rejects(access(lockPath), { code: 'ENOENT' })
    manager.endMaintenance(projectDir)

    assert.equal(await manager.acquire('.'), root)
    await access(lockPath)
  } finally {
    manager.endMaintenance(root)
    await manager.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
