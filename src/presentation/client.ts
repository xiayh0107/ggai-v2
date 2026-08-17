import type {
  PresentationExportMode,
  PresentationExportResponse,
} from './contracts'

export class PresentationExportClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  constructor(baseUrl: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.#baseUrl = baseUrl.replace(/\/$/u, '')
    this.#fetch = fetchImpl
  }

  async export(input: {
    projectDir: string
    branch: string
    presentationNodeId: string
    mode: PresentationExportMode
  }): Promise<PresentationExportResponse> {
    const url = new URL('/exports/pptx', `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', input.projectDir)
    url.searchParams.set('branch', input.branch)
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        presentationNodeId: input.presentationNodeId,
        mode: input.mode,
      }),
    })
    const value = await response.json() as unknown
    if (!response.ok) throw new Error(errorMessage(value, response.status))
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.export)
      || typeof value.export.runId !== 'string' || !isRecord(value.export.pptx)) {
      throw new TypeError('PPTX export response is invalid')
    }
    return structuredClone(value.export) as unknown as PresentationExportResponse
  }
}

function errorMessage(value: unknown, status: number): string {
  return isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string'
    ? value.error.message : `PPTX export failed (${status})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
