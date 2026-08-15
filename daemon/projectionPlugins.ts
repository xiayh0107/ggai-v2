import {
  BUILTIN_ARTIFACT_CLAIM_REGISTRY,
  inspectArtifactClaimRegistry,
} from '../src/plugins/artifactContracts.js'
import type { ProjectionPluginContract } from './projectionPlan.js'

/**
 * Daemon projection contracts are derived from the shared, data-only artifact
 * registry. Browser renderers and executable projection hooks never cross this
 * boundary.
 */
function builtInProjectionPluginContracts(): ProjectionPluginContract[] {
  const inspection = inspectArtifactClaimRegistry(
    structuredClone(BUILTIN_ARTIFACT_CLAIM_REGISTRY),
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

export const BUILTIN_PROJECTION_PLUGIN_CONTRACTS = builtInProjectionPluginContracts()
