// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeDefinitionApi } from '@/node-studio/client'
import { createBlankNodeStudioDefinition } from '@/node-studio/model'
import NodeStudio from './NodeStudio'

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

describe('NodeStudio', () => {
  it('frames custom nodes inside the platform lifecycle and ownership model', async () => {
    await renderStudio(nodeApi())

    expect(container?.textContent).toContain('节点在画布中的生命周期')
    expect(container?.textContent).toContain('控制归属')
    expect(container?.textContent).toContain('生成、权限和重试始终由所属 Task 控制')
    expect(container?.textContent).not.toContain('空态标题')
    expect(required('[data-testid="node-studio-platform-preview"] [data-node-shell="true"]'))
      .toBeTruthy()
  })

  it('applies a real Agent result as an uninstalled candidate without saving it', async () => {
    const candidate = {
      ...createBlankNodeStudioDefinition(new Date('2026-01-02T00:00:00.000Z')),
      id: '@local/research-table',
      label: '研究对照表',
      contentKind: 'table' as const,
      icon: 'table' as const,
      sampleContent: '指标,方案 A,方案 B\n成本,低,高',
    }
    const save = vi.fn<NodeDefinitionApi['save']>()
    const api = nodeApi({
      save,
      startAgent: vi.fn<NodeDefinitionApi['startAgent']>().mockResolvedValue('studio-run-1'),
      getAgentRun: vi.fn<NodeDefinitionApi['getAgentRun']>().mockResolvedValue({
        runId: 'studio-run-1',
        status: 'done',
        definition: candidate,
      }),
    })
    await renderStudio(api)

    setValue(required<HTMLTextAreaElement>('textarea[placeholder^="例如："]'), '做一个研究对照表')
    await act(async () => {
      button('让 Agent 设计').click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.startAgent).toHaveBeenCalledWith('做一个研究对照表', expect.any(Object))
    expect(required<HTMLInputElement>('input').value).toBe('自定义节点')
    expect(container?.textContent).toContain('Agent 已返回候选定义')
    expect(save).not.toHaveBeenCalled()

    act(() => button('应用候选').click())
    expect(required<HTMLInputElement>('input').value).toBe('研究对照表')
    expect(container?.textContent).toContain('指标')
    expect(required('[data-testid="node-studio-platform-preview"] [data-canvas-entity="node"]'))
      .toBeTruthy()
    expect(required('[data-node-template="table"]')).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })

  it('cancels an active Agent run without installing its output', async () => {
    const cancelAgentRun = vi.fn<NodeDefinitionApi['cancelAgentRun']>().mockResolvedValue()
    const api = nodeApi({
      startAgent: vi.fn<NodeDefinitionApi['startAgent']>().mockResolvedValue('studio-run-2'),
      getAgentRun: vi.fn<NodeDefinitionApi['getAgentRun']>().mockImplementation(
        () => new Promise(() => undefined),
      ),
      cancelAgentRun,
    })
    await renderStudio(api)

    setValue(required<HTMLTextAreaElement>('textarea[placeholder^="例如："]'), '设计一个图片节点')
    await act(async () => {
      button('让 Agent 设计').click()
      await Promise.resolve()
    })
    expect(container?.textContent).toContain('Agent 正在设计节点')

    await act(async () => {
      button('取消 Agent').click()
      await Promise.resolve()
    })
    expect(cancelAgentRun).toHaveBeenCalledWith('studio-run-2')
    expect(container?.textContent).not.toContain('Agent 正在设计节点')
    expect(api.save).not.toHaveBeenCalled()
  })
})

async function renderStudio(api: NodeDefinitionApi): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<MemoryRouter><NodeStudio api={api} /></MemoryRouter>)
    await Promise.resolve()
  })
}

function nodeApi(overrides: Partial<NodeDefinitionApi> = {}): NodeDefinitionApi {
  return {
    list: vi.fn<NodeDefinitionApi['list']>().mockResolvedValue([]),
    save: vi.fn<NodeDefinitionApi['save']>(),
    delete: vi.fn<NodeDefinitionApi['delete']>().mockResolvedValue(),
    startAgent: vi.fn<NodeDefinitionApi['startAgent']>(),
    getAgentRun: vi.fn<NodeDefinitionApi['getAgentRun']>(),
    cancelAgentRun: vi.fn<NodeDefinitionApi['cancelAgentRun']>().mockResolvedValue(),
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

function setValue(element: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
