export const MAX_FILESYSTEM_TREE_PAGE = 100
export const MAX_BOUND_TEXT_BYTES = 1_000_000

export type FilesystemBindingMode =
  | 'fs-authoritative'
  | 'canvas-authoritative'
  | 'bidirectional'

export type FilesystemBindingState =
  | 'clean'
  | 'canvas-dirty'
  | 'disk-dirty'
  | 'conflict'
  | 'missing'

export interface WorkspaceRoot {
  rootId: string
  projectId: string
  displayName: string
  platformProvider: 'macos'
  createdAt: string
}

export interface FilesystemBinding {
  bindingId: string
  projectId: string
  canvasBranch: string
  nodeId: string
  rootId: string
  relativePath: string
  kind: 'file' | 'directory'
  mode: FilesystemBindingMode
  baseDigest: string | null
  canvasDigest: string | null
  diskDigest: string | null
  state: FilesystemBindingState
  updatedAt: string
}

export interface FilesystemConflict {
  conflictId: string
  bindingId: string
  baseDigest: string | null
  canvasDigest: string
  diskDigest: string
  state: 'open' | 'resolved-canvas' | 'resolved-disk'
  createdAt: string
  resolvedAt: string | null
}

export interface FilesystemTreeEntry {
  name: string
  relativePath: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt: string
}

export function validFilesystemRelativePath(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > 4_096 || value.includes('\\')) return false
  if (value === '') return allowEmpty
  return !value.startsWith('/')
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function filesystemTextKind(relativePath: string): boolean {
  const extension = relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase()
  return [
    '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.js', '.mjs', '.cjs',
    '.ts', '.tsx', '.jsx', '.py', '.r', '.rb', '.go', '.rs', '.java', '.kt',
    '.swift', '.c', '.h', '.cpp', '.hpp', '.css', '.scss', '.html', '.xml',
    '.yaml', '.yml', '.toml', '.sql', '.sh', '.zsh', '.fish',
  ].includes(extension)
}
