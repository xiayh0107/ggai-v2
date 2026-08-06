import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

export type CanvasModelMode = 'v1' | 'v2'

export interface CanvasModelMarkerV1 {
  version: 1
  canvasModel: 2
  initializedAt: string
  legacyArchive: string
}

export class CanvasModelBootError extends Error {
  readonly code: 'canvas_reset_required' | 'canvas_model_mismatch' | 'canvas_model_marker_invalid'
  readonly resetRequired: boolean

  constructor(
    message: string,
    code: CanvasModelBootError['code'],
    resetRequired: boolean,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'CanvasModelBootError'
    this.code = code
    this.resetRequired = resetRequired
  }
}

export function parseCanvasModelMode(value: unknown): CanvasModelMode {
  if (value === 'v1' || value === '1') return 'v1'
  if (value === 'v2' || value === '2') return 'v2'
  throw new CanvasModelBootError(
    'canvas model must be v1 or v2',
    'canvas_model_mismatch',
    false,
  )
}

export function parseCanvasModelV2Flag(value: unknown): CanvasModelMode {
  if (value === undefined) return 'v2'
  if (typeof value !== 'string') {
    throw new CanvasModelBootError(
      'GGAI_CANVAS_MODEL_V2 must be 0, 1, false, or true',
      'canvas_model_mismatch',
      false,
    )
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return 'v2'
  if (normalized === '') return 'v2'
  if (normalized === '0' || normalized === 'false') return 'v1'
  throw new CanvasModelBootError(
    'GGAI_CANVAS_MODEL_V2 must be 0, 1, false, or true',
    'canvas_model_mismatch',
    false,
  )
}

/** Ensures the selected daemon model agrees with the explicit on-disk marker. */
export async function assertCanvasModelReady(
  projectRoot: string,
  mode: CanvasModelMode,
): Promise<CanvasModelMarkerV1 | null> {
  const lexicalRoot = path.resolve(projectRoot)
  const canonicalRoot = await realpath(lexicalRoot)
  if (lexicalRoot !== canonicalRoot) {
    throw new CanvasModelBootError(
      'project root must not contain symlink components',
      'canvas_model_marker_invalid',
      false,
    )
  }
  const ggDir = path.join(canonicalRoot, '.gg')
  const markerPath = path.join(ggDir, 'canvas-model.json')
  const ggKind = await fileKind(ggDir)
  if (ggKind !== 'missing' && ggKind !== 'directory') {
    throw new CanvasModelBootError(
      'project .gg path must be a real directory',
      'canvas_model_marker_invalid',
      false,
    )
  }
  const markerKind = await fileKind(markerPath)
  if (markerKind === 'missing') {
    if (mode === 'v1') return null
    throw new CanvasModelBootError(
      'Canvas V2 requires an explicit reset; run `npm run canvas:v2:reset -- --apply` first',
      'canvas_reset_required',
      true,
    )
  }
  if (markerKind !== 'file') {
    throw new CanvasModelBootError(
      'Canvas model marker must be a regular file',
      'canvas_model_marker_invalid',
      false,
    )
  }

  const marker = await readMarker(markerPath)
  if (mode === 'v1') {
    throw new CanvasModelBootError(
      'Project is initialized for Canvas V2; restore the archived V1 state before selecting V1',
      'canvas_model_mismatch',
      false,
    )
  }
  return marker
}

async function readMarker(filePath: string): Promise<CanvasModelMarkerV1> {
  let value: unknown
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      value = JSON.parse(await handle.readFile('utf8')) as unknown
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new CanvasModelBootError(
      `Canvas model marker is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      'canvas_model_marker_invalid',
      false,
      error,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidMarker()
  }
  const marker = value as Record<string, unknown>
  if (
    marker.version !== 1
    || marker.canvasModel !== 2
    || typeof marker.initializedAt !== 'string'
    || !Number.isFinite(Date.parse(marker.initializedAt))
    || typeof marker.legacyArchive !== 'string'
    || !/^\.gg\/legacy-v1\/[0-9]{8}T[0-9]{6}\.[0-9]{3}Z$/u.test(marker.legacyArchive)
  ) {
    throw invalidMarker()
  }
  return {
    version: 1,
    canvasModel: 2,
    initializedAt: marker.initializedAt,
    legacyArchive: marker.legacyArchive,
  }
}

function invalidMarker(): CanvasModelBootError {
  return new CanvasModelBootError(
    'Canvas model marker has an unsupported or invalid schema',
    'canvas_model_marker_invalid',
    false,
  )
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
