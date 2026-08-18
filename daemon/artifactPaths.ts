import path from 'node:path'

export const ARTIFACT_CONTROL_DIRECTORY = '.ggai'

/** Control metadata is never a user-facing artifact, regardless of nesting. */
export function isArtifactControlPath(value: string): boolean {
  return value.split(/[\\/]/u).includes(ARTIFACT_CONTROL_DIRECTORY)
}

/** Normalized project-relative path inside daemon-managed artifact storage. */
export function isSafeArtifactReference(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4_096
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
  ) return false
  const normalized = path.posix.normalize(value)
  return normalized === value
    && value.startsWith('artifacts/')
    && !value.split('/').includes('..')
    && !isArtifactControlPath(value)
}
