import type {
  NodeTypeSkillBindings,
  SkillAssetRef,
  SkillAssetSummary,
} from '../../src/skills/contracts.js'
import {
  SkillAssetCatalog,
  type ImportSkillAssetInput,
  type ResolvedSkillAsset,
  type SkillAssetCatalogSnapshot,
  type UpdateNodeTypeSkillBindingsInput,
} from '../skillAssets.js'
import type { SkillResolver } from './contracts.js'

/**
 * Compatibility facade for the legacy HTTP/Run adapter. Core-owned mutation
 * methods remain delegated to the authoritative catalog; only immutable Run
 * resolution crosses the Workspace SkillResolver capability seam.
 */
export class CapabilitySkillAssetCatalog extends SkillAssetCatalog {
  readonly #authority: SkillAssetCatalog
  readonly #resolver: SkillResolver

  constructor(authority: SkillAssetCatalog, resolver: SkillResolver) {
    super(authority.projectRoot)
    this.#authority = authority
    this.#resolver = resolver
  }

  override list(): Promise<SkillAssetCatalogSnapshot> {
    return this.#authority.list()
  }

  override import(input: ImportSkillAssetInput): Promise<SkillAssetSummary> {
    return this.#authority.import(input)
  }

  override archive(skillId: string): Promise<boolean> {
    return this.#authority.archive(skillId)
  }

  override updateTypeBindings(
    input: UpdateNodeTypeSkillBindingsInput,
  ): Promise<NodeTypeSkillBindings> {
    return this.#authority.updateTypeBindings(input)
  }

  override typeBindings(
    nodeTypes: readonly string[],
  ): Promise<Map<string, SkillAssetRef[]>> {
    return this.#authority.typeBindings(nodeTypes)
  }

  override async resolve(refs: readonly SkillAssetRef[]): Promise<ResolvedSkillAsset[]> {
    const resolution = await this.#resolver.resolve(refs)
    return resolution.assets.map((asset) => structuredClone(asset))
  }
}
