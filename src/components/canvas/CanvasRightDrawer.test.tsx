// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import CanvasRightDrawer from './CanvasRightDrawer'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

async function renderHarness(onStagePointerDown = vi.fn()) {
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <div onPointerDown={onStagePointerDown}>
        <button type="button" onClick={() => setOpen(true)}>打开抽屉</button>
        {open && (
          <CanvasRightDrawer ariaLabel="运行过程" onClose={() => setOpen(false)}>
            <button type="button">第一个操作</button>
            <button type="button">最后一个操作</button>
          </CanvasRightDrawer>
        )}
      </div>
    )
  }

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Harness />)
    await Promise.resolve()
  })
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  trigger.focus()
  await act(async () => trigger.click())
  onStagePointerDown.mockClear()
  return { host: container, trigger, onStagePointerDown }
}

describe('Canvas right drawer', () => {
  it('traps forward and backward Tab navigation inside the modal drawer', async () => {
    const { host } = await renderHarness()
    const drawer = host.querySelector<HTMLElement>('[role="dialog"]')!
    const buttons = drawer.querySelectorAll<HTMLButtonElement>('button')
    const first = buttons[0]!
    const last = buttons[1]!

    last.focus()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(first)

    first.focus()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
      }))
    })
    expect(document.activeElement).toBe(last)
  })

  it('closes from the backdrop without starting a canvas gesture and restores focus', async () => {
    const { host, trigger, onStagePointerDown } = await renderHarness()
    const backdrop = host.querySelector<HTMLElement>(
      '[data-testid="canvas-right-drawer-backdrop"]',
    )!

    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(onStagePointerDown).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })
})
