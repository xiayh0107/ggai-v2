#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const EMPTY_UPDATED_AT = '1970-01-01T00:00:00.000Z'
const RESET_LOCK_RELATIVE = '.gg/canvas-maintenance.lock'
const RESET_JOURNAL_RELATIVE = '.gg/canvas-v2-reset.pending.json'
const MODEL_MARKER_RELATIVE = '.gg/canvas-model.json'
const MAIN_BRANCH_STORAGE_ID = createHash('sha256').update('main', 'utf8').digest('hex')
const RESET_TARGETS = [
  { source: '.gg/runtime', archive: '.gg/runtime' },
  { source: '.gg/canvas-state', archive: '.gg/canvas-state' },
  { source: '.gg/canvas-worktrees', archive: '.gg/canvas-worktrees' },
  { source: 'artifacts', archive: 'artifacts' },
]

export class CanvasV2ResetError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'CanvasV2ResetError'
    this.code = code
    this.details = details
  }
}

/**
 * Builds a read-only reset preview. Applying that preview is intentionally a
 * separate call so a CLI invocation without --apply can never mutate state.
 */
export async function inspectCanvasV2Reset(projectRoot, options = {}) {
  const projectDir = await validateProjectRoot(projectRoot)
  await assertUntrackedResetTargets(projectDir)
  await assertSafeManagedParents(projectDir)

  const markerPath = path.join(projectDir, MODEL_MARKER_RELATIVE)
  const journalPath = path.join(projectDir, RESET_JOURNAL_RELATIVE)
  const pendingJournal = await readOptionalJsonNoFollow(journalPath)
  const marker = await readOptionalJsonNoFollow(markerPath)
  if (marker && !pendingJournal) {
    throw new CanvasV2ResetError(
      'Canvas V2 is already initialized; refusing to archive the current V2 state',
      'canvas_v2_already_initialized',
      { markerPath },
    )
  }

  if (pendingJournal) {
    const journal = parseJournal(pendingJournal, projectDir)
    return resetPreviewFromJournal(projectDir, journal, true)
  }

  const timestamp = resetTimestamp(options.now?.() ?? Date.now())
  const archiveRelative = `.gg/legacy-v1/${timestamp}`
  const operations = []
  for (const target of RESET_TARGETS) {
    const sourcePath = path.join(projectDir, target.source)
    const source = await safePathKind(sourcePath)
    operations.push({
      source: target.source,
      destination: path.posix.join(archiveRelative, target.archive),
      status: source === 'missing' ? 'absent' : 'pending',
    })
  }

  const lease = await inspectDaemonLease(projectDir)
  return {
    version: 1,
    projectDir,
    archiveRelative,
    markerRelative: MODEL_MARKER_RELATIVE,
    journalRelative: RESET_JOURNAL_RELATIVE,
    operations,
    daemonLease: lease,
    resumed: false,
  }
}

/**
 * Archives V1 state through a durable journal and initializes a pristine V2
 * snapshot. No archived path is deleted, and a failed transaction is resumed
 * from the same journal on the next explicit --apply.
 */
