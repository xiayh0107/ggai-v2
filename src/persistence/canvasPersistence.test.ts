import { describe, expect, it } from 'vitest'
import type { DaemonCanvasDocumentV1 } from '@/agent/daemonClient'
import {
  canvasJournalKey,
  decodeCanvasJournalEntries,
  reconcileCanvasJournalCandidate,
  selectCanvasJournalCandidates,
  type CanvasJournalCandidate,
  type CanvasJournalEntry,
  type CanvasJournalScope,
} from './canvasPersistence'

const scope: CanvasJournalScope = {
  daemonBaseUrl: 'http://127.0.0.1:7380',
  projectDir: '.',
  branch: 'main',
}

const document: DaemonCanvasDocumentV1 = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  everCreated: false,
  generationByNodeId: {},
  latestRunByNodeId: {},
  runRefsByNodeId: {},
}

function entry(mutationId: string, baseRevision: number, attempted = false): CanvasJournalEntry {
  return {
    mutationId,
    baseRevision,
    changeKind: 'autosave',
    createdAt: 1,
    attempted,
    fingerprint: mutationId,
    document,
  }
}

describe('canvas IndexedDB journal protocol', () => {
  it('partitions the same canvas scope by stable writer id', () => {
    expect(canvasJournalKey(scope, 'tab-a')).not.toBe(canvasJournalKey(scope, 'tab-b'))
    expect(canvasJournalKey(scope, 'tab-a')).toBe(canvasJournalKey(scope, 'tab-a'))
  })

  it('fully validates documents and isolates corrupt entries one at a time', () => {
    const malformed = {
      ...entry('bad', 4),
      document: { ...document, nodes: [{ id: 'missing-required-fields' }] },
    }
    const decoded = decodeCanvasJournalEntries([
      entry('good', 4),
      malformed,
      { mutationId: 'truncated' },
    ])

    expect(decoded.entries.map((candidate) => candidate.mutationId)).toEqual(['good'])
    expect(decoded.discardedEntries).toBe(2)
  })

  it('drops an acknowledged head and rebases every tail entry for retry', () => {
    const candidate: CanvasJournalCandidate = {
      writerId: 'tab-a',
      entries: [entry('head', 4, true), entry('tail-1', 4, true), entry('tail-2', 4, true)],
      updatedAt: 1,
      discardedEntries: 0,
    }

    const reconciled = reconcileCanvasJournalCandidate(candidate, {
      revision: 5,
      lastMutationId: 'head',
    })

    expect(reconciled.acknowledged).toBe(true)
    expect(reconciled.candidate?.entries).toHaveLength(2)
    expect(reconciled.candidate?.entries.every((tail) =>
      tail.baseRevision === 5 && tail.attempted === false)).toBe(true)
  })

  it('keeps two tabs isolated and flags the foreign candidate instead of merging it', () => {
    const tabA: CanvasJournalCandidate = {
      writerId: 'tab-a',
      entries: [entry('mutation-a', 7)],
      updatedAt: 2,
      discardedEntries: 0,
    }
    const tabB: CanvasJournalCandidate = {
      writerId: 'tab-b',
      entries: [entry('mutation-b', 7)],
      updatedAt: 3,
      discardedEntries: 0,
    }

    const selection = selectCanvasJournalCandidates([tabA, tabB], 'tab-a', 7)

    expect(selection.conflict).toBe(true)
    expect(selection.ownCandidate?.entries[0]?.mutationId).toBe('mutation-a')
    expect(selection.foreignCandidates.map((candidate) => candidate.writerId)).toEqual(['tab-b'])
    expect(selection.ownCandidate?.entries).not.toContain(tabB.entries[0])
  })
})
