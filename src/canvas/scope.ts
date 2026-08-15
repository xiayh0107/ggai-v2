const WORKSPACE_PROJECT_ID_PATTERN = /^project_[0-9a-f]{32}$/u

export class CanvasScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanvasScopeError'
  }
}

export function canvasBranchFromSearch(search: string): string {
  const candidate = new URLSearchParams(search).get('branch')?.trim()
  return candidate || 'main'
}

/**
 * Browser URLs carry a managed opaque catalog id, never a filesystem path.
 * Missing and malformed ids fail closed instead of opening the daemon's
 * configured filesystem root by mistake.
 */
export function canvasProjectIdFromSearch(search: string): string {
  const parameters = new URLSearchParams(search)
  const candidates = parameters.getAll('project')
  if (candidates.length === 0) {
    throw new CanvasScopeError('Canvas URL does not contain a project id')
  }
  if (candidates.length !== 1) {
    throw new CanvasScopeError('Canvas URL contains more than one project id')
  }
  const candidate = candidates[0] ?? ''
  if (
    !WORKSPACE_PROJECT_ID_PATTERN.test(candidate)
  ) {
    throw new CanvasScopeError('Canvas URL contains an invalid project id')
  }
  return candidate
}
