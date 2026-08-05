import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  inspectRunOutcome,
  type RunOutcome,
} from '../src/agent/outcome.js'

export {
  MAX_SUGGESTED_ACTION_ID_LENGTH,
  MAX_SUGGESTED_ACTION_LABEL_LENGTH,
  MAX_SUGGESTED_ACTION_PROMPT_LENGTH,
  MAX_SUGGESTED_ACTIONS,
  MIN_SUGGESTED_ACTIONS,
} from '../src/agent/outcome.js'

export const RUN_OUTCOME_RELATIVE_PATH = '.ggai/run-result.json'
export const MAX_RUN_OUTCOME_BYTES = 16 * 1024
const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

/**
 * Read the small, Agent-authored semantic result for one already-settled run.
 *
 * The artifact directory is selected by the daemon, not by sidecar contents.
 * Invalid or unsafe files deliberately degrade to no outcome so a useful run
 * never becomes an error solely because this optional control file is absent.
 */
export async function readRunOutcome(artifactDir: string): Promise<RunOutcome | undefined> {
  const absoluteArtifactDir = path.resolve(artifactDir)
  const controlDir = path.join(absoluteArtifactDir, '.ggai')
  const outcomePath = path.join(controlDir, 'run-result.json')

  try {
    const artifactInfo = await lstat(absoluteArtifactDir)
    if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink()) return undefined
    const canonicalArtifactDir = await realpath(absoluteArtifactDir)

    const controlInfo = await lstat(controlDir)
    if (!controlInfo.isDirectory() || controlInfo.isSymbolicLink()) return undefined
    const canonicalControlDir = await realpath(controlDir)
    if (canonicalControlDir !== path.join(canonicalArtifactDir, '.ggai')) return undefined

    const outcomeInfo = await lstat(outcomePath)
    if (!outcomeInfo.isFile() || outcomeInfo.isSymbolicLink()) return undefined
    if (outcomeInfo.size <= 0 || outcomeInfo.size > MAX_RUN_OUTCOME_BYTES) return undefined
    const canonicalOutcomePath = await realpath(outcomePath)
    if (canonicalOutcomePath !== path.join(canonicalControlDir, 'run-result.json')) return undefined

    // Windows does not implement O_NOFOLLOW. The surrounding lstat/realpath
    // checks and post-open inode comparison retain the same fail-closed shape.
    const handle = await open(outcomePath, constants.O_RDONLY | NO_FOLLOW_FLAG)
    try {
      const openedInfo = await handle.stat()
      if (
        !openedInfo.isFile()
        || openedInfo.dev !== outcomeInfo.dev
        || openedInfo.ino !== outcomeInfo.ino
        || openedInfo.size <= 0
        || openedInfo.size > MAX_RUN_OUTCOME_BYTES
      ) return undefined

      // A fixed-size read keeps the bound intact even if a writer grows the
      // file between lstat and read.
      const buffer = Buffer.alloc(MAX_RUN_OUTCOME_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const finalInfo = await handle.stat()
      if (bytesRead === 0 || bytesRead > MAX_RUN_OUTCOME_BYTES) return undefined
      if (finalInfo.size !== bytesRead || finalInfo.size > MAX_RUN_OUTCOME_BYTES) return undefined

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
