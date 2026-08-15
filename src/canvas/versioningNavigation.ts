import { useCallback } from 'react'

export type CanvasBranchNavigationCommit = (href: string) => void

export function canvasBranchNavigationHref(currentHref: string, branch: string): string {
  const normalized = branch.trim()
  if (!normalized) throw new TypeError('Canvas branch is required')
  const next = new URL(currentHref)
  next.searchParams.set('branch', normalized)
  return next.toString()
}

/**
 * Branch navigation intentionally performs a document navigation. Canvas
 * stores are branch-scoped, so reloading is what replaces the provider/store
 * rather than mutating the active store underneath a pending command queue.
 */
export function useCanvasBranchNavigation(
  commit?: CanvasBranchNavigationCommit,
): (branch: string) => void {
  return useCallback((branch: string) => {
    const href = canvasBranchNavigationHref(window.location.href, branch)
    if (commit) commit(href)
    else window.location.assign(href)
  }, [commit])
}