export async function applyCanvasV2Reset(projectRoot, options = {}) {
  const preview = await inspectCanvasV2Reset(projectRoot, options)
  const projectDir = preview.projectDir
  const maintenance = await acquireMaintenanceLock(projectDir, options.now?.() ?? Date.now())
  let daemonFence = null
  try {
    const runtimeOperation = preview.operations.find((operation) => operation.source === '.gg/runtime')
    daemonFence = await fenceDaemonLease(projectDir, maintenance, {
      allowStale: runtimeOperation?.status === 'pending',
    })
    const journalPath = path.join(projectDir, RESET_JOURNAL_RELATIVE)
    let journal
    if (preview.resumed) {
      journal = parseJournal(await readJsonNoFollow(journalPath), projectDir)
    } else {
      journal = {
        version: 1,
        projectDir,
        archiveRelative: preview.archiveRelative,
        createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        phase: 'archiving',
        operations: preview.operations,
      }
      await atomicWriteJson(journalPath, journal)
    }

    let movedCount = 0
    for (let index = 0; index < journal.operations.length; index += 1) {
      const operation = journal.operations[index]
      if (operation.status === 'moved' || operation.status === 'absent') continue
      const sourcePath = path.join(projectDir, operation.source)
      const destinationPath = path.join(projectDir, operation.destination)
      const [sourceKind, destinationKind] = await Promise.all([
        safePathKind(sourcePath),
        safePathKind(destinationPath),
      ])
      if (sourceKind === 'missing' && destinationKind === 'directory') {
        operation.status = 'moved'
      } else if (sourceKind === 'missing' && destinationKind === 'missing') {
        operation.status = 'absent'
      } else if (sourceKind === 'directory' && destinationKind === 'missing') {
        await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
        await rename(sourcePath, destinationPath)
        operation.status = 'moved'
        movedCount += 1
      } else {
        throw new CanvasV2ResetError(
          `Cannot resume reset operation ${operation.source}: unexpected source/destination state`,
          'canvas_v2_reset_state_conflict',
          { sourceKind, destinationKind, operation },
        )
      }
      await atomicWriteJson(journalPath, journal)
      if (options.failAfterMoveCount === movedCount) {
        throw new CanvasV2ResetError(
          'Injected reset interruption',
          'canvas_v2_reset_interrupted',
        )
      }
    }

    journal.phase = 'initializing'
    await atomicWriteJson(journalPath, journal)
    await initializeCanvasV2(projectDir, journal)
    journal.phase = 'complete'
    journal.completedAt = new Date(options.now?.() ?? Date.now()).toISOString()
    await atomicWriteJson(journalPath, journal)

    const archivedJournal = path.join(projectDir, journal.archiveRelative, 'reset-journal.json')
    await mkdir(path.dirname(archivedJournal), { recursive: true, mode: 0o700 })
    if (await safePathKind(archivedJournal) === 'missing') {
      await rename(journalPath, archivedJournal)
    } else {
      throw new CanvasV2ResetError(
        'Archived reset journal already exists',
        'canvas_v2_reset_state_conflict',
        { archivedJournal },
      )
    }

    return {
      ...resetPreviewFromJournal(projectDir, journal, preview.resumed),
      completedAt: journal.completedAt,
      archivedJournal: path.relative(projectDir, archivedJournal),
    }
  } finally {
    await releaseDaemonFence(daemonFence)
    await releaseMaintenanceLock(maintenance)
  }
}

async function validateProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    throw new CanvasV2ResetError('Project root is required', 'invalid_project_root')
  }
  const lexical = path.resolve(projectRoot)
  const canonical = await realpath(lexical).catch((error) => {
    throw new CanvasV2ResetError(
      `Project root cannot be resolved: ${error.message}`,
      'invalid_project_root',
    )
  })
  if (lexical !== canonical) {
    throw new CanvasV2ResetError(
      'Project root must not contain symlink components',
      'unsafe_project_root',
      { lexical, canonical },
    )
  }
  if (canonical === path.parse(canonical).root || canonical === await realpath(os.homedir())) {
    throw new CanvasV2ResetError(
      'Refusing to reset a filesystem root or home directory',
      'unsafe_project_root',
      { projectDir: canonical },
    )
  }
  if (await safePathKind(path.join(canonical, 'package.json')) !== 'file') {
    throw new CanvasV2ResetError(
      'Project root must contain a regular package.json',
      'invalid_project_root',
      { projectDir: canonical },
    )
  }
  const gitRoot = await gitOutput(canonical, ['rev-parse', '--show-toplevel'])
  const canonicalGitRoot = await realpath(gitRoot.trim())
  if (canonicalGitRoot !== canonical) {
    throw new CanvasV2ResetError(
      'Project root must be the source Git worktree root',
      'unsafe_project_root',
      { projectDir: canonical, gitRoot: canonicalGitRoot },
    )
  }
  return canonical
}

