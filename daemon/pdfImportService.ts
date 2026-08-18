import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import {
  AnnotationMode,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { GraphProposal } from '../src/agent/graphProposal.js'
import { canvasOrderKey, type CanvasNode } from '../src/canvas/model.js'
import {
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  PDF_PLAN_SCHEMA_VERSION,
  type PdfImportRecord,
  type PdfMaterializationPlan,
  type PdfPageBaseline,
} from '../src/pdf/contracts.js'
import { atomicWriteBytes, readExactFileBytes } from './atomic-file.js'
import { createBuiltinPayloadSchemaRegistry } from './builtinPayloadSchemas.js'
import { builtinNodeTypeSnapshots } from './nodeTypeSnapshots.js'
import { PdfImportStore } from './pdfImportStore.js'
import { openVerifiedRunArtifactFile, RunArtifactStore } from './runArtifactStorage.js'

const MAX_PAGE_PREVIEW_DIMENSION = 1_600
const MAX_PAGE_TEXT_SUMMARY = 16_000

export class PdfImportError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'PdfImportError'
    this.code = code
    this.status = status
  }
}

export interface PdfParser {
  inspect(bytes: Uint8Array): Promise<{
    pageCount: number
    metadata: Record<string, string | null>
  }>
  page(bytes: Uint8Array, pageNumber: number): Promise<{
    viewport: { width: number; height: number; rotation: number }
    text: { itemCount: number; summary: string }
    annotations: { count: number; subtypes: string[] }
    previewPng: Uint8Array
  }>
}

export class PdfJsParser implements PdfParser {
  inspect(bytes: Uint8Array) {
    return withPdfDocument(bytes, async (document) => {
      assertPageCount(document.numPages)
      const actions = await document.getJSActions()
      if (actions && Object.keys(actions).length > 0) {
        throw new PdfImportError('pdf_javascript_denied', 'PDF JavaScript actions are not allowed', 400)
      }
      const metadata = await document.getMetadata()
      return {
        pageCount: document.numPages,
        metadata: normalizePdfMetadata(metadata.info),
      }
    })
  }

  page(bytes: Uint8Array, pageNumber: number) {
    return withPdfDocument(bytes, async (document) => {
      assertPageCount(document.numPages)
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
        throw new PdfImportError('pdf_page_out_of_range', 'PDF page number is out of range', 400)
      }
      const page = await document.getPage(pageNumber)
      try {
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.min(
          2,
          MAX_PAGE_PREVIEW_DIMENSION / Math.max(baseViewport.width, baseViewport.height),
        )
        const viewport = page.getViewport({ scale: Math.max(0.25, scale) })
        const canvas = createCanvas(
          Math.max(1, Math.ceil(viewport.width)),
          Math.max(1, Math.ceil(viewport.height)),
        )
        const [textContent, annotations] = await Promise.all([
          page.getTextContent({ disableNormalization: false }),
          page.getAnnotations({ intent: 'display' }),
        ])
        await page.render({
          canvas: null,
          canvasContext: canvas.getContext('2d') as never,
          viewport,
          annotationMode: AnnotationMode.DISABLE,
        }).promise
        const strings = textContent.items.flatMap((item) =>
          'str' in item && typeof item.str === 'string' ? [item.str] : [])
        return {
          viewport: {
            width: baseViewport.width,
            height: baseViewport.height,
            rotation: baseViewport.rotation,
          },
          text: {
            itemCount: strings.length,
            summary: strings.join(' ').replaceAll(/\s+/gu, ' ').trim().slice(0, MAX_PAGE_TEXT_SUMMARY),
          },
          annotations: {
            count: annotations.length,
            subtypes: [...new Set(annotations.flatMap((annotation) =>
              typeof annotation.subtype === 'string' ? [annotation.subtype] : []))].sort(),
          },
          previewPng: canvas.toBuffer('image/png'),
        }
      } finally {
        page.cleanup()
      }
    })
  }
}

export class PdfImportService {
  readonly #parser: PdfParser
  readonly #stores = new Map<string, PdfImportStore>()

  constructor(parser: PdfParser = new PdfJsParser()) {
    this.#parser = parser
  }

