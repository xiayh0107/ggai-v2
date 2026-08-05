import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MAX_RUN_OUTCOME_BYTES,
  readRunOutcome,
  RUN_OUTCOME_RELATIVE_PATH,
} from '../outcome.js'

interface TestOutcome {
  schemaVersion: number
  suggestedActions: Array<{ id: string; label: string; prompt: string }>
}

function outcome(label = 'Summarize findings'): TestOutcome {
  return {
    schemaVersion: 1,
    suggestedActions: [
      { id: 'summarize', label, prompt: 'Summarize the main findings.' },
      { id: 'make-chart', label: 'Make a chart', prompt: 'Turn the key values into a chart.' },
      { id: 'draft-brief', label: 'Draft a brief', prompt: 'Draft a concise stakeholder brief.' },
    ],
  }
}

async function fixture(): Promise<{ root: string; artifactDir: string; close(): Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-outcome-'))
  const artifactDir = path.join(root, 'artifacts', 'run', 'node')
  await mkdir(artifactDir, { recursive: true })
  return {
    root,
    artifactDir,
    async close() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function writeOutcome(artifactDir: string, value: unknown): Promise<string> {
  const target = path.join(artifactDir, ...RUN_OUTCOME_RELATIVE_PATH.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value)}\n`, 'utf8')
  return target
}

test('reads a bounded, exact v1 run outcome', async () => {
  const subject = await fixture()
  try {
    await writeOutcome(subject.artifactDir, outcome())
    assert.deepEqual(await readRunOutcome(subject.artifactDir), outcome())
  } finally {
    await subject.close()
  }
})

test('missing, malformed, oversized, and unknown outcomes are non-fatal', async (t) => {
  await t.test('missing', async () => {
    const subject = await fixture()
    try {
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)
    } finally {
      await subject.close()
    }
  })

  await t.test('malformed or non-exact schema', async () => {
    const subject = await fixture()
    try {
      const target = await writeOutcome(subject.artifactDir, outcome())
      await writeFile(target, '{not json', 'utf8')
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)

      await writeOutcome(subject.artifactDir, { ...outcome(), unexpected: true })
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)

      const duplicate = outcome()
      duplicate.suggestedActions[1] = {
        ...duplicate.suggestedActions[0] as TestOutcome['suggestedActions'][number],
        id: 'different-id',
      }
      await writeOutcome(subject.artifactDir, duplicate)
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)

      const controlLabel = outcome()
      controlLabel.suggestedActions[0] = {
        ...controlLabel.suggestedActions[0] as TestOutcome['suggestedActions'][number],
        label: 'Unsafe\nlabel',
      }
      await writeOutcome(subject.artifactDir, controlLabel)
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)
    } finally {
      await subject.close()
    }
  })

  await t.test('oversized', async () => {
    const subject = await fixture()
    try {
      const target = path.join(subject.artifactDir, ...RUN_OUTCOME_RELATIVE_PATH.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.alloc(MAX_RUN_OUTCOME_BYTES + 1, 0x20))
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)
    } finally {
      await subject.close()
    }
  })

  await t.test('unknown version', async () => {
    const subject = await fixture()
    try {
      await writeOutcome(subject.artifactDir, { ...outcome(), schemaVersion: 2 })
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)
    } finally {
      await subject.close()
    }
  })
})

test('symlinked outcome files and control directories are ignored', async (t) => {
  await t.test('sidecar symlink', async () => {
    const subject = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-outcome-outside-'))
    try {
      const outsideFile = path.join(outside, 'run-result.json')
      await writeFile(outsideFile, JSON.stringify(outcome('Outside')), 'utf8')
      const target = path.join(subject.artifactDir, ...RUN_OUTCOME_RELATIVE_PATH.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await symlink(outsideFile, target)
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)
    } finally {
      await Promise.all([
        subject.close(),
        rm(outside, { recursive: true, force: true }),
      ])
    }
  })

  await t.test('control directory symlink', async () => {
    const subject = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ggai-outcome-dir-outside-'))
    try {
      await writeFile(
        path.join(outside, 'run-result.json'),
        JSON.stringify(outcome('Outside directory')),
        'utf8',
      )
      await symlink(outside, path.join(subject.artifactDir, '.ggai'), 'dir')
      assert.equal(await readRunOutcome(subject.artifactDir), undefined)
    } finally {
      await Promise.all([
        subject.close(),
        rm(outside, { recursive: true, force: true }),
      ])
    }
  })
})
