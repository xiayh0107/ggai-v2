import type { PdfPageBaseline } from './contracts'

export class PdfImportClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  constructor(baseUrl: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.#baseUrl = baseUrl.replace(/\/$/u, '')
    this.#fetch = fetchImpl
  }

  async page(input: {
    projectDir: string
    importId: string
    pageNumber: number
  }): Promise<PdfPageBaseline> {
    const url = new URL(`/imports/${encodeURIComponent(input.importId)}/plan`, `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', input.projectDir)
    url.searchParams.set('page', String(input.pageNumber))
    const response = await this.#fetch(url)
    const value = await response.json() as unknown
    if (!response.ok) throw new Error(errorMessage(value, response.status))
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.page)
      || value.page.importId !== input.importId || value.page.pageNumber !== input.pageNumber
      || !isRecord(value.page.preview)) {
      throw new TypeError('PDF page response is invalid')
    }
    return structuredClone(value.page) as unknown as PdfPageBaseline
  }
}

function errorMessage(value: unknown, status: number): string {
  return isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string'
    ? value.error.message : `PDF request failed (${status})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
