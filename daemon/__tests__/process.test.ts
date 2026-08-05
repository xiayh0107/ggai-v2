import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ChildProcessPool } from '../transport/process.js'

test('cancellation terminates the full POSIX child process group', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-process-'))
  const marker = path.join(root, 'grandchild-survived')
  const controller = new AbortController()
  const pool = new ChildProcessPool()
  let ready: (() => void) | undefined
  const readyPromise = new Promise<void>((resolve) => { ready = resolve })
  const grandchild = [
    "import { writeFileSync } from 'node:fs'",
    `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 750)`,
  ].join(';')
  const parent = [
    "import { spawn } from 'node:child_process'",
    `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
    "process.stdout.write('READY\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')

  try {
    const run = pool.spawn({
      runId: 'process-tree-test',
      command: process.execPath,
      args: ['--input-type=module', '-e', parent],
      cwd: root,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'text-delta' && event.text === 'READY') ready?.()
      },
      onSessionId: () => undefined,
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        readyPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('child did not start')), 2_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    controller.abort()
    await assert.rejects(run, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await assert.rejects(access(marker))
  } finally {
    await pool.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelAndWait holds the boundary until a TERM-ignoring descendant is gone', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-process-wait-'))
  const marker = path.join(root, 'late-grandchild-write')
  const pool = new ChildProcessPool({ forceKillAfterMs: 150, forceKillConfirmMs: 500 })
  let ready: (() => void) | undefined
  const readyPromise = new Promise<void>((resolve) => { ready = resolve })
  const grandchild = [
    "import { writeFileSync } from 'node:fs'",
    "process.on('SIGTERM', () => undefined)",
    "process.stdout.write('GRANDCHILD_READY\\n')",
    `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 600)`,
    'setInterval(() => undefined, 1000)',
  ].join(';')
  const parent = [
    "import { spawn } from 'node:child_process'",
    `const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    "process.on('SIGTERM', () => process.exit(0))",
    "child.stdout.once('data', () => process.stdout.write('READY\\n'))",
    'setInterval(() => undefined, 1000)',
  ].join(';')

  try {
    const run = pool.spawn({
      runId: 'process-tree-wait-test',
      command: process.execPath,
      args: ['--input-type=module', '-e', parent],
      cwd: root,
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.type === 'text-delta' && event.text === 'READY') ready?.()
      },
      onSessionId: () => undefined,
    })
    await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('grandchild did not start')), 2_000)),
    ])
    const startedAt = Date.now()
    assert.equal(await pool.cancelAndWait('process-tree-wait-test'), true)
    assert.ok(Date.now() - startedAt >= 100)
    await run
    await new Promise((resolve) => setTimeout(resolve, 650))
    await assert.rejects(access(marker))
  } finally {
    await pool.close()
    await rm(root, { recursive: true, force: true })
  }
})
