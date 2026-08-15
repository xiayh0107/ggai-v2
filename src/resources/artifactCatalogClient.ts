export const ARTIFACT_CATALOG_SCHEMA_VERSION = 2
export const MAX_ARTIFACT_CATALOG_PAGE_SIZE = 500

export interface ProjectArtifactResource {
  runId: string
  artifactId: string
  taskId: string
  canvasBranch: string
  relativePath: string
  mediaType: string
  size: number
  contentDigest: string
  createdAt: number
}

export interface ProjectArtifactCatalogPage {
  schemaVersion: 2
  artifacts: ProjectArtifactResource[]
  truncated: boolean
  partial: boolean
  nextCursor: string | null
}

export interface ProjectArtifactCatalogApi {
  list(input: {
    projectDir: string
    branch?: string
    limit?: number
    cursor?: string
    signal?: AbortSignal
  }): Promise<ProjectArtifactCatalogPage>
  artifactUrl(projectDir: string, artifact: Pick<ProjectArtifactResource, 'runId' | 'artifactId'>): string
}

export class ArtifactCatalogProtocolError extends Error {}

export class ProjectArtifactCatalogClient implements ProjectArtifactCatalogApi {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(options: { baseUrl: string; fetch?: typeof fetch }) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async list(input: {
    projectDir: string
    branch?: string
    limit?: number
    cursor?: string
    signal?: AbortSignal
  }): Promise<ProjectArtifactCatalogPage> {
    const projectDir = requiredString(input.projectDir, 'projectDir', 4_096)
    if (input.branch !== undefined) requiredString(input.branch, 'branch', 120)
    if (input.limit !== undefined
      && (!Number.isSafeInteger(input.limit)
        || input.limit < 1
        || input.limit > MAX_ARTIFACT_CATALOG_PAGE_SIZE)) {
      throw new TypeError(`limit must be between 1 and ${MAX_ARTIFACT_CATALOG_PAGE_SIZE}`)
    }
    const cursor = input.cursor === undefined
      ? undefined
      : catalogCursor(input.cursor, 'cursor')
    const url = new URL('/artifact-catalog', this.#baseUrl)
    url.searchParams.set('projectDir', projectDir)
    if (input.branch) url.searchParams.set('branch', input.branch)
    if (input.limit) url.searchParams.set('limit', String(input.limit))
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await this.#fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: input.signal,
    })
    if (!response.ok) throw new Error(`资源列表加载失败（HTTP ${response.status}）`)
    const page = parseArtifactCatalogPage(await response.json())
    if (cursor !== undefined && page.nextCursor === cursor) {
      throw protocol('资源列表响应重复了请求游标')
    }
    return page
  }

  artifactUrl(
    projectDir: string,
    artifact: Pick<ProjectArtifactResource, 'runId' | 'artifactId'>,
  ): string {
    const url = new URL(
      `/runs/${encodeURIComponent(requiredString(artifact.runId, 'runId', 160))}`
        + `/artifacts/${encodeURIComponent(artifactId(artifact.artifactId, 'artifactId'))}`,
      this.#baseUrl,
    )
    url.searchParams.set('projectDir', requiredString(projectDir, 'projectDir', 4_096))
    return url.toString()
  }
}

