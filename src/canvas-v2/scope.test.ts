import { describe, expect, it } from 'vitest'
import {
  CanvasV2ScopeError,
  canvasV2BranchFromSearch,
  canvasV2ProjectIdFromSearch,
} from './scope'

describe('Canvas V2 browser scope', () => {
  it('scopes browser state to the branch in the URL', () => {
    expect(canvasV2BranchFromSearch('?branch=feature%2Frich-task')).toBe('feature/rich-task')
    expect(canvasV2BranchFromSearch('')).toBe('main')
    expect(canvasV2BranchFromSearch('?branch=%20')).toBe('main')
  })

  it('uses an opaque project id and preserves old root-project URLs', () => {
    expect(canvasV2ProjectIdFromSearch('')).toBe('project_root')
    expect(canvasV2ProjectIdFromSearch('?project=project_root')).toBe('project_root')
    expect(canvasV2ProjectIdFromSearch(
      '?project=project_0123456789abcdef0123456789abcdef&branch=main',
    )).toBe('project_0123456789abcdef0123456789abcdef')
  })

  it('rejects paths, malformed ids, and ambiguous project selection', () => {
    for (const search of [
      '?project=..%2Fsecrets',
      '?project=%2Ftmp%2Fproject',
      '?project=project_ABCDEF0123456789ABCDEF0123456789',
      '?project=',
      '?project=%20project_root%20',
      '?project=%0Aproject_root',
      '?project=project_root%09',
      '?project=project_root&project=project_0123456789abcdef0123456789abcdef',
    ]) {
      expect(() => canvasV2ProjectIdFromSearch(search)).toThrow(CanvasV2ScopeError)
    }
  })
})
