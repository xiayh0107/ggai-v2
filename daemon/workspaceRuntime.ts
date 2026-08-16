import type { WorkspaceCapabilityScope } from './capabilityScopes.js'
import { createWorkspaceSkillResolverPlugin } from './plugins/skillResolver/workspace.js'
import {
  ProjectionContributionRegistry,
  PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
} from './projectionContributions.js'
import {
  SKILL_CATALOG_READER_SERVICE,
  type SkillCatalogReader,
} from './skills/contracts.js'

/** Composition root for Workspace-scoped capability providers. */
export function installWorkspaceCapabilityProviders(
  workspace: WorkspaceCapabilityScope,
  input: {
    skillCatalog: SkillCatalogReader
    projectionContributions?: ProjectionContributionRegistry
  },
): void {
  workspace.services.provide(
    SKILL_CATALOG_READER_SERVICE,
    input.skillCatalog,
    '@ggai/skill-catalog-authority',
  )
  workspace.services.provide(
    PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
    input.projectionContributions ?? new ProjectionContributionRegistry(),
    '@ggai/projection-contribution-authority',
  )
  workspace.mountSync(createWorkspaceSkillResolverPlugin())
}