export function parseArtifactCatalogPage(value: unknown): ProjectArtifactCatalogPage {
  const envelope = exactRecord(
    value,
    ['schemaVersion', 'artifacts', 'truncated', 'partial', 'nextCursor'],
    '资源列表响应',
  )
  if (envelope.schemaVersion !== ARTIFACT_CATALOG_SCHEMA_VERSION
    || !Array.isArray(envelope.artifacts)
    || typeof envelope.truncated !== 'boolean'
    || typeof envelope.partial !== 'boolean'
    || (envelope.nextCursor !== null && typeof envelope.nextCursor !== 'string')) {
    throw protocol('资源列表响应格式无效')
  }
  if (envelope.artifacts.length > MAX_ARTIFACT_CATALOG_PAGE_SIZE) {
    throw protocol('资源列表响应超出页面上限')
  }
  const nextCursor = envelope.nextCursor === null
    ? null
    : catalogCursor(envelope.nextCursor, '资源列表响应.nextCursor')
  if ((nextCursor !== null) !== envelope.truncated) {
    throw protocol('资源列表响应的续页状态无效')
  }
  const seen = new Set<string>()
  const artifacts = envelope.artifacts.map((value, index): ProjectArtifactResource => {
    const context = `资源列表响应.artifacts[${index}]`
    const record = exactRecord(value, [
      'runId',
      'artifactId',
      'taskId',
      'canvasBranch',
      'relativePath',
      'mediaType',
      'size',
      'contentDigest',
      'createdAt',
    ], context)
    const runId = identifier(record.runId, `${context}.runId`)
    const parsedArtifactId = artifactId(record.artifactId, `${context}.artifactId`)
    const item: ProjectArtifactResource = {
      runId,
      artifactId: parsedArtifactId,
      taskId: identifier(record.taskId, `${context}.taskId`),
      canvasBranch: branch(record.canvasBranch, `${context}.canvasBranch`),
      relativePath: relativePath(record.relativePath, `${context}.relativePath`),
      mediaType: mediaType(record.mediaType, `${context}.mediaType`),
      size: safeInteger(record.size, `${context}.size`),
      contentDigest: digest(record.contentDigest, `${context}.contentDigest`),
      createdAt: timestamp(record.createdAt, `${context}.createdAt`),
    }
    const key = `${runId}\u0000${parsedArtifactId}`
    if (seen.has(key)) throw protocol(`${context} 与其他资源重复`)
    seen.add(key)
    return item
  })
  return {
    schemaVersion: ARTIFACT_CATALOG_SCHEMA_VERSION,
    artifacts,
    truncated: envelope.truncated,
    partial: envelope.partial,
    nextCursor,
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('baseUrl must use http or https')
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function exactRecord(value: unknown, keys: string[], context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocol(`${context} 必须是对象`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw protocol(`${context} 字段不完整或包含未知字段`)
  }
  return record
}

function requiredString(value: unknown, context: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw protocol(`${context} 无效`)
  }
  return value
}

function catalogCursor(value: unknown, context: string): string {
  const result = requiredString(value, context, 1_024)
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) throw protocol(`${context} 无效`)
  return result
}

function identifier(value: unknown, context: string): string {
  const result = requiredString(value, context, 160)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(result) || result.includes('..')) {
    throw protocol(`${context} 无效`)
  }
  return result
}

function artifactId(value: unknown, context: string): string {
  const result = requiredString(value, context, 73)
  if (!/^artifact_[0-9a-f]{64}$/u.test(result)) throw protocol(`${context} 无效`)
  return result
}

function branch(value: unknown, context: string): string {
  const result = requiredString(value, context, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(result)
    || result.includes('..')
    || result.includes('//')) throw protocol(`${context} 无效`)
  return result
}

function relativePath(value: unknown, context: string): string {
  const result = requiredString(value, context, 4_096)
  if (result.startsWith('/')
    || result.endsWith('/')
    || result.includes('\\')
    || result.includes('\0')
    || result.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw protocol(`${context} 无效`)
  }
  return result
}

function mediaType(value: unknown, context: string): string {
  const result = requiredString(value, context, 200)
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(result)) {
    throw protocol(`${context} 无效`)
  }
  return result
}

function digest(value: unknown, context: string): string {
  const result = requiredString(value, context, 64)
  if (!/^[0-9a-f]{64}$/u.test(result)) throw protocol(`${context} 无效`)
  return result
}

function safeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocol(`${context} 无效`)
  return value as number
}

function timestamp(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw protocol(`${context} 无效`)
  }
  return value
}

function protocol(message: string): ArtifactCatalogProtocolError {
  return new ArtifactCatalogProtocolError(message)
}
