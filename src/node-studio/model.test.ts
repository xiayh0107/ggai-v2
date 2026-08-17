import { describe, expect, it } from 'vitest'
import {
  createBlankNodeStudioDefinition,
  customNodeRuntimeId,
  draftCustomNodeFromRequirement,
  isNodeStudioDefinition,
  validateNodeStudioDefinition,
} from './model'

describe('node studio manifest', () => {
  it('creates a safe declarative draft from a natural-language requirement', () => {
    const draft = draftCustomNodeFromRequirement(
      '做一个竞品数据表格，支持补充维度、分析趋势和生成总结。',
      createBlankNodeStudioDefinition(new Date('2026-01-01T00:00:00.000Z')),
      new Date('2026-01-02T00:00:00.000Z'),
    )

    expect(draft.contentKind).toBe('table')
    expect(draft.id).toMatch(/^@local\//u)
    expect(draft.actions).toContain('分析趋势')
    expect(validateNodeStudioDefinition(draft)).toEqual([])
  })

  it('rejects extra fields and invalid reserved identities', () => {
    const draft = createBlankNodeStudioDefinition()
    expect(isNodeStudioDefinition({ ...draft, script: 'alert(1)' })).toBe(false)
    expect(validateNodeStudioDefinition({ ...draft, id: '@local/text' }))
      .toContain('节点 ID 不能覆盖内置节点')
  })

  it('binds runtime identity to an immutable revision', () => {
    expect(customNodeRuntimeId({ id: '@local/research-card', revision: 3 }))
      .toBe('@local/research-card@3')
  })
})
