// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  WorkspaceProjectClient,
  WorkspaceProjectProtocolError,
  type WorkspaceProject,
  type WorkspaceProjectApi,
} from '@/workspace/projectClient'
import Workspace from './Workspace'

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
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe('Workspace', () => {
  it('loads real projects and refreshes them when the page regains focus', async () => {
    let resolveFirst!: (projects: WorkspaceProject[]) => void
    const first = new Promise<WorkspaceProject[]>((resolve) => {
      resolveFirst = resolve
    })
    const list = vi.fn<WorkspaceProjectApi['list']>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce([project({
        id: 'project_22222222222222222222222222222222',
        title: '聚焦后项目',
      })])
    const api = projectApi({ list })

    await renderWorkspace(api)
    expect(required('[role="status"]').textContent).toContain('正在加载项目')

    await act(async () => {
      resolveFirst([project({ title: '真实项目', summary: {
        taskCount: 3,
        nodeCount: 7,
        collectionCount: 2,
      } })])
      await first
    })

    expect(container?.textContent).toContain('真实项目')
    expect(container?.textContent).toContain('3')
    expect(container?.textContent).toContain('7')
    expect(container?.textContent).not.toContain('线粒体自噬机制图')
    expect(required<HTMLAnchorElement>(
      'a[href="/canvas?project=project_11111111111111111111111111111111"]',
    ).href).toContain('/canvas?project=project_11111111111111111111111111111111')

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(list).toHaveBeenCalledTimes(2)
    expect(container?.textContent).toContain('聚焦后项目')
    expect(container?.textContent).not.toContain('真实项目')
  })

  it('creates a named project and navigates with its encoded project id', async () => {
    const created = project({
      id: 'project_33333333333333333333333333333333',
      title: '新实验项目',
    })
    const create = vi.fn<WorkspaceProjectApi['create']>().mockResolvedValue(created)
    const api = projectApi({
      list: vi.fn<WorkspaceProjectApi['list']>().mockResolvedValue([]),
      create,
    })
    await renderWorkspace(api)

    click(button('新建项目'))
    const dialog = required('[role="dialog"]')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    setInputValue(required<HTMLInputElement>('#workspace-project-title'), '  新实验项目  ')

    await act(async () => {
      button('创建并打开').click()
      await Promise.resolve()
    })

    expect(create).toHaveBeenCalledWith('新实验项目', expect.any(AbortSignal))
    expect(required('[data-testid="location"]').textContent)
      .toBe('/canvas?project=project_33333333333333333333333333333333')
  })

  it('filters projects by their real title', async () => {
    await renderWorkspace(projectApi({
      list: vi.fn<WorkspaceProjectApi['list']>().mockResolvedValue([
        project({ id: 'project_44444444444444444444444444444444', title: '单细胞图谱' }),
        project({ id: 'project_55555555555555555555555555555555', title: '碳排放分析' }),
      ]),
    }))

    setInputValue(required<HTMLInputElement>('input[placeholder="搜索项目名称"]'), '碳排放')
    expect(container?.textContent).toContain('碳排放分析')
    expect(container?.textContent).not.toContain('单细胞图谱')
  })

  it('shows an actionable load error and a real empty state after retry', async () => {
    const list = vi.fn<WorkspaceProjectApi['list']>()
      .mockRejectedValueOnce(new Error('daemon 暂时不可用'))
      .mockResolvedValueOnce([])
    await renderWorkspace(projectApi({ list }))

    expect(required('[role="alert"]').textContent).toContain('项目列表暂时无法加载')
    expect(required('[role="alert"]').textContent).not.toContain('daemon 暂时不可用')
    await act(async () => {
      button('重试').click()
      await Promise.resolve()
    })
    expect(container?.textContent).toContain('还没有项目')
    expect(container?.textContent).toContain('创建第一个项目')
  })

  it('shows an explicit team empty state instead of reusing personal projects', async () => {
    await renderWorkspace(projectApi({
      list: vi.fn<WorkspaceProjectApi['list']>().mockResolvedValue([
        project({ title: '只属于个人的项目' }),
      ]),
    }))

    click(button('团队项目'))
    expect(container?.textContent).toContain('团队项目尚未启用')
    expect(container?.textContent).not.toContain('只属于个人的项目')
  })

  it('renders an unavailable project as status content instead of a navigable link', async () => {
    const unavailable = project({
      id: 'project_66666666666666666666666666666666',
      title: '暂不可用项目',
      state: 'unavailable',
      summary: null,
    })
    await renderWorkspace(projectApi({
      list: vi.fn<WorkspaceProjectApi['list']>().mockResolvedValue([unavailable]),
    }))

    expect(container?.textContent).toContain('暂不可用项目')
    expect(container?.textContent).toContain('暂时不可用')
    expect(container?.querySelector(`a[href="/canvas?project=${unavailable.id}"]`)).toBeNull()
  })

  it('rejects project responses that drift from the strict protocol', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      projects: [{ ...project(), unexpected: true }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = new WorkspaceProjectClient({ baseUrl: 'http://daemon.test', fetch })

    await expect(client.list()).rejects.toBeInstanceOf(WorkspaceProjectProtocolError)
  })
})

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  const id = overrides.id ?? 'project_11111111111111111111111111111111'
  return {
    id,
    title: '项目一',
    projectDir: id === 'project_root' ? '.' : `.gg/workspace/projects/${id}`,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-05T10:00:00.000Z',
    lastOpenedAt: '2026-08-05T10:30:00.000Z',
    state: 'ready',
    summary: { taskCount: 1, nodeCount: 2, collectionCount: 0 },
    ...overrides,
  }
}

function projectApi(overrides: Partial<WorkspaceProjectApi> = {}): WorkspaceProjectApi {
  return {
    list: async () => [],
    create: async (title) => project({ title }),
    open: async (id) => project({ id }),
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

async function renderWorkspace(api: WorkspaceProjectApi) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Workspace projectClient={api} />} />
          <Route path="/canvas" element={<p>Canvas</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    )
    await Promise.resolve()
  })
}

function required<ElementType extends Element = HTMLElement>(selector: string): ElementType {
  const element = container?.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function button(label: string): HTMLButtonElement {
  const match = [...(container?.querySelectorAll('button') ?? [])]
    .find((candidate) => candidate.textContent?.includes(label))
  if (!match) throw new Error(`Missing button ${label}`)
  return match
}

function click(element: HTMLElement) {
  act(() => element.click())
}

function setInputValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
