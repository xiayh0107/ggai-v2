import { describe, expect, it } from 'vitest'
import {
  CanvasScopeError,
  canvasBranchFromSearch,
  canvasProjectIdFromSearch,
} from './scope'

describe('Canvas browser scope', () => {
  it('scopes browser state to the branch in the URL', () => {
    expect(canvasBranchFromSearch('?branch=feature%2Frich-task')).toBe('feature/rich-task')
    expect(canvasBranchFromSearch('')).toBe('main')
    expect(canvasBranchFromSearch('?branch=%20')).toBe('main')
  })

  it('uses a managed opaque project id', () => {
    expect(canvasProjectIdFromSearch(
      '?project=project_0123456789abcdef0123456789abcdef&branch=main',
    )).toBe('project_0123456789abcdef0123456789abcdef')
  })

  it('rejects paths, malformed ids, and ambiguous project selection', () => {
    for (const search of [
      '',
      '?project=..%2Fsecrets',
      '?project=%2Ftmp%2Fproject',
      '?project=project_ABCDEF0123456789ABCDEF0123456789',
      '?project=',
      '?project=project_root',
      '?project=%20project_root%20',
      '?project=%0Aproject_root',
      '?project=project_root%09',
      '?project=project_root&project=project_0123456789abcdef0123456789abcdef',
    ]) {
      expect(() => canvasProjectIdFromSearch(search)).toThrow(CanvasScopeError)
    }
  })
})
