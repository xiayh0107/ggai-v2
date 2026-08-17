import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
  BUILTIN_ARTIFACT_CLAIM_REGISTRY,
  MAX_ARTIFACT_CLAIM_MATCHERS_PER_RULE,
  MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN,
  artifactClaimsForBuiltin,
  inspectArtifactCapabilitySnapshotRequest,
  inspectArtifactClaimRegistry,
} from './artifactContracts'

describe('manifest-backed artifact claim registry', () => {
  it('keeps built-in claims serializable and gives R source to code', () => {
    expect(structuredClone(BUILTIN_ARTIFACT_CLAIM_REGISTRY)).toEqual(
      BUILTIN_ARTIFACT_CLAIM_REGISTRY,
    )
    expect(BUILTIN_ARTIFACT_CLAIM_REGISTRY.map(({ id }) => id)).toEqual([
      'code',
      'image',
      'pdf-document',
      'table',
      'text',
      'file',
    ])
    expect(artifactClaimsForBuiltin('code').some((claim) =>
      claim.extensions?.includes('.r'))).toBe(true)
    expect(BUILTIN_ARTIFACT_CLAIM_REGISTRY.find(({ id }) => id === 'file')).toMatchObject({
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
    const inspection = inspectArtifactClaimRegistry(source)
    expect(inspection).toEqual({
      status: 'valid',
      registrations: [{ id: 'image', artifactClaims: [{ extensions: ['.png'] }] }],
    })
    expect(source[0]?.artifactClaims[0]?.priority).toBe(0)
  })

  it('rejects duplicate ids and malformed or excessive claims', () => {
    const valid = { id: 'image', artifactClaims: [{ extensions: ['.png'] }] }
    expect(inspectArtifactClaimRegistry([valid, valid]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistry([{
      id: 'image',
      artifactClaims: [{ extensions: ['.PNG'] }],
    }]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistry([{
      id: 'image',
      artifactClaims: [{ extensions: ['.png'], priority: 1_001 }],
    }]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistry([{
      id: 'image',
      artifactClaims: Array.from(
        { length: MAX_ARTIFACT_CLAIM_RULES_PER_PLUGIN + 1 },
        () => ({ extensions: ['.png'] }),
      ),
    }]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistry([{
      id: 'image',
      artifactClaims: [{
        extensions: Array.from(
          { length: MAX_ARTIFACT_CLAIM_MATCHERS_PER_RULE + 1 },
          (_, index) => `.x${index}`,
        ),
      }],
    }]).status).toBe('invalid')
    expect(inspectArtifactClaimRegistry([{
      ...valid,
      projectArtifact: () => null,
    }]).status).toBe('invalid')
  })

  it('strictly canonicalizes the serializable capability envelope', () => {
    expect(inspectArtifactCapabilitySnapshotRequest({
      schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      plugins: [{
        id: '@community/data-view',
        artifactClaims: [{
          mediaTypes: ['application/x-zeta', 'application/x-alpha'],
          extensions: ['.zeta', '.alpha'],
        }],
        nodeContext: {
          schemaVersion: 1,
          summary: { textMaxChars: 200, payloadFields: ['zeta', 'alpha'] },
          full: { textMaxChars: 2_000, payloadFields: ['zeta'], artifactRefs: 'none' },
        },
      }],
    })).toEqual({
      status: 'valid',
      snapshot: {
        schemaVersion: 2,
        plugins: [{
          id: '@community/data-view',
          artifactClaims: [{
            extensions: ['.alpha', '.zeta'],
            mediaTypes: ['application/x-alpha', 'application/x-zeta'],
          }],
          nodeContext: {
            schemaVersion: 1,
            summary: { textMaxChars: 200, payloadFields: ['alpha', 'zeta'] },
            full: { textMaxChars: 2_000, payloadFields: ['zeta'], artifactRefs: 'none' },
          },
        }],
      },
    })
    expect(inspectArtifactCapabilitySnapshotRequest({
      schemaVersion: 2,
      plugins: [],
      projectArtifact: () => null,
    }).status).toBe('invalid')
    expect(inspectArtifactCapabilitySnapshotRequest({
      schemaVersion: 1,
      plugins: [],
    }).status).toBe('invalid')
  })
})
