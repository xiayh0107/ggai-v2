// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { CanvasContext } from '@/canvas/hooks'
import type { CanvasEnvelope } from '@/canvas/daemonClient'
import { emptyCanvasDocument } from '@/canvas/model'
import { CanvasPersistence, MemoryCanvasPersistenceAdapter } from '@/canvas/persistence'
import { CanvasStore } from '@/canvas/store'
import { generatedContentHref } from '@/resources/resourceRoutes'
import CanvasShell, { type CanvasShellProps } from './CanvasShell'

vi.mock('./CanvasStage', () => ({
  default: () => createElement('div', { 'data-testid': 'mock-canvas-stage' }),
}))

const Shell = CanvasShell as ComponentType<CanvasShellProps>

class FailingOncePersistenceAdapter extends MemoryCanvasPersistenceAdapter {
  #failed = false

  override async readView(scopeKey: string) {
    if (!this.#failed) {
      this.#failed = true
      throw new Error('The requested version (1) is less than the existing version (2).')
    }
    return super.readView(scopeKey)
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('CanvasShell resource navigation', () => {
  it('links to the generated-content subview with the current project and branch', () => {
    expect(generatedContentHref(
      'project_11111111111111111111111111111111',
      'restore/one',
    )).toBe(
      '/resources/generated?project=project_11111111111111111111111111111111&branch=restore%2Fone',
    )
  })

  it('keeps implementation versions and raw branch names out of the persistent header', async () => {
    const projectId = 'project_11111111111111111111111111111111'
    const store = new CanvasStore({
      daemonBaseUrl: 'http://127.0.0.1:7380',
      scope: { projectDir: '/workspace/project', branch: 'main' },
      persistence: new CanvasPersistence({
        adapter: new MemoryCanvasPersistenceAdapter(),
      }),
      client: {
        getCanvas: async () => ({
          branch: 'main',
          revision: 0,
          updatedAt: '2026-08-10T00:00:00.000Z',
          lastMutationId: null,
          document: emptyCanvasDocument(),
        }),
        flushOutbox: async () => ({ status: 'flushed', acknowledged: 0, envelope: null }),
      },
    })
    await store.load()

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(
        MemoryRouter,
        null,
        createElement(
          CanvasContext.Provider,
          { value: store },
          createElement(
            Shell,
            { projectId, projectTitle: 'test4' } satisfies CanvasShellProps,
          ),
        ),
      ))
    })

    expect(host.textContent).toContain('test4')
    expect(host.querySelector('[aria-label="画布工作台"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="搜索与定位"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="节点管理"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="生成内容"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="历史记录"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="节点 Skills"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="新建节点"]')).toBeNull()
    expect(host.querySelector('header [aria-label="生成内容"]')).toBeNull()
    expect(host.querySelector('header [aria-label="历史记录"]')).toBeNull()
    expect(host.textContent).not.toContain('Canvas')
    expect(host.textContent).not.toContain('V2')
    expect(host.textContent).not.toContain('main')

    act(() => root.unmount())
    host.remove()
    store.dispose()
  })

  it('recovers from a browser persistence failure when the user retries', async () => {
    const store = new CanvasStore({
      daemonBaseUrl: 'http://127.0.0.1:7380',
      scope: { projectDir: '/workspace/project', branch: 'main' },
      persistence: new CanvasPersistence({
        adapter: new FailingOncePersistenceAdapter(),
      }),
      client: {
        getCanvas: async () => ({
          branch: 'main',
          revision: 0,
          updatedAt: '2026-08-10T00:00:00.000Z',
          lastMutationId: null,
          document: emptyCanvasDocument(),
        }),
        flushOutbox: async () => ({ status: 'flushed', acknowledged: 0, envelope: null }),
      },
    })
    await store.load()

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(
        MemoryRouter,
        null,
        createElement(
          CanvasContext.Provider,
          { value: store },
          createElement(
            Shell,
            { projectTitle: '恢复后的项目' } satisfies CanvasShellProps,
          ),
        ),
      ))
    })

    const alert = host.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('画布加载失败')
    expect(alert?.textContent).toContain(
      'The requested version (1) is less than the existing version (2).',
    )

    const retry = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('重试'))
    expect(retry).toBeDefined()
    await act(async () => {
      retry!.click()
      await vi.waitFor(() => {
        expect(store.getSnapshot().hydration.status).toBe('ready')
      })
    })

    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).toContain('恢复后的项目')

    act(() => root.unmount())
    host.remove()
    store.dispose()
  })

  it('keeps the Stage mounted during a background Canvas refresh', async () => {
    const pending = deferred<CanvasEnvelope>()
    let reads = 0
    const store = new CanvasStore({
      daemonBaseUrl: 'http://127.0.0.1:7380',
      scope: { projectDir: '/workspace/project', branch: 'main' },
      persistence: new CanvasPersistence({
        adapter: new MemoryCanvasPersistenceAdapter(),
      }),
      client: {
        getCanvas: async () => {
          reads += 1
          if (reads > 1) return pending.promise
          return {
            branch: 'main',
            revision: 1,
            updatedAt: '2026-08-10T00:00:00.000Z',
            lastMutationId: null,
            document: emptyCanvasDocument(),
          }
        },
        flushOutbox: async () => ({ status: 'flushed', acknowledged: 0, envelope: null }),
      },
    })
    await store.load()

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(createElement(
      MemoryRouter,
      null,
      createElement(
        CanvasContext.Provider,
        { value: store },
        createElement(Shell, { projectTitle: '刷新中的项目' }),
      ),
    )))

    let refresh!: Promise<void>
    act(() => {
      refresh = store.reload()
    })
    await vi.waitFor(() => expect(store.getSnapshot().refresh.status).toBe('refreshing'))
    expect(host.querySelector('[data-testid="mock-canvas-stage"]')).not.toBeNull()
    expect(host.textContent).not.toContain('正在打开画布')

    pending.resolve({
      branch: 'main',
      revision: 2,
      updatedAt: '2026-08-10T00:00:01.000Z',
      lastMutationId: null,
      document: emptyCanvasDocument(),
    })
    await act(async () => refresh)
    expect(host.querySelector('[data-testid="mock-canvas-stage"]')).not.toBeNull()

    act(() => root.unmount())
    host.remove()
    store.dispose()
  })
})
