import assert from 'node:assert/strict'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import {
  assertCanvasReady,
  blankProjectCanvasInitializationMarker,
} from '../canvasInitialization.js'
import {
  ProjectCatalog,
  ProjectCatalogError,
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
  return root
}

async function writeBlankMarker(projectDir: string, projectId: string): Promise<void> {
  await mkdir(path.join(projectDir, '.gg'), { recursive: true })
  await writeFile(
    path.join(projectDir, '.gg', 'canvas-model.json'),
    `${JSON.stringify(blankProjectCanvasInitializationMarker(
      projectId,
      '2026-08-06T12:00:00.000Z',
    ))}\n`,
    'utf8',
  )
}

test('catalog starts empty and lists only explicit opaque user projects', async () => {
  const root = await temporaryWorkspace()
  await mkdir(path.join(root, 'ordinary-unregistered-directory'))
  let now = Date.parse('2026-08-06T13:00:00.000Z')
  const catalog = new ProjectCatalog(root, {
    now: () => now,
    idFactory: () => PROJECT_A,
  })

  const initial = await catalog.list()
  assert.deepEqual(initial, [])

  now = Date.parse('2026-08-06T14:00:00.000Z')
  const created = await catalog.create(path.basename(root))
  assert.deepEqual(created, {
    id: PROJECT_A,
    title: path.basename(root),
    projectDir: `.gg/workspace/projects/${PROJECT_A}`,
    createdAt: '2026-08-06T14:00:00.000Z',
    updatedAt: '2026-08-06T14:00:00.000Z',
    lastOpenedAt: null,
    state: 'ready',
    summary: { taskCount: 0, nodeCount: 0, collectionCount: 0 },
  })
  const projectPath = path.join(root, ...created.projectDir.split('/'))
  const marker = await assertCanvasReady(projectPath)
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
  assert.deepEqual(projects.map((project) => project.id), [PROJECT_A])
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
    `${JSON.stringify(blankProjectCanvasInitializationMarker(
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
    schemaVersion: 1,
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
  source.projects[0]!.projectDir = '../escape'
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
  await assert.rejects(
    readFile(path.join(root, '.gg/canvas-model.json'), 'utf8'),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
  await catalog.close()
})

test('ready managed projects can be deleted and stay deleted after restart', async () => {
  const root = await temporaryWorkspace()
  const catalog = new ProjectCatalog(root, { idFactory: () => PROJECT_A })
  const created = await catalog.create('待删除项目')
  const projectPath = path.join(root, ...created.projectDir.split('/'))
  await mkdir(path.join(projectPath, 'artifacts'))
  await writeFile(path.join(projectPath, 'artifacts', 'result.txt'), 'durable project data')

  const deleted = await catalog.delete(PROJECT_A)
  assert.deepEqual(deleted, {
    id: PROJECT_A,
    title: '待删除项目',
    projectDir: `.gg/workspace/projects/${PROJECT_A}`,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
    lastOpenedAt: null,
  })
  await assert.rejects(
    lstat(projectPath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
  assert.deepEqual((await catalog.list()).map((project) => project.id), [])
  await catalog.close()

  const reopened = new ProjectCatalog(root)
  assert.deepEqual((await reopened.list()).map((project) => project.id), [])
  await reopened.close()
})

test('deletion refuses marker-mismatched or symlinked projects', async () => {
  const root = await temporaryWorkspace()
  const ids = [PROJECT_A, PROJECT_B]
  const catalog = new ProjectCatalog(root, { idFactory: () => ids.shift() ?? PROJECT_B })

  const mismatched = await catalog.create('身份损坏')
  const mismatchedPath = path.join(root, ...mismatched.projectDir.split('/'))
  await writeFile(
    path.join(mismatchedPath, '.gg/canvas-model.json'),
    `${JSON.stringify(blankProjectCanvasInitializationMarker(
      PROJECT_B,
      '2026-08-06T16:00:00.000Z',
    ))}\n`,
  )
  await assert.rejects(
    catalog.delete(PROJECT_A),
    (error: unknown) => error instanceof ProjectCatalogError
      && error.code === 'project_unavailable',
  )
  assert.equal((await lstat(mismatchedPath)).isDirectory(), true)

  const linked = await catalog.create('目录被替换')
  const linkedPath = path.join(root, ...linked.projectDir.split('/'))
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-delete-outside-')))
  temporaryDirectories.push(outside)
  await writeBlankMarker(outside, PROJECT_B)
  await writeFile(path.join(outside, 'must-survive.txt'), 'outside data')
  await rm(linkedPath, { recursive: true })
  await symlink(outside, linkedPath, 'dir')

  await assert.rejects(
    catalog.delete(PROJECT_B),
    (error: unknown) => error instanceof ProjectCatalogError
      && error.code === 'project_unavailable',
  )
  assert.equal((await lstat(linkedPath)).isSymbolicLink(), true)
  assert.equal(await readFile(path.join(outside, 'must-survive.txt'), 'utf8'), 'outside data')
  const listed = await catalog.list()
  assert.equal(listed.find((project) => project.id === PROJECT_A)?.state, 'unavailable')
  assert.equal(listed.find((project) => project.id === PROJECT_B)?.state, 'unavailable')
  await catalog.close()
})

test('catalog startup restores or cleans fixed interrupted-deletion tombstones', async () => {
  const root = await temporaryWorkspace()
  const catalog = new ProjectCatalog(root, { idFactory: () => PROJECT_A })
  const created = await catalog.create('恢复删除事务')
  const projectPath = path.join(root, ...created.projectDir.split('/'))
  const tombstonePath = path.join(catalog.projectsDir, `.deleting-${PROJECT_A}`)
  await catalog.close()

  // Crash before catalog commit: the catalog record is authoritative, so the
  // quarantined directory must be restored to its managed path.
  await rename(projectPath, tombstonePath)
  const beforeCommitRestart = new ProjectCatalog(root)
  const restored = await beforeCommitRestart.list()
  assert.equal(restored.find((project) => project.id === PROJECT_A)?.state, 'ready')
  assert.equal((await lstat(projectPath)).isDirectory(), true)
  await assert.rejects(
    lstat(tombstonePath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
  await beforeCommitRestart.close()

  // Crash after catalog commit: no record means the same tombstone is pending
  // cleanup, never a project to rediscover.
  await rename(projectPath, tombstonePath)
  const document = JSON.parse(await readFile(catalog.filePath, 'utf8')) as {
    schemaVersion: 1
    projects: Array<{ id: string }>
  }
  document.projects = document.projects.filter((record) => record.id !== PROJECT_A)
  await writeFile(catalog.filePath, `${JSON.stringify(document, null, 2)}\n`)

  const afterCommitRestart = new ProjectCatalog(root)
  assert.deepEqual((await afterCommitRestart.list()).map((project) => project.id), [])
  await assert.rejects(
    lstat(tombstonePath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
  await afterCommitRestart.close()
})
