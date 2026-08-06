import { useCallback } from 'react'

export type CanvasV2BranchNavigationCommit = (href: string) => void

export function canvasV2BranchNavigationHref(currentHref: string, branch: string): string {
  const normalized = branch.trim()
  if (!normalized) throw new TypeError('Canvas V2 branch is required')
  const next = new URL(currentHref)
  next.searchParams.set('branch', normalized)
  return next.toString()
}

/**
 * Branch navigation intentionally performs a document navigation. Canvas V2
 * stores are branch-scoped, so reloading is what replaces the provider/store
 * rather than mutating the active store underneath a pending command queue.
 */
export function useCanvasV2BranchNavigation(
  commit?: CanvasV2BranchNavigationCommit,
): (branch: string) => void {
  return useCallback((branch: string) => {
    const href = canvasV2BranchNavigationHref(window.location.href, branch)
    if (commit) commit(href)
    else window.location.assign(href)
  }, [commit])
}
