import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import sharp from 'sharp'
import test, { type TestContext } from 'node:test'
import {
  canvasNodeGeometry,
  canvasNodeTypeRef,
  emptyCanvasDocument,
  type CanvasNode,
} from '../../src/canvas/model.js'
import { PresentationExporter, validateOoxmlPackage } from '../presentationExporter.js'
import { RunArtifactStore } from '../runArtifactStorage.js'

test('PPTX export keeps native objects editable and embeds notes plus canonical provenance', async (t) => {
  const projectDir = await temporaryProject(t)
  const imageRef = await imageArtifact(projectDir)
  const document = presentationDocument(imageRef)
  const exporter = new PresentationExporter({
    fontResolver: async () => new Set(['Arial']),
  })
  const result = await exporter.export({
    projectId: 'project-pptx', projectDir, canvasBranch: 'main', canvasRevision: 7,
    document, presentationNodeId: 'presentation', mode: 'hybrid',
  })
  assert.ok(result.diagnosticCount >= 2)
  const store = new RunArtifactStore(projectDir, 'main')
  const pptx = await store.lookup(result.pptx.runId, result.pptx.artifactId)
  assert.equal(
    pptx?.mediaType,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  )
  const bytes = await readFile(pptx!.absolutePath)
  validateOoxmlPackage(bytes)
  const entries = unzipSync(bytes)
  const slideXml = strFromU8(entries['ppt/slides/slide1.xml']!)
  assert.match(slideXml, /Editable title/u)
  assert.match(slideXml, /<a:tbl>/u)
  assert.ok(Object.keys(entries).some((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name)))
  assert.ok(Object.keys(entries).some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name)))
  const notes = Object.entries(entries)
    .filter(([name]) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name))
    .map(([, value]) => strFromU8(value)).join('\n')
  assert.match(notes, /Speaker note/u)
  const custom = strFromU8(entries['customXml/item1.xml']!)
  assert.match(custom, /ggai:provenance/u)
  assert.match(custom, /presentationNodeId/u)
  assert.match(strFromU8(entries['_rels/.rels']!), /rIdGgaiProvenance/u)
  assert.match(strFromU8(entries['[Content_Types].xml']!), /\/customXml\/item1.xml/u)

  const diagnosticsLookup = await store.lookup(
    result.diagnostics.runId, result.diagnostics.artifactId,
  )
  const diagnostics = JSON.parse(await readFile(diagnosticsLookup!.absolutePath, 'utf8')) as {
    diagnostics: Array<{ code: string; nodeId?: string }>
  }
  assert.ok(diagnostics.diagnostics.some((item) =>
    item.code === 'missing-font' && item.nodeId === 'text'))
  assert.ok(diagnostics.diagnostics.some((item) =>
    item.code === 'raster-fallback' && item.nodeId === 'unknown'))

  const provenanceLookup = await store.lookup(
    result.provenance.runId, result.provenance.artifactId,
  )
  const provenance = JSON.parse(await readFile(provenanceLookup!.absolutePath, 'utf8')) as {
    mode: string
    canvasRevision: number
    nodes: Array<{ nodeId: string }>
  }
  assert.equal(provenance.mode, 'hybrid')
  assert.equal(provenance.canvasRevision, 7)
  assert.deepEqual(provenance.nodes.map((node) => node.nodeId),
    [...provenance.nodes.map((node) => node.nodeId)].sort())
})

test('editable and fidelity modes diagnose unsupported and rasterized content explicitly', async (t) => {
  const projectDir = await temporaryProject(t)
  const imageRef = await imageArtifact(projectDir)
  const document = presentationDocument(imageRef)
  const exporter = new PresentationExporter({ fontResolver: async () => new Set(['Arial']) })
  const editable = await exporter.export({
    projectId: 'project-pptx', projectDir, canvasBranch: 'main', canvasRevision: 1,
    document, presentationNodeId: 'presentation', mode: 'editable',
  })
  const fidelity = await exporter.export({
    projectId: 'project-pptx', projectDir, canvasBranch: 'main', canvasRevision: 1,
    document, presentationNodeId: 'presentation', mode: 'fidelity',
  })
  assert.ok(editable.diagnosticCount >= 3)
  assert.ok(fidelity.diagnosticCount >= 6)
})

function presentationDocument(imageRef: { runId: string; artifactId: string }) {
  const document = emptyCanvasDocument()
  const presentation = node('presentation', 'presentation', null, 0, 0, 960, 540, {
    title: 'Deck', author: 'GGAI', widthPt: 960, heightPt: 540, mode: 'hybrid',
  })
  const slide = node('slide', 'slide', presentation.id, 0, 0, 960, 540, {
    background: '#ffffff', notes: 'Speaker note for the presenter.',
  })
  slide.coordinateSpace = { unit: 'pt' }
  const text = node('text', 'text', slide.id, 48, 36, 360, 54, {
    content: 'Editable title', fontFace: 'Ghost Font', fontSize: 28, color: '#202124',
  })
  text.text = 'Editable title'
  const image = node('image', 'image', slide.id, 48, 120, 180, 120, { alt: 'Native image' })
  image.artifactRefs = [imageRef]
  const shape = node('shape', 'shape', slide.id, 260, 120, 140, 90, {
    kind: 'rectangle', fill: '#d9e5ff', stroke: '#3355aa', strokeWidth: 1, cornerRadius: 8,
  })
  const table = node('table', 'table', slide.id, 48, 280, 300, 120, {
    rows: [['Name', 'Value'], ['A', '10'], ['B', '20']],
  })
  const chart = node('chart', 'chart', slide.id, 380, 250, 360, 220, {
    chartType: 'bar', title: 'Editable chart', showLegend: true,
    series: [{ name: 'Value', labels: ['A', 'B'], values: [10, 20] }],
  })
  const unknown = node('unknown', '@custom/unknown', slide.id, 760, 40, 160, 100, {
    content: 'Raster fallback', externalUrl: 'https://example.invalid/must-not-fetch',
  })
  document.nodes.push(presentation, slide, text, image, shape, table, chart, unknown)
  return document
}

function node(
  id: string,
  type: string,
  parentId: string | null,
  x: number,
  y: number,
  w: number,
  h: number,
  payload: Record<string, unknown>,
): CanvasNode {
  const node = {
    id,
    typeRef: canvasNodeTypeRef(type),
    ...canvasNodeGeometry({ x, y, w, h, z: 1 }),
    title: id,
    payload,
    artifactRefs: [],
    origin: { kind: 'user' as const },
  }
  node.parentId = parentId
  return node
}

async function temporaryProject(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-pptx-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function imageArtifact(projectDir: string) {
  const store = new RunArtifactStore(projectDir, 'main')
  const location = await store.prepareRun('image-source')
  await writeFile(
    path.join(location.absoluteFilesRoot, 'image.png'),
    await sharp({ create: { width: 32, height: 24, channels: 4, background: '#ff0000' } })
      .png().toBuffer(),
  )
  const entry = (await store.closeRun('image-source')).manifest.entries[0]!
  return { runId: 'image-source', artifactId: entry.artifactId }
}
