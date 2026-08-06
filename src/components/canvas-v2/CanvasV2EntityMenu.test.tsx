// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import CanvasV2EntityMenu from './CanvasV2EntityMenu'

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
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function renderSubject() {
  const onAction = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(
    <CanvasV2EntityMenu
      label="分析节点菜单"
      items={[
        { id: 'edit', label: '编辑节点' },
        { id: 'duplicate', label: '复制节点', disabled: true },
        { id: 'delete', label: '删除节点', destructive: true },
      ]}
      onAction={onAction}
    />,
  ))
  return {
    trigger: required<HTMLButtonElement>('[aria-label="分析节点菜单"]'),
    onAction,
  }
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = container?.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function keyDown(element: Element, key: string, shiftKey = false) {
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  })))
}

function menuItems(): HTMLButtonElement[] {
  return [...required<HTMLElement>('[role="menu"]').querySelectorAll<HTMLButtonElement>(
    '[role="menuitem"]',
  )]
}

describe('CanvasV2EntityMenu', () => {
  it('opens from arrow keys and supports wrapped Arrow/Home/End navigation', () => {
    const { trigger } = renderSubject()
    act(() => trigger.focus())
    keyDown(trigger, 'ArrowDown')
    const [edit, duplicate, deleteItem] = menuItems()

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(edit)
    expect(duplicate?.disabled).toBe(true)

    keyDown(edit!, 'ArrowDown')
    expect(document.activeElement).toBe(deleteItem)
    keyDown(deleteItem!, 'ArrowDown')
    expect(document.activeElement).toBe(edit)
    keyDown(edit!, 'ArrowUp')
    expect(document.activeElement).toBe(deleteItem)
    keyDown(deleteItem!, 'Home')
    expect(document.activeElement).toBe(edit)
    keyDown(edit!, 'End')
    expect(document.activeElement).toBe(deleteItem)
  })

  it('opens at the last enabled item with ArrowUp and restores focus on Escape', () => {
    const { trigger } = renderSubject()
    act(() => trigger.focus())
    keyDown(trigger, 'ArrowUp')
    const items = menuItems()
    expect(document.activeElement).toBe(items[2])

    keyDown(items[2]!, 'Escape')

    expect(container?.querySelector('[role="menu"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on an outside pointer and restores the trigger focus', () => {
    const { trigger } = renderSubject()
    act(() => trigger.click())
    expect(document.activeElement).toBe(menuItems()[0])

    act(() => document.body.dispatchEvent(new Event('pointerdown', {
      bubbles: true,
      cancelable: true,
    })))

    expect(container?.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus before emitting a selected action', () => {
    const { trigger, onAction } = renderSubject()
    act(() => trigger.click())
    const deleteItem = menuItems()[2]!

    act(() => deleteItem.click())

    expect(onAction).toHaveBeenCalledWith('delete')
    expect(container?.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
