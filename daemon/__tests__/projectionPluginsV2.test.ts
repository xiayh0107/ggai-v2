import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2 } from '../../src/plugins/artifactContracts.js'
import { BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2 } from '../projectionPluginsV2.js'

test('daemon built-ins are projected from the shared artifact claim registry', () => {
  assert.deepEqual(
    BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2,
    BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2.map((registration) => ({
      id: registration.id,
      artifactRules: registration.artifactClaims,
      ...(registration.acceptsUnknown ? { acceptsUnknown: true } : {}),
    })),
  )
})

test('daemon build artifact graph does not import browser renderer dependencies', async () => {
  const daemonModule = await readFile(new URL('../projectionPluginsV2.js', import.meta.url), 'utf8')
  const sharedModule = await readFile(
    new URL('../../src/plugins/artifactContracts.js', import.meta.url),
    'utf8',
  )
  const emittedGraph = `${daemonModule}\n${sharedModule}`

  assert.match(daemonModule, /src\/plugins\/artifactContracts\.js/u)
  assert.doesNotMatch(emittedGraph, /\bfrom\s+['"](?:react|lucide-react)['"]/u)
  assert.doesNotMatch(emittedGraph, /src\/plugins\/(?:types|builtins)(?:\.js|\/)/u)
  assert.doesNotMatch(emittedGraph, /\bfrom\s+['"][^'"]+\.tsx['"]/u)
})
