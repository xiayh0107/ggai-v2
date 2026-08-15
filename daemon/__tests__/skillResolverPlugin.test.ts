import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { CapabilityExecutionScopes } from '../capabilityScopes.js'
import { createWorkspaceSkillResolverPlugin } from '../plugins/skillResolver/workspace.js'
import { AgentRegistry } from '../registry.js'
import {
  SKILL_CATALOG_READER_SERVICE,
  SKILL_RESOLVER_SERVICE,
  type SkillCatalogReader,
} from '../skills/contracts.js'

const REF = {
  skillId: 'example-skill',
  revision: 1,
  digest: 'a'.repeat(64),
}

test('Workspace Skill Resolver is a scoped capability with deterministic digest', async () => {
  const registry = new AgentRegistry()
  const scopes = new CapabilityExecutionScopes(registry.runtimeServices)
  const workspace = scopes.workspace(path.resolve('skill-resolver-fixtures'))
  const reader: SkillCatalogReader = {
    async resolve() {
      return [{
        ref: REF,
        title: 'Example',
        description: 'A deterministic fixture',
        entrypoint: 'SKILL.md',
        files: [{
          relativePath: 'SKILL.md',
          size: 8,
          digest: 'b'.repeat(64),
          contentBase64: 'Zml4dHVyZQ==',
        }],
      }]
    },
  }
  workspace.services.provide(
    SKILL_CATALOG_READER_SERVICE,
    reader,
    '@ggai/test-catalog',
  )
  workspace.mountSync(createWorkspaceSkillResolverPlugin())
  const resolver = workspace.services.require(SKILL_RESOLVER_SERVICE)

  const first = await resolver.resolve([REF])
  const second = await resolver.resolve([REF])
  assert.deepEqual(first, second)
  assert.match(first.digest, /^[0-9a-f]{64}$/u)
  assert.equal(first.assets[0]?.files[0]?.contentBase64, 'Zml4dHVyZQ==')

  await workspace.dispose()
  assert.throws(() => workspace.services.require(SKILL_RESOLVER_SERVICE), /disposed/u)
  await scopes.dispose()
  await registry.dispose()
})

test('Skill Resolver plugin fails before side effects when catalog authority is missing', async () => {
  const registry = new AgentRegistry()
  const scopes = new CapabilityExecutionScopes(registry.runtimeServices)
  const workspace = scopes.workspace(path.resolve('skill-resolver-missing'))
  assert.throws(
    () => workspace.mountSync(createWorkspaceSkillResolverPlugin()),
    /required service is unavailable/u,
  )
  await scopes.dispose()
  await registry.dispose()
})