  async createImport(input: {
    projectId: string
    projectDir: string
    canvasBranch: string
    taskId: string
    sourceRunId: string
    sourceArtifactId: string
    title: string
  }): Promise<{ record: PdfImportRecord; plan: PdfMaterializationPlan }> {
    if (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 240) {
      throw new PdfImportError('invalid_pdf_title', 'PDF title is invalid', 400)
    }
    const artifact = await new RunArtifactStore(input.projectDir, input.canvasBranch)
      .lookup(input.sourceRunId, input.sourceArtifactId)
    if (!artifact || artifact.mediaType !== 'application/pdf') {
      throw new PdfImportError('pdf_artifact_not_found', 'Verified PDF artifact does not exist', 404)
    }
    const bytes = await readPdfArtifact(artifact)
    let inspected
    try {
      inspected = await this.#parser.inspect(new Uint8Array(bytes))
    } catch (error) {
      throw classifyPdfError(error)
    }
    assertPageCount(inspected.pageCount)
    const importId = `pdf_import_${randomUUID()}`
    const planId = planIdFor('document', importId, input.sourceArtifactId)
    const documentNodeId = reservedId('node', planId, 'document')
    const type = requireBuiltinType('pdf-document')
    const payload = {
      importId,
      sourcePdfDigest: artifact.contentDigest,
      pageCount: inspected.pageCount,
      metadata: inspected.metadata,
    }
    assertPayload(type.agent.writableInitSchema ?? type.initialPayloadSchema, payload)
    const node: CanvasNode = {
      id: documentNodeId,
      typeRef: { id: type.id, revision: type.revision, digest: type.digest },
      parentId: null,
      orderKey: canvasOrderKey(0),
      bounds: { w: 480, h: 300 },
      transform: { matrix: [1, 0, 0, 1, 520, 120] },
      title: input.title.trim(),
      payload,
      artifactRefs: [{ runId: input.sourceRunId, artifactId: input.sourceArtifactId }],
      homeTaskId: input.taskId,
      origin: {
        kind: 'agent-output', taskId: input.taskId, runId: input.sourceRunId,
        planId, outputKey: 'document',
      },
    }
    const plan = finalizePlan({
      schemaVersion: PDF_PLAN_SCHEMA_VERSION,
      planId,
      importId,
      kind: 'document',
      projectId: input.projectId,
      canvasBranch: input.canvasBranch,
      taskId: input.taskId,
      sourceRunId: input.sourceRunId,
      activityRunId: input.sourceRunId,
      sourceArtifactId: input.sourceArtifactId,
      sourcePdfDigest: artifact.contentDigest,
      documentNodeId,
      nodes: [{ logicalKey: 'document', node }],
    })
    const record: PdfImportRecord = {
      importId,
      projectId: input.projectId,
      canvasBranch: input.canvasBranch,
      taskId: input.taskId,
      sourceRunId: input.sourceRunId,
      sourceArtifactId: input.sourceArtifactId,
      sourcePdfDigest: artifact.contentDigest,
      pageCount: inspected.pageCount,
      metadata: inspected.metadata,
      documentNodeId,
      initialPlanId: planId,
      createdAt: new Date().toISOString(),
    }
    await this.#store(input.projectDir).putImport(record, plan)
    return { record, plan }
  }

  async getImport(projectDir: string, importId: string) {
    const entry = await this.#store(projectDir).getImport(importId)
    if (!entry) throw new PdfImportError('pdf_import_not_found', 'PDF import does not exist', 404)
    return entry
  }

  async getPlan(projectDir: string, planId: string): Promise<PdfMaterializationPlan> {
    const plan = await this.#store(projectDir).getPlan(planId)
    if (!plan || inspectPdfPlan(plan).status !== 'valid') {
      throw new PdfImportError('pdf_plan_not_found', 'PDF materialization plan does not exist', 404)
    }
    return plan
  }

