import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import PptxGenModule from 'pptxgenjs'
import type { CanvasDocument, CanvasNode } from '../src/canvas/model.js'
import {
  type PresentationExportDiagnostic,
  type PresentationExportMode,
  type PresentationExportResponse,
  type PresentationProvenanceManifest,
} from '../src/presentation/contracts.js'
import { parseShapePayload } from '../src/assets/contracts.js'
import { atomicWriteBytes, atomicWriteText } from './atomic-file.js'
import { createBuiltinPayloadSchemaRegistry } from './builtinPayloadSchemas.js'
import { DeclarativeNodeRasterizer } from './assetRasterizer.js'
import { openVerifiedRunArtifactFile, RunArtifactStore } from './runArtifactStorage.js'

const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

interface PptxSlideAdapter {
  background: { color: string }
  addNotes(notes: string): unknown
  addText(text: unknown, options: Record<string, unknown>): unknown
  addImage(options: Record<string, unknown>): unknown
  addShape(shape: string, options: Record<string, unknown>): unknown
  addTable(rows: string[][], options: Record<string, unknown>): unknown
  addChart(type: string, series: unknown[], options: Record<string, unknown>): unknown
}

interface PptxAdapter {
  author: string
  title: string
  subject: string
  company: string
  lang: string
  layout: string
  ShapeType: Record<string, string>
  ChartType: Record<string, string>
  defineLayout(layout: { name: string; width: number; height: number }): void
  addSlide(): PptxSlideAdapter
  write(options: { outputType: 'nodebuffer'; compression: boolean }): Promise<unknown>
}

const PptxConstructor = PptxGenModule as unknown as new () => PptxAdapter

export class PresentationExportError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'PresentationExportError'
    this.code = code
    this.status = status
  }
}

export class PresentationExporter {
  readonly #rasterizer: DeclarativeNodeRasterizer
  readonly #fontResolver: () => Promise<Set<string>>

  constructor(options: {
    rasterizer?: DeclarativeNodeRasterizer
    fontResolver?: () => Promise<Set<string>>
  } = {}) {
    this.#rasterizer = options.rasterizer ?? new DeclarativeNodeRasterizer()
    this.#fontResolver = options.fontResolver ?? systemFontCatalog
  }

