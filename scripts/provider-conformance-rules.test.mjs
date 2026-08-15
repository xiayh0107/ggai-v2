import assert from 'node:assert/strict'
import test from 'node:test'
import { providerConformanceViolations } from './provider-conformance-rules.mjs'

test('provider conformance gate requires one case per plugin family', () => {
  const source = [
    "contributionProviderConformanceCase('agentTransport', () => ({}))",
    "providerConformanceCase('skillResolver', () => ({}))",
  ].join('\n')
  assert.deepEqual(
    providerConformanceViolations(
      ['agentTransport', 'skillResolver', 'projectionContribution'],
      source,
    ),
    [
      'daemon/plugins/projectionContribution has no provider conformance case in '
        + 'daemon/__tests__/providerConformance.test.ts',
    ],
  )
})
