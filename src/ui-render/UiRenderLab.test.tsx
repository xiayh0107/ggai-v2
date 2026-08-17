// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import UiRenderLab from './UiRenderLab'

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
})

describe('UI render lab', () => {
  it('organizes real render scenarios by journey and exposes state ownership', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root?.render(<UiRenderLab />))

    expect(container.querySelector('[data-testid="ui-render-lab"]')).toBeTruthy()
    expect(container.textContent).toContain('节点生成生命周期')
    expect(container.textContent).toContain('Task 控制生成')
    expect(container.textContent).toContain('控制归属')
    expect(container.textContent).toContain('自动契约')
    const preview = container.querySelector<HTMLIFrameElement>('iframe')
    expect(preview?.src).toContain('scenario=node-lifecycle-empty')
  })
})