  async pageBaseline(input: {
    projectDir: string
    importId: string
    pageNumber: number
  }): Promise<PdfPageBaseline> {
    const { record } = await this.getImport(input.projectDir, input.importId)
    const artifact = await new RunArtifactStore(input.projectDir, record.canvasBranch)
      .lookup(record.sourceRunId, record.sourceArtifactId)
    if (!artifact || artifact.contentDigest !== record.sourcePdfDigest) {
      throw new PdfImportError('pdf_source_changed', 'Source PDF no longer matches the import', 409)
    }
    const bytes = await readPdfArtifact(artifact)
    let page
    try {
      page = await this.#parser.page(new Uint8Array(bytes), input.pageNumber)
    } catch (error) {
      throw classifyPdfError(error)
    }
    const previewRunId = `pdf-preview-${record.importId}-${input.pageNumber}`
    const previews = new RunArtifactStore(input.projectDir, record.canvasBranch)
    const existing = await previews.manifest(previewRunId)
    let preview = existing?.entries.find((entry) => entry.relativePath === 'page.png')
    if (!preview) {
      const location = await previews.prepareRun(previewRunId)
      await atomicWriteBytes(path.join(location.absoluteFilesRoot, 'page.png'), page.previewPng)
      preview = (await previews.closeRun(previewRunId)).manifest.entries
        .find((entry) => entry.relativePath === 'page.png')
    }
    if (!preview) throw new Error('PDF page preview artifact was not created')
    return {
      importId: record.importId,
      pageNumber: input.pageNumber,
      viewport: { ...page.viewport, unit: 'pt' },
      text: page.text,
      annotations: page.annotations,
      preview: { runId: previewRunId, artifactId: preview.artifactId },
    }
  }

  async createDecomposition(input: {
    projectDir: string
    importId: string
    toolRunId: string
    proposal: GraphProposal
  }): Promise<PdfMaterializationPlan> {
    const { record } = await this.getImport(input.projectDir, input.importId)
    const plan = await buildPdfDecompositionPlan({
      projectDir: input.projectDir,
      record,
      toolRunId: input.toolRunId,
      proposal: input.proposal,
    })
    await this.#store(input.projectDir).putPlan(plan)
    return plan
  }

  #store(projectDir: string): PdfImportStore {
    const key = path.resolve(projectDir)
    let store = this.#stores.get(key)
    if (!store) {
      store = new PdfImportStore(key)
      this.#stores.set(key, store)
    }
    return store
  }
}

async function withPdfDocument<T>(
  bytes: Uint8Array,
  operation: (document: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  let loadingTask: PDFDocumentLoadingTask | null = null
  let document: PDFDocumentProxy | null = null
  try {
    loadingTask = getDocument({
      data: new Uint8Array(bytes),
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 64 * 1024 * 1024,
      stopAtErrors: true,
      verbosity: 0,
    })
    const passwordFailure = new Promise<never>((_resolve, reject) => {
      loadingTask!.onPassword = () => reject(new PdfImportError(
        'pdf_password_required', 'Encrypted PDFs require an explicit one-time password', 409,
      ))
    })
    document = await Promise.race([loadingTask.promise, passwordFailure])
    return await operation(document)
  } finally {
    await document?.cleanup().catch(() => undefined)
    await loadingTask?.destroy().catch(() => undefined)
  }
}

async function readPdfArtifact(
  artifact: Awaited<ReturnType<RunArtifactStore['lookup']>> & {},
): Promise<Buffer> {
  if (!artifact || artifact.size > MAX_PDF_BYTES) {
    throw new PdfImportError('pdf_too_large', 'PDF exceeds the supported size', 413)
  }
  const handle = await openVerifiedRunArtifactFile(artifact)
  try {
    return await readExactFileBytes(handle, artifact.size, MAX_PDF_BYTES)
  } finally {
    await handle.close()
  }
}

function normalizePdfMetadata(info: object): Record<string, string | null> {
  const output: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(info).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof value === 'string') output[key] = value.slice(0, 4_000)
    else if (value === null) output[key] = null
    else if (typeof value === 'number' || typeof value === 'boolean') output[key] = String(value)
  }
  return output
}

function classifyPdfError(error: unknown): PdfImportError {
  if (error instanceof PdfImportError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') {
    return new PdfImportError('pdf_password_required', 'Encrypted PDF requires a password', 409)
  }
  if (name === 'InvalidPDFException' || name === 'FormatError') {
    return new PdfImportError('pdf_malformed', 'PDF is malformed or unsupported', 400)
  }
  return new PdfImportError(
    'pdf_parse_failed',
    error instanceof Error ? error.message : 'PDF parsing failed',
    400,
  )
}

