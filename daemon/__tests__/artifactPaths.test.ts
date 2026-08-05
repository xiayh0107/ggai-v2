import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artifactRunRelativeDir,
  isArtifactReferenceForNode,
  isSafeArtifactReference,
} from '../artifactPaths.js'

test('artifact paths isolate every branch and run without exposing logical branch names', () => {
  const main = artifactRunRelativeDir('main', 'run-1', 'node-1')
  const feature = artifactRunRelativeDir('feature/private-name', 'run-2', 'node-1')
  const sibling = artifactRunRelativeDir('feature/private-name', 'run-3', 'node-1')

  assert.match(main, /^artifacts\/\.branches\/[0-9a-f]{64}\/run-1\/node-1$/u)
  assert.doesNotMatch(feature, /feature|private-name/u)
  assert.notEqual(main, feature)
  assert.notEqual(feature, sibling)
})

test('artifact reference validation accepts legacy and immutable paths but rejects traversal', () => {
  assert.equal(isSafeArtifactReference('artifacts/node-1/legacy.txt'), true)
  assert.equal(isSafeArtifactReference(
    `${artifactRunRelativeDir('main', 'run-1', 'node-1')}/result.txt`,
  ), true)
  assert.equal(isSafeArtifactReference('../artifacts/secret.txt'), false)
  assert.equal(isSafeArtifactReference('artifacts/node-1/../../secret.txt'), false)
  assert.equal(isSafeArtifactReference('artifacts/node-1/.ggai/run-result.json'), false)
  assert.equal(isSafeArtifactReference('/artifacts/node-1/file.txt'), false)
  assert.equal(isSafeArtifactReference('artifacts\\node-1\\file.txt'), false)
})

test('artifact references may cross immutable runs but never node ownership', () => {
  const inherited = `${artifactRunRelativeDir('feature/a', 'run-parent', 'node-1')}/result.txt`
  assert.equal(isArtifactReferenceForNode(inherited, 'node-1'), true)
  assert.equal(isArtifactReferenceForNode(inherited, 'node-2'), false)
  assert.equal(isArtifactReferenceForNode('artifacts/node-1/legacy.txt', 'node-1'), true)
  assert.equal(isArtifactReferenceForNode('artifacts/node-2/legacy.txt', 'node-1'), false)
  assert.equal(isArtifactReferenceForNode(
    'artifacts/.branches/not-a-hash/run-parent/node-1/result.txt',
    'node-1',
  ), false)
})
