import type { SkillAssetRef } from '../../src/skills/contracts.js'
import type { ResolvedSkillAsset } from '../skillAssets.js'
import { defineService } from '../runtime/services.js'

/** Read-only Core authority exposed to a Workspace-scoped resolver plugin. */
export interface SkillCatalogReader {
  resolve(refs: readonly SkillAssetRef[]): Promise<ResolvedSkillAsset[]>
}

export interface ResolvedSkillCapability {
  readonly assets: readonly ResolvedSkillAsset[]
  readonly digest: string
}

/** Compatibility name for providers compiled against the first capability slice. */
export type SkillResolution = ResolvedSkillCapability

export interface SkillResolver {
  resolve(refs: readonly SkillAssetRef[]): Promise<ResolvedSkillCapability>
}

export const SKILL_CATALOG_READER_SERVICE =
  defineService<SkillCatalogReader>('ggai.skill-catalog-reader.v1')
export const SKILL_RESOLVER_SERVICE =
  defineService<SkillResolver>('ggai.skill-resolver.v1')
