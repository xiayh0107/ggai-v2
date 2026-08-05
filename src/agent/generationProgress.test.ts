import { describe, expect, it } from 'vitest'
import {
  advanceGenerationPanel,
  createGenerationPanel,
  generationActivityForEvent,
} from './generationProgress'

describe('generation progress presentation', () => {
  it('turns protocol events into product language without exposing raw content in labels', () => {
    const rawReasoning = 'I will inspect private implementation details before answering.'
    const activity = generationActivityForEvent(
      { type: 'thinking', text: rawReasoning },
      'text',
    )

    expect(activity).toEqual({
      key: 'thinking',
      kind: 'thinking',
      label: '正在理解任务',
    })
    expect(activity?.label).not.toContain(rawReasoning)
  })

  it('preserves raw reasoning and streamed output in the expandable log', () => {
    let panel = createGenerationPanel(7)
    panel = advanceGenerationPanel(panel, { type: 'thinking', text: 'Let me think.' }, 'text')
    panel = advanceGenerationPanel(panel, { type: 'thinking', text: ' Step two.' }, 'text')
    panel = advanceGenerationPanel(panel, { type: 'text-delta', text: '第一段' }, 'text')
    panel = advanceGenerationPanel(panel, { type: 'text-delta', text: '第二段' }, 'text')
    panel = advanceGenerationPanel(panel, { type: 'tool-call', name: 'read_file', input: { path: 'a.md' } }, 'text')
    panel = advanceGenerationPanel(panel, { type: 'done', stopReason: 'end_turn' }, 'text')

    // 流式片段合并进上一条同类日志
    expect(panel.log).toEqual([
      { kind: 'thinking', text: 'Let me think. Step two.' },
      { kind: 'output', text: '第一段第二段' },
      { kind: 'tool', text: '→ read_file {"path":"a.md"}' },
      { kind: 'info', text: 'done (end_turn)' },
    ])
    // 产品化标签仍不暴露原始内容
    expect(panel.recent.concat(panel.current).every((a) => !a.label.includes('Let me think'))).toBe(true)
  })

  it('deduplicates stream chunks in the visible process and keeps only three completed activities', () => {
    let panel = createGenerationPanel(7)
    panel = advanceGenerationPanel(panel, { type: 'thinking', text: 'raw' }, 'text')
    panel = advanceGenerationPanel(panel, { type: 'text-delta', text: '第一段' }, 'text')
    const afterFirstChunk = panel
    panel = advanceGenerationPanel(panel, { type: 'text-delta', text: '第二段' }, 'text')

    // 可见过程去重：current / recent 引用不变，只有原始日志追加
    expect(panel.current).toBe(afterFirstChunk.current)
    expect(panel.recent).toBe(afterFirstChunk.recent)
    expect(panel.log).not.toBe(afterFirstChunk.log)
    expect(panel.current.label).toBe('正在生成文本')

    panel = advanceGenerationPanel(panel, { type: 'tool-call', name: 'read_file', input: {} }, 'text')
    panel = advanceGenerationPanel(panel, { type: 'tool-result', result: {} }, 'text')
    panel = advanceGenerationPanel(panel, { type: 'file-write', path: 'artifacts/n_1/result.md' }, 'text')

    expect(panel.recent).toHaveLength(3)
    expect(panel.recent.map((activity) => activity.label)).toEqual([
      '正在生成文本',
      '正在读取节点上下文',
      '处理步骤已完成',
    ])
    expect(panel.current.label).toBe('已生成 result.md')
  })

  it('ignores usage bookkeeping in both the visible process and the log', () => {
    const panel = createGenerationPanel(2)
    expect(advanceGenerationPanel(
      panel,
      { type: 'usage', tokensIn: 10, tokensOut: 20 },
      'text',
    )).toBe(panel)
  })
})
