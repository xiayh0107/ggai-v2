import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SkillAssetCatalog, SkillAssetConflictError } from '../skillAssets.js'

async function writeSkill(root: string, body: string): Promise<string> {
  const directory = path.join(root, 'external-skill')
  await mkdir(path.join(directory, 'references'), { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), body, 'utf8')
  await writeFile(path.join(directory, 'references', 'guide.md'), '# Guide\n\nBe precise.\n', 'utf8')
  return directory
}

test('imports immutable skills, binds Node types, and resolves archived revisions', async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-project-'))
  const external = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-source-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  t.after(() => rm(external, { recursive: true, force: true }))
  const sourcePath = await writeSkill(external, [
    '---',
    'name: Image direction',
    'description: Direct image composition for this Node.',
    '---',
    '# Image direction',
    '',
    'Read references/guide.md before composing.',
    '',
  ].join('\n'))
  const firstSkillMarkdown = await readFile(path.join(sourcePath, 'SKILL.md'))
  const catalog = new SkillAssetCatalog(project)

  const first = await catalog.import({
    sourcePath,
    skillId: '@workspace/image-direction',
    expectedRevision: 0,
  })
  assert.equal(first.revision, 1)
  assert.equal(first.title, 'Image direction')
  assert.equal(first.fileCount, 2)
  await assert.rejects(() => lstat(sourcePath), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT')
  const firstRef = {
    skillId: first.skillId,
    revision: first.revision,
    digest: first.digest,
  }
  const binding = await catalog.updateTypeBindings({
    nodeType: 'image',
    expectedRevision: 0,
    skills: [firstRef],
  })
  assert.deepEqual(binding.skills, [{
    skillId: first.skillId,
    revision: first.revision,
    digest: first.digest,
  }])
  await assert.rejects(() => catalog.updateTypeBindings({
    nodeType: 'image',
    expectedRevision: 0,
    skills: [firstRef],
  }), (error: unknown) => error instanceof SkillAssetConflictError)

  assert.equal(await catalog.archive(first.skillId), true)
  const snapshot = await catalog.list()
  assert.equal(snapshot.assets[0]?.archived, true)
  assert.equal(snapshot.typeBindings[0]?.nodeType, 'image')
  const [resolved] = await catalog.resolve([firstRef])
  assert.equal(resolved?.files.find((file) => file.relativePath === 'SKILL.md')?.contentBase64,
    firstSkillMarkdown.toString('base64'))

  await writeSkill(external, '# Changed\n\nA new immutable revision.\n')
  const second = await catalog.import({
    sourcePath,
    skillId: first.skillId,
    expectedRevision: 1,
  })
  assert.equal(second.revision, 2)
  assert.notEqual(second.digest, first.digest)
  assert.equal((await catalog.list()).assets.length, 2)
})

test('fails closed for symlinked source files and tampered managed snapshots', async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-project-'))
  const external = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-source-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  t.after(() => rm(external, { recursive: true, force: true }))
  const sourcePath = await writeSkill(external, '# Safe skill\n\nSafe instructions.\n')
  const catalog = new SkillAssetCatalog(project)
  await writeFile(path.join(external, 'outside.md'), 'outside\n')
  await symlink(sourcePath, path.join(external, 'source-link'))
  await assert.rejects(() => catalog.import({
    sourcePath: path.join(external, 'source-link'),
    skillId: '@workspace/source-link',
    expectedRevision: 0,
  }), /symbolic link/u)
  await symlink(path.join(external, 'outside.md'), path.join(sourcePath, 'escape.md'))
  await assert.rejects(() => catalog.import({
    sourcePath,
    skillId: '@workspace/unsafe',
    expectedRevision: 0,
  }), /symbolic links/u)

  await rm(path.join(sourcePath, 'escape.md'))
  const asset = await catalog.import({
    sourcePath,
    skillId: '@workspace/safe',
    expectedRevision: 0,
  })
  await assert.rejects(() => lstat(sourcePath), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT')
  const assetRef = { skillId: asset.skillId, revision: asset.revision, digest: asset.digest }
  await writeFile(path.join(catalog.assetsDir, asset.digest, 'SKILL.md'), 'tampered\n')
  await assert.rejects(() => catalog.resolve([assetRef]), /manifest|digest/u)
  await writeSkill(external, '# Safe skill\n\nSafe instructions.\n')
  await assert.rejects(() => catalog.import({
    sourcePath,
    skillId: '@workspace/collision',
    expectedRevision: 0,
  }), /collision/u)
  assert.equal((await lstat(sourcePath)).isDirectory(), true)
  assert.equal((await catalog.list()).assets.some((item) => item.skillId === '@workspace/collision'), false)
})

test('refuses a symlinked workspace parent', async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-project-'))
  const external = await mkdtemp(path.join(os.tmpdir(), 'ggai-node-skills-outside-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  t.after(() => rm(external, { recursive: true, force: true }))
  await mkdir(path.join(project, '.gg'), { recursive: true })
  await symlink(external, path.join(project, '.gg', 'workspace'))
  const catalog = new SkillAssetCatalog(project)
  await assert.rejects(() => catalog.list(), /symlink/u)
})
