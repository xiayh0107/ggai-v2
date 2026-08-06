// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Home from './Home'

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
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

async function renderHome(health: unknown) {
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

describe('V2-only Home entry', () => {
  it('shows the exact reset command when the daemon reports a missing marker', async () => {
    const { host } = await renderHome({
      capabilities: { canvasModelV1: false, canvasModelV2: true },
      canvas: { model: 'v2', schemaVersion: 2, resetRequired: true },
    })

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'npm run canvas:v2:reset -- --apply',
    )
    expect(host.textContent).toContain('缺少 Canvas V2 初始化标记')
  })

  it('blocks an explicitly selected V1 diagnostic daemon without rendering V1 UI', async () => {
    const { host } = await renderHome({
      capabilities: { canvasModelV1: true, canvasModelV2: false },
      canvas: { model: 'v1', schemaVersion: 1, resetRequired: false },
    })

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('V1 归档诊断模式')
    expect(host.textContent).not.toContain('正在恢复画布')
    expect(host.textContent).not.toContain('版本的检查点恢复')
  })
})
