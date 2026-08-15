export const SKILL_ASSET_SCHEMA_VERSION = 1 as const
export const MAX_NODE_SKILL_BINDINGS = 32

const SKILL_ID_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u

/** Immutable identity stored by Node types, Canvas Nodes, and accepted Runs. */
export interface SkillAssetRef {
  skillId: string
  revision: number
  digest: string
}

/**
 * Per-Node override. Missing means inherit type bindings with no additions.
 * `inheritType: false` replaces the type defaults with this exact list.
 */
export interface NodeSkillBindings {
  inheritType: boolean
  skills: SkillAssetRef[]
}

export interface SkillAssetSummary extends SkillAssetRef {
  schemaVersion: typeof SKILL_ASSET_SCHEMA_VERSION
  title: string
  description: string
  entrypoint: 'SKILL.md'
  fileCount: number
  totalBytes: number
  importedAt: string
  archived: boolean
}

export interface NodeTypeSkillBindings {
  schemaVersion: typeof SKILL_ASSET_SCHEMA_VERSION
  nodeType: string
  revision: number
  skills: SkillAssetRef[]
  updatedAt: string
}

export function canonicalSkillAssetRef(value: unknown, label = 'skill'): SkillAssetRef {
  if (!isExactRecord(value, ['skillId', 'revision', 'digest'])) {
    throw new TypeError(`${label} must contain exactly skillId, revision, and digest`)
  }
  if (!isSkillId(value.skillId)) throw new TypeError(`${label}.skillId is invalid`)
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new TypeError(`${label}.revision must be a positive safe integer`)
  }
  if (typeof value.digest !== 'string' || !DIGEST_PATTERN.test(value.digest)) {
    throw new TypeError(`${label}.digest is invalid`)
  }
  return {
    skillId: value.skillId,
    revision: value.revision as number,
    digest: value.digest,
  }
}

export function canonicalSkillAssetRefs(
  value: unknown,
  label = 'skills',
): SkillAssetRef[] {
  if (!Array.isArray(value) || value.length > MAX_NODE_SKILL_BINDINGS) {
    throw new TypeError(`${label} must be a bounded array`)
  }
  const refs = value.map((entry, index) =>
    canonicalSkillAssetRef(entry, `${label}[${index}]`))
  const ids = refs.map((entry) => entry.skillId)
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${label} cannot bind multiple revisions of the same skill`)
  }
  return refs.sort((left, right) =>
    left.skillId.localeCompare(right.skillId)
      || left.revision - right.revision
      || left.digest.localeCompare(right.digest))
}

export function canonicalNodeSkillBindings(
  value: unknown,
  label = 'skillBindings',
): NodeSkillBindings {
  if (!isExactRecord(value, ['inheritType', 'skills'])
    || typeof value.inheritType !== 'boolean') {
    throw new TypeError(`${label} must contain exactly inheritType and skills`)
  }
  return {
    inheritType: value.inheritType,
    skills: canonicalSkillAssetRefs(value.skills, `${label}.skills`),
  }
}

export function effectiveNodeSkillRefs(
  typeSkills: readonly SkillAssetRef[],
  instanceBindings: NodeSkillBindings | undefined,
): SkillAssetRef[] {
  const selected = instanceBindings?.inheritType === false
    ? [...instanceBindings.skills]
    : [...typeSkills, ...(instanceBindings?.skills ?? [])]
  const byId = new Map<string, SkillAssetRef>()
  for (const ref of selected) {
    const canonical = canonicalSkillAssetRef(ref)
    const existing = byId.get(canonical.skillId)
    if (existing && (existing.revision !== canonical.revision
      || existing.digest !== canonical.digest)) {
      throw new TypeError(`skill ${canonical.skillId} is bound to conflicting revisions`)
    }
    byId.set(canonical.skillId, canonical)
  }
  return [...byId.values()].sort((left, right) => left.skillId.localeCompare(right.skillId))
}

export function isSkillId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 160
    && SKILL_ID_PATTERN.test(value)
    && !value.includes('..')
    && !value.includes('//')
    && !value.endsWith('/')
}

export function isNodeTypeId(value: unknown): value is string {
  return isSkillId(value)
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
