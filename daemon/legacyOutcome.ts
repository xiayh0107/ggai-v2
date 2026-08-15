import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { SuggestedAction } from '../src/agent/suggestedActions.js'

export {
  MAX_SUGGESTED_ACTION_ID_LENGTH,
  MAX_SUGGESTED_ACTION_LABEL_LENGTH,
  MAX_SUGGESTED_ACTION_PROMPT_LENGTH,
  MAX_SUGGESTED_ACTIONS,
  MIN_SUGGESTED_ACTIONS,
} from '../src/agent/suggestedActions.js'

export const RUN_OUTCOME_RELATIVE_PATH = '.ggai/run-result.json'
export const MAX_RUN_OUTCOME_BYTES = 16 * 1024
const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

export interface LegacyRunOutcome {
  schemaVersion: 1
  suggestedActions: SuggestedAction[]
}

type LegacyRunOutcomeInspection =
  | { status: 'valid'; outcome: LegacyRunOutcome }
  | { status: 'unsupported' }
  | { status: 'invalid' }

export function inspectLegacyRunOutcome(value: unknown): LegacyRunOutcomeInspection {
  if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion)) return { status: 'invalid' }
  if (value.schemaVersion !== 1) return { status: 'unsupported' }
  if (!hasExactKeys(value, ['schemaVersion', 'suggestedActions'])
    || !Array.isArray(value.suggestedActions)
    || value.suggestedActions.length < 3
    || value.suggestedActions.length > 5) return { status: 'invalid' }
  const ids = new Set<string>()
  const contents = new Set<string>()
  const suggestedActions: SuggestedAction[] = []
  for (const candidate of value.suggestedActions) {
    if (!isSuggestedAction(candidate) || ids.has(candidate.id)) return { status: 'invalid' }
    const contentKey = JSON.stringify([candidate.label, candidate.prompt])
    if (contents.has(contentKey)) return { status: 'invalid' }
    ids.add(candidate.id)
    contents.add(contentKey)
    suggestedActions.push(candidate)
  }
  return { status: 'valid', outcome: { schemaVersion: 1, suggestedActions } }
}

function isSuggestedAction(value: unknown): value is SuggestedAction {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'label', 'prompt'])
    && isBoundedString(value.id, 80)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.id)
    && isBoundedDisplayString(value.label, 80)
    && isBoundedDisplayString(value.prompt, 1_000)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
}

function isBoundedDisplayString(value: unknown, maxLength: number): value is string {
  if (!isBoundedString(value, maxLength)) return false
  return ![...value].some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point <= 0x1f || point === 0x7f
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

/**
 * Read the small, Agent-authored semantic result for one already-settled run.
 *
 * The artifact directory is selected by the daemon, not by sidecar contents.
 * Invalid or unsafe files deliberately degrade to no outcome so a useful run
 * never becomes an error solely because this optional control file is absent.
 */
export async function readLegacyRunOutcome(
  artifactDir: string,
): Promise<LegacyRunOutcome | undefined> {
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
      const inspection = inspectLegacyRunOutcome(JSON.parse(source) as unknown)
      return inspection.status === 'valid' ? inspection.outcome : undefined
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}
