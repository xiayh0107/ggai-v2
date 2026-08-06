import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2,
  MAX_ARTIFACT_CLAIM_MATCHERS_PER_RULE_V2,
  MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN_V2,
  artifactClaimsForBuiltinV2,
  inspectArtifactClaimRegistryV2,
} from './artifactContracts'

describe('V2 artifact claim registry', () => {
  it('keeps built-in claims serializable and gives R source to code', () => {
    expect(structuredClone(BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2)).toEqual(
      BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2,
    )
    expect(BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2.map(({ id }) => id)).toEqual([
      'code',
      'image',
      'pdf',
      'table',
      'text',
      'file',
    ])
    expect(artifactClaimsForBuiltinV2('code').some((claim) =>
      claim.extensions?.includes('.r'))).toBe(true)
    expect(BUILTIN_ARTIFACT_CLAIM_REGISTRY_V2.find(({ id }) => id === 'file')).toMatchObject({
      artifactClaims: [],
      acceptsUnknown: true,
    })
  })

  it('canonicalizes zero priority without mutating the caller', () => {
    const source = [{
      id: 'image',
      artifactClaims: [{ extensions: ['.png'], priority: 0 }],
      acceptsUnknown: false,
    }]
    const inspection = inspectArtifactClaimRegistryV2(source)
    expect(inspection).toEqual({
      status: 'valid',
      registrations: [{ id: 'image', artifactClaims: [{ extensions: ['.png'] }] }],
    })
    expect(source[0]?.artifactClaims[0]?.priority).toBe(0)
  })

  it('rejects duplicate ids and malformed or excessive claims', () => {
    const valid = { id: 'image', artifactClaims: [{ extensions: ['.png'] }] }
    expect(inspectArtifactClaimRegistryV2([valid, valid]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistryV2([{
      id: 'image',
      artifactClaims: [{ extensions: ['.PNG'] }],
    }]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistryV2([{
      id: 'image',
      artifactClaims: [{ extensions: ['.png'], priority: 1_001 }],
    }]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistryV2([{
      id: 'image',
      artifactClaims: Array.from(
        { length: MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN_V2 + 1 },
        () => ({ extensions: ['.png'] }),
      ),
    }]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistryV2([{
      id: 'image',
      artifactClaims: [{
        extensions: Array.from(
          { length: MAX_ARTIFACT_CLAIM_MATCHERS_PER_RULE_V2 + 1 },
          (_, index) => `.x${index}`,
        ),
      }],
    }]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistryV2([{
      ...valid,
      projectArtifact: () => null,
    }]).status).toBe('invalid')
  })
})
