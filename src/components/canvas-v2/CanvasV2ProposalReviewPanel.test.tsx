// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TrustedTaskProposalV2 } from '@/canvas-v2/commands'
import CanvasV2ProposalReviewPanel from './CanvasV2ProposalReviewPanel'

const proposals: TrustedTaskProposalV2[] = [
  {
    key: 'prepare',
    title: '整理数据',
    prompt: '清理并整理原始数据。',
    inputOutputKeys: ['raw-data'],
    dependsOn: [],
  },
  {
    key: 'explain',
    title: '解释结果',
    prompt: '解释整理后的数据结果。',
    inputOutputKeys: [],
    dependsOn: ['prepare'],
  },
  {
    key: 'publish',
    title: '发布报告',
    prompt: '生成最终发布报告。',
    inputOutputKeys: [],
    dependsOn: ['explain'],
  },
]

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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function renderSubject(settledProposalKeys: readonly string[] = []) {
  const onAccept = vi.fn()
  const onReject = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(
    <CanvasV2ProposalReviewPanel
      proposals={proposals}
      settledProposalKeys={settledProposalKeys}
      onAccept={onAccept}
      onReject={onReject}
    />,
  ))
  return { host: required<HTMLElement>('[data-testid="canvas-v2-proposal-review-panel"]'), onAccept, onReject }
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = container?.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function byTestId<ElementType extends Element>(testId: string): ElementType {
  return required<ElementType>(`[data-testid="${testId}"]`)
}

function click(element: HTMLElement) {
  act(() => element.click())
}

function setTextValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function dispatchDrag(source: HTMLElement, target: HTMLElement) {
  const values = new Map<string, string>()
  const dataTransfer = {
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => {
      values.set(type, value)
    },
  } as unknown as DataTransfer
  const dragStart = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
  act(() => {
    source.dispatchEvent(dragStart)
    target.dispatchEvent(drop)
  })
}

describe('CanvasV2ProposalReviewPanel', () => {
  it('accepts the full trusted proposal set without edits or automatic execution', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { host, onAccept, onReject } = renderSubject()

    expect(host.querySelectorAll('fieldset').length).toBeGreaterThan(3)
    expect(host.querySelectorAll('label').length).toBeGreaterThan(3)
    expect(host.querySelectorAll('button').length).toBeGreaterThan(2)
    expect(byTestId<HTMLElement>('proposal-validation').getAttribute('aria-live')).toBe('polite')
    for (const proposal of proposals) {
      expect(byTestId<HTMLInputElement>(`proposal-select-${proposal.key}`).checked).toBe(true)
    }

    click(byTestId<HTMLButtonElement>('proposal-accept'))

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onAccept).toHaveBeenCalledWith({
      proposalKeys: ['prepare', 'explain', 'publish'],
      edits: {},
    })
    expect(onReject).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('supports clearing, selecting all, and accepting a valid subset', () => {
    const { onAccept } = renderSubject()
    const accept = byTestId<HTMLButtonElement>('proposal-accept')

    click(byTestId<HTMLButtonElement>('proposal-clear-selection'))
    expect(accept.disabled).toBe(true)
    expect(byTestId<HTMLElement>('proposal-validation').textContent)
      .toContain('至少选择一个任务提案')

    click(byTestId<HTMLButtonElement>('proposal-select-all'))
    expect(accept.disabled).toBe(false)
    click(byTestId<HTMLInputElement>('proposal-select-publish'))
    expect(accept.disabled).toBe(false)
    click(accept)

    expect(onAccept).toHaveBeenCalledWith({
      proposalKeys: ['prepare', 'explain'],
      edits: {},
    })
  })

  it('returns only changed title and prompt fields for selected proposals', () => {
    const { onAccept } = renderSubject()
    setTextValue(byTestId<HTMLInputElement>('proposal-title-explain'), '撰写结论')
    setTextValue(
      byTestId<HTMLTextAreaElement>('proposal-prompt-explain'),
      '根据整理结果撰写清晰结论。',
    )

    click(byTestId<HTMLButtonElement>('proposal-accept'))

    expect(onAccept).toHaveBeenCalledWith({
      proposalKeys: ['prepare', 'explain', 'publish'],
      edits: {
        explain: {
          title: '撰写结论',
          prompt: '根据整理结果撰写清晰结论。',
        },
      },
    })
  })

  it('returns button and keyboard ordering in proposalKeys', () => {
    const { onAccept } = renderSubject()
    click(required<HTMLButtonElement>('[aria-label="将“发布报告”上移"]'))
    const handle = required<HTMLButtonElement>('[aria-label="拖动“发布报告”调整顺序"]')
    act(() => handle.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      altKey: true,
      bubbles: true,
      cancelable: true,
    })))

    click(byTestId<HTMLButtonElement>('proposal-accept'))

    expect(handle.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    expect(onAccept).toHaveBeenCalledWith({
      proposalKeys: ['publish', 'prepare', 'explain'],
      edits: {},
    })
  })

  it('supports drag ordering without changing proposal semantics', () => {
    const { onAccept } = renderSubject()
    const handle = required<HTMLButtonElement>('[aria-label="拖动“整理数据”调整顺序"]')
    const target = required<HTMLElement>('[data-proposal-key="publish"]')

    dispatchDrag(handle, target)
    click(byTestId<HTMLButtonElement>('proposal-accept'))

    expect(onAccept).toHaveBeenCalledWith({
      proposalKeys: ['explain', 'publish', 'prepare'],
      edits: {},
    })
  })

  it('emits dependency edits from the local proposal DAG', () => {
    const { onAccept } = renderSubject()
    click(byTestId<HTMLInputElement>('proposal-dependency-publish-explain'))
    click(byTestId<HTMLInputElement>('proposal-dependency-publish-prepare'))

    click(byTestId<HTMLButtonElement>('proposal-accept'))

    expect(onAccept).toHaveBeenCalledWith({
      proposalKeys: ['prepare', 'explain', 'publish'],
      edits: {
        publish: { dependsOn: ['prepare'] },
      },
    })
  })

  it('blocks self-dependencies and cycles with visible validation errors', () => {
    renderSubject()
    const accept = byTestId<HTMLButtonElement>('proposal-accept')
    const validation = byTestId<HTMLElement>('proposal-validation')

    click(byTestId<HTMLInputElement>('proposal-dependency-prepare-prepare'))
    expect(accept.disabled).toBe(true)
    expect(validation.textContent).toContain('不能依赖自身')
    click(byTestId<HTMLInputElement>('proposal-dependency-prepare-prepare'))

    click(byTestId<HTMLInputElement>('proposal-dependency-prepare-publish'))
    expect(accept.disabled).toBe(true)
    expect(validation.textContent).toContain('依赖关系存在循环')
  })

  it('blocks a selected proposal whose dependency is not selected', () => {
    renderSubject()
    click(byTestId<HTMLInputElement>('proposal-select-explain'))

    expect(byTestId<HTMLButtonElement>('proposal-accept').disabled).toBe(true)
    expect(byTestId<HTMLElement>('proposal-validation').textContent)
      .toContain('依赖的“解释结果”尚未选中')
  })

  it('rejects every unsettled key while excluding settled proposals', () => {
    const { host, onAccept, onReject } = renderSubject(['prepare'])
    expect(host.querySelector('[data-proposal-key="prepare"]')).toBeNull()
    click(byTestId<HTMLInputElement>('proposal-select-publish'))

    click(byTestId<HTMLButtonElement>('proposal-reject'))

    expect(onReject).toHaveBeenCalledWith(['explain', 'publish'])
    expect(onAccept).not.toHaveBeenCalled()
  })
})
