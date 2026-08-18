import assert from 'node:assert/strict'
import test from 'node:test'
import { isSafeArtifactReference } from '../artifactPaths.js'

test('artifact references accept only normalized current managed paths', () => {
  assert.equal(isSafeArtifactReference(
    `artifacts/.branches/${'a'.repeat(64)}/run-1/files/result.txt`,
  ), true)
  assert.equal(isSafeArtifactReference('../artifacts/secret.txt'), false)
  assert.equal(isSafeArtifactReference('artifacts/run/../../secret.txt'), false)
  assert.equal(isSafeArtifactReference('artifacts/run/.ggai/run-result.json'), false)
  assert.equal(isSafeArtifactReference('/artifacts/run/file.txt'), false)
  assert.equal(isSafeArtifactReference('artifacts\\run\\file.txt'), false)
})
