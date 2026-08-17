import assert from 'node:assert/strict'
import test from 'node:test'
import { createBlankCustomNodeManifest } from '../../src/node-studio/model.js'
import { snapshotCustomNodeType } from '../nodeTypeSnapshots.js'

test('custom node type snapshots are immutable, typed, and content-addressed', () => {
  const manifest = {
    ...createBlankCustomNodeManifest(new Date('2026-08-17T00:00:00.000Z')),
    id: '@local/analysis',
    revision: 4,
    installed: true,
    ports: [{
      key: 'data',
      direction: 'input' as const,
      schema: 'ggai://value/json',
      cardinality: 'one' as const,
    }],
  }
  const first = snapshotCustomNodeType(manifest)
  const second = snapshotCustomNodeType(structuredClone(manifest))

  assert.equal(first.id, '@local/analysis@4')
  assert.equal(first.revision, 4)
  assert.match(first.digest, /^[0-9a-f]{64}$/u)
  assert.deepEqual(first, second)
  assert.notEqual(snapshotCustomNodeType({ ...manifest, label: 'Changed' }).digest, first.digest)
  assert.equal('command' in first, false)
  assert.equal('path' in first, false)
})