  async export(input: {
    projectId: string
    projectDir: string
    canvasBranch: string
    canvasRevision: number
    document: CanvasDocument
    presentationNodeId: string
    mode?: PresentationExportMode
  }): Promise<PresentationExportResponse> {
    const presentation = input.document.nodes.find((node) => node.id === input.presentationNodeId)
    if (!presentation || presentation.typeRef.id !== 'presentation') {
      throw new PresentationExportError('presentation_not_found', 'Presentation node does not exist', 404)
    }
    const payload = presentation.payload ?? {}
    assertPayload('ggai://schema/payload/presentation', payload)
    const mode = input.mode ?? payload.mode as PresentationExportMode
    if (!['hybrid', 'editable', 'fidelity'].includes(mode)) {
      throw new PresentationExportError('invalid_export_mode', 'Presentation export mode is invalid', 400)
    }
    const slides = children(input.document, presentation.id)
      .filter((node) => node.typeRef.id === 'slide')
    if (slides.length === 0) throw new PresentationExportError('presentation_empty', 'Presentation has no slides', 400)
    const widthPt = Number(payload.widthPt)
    const heightPt = Number(payload.heightPt)
    const pptx = new PptxConstructor()
    pptx.author = String(payload.author)
    pptx.title = String(payload.title)
    pptx.subject = 'GGAI Canvas export'
    pptx.company = 'GGAI'
    pptx.lang = 'zh-CN'
    pptx.defineLayout({ name: 'GGAI_CUSTOM', width: widthPt / 72, height: heightPt / 72 })
    pptx.layout = 'GGAI_CUSTOM'
    const diagnostics: PresentationExportDiagnostic[] = []
    const fonts = await this.#fontResolver()
    const involvedNodes = [presentation, ...slides, ...slides.flatMap((slide) =>
      descendants(input.document, slide.id))]

    for (const slideNode of slides) {
      assertPayload('ggai://schema/payload/slide', slideNode.payload ?? {})
      const slide = pptx.addSlide()
      slide.background = { color: color(String(slideNode.payload!.background)) }
      const notes = slideNode.payload?.notes
      if (typeof notes === 'string' && notes.length > 0) slide.addNotes(notes)
      for (const node of children(input.document, slideNode.id)) {
        if (mode === 'fidelity') {
          await addRasterFallback(slide, node, input, this.#rasterizer, diagnostics)
          continue
        }
        const mapped = await addNativeNode({
          pptx, slide, node, input, fonts, diagnostics,
        })
        if (!mapped) {
          if (mode === 'editable') diagnostics.push({
            code: 'unsupported-editable-node',
            nodeId: node.id,
            message: `Node ${node.typeRef.id} has no editable PowerPoint mapping`,
          })
          await addRasterFallback(slide, node, input, this.#rasterizer, diagnostics)
        }
      }
    }

    const raw = await pptx.write({ outputType: 'nodebuffer', compression: true })
    const bytes = raw instanceof Uint8Array
      ? raw
      : typeof raw === 'string'
        ? Buffer.from(raw, 'binary')
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : (() => { throw new Error('PptxGenJS returned an unsupported output type') })()
    const provenance = canonicalProvenance({
      schemaVersion: 1,
      exporter: { id: 'ggai-pptx', version: '1' },
      projectId: input.projectId,
      canvasBranch: input.canvasBranch,
      canvasRevision: input.canvasRevision,
      presentationNodeId: presentation.id,
      mode,
      nodes: involvedNodes.map((node) => ({
        nodeId: node.id,
        typeRef: structuredClone(node.typeRef),
        artifactRefs: structuredClone(node.artifactRefs),
      })),
    })
    const pptxBytes = embedProvenance(bytes, provenance)
    validateOoxmlPackage(pptxBytes)

    const runId = `pptx-export-${randomUUID()}`
    const store = new RunArtifactStore(input.projectDir, input.canvasBranch)
    const location = await store.prepareRun(runId)
    await Promise.all([
      atomicWriteBytes(path.join(location.absoluteFilesRoot, 'presentation.pptx'), pptxBytes),
      atomicWriteText(
        path.join(location.absoluteFilesRoot, 'export-diagnostics.json'),
        `${JSON.stringify({ schemaVersion: 1, mode, diagnostics }, null, 2)}\n`,
      ),
      atomicWriteText(
        path.join(location.absoluteFilesRoot, 'provenance.json'),
        `${JSON.stringify(provenance, null, 2)}\n`,
      ),
    ])
    const closed = await store.closeRun(runId)
    const artifact = (relativePath: string) => {
      const entry = closed.manifest.entries.find((candidate) => candidate.relativePath === relativePath)
      if (!entry) throw new Error(`PPTX export artifact is missing: ${relativePath}`)
      return { runId, artifactId: entry.artifactId }
    }
    const pptxArtifact = closed.manifest.entries.find((entry) => entry.relativePath === 'presentation.pptx')
    if (pptxArtifact?.mediaType !== PPTX_MEDIA_TYPE) {
      throw new Error('PPTX artifact media type is invalid')
    }
    return {
      runId,
      pptx: artifact('presentation.pptx'),
      diagnostics: artifact('export-diagnostics.json'),
      provenance: artifact('provenance.json'),
      diagnosticCount: diagnostics.length,
    }
  }
}

async function addNativeNode(input: {
  pptx: PptxAdapter
  slide: PptxSlideAdapter
  node: CanvasNode
  input: {
    projectDir: string
    canvasBranch: string
    document: CanvasDocument
  }
  fonts: Set<string>
  diagnostics: PresentationExportDiagnostic[]
}): Promise<boolean> {
  const { node, slide, pptx } = input
  const geometry = pptGeometry(node)
  if (node.typeRef.id === 'text') {
    const fontFace = typeof node.payload?.fontFace === 'string' ? node.payload.fontFace : 'Arial'
    if (!hasFont(input.fonts, fontFace)) input.diagnostics.push({
      code: 'missing-font', nodeId: node.id,
      message: `Font is not installed and was retained for PowerPoint diagnostics: ${fontFace}`,
    })
    slide.addText(node.text ?? String(node.payload?.content ?? ''), {
      ...geometry,
      fontFace,
      fontSize: finite(node.payload?.fontSize, 18),
      color: color(String(node.payload?.color ?? '#202124')),
      bold: node.payload?.bold === true,
      italic: node.payload?.italic === true,
      margin: 0,
      breakLine: false,
      fit: 'shrink',
    })
    return true
  }
  if (node.typeRef.id === 'image') {
    const ref = node.artifactRefs[0]
    if (!ref) return false
    const artifact = await new RunArtifactStore(input.input.projectDir, input.input.canvasBranch)
      .lookup(ref.runId, ref.artifactId)
    if (!artifact || !artifact.mediaType.startsWith('image/')) return false
    const handle = await openVerifiedRunArtifactFile(artifact)
    try {
      const bytes = await handle.readFile()
      slide.addImage({
        data: `data:${artifact.mediaType};base64,${bytes.toString('base64')}`,
        ...geometry,
        altText: typeof node.payload?.alt === 'string' ? node.payload.alt : node.title,
      })
    } finally {
      await handle.close()
    }
    return true
  }
  if (node.typeRef.id === 'shape') {
    const shape = parseShapePayload(node.payload)
    slide.addShape(
      shape.kind === 'ellipse' ? pptx.ShapeType.ellipse : pptx.ShapeType.rect,
      {
        ...geometry,
        fill: shape.fill === 'transparent'
          ? { color: 'FFFFFF', transparency: 100 }
          : { color: color(shape.fill) },
        line: shape.stroke === 'transparent'
          ? { color: 'FFFFFF', transparency: 100 }
          : { color: color(shape.stroke), width: shape.strokeWidth },
        radius: shape.cornerRadius / 72,
      },
    )
    return true
  }
  if (node.typeRef.id === 'table') {
    const rows = tableRows(node)
    if (rows.length === 0) return false
    slide.addTable(rows, {
      x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h,
      border: { pt: 1, color: 'D0D2D6' },
      fontFace: 'Arial', fontSize: 12, margin: 0.04,
    })
    return true
  }
  if (node.typeRef.id === 'chart') {
    assertPayload('ggai://schema/payload/chart', node.payload ?? {})
    const series = node.payload!.series as Array<{ name: string; labels: string[]; values: number[] }>
    if (series.length === 0 || series.some((item) => item.labels.length !== item.values.length)) {
      input.diagnostics.push({
        code: 'invalid-native-data', nodeId: node.id,
        message: 'Chart labels and values are empty or have different lengths',
      })
      return false
    }
    const chartType = String(node.payload!.chartType) as 'bar' | 'line' | 'pie' | 'doughnut'
    slide.addChart(pptx.ChartType[chartType], series, {
      ...geometry,
      showTitle: Boolean(node.payload!.title),
      title: String(node.payload!.title),
      showLegend: node.payload!.showLegend === true,
    })
    return true
  }
  return false
}

async function addRasterFallback(
  slide: PptxSlideAdapter,
  node: CanvasNode,
  input: { projectDir: string; canvasBranch: string; document: CanvasDocument },
  rasterizer: DeclarativeNodeRasterizer,
  diagnostics: PresentationExportDiagnostic[],
): Promise<void> {
  const rendered = await rasterizer.renderNode({
    projectDir: input.projectDir,
    canvasBranch: input.canvasBranch,
    document: input.document,
    root: node,
  })
  slide.addImage({
    data: `data:image/png;base64,${rendered.png.toString('base64')}`,
    ...pptGeometry(node),
    altText: node.title,
  })
  diagnostics.push({
    code: 'raster-fallback', nodeId: node.id,
    message: `Node ${node.typeRef.id} was rasterized by the trusted fallback`,
  })
}

function pptGeometry(node: CanvasNode) {
  const [a, b, c, d, e, f] = node.transform.matrix
  const scaleX = Math.hypot(a, b)
  const scaleY = Math.hypot(c, d)
  return {
    x: e / 72,
    y: f / 72,
    w: Math.max(1, node.bounds.w * scaleX) / 72,
    h: Math.max(1, node.bounds.h * scaleY) / 72,
    rotate: Math.atan2(b, a) * 180 / Math.PI,
  }
}

function tableRows(node: CanvasNode): string[][] {
  if (Array.isArray(node.payload?.rows)) {
    return node.payload.rows.slice(0, 200).map((row) =>
      Array.isArray(row) ? row.slice(0, 30).map((cell) => String(cell)) : [String(row)])
  }
  return (node.text ?? '').split(/\r?\n/u).filter(Boolean).slice(0, 200)
    .map((row) => row.split(',').slice(0, 30).map((cell) => cell.trim()))
}

function children(document: CanvasDocument, parentId: string): CanvasNode[] {
  return document.nodes.filter((node) => node.parentId === parentId)
    .sort((left, right) => left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id))
}

function descendants(document: CanvasDocument, rootId: string): CanvasNode[] {
  const result: CanvasNode[] = []
  const queue = [rootId]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    const next = children(document, parentId)
    result.push(...next)
    queue.push(...next.map((node) => node.id))
  }
  return result
}

