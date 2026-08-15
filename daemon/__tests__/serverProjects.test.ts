import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { blankProjectCanvasInitializationMarker } from '../canvasInitialization.js'
import {
  ProjectCatalog,
  type WorkspaceProjectDescriptor,
} from '../projectCatalog.js'
import { createDaemonServer, type DaemonServer } from '../server.js'

const PROJECT_A = 'project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PROJECT_B = 'project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

interface ServerFixture {
  root: string
  daemon: DaemonServer
  baseUrl: string
  close(): Promise<void>
}

async function startServer(): Promise<ServerFixture & { setNow(value: number): void }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-server-projects-')))
  let now = Date.parse('2030-08-06T12:00:00.000Z')
  const ids = [PROJECT_A, PROJECT_B]
  const catalog = new ProjectCatalog(root, {
    now: () => now,
    idFactory: () => ids.shift() ?? PROJECT_B,
  })
  const daemon = createDaemonServer({ projectRoot: root, projectCatalog: catalog })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  return {
    root,
    daemon,
    baseUrl: `http://127.0.0.1:${address.port}`,
    setNow(value) {
      now = value
    },
    async close() {
      await daemon.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('project HTTP routes create, list, open, summarize, and isolate real Canvas projects', async () => {
  const fixture = await startServer()
  try {
    const initial = await requestJson(fixture.baseUrl, 'GET', '/projects') as {
      schemaVersion: number
      projects: WorkspaceProjectDescriptor[]
    }
    assert.deepEqual(Object.keys(initial).sort(), ['projects', 'schemaVersion'])
    assert.equal(initial.schemaVersion, 1)
    assert.deepEqual(initial.projects, [])
    assert.ok(await readFile(path.join(fixture.root, '.gg/workspace/runtime/daemon.lock'), 'utf8'))

    fixture.setNow(Date.parse('2030-08-06T13:00:00.000Z'))
    const createdAResponse = await requestJson(fixture.baseUrl, 'POST', '/projects', {
      title: '项目 A',
    }) as { schemaVersion: number; project: WorkspaceProjectDescriptor }
    assert.deepEqual(Object.keys(createdAResponse).sort(), ['project', 'schemaVersion'])
    assert.equal(createdAResponse.schemaVersion, 1)
    assertProjectShape(createdAResponse.project)
    assert.equal(createdAResponse.project.id, PROJECT_A)
    assert.equal(createdAResponse.project.projectDir, `.gg/workspace/projects/${PROJECT_A}`)
    assert.equal(createdAResponse.project.state, 'ready')
    assert.deepEqual(createdAResponse.project.summary, {
      taskCount: 0,
      nodeCount: 0,
      collectionCount: 0,
    })
    await assert.rejects(
      readFile(path.join(
        fixture.root,
        ...createdAResponse.project.projectDir.split('/'),
        '.gg/runtime/canvas-daemon.lock',
      )),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    )

    fixture.setNow(Date.parse('2030-08-06T14:00:00.000Z'))
    const createdBResponse = await requestJson(fixture.baseUrl, 'POST', '/projects', {
      title: '项目 B',
    }) as { project: WorkspaceProjectDescriptor }
    assert.equal(createdBResponse.project.id, PROJECT_B)

    await createTask(fixture.baseUrl, createdAResponse.project.projectDir, 'task-shared', 'A 内容')
    await createTask(fixture.baseUrl, createdBResponse.project.projectDir, 'task-shared', 'B 内容')
    const [canvasA, canvasB] = await Promise.all([
      getCanvas(fixture.baseUrl, createdAResponse.project.projectDir),
      getCanvas(fixture.baseUrl, createdBResponse.project.projectDir),
    ])
    assert.equal(canvasA.document.tasks[0]?.title, 'A 内容')
    assert.equal(canvasB.document.tasks[0]?.title, 'B 内容')

    const summarized = await requestJson(fixture.baseUrl, 'GET', '/projects') as {
      projects: WorkspaceProjectDescriptor[]
    }
    assert.equal(summarized.projects.find((project) => project.id === PROJECT_A)?.summary?.taskCount, 1)
    assert.equal(summarized.projects.find((project) => project.id === PROJECT_B)?.summary?.taskCount, 1)

    fixture.setNow(Date.parse('2030-08-06T15:00:00.000Z'))
    const opened = await requestJson(
      fixture.baseUrl,
      'POST',
      `/projects/${PROJECT_A}/open`,
    ) as { schemaVersion: number; project: WorkspaceProjectDescriptor }
    assert.equal(opened.schemaVersion, 1)
    assertProjectShape(opened.project)
    assert.equal(opened.project.lastOpenedAt, '2030-08-06T15:00:00.000Z')
    assert.equal(opened.project.summary?.taskCount, 1)
    const afterOpen = await requestJson(fixture.baseUrl, 'GET', '/projects') as {
      projects: WorkspaceProjectDescriptor[]
    }
    assert.equal(afterOpen.projects[0]?.id, PROJECT_A)
    assert.equal(
      afterOpen.projects.find((project) => project.id === PROJECT_B)?.lastOpenedAt,
      null,
    )
  } finally {
    await fixture.close()
  }
})

test('project deletion drains opened stores and old projectDir requests cannot recreate it', async () => {
  const fixture = await startServer()
  try {
    const created = await requestJson(fixture.baseUrl, 'POST', '/projects', {
      title: '待删除项目',
    }) as { project: WorkspaceProjectDescriptor }
    const project = created.project
    const projectPath = path.join(fixture.root, ...project.projectDir.split('/'))

    await requestJson(fixture.baseUrl, 'POST', `/projects/${project.id}/open`)
    await createTask(fixture.baseUrl, project.projectDir, 'task-before-delete', '删除前内容')

    const removed = await requestJson(
      fixture.baseUrl,
      'DELETE',
      `/projects/${project.id}`,
    ) as { schemaVersion: number; deletedProjectId: string }
    assert.deepEqual(removed, {
      schemaVersion: 1,
      deletedProjectId: project.id,
    })
    await assert.rejects(
      readFile(path.join(projectPath, '.gg/canvas-model.json')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    )

    const listed = await requestJson(fixture.baseUrl, 'GET', '/projects') as {
      projects: WorkspaceProjectDescriptor[]
    }
    assert.equal(listed.projects.some((entry) => entry.id === project.id), false)

    const reopen = await fetch(`${fixture.baseUrl}/projects/${project.id}/open`, {
      method: 'POST',
    })
    assert.equal(reopen.status, 404)
    assert.equal(
      (await reopen.json() as { error: { code: string } }).error.code,
      'project_not_found',
    )

    const staleCanvas = await fetch(
      `${fixture.baseUrl}/canvas?projectDir=${encodeURIComponent(project.projectDir)}&branch=main`,
    )
    assert.equal(staleCanvas.ok, false)
    await assert.rejects(
      readFile(path.join(projectPath, '.gg/canvas-model.json')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    )

    const legacyRootDelete = await fetch(
      `${fixture.baseUrl}/projects/project_root`,
      { method: 'DELETE' },
    )
    assert.equal(legacyRootDelete.status, 400)
    assert.equal(
      (await legacyRootDelete.json() as { error: { code: string } }).error.code,
      'invalid_project_id',
    )
    const legacyRootOpen = await fetch(
      `${fixture.baseUrl}/projects/project_root/open`,
      { method: 'POST' },
    )
    assert.equal(legacyRootOpen.status, 400)
    assert.equal(
      (await legacyRootOpen.json() as { error: { code: string } }).error.code,
      'invalid_project_id',
    )
    await assert.rejects(
      readFile(path.join(fixture.root, '.gg/canvas-model.json'), 'utf8'),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    )
  } finally {
    await fixture.close()
  }
})

test('project routes reject forged input and keep unavailable registered projects visible', async () => {
  const fixture = await startServer()
  try {
    const invalid = await fetch(`${fixture.baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '伪造', projectDir: '/tmp/escape' }),
    })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'invalid_project_request')

    const empty = await fetch(`${fixture.baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    assert.equal(empty.status, 400)
    assert.equal((await empty.json() as { error: { code: string } }).error.code, 'invalid_project_title')

    fixture.setNow(Date.parse('2030-08-06T13:00:00.000Z'))
    const created = await requestJson(fixture.baseUrl, 'POST', '/projects', { title: '会损坏' }) as {
      project: WorkspaceProjectDescriptor
    }
    const projectPath = path.join(fixture.root, ...created.project.projectDir.split('/'))
    await writeFile(
      path.join(projectPath, '.gg/canvas-model.json'),
      `${JSON.stringify(blankProjectCanvasInitializationMarker(
        PROJECT_B,
        '2030-08-06T13:00:00.000Z',
      ))}\n`,
    )

    const listed = await requestJson(fixture.baseUrl, 'GET', '/projects') as {
      projects: WorkspaceProjectDescriptor[]
    }
    const unavailable = listed.projects.find((project) => project.id === created.project.id)
    assert.equal(unavailable?.state, 'unavailable')
    assert.equal(unavailable?.summary, null)

    const cannotOpen = await fetch(`${fixture.baseUrl}/projects/${created.project.id}/open`, {
      method: 'POST',
    })
    assert.equal(cannotOpen.status, 409)
    assert.equal(
      (await cannotOpen.json() as { error: { code: string } }).error.code,
      'project_unavailable',
    )
    const unknown = await fetch(`${fixture.baseUrl}/projects/${PROJECT_B}/open`, {
      method: 'POST',
    })
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json() as { error: { code: string } }).error.code, 'project_not_found')

    await writeFile(path.join(fixture.root, '.gg/workspace/projects.json'), '{"broken":true}\n')
    const corruptCatalog = await fetch(`${fixture.baseUrl}/projects`)
    assert.equal(corruptCatalog.status, 409)
    assert.equal(
      (await corruptCatalog.json() as { error: { code: string } }).error.code,
      'project_catalog_corrupt',
    )
  } finally {
    await fixture.close()
  }
})

test('project catalog and blank project identity survive a daemon restart', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ggai-server-project-restart-')))
  let first: { daemon: DaemonServer; baseUrl: string } | null = null
  let reopened: { daemon: DaemonServer; baseUrl: string } | null = null
  try {
    first = await listenDaemon(root, new ProjectCatalog(root, {
      now: () => Date.parse('2030-08-06T13:00:00.000Z'),
      idFactory: () => PROJECT_A,
    }))
    const created = await requestJson(first.baseUrl, 'POST', '/projects', {
      title: '跨重启项目',
    }) as { project: WorkspaceProjectDescriptor }
    assert.equal(created.project.id, PROJECT_A)
    await first.daemon.close()
    first = null

    reopened = await listenDaemon(root, new ProjectCatalog(root, {
      now: () => Date.parse('2030-08-06T14:00:00.000Z'),
    }))
    const listed = await requestJson(reopened.baseUrl, 'GET', '/projects') as {
      projects: WorkspaceProjectDescriptor[]
    }
    assert.equal(listed.projects.some((project) => project.id === PROJECT_A), true)
    const opened = await requestJson(
      reopened.baseUrl,
      'POST',
      `/projects/${PROJECT_A}/open`,
    ) as { project: WorkspaceProjectDescriptor }
    assert.equal(opened.project.state, 'ready')
    assert.equal(opened.project.lastOpenedAt, '2030-08-06T14:00:00.000Z')
  } finally {
    await first?.daemon.close()
    await reopened?.daemon.close()
    await rm(root, { recursive: true, force: true })
  }
})

function assertProjectShape(project: WorkspaceProjectDescriptor | undefined): void {
  assert.ok(project)
  assert.deepEqual(Object.keys(project).sort(), [
    'createdAt',
    'id',
    'lastOpenedAt',
    'projectDir',
    'state',
    'summary',
    'title',
    'updatedAt',
  ])
}

async function requestJson(
  baseUrl: string,
  method: 'GET' | 'POST' | 'DELETE',
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const source = await response.text()
  assert.ok(response.ok, `${method} ${pathname}: ${response.status} ${source}`)
  return JSON.parse(source) as unknown
}

async function listenDaemon(
  root: string,
  projectCatalog: ProjectCatalog,
): Promise<{ daemon: DaemonServer; baseUrl: string }> {
  const daemon = createDaemonServer({ projectRoot: root, projectCatalog })
  await new Promise<void>((resolve, reject) => {
    daemon.server.once('error', reject)
    daemon.server.listen(0, '127.0.0.1', resolve)
  })
  const address = daemon.server.address() as AddressInfo
  return { daemon, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function createTask(
  baseUrl: string,
  projectDir: string,
  id: string,
  title: string,
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/canvas/commands?projectDir=${encodeURIComponent(projectDir)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'main',
        baseRevision: 0,
        mutationId: `create-${id}`,
        command: {
          type: 'CreateTask',
          task: {
            id,
            title,
            goal: `${title} goal`,
            anchor: { x: 100, y: 120 },
            origin: { kind: 'user' },
          },
        },
      }),
    },
  )
  const source = await response.text()
  assert.equal(response.status, 200, source)
}

async function getCanvas(baseUrl: string, projectDir: string): Promise<{
  document: { tasks: Array<{ title: string }> }
}> {
  const response = await fetch(
    `${baseUrl}/canvas?projectDir=${encodeURIComponent(projectDir)}&branch=main`,
  )
  const source = await response.text()
  assert.equal(response.status, 200, source)
  return JSON.parse(source) as { document: { tasks: Array<{ title: string }> } }
}
