import {
  PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
  type ProjectionContribution,
} from '../../projectionContributions.js'
import {
  GGAI_RUNTIME_API_VERSION,
  type SynchronousCapabilityPlugin,
} from '../../runtime/pluginHost.js'

export function createProjectionContributionPlugin(options: {
  id: string
  version: string
  displayName?: string
  contributions: readonly ProjectionContribution[]
}): SynchronousCapabilityPlugin {
  return {
    manifest: {
      id: options.id,
      version: options.version,
      apiVersion: GGAI_RUNTIME_API_VERSION,
      ...(options.displayName ? { displayName: options.displayName } : {}),
    },
    inject: [PROJECTION_CONTRIBUTION_REGISTRY_SERVICE],
    activate(context) {
      return context.require(PROJECTION_CONTRIBUTION_REGISTRY_SERVICE)
        .register(context.pluginId, options.version, options.contributions)
    },
  }
}