async function assertUntrackedResetTargets(projectDir) {
  const tracked = await gitOutput(projectDir, [
    'ls-files',
    '-z',
    '--',
    '.gg/runtime',
    '.gg/canvas-state',
    '.gg/canvas-worktrees',
    'artifacts',
  ])
  const paths = tracked.split('\0').filter(Boolean)
  if (paths.length > 0) {
    throw new CanvasV2ResetError(
      'Reset targets contain source-Git tracked files',
      'tracked_reset_target',
      { paths },
    )
  }
}

async function assertSafeManagedParents(projectDir) {
  for (const relative of ['.gg', '.gg/legacy-v1', 'artifacts']) {
    const kind = await safePathKind(path.join(projectDir, relative))
    if (kind !== 'missing' && kind !== 'directory') {
      throw new CanvasV2ResetError(
        `Managed reset path must be a real directory: ${relative}`,
        'unsafe_managed_path',
        { relative, kind },
      )
    }
  }
  for (const target of RESET_TARGETS) {
    const kind = await safePathKind(path.join(projectDir, target.source))
    if (kind !== 'missing' && kind !== 'directory') {
      throw new CanvasV2ResetError(
        `Reset target must be a real directory: ${target.source}`,
        'unsafe_managed_path',
        { relative: target.source, kind },
      )
    }
  }
}

async function inspectDaemonLease(projectDir) {
  const leasePath = path.join(projectDir, '.gg/runtime/canvas-daemon.lock')
  const kind = await safePathKind(leasePath)
  if (kind === 'missing') return { state: 'absent' }
  if (kind !== 'file') {
    throw new CanvasV2ResetError(
      'Daemon lease must be a regular file',
      'unsafe_daemon_lease',
      { leasePath, kind },
    )
  }
  const owner = parseLeaseOwner(await readJsonNoFollow(leasePath))
  const alive = processIsAlive(owner.pid)
  return { state: alive ? 'live' : 'stale', pid: owner.pid, token: owner.token }
}

async function acquireMaintenanceLock(projectDir, now) {
  const filePath = path.join(projectDir, RESET_LOCK_RELATIVE)
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const owner = { version: 1, kind: 'canvas-v2-reset', pid: process.pid, token, createdAt: new Date(now).toISOString() }
  try {
    const handle = await open(filePath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = parseLeaseOwner(await readJsonNoFollow(filePath))
    throw new CanvasV2ResetError(
      processIsAlive(existing.pid)
        ? `Canvas maintenance is already active in process ${existing.pid}`
        : 'A stale canvas maintenance lock requires operator inspection',
      processIsAlive(existing.pid) ? 'canvas_maintenance_active' : 'canvas_maintenance_stale',
      { filePath, pid: existing.pid },
    )
  }
  return { filePath, token, projectDir }
}

async function fenceDaemonLease(projectDir, maintenance, options) {
  const leasePath = path.join(projectDir, '.gg/runtime/canvas-daemon.lock')
  await mkdir(path.dirname(leasePath), { recursive: true, mode: 0o700 })
  try {
    const handle = await open(leasePath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        token: maintenance.token,
        kind: 'canvas-v2-reset-fence',
      })}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { filePath: leasePath, token: maintenance.token }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  const kind = await safePathKind(leasePath)
  if (kind !== 'file') {
    throw new CanvasV2ResetError(
      'Daemon lease is not a regular file',
      'unsafe_daemon_lease',
      { leasePath, kind },
    )
  }
  const owner = parseLeaseOwner(await readJsonNoFollow(leasePath))
  if (processIsAlive(owner.pid)) {
    throw new CanvasV2ResetError(
      `Daemon process ${owner.pid} is still alive; stop it before resetting`,
      'daemon_instance_active',
      { leasePath, pid: owner.pid },
    )
  }
  if (!options.allowStale) {
    throw new CanvasV2ResetError(
      'A stale daemon lease appeared after the legacy runtime was archived',
      'daemon_lease_stale',
      { leasePath, pid: owner.pid },
    )
  }
  // Keep the stale file in place until its entire runtime directory is moved.
  // It remains a fence against pre-maintenance daemon binaries.
  return null
}

