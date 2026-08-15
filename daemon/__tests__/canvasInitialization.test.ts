import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  assertCanvasReady,
  blankProjectCanvasInitializationMarker,
  CanvasInitializationError,
} from '../canvasInitialization.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-canvas-init-')))
  temporaryDirectories.push(directory)
  return directory
}

async function writeCanvasMarker(projectDir: string): Promise<void> {
  await mkdir(path.join(projectDir, '.gg'), { recursive: true })
  await writeFile(
    path.join(projectDir, '.gg/canvas-model.json'),
    `${JSON.stringify(blankProjectCanvasInitializationMarker(
      'project_0123456789abcdef0123456789abcdef',
      '2026-08-05T12:00:00.000Z',
    ))}\n`,
  )
}

test('managed projects require their daemon-created identity marker', async () => {
  const projectDir = await temporaryProject()
  await assert.rejects(
    assertCanvasReady(projectDir),
    (error: unknown) => error instanceof CanvasInitializationError
      && error.code === 'canvas_initialization_required'
      && error.initializationRequired
      && error.message.includes('missing its Canvas identity marker'),
  )

  await writeCanvasMarker(projectDir)
  assert.equal((await assertCanvasReady(projectDir)).schemaVersion, 1)
})

test('blank workspace projects use an explicit marker without pretending to have a legacy archive', async () => {
  const projectDir = await temporaryProject()
  await mkdir(path.join(projectDir, '.gg'), { recursive: true })
  const marker = blankProjectCanvasInitializationMarker(
    'project_0123456789abcdef0123456789abcdef',
    '2026-08-06T12:00:00.000Z',
  )
  await writeFile(
    path.join(projectDir, '.gg/canvas-model.json'),
    `${JSON.stringify(marker)}\n`,
  )

  assert.deepEqual(await assertCanvasReady(projectDir), marker)
  assert.equal('legacyArchive' in marker, false)
})

test('invalid and symlinked model markers fail closed', async () => {
  const invalidProject = await temporaryProject()
  await mkdir(path.join(invalidProject, '.gg'), { recursive: true })
  await writeFile(path.join(invalidProject, '.gg/canvas-model.json'), '{"canvasModel":2}\n')
  await assert.rejects(
    assertCanvasReady(invalidProject),
    (error: unknown) => error instanceof CanvasInitializationError
      && error.code === 'canvas_marker_invalid',
  )

  const ambiguousProject = await temporaryProject()
  await mkdir(path.join(ambiguousProject, '.gg'), { recursive: true })
  await writeFile(path.join(ambiguousProject, '.gg/canvas-model.json'), `${JSON.stringify({
    ...blankProjectCanvasInitializationMarker(
      'project_0123456789abcdef0123456789abcdef',
      '2026-08-06T12:00:00.000Z',
    ),
    legacyArchive: '.gg/legacy-v1/20260806T120000.000Z',
  })}\n`)
  await assert.rejects(
    assertCanvasReady(ambiguousProject),
    (error: unknown) => error instanceof CanvasInitializationError
      && error.code === 'canvas_marker_invalid',
  )

  const linkedProject = await temporaryProject()
  const outside = await temporaryProject()
  await writeCanvasMarker(outside)
  await symlink(path.join(outside, '.gg'), path.join(linkedProject, '.gg'), 'dir')
  await assert.rejects(
    assertCanvasReady(linkedProject),
    (error: unknown) => error instanceof CanvasInitializationError
      && error.code === 'canvas_marker_invalid',
  )
})
