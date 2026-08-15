export type PermissionDecision = 'allow' | 'deny'

export interface PermissionResolution {
  decision: PermissionDecision
  /** Whether the same decision may be reused for this run. */
  remember?: boolean
  reason?: string
}
