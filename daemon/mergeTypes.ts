export type GitMergeState = 'ready' | 'conflicts' | 'up-to-date'

export type GitMergeConflictKind =
  | 'content'
  | 'add-add'
  | 'modify-delete'
  | 'delete-modify'
  | 'unknown'

export interface GitMergeConflict {
  path: string
  kind: GitMergeConflictKind
  stages: {
    base: boolean
    ours: boolean
    theirs: boolean
  }
}

export type MergeResolutionChoice = 'ours' | 'theirs' | 'custom'

/**
 * Contract reserved for a future conflict-resolution Agent. A proposal is
 * advisory data only: merge APIs never apply it without a separate, explicit
 * approval workflow.
 */
export interface MergeConflictResolutionProposal {
  schemaVersion: 1
  generatedBy: string
  rationale?: string
  resolutions: Array<{
    path: string
    choice: MergeResolutionChoice
    /** Required only for `custom`; omitted for ours/theirs. */
    content?: string
    rationale?: string
  }>
}

export interface MergeConflictResolutionState {
  requiresExplicitApproval: true
  proposal?: MergeConflictResolutionProposal
}

export interface GitMergePreview {
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
  targetCommit: string
  baseCommit: string | null
  state: GitMergeState
  changed: boolean
  paths: string[]
  conflicts: GitMergeConflict[]
  /** Present only when conflicts require a separate resolution workflow. */
  resolution?: MergeConflictResolutionState
}

export interface GitMergeExecution extends GitMergePreview {
  merged: boolean
  commit: string
}

export function parseUnmergedIndex(raw: string): GitMergeConflict[] {
  const byPath = new Map<string, Set<number>>()
  for (const entry of raw.split('\0')) {
    if (!entry) continue
    const match = /^\d+ [0-9a-f]+ ([123])\t(.+)$/u.exec(entry)
    if (!match) continue
    const stage = Number(match[1])
    const path = match[2]
    if (!path) continue
    const stages = byPath.get(path) ?? new Set<number>()
    stages.add(stage)
    byPath.set(path, stages)
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, stages]) => {
      const base = stages.has(1)
      const ours = stages.has(2)
      const theirs = stages.has(3)
      return {
        path,
        kind: conflictKind(base, ours, theirs),
        stages: { base, ours, theirs },
      }
    })
}

export function nulSeparatedPaths(raw: string): string[] {
  return [...new Set(raw.split('\0').filter(Boolean))].sort()
}

function conflictKind(
  base: boolean,
  ours: boolean,
  theirs: boolean,
): GitMergeConflictKind {
  if (!base && ours && theirs) return 'add-add'
  if (base && ours && !theirs) return 'modify-delete'
  if (base && !ours && theirs) return 'delete-modify'
  if (base && ours && theirs) return 'content'
  return 'unknown'
}
