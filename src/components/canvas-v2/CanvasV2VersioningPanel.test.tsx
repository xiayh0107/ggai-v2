// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasV2StoreState } from '@/canvas-v2/store'
import type {
  CanvasV2VersioningClient,
  CanvasV2WorkspaceMergePreview,
} from '@/canvas-v2/versioningClient'
import CanvasV2VersioningPanel, {
  type CanvasV2VersioningFlushStore,
} from './CanvasV2VersioningPanel'

const commitA = 'a'.repeat(40)
const commitB = 'b'.repeat(40)
const commitC = 'c'.repeat(40)
const ready = { state: 'ready', initialized: true, gitAvailable: true } as const
const branches = [
  { name: 'main', commit: commitA, worktree: null },
  { name: 'feature/chart', commit: commitB, worktree: null },
]
const historyPage = {
  entries: [{
    commit: commitA,
    parents: [],
    committedAt: '2026-08-05T10:00:00.000Z',
    subject: 'manual checkpoint',
  }],
  nextCursor: null,
}

type VersioningClient = Pick<
  CanvasV2VersioningClient,
  | 'status'
  | 'listBranches'
  | 'history'
  | 'createBranch'
  | 'checkpoint'
  | 'restoreAsNewBranch'
  | 'previewMerge'
  | 'executeMerge'
>

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function operation<Value>(value: Value) {
  return { ok: true, partial: false, value, versioning: ready } as const
}

function canvas(branch = 'main') {
  return {
    branch,
    revision: 2,
    updatedAt: '2026-08-05T10:00:00.000Z',
    lastMutationId: null,
    lastCheckpoint: commitA,
    document: {
      schemaVersion: 2 as const,
      nodes: [],
      tasks: [],
      collections: [],
      edges: [],
      receipts: [],
      everCreated: false,
    },
  }
}

function createClient(overrides: Partial<VersioningClient> = {}): VersioningClient {
  return {
    status: vi.fn(async () => ({ versioning: ready })),
    listBranches: vi.fn(async () => operation(branches)),
    history: vi.fn(async () => operation(historyPage)),
    createBranch: vi.fn(async (_scope, input) => operation({
      branch: { name: input.name, commit: commitA, worktree: null },
      canvas: canvas(input.name),
    })),
    checkpoint: vi.fn(async () => operation({
      canvas: canvas(),
      checkpoint: { branch: 'main', commit: commitA, changed: true, status: ready },
    })),
    restoreAsNewBranch: vi.fn(async (_scope, input) => operation({
      branch: { name: input.newBranch, commit: input.checkpoint, worktree: null },
      canvas: canvas(input.newBranch),
    })),
    previewMerge: vi.fn(async () => operation(mergePreview())),
    executeMerge: vi.fn(async () => operation({
      state: 'merged' as const,
      canvas: { ...mergePreview().canvas, merged: true, commit: commitC },
      canvasEnvelope: canvas(),
    })),
    ...overrides,
  }
}

function syncedStore(overrides: Partial<CanvasV2StoreState['commandSync']> = {}) {
  const commandSync: CanvasV2StoreState['commandSync'] = {
    status: 'saved',
    pendingCount: 0,
    error: null,
    conflict: null,
    ...overrides,
  }
  return {
    flushCommands: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => ({ commandSync })),
  } satisfies CanvasV2VersioningFlushStore
}

function mergePreview(): CanvasV2WorkspaceMergePreview {
  return {
    state: 'ready',
    canvas: {
      sourceBranch: 'feature/chart',
      targetBranch: 'main',
      sourceCommit: commitB,
      targetCommit: commitA,
      baseCommit: commitC,
      state: 'ready',
      changed: true,
      paths: ['nodes/chart.json'],
      conflicts: [],
    },
    expectation: {
      sourceCommit: commitB,
      targetCommit: commitA,
      sourceRevision: 4,
      targetRevision: 2,
    },
  }
}

async function renderSubject(options: {
  client?: VersioningClient
  store?: CanvasV2VersioningFlushStore
} = {}) {
  const client = options.client ?? createClient()
  const store = options.store ?? syncedStore()
  const onNavigateBranch = vi.fn()
  const onClose = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <CanvasV2VersioningPanel
        client={client}
        projectDir="/workspace/project"
        branch="main"
        store={store}
        onNavigateBranch={onNavigateBranch}
        onClose={onClose}
      />,
    )
  })
  return { client, store, onNavigateBranch, onClose }
}

