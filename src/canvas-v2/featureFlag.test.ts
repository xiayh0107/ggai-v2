import { describe, expect, it } from 'vitest'
import { canvasV2BranchFromSearch, isCanvasV2FrontendEnabled } from './featureFlag'

describe('Canvas V2 frontend flag', () => {
  it('requires an explicit true value', () => {
    expect(isCanvasV2FrontendEnabled('1')).toBe(true)
    expect(isCanvasV2FrontendEnabled(' TRUE ')).toBe(true)
    expect(isCanvasV2FrontendEnabled('0')).toBe(false)
    expect(isCanvasV2FrontendEnabled('enabled')).toBe(false)
    expect(isCanvasV2FrontendEnabled(undefined)).toBe(false)
  })

  it('scopes V2 browser state to the branch in the URL', () => {
    expect(canvasV2BranchFromSearch('?branch=feature%2Frich-task')).toBe('feature/rich-task')
    expect(canvasV2BranchFromSearch('')).toBe('main')
    expect(canvasV2BranchFromSearch('?branch=%20')).toBe('main')
  })
})
