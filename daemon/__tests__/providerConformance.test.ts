import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contributionProviderConformanceCase,
  providerConformanceCase,
} from './support/capabilityProviderConformance.js'
import { createCodexAgentTransportPlugin } from '../plugins/agentTransport/codex.js'
import { createProjectionContributionPlugin } from '../plugins/projectionContribution/data.js'
import { createWorkspaceSkillResolverPlugin } from '../plugins/skillResolver/workspace.js'
import {
  ProjectionContributionRegistry,
  PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
} from '../projectionContributions.js'
import {
  CapabilityPluginHost,
  GGAI_RUNTIME_API_VERSION,
  type CapabilityPlugin,
  type CapabilityPluginContext,
} from '../runtime/pluginHost.js'
import { defineService } from '../runtime/services.js'
import {
  SKILL_CATALOG_READER_SERVICE,
  SKILL_RESOLVER_SERVICE,
  type SkillCatalogReader,
} from '../skills/contracts.js'
import {
  AGENT_TRANSPORT_REGISTRY_SERVICE,
  AgentTransportRegistry,
} from '../transport/registry.js'

contributionProviderConformanceCase('agentTransport', () => {
  const host = new CapabilityPluginHost()
  const registry = new AgentTransportRegistry()
  host.services.provide(
    AGENT_TRANSPORT_REGISTRY_SERVICE,
    registry,
    '@ggai/conformance',
  )
  return {
    host,
    plugin: createCodexAgentTransportPlugin({ command: '/definitely/missing/codex' }),
    snapshot: () => registry.snapshot(),
    isEmpty: (snapshot) => snapshot.length === 0,
    assertPopulated(snapshot) {
      assert.deepEqual(snapshot.map(({ id }) => id), ['@ggai/agent-transport-codex'])
    },
  }
})

providerConformanceCase('skillResolver', () => {
  const host = new CapabilityPluginHost()
  const catalog: SkillCatalogReader = {
    async resolve() {
      return [{
        ref: {
          skillId: 'conformance-skill',
          revision: 1,
          digest: 'a'.repeat(64),
        },
        title: 'Conformance',
        description: 'Fixture',
        entrypoint: 'SKILL.md',
        files: [{
          relativePath: 'SKILL.md',
          size: 7,
          digest: 'b'.repeat(64),
          contentBase64: 'Zml4dHVyZQ==',
        }],
      }]
    },
  }
  host.services.provide(
    SKILL_CATALOG_READER_SERVICE,
    catalog,
    '@ggai/conformance',
  )
  return {
    host,
    plugin: createWorkspaceSkillResolverPlugin(),
    key: SKILL_RESOLVER_SERVICE,
    async assertService(service) {
      const resolution = await service.resolve([{
        skillId: 'conformance-skill',
        revision: 1,
        digest: 'a'.repeat(64),
      }])
      assert.match(resolution.digest, /^[0-9a-f]{64}$/u)
      assert.equal(resolution.assets.length, 1)
    },
  }
})

contributionProviderConformanceCase('projectionContribution', () => {
  const host = new CapabilityPluginHost()
  const registry = new ProjectionContributionRegistry()
  host.services.provide(
    PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
    registry,
    '@ggai/conformance',
  )
  return {
    host,
    plugin: createProjectionContributionPlugin({
      id: '@ggai/conformance-projection',
      version: '1.0.0',
      contributions: [{
        id: '@ggai/conformance-artifact',
        artifactClaims: [{
          extensions: ['.conformance'],
          mediaTypes: ['application/x-ggai-conformance'],
          priority: 1,
        }],
      }],
    }),
    snapshot: () => registry.snapshot(),
    isEmpty: (snapshot) => snapshot.contributions.length === 0,
    assertPopulated(snapshot) {
      assert.equal(snapshot.contributions.length, 1)
      assert.match(snapshot.digest, /^[0-9a-f]{64}$/u)
    },
  }
})

test('capability provider conformance: activation rollback', async () => {
  const TEST_SERVICE = defineService<object>('ggai.conformance-rollback.v1')
  const plugin: CapabilityPlugin = {
    manifest: {
      id: '@ggai/conformance-rollback',
      version: '1.0.0',
      apiVersion: GGAI_RUNTIME_API_VERSION,
    },
    activate(context: CapabilityPluginContext) {
      context.provide(TEST_SERVICE, {})
      throw new Error('intentional activation failure')
    },
  }
  const host = new CapabilityPluginHost()
  await assert.rejects(host.mount(plugin), /intentional activation failure/u)
  assert.equal(host.services.get(TEST_SERVICE), undefined)
  await host.dispose()
})