async function initializeCanvasV2(projectDir, journal) {
  const initializedAt = journal.completedAt ?? new Date().toISOString()
  const marker = {
    version: 1,
    canvasModel: 2,
    initializedAt,
    legacyArchive: journal.archiveRelative,
  }
  const markerPath = path.join(projectDir, MODEL_MARKER_RELATIVE)
  const existingMarker = await readOptionalJsonNoFollow(markerPath)
  if (existingMarker) {
    if (
      existingMarker.version !== marker.version
      || existingMarker.canvasModel !== marker.canvasModel
      || existingMarker.legacyArchive !== marker.legacyArchive
    ) {
      throw new CanvasV2ResetError(
        'Existing Canvas model marker belongs to another reset',
        'canvas_v2_reset_state_conflict',
        { markerPath },
      )
    }
  } else {
    await atomicWriteJson(markerPath, marker)
  }

  const snapshotPath = path.join(
    projectDir,
    '.gg/runtime/canvas-v2',
    MAIN_BRANCH_STORAGE_ID,
    'snapshot.json',
  )
  const snapshot = {
    branch: 'main',
    revision: 0,
    updatedAt: EMPTY_UPDATED_AT,
    lastMutationId: null,
    lastCheckpoint: null,
    document: {
      schemaVersion: 2,
      nodes: [],
      tasks: [],
      collections: [],
      edges: [],
      receipts: [],
      everCreated: false,
    },
  }
  const existingSnapshot = await readOptionalJsonNoFollow(snapshotPath)
  if (existingSnapshot) {
    if (JSON.stringify(existingSnapshot) !== JSON.stringify(snapshot)) {
      throw new CanvasV2ResetError(
        'Existing Canvas V2 main snapshot is not pristine',
        'canvas_v2_reset_state_conflict',
        { snapshotPath },
      )
    }
  } else {
    await atomicWriteJson(snapshotPath, snapshot)
  }
  await mkdir(path.join(projectDir, 'artifacts/.branches'), { recursive: true, mode: 0o700 })
}

function resetPreviewFromJournal(projectDir, journal, resumed) {
  return {
    version: 1,
    projectDir,
    archiveRelative: journal.archiveRelative,
    markerRelative: MODEL_MARKER_RELATIVE,
    journalRelative: RESET_JOURNAL_RELATIVE,
    operations: structuredClone(journal.operations),
    daemonLease: { state: 'fenced' },
    resumed,
  }
}

function parseJournal(value, projectDir) {
  if (!isRecord(value) || value.version !== 1 || value.projectDir !== projectDir) {
    throw new CanvasV2ResetError('Invalid Canvas V2 reset journal', 'invalid_reset_journal')
  }
  if (
    typeof value.archiveRelative !== 'string'
    || !/^\.gg\/legacy-v1\/[0-9]{8}T[0-9]{6}\.[0-9]{3}Z$/u.test(value.archiveRelative)
    || !['archiving', 'initializing', 'complete'].includes(value.phase)
    || !Array.isArray(value.operations)
    || value.operations.length !== RESET_TARGETS.length
  ) {
    throw new CanvasV2ResetError('Invalid Canvas V2 reset journal fields', 'invalid_reset_journal')
  }
  const operations = value.operations.map((operation, index) => {
    const expected = RESET_TARGETS[index]
    const expectedDestination = path.posix.join(value.archiveRelative, expected.archive)
    if (
      !isRecord(operation)
      || operation.source !== expected.source
      || operation.destination !== expectedDestination
      || !['pending', 'moved', 'absent'].includes(operation.status)
    ) {
      throw new CanvasV2ResetError('Invalid Canvas V2 reset operation', 'invalid_reset_journal')
    }
    return { source: operation.source, destination: operation.destination, status: operation.status }
  })
  return {
    version: 1,
    projectDir,
    archiveRelative: value.archiveRelative,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : EMPTY_UPDATED_AT,
    phase: value.phase,
    operations,
    ...(typeof value.completedAt === 'string' ? { completedAt: value.completedAt } : {}),
  }
}

