import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'
import {
  applyCanvasV2Reset,
  CanvasV2ResetError,
  inspectCanvasV2Reset,
} from './reset-canvas-v2.mjs'

const execFileAsync = promisify(execFile)
const temporaryDirectories = []
const RESET_TIME = Date.parse('2026-08-05T12:34:56.789Z')
const ARCHIVE_RELATIVE = '.gg/legacy-v1/20260805T123456.789Z'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryProject() {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-v2-reset-')))
  temporaryDirectories.push(projectDir)
  await writeFile(
    path.join(projectDir, 'package.json'),
    `${JSON.stringify({ name: 'reset-fixture', private: true })}\n`,
    'utf8',
  )
  await writeFile(path.join(projectDir, 'source.txt'), 'preserve me\n', 'utf8')
  await execFileAsync('git', ['init', '--quiet'], { cwd: projectDir })
  await execFileAsync('git', ['add', 'package.json', 'source.txt'], { cwd: projectDir })
  return projectDir
}

async function seedLegacyState(projectDir, leasePid = 2_147_483_647) {
  const directories = [
    '.gg/runtime',
    '.gg/canvas-state',
    '.gg/canvas-worktrees',
    '.gg/source-worktrees/keep',
    'artifacts/node-old',
  ]
  await Promise.all(directories.map((directory) =>
    mkdir(path.join(projectDir, directory), { recursive: true })))
  await writeFile(path.join(projectDir, '.gg/runtime/legacy.json'), '{"schemaVersion":1}\n')
  await writeFile(
    path.join(projectDir, '.gg/runtime/canvas-daemon.lock'),
    `${JSON.stringify({ pid: leasePid, token: 'legacy-lease' })}\n`,
  )
  await writeFile(path.join(projectDir, '.gg/canvas-state/HEAD'), 'legacy\n')
  await writeFile(path.join(projectDir, '.gg/canvas-worktrees/legacy'), 'legacy\n')
  await writeFile(path.join(projectDir, '.gg/source-worktrees/keep/source'), 'keep\n')
  await writeFile(path.join(projectDir, 'artifacts/node-old/result.png'), 'png\n')
}

test('reset is read-only by default and previews exact archive destinations', async () => {
  const projectDir = await temporaryProject()
  await seedLegacyState(projectDir)

  const preview = await inspectCanvasV2Reset(projectDir, { now: () => RESET_TIME })

  assert.equal(preview.archiveRelative, ARCHIVE_RELATIVE)
  assert.equal(preview.daemonLease.state, 'stale')
  assert.deepEqual(
    preview.operations.map(({ source, destination, status }) => ({ source, destination, status })),
    [
      { source: '.gg/runtime', destination: `${ARCHIVE_RELATIVE}/.gg/runtime`, status: 'pending' },
      { source: '.gg/canvas-state', destination: `${ARCHIVE_RELATIVE}/.gg/canvas-state`, status: 'pending' },
      { source: '.gg/canvas-worktrees', destination: `${ARCHIVE_RELATIVE}/.gg/canvas-worktrees`, status: 'pending' },
      { source: 'artifacts', destination: `${ARCHIVE_RELATIVE}/artifacts`, status: 'pending' },
    ],
  )
  assert.equal(await readFile(path.join(projectDir, '.gg/runtime/legacy.json'), 'utf8'), '{"schemaVersion":1}\n')
  await assert.rejects(access(path.join(projectDir, ARCHIVE_RELATIVE)), { code: 'ENOENT' })
})

