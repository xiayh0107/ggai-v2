import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, test } from 'node:test'
import {
  assertCanvasReady,
  blankProjectCanvasInitializationMarker,
  CanvasInitializationError,
  ensureCanvasReady,
} from '../canvasInitialization.js'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

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
  assert.equal((await assertCanvasReady(projectDir)).schemaVersion, 2)
  assert.equal((await assertCanvasReady(projectDir)).canvasSchemaVersion, 3)
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

test('first current startup clears old managed state without touching source files', async () => {
  const projectDir = await temporaryProject()
  const projectId = 'project_0123456789abcdef0123456789abcdef'
  await mkdir(path.join(projectDir, '.gg/runtime'), { recursive: true })
  const retiredCanvasDir = path.join(projectDir, '.gg', `canvas-state-v${2}`)
  await mkdir(retiredCanvasDir, { recursive: true })
  await mkdir(path.join(projectDir, '.gg/canvas'), { recursive: true })
  await mkdir(path.join(projectDir, 'artifacts/run-old'), { recursive: true })
  await writeFile(path.join(projectDir, '.gg/runtime/run.json'), '{}\n')
  await writeFile(path.join(projectDir, 'artifacts/run-old/output.txt'), 'old\n')
  await writeFile(path.join(projectDir, 'source.txt'), 'keep\n')
  await writeFile(path.join(projectDir, '.gg/canvas-model.json'), `${JSON.stringify({
    schemaVersion: 1,
    initializedAt: '2026-08-06T12:00:00.000Z',
    initializedFrom: 'blank-project',
    projectId,
  })}\n`)

  const marker = await ensureCanvasReady(projectDir, projectId)
  assert.equal(marker.schemaVersion, 2)
  assert.equal(marker.canvasSchemaVersion, 3)
  assert.equal(marker.initializedFrom, 'schema-reset')
  await access(path.join(projectDir, 'source.txt'))
  await assert.rejects(access(path.join(projectDir, '.gg/runtime')), /ENOENT/u)
  await assert.rejects(access(retiredCanvasDir), /ENOENT/u)
  await assert.rejects(access(path.join(projectDir, '.gg/canvas')), /ENOENT/u)
  await assert.rejects(access(path.join(projectDir, 'artifacts')), /ENOENT/u)
  await assert.rejects(access(path.join(projectDir, '.gg/canvas-reset.json')), /ENOENT/u)
  assert.deepEqual(await ensureCanvasReady(projectDir, projectId), marker)
})

test('automatic reset refuses symlinked managed targets', async () => {
  const projectDir = await temporaryProject()
  const outside = await temporaryProject()
  const projectId = 'project_0123456789abcdef0123456789abcdef'
  await mkdir(path.join(projectDir, '.gg'), { recursive: true })
  await writeFile(path.join(projectDir, '.gg/canvas-model.json'), `${JSON.stringify({
    schemaVersion: 1,
    initializedAt: '2026-08-06T12:00:00.000Z',
    initializedFrom: 'blank-project',
    projectId,
  })}\n`)
  await symlink(outside, path.join(projectDir, 'artifacts'))
  await assert.rejects(ensureCanvasReady(projectDir, projectId), /not a real directory/u)
  await access(outside)
})

test('automatic reset never removes source-controlled files', async () => {
  const projectDir = await temporaryProject()
  const projectId = 'project_0123456789abcdef0123456789abcdef'
  await mkdir(path.join(projectDir, '.gg'), { recursive: true })
  await mkdir(path.join(projectDir, 'artifacts'), { recursive: true })
  await writeFile(path.join(projectDir, 'artifacts/tracked.txt'), 'keep\n')
  await writeFile(path.join(projectDir, '.gg/canvas-model.json'), `${JSON.stringify({
    schemaVersion: 1,
    initializedAt: '2026-08-06T12:00:00.000Z',
    initializedFrom: 'blank-project',
    projectId,
  })}\n`)
  await execFileAsync('git', ['-C', projectDir, 'init'])
  await execFileAsync('git', ['-C', projectDir, 'add', 'artifacts/tracked.txt'])

  await assert.rejects(ensureCanvasReady(projectDir, projectId), /source-controlled/u)
  await access(path.join(projectDir, 'artifacts/tracked.txt'))
})
