import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  inspectRunOutcome,
  type RunOutcome,
} from '../src/agent/outcome.js'

export const RUN_OUTCOME_RELATIVE_PATH = '.ggai/run-result.json'
export const MAX_RUN_OUTCOME_BYTES = 1024 * 1024

const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

/**
 * Reads an optional Agent-authored outcome from a daemon-selected files root.
 *
 * This boundary is deliberately fail-closed and non-fatal: malformed JSON,
 * unsupported schemas, path indirection, and files that change while being
 * read all degrade to no outcome. The terminal run status decides whether this
 * function is called; unsuccessful runs must never consult the sidecar.
 */
export async function readRunOutcome(
  filesRoot: string,
): Promise<RunOutcome | undefined> {
  const absoluteFilesRoot = path.resolve(filesRoot)
  const controlDirectory = path.join(absoluteFilesRoot, '.ggai')
  const outcomePath = path.join(controlDirectory, 'run-result.json')

  try {
    const filesRootInfo = await lstat(absoluteFilesRoot)
    if (!filesRootInfo.isDirectory() || filesRootInfo.isSymbolicLink()) return undefined
    const canonicalFilesRoot = await realpath(absoluteFilesRoot)

    const controlInfo = await lstat(controlDirectory)
    if (!controlInfo.isDirectory() || controlInfo.isSymbolicLink()) return undefined
    const canonicalControlDirectory = await realpath(controlDirectory)
    if (canonicalControlDirectory !== path.join(canonicalFilesRoot, '.ggai')) return undefined

    const outcomeInfo = await lstat(outcomePath)
    if (!outcomeInfo.isFile() || outcomeInfo.isSymbolicLink() || outcomeInfo.nlink !== 1) {
      return undefined
    }
    if (outcomeInfo.size <= 0 || outcomeInfo.size > MAX_RUN_OUTCOME_BYTES) return undefined
    const canonicalOutcomePath = await realpath(outcomePath)
    if (canonicalOutcomePath !== path.join(canonicalControlDirectory, 'run-result.json')) {
      return undefined
    }

    const handle = await open(outcomePath, constants.O_RDONLY | NO_FOLLOW_FLAG)
    try {
      const openedInfo = await handle.stat()
      if (!openedInfo.isFile()
        || openedInfo.dev !== outcomeInfo.dev
        || openedInfo.ino !== outcomeInfo.ino
        || openedInfo.nlink !== 1
        || openedInfo.size <= 0
        || openedInfo.size > MAX_RUN_OUTCOME_BYTES) return undefined

      const buffer = Buffer.alloc(MAX_RUN_OUTCOME_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const finalInfo = await handle.stat()
      if (bytesRead <= 0
        || bytesRead > MAX_RUN_OUTCOME_BYTES
        || finalInfo.size !== bytesRead
        || finalInfo.dev !== openedInfo.dev
        || finalInfo.ino !== openedInfo.ino
        || finalInfo.mtimeMs !== openedInfo.mtimeMs
        || finalInfo.ctimeMs !== openedInfo.ctimeMs) return undefined

      const source = new TextDecoder('utf-8', { fatal: true })
        .decode(buffer.subarray(0, bytesRead))
      const inspection = inspectRunOutcome(JSON.parse(source) as unknown)
      return inspection.status === 'valid' ? inspection.outcome : undefined
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}
