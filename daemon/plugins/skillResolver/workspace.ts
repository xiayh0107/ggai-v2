import { createHash } from 'node:crypto'
import {
  GGAI_RUNTIME_API_VERSION,
  type SynchronousCapabilityPlugin,
} from '../../runtime/pluginHost.js'
import {
  SKILL_CATALOG_READER_SERVICE,
  SKILL_RESOLVER_SERVICE,
  type SkillResolution,
} from '../../skills/contracts.js'

const SKILL_RESOLUTION_DIGEST_DOMAIN = 'ggai.workspace-skill-resolution.v1'

export function createWorkspaceSkillResolverPlugin(): SynchronousCapabilityPlugin {
  return {
    manifest: {
      id: '@ggai/workspace-skill-resolver',
      version: '1.0.0',
      apiVersion: GGAI_RUNTIME_API_VERSION,
      displayName: 'Workspace Skill Resolver',
    },
    inject: [SKILL_CATALOG_READER_SERVICE],
    activate(context) {
      const catalog = context.require(SKILL_CATALOG_READER_SERVICE)
      context.provide(SKILL_RESOLVER_SERVICE, {
        async resolve(refs): Promise<SkillResolution> {
          const assets = (await catalog.resolve(refs))
            .map((asset) => structuredClone(asset))
            .sort((left, right) => left.ref.skillId.localeCompare(right.ref.skillId))
          const canonical = assets.map((asset) => ({
            ref: asset.ref,
            title: asset.title,
            description: asset.description,
            entrypoint: asset.entrypoint,
            files: [...asset.files]
              .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
              .map(({ relativePath, size, digest }) => ({ relativePath, size, digest })),
          }))
          const digest = createHash('sha256')
            .update(`${SKILL_RESOLUTION_DIGEST_DOMAIN}\0`, 'utf8')
            .update(JSON.stringify(canonical), 'utf8')
            .digest('hex')
          return Object.freeze({
            assets: Object.freeze(assets),
            digest,
          })
        },
      })
    },
  }
}
