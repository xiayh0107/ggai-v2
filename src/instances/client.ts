import type { CanvasEdge, CanvasNode } from '../canvas/model'

export class InstanceClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  constructor(baseUrl: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.#baseUrl = baseUrl.replace(/\/$/u, '')
    this.#fetch = fetchImpl
  }

  async resolved(input: {
    projectDir: string
    branch: string
    nodeId: string
  }): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }> {
    const url = new URL(`/instances/${encodeURIComponent(input.nodeId)}/resolved`, `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', input.projectDir)
    url.searchParams.set('branch', input.branch)
    const response = await this.#fetch(url)
    const value = await response.json() as unknown
    if (!response.ok) throw new Error(errorMessage(value, response.status))
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.resolved)
      || !Array.isArray(value.resolved.nodes) || !Array.isArray(value.resolved.edges)) {
      throw new TypeError('Resolved instance response is invalid')
    }
    return structuredClone(value.resolved) as unknown as { nodes: CanvasNode[]; edges: CanvasEdge[] }
  }
}

function errorMessage(value: unknown, status: number): string {
  return isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string'
    ? value.error.message : `Instance request failed (${status})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
