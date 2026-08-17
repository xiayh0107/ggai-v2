import type { CanvasDocument } from './model'
import {
  effectiveNodeSkillRefs,
  type NodeTypeSkillBindings,
  type SkillAssetRef,
} from '@/skills/contracts'

/**
 * Resolves the effective Skill set for Task-owned output Nodes with the same
 * inheritance and conflict semantics used by the daemon.
 */
export function effectiveTaskSkillRefs(
  document: CanvasDocument,
  taskId: string,
  typeBindings: readonly NodeTypeSkillBindings[],
): SkillAssetRef[] {
  const defaultsByType = new Map(typeBindings.map((binding) => [
    binding.nodeType,
    binding.skills,
  ] as const))
  const bySkillId = new Map<string, SkillAssetRef>()

  for (const node of document.nodes.filter((candidate) => candidate.homeTaskId === taskId)) {
    const refs = effectiveNodeSkillRefs(
      defaultsByType.get(node.typeRef.id) ?? [],
      node.skillBindings,
    )
    for (const ref of refs) {
      const existing = bySkillId.get(ref.skillId)
      if (existing && (existing.revision !== ref.revision || existing.digest !== ref.digest)) {
        throw new TypeError(`Task output Nodes bind conflicting revisions of ${ref.skillId}`)
      }
      bySkillId.set(ref.skillId, ref)
    }
  }

  return [...bySkillId.values()].sort((left, right) =>
    left.skillId.localeCompare(right.skillId))
}
