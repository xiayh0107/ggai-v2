import type { CanvasCommand } from '../src/canvas/commands.js'
import { parseCanvasDocument, type CanvasDocument } from '../src/canvas/model.js'

export interface HeadlessCanvasScope {
  projectDir: string
  branch: string
}

export interface HeadlessCanvasEnvelope {
  branch: string
  revision: number
  updatedAt: string
  lastMutationId: string | null
  document: CanvasDocument
}

export interface HeadlessCanvasCommandEntry {
  branch: string
  baseRevision: number
  initialBaseRevision: number
  mutationId: string
  command: CanvasCommand
  createdAt: number
}

export class HeadlessCanvasClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: { baseUrl: string; fetch?: typeof globalThis.fetch }) {
    this.#baseUrl = options.baseUrl
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async getCanvas(scope: HeadlessCanvasScope): Promise<HeadlessCanvasEnvelope> {
    const response = await this.#fetch(this.#url('/canvas', scope), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    return this.#readEnvelope(response, scope.branch, 'GET /canvas')
  }

  async executeCommand(
    scope: HeadlessCanvasScope,
    entry: HeadlessCanvasCommandEntry,
  ): Promise<HeadlessCanvasEnvelope> {
    if (entry.branch !== scope.branch || entry.initialBaseRevision !== entry.baseRevision) {
      throw new TypeError('headless Canvas command scope is inconsistent')
    }
    const response = await this.#fetch(this.#url('/canvas/commands', scope), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        branch: entry.branch,
        baseRevision: entry.baseRevision,
        mutationId: entry.mutationId,
        command: entry.command,
      }),
    })
    return this.#readEnvelope(response, scope.branch, 'POST /canvas/commands')
  }

  #url(pathname: string, scope: HeadlessCanvasScope): string {
    if (!scope.projectDir.trim() || !scope.branch.trim()) {
      throw new TypeError('Canvas scope requires projectDir and branch')
    }
    const url = new URL(pathname, `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', scope.projectDir)
    url.searchParams.set('branch', scope.branch)
    return url.toString()
  }

  async #readEnvelope(
    response: Response,
    expectedBranch: string,
    operation: string,
  ): Promise<HeadlessCanvasEnvelope> {
    const value = await response.json() as unknown
    if (!response.ok) throw new Error(responseError(value, response.status, operation))
    if (!isEnvelopeRecord(value)
      || value.branch !== expectedBranch
      || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 0
      || typeof value.updatedAt !== 'string'
      || (value.lastMutationId !== null && typeof value.lastMutationId !== 'string')) {
      throw new TypeError(`${operation} response was malformed`)
    }
    return {
      branch: expectedBranch,
      revision: value.revision as number,
      updatedAt: value.updatedAt,
      lastMutationId: value.lastMutationId as string | null,
      document: parseCanvasDocument(value.document),
    }
  }
}

function responseError(value: unknown, status: number, operation: string): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message
  }
  return `${operation} failed (HTTP ${status})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvelopeRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value)
  const required = ['branch', 'revision', 'updatedAt', 'lastMutationId', 'document']
  const allowed = new Set([...required, 'lastCheckpoint'])
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every((key) => allowed.has(key))
}
