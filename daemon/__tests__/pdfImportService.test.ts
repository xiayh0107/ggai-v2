import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { applyCanvasCommand } from '../../src/canvas/commands.js'
import { emptyCanvasDocument } from '../../src/canvas/model.js'
import type { GraphProposal } from '../../src/agent/graphProposal.js'
import { MAX_PDF_BYTES } from '../../src/pdf/contracts.js'
import { PdfImportService, PdfJsParser, type PdfParser } from '../pdfImportService.js'
import { RunArtifactStore } from '../runArtifactStorage.js'

test('a 300-page PDF imports as one document node and lazily renders a page baseline', async (t) => {
  const projectDir = await temporaryProject(t)
  const source = await pdfArtifact(projectDir, 'pdf-source', minimalPdf(300))
  const service = new PdfImportService()
  const imported = await service.createImport({
    projectId: 'project-pdf', projectDir, canvasBranch: 'main', taskId: 'task-pdf',
    sourceRunId: 'pdf-source', sourceArtifactId: source.artifactId, title: 'Large PDF',
  })
  assert.equal(imported.record.pageCount, 300)
  assert.equal(imported.plan.nodes.length, 1)
  assert.equal(imported.plan.nodes[0]?.node.typeRef.id, 'pdf-document')
  const document = emptyCanvasDocument()
  document.tasks.push({
    id: 'task-pdf', title: 'PDF', goal: 'Import PDF', anchor: { x: 0, y: 0 },
    origin: { kind: 'user' },
  })
  const materialized = applyCanvasCommand(document, {
    type: 'MaterializeDecompositionPlan', plan: imported.plan,
  })
  assert.equal(materialized.nodes.length, 1)
  assert.equal(materialized.nodes.some((node) => node.typeRef.id === 'pdf-page'), false)
  assert.deepEqual(applyCanvasCommand(materialized, {
    type: 'MaterializeDecompositionPlan', plan: imported.plan,
  }), materialized)

  const page = await service.pageBaseline({
    projectDir, importId: imported.record.importId, pageNumber: 1,
  })
  assert.equal(page.viewport.unit, 'pt')
  assert.equal(page.viewport.width, 612)
  assert.equal(page.annotations.count, 0)
  const preview = await new RunArtifactStore(projectDir, 'main')
    .lookup(page.preview.runId, page.preview.artifactId)
  assert.equal(preview?.mediaType, 'image/png')
  await assert.rejects(service.pageBaseline({
    projectDir, importId: imported.record.importId, pageNumber: 301,
  }), /out of range/u)
})

test('malformed and encrypted PDFs fail closed without persisting a plan', async (t) => {
  const projectDir = await temporaryProject(t)
  const malformed = await pdfArtifact(projectDir, 'pdf-malformed', Buffer.from('%PDF broken'))
  await assert.rejects(new PdfImportService().createImport({
    projectId: 'project-pdf', projectDir, canvasBranch: 'main', taskId: 'task-pdf',
    sourceRunId: 'pdf-malformed', sourceArtifactId: malformed.artifactId, title: 'Bad',
  }), /malformed|invalid|format/u)

  const encrypted = await pdfArtifact(projectDir, 'pdf-encrypted', minimalPdf(1))
  const passwordParser: PdfParser = {
    inspect: async () => {
      const error = new Error('password')
      error.name = 'PasswordException'
      throw error
    },
    page: async () => { throw new Error('unused') },
  }
  await assert.rejects(new PdfImportService(passwordParser).createImport({
    projectId: 'project-pdf', projectDir, canvasBranch: 'main', taskId: 'task-pdf',
    sourceRunId: 'pdf-encrypted', sourceArtifactId: encrypted.artifactId, title: 'Encrypted',
  }), /password/u)
})

test('oversized PDF is rejected before PDF.js receives its bytes', async (t) => {
  const projectDir = await temporaryProject(t)
  const oversized = await pdfArtifact(
    projectDir, 'pdf-oversized', Buffer.alloc(MAX_PDF_BYTES + 1),
  )
  let inspected = false
  const parser: PdfParser = {
    inspect: async () => {
      inspected = true
      return { pageCount: 1, metadata: {} }
    },
    page: async () => { throw new Error('unused') },
  }
  await assert.rejects(new PdfImportService(parser).createImport({
    projectId: 'project-pdf', projectDir, canvasBranch: 'main', taskId: 'task-pdf',
    sourceRunId: 'pdf-oversized', sourceArtifactId: oversized.artifactId, title: 'Oversized',
  }), /too large|exceeds/u)
  assert.equal(inspected, false)
})

