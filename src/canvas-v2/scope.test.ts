import { describe, expect, it } from 'vitest'
import { canvasV2BranchFromSearch } from './scope'

describe('Canvas V2 browser scope', () => {
  it('scopes browser state to the branch in the URL', () => {
    expect(canvasV2BranchFromSearch('?branch=feature%2Frich-task')).toBe('feature/rich-task')
    expect(canvasV2BranchFromSearch('')).toBe('main')
    expect(canvasV2BranchFromSearch('?branch=%20')).toBe('main')
  })
})