function assertPageCount(pageCount: number): void {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGES) {
    throw new PdfImportError('pdf_page_limit', `PDF page count must be from 1 to ${MAX_PDF_PAGES}`, 413)
  }
}

function requireBuiltinType(id: string) {
  const type = builtinNodeTypeSnapshots().find((candidate) => candidate.id === id)
  if (!type) throw new Error(`Missing builtin PDF node type: ${id}`)
  return type
}

function assertPayload(schemaId: string, payload: Record<string, unknown>): void {
  if (!createBuiltinPayloadSchemaRegistry().validate(schemaId, payload).valid) {
    throw new PdfImportError('invalid_pdf_payload', `PDF payload does not match ${schemaId}`, 400)
  }
}

function planIdFor(...parts: string[]): string {
  return `plan_${createHash('sha256').update(parts.join('\u001f')).digest('hex')}`
}

function reservedId(kind: 'node', ...parts: string[]): string {
  return `canvas_${kind}_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`
}

function finalizePlan(
  unsigned: Omit<PdfMaterializationPlan, 'digest'>,
): PdfMaterializationPlan {
  return {
    ...unsigned,
    digest: digestPlan(unsigned),
  }
}

export function inspectPdfPlan(value: unknown): { status: 'valid'; plan: PdfMaterializationPlan } | {
  status: 'invalid'
  reason: string
} {
  if (!isRecord(value) || typeof value.digest !== 'string') {
    return { status: 'invalid', reason: 'PDF plan envelope is invalid' }
  }
  const { digest, ...unsigned } = value
  if (digest !== digestPlan(unsigned)) return { status: 'invalid', reason: 'PDF plan digest does not match' }
  return { status: 'valid', plan: structuredClone(value) as unknown as PdfMaterializationPlan }
}

function digestPlan(value: unknown): string {
  return createHash('sha256').update('ggai.pdf-plan.v1\0').update(JSON.stringify(value)).digest('hex')
}

