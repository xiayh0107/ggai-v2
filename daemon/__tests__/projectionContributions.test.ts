import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { CapabilityExecutionScopes } from '../capabilityScopes.js'
import { createProjectionContributionPlugin } from '../plugins/projectionContribution/data.js'
import {
  inspectProjectionContributionSnapshot,
  ProjectionContributionRegistry,
  PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
} from '../projectionContributions.js'
import { AgentRegistry } from '../registry.js'

const REPORT_RULE = {
  extensions: ['.report'],
  mediaTypes: ['text/plain'],
  priority: 10,
}
const REPORT_CONTRIBUTION = {
  id: '@fixture/report',
  artifactClaims: [REPORT_RULE],
}

test('projection contributions are scoped, deterministic data-only snapshots', async () => {
  const registry = new AgentRegistry()
  const scopes = new CapabilityExecutionScopes(registry.runtimeServices)
  const workspace = scopes.workspace(path.resolve('projection-contribution-fixtures'))
  const contributions = new ProjectionContributionRegistry()
  workspace.services.provide(
    PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
    contributions,
    '@ggai/test-projection-authority',
  )
  const unmount = workspace.mountSync(createProjectionContributionPlugin({
    id: '@fixture/report-provider',
    version: '1.0.0',
    contributions: [REPORT_CONTRIBUTION],
  }))

  const first = contributions.snapshot()
  const second = contributions.snapshot()
  assert.deepEqual(first, second)
  assert.equal(first.contributions[0]?.providerId, '@fixture/report-provider')
  assert.equal(first.contributions[0]?.providerVersion, '1.0.0')
  assert.equal(inspectProjectionContributionSnapshot(first).status, 'valid')

  await unmount()
  assert.deepEqual(contributions.snapshot().contributions, [])
  assert.equal(inspectProjectionContributionSnapshot(first).status, 'valid')
  await scopes.dispose()
  await registry.dispose()
})

test('projection contributions cannot replace builtin or unknown fallback authority', () => {
  const registry = new ProjectionContributionRegistry()
  assert.throws(() => registry.register('@fixture/builtin', '1.0.0', [{
    id: 'image',
    artifactClaims: [REPORT_RULE],
  }]), /cannot replace builtin/u)
  assert.throws(() => registry.register('@fixture/unknown', '1.0.0', [{
    id: '@fixture/unknown',
    artifactClaims: [REPORT_RULE],
    acceptsUnknown: true,
  }]), /cannot accept unknown/u)
})

test('projection contribution ids have a single provider owner', () => {
  const registry = new ProjectionContributionRegistry()
  registry.register('@fixture/first', '1.0.0', [REPORT_CONTRIBUTION])
  assert.throws(
    () => registry.register('@fixture/second', '1.0.0', [REPORT_CONTRIBUTION]),
    /already owned/u,
  )
})
