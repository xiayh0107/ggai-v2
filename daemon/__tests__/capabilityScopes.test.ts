import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  CapabilityExecutionScopes,
  RUN_CAPABILITY_IDENTITY_SERVICE,
  WORKSPACE_CAPABILITY_IDENTITY_SERVICE,
} from '../capabilityScopes.js'
import { AgentRegistry } from '../registry.js'
import { AGENT_TRANSPORT_REGISTRY_SERVICE } from '../transport/registry.js'

test('execution scopes inherit runtime capabilities and add bounded identities', async () => {
  const projectDir = path.resolve('scope-fixtures/workspace')
  const registry = new AgentRegistry({ codexCommand: '/definitely/missing/codex' })
  const scopes = new CapabilityExecutionScopes(registry.runtimeServices)
  const workspace = scopes.workspace(projectDir)
  const run = workspace.run('run-scope-1')

  assert.equal(
    run.services.require(AGENT_TRANSPORT_REGISTRY_SERVICE),
    registry,
  )
  assert.deepEqual(
    run.services.require(WORKSPACE_CAPABILITY_IDENTITY_SERVICE),
    { projectDir },
  )
  assert.deepEqual(
    run.services.require(RUN_CAPABILITY_IDENTITY_SERVICE),
    { projectDir, runId: 'run-scope-1' },
  )
  assert.deepEqual(scopes.snapshot().workspaces[0]?.runs.map(({ runId }) => runId), [
    'run-scope-1',
  ])

  await run.dispose()
  assert.throws(() => run.services.require(AGENT_TRANSPORT_REGISTRY_SERVICE), /disposed/u)
  assert.deepEqual(workspace.snapshot().runs, [])
  await scopes.dispose()
  await registry.dispose()
})

test('workspace disposal drains active Run scopes before revoking the workspace', async () => {
  const registry = new AgentRegistry()
  const scopes = new CapabilityExecutionScopes(registry.runtimeServices)
  const workspace = scopes.workspace(path.resolve('scope-fixtures/drain'))
  const first = workspace.run('first')
  const second = workspace.run('second')

  await workspace.dispose()
  assert.throws(() => first.snapshot(), /disposed/u)
  assert.throws(() => second.snapshot(), /disposed/u)
  assert.deepEqual(scopes.snapshot().workspaces, [])
  await scopes.dispose()
  await registry.dispose()
})
