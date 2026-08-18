import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PdfImportService, type PdfParser } from '../pdfImportService.js'
import { RunArtifactStore } from '../runArtifactStorage.js'
import { createDaemonServer } from '../server.js'

test('PDF HTTP import creates a plan, materializes one root, and loads pages lazily', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-server-pdf-')))
  const sources = new RunArtifactStore(root, 'main')
  const location = await sources.prepareRun('pdf-source')
  await writeFile(path.join(location.absoluteFilesRoot, 'paper.pdf'), '%PDF fake', 'utf8')
  const source = (await sources.closeRun('pdf-source')).manifest.entries[0]!
  const parser: PdfParser = {
    inspect: async () => ({ pageCount: 300, metadata: { Title: 'Paper' } }),
    page: async (bytes, pageNumber) => {
      assert.ok(bytes.byteLength > 0)
      return {
        viewport: { width: 612, height: 792, rotation: 0 },
        text: { itemCount: 1, summary: `Page ${pageNumber}` },
        annotations: { count: 0, subtypes: [] },
        previewPng: new Uint8Array([137, 80, 78, 71]),
      }
    },
  }
  const daemon = createDaemonServer({
    projectRoot: root,
    pdfImportService: new PdfImportService(parser),
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
  const createTask = await fetch(`${baseUrl}/canvas/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', baseRevision: 0, mutationId: 'create-pdf-task',
      command: {
        type: 'CreateTask',
        task: {
          id: 'task-pdf', title: 'PDF', goal: 'Import', anchor: { x: 0, y: 0 },
          origin: { kind: 'user' },
        },
      },
    }),
  })
  assert.equal(createTask.status, 200, await createTask.text())
  const importedResponse = await fetch(`${baseUrl}/imports/pdf?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', taskId: 'task-pdf', runId: 'pdf-source',
      artifactId: source.artifactId, title: 'Paper',
    }),
  })
  const imported = await importedResponse.json() as {
    record: { importId: string; initialPlanId: string }
    plan: { planId: string }
  }
  assert.equal(importedResponse.status, 201, JSON.stringify(imported))
  const materialized = await fetch(`${baseUrl}/canvas/commands?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', baseRevision: 1, mutationId: 'materialize-pdf',
      command: { type: 'MaterializeDecompositionPlan', planId: imported.plan.planId },
    }),
  })
  const canvas = await materialized.json() as {
    document: { nodes: Array<{ typeRef: { id: string } }> }
  }
  assert.equal(materialized.status, 200, JSON.stringify(canvas))
  assert.deepEqual(canvas.document.nodes.map((node) => node.typeRef.id), ['pdf-document'])

  const plan = await (await fetch(
    `${baseUrl}/imports/${imported.record.importId}/plan?projectDir=.`,
  )).json() as { record: { pageCount: number }; initialPlan: { nodes: unknown[] } }
  assert.equal(plan.record.pageCount, 300)
  assert.equal(plan.initialPlan.nodes.length, 1)
  const page = await (await fetch(
    `${baseUrl}/imports/${imported.record.importId}/plan?projectDir=.&page=300`,
  )).json() as { page: { pageNumber: number; preview: { artifactId: string } } }
  assert.equal(page.page.pageNumber, 300)
  assert.match(page.page.preview.artifactId, /^artifact_[0-9a-f]{64}$/u)

  const password = await fetch(`${baseUrl}/imports/pdf?projectDir=.`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'main', taskId: 'task-pdf', runId: 'pdf-source',
      artifactId: source.artifactId, title: 'Paper', password: 'must-not-persist',
    }),
  })
  assert.equal(password.status, 400)
})
