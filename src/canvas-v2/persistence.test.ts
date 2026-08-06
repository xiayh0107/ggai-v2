import { describe, expect, it } from 'vitest'
import {
  CanvasV2Persistence,
  MemoryCanvasV2PersistenceAdapter,
  rebaseCanvasV2OutboxEntries,
  type CanvasV2OutboxEntry,
  type CanvasV2PersistenceScope,
  type CanvasV2ViewState,
} from './persistence'

type TestCommand =
  | { type: 'move-task'; taskId: string; dx: number }
  | { type: 'rename-task'; taskId: string; title: string }

const main: CanvasV2PersistenceScope = {
  daemonBaseUrl: 'http://127.0.0.1:7380',
  projectDir: '/project',
  branch: 'main',
}

const feature: CanvasV2PersistenceScope = { ...main, branch: 'feature/rich-node' }

const viewState: CanvasV2ViewState = {
  camera: { x: 12, y: -4, zoom: 1.25 },
  selection: [{ kind: 'task', id: 'task-1' }],
  collapsedTaskIds: ['task-2'],
  collapsedCollectionIds: ['collection-1'],
  composerDrafts: { 'task:task-1': '继续完善图表' },
}

function persistence(adapter = new MemoryCanvasV2PersistenceAdapter()) {
  return new CanvasV2Persistence<TestCommand>({ adapter, now: () => 100 })
}

