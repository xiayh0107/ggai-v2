import type { FilesystemBinding, FilesystemConflict } from './contracts'

export class FilesystemClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(baseUrl: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.#baseUrl = baseUrl.replace(/\/$/u, '')
    this.#fetch = fetchImpl
  }

  async binding(projectDir: string, bindingId: string): Promise<FilesystemBinding> {
    const url = this.#url(`/filesystem/bindings/${encodeURIComponent(bindingId)}`, projectDir)
    return decodeBinding(await this.#fetch(url))
  }

  async save(projectDir: string, branch: string, bindingId: string): Promise<FilesystemBinding> {
    const url = this.#url(`/filesystem/bindings/${encodeURIComponent(bindingId)}/save`, projectDir)
    url.searchParams.set('branch', branch)
    return decodeBinding(await this.#fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }))
  }

  async conflicts(projectDir: string): Promise<FilesystemConflict[]> {
    const response = await this.#fetch(this.#url('/filesystem/conflicts', projectDir))
    const value = await response.json() as unknown
    if (!response.ok) throw responseError(response.status, value)
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.conflicts)) {
      throw new TypeError('filesystem conflicts response is invalid')
    }
    return structuredClone(value.conflicts) as FilesystemConflict[]
  }

  #url(pathname: string, projectDir: string): URL {
    const url = new URL(pathname, `${this.#baseUrl}/`)
    url.searchParams.set('projectDir', projectDir)
    return url
  }
}

async function decodeBinding(response: Response): Promise<FilesystemBinding> {
  const value = await response.json() as unknown
  if (!response.ok) throw responseError(response.status, value)
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.binding)
    || typeof value.binding.bindingId !== 'string' || typeof value.binding.state !== 'string') {
    throw new TypeError('filesystem binding response is invalid')
  }
  return structuredClone(value.binding) as unknown as FilesystemBinding
}

function responseError(status: number, value: unknown): Error {
  return new Error(isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string'
    ? value.error.message : `filesystem request failed (${status})`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
