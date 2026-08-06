import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { CanvasCommandStoreV2Manager } from '../canvasCommandStoreV2Manager.js'

const execFileAsync = promisify(execFile)

test('the reset script initializes a snapshot accepted by the V2 command store', async () => {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-reset-load-v2-')))
  const manager = new CanvasCommandStoreV2Manager({
    projectRoot: projectDir,
    acquireProjectLease: async (requested) => realpath(
      path.isAbsolute(requested) ? requested : path.resolve(projectDir, requested),
    ),
  })
  try {
    await writeFile(
      path.join(projectDir, 'package.json'),
      `${JSON.stringify({ name: 'reset-load-fixture', private: true })}\n`,
      'utf8',
    )
    await execFileAsync('git', ['init', '--quiet'], { cwd: projectDir })
    await execFileAsync('git', ['add', 'package.json'], { cwd: projectDir })
    await execFileAsync(
      process.execPath,
      [
        path.resolve('scripts/reset-canvas-v2.mjs'),
        '--project-root',
        projectDir,
        '--apply',
      ],
      { cwd: path.resolve('.') },
    )

    const envelope = await manager.get(projectDir, 'main')
    assert.equal(envelope.revision, 0)
    assert.equal(envelope.lastCheckpoint, null)
    assert.deepEqual(envelope.document, {
      schemaVersion: 2,
      nodes: [],
      tasks: [],
      collections: [],
      edges: [],
      receipts: [],
      everCreated: false,
    })
  } finally {
    manager.close()
    await rm(projectDir, { recursive: true, force: true })
  }
})
