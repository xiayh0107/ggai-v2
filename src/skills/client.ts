import {
  SKILL_ASSET_SCHEMA_VERSION,
  canonicalSkillAssetRef,
  canonicalSkillAssetRefs,
  isNodeTypeId,
  isSkillId,
  type NodeTypeSkillBindings,
  type SkillAssetRef,
  type SkillAssetSummary,
} from './contracts'

export interface SkillAssetCatalogPayload {
  schemaVersion: typeof SKILL_ASSET_SCHEMA_VERSION
  assets: SkillAssetSummary[]
  typeBindings: NodeTypeSkillBindings[]
}

export interface SkillAssetApi {
  list(signal?: AbortSignal): Promise<SkillAssetCatalogPayload>
  import(input: {
    sourcePath: string
    skillId: string
    expectedRevision: number
    signal?: AbortSignal
  }): Promise<SkillAssetSummary>
  archive(skillId: string, signal?: AbortSignal): Promise<string>
  updateTypeBindings(input: {
    nodeType: string
    expectedRevision: number
    skills: SkillAssetRef[]
    signal?: AbortSignal
  }): Promise<NodeTypeSkillBindings>
}

export class SkillAssetRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SkillAssetRequestError'
    this.status = status
    this.code = code
  }
}

export class SkillAssetClient implements SkillAssetApi {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: { baseUrl: string; fetch?: typeof globalThis.fetch }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async list(signal?: AbortSignal): Promise<SkillAssetCatalogPayload> {
    return decodeCatalog(await this.#request('/skill-assets', { signal }))
  }

  async import(input: {
    sourcePath: string
    skillId: string
    expectedRevision: number
    signal?: AbortSignal
  }): Promise<SkillAssetSummary> {
    if (!isSkillId(input.skillId)
      || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0
      || typeof input.sourcePath !== 'string'
      || !input.sourcePath.startsWith('/')) {
      throw new TypeError('skill import input is invalid')
    }
    const value = await this.#request('/skill-assets/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourcePath: input.sourcePath,
        skillId: input.skillId,
        expectedRevision: input.expectedRevision,
      }),
      signal: input.signal,
    })
    if (!isExactRecord(value, ['schemaVersion', 'asset'])
      || value.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION) {
      throw new TypeError('skill import response is invalid')
    }
    return decodeAsset(value.asset)
  }

  async archive(skillId: string, signal?: AbortSignal): Promise<string> {
    if (!isSkillId(skillId)) throw new TypeError('skillId is invalid')
    const value = await this.#request(`/skill-assets/${encodeURIComponent(skillId)}`, {
      method: 'DELETE',
      signal,
    })
    if (!isExactRecord(value, ['schemaVersion', 'archivedSkillId'])
      || value.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION
      || value.archivedSkillId !== skillId) {
      throw new TypeError('skill archive response is invalid')
    }
    return skillId
  }

  async updateTypeBindings(input: {
    nodeType: string
    expectedRevision: number
    skills: SkillAssetRef[]
    signal?: AbortSignal
  }): Promise<NodeTypeSkillBindings> {
    if (!isNodeTypeId(input.nodeType)
      || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0) {
      throw new TypeError('node type skill binding input is invalid')
    }
    const skills = canonicalSkillAssetRefs(input.skills)
    const value = await this.#request(
      `/skill-bindings/types/${encodeURIComponent(input.nodeType)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
          expectedRevision: input.expectedRevision,
          skills,
        }),
        signal: input.signal,
      },
    )
    if (!isExactRecord(value, ['schemaVersion', 'binding'])
      || value.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION) {
      throw new TypeError('node type skill binding response is invalid')
    }
    return decodeTypeBinding(value.binding)
  }

  async #request(pathname: string, init: RequestInit): Promise<unknown> {
    const response = await this.#fetch(new URL(pathname, `${this.#baseUrl}/`), {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
    })
    const value = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const error = isRecord(value) && isRecord(value.error) ? value.error : null
      throw new SkillAssetRequestError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'skill_asset_request_failed',
        typeof error?.message === 'string' ? error.message : `Request failed (${response.status})`,
      )
    }
    return value
  }
}

function decodeCatalog(value: unknown): SkillAssetCatalogPayload {
  if (!isExactRecord(value, ['schemaVersion', 'assets', 'typeBindings'])
    || value.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION
    || !Array.isArray(value.assets)
    || !Array.isArray(value.typeBindings)) {
    throw new TypeError('skill asset catalog response is invalid')
  }
  const assets = value.assets.map(decodeAsset)
  const typeBindings = value.typeBindings.map(decodeTypeBinding)
  return { schemaVersion: SKILL_ASSET_SCHEMA_VERSION, assets, typeBindings }
}

function decodeAsset(value: unknown): SkillAssetSummary {
  if (!isExactRecord(value, [
    'schemaVersion', 'skillId', 'revision', 'digest', 'title', 'description',
    'entrypoint', 'fileCount', 'totalBytes', 'importedAt', 'archived',
  ]) || value.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION
    || typeof value.title !== 'string' || value.title.length === 0 || value.title.length > 160
    || typeof value.description !== 'string' || value.description.length > 1_000
    || value.entrypoint !== 'SKILL.md'
    || !Number.isSafeInteger(value.fileCount) || (value.fileCount as number) < 1
    || !Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 1
    || typeof value.importedAt !== 'string'
    || new Date(value.importedAt).toISOString() !== value.importedAt
    || typeof value.archived !== 'boolean') {
    throw new TypeError('skill asset response is invalid')
  }
  return {
    schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
    ...canonicalSkillAssetRef({
      skillId: value.skillId,
      revision: value.revision,
      digest: value.digest,
    }),
    title: value.title,
    description: value.description,
    entrypoint: 'SKILL.md',
    fileCount: value.fileCount as number,
    totalBytes: value.totalBytes as number,
    importedAt: value.importedAt,
    archived: value.archived,
  }
}

function decodeTypeBinding(value: unknown): NodeTypeSkillBindings {
  if (!isExactRecord(value, ['schemaVersion', 'nodeType', 'revision', 'skills', 'updatedAt'])
    || value.schemaVersion !== SKILL_ASSET_SCHEMA_VERSION
    || !isNodeTypeId(value.nodeType)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.updatedAt !== 'string'
    || new Date(value.updatedAt).toISOString() !== value.updatedAt) {
    throw new TypeError('node type skill binding response is invalid')
  }
  return {
    schemaVersion: SKILL_ASSET_SCHEMA_VERSION,
    nodeType: value.nodeType,
    revision: value.revision as number,
    skills: canonicalSkillAssetRefs(value.skills),
    updatedAt: value.updatedAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
