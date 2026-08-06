import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  assertCanvasModelReady,
  CanvasModelBootError,
  parseCanvasModelMode,
  parseCanvasModelV2Flag,
} from '../canvasModelMode.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-model-mode-')))
  temporaryDirectories.push(directory)
  return directory
}

async function writeV2Marker(projectDir: string): Promise<void> {
  await mkdir(path.join(projectDir, '.gg'), { recursive: true })
  await writeFile(path.join(projectDir, '.gg/canvas-model.json'), `${JSON.stringify({
    version: 1,
    canvasModel: 2,
    initializedAt: '2026-08-05T12:00:00.000Z',
    legacyArchive: '.gg/legacy-v1/20260805T120000.000Z',
  })}\n`)
}

test('model selection flags are explicit and reject ambiguous values', () => {
  assert.equal(parseCanvasModelMode('v1'), 'v1')
  assert.equal(parseCanvasModelMode('2'), 'v2')
  assert.equal(parseCanvasModelV2Flag(undefined), 'v1')
  assert.equal(parseCanvasModelV2Flag('TRUE'), 'v2')
  assert.equal(parseCanvasModelV2Flag('0'), 'v1')
  assert.throws(() => parseCanvasModelV2Flag('enabled'), CanvasModelBootError)
})

test('V2 requires the reset marker and V1 refuses a V2 project', async () => {
  const projectDir = await temporaryProject()
  assert.equal(await assertCanvasModelReady(projectDir, 'v1'), null)
  await assert.rejects(
    assertCanvasModelReady(projectDir, 'v2'),
    (error: unknown) => error instanceof CanvasModelBootError
      && error.code === 'canvas_reset_required'
      && error.resetRequired,
  )

  await writeV2Marker(projectDir)
  assert.equal((await assertCanvasModelReady(projectDir, 'v2'))?.canvasModel, 2)
  await assert.rejects(
    assertCanvasModelReady(projectDir, 'v1'),
    (error: unknown) => error instanceof CanvasModelBootError
      && error.code === 'canvas_model_mismatch',
  )
})

test('invalid and symlinked model markers fail closed', async () => {
  const invalidProject = await temporaryProject()
  await mkdir(path.join(invalidProject, '.gg'), { recursive: true })
  await writeFile(path.join(invalidProject, '.gg/canvas-model.json'), '{"canvasModel":2}\n')
  await assert.rejects(
    assertCanvasModelReady(invalidProject, 'v2'),
    (error: unknown) => error instanceof CanvasModelBootError
      && error.code === 'canvas_model_marker_invalid',
  )

  const linkedProject = await temporaryProject()
  const outside = await temporaryProject()
  await writeV2Marker(outside)
  await symlink(path.join(outside, '.gg'), path.join(linkedProject, '.gg'), 'dir')
  await assert.rejects(
    assertCanvasModelReady(linkedProject, 'v2'),
    (error: unknown) => error instanceof CanvasModelBootError
      && error.code === 'canvas_model_marker_invalid',
  )
})