function testId<ElementType extends Element>(id: string): ElementType {
  const element = document.querySelector<ElementType>(`[data-testid="${id}"]`)
  if (!element) throw new Error(`Missing test id ${id}`)
  return element
}

function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!result) throw new Error(`Missing button ${label}`)
  return result
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
}

describe('CanvasV2VersioningPanel', () => {
  it('is an accessible V2-only panel with branches, checkpoints, and no source/delete controls', async () => {
    await renderSubject()

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog?.textContent).toContain('仅记录 Canvas V2 文档')
    expect(dialog?.textContent).toContain('feature/chart')
    expect(dialog?.textContent).toContain('manual checkpoint')
    expect([...dialog?.querySelectorAll('button') ?? []]
      .some((control) => control.textContent?.includes('源码'))).toBe(false)
    expect([...dialog?.querySelectorAll('button') ?? []]
      .some((control) => control.textContent?.includes('删除分支'))).toBe(false)
  })

  it('flushes to a genuinely empty outbox before create, checkpoint, and switch operations', async () => {
    const client = createClient()
    const store = syncedStore()
    const { onNavigateBranch } = await renderSubject({ client, store })

    setValue(testId<HTMLInputElement>('versioning-new-branch'), 'feature/new-chart')
    await click(testId('versioning-create-branch'))
    expect(store.flushCommands).toHaveBeenCalledTimes(1)
    expect(client.createBranch).toHaveBeenCalledWith(
      { projectDir: '/workspace/project' },
      { name: 'feature/new-chart', fromBranch: 'main' },
    )

    await click(testId('versioning-checkpoint'))
    expect(store.flushCommands).toHaveBeenCalledTimes(2)
    expect(client.checkpoint).toHaveBeenCalledOnce()

    await click(button('切换'))
    expect(store.flushCommands).toHaveBeenCalledTimes(3)
    expect(onNavigateBranch).toHaveBeenCalledWith('feature/chart')
  })

  it('blocks navigation on conflict and keeps the user-visible conflict state', async () => {
    const store = syncedStore({
      status: 'conflict',
      pendingCount: 1,
      conflict: {
        reason: 'revision',
        mutationId: 'mutation-1',
        code: 'revision_conflict',
        message: 'server revision changed',
      },
    })
    const { onNavigateBranch } = await renderSubject({ store })

    await click(button('切换'))

    expect(store.flushCommands).toHaveBeenCalledOnce()
    expect(onNavigateBranch).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'server revision changed',
    )
  })

  it('preserves restore input and dialog when daemon reports a partial failure', async () => {
    const restoreAsNewBranch = vi.fn<VersioningClient['restoreAsNewBranch']>(async (_scope, input) => ({
      ok: false,
      partial: true,
      error: { code: 'materialize_failed', message: 'runtime materialization failed' },
      value: {
        branch: { name: input.newBranch, commit: input.checkpoint, worktree: null },
        canvas: canvas(input.newBranch),
      },
      versioning: ready,
    }))
    const client = createClient({ restoreAsNewBranch })
    const { onNavigateBranch } = await renderSubject({ client })
    await click(button('恢复…'))
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    const input = testId<HTMLInputElement>('versioning-restore-branch')
    setValue(input, 'restore/my-chart')

    await click(testId('versioning-confirm-restore'))

    expect(onNavigateBranch).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(testId<HTMLInputElement>('versioning-restore-branch').value).toBe('restore/my-chart')
    expect(document.body.textContent).toContain('操作已部分完成')
  })

  it('executes only after preview and explicit confirmation, flushing both times', async () => {
    const client = createClient()
    const store = syncedStore()
    const { onNavigateBranch } = await renderSubject({ client, store })

    await click(testId('versioning-preview-merge'))

    expect(client.previewMerge).toHaveBeenCalledWith(
      { projectDir: '/workspace/project' },
      { sourceBranch: 'feature/chart', targetBranch: 'main' },
    )
    expect(client.executeMerge).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      '明确确认',
    )

    await click(testId('versioning-confirm-merge'))

    expect(store.flushCommands).toHaveBeenCalledTimes(2)
    expect(client.executeMerge).toHaveBeenCalledWith(
      { projectDir: '/workspace/project' },
      {
        sourceBranch: 'feature/chart',
        targetBranch: 'main',
        confirmed: true,
        expected: mergePreview().expectation,
      },
    )
    expect(onNavigateBranch).toHaveBeenCalledWith('main')
  })
})
