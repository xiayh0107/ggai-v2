import { beforeAll, describe, expect, it } from 'vitest'
import type { CanvasNode } from '@/types/canvas'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import { applyRunOutcome, settleUnsuccessfulRun } from './settlement'

const node = (type = 'text'): CanvasNode => ({
  id: 'node-1',
  type,
  x: 0,
  y: 0,
  w: 320,
  h: 120,
  title: 'Node',
  text: 'old',
  instruction: {
    phase: 'generating',
    prompt: 'generate',
    attachments: [],
    sources: [],
    open: false,
    suggestedActions: {
      runId: 'run-old',
      actions: [{ id: 'old', label: '旧建议', prompt: '旧建议' }],
    },
  },
  payload: { artifactFiles: ['old.md'], agentProgress: 'transient' },
})

beforeAll(() => registerBuiltinPlugins())

describe('run settlement', () => {
  it('materializes text through the plugin and caches suggestions by source run', () => {
    const settled = applyRunOutcome(node(), {
      runId: 'run-new',
      responseText: 'new response',
      artifactFiles: ['new.md'],
      outcome: {
        schemaVersion: 1,
        suggestedActions: [{ id: 'chart', label: '做成图表', prompt: '把内容做成图表。' }],
      },
    })

    expect(settled.text).toBe('new response')
    expect(settled.payload).toEqual({ artifactFiles: ['new.md'] })
    expect(settled.instruction.suggestedActions).toEqual({
      runId: 'run-new',
      actions: [{ id: 'chart', label: '做成图表', prompt: '把内容做成图表。' }],
    })
  })

  it('keeps unknown node content intact while still reconciling generic artifacts', () => {
    const settled = applyRunOutcome(node('@custom/missing'), {
      runId: 'run-custom',
      responseText: 'transport text should not assume a node shape',
      artifactFiles: ['site/index.html'],
    })

    expect(settled.text).toBe('old')
    expect(settled.payload).toEqual({ artifactFiles: ['site/index.html'] })
    expect(settled.instruction.suggestedActions).toBeUndefined()
  })

  it('never carries suggestions through an unsuccessful settlement', () => {
    const settled = settleUnsuccessfulRun(node(), {
      previousPhase: 'done',
      message: '执行失败 · test',
    })

    expect(settled.instruction).toMatchObject({ phase: 'done', open: true })
    expect(settled.instruction.suggestedActions).toBeUndefined()
  })
})
