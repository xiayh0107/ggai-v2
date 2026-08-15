import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

export interface CanvasBlankProjectMarker {
  schemaVersion: 1
  initializedAt: string
  initializedFrom: 'blank-project'
  projectId: string
}

export type CanvasInitializationMarker = CanvasBlankProjectMarker

export class CanvasInitializationError extends Error {
  readonly code: 'canvas_initialization_required' | 'canvas_marker_invalid'
  readonly initializationRequired: boolean

  constructor(
    message: string,
    code: CanvasInitializationError['code'],
    initializationRequired: boolean,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'CanvasInitializationError'
    this.code = code
    this.initializationRequired = initializationRequired
  }
}

/** Verifies the identity marker of a daemon-managed workspace project. */
export async function assertCanvasReady(
  projectRoot: string,
): Promise<CanvasInitializationMarker> {
  const lexicalRoot = path.resolve(projectRoot)
  const canonicalRoot = await realpath(lexicalRoot)
  if (lexicalRoot !== canonicalRoot) {
    throw new CanvasInitializationError(
      'project root must not contain symlink components',
      'canvas_marker_invalid',
      false,
    )
  }
  const ggDir = path.join(canonicalRoot, '.gg')
  const markerPath = path.join(ggDir, 'canvas-model.json')
  const ggKind = await fileKind(ggDir)
  if (ggKind !== 'missing' && ggKind !== 'directory') {
    throw new CanvasInitializationError(
      'project .gg path must be a real directory',
      'canvas_marker_invalid',
      false,
    )
  }
  const markerKind = await fileKind(markerPath)
  if (markerKind === 'missing') {
    throw new CanvasInitializationError(
      'Managed workspace project is missing its Canvas identity marker',
      'canvas_initialization_required',
      true,
    )
  }
  if (markerKind !== 'file') {
    throw new CanvasInitializationError(
      'Canvas model marker must be a regular file',
      'canvas_marker_invalid',
      false,
    )
  }
  return readMarker(markerPath)
}

async function readMarker(filePath: string): Promise<CanvasInitializationMarker> {
  let value: unknown
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      value = JSON.parse(await handle.readFile('utf8')) as unknown
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new CanvasInitializationError(
      `Canvas model marker is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      'canvas_marker_invalid',
      false,
      error,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidMarker()
  }
  const marker = value as Record<string, unknown>
  if (!isCanonicalTimestamp(marker.initializedAt)) throw invalidMarker()

  if (
    hasExactKeys(marker, [
      'schemaVersion',
      'initializedAt',
      'initializedFrom',
      'projectId',
    ])
    && marker.schemaVersion === 1
    && marker.initializedFrom === 'blank-project'
    && isWorkspaceProjectId(marker.projectId)
  ) {
    return {
      schemaVersion: 1,
      initializedAt: marker.initializedAt as string,
      initializedFrom: 'blank-project',
      projectId: marker.projectId as string,
    }
  }

  throw invalidMarker()
}

export function blankProjectCanvasInitializationMarker(
  projectId: string,
  initializedAt = new Date().toISOString(),
): CanvasBlankProjectMarker {
  if (!isWorkspaceProjectId(projectId)) throw new TypeError('projectId is invalid')
  if (!isCanonicalTimestamp(initializedAt)) throw new TypeError('initializedAt must be canonical ISO-8601')
  return {
    schemaVersion: 1,
    initializedAt,
    initializedFrom: 'blank-project',
    projectId,
  }
}

function invalidMarker(): CanvasInitializationError {
  return new CanvasInitializationError(
    'Canvas model marker has an unsupported or invalid schema',
    'canvas_marker_invalid',
    false,
  )
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function isWorkspaceProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^project_[0-9a-f]{32}$/u.test(value)
}

async function fileKind(filePath: string): Promise<'missing' | 'directory' | 'file' | 'other'> {
  try {
    const info = await lstat(filePath)
    if (info.isSymbolicLink()) return 'other'
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}
