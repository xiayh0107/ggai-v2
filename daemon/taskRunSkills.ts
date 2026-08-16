import { selectDirectTaskInputEdges } from '../src/canvas/contextEdges.js'
import type { CanvasDocument, CanvasNode } from '../src/canvas/model.js'
import { effectiveNodeSkillRefs } from '../src/skills/contracts.js'
import { ProtocolError } from './protocol.js'
import type { SkillResolver } from './skills/contracts.js'
import type { SkillAssetCatalog } from './skillAssets.js'
import type { RunIntent } from './taskRunProtocol.js'
import {
  pinResolvedTaskSkills,
  type ResolvedSkillSource,
  type ResolvedTaskSkill,
  resolvedTaskSkillCapabilityDigest,
} from './taskRunTypes.js'

export interface ResolvedRunIntentSkills {
  skills: ResolvedTaskSkill[]
  digest: string
  resolverDigest: string
  resolverProvider: string
}

/**
 * Core selects participating Nodes and effective refs; the Workspace-scoped
 * resolver supplies immutable bytes. Core then revalidates and pins the
 * provider result before it can enter a Run request.
 */
export async function resolveRunIntentSkills(
  intent: RunIntent,
  document: CanvasDocument,
  bindings: Pick<SkillAssetCatalog, 'typeBindings'>,
  resolver: SkillResolver,
  resolverProvider: string,
): Promise<ResolvedRunIntentSkills> {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const participation = new Map<string, {
    node: CanvasNode
    roles: Set<ResolvedSkillSource['role']>
  }>()
  const participate = (node: CanvasNode, role: ResolvedSkillSource['role']) => {
    const existing = participation.get(node.id)
    if (existing) existing.roles.add(role)
    else participation.set(node.id, { node, roles: new Set([role]) })
  }

  for (const node of document.nodes) {
    if (node.homeTaskId === intent.taskId) participate(node, 'target')
  }
  for (const edge of selectDirectTaskInputEdges(document.edges, intent.taskId)) {
    if (edge.from.kind === 'node') participate(requireRunSkillNode(nodesById, edge.from.id), 'context')
  }
  for (const attachment of intent.attachments) {
    if (attachment.kind === 'node') {
      participate(requireRunSkillNode(nodesById, attachment.nodeId), 'attachment')
    }
  }

  const typeBindings = await bindings.typeBindings(
    [...new Set([...participation.values()].map(({ node }) => node.type))],
  )
  const requested = new Map<string, {
    ref: ReturnType<typeof effectiveNodeSkillRefs>[number]
    sources: ResolvedSkillSource[]
  }>()
  for (const { node, roles } of participation.values()) {
    const refs = effectiveNodeSkillRefs(typeBindings.get(node.type) ?? [], node.skillBindings)
    for (const ref of refs) {
      const existing = requested.get(ref.skillId)
      if (existing && (existing.ref.revision !== ref.revision
        || existing.ref.digest !== ref.digest)) {
        throw new ProtocolError(
          `participating Nodes bind conflicting revisions of skill ${ref.skillId}`,
          'skill_binding_conflict',
          409,
        )
      }
      const entry = existing ?? { ref, sources: [] }
      for (const role of roles) {
        if (!entry.sources.some((source) => source.nodeId === node.id && source.role === role)) {
          entry.sources.push({ kind: 'node', nodeId: node.id, nodeType: node.type, role })
        }
      }
      requested.set(ref.skillId, entry)
    }
  }

  const entries = [...requested.values()]
    .sort((left, right) => left.ref.skillId.localeCompare(right.ref.skillId))
    .map((entry) => ({
      ...entry,
      sources: entry.sources.sort((left, right) =>
        left.nodeId.localeCompare(right.nodeId) || left.role.localeCompare(right.role)),
    }))
  let resolution
  try {
    resolution = await resolver.resolve(entries.map((entry) => entry.ref))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Run skills are unavailable'
    throw new ProtocolError(
      message,
      message.includes('exceed') ? 'run_skills_too_large' : 'run_skill_unavailable',
      message.includes('exceed') ? 413 : 409,
    )
  }
  if (!/^[0-9a-f]{64}$/u.test(resolution.digest)) {
    throw new ProtocolError(
      'Workspace Skill Resolver returned an invalid semantic digest',
      'run_skill_unavailable',
      409,
    )
  }
  const expectedRefs = entries.map(({ ref }) => ref)
  const actualRefs = resolution.assets.map(({ ref }) => ref)
  if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
    throw new ProtocolError(
      'Workspace Skill Resolver did not return the exact requested revisions',
      'run_skill_unavailable',
      409,
    )
  }
  const sourcesById = new Map(entries.map((entry) => [entry.ref.skillId, entry.sources]))
  const proposedSkills: ResolvedTaskSkill[] = resolution.assets.map((asset) => ({
    ...structuredClone(asset),
    sources: structuredClone(sourcesById.get(asset.ref.skillId) ?? []),
  }))
  const digest = resolvedTaskSkillCapabilityDigest(proposedSkills)
  const skills = pinResolvedTaskSkills(proposedSkills, digest)
  return {
    skills,
    digest,
    resolverDigest: resolution.digest,
    resolverProvider,
  }
}

function requireRunSkillNode(nodes: Map<string, CanvasNode>, nodeId: string): CanvasNode {
  const node = nodes.get(nodeId)
  if (!node) {
    throw new ProtocolError(
      `skill authority references a missing Node: ${nodeId}`,
      'attachment_not_found',
      404,
    )
  }
  return node
}
