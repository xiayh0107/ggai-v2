import assert from 'node:assert/strict'
import {
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

import {
  assertCanvasModelReady,
  blankProjectCanvasModelMarker,
} from '../canvasModelMode.js'
import {
  ProjectCatalog,
  ProjectCatalogError,
  ROOT_WORKSPACE_PROJECT_ID,
} from '../projectCatalog.js'

const temporaryDirectories: string[] = []
const PROJECT_A = 'project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PROJECT_B = 'project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-project-catalog-')))
  temporaryDirectories.push(root)
  await writeBlankMarker(root, ROOT_WORKSPACE_PROJECT_ID)
  return root
}

async function writeBlankMarker(projectDir: string, projectId: string): Promise<void> {
  await mkdir(path.join(projectDir, '.gg'), { recursive: true })
  await writeFile(
    path.join(projectDir, '.gg', 'canvas-model.json'),
    `${JSON.stringify(blankProjectCanvasModelMarker(
      projectId,
      '2026-08-06T12:00:00.000Z',
    ))}\n`,
    'utf8',
  )
}

test('catalog persists the fixed root and opaque blank projects without scanning directories', async () => {
  const root = await temporaryWorkspace()
  await mkdir(path.join(root, 'ordinary-unregistered-directory'))
  let now = Date.parse('2026-08-06T13:00:00.000Z')
  const catalog = new ProjectCatalog(root, {
    now: () => now,
    idFactory: () => PROJECT_A,
  })

  const initial = await catalog.list()
  assert.deepEqual(initial, [{
    id: ROOT_WORKSPACE_PROJECT_ID,
    title: path.basename(root),
    projectDir: '.',
    createdAt: '2026-08-06T13:00:00.000Z',
    updatedAt: '2026-08-06T13:00:00.000Z',
    lastOpenedAt: null,
    state: 'ready',
    summary: { taskCount: 0, nodeCount: 0, collectionCount: 0 },
  }])

  now = Date.parse('2026-08-06T14:00:00.000Z')
  const created = await catalog.create('真实项目')
  assert.deepEqual(created, {
    id: PROJECT_A,
    title: '真实项目',
    projectDir: `.gg/workspace/projects/${PROJECT_A}`,
    createdAt: '2026-08-06T14:00:00.000Z',
    updatedAt: '2026-08-06T14:00:00.000Z',
    lastOpenedAt: null,
    state: 'ready',
    summary: { taskCount: 0, nodeCount: 0, collectionCount: 0 },
  })
  const projectPath = path.join(root, ...created.projectDir.split('/'))
  const marker = await assertCanvasModelReady(projectPath, 'v2')
  assert.ok(marker && 'projectId' in marker)
  assert.equal(marker.projectId, PROJECT_A)
  await assert.rejects(
    readFile(path.join(projectPath, '.gg/runtime/canvas-daemon.lock')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  )

  now = Date.parse('2026-08-06T15:00:00.000Z')
  const opened = await catalog.markOpened(PROJECT_A)
  assert.equal(opened.lastOpenedAt, '2026-08-06T15:00:00.000Z')
  await catalog.close()

  const reopened = new ProjectCatalog(root)
  const projects = await reopened.list()
  assert.deepEqual(projects.map((project) => project.id), [PROJECT_A, ROOT_WORKSPACE_PROJECT_ID])
  assert.equal(projects[0]?.lastOpenedAt, '2026-08-06T15:00:00.000Z')
  assert.equal(projects.some((project) => project.title.includes('ordinary')), false)
  await reopened.close()
})

test('missing, symlinked, and marker-mismatched projects remain visible as unavailable', async () => {
  const root = await temporaryWorkspace()
  const ids = [PROJECT_A, PROJECT_B]
  const catalog = new ProjectCatalog(root, { idFactory: () => ids.shift() ?? PROJECT_B })
  const missing = await catalog.create('稍后丢失')
  const mismatched = await catalog.create('身份错配')
  await rm(path.join(root, ...missing.projectDir.split('/')), { recursive: true })
  const mismatchedPath = path.join(root, ...mismatched.projectDir.split('/'))
  await writeFile(
    path.join(mismatchedPath, '.gg/canvas-model.json'),
    `${JSON.stringify(blankProjectCanvasModelMarker(
      PROJECT_A,
      '2026-08-06T16:00:00.000Z',
    ))}\n`,
  )

  const listed = await catalog.list()
  assert.equal(listed.find((project) => project.id === missing.id)?.state, 'unavailable')
  assert.equal(listed.find((project) => project.id === missing.id)?.summary, null)
  assert.equal(listed.find((project) => project.id === mismatched.id)?.state, 'unavailable')
  await assert.rejects(
    catalog.requireReady(mismatched.id),
    (error: unknown) => error instanceof ProjectCatalogError
      && error.code === 'project_unavailable',
  )

  await writeFile(path.join(mismatchedPath, '.gg/canvas-model.json'), `${JSON.stringify({
    version: 1,
    canvasModel: 2,
    initializedAt: '2026-08-06T16:00:00.000Z',
    legacyArchive: '.gg/legacy-v1/20260806T160000.000Z',
  })}\n`)
  assert.equal(
    (await catalog.list()).find((project) => project.id === mismatched.id)?.state,
    'unavailable',
  )

  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-project-outside-')))
  temporaryDirectories.push(outside)
  await writeBlankMarker(outside, PROJECT_A)
  const missingPath = path.join(root, ...missing.projectDir.split('/'))
  await symlink(outside, missingPath, 'dir')
  assert.equal(
    (await catalog.list()).find((project) => project.id === missing.id)?.state,
    'unavailable',
  )
  await catalog.close()
})

test('catalog rejects invalid titles, serializes creates, and fails closed on registry tampering', async () => {
  const root = await temporaryWorkspace()
  const ids = [PROJECT_A, PROJECT_B]
  const catalog = new ProjectCatalog(root, { idFactory: () => ids.shift() ?? PROJECT_B })
  await assert.rejects(
    catalog.create('  '),
    (error: unknown) => error instanceof ProjectCatalogError
      && error.code === 'invalid_project_title',
  )
  await assert.rejects(
    catalog.create(`bad\u0000title`),
    (error: unknown) => error instanceof ProjectCatalogError
      && error.code === 'invalid_project_title',
  )

  const [first, second] = await Promise.all([
    catalog.create('项目 A'),
    catalog.create('项目 B'),
  ])
  assert.deepEqual(new Set([first.id, second.id]), new Set([PROJECT_A, PROJECT_B]))
  await assert.rejects(
    catalog.create('项目 A'),
    (error: unknown) => error instanceof ProjectCatalogError
      && error.code === 'project_title_conflict',
  )
  await catalog.close()

  const source = JSON.parse(await readFile(catalog.filePath, 'utf8')) as {
    projects: Array<Record<string, unknown>>
  }
  source.projects[1]!.projectDir = '../escape'
  await writeFile(catalog.filePath, `${JSON.stringify(source)}\n`)
  const corrupt = new ProjectCatalog(root)
  await assert.rejects(
    corrupt.list(),
    (error: unknown) => error instanceof ProjectCatalogError
      && error.code === 'project_catalog_corrupt',
  )
  await corrupt.close()
})

test('catalog and managed project parent symlinks fail closed without writing outside', async () => {
  const root = await temporaryWorkspace()
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-catalog-symlink-')))
  temporaryDirectories.push(outside)
  await mkdir(path.join(root, '.gg', 'workspace'), { recursive: true })
  await symlink(outside, path.join(root, '.gg', 'workspace', 'projects'), 'dir')
  const catalog = new ProjectCatalog(root, { idFactory: () => PROJECT_A })

  await assert.rejects(
    catalog.list(),
    (error: unknown) => error instanceof ProjectCatalogError
      && error.code === 'unsafe_workspace_catalog',
  )
  assert.deepEqual(await readFile(path.join(root, '.gg/canvas-model.json'), 'utf8').then(Boolean), true)
  await catalog.close()
})
