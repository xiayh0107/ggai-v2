import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canvasNodeGeometry, canvasNodeTypeRef } from '../../src/canvas/model.js'
import { PresentationExporter } from '../presentationExporter.js'
import { RunArtifactStore } from '../runArtifactStorage.js'
import { createDaemonServer } from '../server.js'

test('PPTX HTTP export derives everything from Canvas identity and returns immutable artifacts', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-server-pptx-')))
  const daemon = createDaemonServer({
    projectRoot: root,
    presentationExporter: new PresentationExporter({ fontResolver: async () => new Set(['Arial']) }),
  })
  t.after(async () => {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`
  const command = async (
    baseRevision: number,
    mutationId: string,
    canvasCommand: Record<string, unknown>,
  ) => {
    const response = await fetch(`${baseUrl}/canvas/commands?projectDir=.`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'main', baseRevision, mutationId,
        command: canvasCommand,
      }),
    })
    assert.equal(response.status, 200, await response.text())
  }
  const commit = (baseRevision: number, mutationId: string, node: Record<string, unknown>) =>
    command(baseRevision, mutationId, { type: 'CreateNode', node })
  const presentation = {
    id: 'presentation', typeRef: canvasNodeTypeRef('presentation'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 560, h: 320, z: 1 }),
    title: 'Deck',
    payload: { title: 'Deck', author: '', widthPt: 960, heightPt: 540, mode: 'hybrid' },
    artifactRefs: [], origin: { kind: 'user' },
  }
  await commit(0, 'create-presentation', presentation)
  const slide = {
    id: 'slide', typeRef: canvasNodeTypeRef('slide'),
    ...canvasNodeGeometry({ x: 0, y: 0, w: 960, h: 540, z: 1 }),
    coordinateSpace: { unit: 'pt' }, title: 'Slide',
    payload: { background: '#ffffff', notes: 'HTTP note' },
    artifactRefs: [], origin: { kind: 'user' },
  }
  await commit(1, 'create-slide', slide)
  await command(2, 'reparent-slide', {
    type: 'ReparentNodes', nodeIds: ['slide'], parentId: 'presentation',
  })
  const text = {
    id: 'text', typeRef: canvasNodeTypeRef('text'),
    ...canvasNodeGeometry({ x: 48, y: 48, w: 400, h: 80, z: 1 }),
    title: 'Title', text: 'Exported through API',
    payload: { content: 'Exported through API' },
    artifactRefs: [], origin: { kind: 'user' },
  }
  await commit(3, 'create-text', text)
  await command(4, 'reparent-text', {
    type: 'ReparentNodes', nodeIds: ['text'], parentId: 'slide',
  })

  const response = await fetch(`${baseUrl}/exports/pptx?projectDir=.&branch=main`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presentationNodeId: 'presentation', mode: 'hybrid' }),
  })
  const body = await response.json() as {
    export: {
      runId: string
      pptx: { runId: string; artifactId: string }
      diagnostics: { runId: string; artifactId: string }
      provenance: { runId: string; artifactId: string }
    }
  }
  assert.equal(response.status, 201, JSON.stringify(body))
  const store = new RunArtifactStore(root, 'main')
  const pptx = await store.lookup(body.export.pptx.runId, body.export.pptx.artifactId)
  assert.equal(pptx?.relativePath, 'presentation.pptx')
  assert.ok(await store.lookup(
    body.export.diagnostics.runId, body.export.diagnostics.artifactId,
  ))
  assert.ok(await store.lookup(
    body.export.provenance.runId, body.export.provenance.artifactId,
  ))

  const forged = await fetch(`${baseUrl}/exports/pptx?projectDir=.&branch=main`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      presentationNodeId: 'presentation', mode: 'hybrid', url: 'https://example.invalid/file',
    }),
  })
  assert.equal(forged.status, 400)
})
