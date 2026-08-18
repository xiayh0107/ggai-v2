import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBlankNodeStudioDefinition } from '../../src/node-studio/model.js'
import { createDaemonServer } from '../server.js'

test('node definition HTTP routes persist immutable revisions and reject stale writes', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-definitions-http-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  const daemon = createDaemonServer({ projectRoot: root })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  const draft = { ...createBlankNodeStudioDefinition(), id: '@local/research-card' }

  const firstResponse = await fetch(`${baseUrl}/node-definitions/${encodeURIComponent(draft.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json() as { definition: typeof draft }
  assert.equal(first.definition.revision, 1)

  const staleResponse = await fetch(`${baseUrl}/node-definitions/${encodeURIComponent(draft.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  assert.equal(staleResponse.status, 409)

  const listed = await (await fetch(`${baseUrl}/node-definitions`)).json() as {
    schemaVersion: number
    definitions: Array<{ id: string; revision: number }>
  }
  assert.equal(listed.schemaVersion, 1)
  assert.deepEqual(listed.definitions.map(({ id, revision }) => ({ id, revision })), [{
    id: draft.id,
    revision: 1,
  }])
})
