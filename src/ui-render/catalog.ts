export interface UiRenderPrinciple {
  id: string
  label: string
  description: string
}

export interface UiRenderJourney {
  id: string
  label: string
  description: string
}

export type UiRenderCheck =
  | { kind: 'selector-count'; selector: string; count: number; label: string }
  | { kind: 'selector-visible'; selector: string; label: string }
  | { kind: 'text-present' | 'text-absent'; text: string; label: string }

export interface UiRenderScenarioCatalogEntry {
  id: string
  title: string
  description: string
  journeyId: string
  step: number
  viewport: { width: number; height: number }
  readySelector: string
  state: {
    phase: string
    selection: string
    controlOwner: string
    disclosure: string
  }
  principleIds: string[]
  checkpoints: string[]
  checks: UiRenderCheck[]
}

export interface UiRenderCatalog {
  schemaVersion: 2
  principles: UiRenderPrinciple[]
  journeys: UiRenderJourney[]
  scenarios: UiRenderScenarioCatalogEntry[]
}
