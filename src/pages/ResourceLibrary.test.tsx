// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  ProjectArtifactCatalogApi,
  ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'
import type { WorkspaceProject, WorkspaceProjectApi } from '@/workspace/projectClient'
import type { SkillAssetApi } from '@/skills/client'
import ResourceLibrary, { ResourceLibraryContent } from './ResourceLibrary'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe('ResourceLibraryContent', () => {
  it('lists Run-owned resources independently of Canvas nodes and opens the shared viewer', async () => {
    const artifact = resource()
    const api = artifactApi({
      list: vi.fn<ProjectArtifactCatalogApi['list']>().mockResolvedValue({
        schemaVersion: 2,
        artifacts: [artifact],
        truncated: false,
        partial: false,
        nextCursor: null,
      }),
    })
    await renderLibrary(api)

    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: project.projectDir,
      limit: 60,
      signal: expect.any(AbortSignal),
    }))
    expect(container?.textContent).toContain('preview.png')
    expect(container?.textContent).toContain('生成内容')
    expect(container?.textContent).toContain('资源中心')
    expect(container?.textContent).toContain('从画布移除节点只会移除画布上的引用')
    expect(container?.textContent).toContain('查看和下载')
    expect(container?.textContent).not.toContain('task-1')
    expect(required('button[aria-label="预览 preview.png"]')).toBeTruthy()

    act(() => button('preview.png').click())
    expect(required('[data-testid="canvas-artifact-viewer"]')).toBeTruthy()
    expect(required('[role="dialog"]').getAttribute('aria-label')).toContain('preview.png')
    expect(container?.querySelector('[data-testid="canvas-viewer-toolbar"]')).toBeNull()
  })

  it('shows an honest empty state and partial catalog notice', async () => {
    const api = artifactApi({
      list: vi.fn<ProjectArtifactCatalogApi['list']>()
        .mockResolvedValueOnce({
          schemaVersion: 2,
          artifacts: [],
          truncated: false,
          partial: false,
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          schemaVersion: 2,
          artifacts: [resource()],
          truncated: true,
          partial: true,
          nextCursor: 'cursor_more',
        }),
    })
    await renderLibrary(api)
    expect(container?.textContent).toContain('还没有项目资源')

    await act(async () => {
      button('刷新').click()
      await Promise.resolve()
    })
    expect(container?.textContent).toContain('部分资源不完整或未通过完整性检查')
    expect(container?.textContent).toContain('还有更多较早资源')
  })

  it('loads the next cursor page and appends resources without duplicates', async () => {
    const first = resource()
    const second = resource({
      runId: 'run-2',
      artifactId: `artifact_${'c'.repeat(64)}`,
      relativePath: 'notes/result.txt',
      mediaType: 'text/plain',
    })
    const list = vi.fn<ProjectArtifactCatalogApi['list']>()
      .mockResolvedValueOnce({
        schemaVersion: 2,
        artifacts: [first],
        truncated: true,
        partial: false,
        nextCursor: 'cursor_page_2',
      })
      .mockResolvedValueOnce({
        schemaVersion: 2,
        artifacts: [first, second],
        truncated: false,
        partial: false,
        nextCursor: null,
      })
    const api = artifactApi({ list })
    await renderLibrary(api)

    await act(async () => {
      button('加载更多').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({
      projectDir: project.projectDir,
      limit: 60,
      cursor: 'cursor_page_2',
      signal: expect.any(AbortSignal),
    }))
    expect(container?.textContent).toContain('preview.png')
    expect(container?.textContent).toContain('result.txt')
    expect(container?.querySelectorAll('li')).toHaveLength(2)
    expect(() => button('加载更多')).toThrow('Missing button 加载更多')
  })
})