test('Agent decomposition verifies source, bbox, parent types, and tool-run artifacts', async (t) => {
  const projectDir = await temporaryProject(t)
  const source = await pdfArtifact(projectDir, 'pdf-source', minimalPdf(2))
  const toolStore = new RunArtifactStore(projectDir, 'main')
  const toolLocation = await toolStore.prepareRun('mineru-run')
  await writeFile(path.join(toolLocation.absoluteFilesRoot, 'figure.png'), 'image bytes', 'utf8')
  const toolArtifact = (await toolStore.closeRun('mineru-run')).manifest.entries[0]!
  const service = new PdfImportService()
  const imported = await service.createImport({
    projectId: 'project-pdf', projectDir, canvasBranch: 'main', taskId: 'task-pdf',
    sourceRunId: 'pdf-source', sourceArtifactId: source.artifactId, title: 'Paper',
  })
  const proposal = decompositionProposal(
    imported.record.sourcePdfDigest,
    toolArtifact.artifactId,
  )
  const plan = await service.createDecomposition({
    projectDir, importId: imported.record.importId, toolRunId: 'mineru-run', proposal,
  })
  assert.equal(plan.kind, 'decomposition')
  assert.deepEqual(plan.nodes.map((entry) => entry.node.typeRef.id), [
    'pdf-page', 'pdf-text-block', 'pdf-image',
  ])
  assert.equal(plan.nodes[2]?.node.artifactRefs[0]?.artifactId, toolArtifact.artifactId)

  const document = emptyCanvasDocument()
  document.tasks.push({
    id: 'task-pdf', title: 'PDF', goal: 'Import', anchor: { x: 0, y: 0 }, origin: { kind: 'user' },
  })
  const withDocument = applyCanvasCommand(document, {
    type: 'MaterializeDecompositionPlan', plan: imported.plan,
  })
  const decomposed = applyCanvasCommand(withDocument, {
    type: 'MaterializeDecompositionPlan', plan,
  })
  assert.equal(decomposed.nodes.length, 4)
  assert.equal(decomposed.nodes.filter((node) => node.parentId === imported.record.documentNodeId).length, 1)
  assert.deepEqual(applyCanvasCommand(decomposed, {
    type: 'MaterializeDecompositionPlan', plan,
  }), decomposed)

  const badBbox = structuredClone(proposal)
  ;(badBbox.nodes[2]!.init.bbox as { x: number }).x = 700
  await assert.rejects(service.createDecomposition({
    projectDir, importId: imported.record.importId, toolRunId: 'mineru-run', proposal: badBbox,
  }), /bbox/u)
  const crossRun = structuredClone(proposal)
  ;(crossRun.nodes[3]!.init.artifactRef as { runId: string }).runId = 'another-run'
  await assert.rejects(service.createDecomposition({
    projectDir, importId: imported.record.importId, toolRunId: 'mineru-run', proposal: crossRun,
  }), /another tool run/u)
})

test('PDF.js parser destroys page/document resources after baseline extraction', async () => {
  const parser = new PdfJsParser()
  const inspected = await parser.inspect(new Uint8Array(minimalPdf(1)))
  assert.equal(inspected.pageCount, 1)
  const page = await parser.page(new Uint8Array(minimalPdf(1)), 1)
  assert.ok(page.previewPng.byteLength > 8)
  await assert.rejects(parser.inspect(new Uint8Array(javascriptPdf())), /JavaScript/u)
})

function decompositionProposal(sourcePdfDigest: string, artifactId: string): GraphProposal {
  return {
    nodes: [
      {
        key: 'document', typeId: 'pdf-document', title: 'Paper',
        init: { sourcePdfDigest },
      },
      {
        key: 'page-1', typeId: 'pdf-page', title: 'Page 1', parentKey: 'document',
        init: { sourcePdfDigest, pageNumber: 1, width: 612, height: 792, rotation: 0 },
      },
      {
        key: 'text-1', typeId: 'pdf-text-block', title: 'Text', parentKey: 'page-1',
        init: { pageNumber: 1, bbox: { x: 10, y: 20, w: 200, h: 40 }, text: 'Hello' },
      },
      {
        key: 'image-1', typeId: 'pdf-image', title: 'Figure', parentKey: 'page-1',
        init: {
          pageNumber: 1,
          bbox: { x: 100, y: 100, w: 200, h: 120 },
          artifactRef: { runId: 'mineru-run', artifactId },
          alt: 'Figure',
        },
      },
    ],
    edges: [],
  }
}

async function temporaryProject(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-pdf-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function pdfArtifact(projectDir: string, runId: string, bytes: Uint8Array) {
  const store = new RunArtifactStore(projectDir, 'main')
  const location = await store.prepareRun(runId)
  await writeFile(path.join(location.absoluteFilesRoot, 'source.pdf'), bytes)
  return (await store.closeRun(runId)).manifest.entries[0]!
}

function minimalPdf(pageCount: number): Buffer {
  const objects: string[] = []
  const contentObject = pageCount + 3
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) =>
    `${index + 3} 0 R`).join(' ')}] /Count ${pageCount} >>`
  for (let index = 0; index < pageCount; index += 1) {
    objects[index + 3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${contentObject} 0 R >>`
  }
  objects[contentObject] = '<< /Length 0 >>\nstream\n\nendstream'
  return serializePdf(objects)
}

function javascriptPdf(): Buffer {
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>'
  objects[4] = '<< /Length 0 >>\nstream\n\nendstream'
  objects[5] = '<< /S /JavaScript /JS (app.alert\\(1\\)) >>'
  return serializePdf(objects)
}

function serializePdf(objects: string[]): Buffer {
  const lastObject = objects.length - 1
  let pdf = '%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n'
  const offsets = [0]
  for (let number = 1; number <= lastObject; number += 1) {
    offsets[number] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${number} 0 obj\n${objects[number]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${lastObject + 1}\n0000000000 65535 f \n`
  for (let number = 1; number <= lastObject; number += 1) {
    pdf += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${lastObject + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
