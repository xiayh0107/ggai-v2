import { describe, expect, it } from 'vitest'
import { emptyCanvasDocument } from './model'
import { effectiveTaskSkillRefs } from './taskSkills'
import type { NodeTypeSkillBindings, SkillAssetRef } from '@/skills/contracts'

const typeSkill: SkillAssetRef = {
  skillId: 'figure-layout',
  revision: 2,
  digest: 'a'.repeat(64),
}
const instanceSkill: SkillAssetRef = {
  skillId: 'journal-style',
  revision: 1,
  digest: 'b'.repeat(64),
}

function typeBinding(skills: SkillAssetRef[]): NodeTypeSkillBindings {
  return {
    schemaVersion: 1,
    nodeType: 'image',
    revision: 3,
    skills,
    updatedAt: '2026-08-16T00:00:00.000Z',
  }
}

describe('effectiveTaskSkillRefs', () => {
  it('combines type defaults and instance additions for Task outputs', () => {
    const document = emptyCanvasDocument()
    document.nodes.push({
      id: 'node-1',
      type: 'image',
      frame: { x: 0, y: 0, w: 320, h: 240, z: 1 },
      title: '图像',
      artifactRefs: [],
      homeTaskId: 'task-1',
      origin: { kind: 'user' },
      skillBindings: { inheritType: true, skills: [instanceSkill] },
    })

    expect(effectiveTaskSkillRefs(document, 'task-1', [typeBinding([typeSkill])]))
      .toEqual([typeSkill, instanceSkill])
  })

  it('fails closed when multiple output Nodes bind conflicting revisions', () => {
    const document = emptyCanvasDocument()
    document.nodes.push(
      {
        id: 'node-1',
        type: 'image',
        frame: { x: 0, y: 0, w: 320, h: 240, z: 1 },
        title: '图像一',
        artifactRefs: [],
        homeTaskId: 'task-1',
        origin: { kind: 'user' },
        skillBindings: { inheritType: false, skills: [typeSkill] },
      },
      {
        id: 'node-2',
        type: 'image',
        frame: { x: 360, y: 0, w: 320, h: 240, z: 2 },
        title: '图像二',
        artifactRefs: [],
        homeTaskId: 'task-1',
        origin: { kind: 'user' },
        skillBindings: {
          inheritType: false,
          skills: [{ ...typeSkill, revision: 3, digest: 'c'.repeat(64) }],
        },
      },
    )

    expect(() => effectiveTaskSkillRefs(document, 'task-1', []))
      .toThrow('conflicting revisions')
  })
})
