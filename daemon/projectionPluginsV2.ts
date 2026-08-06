import {
  BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2,
  inspectArtifactClaimRegistryV2,
} from '../src/plugins/artifactContracts.js'
import type { ProjectionPluginContractV2 } from './projectionPlanV2.js'

/**
 * Daemon projection contracts are derived from the shared, data-only artifact
 * registry. Browser renderers and executable projection hooks never cross this
 * boundary.
 */
function builtInProjectionPluginContractsV2(): ProjectionPluginContractV2[] {
  const inspection = inspectArtifactClaimRegistryV2(
    structuredClone(BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2),
  )
  if (inspection.status !== 'valid') {
    throw new TypeError(`built-in artifact claims are invalid: ${inspection.reason}`)
  }
  return inspection.registrations.map((registration) => ({
    id: registration.id,
    artifactRules: registration.artifactClaims,
    ...(registration.acceptsUnknown ? { acceptsUnknown: true } : {}),
  }))
}

export const BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2 = builtInProjectionPluginContractsV2()