function canonicalProvenance(value: PresentationProvenanceManifest): PresentationProvenanceManifest {
  return {
    ...structuredClone(value),
    nodes: structuredClone(value.nodes).sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  }
}

export function embedProvenance(
  pptxBytes: Uint8Array,
  manifest: PresentationProvenanceManifest,
): Uint8Array {
  const entries = unzipSync(pptxBytes)
  const relationships = requiredXml(entries, '_rels/.rels')
  const contentTypes = requiredXml(entries, '[Content_Types].xml')
  if (relationships.includes('rIdGgaiProvenance') || entries['customXml/item1.xml']) {
    throw new PresentationExportError('ooxml_provenance_conflict', 'PPTX already contains the GGAI provenance part')
  }
  entries['_rels/.rels'] = strToU8(relationships.replace(
    '</Relationships>',
    '<Relationship Id="rIdGgaiProvenance" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="customXml/item1.xml"/></Relationships>',
  ))
  entries['[Content_Types].xml'] = strToU8(contentTypes.replace(
    '</Types>',
    '<Override PartName="/customXml/item1.xml" ContentType="application/xml"/></Types>',
  ))
  entries['customXml/item1.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ggai:provenance xmlns:ggai="https://ggai.dev/ooxml/provenance/v1"><ggai:json>${xmlEscape(JSON.stringify(manifest))}</ggai:json></ggai:provenance>`,
  )
  return zipSync(entries as Zippable, { level: 6, mtime: new Date(1980, 0, 1) })
}