function parseLeaseOwner(value) {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.token !== 'string'
    || !value.token
  ) {
    throw new CanvasV2ResetError(
      'Daemon or maintenance lease owner is invalid; refusing to assume it is stale',
      'invalid_lease_owner',
    )
  }
  return { pid: value.pid, token: value.token }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function releaseMaintenanceLock(maintenance) {
  try {
    const owner = parseLeaseOwner(await readJsonNoFollow(maintenance.filePath))
    if (owner.token === maintenance.token) await unlink(maintenance.filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function releaseDaemonFence(fence) {
  if (!fence) return
  try {
    const owner = parseLeaseOwner(await readJsonNoFollow(fence.filePath))
    if (owner.token === fence.token) await unlink(fence.filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function safePathKind(filePath) {
  try {
    const info = await lstat(filePath)
    if (info.isSymbolicLink()) return 'symlink'
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readJsonNoFollow(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return JSON.parse(await handle.readFile('utf8'))
  } finally {
    await handle.close()
  }
}

async function readOptionalJsonNoFollow(filePath) {
  try {
    return await readJsonNoFollow(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, filePath)
    await syncDirectory(path.dirname(filePath))
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

async function syncDirectory(directory) {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function gitOutput(projectDir, arguments_) {
  try {
    const result = await execFileAsync('git', ['-C', projectDir, ...arguments_], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    throw new CanvasV2ResetError(
      `Git validation failed: ${error.stderr?.trim() || error.message}`,
      'git_validation_failed',
    )
  }
}

function resetTimestamp(value) {
  return new Date(value).toISOString().replaceAll('-', '').replaceAll(':', '')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCli(argv) {
  const result = { projectRoot: process.cwd(), apply: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--project-root') {
      result.projectRoot = argv[++index] ?? ''
    } else if (argument === '--apply') {
      result.apply = true
    } else if (argument === '--json') {
      result.json = true
    } else if (argument === '--help' || argument === '-h') {
      result.help = true
    } else {
      throw new CanvasV2ResetError(`Unknown argument: ${argument}`, 'invalid_argument')
    }
  }
  return result
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    process.stdout.write([
      'Usage: npm run canvas:v2:reset -- [--project-root DIR] [--apply] [--json]',
      '',
      'Without --apply this command is read-only and prints the archive plan.',
      'With --apply it refuses live daemons, archives V1 state, and initializes V2.',
      '',
    ].join('\n'))
    return
  }
  const result = options.apply
    ? await applyCanvasV2Reset(options.projectRoot)
    : await inspectCanvasV2Reset(options.projectRoot)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(`${options.apply ? 'Canvas V2 reset complete' : 'Canvas V2 reset preview'}\n`)
  process.stdout.write(`Project: ${result.projectDir}\n`)
  process.stdout.write(`Archive: ${result.archiveRelative}\n`)
  for (const operation of result.operations) {
    process.stdout.write(`- ${operation.source} -> ${operation.destination} [${operation.status}]\n`)
  }
  if (!options.apply) process.stdout.write('No files changed. Re-run with --apply to execute this plan.\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof CanvasV2ResetError ? error.code : 'unexpected_error'
    process.stderr.write(`[${code}] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
