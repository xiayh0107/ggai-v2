import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from '../../src/canvas/model.js'
import { ProtocolError } from '../protocol.js'
import type { SkillResolver } from '../skills/contracts.js'
import type { RunIntent } from '../taskRunProtocol.js'
import { resolveRunIntentSkills } from '../taskRunSkills.js'

const INTENT: RunIntent = {
  schemaVersion: 2,
  runId: 'run-skill-resolution',
  taskId: 'task-skill-resolution',
  agentId: 'codex',
  canvasBranch: 'main',
  baseRevision: 1,
  prompt: 'Resolve skills',
  attachments: [],
  materializationPolicy: 'auto',
}

test('Run skill resolution uses the Workspace resolver and snapshots its semantic identity', async () => {
  const document = canvas([])
  const bindings = { typeBindings: async () => new Map() }
  const resolver = (digest: string): SkillResolver => ({
    async resolve(refs) {
      assert.deepEqual(refs, [])
      return { assets: [], digest }
    },
  })

  const first = await resolveRunIntentSkills(
    INTENT,
    document,
    bindings,
    resolver('a'.repeat(64)),
    '@ggai/resolver-v1',
  )
  const second = await resolveRunIntentSkills(
    INTENT,
    document,
    bindings,
    resolver('b'.repeat(64)),
    '@ggai/resolver-v2',
  )
  assert.equal(first.resolverDigest, 'a'.repeat(64))
  assert.equal(first.resolverProvider, '@ggai/resolver-v1')
  assert.equal(second.resolverDigest, 'b'.repeat(64))
  assert.equal(second.resolverProvider, '@ggai/resolver-v2')
  assert.deepEqual(first.skills, [])
})

test('conflicting participating Skill revisions fail before the resolver is queried', async () => {
  const skillId = '@workspace/conflicting'
  const document = canvas([
    {
      id: 'node-a',
      typeRef: { id: 'text', revision: 1, digest: '0'.repeat(64) },
      parentId: null,
      orderKey: '000000000001',
      bounds: { w: 320, h: 180 },
      transform: { matrix: [1, 0, 0, 1, 0, 0] },
      title: 'A',
      artifactRefs: [],
      homeTaskId: INTENT.taskId,
      origin: { kind: 'user' },
      skillBindings: {
        inheritType: false,
        skills: [{ skillId, revision: 1, digest: 'a'.repeat(64) }],
      },
    },
    {
      id: 'node-b',
      typeRef: { id: 'text', revision: 1, digest: '0'.repeat(64) },
      parentId: null,
      orderKey: '000000000002',
      bounds: { w: 320, h: 180 },
      transform: { matrix: [1, 0, 0, 1, 400, 0] },
      title: 'B',
      artifactRefs: [],
      homeTaskId: INTENT.taskId,
      origin: { kind: 'user' },
      skillBindings: {
        inheritType: false,
        skills: [{ skillId, revision: 2, digest: 'b'.repeat(64) }],
      },
    },
  ])
  let resolverCalls = 0
  await assert.rejects(
    resolveRunIntentSkills(
      INTENT,
      document,
      { typeBindings: async () => new Map() },
      {
        async resolve() {
          resolverCalls += 1
          return { assets: [], digest: 'c'.repeat(64) }
        },
      },
      '@ggai/test-resolver',
    ),
    (error: unknown) => error instanceof ProtocolError
      && error.code === 'skill_binding_conflict',
  )
  assert.equal(resolverCalls, 0)
})

function canvas(nodes: CanvasDocument['nodes']): CanvasDocument {
  return {
    schemaVersion: 3,
    tasks: [{
      id: INTENT.taskId,
      title: 'Skill task',
      goal: 'Resolve skills',
      anchor: { x: 0, y: 0 },
      origin: { kind: 'user' },
    }],
    nodes,
    collections: [],
    edges: [],
    receipts: [],
    everCreated: true,
  }
}