export function validateOoxmlPackage(bytes: Uint8Array): void {
  const entries = unzipSync(bytes)
  for (const [relationsPath, data] of Object.entries(entries)) {
    if (!relationsPath.endsWith('.rels')) continue
    const xml = strFromU8(data)
    for (const match of xml.matchAll(/Target="([^"]+)"/gu)) {
      const target = match[1]!
      if (/^[a-z]+:/iu.test(target)) continue
      const base = relationsPath === '_rels/.rels'
        ? ''
        : path.posix.dirname(path.posix.dirname(relationsPath))
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(base, target)).replace(/^\//u, '')
      if (!entries[resolved]) {
        throw new PresentationExportError(
          'ooxml_relationship_invalid',
          `OOXML relationship target is missing: ${relationsPath} -> ${target}`,
        )
      }
    }
  }
  if (!entries['ppt/presentation.xml'] || !entries['customXml/item1.xml']) {
    throw new PresentationExportError('ooxml_package_invalid', 'PPTX package is missing required parts')
  }
}

async function systemFontCatalog(): Promise<Set<string>> {
  const fonts = new Set(['Arial', 'Helvetica', 'Times New Roman', 'Courier New'])
  for (const directory of ['/System/Library/Fonts', '/Library/Fonts']) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      fonts.add(path.parse(entry.name).name.replaceAll(/[-_]/gu, ' '))
    }
  }
  return fonts
}

function hasFont(fonts: Set<string>, requested: string): boolean {
  const normalized = requested.toLowerCase().replaceAll(/[-_]/gu, ' ')
  return [...fonts].some((font) => font.toLowerCase().replaceAll(/[-_]/gu, ' ') === normalized)
}

function requiredXml(entries: Record<string, Uint8Array>, name: string): string {
  const value = entries[name]
  if (!value) throw new PresentationExportError('ooxml_package_invalid', `PPTX is missing ${name}`)
  return strFromU8(value)
}

function assertPayload(schemaId: string, value: Record<string, unknown>): void {
  if (!createBuiltinPayloadSchemaRegistry().validate(schemaId, value).valid) {
    throw new PresentationExportError('invalid_presentation_payload', `Payload does not match ${schemaId}`, 400)
  }
}

function color(value: string): string {
  return value.replace(/^#/u, '').toUpperCase()
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
