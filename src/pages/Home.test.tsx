// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkspaceProject } from '@/workspace/projectClient'
import Home, { CanvasProjectBootstrap } from './Home'

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
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

async function renderHome(health: unknown) {
  window.history.replaceState(
    null,
    '',
    '/canvas?project=project_0123456789abcdef0123456789abcdef',
  )
  const fetch = vi.fn(async () => new Response(JSON.stringify(health), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetch)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Home />)
  })
  return { host: container, fetch }
}

describe('Canvas Home entry', () => {
  it('rejects a missing project id instead of opening the configured root', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    window.history.replaceState(null, '', '/canvas')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<Home />))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('项目地址无效')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a malformed project URL without probing or mounting another project', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    window.history.replaceState(null, '', '/canvas?project=..%2Fother')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<Home />))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('项目地址无效')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks for an app restart when an obsolete daemon reports root initialization', async () => {
    const { host } = await renderHome({
      capabilities: { canvas: true },
      canvas: { schemaVersion: 2, initializationRequired: true },
    })

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('重启应用')
    expect(host.textContent).toContain('已退役的根项目启动协议')
  })
})

const READY_PROJECT: WorkspaceProject = {
  id: 'project_0123456789abcdef0123456789abcdef',
  title: '散点图研究',
  projectDir: '.gg/workspace/projects/project_0123456789abcdef0123456789abcdef',
  createdAt: '2026-08-06T12:00:00.000Z',
  updatedAt: '2026-08-06T12:00:00.000Z',
  lastOpenedAt: '2026-08-06T12:00:00.000Z',
  state: 'ready',
  summary: { taskCount: 1, nodeCount: 2, collectionCount: 0 },
}

describe('project-scoped Canvas entry', () => {
  it('resolves the catalog id before mounting project-scoped children', async () => {
    let resolveProject!: (project: WorkspaceProject) => void
    const open = vi.fn((...args: [string, AbortSignal?]) => {
      void args
      return new Promise<WorkspaceProject>((resolve) => {
        resolveProject = resolve
      })
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasProjectBootstrap client={{ open }} projectId={READY_PROJECT.id}>
          {(project) => <output>{project.projectDir}</output>}
        </CanvasProjectBootstrap>,
      )
    })

    expect(container.textContent).toContain('正在打开项目')
    expect(container.querySelector('output')).toBeNull()
    await act(async () => resolveProject(READY_PROJECT))

    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]?.[0]).toBe(READY_PROJECT.id)
    expect(container.querySelector('output')?.textContent).toBe(READY_PROJECT.projectDir)
  })

  it('does not mount a Canvas for an unavailable project and can retry opening', async () => {
    const open = vi.fn(async () => ({ ...READY_PROJECT, state: 'unavailable' as const }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasProjectBootstrap client={{ open }} projectId={READY_PROJECT.id}>
          {() => <output>mounted</output>}
        </CanvasProjectBootstrap>,
      )
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('项目目录当前不可用')
    expect(container.querySelector('output')).toBeNull()
    const retry = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('重试'))
    await act(async () => retry?.click())
    expect(open).toHaveBeenCalledTimes(2)
    expect(container.querySelector('output')).toBeNull()
  })

  it('does not mount a Canvas when open resolves a different project id', async () => {
    const open = vi.fn(async () => ({
      ...READY_PROJECT,
      id: 'project_ffffffffffffffffffffffffffffffff',
      projectDir: '.gg/workspace/projects/project_ffffffffffffffffffffffffffffffff',
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <CanvasProjectBootstrap client={{ open }} projectId={READY_PROJECT.id}>
          {() => <output>mounted</output>}
        </CanvasProjectBootstrap>,
      )
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('不匹配的数据')
    expect(container.querySelector('output')).toBeNull()
  })
})
