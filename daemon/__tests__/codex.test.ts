import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexTransport } from '../transport/codex.js'
import { TransportError } from '../transport/types.js'

test('Codex never recreates a missing bound source worktree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ggai-codex-source-missing-'))
  const sourceProjectDir = path.join(root, '.gg', 'source-worktrees', 'missing-id')
  try {
    const transport = new CodexTransport({ command: process.execPath })
    await assert.rejects(() => transport.run({
      runId: 'run-missing-source',
      nodeId: 'node-missing-source',
      agentId: 'codex',
      sessionId: null,
      prompt: 'must not run',
      projectDir: root,
      sourceProjectDir,
      contextFile: path.join(root, '.gg/context/pack.md'),
      artifactDir: path.join(root, 'artifacts/node-missing-source'),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onSessionId: () => undefined,
    }), (error: unknown) =>
      error instanceof TransportError && error.code === 'source_worktree_unavailable')
    await assert.rejects(access(sourceProjectDir), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