describe('ResourceLibrary routing and information architecture', () => {
  it('opens a workspace-level resource center without a project id', async () => {
    window.history.replaceState({}, '', '/resources')
    const client = projectApi({
      list: vi.fn<WorkspaceProjectApi['list']>().mockResolvedValue([project]),
    })
    await renderResourceRoute(client)

    expect(client.list).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(client.open).not.toHaveBeenCalled()
    expect(container?.textContent).toContain('资源中心')
    expect(container?.textContent).toContain('文件与数据')
    expect(container?.textContent).toContain('生成内容')
    expect(container?.textContent).toContain('项目文件')
    expect(container?.textContent).toContain('同步')
    expect(container?.textContent).toContain('文件系统')
    expect(container?.textContent).toContain('节点能力')
    expect(container?.textContent).toContain('节点工作台')
    expect(container?.textContent).toContain('任务 Skills')
    expect(container?.textContent).toContain('进入节点工作台')
    expect(container?.textContent).toContain('计算与部署')
    expect(container?.textContent).toContain('计算集群')
    expect(container?.textContent).toContain('服务器')
    expect(container?.textContent).toContain('规划中')
    expect(required<HTMLAnchorElement>('a[href="/node-studio"]')).toBeTruthy()
    expect(required<HTMLAnchorElement>('a[href="/resources/skills"]')).toBeTruthy()
    expect(required<HTMLAnchorElement>(
      `a[href="/resources/generated?project=${project.id}"]`,
    ).textContent).toContain(project.title)
  })

  it('keeps the resource domains visible when no project exists', async () => {
    window.history.replaceState({}, '', '/resources')
    await renderResourceRoute(projectApi({
      list: vi.fn<WorkspaceProjectApi['list']>().mockResolvedValue([]),
    }))

    expect(container?.textContent).not.toContain('资源库无法打开')
    expect(container?.textContent).toContain('还没有可用项目')
    expect(container?.textContent).toContain('节点工作台')
    expect(container?.textContent).toContain('计算与部署')
  })

  it('keeps legacy project links on the generated-content subview', async () => {
    window.history.replaceState({}, '', `/resources?project=${project.id}`)
    const api = artifactApi({
      list: vi.fn<ProjectArtifactCatalogApi['list']>().mockResolvedValue({
        schemaVersion: 2,
        artifacts: [resource()],
        truncated: false,
        partial: false,
        nextCursor: null,
      }),
    })
    const client = projectApi()
    await renderResourceRoute(client, api)

    expect(client.open).toHaveBeenCalledWith(project.id, expect.any(AbortSignal))
    expect(container?.textContent).toContain('项目生成内容')
    expect(container?.textContent).toContain('preview.png')
  })

  it('preserves an explicit Canvas branch in generated-content reads and return links', async () => {
    window.history.replaceState(
      {},
      '',
      `/resources/generated?project=${project.id}&branch=restore-1b46c90d`,
    )
    const api = artifactApi({
      list: vi.fn<ProjectArtifactCatalogApi['list']>().mockResolvedValue({
        schemaVersion: 2,
        artifacts: [],
        truncated: false,
        partial: false,
        nextCursor: null,
      }),
    })
    await renderResourceRoute(projectApi(), api)

    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: project.projectDir,
      branch: 'restore-1b46c90d',
    }))
    expect(required<HTMLAnchorElement>(
      `a[href="/canvas?project=${project.id}&branch=restore-1b46c90d"]`,
    ).textContent).toContain('返回画布')
  })

  it('opens the workspace Skill resource manager without selecting a project', async () => {
    window.history.replaceState({}, '', '/resources/skills')
    const client = projectApi()
    const skillApi = skillAssetApi()
    await renderResourceRoute(client, artifactApi(), skillApi)

    expect(skillApi.list).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(client.list).not.toHaveBeenCalled()
    expect(client.open).not.toHaveBeenCalled()
    expect(container?.textContent).toContain('任务 Skills')
    expect(container?.textContent).toContain('节点的专属任务能力')
  })
})

async function renderLibrary(api: ProjectArtifactCatalogApi): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ResourceLibraryContent project={project} api={api} />
      </MemoryRouter>,
    )
    await Promise.resolve()
  })
}

async function renderResourceRoute(
  projectClient: Pick<WorkspaceProjectApi, 'list' | 'open'>,
  api = artifactApi(),
  skillApi?: SkillAssetApi,
): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ResourceLibrary projectClient={projectClient} artifactApi={api} skillApi={skillApi} />
      </MemoryRouter>,
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function skillAssetApi(): SkillAssetApi {
  return {
    list: vi.fn<SkillAssetApi['list']>().mockResolvedValue({
      schemaVersion: 1,
      assets: [],
      typeBindings: [],
    }),
    import: vi.fn<SkillAssetApi['import']>(),
    archive: vi.fn<SkillAssetApi['archive']>(),
    updateTypeBindings: vi.fn<SkillAssetApi['updateTypeBindings']>(),
  }
}

const project: WorkspaceProject = {
  id: 'project_11111111111111111111111111111111',
  title: '测试项目',
  projectDir: '.gg/workspace/projects/project_11111111111111111111111111111111',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  lastOpenedAt: null,
  state: 'ready',
  summary: null,
}

function artifactApi(overrides: Partial<ProjectArtifactCatalogApi> = {}): ProjectArtifactCatalogApi {
  return {
    list: vi.fn<ProjectArtifactCatalogApi['list']>(),
    artifactUrl: vi.fn<ProjectArtifactCatalogApi['artifactUrl']>(
      (_projectDir, artifact) => `http://daemon.test/runs/${artifact.runId}/artifacts/${artifact.artifactId}`,
    ),
    ...overrides,
  }
}

function projectApi(
  overrides: Partial<Pick<WorkspaceProjectApi, 'list' | 'open'>> = {},
): Pick<WorkspaceProjectApi, 'list' | 'open'> {
  return {
    list: vi.fn<WorkspaceProjectApi['list']>().mockResolvedValue([project]),
    open: vi.fn<WorkspaceProjectApi['open']>().mockResolvedValue(project),
    ...overrides,
  }
}

function resource(overrides: Partial<ProjectArtifactResource> = {}): ProjectArtifactResource {
  return {
    runId: 'run-1',
    artifactId: `artifact_${'a'.repeat(64)}`,
    taskId: 'task-1',
    canvasBranch: 'main',
    relativePath: 'images/preview.png',
    mediaType: 'image/png',
    size: 1_024,
    contentDigest: 'b'.repeat(64),
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function required<T extends Element = HTMLElement>(selector: string): T {
  const element = container?.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function button(label: string): HTMLButtonElement {
  const element = [...(container?.querySelectorAll('button') ?? [])]
    .find((candidate) => candidate.textContent?.trim().includes(label))
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`)
  return element
}
