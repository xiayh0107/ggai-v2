import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDaemonServer } from '../server.js'

test('skill asset HTTP routes import, bind, list, archive, and reject stale writes', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-http-')))
  const source = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-source-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(source, { recursive: true, force: true }))
  await mkdir(path.join(root, '.gg'), { recursive: true })
  await writeFile(path.join(source, 'SKILL.md'), [
    '---',
    'name: Research discipline',
    'description: Verify sources before summarizing.',
    '---',
    '# Research discipline',
    '',
    'Always distinguish evidence from inference.',
    '',
  ].join('\n'))
  const daemon = createDaemonServer({ projectRoot: root })
  t.after(() => daemon.close())
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  const importResponse = await fetch(`${baseUrl}/skill-assets/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourcePath: source,
      skillId: '@workspace/research-discipline',
      expectedRevision: 0,
    }),
  })
  assert.equal(importResponse.status, 200)
  const imported = await importResponse.json() as {
    schemaVersion: number
    asset: { skillId: string; revision: number; digest: string }
  }
  assert.equal(imported.schemaVersion, 1)
  assert.equal(imported.asset.revision, 1)
  await assert.rejects(() => lstat(source), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT')
  const ref = {
    skillId: imported.asset.skillId,
    revision: imported.asset.revision,
    digest: imported.asset.digest,
  }

  const bindingResponse = await fetch(
    `${baseUrl}/skill-bindings/types/${encodeURIComponent('@local/research-card@1')}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, expectedRevision: 0, skills: [ref] }),
    },
  )
  assert.equal(bindingResponse.status, 200)
  const binding = await bindingResponse.json() as { binding: { nodeType: string; revision: number } }
  assert.equal(binding.binding.nodeType, '@local/research-card@1')
  assert.equal(binding.binding.revision, 1)

  const staleResponse = await fetch(
    `${baseUrl}/skill-bindings/types/${encodeURIComponent('@local/research-card@1')}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, expectedRevision: 0, skills: [] }),
    },
  )
  assert.equal(staleResponse.status, 409)
  const stale = await staleResponse.json() as { error: { code: string } }
  assert.equal(stale.error.code, 'skill_asset_conflict')

  const archivedResponse = await fetch(
    `${baseUrl}/skill-assets/${encodeURIComponent(ref.skillId)}`,
    { method: 'DELETE' },
  )
  assert.equal(archivedResponse.status, 200)
  const listed = await (await fetch(`${baseUrl}/skill-assets`)).json() as {
    assets: Array<{ archived: boolean }>
    typeBindings: Array<{ skills: unknown[] }>
  }
  assert.equal(listed.assets[0]?.archived, true)
  assert.equal(listed.typeBindings[0]?.skills.length, 1)

  const widenedResponse = await fetch(`${baseUrl}/skill-assets/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourcePath: source,
      skillId: '@workspace/research-discipline',
      expectedRevision: 1,
      hiddenAuthority: true,
    }),
  })
  assert.equal(widenedResponse.status, 400)
})
