// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DaemonClient, type SourceGitStatus } from '@/agent/daemonClient'
import { CanvasVersionManagerPanel } from './CanvasVersionManager'

const versioning = { state: 'ready', initialized: true, gitAvailable: true }
const unavailableSource: SourceGitStatus = { status: 'unavailable', branches: [] }
const readySource: SourceGitStatus = {
  status: 'ready',
  repoRoot: '/workspace',
  projectRelativeDir: 'app',
  branches: [{
    logicalBranch: 'main',
    gitBranch: 'ggai/main',
    worktreeId: 'source-1',
    worktreePath: '/workspace/.gg/source-worktrees/source-1',
    projectDir: '/workspace/.gg/source-worktrees/source-1/app',
    head: 'abcdef123456',
    dirty: true,
  }],
}
const branch = { name: 'main', commit: 'abcdef123456', worktree: null }
const featureBranch = { name: 'feature-a', commit: 'fedcba654321', worktree: null }
const canvas = {
  branch: 'main',
  revision: 2,
  updatedAt: new Date(0).toISOString(),
  lastMutationId: null,
  lastCheckpoint: 'abcdef123456',
  document: {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    everCreated: false,
    generationByNodeId: {},
    latestRunByNodeId: {},
    runRefsByNodeId: {},
  },
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function success<T>(value: T, source: SourceGitStatus = unavailableSource) {
  return {
    ok: true,
    partial: false,
    sourceDegraded: false,
    value,
    versioning,
    source,
  }
}

function versionClient(options: {
  source?: 'unavailable' | 'unbound' | 'ready'
  sourceCheckpoint?: 'safe' | 'sensitive'
  automation?: 'auto' | 'confirm'
  merge?: 'ready' | 'conflicts' | 'partial' | 'partial-source' | 'stale'
} = {}) {
  const source: SourceGitStatus = options.source === 'unbound'
    ? { status: 'unbound', repoRoot: '/workspace', projectRelativeDir: 'app', branches: [] }
    : options.source === 'ready' ? readySource : unavailableSource
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    requests.push({ path: url.pathname, method, body })
    if (url.pathname === '/canvas/status') return response({ versioning, source })
    if (url.pathname === '/canvas/branches' && method === 'GET') {
      return response(success([branch, featureBranch], source))
    }
    if (url.pathname === '/canvas/history') {
      return response(success({
        entries: [{
          commit: 'abcdef123456',
          parents: [],
          committedAt: new Date(0).toISOString(),
          subject: 'ggai(canvas): node-created',
        }],
        nextCursor: null,
      }, source))
    }
    if (url.pathname === '/canvas/source' && method === 'GET') return response(source)
    if (url.pathname === '/canvas/preferences' && method === 'GET') {
      return response({ schemaVersion: 1, automationMode: options.automation ?? 'confirm' })
    }
    if (url.pathname === '/canvas/branches' && method === 'POST') {
      return response(success({
        branch: { ...branch, name: body.name },
        canvas: { ...canvas, branch: body.name },
        sourceBranch: null,
      }, source))
    }
    if (url.pathname === '/canvas/restores') {
      return response(success({
        branch: { ...branch, name: body.newBranch },
        canvas: { ...canvas, branch: body.newBranch },
        sourceBranch: null,
      }, source))
    }
    if (url.pathname === '/canvas/merges/preview') {
      const conflicts = options.merge === 'conflicts'
        ? [{
            path: 'nodes/node-1.json',
            kind: 'content',
            stages: { base: true, ours: true, theirs: true },
          }]
        : []
      const state = conflicts.length > 0 ? 'conflicts' : 'ready'
      const sourcePreview = options.merge === 'partial-source'
        ? {
            sourceBranch: body.sourceBranch,
            targetBranch: body.targetBranch,
            sourceCommit: 'source-feature-commit',
            targetCommit: 'source-main-commit',
            baseCommit: 'source-base-commit',
            state: 'ready',
            changed: true,
            paths: ['src/index.ts'],
            conflicts: [],
          }
        : null
      return response(success({
        state,
        canvas: {
          sourceBranch: body.sourceBranch,
          targetBranch: body.targetBranch,
          sourceCommit: 'fedcba654321',
          targetCommit: 'abcdef123456',
          baseCommit: 'base123',
          state,
          changed: true,
          paths: ['nodes/node-1.json'],
          conflicts,
          ...(conflicts.length > 0
            ? { resolution: { requiresExplicitApproval: true } }
            : {}),
        },
        source: sourcePreview,
        expectation: {
          canvas: {
            sourceCommit: 'fedcba654321',
            targetCommit: 'abcdef123456',
            sourceRevision: 4,
            targetRevision: 2,
          },
          source: sourcePreview
            ? {
                sourceCommit: sourcePreview.sourceCommit,
                targetCommit: sourcePreview.targetCommit,
              }
            : null,
        },
      }, source))
    }
    if (url.pathname === '/canvas/merges') {
      if (options.merge === 'stale') {
        return response({
          ok: false,
          partial: false,
          sourceDegraded: false,
          error: {
            code: 'merge_preview_stale',
            message: 'merge preview is stale',
          },
          versioning,
          source,
        })
      }
      if (options.merge === 'partial-source') {
        return response({
          ok: false,
          partial: true,
          sourceDegraded: false,
          error: {
            code: 'canvas_anchor_failed',
            message: 'source merged, but the canvas source anchor failed',
          },
          value: {
            state: 'partial',
            canvas: {
              sourceBranch: body.sourceBranch,
              targetBranch: body.targetBranch,
              sourceCommit: 'fedcba654321',
              targetCommit: 'abcdef123456',
              baseCommit: 'base123',
              state: 'up-to-date',
              changed: false,
              paths: [],
              conflicts: [],
              merged: false,
              commit: 'abcdef123456',
            },
            source: {
              sourceBranch: body.sourceBranch,
              targetBranch: body.targetBranch,
              sourceCommit: 'source-feature-commit',
              targetCommit: 'source-main-commit',
              baseCommit: 'source-base-commit',
              state: 'ready',
              changed: true,
              paths: ['src/index.ts'],
              conflicts: [],
              merged: true,
              commit: 'source-merged-commit',
            },
            canvasEnvelope: canvas,
          },
          versioning,
          source,
        })
      }
      if (options.merge === 'partial') {
        return response({
          ok: false,
          partial: true,
          sourceDegraded: true,
          error: {
            code: 'source_merge_conflict',
            message: 'canvas merged, but the source merge failed',
          },
          value: {
            state: 'partial',
            canvas: {
              sourceBranch: body.sourceBranch,
              targetBranch: body.targetBranch,
              sourceCommit: 'fedcba654321',
              targetCommit: 'abcdef123456',
              baseCommit: 'base123',
              state: 'ready',
              changed: true,
              paths: ['nodes/node-1.json'],
              conflicts: [],
              merged: true,
              commit: 'merged123',
            },
            source: null,
            canvasEnvelope: { ...canvas, revision: 3, lastCheckpoint: 'merged123' },
          },
          versioning,
          source,
        })
      }
      return response(success({
        state: 'merged',
        canvas: {
          sourceBranch: body.sourceBranch,
          targetBranch: body.targetBranch,
          sourceCommit: 'fedcba654321',
          targetCommit: 'abcdef123456',
          baseCommit: 'base123',
          state: 'ready',
          changed: true,
          paths: ['nodes/node-1.json'],
          conflicts: [],
          merged: true,
          commit: 'merged123',
        },
        source: null,
        canvasEnvelope: canvas,
      }, source))
    }
    if (url.pathname === '/canvas/source/bind') {
      return response(success({
        logicalBranch: 'main',
        gitBranch: 'ggai/main',
        worktreeId: 'source-1',
        worktreePath: '/workspace/.gg/source-worktrees/source-1',
        projectDir: '/workspace/.gg/source-worktrees/source-1/app',
        head: 'abcdef123456',
        dirty: false,
      }, source))
    }
    if (url.pathname === '/canvas/source/checkpoints') {
      const warnings = [
        'sensitive path: /workspace/.gg/source-worktrees/source-1/app/.env',
        'large file: data/huge.bin',
      ]
      const paths = [
        '/workspace/.gg/source-worktrees/source-1/app/.env',
        'data/huge.bin',
      ]
      if (options.sourceCheckpoint === 'sensitive' && body.allowSensitive !== true) {
        return response(success({
          changed: true,
          commit: 'abcdef123456',
          requiresConfirmation: true,
          warnings,
          paths,
        }, source))
      }
      return response(success({
        changed: true,
        commit: '12345678fedcba',
        requiresConfirmation: options.sourceCheckpoint === 'sensitive',
        warnings: options.sourceCheckpoint === 'sensitive' ? warnings : [],
        paths: options.sourceCheckpoint === 'sensitive' ? paths : ['src/index.ts'],
      }, source))
    }
    if (url.pathname === '/canvas/preferences' && method === 'PUT') {
      return response({ schemaVersion: 1, automationMode: body.automationMode })
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`)
  })
  return {
    client: new DaemonClient({ baseUrl: 'http://127.0.0.1:7380', fetch }),
    requests,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(ui: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<StrictMode>{ui}</StrictMode>))
  await act(async () => { await Promise.resolve() })
}

function button(label: string): HTMLButtonElement {
  const match = [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((candidate) => candidate.textContent?.includes(label))
  if (!match) throw new Error(`button not found: ${label}`)
  return match
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe('CanvasVersionManagerPanel', () => {
  it('creates a branch and restores a checkpoint only into a new branch', async () => {
    const { client, requests } = versionClient()
    const onSwitchBranch = vi.fn()
    await render(
      <CanvasVersionManagerPanel
        branch="main"
        canChangeBranch
        client={client}
        onSwitchBranch={onSwitchBranch}
      />,
    )

    expect(container?.textContent).toContain('ggai(canvas): node-created')
    const newBranchInput = container?.querySelector<HTMLInputElement>('[aria-label="新分支名称"]')
    await act(async () => {
      if (!newBranchInput) return
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(newBranchInput, 'experiment-a')
      newBranchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('新建').click())

    expect(onSwitchBranch).toHaveBeenCalledWith('experiment-a')
    expect(requests).toContainEqual(expect.objectContaining({
      path: '/canvas/branches',
      method: 'POST',
      body: expect.objectContaining({ name: 'experiment-a', fromBranch: 'main' }),
    }))

    await act(async () => button('恢复').click())
    const restoreInput = container?.querySelector<HTMLInputElement>('[aria-label="恢复到新分支"]')
    expect(restoreInput?.value).toBe('restore-abcdef12')
    await act(async () => button('恢复为新分支').click())

    expect(onSwitchBranch).toHaveBeenLastCalledWith('restore-abcdef12')
    const restoreRequest = requests.find(({ path }) => path === '/canvas/restores')
    expect(restoreRequest?.body).toMatchObject({
      sourceBranch: 'main',
      checkpoint: 'abcdef123456',
      newBranch: 'restore-abcdef12',
    })
  })

  it('requires explicit source binding and persists the automation policy', async () => {
    const { client, requests } = versionClient({ source: 'unbound' })
    await render(
      <CanvasVersionManagerPanel branch="main" canChangeBranch client={client} />,
    )

    expect(container?.textContent).toContain('不会自动创建分支或提交')
    await act(async () => button('显式绑定当前分支').click())

    const select = container?.querySelector<HTMLSelectElement>('[aria-label="源码提交模式"]')
    await act(async () => {
      if (!select) return
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      )?.set
      setter?.call(select, 'auto')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(requests).toContainEqual(expect.objectContaining({
      path: '/canvas/source/bind',
      method: 'POST',
      body: expect.objectContaining({ branch: 'main' }),
    }))
    expect(requests).toContainEqual(expect.objectContaining({
      path: '/canvas/preferences',
      method: 'PUT',
      body: expect.objectContaining({ automationMode: 'auto' }),
    }))
  })

  it('submits safe source changes after a non-sensitive preflight', async () => {
    const { client, requests } = versionClient({
      source: 'ready',
      sourceCheckpoint: 'safe',
    })
    await render(
      <CanvasVersionManagerPanel branch="main" canChangeBranch client={client} />,
    )

    expect(container?.textContent).toContain('源码工作树已隔离')
    await act(async () => {
      button('检查并提交源码变更').click()
      await Promise.resolve()
    })

    const checkpointRequests = requests.filter(({ path }) => path === '/canvas/source/checkpoints')
    expect(checkpointRequests).toHaveLength(1)
    expect(checkpointRequests[0]?.body).toMatchObject({
      branch: 'main',
      nodeTitle: '手动源码检查点',
      allowSensitive: false,
    })
    expect(container?.textContent).toContain('源码变更已提交（12345678）')
    expect(container?.textContent).not.toContain('确认风险并提交')
  })

  it('requires a second explicit confirmation for sensitive changes in auto mode', async () => {
    const { client, requests } = versionClient({
      source: 'ready',
      sourceCheckpoint: 'sensitive',
      automation: 'auto',
    })
    await render(
      <CanvasVersionManagerPanel branch="main" canChangeBranch client={client} />,
    )

    expect(container?.querySelector<HTMLSelectElement>('[aria-label="源码提交模式"]')?.value)
      .toBe('auto')
    await act(async () => {
      button('检查并提交源码变更').click()
      await Promise.resolve()
    })

    const preflightRequests = requests.filter(({ path }) => path === '/canvas/source/checkpoints')
    expect(preflightRequests).toHaveLength(1)
    expect(preflightRequests[0]?.body.allowSensitive).toBe(false)
    expect(container?.textContent).toContain('敏感改动也不会自动提交')
    expect(container?.textContent).toContain('[路径已隐藏]/.env')
    expect(container?.textContent).toContain('data/huge.bin')
    expect(container?.textContent).not.toContain('/workspace')
    expect(container?.textContent).not.toContain('source-worktrees')

    await act(async () => {
      button('确认风险并提交').click()
      await Promise.resolve()
    })

    const checkpointRequests = requests.filter(({ path }) => path === '/canvas/source/checkpoints')
    expect(checkpointRequests).toHaveLength(2)
    expect(checkpointRequests[1]?.body.allowSensitive).toBe(true)
    expect(checkpointRequests[1]?.body.runId).toBe(checkpointRequests[0]?.body.runId)
    expect(container?.textContent).toContain('源码变更已提交（12345678）')
    expect(container?.textContent).not.toContain('确认风险并提交')
  })

  it('previews paths and requires an explicit second confirmation before merging', async () => {
    const { client, requests } = versionClient({ merge: 'ready' })
    const onMergeApplied = vi.fn()
    await render(
      <CanvasVersionManagerPanel
        branch="main"
        canChangeBranch
        client={client}
        onMergeApplied={onMergeApplied}
      />,
    )

    await act(async () => {
      button('合并').click()
      await Promise.resolve()
    })
    expect(container?.textContent).toContain('feature-a')
    expect(container?.textContent).toContain('nodes/node-1.json')
    const confirm = button('明确确认并合并')
    expect(confirm.disabled).toBe(true)
    const approval = container?.querySelector<HTMLInputElement>(
      '[aria-label="明确确认合并预览"]',
    )
    await act(async () => approval?.click())
    expect(confirm.disabled).toBe(false)
    await act(async () => {
      confirm.click()
      await Promise.resolve()
    })

    expect(requests).toContainEqual(expect.objectContaining({
      path: '/canvas/merges/preview',
      method: 'POST',
      body: expect.objectContaining({ sourceBranch: 'feature-a', targetBranch: 'main' }),
    }))
    expect(requests).toContainEqual(expect.objectContaining({
      path: '/canvas/merges',
      method: 'POST',
      body: expect.objectContaining({
        confirmed: true,
        expected: {
          canvas: {
            sourceCommit: 'fedcba654321',
            targetCommit: 'abcdef123456',
            sourceRevision: 4,
            targetRevision: 2,
          },
          source: null,
        },
      }),
    }))
    expect(onMergeApplied).toHaveBeenCalledOnce()
  })

  it('shows merge conflicts without offering an execution action', async () => {
    const { client, requests } = versionClient({ merge: 'conflicts' })
    await render(
      <CanvasVersionManagerPanel branch="main" canChangeBranch client={client} />,
    )

    await act(async () => {
      button('合并').click()
      await Promise.resolve()
    })

    expect(container?.textContent).toContain('内容冲突')
    expect(container?.textContent).toContain('不会在这里自动应用')
    expect([...container!.querySelectorAll('button')].some(
      (candidate) => candidate.textContent?.includes('明确确认并合并'),
    )).toBe(false)
    expect(requests.some(({ path }) => path === '/canvas/merges')).toBe(false)
  })

  it('refreshes the branch after a partial merge already changed the canvas', async () => {
    const { client } = versionClient({ source: 'ready', merge: 'partial' })
    const onMergeApplied = vi.fn()
    await render(
      <CanvasVersionManagerPanel
        branch="main"
        canChangeBranch
        client={client}
        onMergeApplied={onMergeApplied}
      />,
    )

    await act(async () => {
      button('合并').click()
      await Promise.resolve()
    })
    const approval = container?.querySelector<HTMLInputElement>(
      '[aria-label="明确确认合并预览"]',
    )
    await act(async () => approval?.click())
    await act(async () => {
      button('明确确认并合并').click()
      await Promise.resolve()
    })

    expect(onMergeApplied).toHaveBeenCalledOnce()
    expect(container?.textContent).toContain('部分操作已完成')
  })

  it('refreshes after source merged but the final canvas anchor failed', async () => {
    const { client } = versionClient({ source: 'ready', merge: 'partial-source' })
    const onMergeApplied = vi.fn()
    await render(
      <CanvasVersionManagerPanel
        branch="main"
        canChangeBranch
        client={client}
        onMergeApplied={onMergeApplied}
      />,
    )

    await act(async () => {
      button('合并').click()
      await Promise.resolve()
    })
    const approval = container?.querySelector<HTMLInputElement>(
      '[aria-label="明确确认合并预览"]',
    )
    await act(async () => approval?.click())
    await act(async () => {
      button('明确确认并合并').click()
      await Promise.resolve()
    })

    expect(onMergeApplied).toHaveBeenCalledOnce()
    expect(container?.textContent).toContain('部分操作已完成')
  })

  it('clears a stale merge approval and requires a fresh preview', async () => {
    const { client } = versionClient({ merge: 'stale' })
    await render(
      <CanvasVersionManagerPanel branch="main" canChangeBranch client={client} />,
    )

    await act(async () => {
      button('合并').click()
      await Promise.resolve()
    })
    const approval = container?.querySelector<HTMLInputElement>(
      '[aria-label="明确确认合并预览"]',
    )
    await act(async () => approval?.click())
    await act(async () => {
      button('明确确认并合并').click()
      await Promise.resolve()
    })

    expect(container?.textContent).toContain('请重新预览后再确认')
    expect(container?.querySelector('[aria-label="明确确认合并预览"]')).toBeNull()
    expect([...container!.querySelectorAll('button')].some(
      (candidate) => candidate.textContent?.includes('明确确认并合并'),
    )).toBe(false)
  })

  it('offers a non-destructive escape hatch for save conflicts', async () => {
    const { client } = versionClient()
    const preserve = vi.fn(async () => undefined)
    await render(
      <CanvasVersionManagerPanel
        branch="main"
        canChangeBranch={false}
        conflict
        client={client}
        onPreserveConflict={preserve}
      />,
    )

    expect(container?.textContent).toContain('当前改动未被覆盖')
    expect(button('保留为新分支').disabled).toBe(false)
    await act(async () => button('保留为新分支').click())

    expect(preserve).toHaveBeenCalledWith('conflict-copy')
  })
})
