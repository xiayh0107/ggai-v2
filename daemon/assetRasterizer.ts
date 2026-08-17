import path from 'node:path'
import sharp from 'sharp'
import type { CanvasDocument, CanvasNode } from '../src/canvas/model.js'
import {
  MAX_ASSET_DIMENSION,
  MAX_ASSET_PARTS,
  parseAssetAssemblyPayload,
  parseAssetPartPayload,
  parseShapePayload,
} from '../src/assets/contracts.js'
import type { ValueRef } from '../src/execution/contracts.js'
import { atomicWriteBytes, atomicWriteText } from './atomic-file.js'
import {
  openVerifiedRunArtifactFile,
  RunArtifactStore,
  type RunArtifactLookup,
} from './runArtifactStorage.js'
import type { NodeExecutor, NodeExecutorInput } from './nodeExecutions.js'

const MAX_SOURCE_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_INPUT_PIXELS = MAX_ASSET_DIMENSION * MAX_ASSET_DIMENSION
const SUPPORTED_SOURCE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
// sha256(asset-assembly-sharp + exact Sharp/encoder configuration)
const ENVIRONMENT_DIGEST = '649be27e65e427afbafdf8214ac01c04853e7304b18e01e7bbd45921768a5292'

export interface RasterizedNodeTree {
  svg: Buffer
  png: Buffer
}

/** Trusted, declarative renderer shared by Asset execution and later exporters. */
export class DeclarativeNodeRasterizer {
  async render(input: {
    projectDir: string
    canvasBranch: string
    document: CanvasDocument
    root: CanvasNode
  }): Promise<RasterizedNodeTree> {
    const { root } = input
    if (root.typeRef.id !== 'asset-assembly') throw new TypeError('root is not an asset assembly')
    const width = boundedDimension(root.bounds.w, 'width')
    const height = boundedDimension(root.bounds.h, 'height')
    const payload = parseAssetAssemblyPayload(root.payload)
    const children = input.document.nodes
      .filter((node) => node.parentId === root.id)
      .sort((left, right) => left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id))
    if (children.length > MAX_ASSET_PARTS) throw new TypeError('asset assembly has too many parts')

