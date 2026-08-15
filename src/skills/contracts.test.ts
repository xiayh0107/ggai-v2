import { describe, expect, it } from 'vitest'
import {
  canonicalNodeSkillBindings,
  canonicalSkillAssetRefs,
  effectiveNodeSkillRefs,
  type SkillAssetRef,
} from './contracts'

const skill = (skillId: string, revision = 1, digest = 'a'.repeat(64)): SkillAssetRef => ({
  skillId,
  revision,
  digest,
})

describe('Node skill contracts', () => {
  it('canonicalizes bindings and inherits type capabilities by default', () => {
    const typeSkill = skill('@workspace/research')
    const nodeSkill = skill('@workspace/image-style', 2, 'b'.repeat(64))

    expect(canonicalNodeSkillBindings({
      inheritType: true,
      skills: [nodeSkill],
    })).toEqual({ inheritType: true, skills: [nodeSkill] })
    expect(effectiveNodeSkillRefs([typeSkill], {
      inheritType: true,
      skills: [nodeSkill],
    })).toEqual([nodeSkill, typeSkill])
  })

  it('supports instance replacement without silently accepting revision conflicts', () => {
    const replacement = skill('@workspace/research', 2, 'b'.repeat(64))
    expect(effectiveNodeSkillRefs([skill('@workspace/research')], {
      inheritType: false,
      skills: [replacement],
    })).toEqual([replacement])

    expect(() => effectiveNodeSkillRefs([skill('@workspace/research')], {
      inheritType: true,
      skills: [replacement],
    })).toThrow(/conflicting revisions/u)
    expect(() => canonicalSkillAssetRefs([
      skill('@workspace/research'),
      replacement,
    ])).toThrow(/multiple revisions/u)
  })

  it('rejects extra fields and path-like ids that could escape a catalog namespace', () => {
    expect(() => canonicalNodeSkillBindings({
      inheritType: true,
      skills: [],
      sourcePath: '/tmp/private',
    })).toThrow(/exactly/u)
    expect(() => canonicalSkillAssetRefs([{ ...skill('../private'), skillId: '../private' }]))
      .toThrow(/skillId/u)
  })
})