test('apply archives V1 state and initializes only pristine V2 state', async () => {
  const projectDir = await temporaryProject()
  await seedLegacyState(projectDir)

  const result = await applyCanvasV2Reset(projectDir, { now: () => RESET_TIME })

  assert.equal(result.archiveRelative, ARCHIVE_RELATIVE)
  assert.equal(await readFile(path.join(projectDir, 'source.txt'), 'utf8'), 'preserve me\n')
  assert.equal(
    await readFile(path.join(projectDir, '.gg/source-worktrees/keep/source'), 'utf8'),
    'keep\n',
  )
  assert.equal(
    await readFile(path.join(projectDir, ARCHIVE_RELATIVE, '.gg/runtime/legacy.json'), 'utf8'),
    '{"schemaVersion":1}\n',
  )
  assert.equal(
    await readFile(path.join(projectDir, ARCHIVE_RELATIVE, 'artifacts/node-old/result.png'), 'utf8'),
    'png\n',
  )

  const marker = JSON.parse(await readFile(path.join(projectDir, '.gg/canvas-model.json'), 'utf8'))
  assert.equal(marker.canvasModel, 2)
  assert.equal(marker.legacyArchive, ARCHIVE_RELATIVE)
  const branchHash = '0d6e4079e36703ebd37c00722f5891d28b0e2811dc114b129215123adcce3605'
  const snapshot = JSON.parse(await readFile(
    path.join(projectDir, `.gg/runtime/canvas-v2/${branchHash}/snapshot.json`),
    'utf8',
  ))
  assert.equal(snapshot.revision, 0)
  assert.deepEqual(snapshot.document, {
    schemaVersion: 2,
    nodes: [],
    tasks: [],
    collections: [],
    edges: [],
    receipts: [],
    everCreated: false,
  })
  await access(path.join(projectDir, 'artifacts/.branches'))
  await access(path.join(projectDir, ARCHIVE_RELATIVE, 'reset-journal.json'))
  await assert.rejects(access(path.join(projectDir, '.gg/canvas-v2-reset.pending.json')), { code: 'ENOENT' })
  await assert.rejects(access(path.join(projectDir, '.gg/canvas-maintenance.lock')), { code: 'ENOENT' })
  await assert.rejects(access(path.join(projectDir, '.gg/runtime/canvas-daemon.lock')), { code: 'ENOENT' })
})

test('apply refuses a live daemon and releases its maintenance fence', async () => {
  const projectDir = await temporaryProject()
  await seedLegacyState(projectDir, process.pid)

  await assert.rejects(
    applyCanvasV2Reset(projectDir, { now: () => RESET_TIME }),
    (error) => error instanceof CanvasV2ResetError && error.code === 'daemon_instance_active',
  )
  await access(path.join(projectDir, '.gg/runtime/legacy.json'))
  await assert.rejects(access(path.join(projectDir, ARCHIVE_RELATIVE)), { code: 'ENOENT' })
  await assert.rejects(access(path.join(projectDir, '.gg/canvas-maintenance.lock')), { code: 'ENOENT' })
})

test('an interrupted archive resumes from its durable journal without duplicating state', async () => {
  const projectDir = await temporaryProject()
  await seedLegacyState(projectDir)

  await assert.rejects(
    applyCanvasV2Reset(projectDir, { now: () => RESET_TIME, failAfterMoveCount: 1 }),
    (error) => error instanceof CanvasV2ResetError && error.code === 'canvas_v2_reset_interrupted',
  )
  await access(path.join(projectDir, '.gg/canvas-v2-reset.pending.json'))
  await access(path.join(projectDir, ARCHIVE_RELATIVE, '.gg/runtime/legacy.json'))

  const result = await applyCanvasV2Reset(projectDir, { now: () => RESET_TIME })

  assert.equal(result.resumed, true)
  await access(path.join(projectDir, ARCHIVE_RELATIVE, '.gg/canvas-state/HEAD'))
  await access(path.join(projectDir, ARCHIVE_RELATIVE, 'artifacts/node-old/result.png'))
  await assert.rejects(access(path.join(projectDir, '.gg/runtime/canvas-daemon.lock')), { code: 'ENOENT' })
})

test('reset rejects symlink targets and source-Git tracked state', async () => {
  const symlinkProject = await temporaryProject()
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-v2-reset-outside-')))
  temporaryDirectories.push(outside)
  await symlink(outside, path.join(symlinkProject, 'artifacts'), 'dir')
  await assert.rejects(
    inspectCanvasV2Reset(symlinkProject, { now: () => RESET_TIME }),
    (error) => error instanceof CanvasV2ResetError && error.code === 'unsafe_managed_path',
  )

  const trackedProject = await temporaryProject()
  await mkdir(path.join(trackedProject, 'artifacts'), { recursive: true })
  await writeFile(path.join(trackedProject, 'artifacts/tracked.txt'), 'tracked\n')
  await execFileAsync('git', ['add', '--force', 'artifacts/tracked.txt'], { cwd: trackedProject })
  await assert.rejects(
    inspectCanvasV2Reset(trackedProject, { now: () => RESET_TIME }),
    (error) => error instanceof CanvasV2ResetError
      && error.code === 'tracked_reset_target'
      && error.details.paths.includes('artifacts/tracked.txt'),
  )
})