describe('Canvas V2 browser persistence', () => {
  it('stores view state by branch without storing a canvas document', async () => {
    const subject = persistence()
    await subject.writeViewState(main, viewState)

    expect(await subject.readViewState(main)).toEqual(viewState)
    expect(await subject.readViewState(feature)).toBeNull()

    const loaded = await subject.readViewState(main)
    loaded!.camera.x = 999
    expect((await subject.readViewState(main))?.camera.x).toBe(12)
  })

  it('durably queues before send and acknowledges only after success', async () => {
    const subject = persistence()
    const command: TestCommand = { type: 'move-task', taskId: 'task-1', dx: 20 }
    const observed: string[] = []

    const response = await subject.persistThenSend(main, {
      baseRevision: 7,
      mutationId: 'mutation-1',
      command,
    }, async (entry) => {
      observed.push(...(await subject.list(main)).map((candidate) => candidate.mutationId))
      expect(entry).toEqual({
        branch: 'main',
        baseRevision: 7,
        initialBaseRevision: 7,
        mutationId: 'mutation-1',
        command,
        createdAt: 100,
      })
      return { revision: 8 }
    })

    expect(observed).toEqual(['mutation-1'])
    expect(response).toEqual({ revision: 8 })
    expect(await subject.list(main)).toEqual([])
  })

  it('leaves a failed send in the outbox for idempotent retry', async () => {
    const subject = persistence()
    await expect(subject.persistThenSend(main, {
      baseRevision: 3,
      mutationId: 'mutation-retry',
      command: { type: 'rename-task', taskId: 'task-1', title: 'New title' },
    }, async () => {
      throw new Error('offline')
    })).rejects.toThrow('offline')

    expect((await subject.list(main)).map((entry) => entry.mutationId))
      .toEqual(['mutation-retry'])
  })

  it('lists FIFO entries and rebases a conflict without changing commands or ids', async () => {
    const subject = new CanvasV2Persistence<TestCommand>({
      adapter: new MemoryCanvasV2PersistenceAdapter(),
      now: (() => {
        let timestamp = 10
        return () => timestamp++
      })(),
    })
    await subject.enqueue(main, {
      baseRevision: 2,
      mutationId: 'mutation-a',
      command: { type: 'move-task', taskId: 'task-1', dx: 5 },
    })
    await subject.enqueue(main, {
      baseRevision: 2,
      mutationId: 'mutation-b',
      command: { type: 'rename-task', taskId: 'task-1', title: 'Scatter plot' },
    })

    const rebased = await subject.rebaseConflict(main, 9)
    expect(rebased.map(({ mutationId, baseRevision, initialBaseRevision }) => ({
      mutationId,
      baseRevision,
      initialBaseRevision,
    })))
      .toEqual([
        { mutationId: 'mutation-a', baseRevision: 9, initialBaseRevision: 2 },
        { mutationId: 'mutation-b', baseRevision: 10, initialBaseRevision: 2 },
      ])
    expect(rebased.map((entry) => entry.command.type))
      .toEqual(['move-task', 'rename-task'])
    expect(await subject.list(main)).toEqual(rebased)
  })

  it('acks one mutation and clears only the requested branch', async () => {
    const adapter = new MemoryCanvasV2PersistenceAdapter()
    const subject = persistence(adapter)
    await subject.writeViewState(main, viewState)
    await subject.writeViewState(feature, { ...viewState, collapsedTaskIds: [] })
    await subject.enqueue(main, {
      baseRevision: 0,
      mutationId: 'main-a',
      command: { type: 'move-task', taskId: 'task-1', dx: 1 },
    })
    await subject.enqueue(main, {
      baseRevision: 1,
      mutationId: 'main-b',
      command: { type: 'move-task', taskId: 'task-1', dx: 2 },
    })
    await subject.enqueue(feature, {
      baseRevision: 0,
      mutationId: 'feature-a',
      command: { type: 'move-task', taskId: 'task-1', dx: 3 },
    })

    await subject.ack(main, 'main-a')
    expect((await subject.list(main)).map((entry) => entry.mutationId)).toEqual(['main-b'])

    await subject.clearBranch(main)
    expect(await subject.readViewState(main)).toBeNull()
    expect(await subject.list(main)).toEqual([])
    expect(await subject.readViewState(feature)).not.toBeNull()
    expect((await subject.list(feature)).map((entry) => entry.mutationId))
      .toEqual(['feature-a'])
  })

  it('provides a pure deterministic conflict rebase for non-DOM tests', () => {
    const entries: CanvasV2OutboxEntry<TestCommand>[] = [
      {
        branch: 'main',
        baseRevision: 1,
        initialBaseRevision: 1,
        mutationId: 'later',
        command: { type: 'move-task', taskId: 'task-1', dx: 2 },
        createdAt: 2,
      },
      {
        branch: 'main',
        baseRevision: 1,
        initialBaseRevision: 1,
        mutationId: 'earlier',
        command: { type: 'move-task', taskId: 'task-1', dx: 1 },
        createdAt: 1,
      },
    ]

    const rebased = rebaseCanvasV2OutboxEntries(entries, 20)
    expect(rebased.map(({ mutationId, baseRevision, initialBaseRevision }) => ({
      mutationId,
      baseRevision,
      initialBaseRevision,
    })))
      .toEqual([
        { mutationId: 'earlier', baseRevision: 20, initialBaseRevision: 1 },
        { mutationId: 'later', baseRevision: 21, initialBaseRevision: 1 },
      ])
    expect(entries.map((entry) => entry.baseRevision)).toEqual([1, 1])
  })

  it('decodes legacy outbox records with their base as the immutable initial base', async () => {
    const adapter = new MemoryCanvasV2PersistenceAdapter()
    const subject = persistence(adapter)
    const scopeKey = JSON.stringify([main.daemonBaseUrl, main.projectDir, main.branch])
    await adapter.writeOutbox({
      key: JSON.stringify([scopeKey, 'legacy-mutation']),
      scopeKey,
      entry: {
        branch: 'main',
        baseRevision: 6,
        mutationId: 'legacy-mutation',
        command: { type: 'move-task', taskId: 'task-1', dx: 4 },
        createdAt: 99,
      },
    })

    await expect(subject.list(main)).resolves.toEqual([{
      branch: 'main',
      baseRevision: 6,
      initialBaseRevision: 6,
      mutationId: 'legacy-mutation',
      command: { type: 'move-task', taskId: 'task-1', dx: 4 },
      createdAt: 99,
    }])
  })
})