async function buildPdfDecompositionPlan(input: {
  projectDir: string
  record: PdfImportRecord
  toolRunId: string
  proposal: GraphProposal
}): Promise<PdfMaterializationPlan> {
  const documentEntries = input.proposal.nodes.filter((node) => node.typeId === 'pdf-document')
  if (documentEntries.length !== 1 || input.proposal.edges.length > 0) {
    throw new PdfImportError('invalid_pdf_decomposition', 'PDF decomposition requires one document root and containment only', 400)
  }
  const documentKey = documentEntries[0]!.key
  const pageByKey = new Map<string, { pageNumber: number; width: number; height: number }>()
  for (const node of input.proposal.nodes.filter((candidate) =>
    candidate.typeId === 'pdf-document' || candidate.typeId === 'pdf-page')) {
    if (node.typeId === 'pdf-document') {
      if (node.parentKey || node.init.sourcePdfDigest !== input.record.sourcePdfDigest) {
        throw new PdfImportError('pdf_source_mismatch', 'PDF decomposition source digest does not match', 400)
      }
      continue
    }
    if (node.typeId === 'pdf-page') {
      if (node.parentKey !== documentKey) throw new PdfImportError('invalid_pdf_parent', 'PDF page parent is invalid', 400)
      assertPayload('ggai://schema/payload/pdf-page', node.init)
      const pageNumber = Number(node.init.pageNumber)
      if (node.init.sourcePdfDigest !== input.record.sourcePdfDigest
        || pageNumber > input.record.pageCount) {
        throw new PdfImportError('pdf_page_out_of_range', 'PDF page declaration is invalid', 400)
      }
      pageByKey.set(node.key, {
        pageNumber,
        width: Number(node.init.width),
        height: Number(node.init.height),
      })
      continue
    }
  }
  for (const node of input.proposal.nodes.filter((candidate) =>
    candidate.typeId !== 'pdf-document' && candidate.typeId !== 'pdf-page')) {
    if (!['pdf-text-block', 'pdf-image', 'pdf-annotation'].includes(node.typeId)
      || !node.parentKey || !pageByKey.has(node.parentKey)) {
      throw new PdfImportError('invalid_pdf_parent', 'PDF decomposition child parent is invalid', 400)
    }
    const page = pageByKey.get(node.parentKey)!
    assertPayload(`ggai://schema/payload/${node.typeId}`, node.init)
    if (node.init.pageNumber !== page.pageNumber || !bboxWithinPage(node.init.bbox, page)) {
      throw new PdfImportError('pdf_bbox_out_of_range', 'PDF decomposition bbox is outside its page', 400)
    }
    if (node.typeId === 'pdf-image') {
      const ref = node.init.artifactRef as { runId: string; artifactId: string }
      if (ref.runId !== input.toolRunId) {
        throw new PdfImportError('pdf_artifact_scope_mismatch', 'PDF image references another tool run', 400)
      }
      const artifact = await new RunArtifactStore(input.projectDir, input.record.canvasBranch)
        .lookup(ref.runId, ref.artifactId)
      if (!artifact || !artifact.mediaType.startsWith('image/')) {
        throw new PdfImportError('pdf_artifact_invalid', 'PDF image artifact is missing or invalid', 400)
      }
    }
  }
  const planId = planIdFor('decomposition', input.record.importId, input.toolRunId, JSON.stringify(input.proposal))
  const idByKey = new Map<string, string>([[documentKey, input.record.documentNodeId]])
  for (const node of input.proposal.nodes) {
    if (node.key !== documentKey) idByKey.set(node.key, reservedId('node', planId, node.key))
  }
  const siblingIndex = new Map<string, number>()
  const nodes = input.proposal.nodes.flatMap((proposalNode) => {
    if (proposalNode.key === documentKey) return []
    const type = requireBuiltinType(proposalNode.typeId)
    const parentId = idByKey.get(proposalNode.parentKey!)!
    const index = siblingIndex.get(proposalNode.parentKey!) ?? 0
    siblingIndex.set(proposalNode.parentKey!, index + 1)
    const bbox = isRecord(proposalNode.init.bbox) ? proposalNode.init.bbox : null
    const payload = structuredClone(proposalNode.init)
    let artifactRefs: CanvasNode['artifactRefs'] = []
    if (proposalNode.typeId === 'pdf-image') {
      const ref = payload.artifactRef as { runId: string; artifactId: string }
      artifactRefs = [ref]
      delete payload.artifactRef
    }
    const page = proposalNode.typeId === 'pdf-page'
    const node: CanvasNode = {
      id: idByKey.get(proposalNode.key)!,
      typeRef: { id: type.id, revision: type.revision, digest: type.digest },
      parentId,
      orderKey: canvasOrderKey(index),
      bounds: page
        ? { w: Number(payload.width), h: Number(payload.height) }
        : { w: Number(bbox!.w), h: Number(bbox!.h) },
      transform: {
        matrix: page
          ? [1, 0, 0, 1, 24 + index * 120, 56]
          : [1, 0, 0, 1, Number(bbox!.x), Number(bbox!.y)],
      },
      ...(page ? { coordinateSpace: { unit: 'pt' as const } } : {}),
      title: proposalNode.title,
      ...(proposalNode.typeId === 'pdf-text-block' ? { text: String(payload.text) } : {}),
      payload,
      artifactRefs,
      origin: {
        kind: 'agent-output', taskId: input.record.taskId, runId: input.toolRunId,
        planId, outputKey: proposalNode.key,
      },
    }
    return [{ logicalKey: proposalNode.key, node }]
  })
  return finalizePlan({
    schemaVersion: PDF_PLAN_SCHEMA_VERSION,
    planId,
    importId: input.record.importId,
    kind: 'decomposition',
    projectId: input.record.projectId,
    canvasBranch: input.record.canvasBranch,
    taskId: input.record.taskId,
    sourceRunId: input.record.sourceRunId,
    activityRunId: input.toolRunId,
    sourceArtifactId: input.record.sourceArtifactId,
    sourcePdfDigest: input.record.sourcePdfDigest,
    documentNodeId: input.record.documentNodeId,
    nodes,
  })
}

function bboxWithinPage(value: unknown, page: { width: number; height: number }): boolean {
  if (!isRecord(value)) return false
  const x = Number(value.x); const y = Number(value.y)
  const w = Number(value.w); const h = Number(value.h)
  return [x, y, w, h].every(Number.isFinite)
    && x >= 0 && y >= 0 && w > 0 && h > 0
    && x + w <= page.width && y + h <= page.height
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
