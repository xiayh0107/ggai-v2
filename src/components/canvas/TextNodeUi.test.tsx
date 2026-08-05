// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CanvasCtx, useCanvasStore, type CanvasStore } from '@/hooks/useCanvasStore'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import type { GenerationPanelState } from '@/agent/generationProgress'
import type { CanvasNode, Edge } from '@/types/canvas'
import InstructionPanel from './InstructionPanel'
import NodeCard from './NodeCard'
import CanvasStage from './CanvasStage'

const idleNode: CanvasNode = {
  id: 'text-1',
  type: 'text',
  x: 120,
  y: 140,
  w: 320,
  h: 180,
  title: '文本',
  instruction: {
    phase: 'idle',
    prompt: '',
    attachments: [],
    sources: [],
    open: true,
  },
  payload: {},
}

interface HarnessProps {
  node: CanvasNode
  /** 画布上的其他节点（如来源节点），供指令面板解析 sources */
  extraNodes?: CanvasNode[]
  edges?: Edge[]
  progress?: GenerationPanelState
  onCancel?: () => void
  onUpdateInstruction?: CanvasStore['updateInstruction']
  children: React.ReactNode
}

function Harness({ node, extraNodes = [], edges = [], progress, onCancel, onUpdateInstruction, children }: HarnessProps) {
  const liveStore = useCanvasStore()
  const store = {
    ...liveStore,
    nodes: [node, ...extraNodes],
    edges,
    selectedId: node.id,
    selectedIds: [node.id],
    generationByNodeId: progress ? { [node.id]: progress } : {},
    cancelInstruction: onCancel ?? liveStore.cancelInstruction,
    updateInstruction: onUpdateInstruction ?? liveStore.updateInstruction,
  }
  return <CanvasCtx.Provider value={store}>{children}</CanvasCtx.Provider>
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(ui: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(ui))
}

