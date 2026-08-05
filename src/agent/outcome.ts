/** A context-aware next step produced by the Agent for a completed run. */
export interface SuggestedAction {
  id: string
  label: string
  prompt: string
}

export const MIN_SUGGESTED_ACTIONS = 3
export const MAX_SUGGESTED_ACTIONS = 5
export const MAX_SUGGESTED_ACTION_ID_LENGTH = 80
export const MAX_SUGGESTED_ACTION_LABEL_LENGTH = 80
export const MAX_SUGGESTED_ACTION_PROMPT_LENGTH = 1_000

/**
 * Versioned, transport-neutral semantic result of one Agent run.
 *
 * Progress stays in CanvasAgentEvent and files stay in the artifact snapshot.
 * This envelope is only for small structured results that the canvas can use
 * after the run has committed, such as suggested next actions.
 */
export interface RunOutcomeV1 {
  schemaVersion: 1
  suggestedActions: SuggestedAction[]
}

export type RunOutcome = RunOutcomeV1

export type RunOutcomeInspection =
  | { status: 'valid'; outcome: RunOutcome }
  | { status: 'unsupported' }
  | { status: 'invalid' }

/**
 * Pure schema inspection shared by daemon and browser trust boundaries.
 * File/path safety deliberately remains a daemon responsibility.
 */
export function inspectRunOutcome(value: unknown): RunOutcomeInspection {
  if (!isRecord(value)) return { status: 'invalid' }
  if (!Object.prototype.hasOwnProperty.call(value, 'schemaVersion')
    || !Number.isSafeInteger(value.schemaVersion)) return { status: 'invalid' }
  if (value.schemaVersion !== 1) return { status: 'unsupported' }
  if (!isExactRecord(value, ['schemaVersion', 'suggestedActions'])
    || !Array.isArray(value.suggestedActions)
    || value.suggestedActions.length < MIN_SUGGESTED_ACTIONS
    || value.suggestedActions.length > MAX_SUGGESTED_ACTIONS) {
    return { status: 'invalid' }
  }

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
  return {
    status: 'valid',
    outcome: { schemaVersion: 1, suggestedActions },
  }
}

function isSuggestedAction(value: unknown): value is SuggestedAction {
  if (!isExactRecord(value, ['id', 'label', 'prompt'])) return false
  return isBoundedString(value.id, MAX_SUGGESTED_ACTION_ID_LENGTH)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.id)
    && isBoundedString(value.label, MAX_SUGGESTED_ACTION_LABEL_LENGTH)
    && !containsAsciiControl(value.label)
    && isBoundedString(value.prompt, MAX_SUGGESTED_ACTION_PROMPT_LENGTH)
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key))
}
