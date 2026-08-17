import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { atomicWriteText } from './atomic-file.js'

const execFileAsync = promisify(execFile)

export interface CanvasBlankProjectMarker {
  schemaVersion: 2
  canvasSchemaVersion: 3
  initializedAt: string
  initializedFrom: 'blank-project' | 'schema-reset'
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

/**
 * Ensures a managed project is current. A schema-1 marker authorizes the one-time destructive
 * reset selected for this release; no old Canvas, Run, session, artifact, or Git state is read.
 */
export async function ensureCanvasReady(
  projectRoot: string,
  projectId: string,
): Promise<CanvasInitializationMarker> {
  if (!isWorkspaceProjectId(projectId)) throw new TypeError('projectId is invalid')
  const canonicalRoot = await requireCanonicalProjectRoot(projectRoot)
  const ggDir = path.join(canonicalRoot, '.gg')
  const markerPath = path.join(ggDir, 'canvas-model.json')
  const journalPath = path.join(ggDir, 'canvas-reset.json')
  const marker = await readMarkerValue(markerPath)
  const resetPending = await fileKind(journalPath) !== 'missing'
  if (isCurrentMarker(marker) && marker.projectId === projectId && !resetPending) {
    return marker
  }
  if (!resetPending && !isResettableMarker(marker, projectId)) throw invalidMarker()
  return resetCanvasState(canonicalRoot, projectId, markerPath, journalPath)
}

async function readMarker(filePath: string): Promise<CanvasInitializationMarker> {
  const value = await readMarkerValue(filePath)
  if (!isCurrentMarker(value)) throw invalidMarker()
  return value
}

async function readMarkerValue(filePath: string): Promise<unknown> {
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return JSON.parse(await handle.readFile('utf8')) as unknown
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
}

export function blankProjectCanvasInitializationMarker(
  projectId: string,
  initializedAt = new Date().toISOString(),
): CanvasBlankProjectMarker {
  if (!isWorkspaceProjectId(projectId)) throw new TypeError('projectId is invalid')
  if (!isCanonicalTimestamp(initializedAt)) throw new TypeError('initializedAt must be canonical ISO-8601')
  return {
    schemaVersion: 2,
    canvasSchemaVersion: 3,
    initializedAt,
    initializedFrom: 'blank-project',
    projectId,
  }
}

function isCurrentMarker(value: unknown): value is CanvasInitializationMarker {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'canvasSchemaVersion', 'initializedAt', 'initializedFrom', 'projectId',
  ])) return false
  return value.schemaVersion === 2
    && value.canvasSchemaVersion === 3
    && (value.initializedFrom === 'blank-project' || value.initializedFrom === 'schema-reset')
    && isCanonicalTimestamp(value.initializedAt)
    && isWorkspaceProjectId(value.projectId)
}

function isResettableMarker(value: unknown, projectId: string): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['schemaVersion', 'initializedAt', 'initializedFrom', 'projectId'])
    && value.schemaVersion === 1
    && value.initializedFrom === 'blank-project'
    && value.projectId === projectId
    && isCanonicalTimestamp(value.initializedAt)
}

async function resetCanvasState(
  projectRoot: string,
  projectId: string,
  markerPath: string,
  journalPath: string,
): Promise<CanvasInitializationMarker> {
  const ggDir = path.join(projectRoot, '.gg')
  await mkdir(ggDir, { recursive: true, mode: 0o700 })
  const targets = [
    '.gg/runtime',
    ['.gg', `canvas-state-v${2}`].join('/'),
    ['.gg', `canvas-worktrees-v${2}`].join('/'),
    '.gg/canvas',
    '.gg/canvas-worktrees',
    'artifacts',
  ] as const
  await assertResetTargetsUntracked(projectRoot, targets)
  await atomicWriteText(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    targets,
  }, null, 2)}\n`)

  for (const target of targets) {
    const source = path.join(projectRoot, ...target.split('/'))
    const tombstone = path.join(ggDir, `.resetting-${target.replaceAll('/', '-')}`)
    const tombstoneKind = await fileKind(tombstone)
    if (tombstoneKind !== 'missing') {
      if (tombstoneKind !== 'directory') throw unsafeResetTarget(tombstone)
      await rm(tombstone, { recursive: true, force: false })
    }
    const kind = await fileKind(source)
    if (kind === 'missing') continue
    if (kind !== 'directory') throw unsafeResetTarget(source)
    await rename(source, tombstone)
    await rm(tombstone, { recursive: true, force: false })
  }

  const marker: CanvasInitializationMarker = {
    schemaVersion: 2,
    canvasSchemaVersion: 3,
    initializedAt: new Date().toISOString(),
    initializedFrom: 'schema-reset',
    projectId,
  }
  await atomicWriteText(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
  await unlink(journalPath)
  return marker
}

async function requireCanonicalProjectRoot(projectRoot: string): Promise<string> {
  const lexicalRoot = path.resolve(projectRoot)
  const canonicalRoot = await realpath(lexicalRoot)
  if (lexicalRoot !== canonicalRoot) {
    throw new CanvasInitializationError(
      'project root must not contain symlink components',
      'canvas_marker_invalid',
      false,
    )
  }
  return canonicalRoot
}

function unsafeResetTarget(target: string): CanvasInitializationError {
  return new CanvasInitializationError(
    `Canvas reset target is not a real directory: ${target}`,
    'canvas_marker_invalid',
    false,
  )
}

async function assertResetTargetsUntracked(
  projectRoot: string,
  targets: readonly string[],
): Promise<void> {
  let gitRoot: string
  try {
    const result = await execFileAsync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    gitRoot = path.resolve(result.stdout.trim())
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
    if (String(code) === '128') return
    throw new CanvasInitializationError(
      'Canvas reset could not verify source Git tracking state',
      'canvas_marker_invalid',
      false,
      error,
    )
  }
  for (const target of targets) {
    const relativeTarget = path.relative(gitRoot, path.join(projectRoot, ...target.split('/')))
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) continue
    const result = await execFileAsync('git', ['-C', gitRoot, 'ls-files', '--', relativeTarget], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    if (result.stdout.trim()) {
      throw new CanvasInitializationError(
        `Canvas reset target contains source-controlled files: ${target}`,
        'canvas_marker_invalid',
        false,
      )
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
