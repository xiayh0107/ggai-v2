import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import {
  canvasNodeGeometry,
  canvasNodeTypeRef,
  emptyCanvasDocument,
  type CanvasNode,
} from '../../src/canvas/model.js'
import { AssetAssemblyExecutor, DeclarativeNodeRasterizer } from '../assetRasterizer.js'
import { RunArtifactStore } from '../runArtifactStorage.js'

test('declarative rasterizer produces deterministic SVG and PNG artifacts', async (t) => {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-assets-')))
  t.after(() => rm(projectDir, { recursive: true, force: true }))
  const document = emptyCanvasDocument()
  const root = node('assembly', 'asset-assembly', {
    background: '#ffffff00', density: 144,
  }, { x: 0, y: 0, w: 320, h: 200, z: 0 })
  const shape = node('shape', 'shape', {
    kind: 'rectangle', fill: '#112233', stroke: '#ffffff', strokeWidth: 2, cornerRadius: 12,
  }, { x: 20, y: 30, w: 100, h: 80, z: 1 })
  shape.parentId = root.id
  document.nodes.push(root, shape)

  const rasterizer = new DeclarativeNodeRasterizer()
  const first = await rasterizer.render({ projectDir, canvasBranch: 'main', document, root })
  const second = await rasterizer.render({ projectDir, canvasBranch: 'main', document, root })
  assert.deepEqual(first, second)
  assert.match(first.svg.toString('utf8'), /<rect width="100" height="80"/u)
  assert.equal((await sharp(first.png).metadata()).format, 'png')

  const executor = new AssetAssemblyExecutor(rasterizer)
  const outputs = await executor.execute({
    executionId: 'execution-test-assets',
    artifactRunId: 'execution-artifacts-test-assets',
    projectDir,
    canvasBranch: 'main',
    document,
    node: root,
    inputs: {},
    signal: new AbortController().signal,
  })
  assert.deepEqual(Object.keys(outputs).sort(), ['png', 'svg'])
  const png = outputs.png?.[0]
  assert.equal(png?.kind, 'artifact')
  if (png?.kind !== 'artifact') throw new Error('PNG output is not an artifact')
  const lookup = await new RunArtifactStore(projectDir, 'main').lookup(png.runId, png.artifactId)
  assert.equal(lookup?.mediaType, 'image/png')
})

test('asset parts load one verified raster source and enforce its sourceRect', async (t) => {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-asset-parts-')))
  t.after(() => rm(projectDir, { recursive: true, force: true }))
  const sources = new RunArtifactStore(projectDir, 'main')
  const location = await sources.prepareRun('source-run')
  await writeFile(
    path.join(location.absoluteFilesRoot, 'source.png'),
    await sharp({ create: { width: 16, height: 12, channels: 4, background: '#ff0000' } })
      .png().toBuffer(),
  )
  const closed = await sources.closeRun('source-run')
  const source = closed.manifest.entries[0]!
  const document = emptyCanvasDocument()
  const root = node('assembly', 'asset-assembly', {
    background: '#00000000', density: 72,
  }, { x: 0, y: 0, w: 160, h: 120, z: 0 })
  const part = node('part', 'asset-part', {
    sourceRect: { x: 0, y: 0, w: 16, h: 12 },
    pivot: { x: 0, y: 0 }, opacity: 0.8, blend: 'normal', alt: 'red source',
  }, { x: 4, y: 8, w: 80, h: 60, z: 1 })
  part.parentId = root.id
  part.artifactRefs = [{ runId: 'source-run', artifactId: source.artifactId }]
  document.nodes.push(root, part)
  const output = await new DeclarativeNodeRasterizer().render({
    projectDir, canvasBranch: 'main', document, root,
  })
  assert.match(output.svg.toString('utf8'), /data:image\/png;base64,/u)

  part.payload = { ...part.payload, sourceRect: { x: 0, y: 0, w: 17, h: 12 } }
  await assert.rejects(
    new DeclarativeNodeRasterizer().render({ projectDir, canvasBranch: 'main', document, root }),
    /sourceRect exceeds/u,
  )
})

function node(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  frame: { x: number; y: number; w: number; h: number; z: number },
): CanvasNode {
  return {
    id,
    typeRef: canvasNodeTypeRef(type),
    ...canvasNodeGeometry(frame),
    title: id,
    payload,
    artifactRefs: [],
    origin: { kind: 'user' },
  }
}
