import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MAX_RUN_OUTCOME_BYTES,
  readRunOutcome,
  RUN_OUTCOME_RELATIVE_PATH,
} from '../outcome.js'

function outcome(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    suggestedActions: [],
    outputs: [{
      key: 'source',
      path: 'plot.R',
      pluginId: 'code',
      role: 'primary',
    }],
    taskProposals: [{
      key: 'refine',
      title: 'Refine plot',
      prompt: 'Refine the generated plot.',
      inputOutputKeys: ['source'],
    }],
  }
}

async function fixture(): Promise<{ root: string; filesRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-outcome-v2-'))
  const filesRoot = path.join(root, 'artifacts', 'run', 'files')
  await mkdir(filesRoot, { recursive: true })
  return { root, filesRoot }
}

async function writeOutcome(filesRoot: string, value: unknown): Promise<string> {
  const target = path.join(filesRoot, ...RUN_OUTCOME_RELATIVE_PATH.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value)}\n`, 'utf8')
  return target
}

test('reads a bounded exact outcome sidecar and normalizes optional dependency arrays', async () => {
  const subject = await fixture()
  try {
    await writeOutcome(subject.filesRoot, outcome())
    const parsed = await readRunOutcome(subject.filesRoot)
    assert.equal(parsed?.schemaVersion, 2)
    assert.deepEqual(parsed?.outputs[0]?.derivedFrom, [])
    assert.deepEqual(parsed?.taskProposals[0]?.dependsOn, [])
  } finally {
    await rm(subject.root, { recursive: true, force: true })
  }
})

test('missing, malformed, unsupported, extra-field, and oversized outcome sidecars are ignored', async () => {
  const subject = await fixture()
  try {
    assert.equal(await readRunOutcome(subject.filesRoot), undefined)

    const target = await writeOutcome(subject.filesRoot, outcome())
    await writeFile(target, '{not json', 'utf8')
    assert.equal(await readRunOutcome(subject.filesRoot), undefined)

    await writeOutcome(subject.filesRoot, { ...outcome(), schemaVersion: 3 })
    assert.equal(await readRunOutcome(subject.filesRoot), undefined)

    await writeOutcome(subject.filesRoot, { ...outcome(), runId: 'agent-owned' })
    assert.equal(await readRunOutcome(subject.filesRoot), undefined)

    await writeFile(target, Buffer.alloc(MAX_RUN_OUTCOME_BYTES + 1, 0x20))
    assert.equal(await readRunOutcome(subject.filesRoot), undefined)
  } finally {
    await rm(subject.root, { recursive: true, force: true })
  }
})

test('symlinked outcome sidecars and control directories are ignored', async (t) => {
  await t.test('sidecar symlink', async () => {
    const subject = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-outcome-v2-outside-'))
    try {
      const outsideFile = path.join(outside, 'run-result.json')
      await writeFile(outsideFile, JSON.stringify(outcome()), 'utf8')
      const target = path.join(subject.filesRoot, ...RUN_OUTCOME_RELATIVE_PATH.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await symlink(outsideFile, target)
      assert.equal(await readRunOutcome(subject.filesRoot), undefined)
    } finally {
      await Promise.all([
        rm(subject.root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ])
    }
  })

  await t.test('control directory symlink', async () => {
    const subject = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-outcome-v2-dir-outside-'))
    try {
      await writeFile(path.join(outside, 'run-result.json'), JSON.stringify(outcome()), 'utf8')
      await symlink(outside, path.join(subject.filesRoot, '.ggai'), 'dir')
      assert.equal(await readRunOutcome(subject.filesRoot), undefined)
    } finally {
      await Promise.all([
        rm(subject.root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ])
    }
  })
})

test('a hard-linked outcome sidecar is treated as foreign and ignored', async () => {
  const subject = await fixture()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-outcome-v2-link-outside-'))
  try {
    const outsideFile = path.join(outside, 'run-result.json')
    await writeFile(outsideFile, JSON.stringify(outcome()), 'utf8')
    const target = path.join(subject.filesRoot, ...RUN_OUTCOME_RELATIVE_PATH.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await link(outsideFile, target)
    assert.equal(await readRunOutcome(subject.filesRoot), undefined)
  } finally {
    await Promise.all([
      rm(subject.root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  }
})
