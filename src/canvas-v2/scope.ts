export const ROOT_WORKSPACE_PROJECT_ID = 'project_root'

const WORKSPACE_PROJECT_ID_PATTERN = /^project_[0-9a-f]{32}$/u

export class CanvasV2ScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanvasV2ScopeError'
  }
}

export function canvasV2BranchFromSearch(search: string): string {
  const candidate = new URLSearchParams(search).get('branch')?.trim()
  return candidate || 'main'
}

/**
 * Browser URLs carry an opaque catalog id, never a filesystem path. Missing
 * ids intentionally resolve to the registered root project for old `/canvas`
 * bookmarks; malformed ids fail closed instead of opening the root by mistake.
 */
export function canvasV2ProjectIdFromSearch(search: string): string {
  const parameters = new URLSearchParams(search)
  const candidates = parameters.getAll('project')
  if (candidates.length === 0) return ROOT_WORKSPACE_PROJECT_ID
  if (candidates.length !== 1) {
    throw new CanvasV2ScopeError('Canvas URL contains more than one project id')
  }
  const candidate = candidates[0] ?? ''
  if (
    candidate !== ROOT_WORKSPACE_PROJECT_ID
    && !WORKSPACE_PROJECT_ID_PATTERN.test(candidate)
  ) {
    throw new CanvasV2ScopeError('Canvas URL contains an invalid project id')
  }
  return candidate
}