beforeAll(() => {
  registerBuiltinPlugins()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe('text generation node UI', () => {
  it('does not render preset instruction chips on an empty first node', async () => {
    await render(
      <Harness node={idleNode}>
        <InstructionPanel node={idleNode} sx={300} sy={400} />
      </Harness>,
    )

    expect(container?.textContent).not.toContain('改写')
    expect(container?.textContent).not.toContain('缩短')
    expect(container?.textContent).not.toContain('扩写')
    expect(container?.textContent).not.toContain('生成标题')
  })

  it('shows preset instruction chips once the node has generated content', async () => {
    const doneNode: CanvasNode = {
      ...idleNode,
      text: '前路虽远，步履不停，终抵星辰。',
      instruction: { ...idleNode.instruction, phase: 'done', open: true },
    }
    await render(
      <Harness node={doneNode}>
        <InstructionPanel node={doneNode} sx={300} sy={400} />
      </Harness>,
    )

    for (const action of ['改写', '缩短', '扩写', '改变语气', '生成标题']) {
      expect(container?.textContent).toContain(action)
    }
  })

  it('shows source-driven preset chips when a new node references a generated node', async () => {
    const sourceNode: CanvasNode = {
      ...idleNode,
      id: 'text-source',
      title: '文本',
      text: '长路漫漫，惟行不止。',
      instruction: { ...idleNode.instruction, phase: 'done', open: false },
    }
    const newNode: CanvasNode = {
      ...idleNode,
      id: 'text-new',
      instruction: { ...idleNode.instruction, sources: [] },
    }
    const updateInstruction = vi.fn()
    await render(
      <Harness
        node={newNode}
        extraNodes={[sourceNode]}
        edges={[{ id: 'edge-source', from: sourceNode.id, to: newNode.id, label: '来源于' }]}
        onUpdateInstruction={updateInstruction}
      >
        <InstructionPanel node={newNode} sx={300} sy={400} />
      </Harness>,
    )

    for (const action of ['改写', '缩短', '扩写', '改变语气', '生成标题']) {
      expect(container?.textContent).toContain(action)
    }

    // 点击预设指令即填入输入框
    const chip = [...(container?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === '扩写')
    await act(async () => chip?.click())
    expect(updateInstruction).toHaveBeenCalledWith('text-new', { prompt: '扩写' })
  })

  it('prefers Agent suggestions and fills their prompt instead of their label', async () => {
    const node: CanvasNode = {
      ...idleNode,
      text: '季度收入增长 18%，客户留存率下降。',
      instruction: {
        ...idleNode.instruction,
        phase: 'done',
        suggestedActions: {
          runId: 'run-quarterly',
          actions: [{
            id: 'extract-kpi',
            label: '提取 KPI',
            prompt: '把这份季度总结整理成 KPI 表格，并标注风险项。',
          }],
        },
      },
    }
    const updateInstruction = vi.fn()
    await render(
      <Harness node={node} onUpdateInstruction={updateInstruction}>
        <InstructionPanel node={node} sx={300} sy={400} />
      </Harness>,
    )

    expect(container?.textContent).toContain('提取 KPI')
    expect(container?.textContent).not.toContain('改写')
    const chip = [...(container?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === '提取 KPI')
    await act(async () => chip?.click())
    expect(updateInstruction).toHaveBeenCalledWith(node.id, {
      prompt: '把这份季度总结整理成 KPI 表格，并标注风险项。',
    })
  })

  it('treats an empty Agent suggestion list as authoritative instead of falling back', async () => {
    const node: CanvasNode = {
      ...idleNode,
      text: '已完成的内容',
      instruction: {
        ...idleNode.instruction,
        phase: 'done',
        suggestedActions: { runId: 'run-no-next-step', actions: [] },
      },
    }
    await render(
      <Harness node={node}>
        <InstructionPanel node={node} sx={300} sy={400} />
      </Harness>,
    )

    expect(container?.textContent).not.toContain('改写')
  })

  it('uses the footer as a concise, expandable generation process', async () => {
    const cancel = vi.fn()
    const node: CanvasNode = {
      ...idleNode,
      instruction: {
        ...idleNode.instruction,
        phase: 'generating',
        prompt: '写一句简短的话',
        open: false,
      },
    }
    const progress: GenerationPanelState = {
      epoch: 3,
      recent: [
        { key: 'connecting', kind: 'connecting', label: '正在连接 Agent' },
        { key: 'thinking', kind: 'thinking', label: '正在理解任务' },
      ],
      current: { key: 'writing', kind: 'writing', label: '正在生成文本' },
      log: [
        { kind: 'thinking', text: 'I will draft a short uplifting sentence.' },
        { kind: 'output', text: '前路虽远，' },
      ],
    }

    await render(
      <Harness node={node} progress={progress} onCancel={cancel}>
        <NodeCard
          node={node}
          selected
          onDragStart={() => {}}
          onPortDown={() => {}}
          onResizeStart={() => {}}
        />
      </Harness>,
    )

    expect(container?.textContent).toContain('生成中')
    expect(container?.textContent).toContain('正在生成文本')
    expect(container?.textContent).not.toContain('提示词')
    expect(container?.textContent).not.toContain('附件')
    expect(container?.textContent).not.toContain('来源')
    expect(container?.querySelector('[aria-label="生成过程"]')).toBeNull()

    const expand = container?.querySelector<HTMLButtonElement>('[aria-label="展开生成过程"]')
    await act(async () => expand?.click())

    expect(container?.querySelector('[aria-label="生成过程"]')).not.toBeNull()
    expect(container?.textContent).toContain('正在连接 Agent')
    expect(container?.textContent).toContain('正在理解任务')
    // 默认不展示原始日志
    expect(container?.textContent).not.toContain('I will draft a short uplifting sentence.')

    // 切到「原始日志」：展示 Agent 原始思考与流式输出
    const logTab = [...(container?.querySelectorAll<HTMLButtonElement>('button[role="tab"]') ?? [])]
      .find((button) => button.textContent === '原始日志')
    await act(async () => logTab?.click())

    expect(container?.querySelector('[aria-label="原始日志"]')).not.toBeNull()
    expect(container?.textContent).toContain('I will draft a short uplifting sentence.')
    expect(container?.textContent).toContain('前路虽远，')

    const cancelButton = container?.querySelector<HTMLButtonElement>('[title="取消生成"]')
    await act(async () => cancelButton?.click())
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('keeps the completed footer free of prompt and source counters', async () => {
    const node: CanvasNode = {
      ...idleNode,
      instruction: {
        ...idleNode.instruction,
        phase: 'done',
        prompt: '写一句简短的话',
        attachments: ['brief.pdf'],
        sources: ['source-1'],
        open: false,
      },
    }

    await render(
      <Harness node={node}>
        <NodeCard
          node={node}
          selected
          onDragStart={() => {}}
          onPortDown={() => {}}
          onResizeStart={() => {}}
        />
      </Harness>,
    )

    expect(container?.textContent).toContain('已完成')
    expect(container?.textContent).not.toContain('提示词')
    expect(container?.textContent).not.toContain('附件')
    expect(container?.textContent).not.toContain('来源')
  })

  it('keeps run details reviewable from the completed footer', async () => {
    const node: CanvasNode = {
      ...idleNode,
      instruction: {
        ...idleNode.instruction,
        phase: 'done',
        prompt: '写一句简短的话',
        open: false,
      },
    }
    const progress: GenerationPanelState = {
      epoch: 5,
      recent: [
        { key: 'connecting', kind: 'connecting', label: '正在连接 Agent' },
        { key: 'thinking', kind: 'thinking', label: '正在理解任务' },
      ],
      current: { key: 'writing', kind: 'writing', label: '正在生成文本' },
      log: [
        { kind: 'thinking', text: 'I will draft a short uplifting sentence.' },
        { kind: 'output', text: '前路虽远，行则将至。' },
      ],
    }

    await render(
      <Harness node={node} progress={progress}>
        <NodeCard
          node={node}
          selected
          onDragStart={() => {}}
          onPortDown={() => {}}
          onResizeStart={() => {}}
        />
      </Harness>,
    )

    // 完成后默认收起，但详情入口保留在「已完成」底栏上
    expect(container?.textContent).toContain('已完成')
    expect(container?.querySelector('[aria-label="生成过程"]')).toBeNull()

    const expand = container?.querySelector<HTMLButtonElement>('[aria-label="展开生成过程"]')
    await act(async () => expand?.click())

    // 展开后可回顾本次运行的生成过程；终态不再显示进行中的高亮步骤
    expect(container?.querySelector('[aria-label="生成过程"]')).not.toBeNull()
    expect(container?.textContent).toContain('正在连接 Agent')
    expect(container?.textContent).toContain('正在理解任务')
    expect(container?.querySelector('.animate-spin')).toBeNull()

    // 原始日志页签保留 Agent 的思考与流式输出
    const logTab = [...(container?.querySelectorAll<HTMLButtonElement>('button[role="tab"]') ?? [])]
      .find((button) => button.textContent === '原始日志')
    await act(async () => logTab?.click())
    expect(container?.textContent).toContain('I will draft a short uplifting sentence.')
    expect(container?.textContent).toContain('前路虽远，行则将至。')
  })

  it('opens the instruction panel when clicking a node without dragging', async () => {
    const updateInstruction = vi.fn()
    const node: CanvasNode = {
      ...idleNode,
      instruction: {
        ...idleNode.instruction,
        phase: 'done',
        prompt: '写一句简短的话',
        open: false,
      },
    }

    await render(
      <Harness node={node} onUpdateInstruction={updateInstruction}>
        <CanvasStage />
      </Harness>,
    )
    const card = container?.querySelector('[data-node-id]')
    expect(card).not.toBeNull()

    // 原地点击（down + up 无位移）→ 弹出指令面板，支持连续提示
    await act(async () => {
      card?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 300, clientY: 300 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 300, clientY: 300 }))
    })
    expect(updateInstruction).toHaveBeenCalledWith(node.id, { open: true })

    // 拖拽位移 → 只是移动节点，不弹指令面板
    updateInstruction.mockClear()
    await act(async () => {
      card?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 300, clientY: 300 }))
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 360, clientY: 340 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 360, clientY: 340 }))
    })
    expect(updateInstruction).not.toHaveBeenCalled()
  })

  it('opens run details in a roomy side drawer', async () => {
    const node: CanvasNode = {
      ...idleNode,
      instruction: {
        ...idleNode.instruction,
        phase: 'done',
        prompt: '写一句简短的话',
        open: false,
      },
    }
    const progress: GenerationPanelState = {
      epoch: 7,
      recent: [{ key: 'connecting', kind: 'connecting', label: '正在连接 Agent' }],
      current: { key: 'writing', kind: 'writing', label: '正在生成文本' },
      log: [
        { kind: 'thinking', text: 'I will draft a short uplifting sentence.' },
        { kind: 'output', text: '前路虽远，行则将至。' },
      ],
    }

    await render(
      <Harness node={node} progress={progress}>
        <NodeCard
          node={node}
          selected
          onDragStart={() => {}}
          onPortDown={() => {}}
          onResizeStart={() => {}}
        />
      </Harness>,
    )

    // 节点小窗上的「大窗查看」按钮打开右侧宽抽屉（portal 到 body）
    const expand = container?.querySelector<HTMLButtonElement>('button[title="大窗查看"]')
    expect(expand).not.toBeNull()
    await act(async () => expand?.click())

    const drawer = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="运行详情"]')
    expect(drawer).not.toBeNull()
    expect(drawer?.textContent).toContain('已完成')
    expect(drawer?.textContent).toContain('正在连接 Agent')

    // 抽屉里切到「原始日志」：完整日志在宽敞视野中展示
    const logTab = [...(drawer?.querySelectorAll<HTMLButtonElement>('button[role="tab"]') ?? [])]
      .find((button) => button.textContent === '原始日志')
    await act(async () => logTab?.click())
    expect(drawer?.textContent).toContain('I will draft a short uplifting sentence.')
    expect(drawer?.textContent).toContain('前路虽远，行则将至。')

    const close = drawer?.querySelector<HTMLButtonElement>('button[title="关闭"]')
    await act(async () => close?.click())
    expect(document.body.querySelector('[role="dialog"][aria-label="运行详情"]')).toBeNull()
  })

  it('renders the raw log as grouped, collapsible entries', async () => {
    const node: CanvasNode = {
      ...idleNode,
      instruction: {
        ...idleNode.instruction,
        phase: 'done',
        prompt: '写一句简短的话',
        open: false,
      },
    }
    const longResult = `total 42\n${'drwxr-xr-x  some file line\n'.repeat(20)}`
    const progress: GenerationPanelState = {
      epoch: 8,
      recent: [],
      current: { key: 'writing', kind: 'writing', label: '正在生成文本' },
      log: [
        { kind: 'thinking', text: 'Let me check the files first.' },
        { kind: 'tool', text: '→ command {"command":"ls -la /tmp/demo"}' },
        { kind: 'tool', text: `← ${longResult}` },
        { kind: 'artifact', text: 'write artifacts/n_1/result.md' },
        { kind: 'warning', text: 'error: something needs attention' },
      ],
    }

    await render(
      <Harness node={node} progress={progress}>
        <NodeCard
          node={node}
          selected
          onDragStart={() => {}}
          onPortDown={() => {}}
          onResizeStart={() => {}}
        />
      </Harness>,
    )

    // 展开节点内详情并切到「原始日志」
    const expand = container?.querySelector<HTMLButtonElement>('[aria-label="展开生成过程"]')
    await act(async () => expand?.click())
    const logTab = [...(container?.querySelectorAll<HTMLButtonElement>('button[role="tab"]') ?? [])]
      .find((button) => button.textContent === '原始日志')
    await act(async () => logTab?.click())

    // 思考 / 产物 / 警告带类型标签；工具调用渲染为卡片
    expect(container?.textContent).toContain('思考')
    expect(container?.textContent).toContain('产物')
    expect(container?.textContent).toContain('警告')
    expect(container?.textContent).toContain('command')
    expect(container?.textContent).toContain('1 条结果')

    // 工具结果默认折叠不渲染，点开工具卡片后出现
    expect(container?.textContent).not.toContain('total 42')
    const toolCard = [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((button) => button.textContent?.includes('1 条结果'))
    await act(async () => toolCard?.click())
    expect(container?.textContent).toContain('total 42')

    // 长文本提供「展开全部」开关
    const clampToggle = [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((button) => button.textContent === '展开全部')
    expect(clampToggle).not.toBeNull()
    await act(async () => clampToggle?.click())
    expect(container?.textContent).toContain('收起')
  })

  it('renders markdown preview on the text node and keeps raw editing', async () => {
    const markdownNode: CanvasNode = {
      ...idleNode,
      text: '## 结论\n**核心观点**：行动胜过空想。\n- 要点一\n- 要点二',
      instruction: { ...idleNode.instruction, phase: 'done', open: false },
    }

    // 未选中（阅读态）：直接渲染 Markdown 预览
    await render(
      <Harness node={markdownNode}>
        <NodeCard
          node={markdownNode}
          selected={false}
          onDragStart={() => {}}
          onPortDown={() => {}}
          onResizeStart={() => {}}
        />
      </Harness>,
    )
    expect(container?.querySelector('strong')?.textContent).toBe('核心观点')
    expect(container?.querySelectorAll('ul li')).toHaveLength(2)
    expect(container?.querySelector('textarea')).toBeNull()

    // 选中：默认编辑原文（raw markdown），可随时切到预览
    await act(async () => root?.unmount())
    container?.remove()
    await render(
      <Harness node={markdownNode}>
        <NodeCard
          node={markdownNode}
          selected
          onDragStart={() => {}}
          onPortDown={() => {}}
          onResizeStart={() => {}}
        />
      </Harness>,
    )
    const editor = container?.querySelector('textarea')
    expect(editor?.value).toContain('**核心观点**')
    expect(container?.querySelector('strong')).toBeNull()

    const toggle = container?.querySelector<HTMLButtonElement>('button[aria-label="预览排版"]')
    await act(async () => toggle?.click())
    expect(container?.querySelector('strong')?.textContent).toBe('核心观点')
    expect(container?.querySelector('textarea')).toBeNull()

    const back = container?.querySelector<HTMLButtonElement>('button[aria-label="编辑原文"]')
    await act(async () => back?.click())
    expect(container?.querySelector('textarea')?.value).toContain('**核心观点**')
  })
})
