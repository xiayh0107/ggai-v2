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
