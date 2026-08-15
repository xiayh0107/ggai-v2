import assert from 'node:assert/strict'
import test from 'node:test'
import { CapabilitySkillAssetCatalog } from '../skills/capabilityCatalog.js'
import type { SkillResolver } from '../skills/contracts.js'
import type {
  ResolvedSkillAsset,
  SkillAssetCatalog,
  SkillAssetCatalogSnapshot,
} from '../skillAssets.js'

const digest = 'a'.repeat(64)
const asset: ResolvedSkillAsset = {
  ref: { skillId: 'diagram', revision: 1, digest },
  title: 'Diagram skill',
  description: 'Build diagrams',
  entrypoint: 'SKILL.md',
  files: [{
    relativePath: 'SKILL.md',
    size: 0,
    digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    contentBase64: '',
  }],
}

const snapshot: SkillAssetCatalogSnapshot = {
  schemaVersion: 1,
  assets: [],
  typeBindings: [],
}

test('CapabilitySkillAssetCatalog keeps Core writes and routes immutable resolution through resolver', async () => {
  let resolverCalls = 0
  let listCalls = 0
  let archiveCalls = 0
  const authority = {
    projectRoot: process.cwd(),
    async list() {
      listCalls += 1
      return snapshot
    },
    async import() {
      throw new Error('not used')
    },
    async archive(skillId: string) {
      archiveCalls += 1
      return skillId === 'diagram'
    },
    async updateTypeBindings() {
      throw new Error('not used')
    },
    async typeBindings() {
      return new Map()
    },
    async resolve() {
      throw new Error('Core resolve must not be called by the Run facade')
    },
  } as unknown as SkillAssetCatalog
  const resolver: SkillResolver = {
    async resolve(refs) {
      resolverCalls += 1
      assert.deepEqual(refs, [asset.ref])
      return { assets: [asset], digest }
    },
  }
  const catalog = new CapabilitySkillAssetCatalog(authority, resolver)

  assert.equal(await catalog.archive('diagram'), true)
  assert.equal(archiveCalls, 1)
  assert.deepEqual(await catalog.list(), snapshot)
  assert.equal(listCalls, 1)

  const resolved = await catalog.resolve([asset.ref])
  assert.equal(resolverCalls, 1)
  assert.deepEqual(resolved, [asset])
  resolved[0]!.title = 'mutated caller copy'
  assert.equal(asset.title, 'Diagram skill')
})
