export const PROVIDER_CONFORMANCE_GATE_COUNT = 1

export function providerConformanceViolations(pluginFamilies, testSource) {
  const violations = []
  for (const family of [...pluginFamilies].sort((left, right) => left.localeCompare(right))) {
    const markers = [
      `providerConformanceCase('${family}'`,
      `providerConformanceCase("${family}"`,
      `contributionProviderConformanceCase('${family}'`,
      `contributionProviderConformanceCase("${family}"`,
    ]
    if (!markers.some((marker) => testSource.includes(marker))) {
      violations.push(
        `daemon/plugins/${family} has no provider conformance case in daemon/__tests__/providerConformance.test.ts`,
      )
    }
  }
  return violations
}