    const definitions: string[] = []
    const layers: string[] = []
    for (const [index, child] of children.entries()) {
      if (child.typeRef.id === 'shape') {
        layers.push(renderShape(child))
      } else if (child.typeRef.id === 'asset-part') {
        const rendered = await renderAssetPart(input.projectDir, input.canvasBranch, child, index)
        if (rendered.definition) definitions.push(rendered.definition)
        layers.push(rendered.layer)
      } else {
        throw new TypeError(`asset assembly contains unsupported child type: ${child.typeRef.id}`)
      }
    }
    const svg = Buffer.from([
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect width="${width}" height="${height}" fill="${payload.background}"/>`,
      definitions.length > 0 ? `<defs>${definitions.join('')}</defs>` : '',
      ...layers,
      '</svg>',
    ].join(''), 'utf8')
    const png = await sharp(svg, {
      density: payload.density,
      failOn: 'warning',
      limitInputPixels: MAX_INPUT_PIXELS,
      unlimited: false,
    }).png({
      compressionLevel: 9,
      adaptiveFiltering: false,
      palette: false,
      effort: 10,
    }).toBuffer()
    return { svg, png }
  }
}

export class AssetAssemblyExecutor implements NodeExecutor {
  readonly id = 'asset-assembly-sharp'
  readonly environmentDigest = ENVIRONMENT_DIGEST
  readonly #rasterizer: DeclarativeNodeRasterizer

  constructor(rasterizer = new DeclarativeNodeRasterizer()) {
    this.#rasterizer = rasterizer
  }

  supports(nodeTypeId: string): boolean {
    return nodeTypeId === 'asset-assembly'
  }

  async execute(input: NodeExecutorInput): Promise<Record<string, ValueRef[]>> {
    if (!input.projectDir) throw new TypeError('asset execution requires a trusted project directory')
    const output = await this.#rasterizer.render({
      projectDir: input.projectDir,
      canvasBranch: input.canvasBranch,
      document: input.document,
      root: input.node,
    })
    if (input.signal.aborted) throw input.signal.reason ?? new Error('asset execution cancelled')
    const store = new RunArtifactStore(input.projectDir, input.canvasBranch)
    const location = await store.prepareRun(input.artifactRunId)
    await Promise.all([
      atomicWriteText(path.join(location.absoluteFilesRoot, 'assembly.svg'), output.svg.toString('utf8')),
      atomicWriteBytes(path.join(location.absoluteFilesRoot, 'assembly.png'), output.png),
    ])
    const closed = await store.closeRun(input.artifactRunId)
    const artifact = (relativePath: string): ValueRef => {
      const entry = closed.manifest.entries.find((candidate) => candidate.relativePath === relativePath)
      if (!entry) throw new Error(`rasterizer output is absent from manifest: ${relativePath}`)
      return { kind: 'artifact', runId: input.artifactRunId, artifactId: entry.artifactId }
    }
    return { png: [artifact('assembly.png')], svg: [artifact('assembly.svg')] }
  }
}

async function renderAssetPart(
  projectDir: string,
  canvasBranch: string,
  node: CanvasNode,
  index: number,
): Promise<{ definition?: string; layer: string }> {
  const payload = parseAssetPartPayload(node.payload)
  if (node.artifactRefs.length !== 1) {
    throw new TypeError('asset part must reference exactly one source artifact')
  }
  const sourceRef = node.artifactRefs[0]!
  const artifact = await new RunArtifactStore(projectDir, canvasBranch)
    .lookup(sourceRef.runId, sourceRef.artifactId)
  if (!artifact) throw new TypeError('asset part source artifact does not exist')
  const bytes = await readTrustedRaster(artifact)
  const metadata = await sharp(bytes, {
    failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS, unlimited: false,
  }).metadata()
  if ((metadata.channels ?? 0) < 1 || (metadata.channels ?? 0) > 4) {
    throw new TypeError('asset part source has an unsupported channel count')
  }
  const sourceWidth = metadata.width ?? 0
  const sourceHeight = metadata.height ?? 0
  if (sourceWidth < payload.sourceRect.x + payload.sourceRect.w
    || sourceHeight < payload.sourceRect.y + payload.sourceRect.h) {
    throw new TypeError('asset part sourceRect exceeds source image bounds')
  }
  const clipId = payload.clip ? `clip-${index}` : undefined
  const definition = payload.clip
    ? `<clipPath id="${clipId}"><rect x="${number(payload.clip.x)}" y="${number(payload.clip.y)}" width="${number(payload.clip.w)}" height="${number(payload.clip.h)}"/></clipPath>`
    : undefined
  const transform = matrix(node.transform.matrix)
  const dataUri = `data:${artifact.mediaType};base64,${bytes.toString('base64')}`
  const blend = payload.blend === 'normal' ? '' : ` style="mix-blend-mode:${payload.blend}"`
  const clip = clipId ? ` clip-path="url(#${clipId})"` : ''
  const layer = [
    `<g transform="${transform} translate(${-payload.pivot.x} ${-payload.pivot.y})" opacity="${number(payload.opacity)}"${blend}${clip}>`,
    `<svg width="${number(node.bounds.w)}" height="${number(node.bounds.h)}" viewBox="${number(payload.sourceRect.x)} ${number(payload.sourceRect.y)} ${number(payload.sourceRect.w)} ${number(payload.sourceRect.h)}" preserveAspectRatio="none">`,
    `<image href="${dataUri}" width="${sourceWidth}" height="${sourceHeight}"/>`,
    '</svg></g>',
  ].join('')
  return { definition, layer }
}

function renderShape(node: CanvasNode): string {
  const payload = parseShapePayload(node.payload)
  const common = `fill="${payload.fill}" stroke="${payload.stroke}" stroke-width="${number(payload.strokeWidth)}"`
  const shape = payload.kind === 'ellipse'
    ? `<ellipse cx="${number(node.bounds.w / 2)}" cy="${number(node.bounds.h / 2)}" rx="${number(node.bounds.w / 2)}" ry="${number(node.bounds.h / 2)}" ${common}/>`
    : `<rect width="${number(node.bounds.w)}" height="${number(node.bounds.h)}" rx="${number(payload.cornerRadius)}" ${common}/>`
  return `<g transform="${matrix(node.transform.matrix)}">${shape}</g>`
}

async function readTrustedRaster(artifact: RunArtifactLookup): Promise<Buffer> {
  if (!SUPPORTED_SOURCE_MEDIA.has(artifact.mediaType)) {
    throw new TypeError(`asset part source media type is unsupported: ${artifact.mediaType}`)
  }
  if (artifact.size > MAX_SOURCE_ARTIFACT_BYTES) throw new TypeError('asset part source is too large')
  const handle = await openVerifiedRunArtifactFile(artifact)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function boundedDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ASSET_DIMENSION) {
    throw new TypeError(`asset ${label} is outside the supported range`)
  }
  return value
}

function matrix(value: CanvasNode['transform']['matrix']): string {
  return `matrix(${value.map(number).join(' ')})`
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError('asset geometry contains a non-finite number')
  const rounded = Math.round(value * 1_000_000) / 1_000_000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}
