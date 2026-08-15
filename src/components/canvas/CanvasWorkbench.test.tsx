// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyCanvasCommand, type CanvasCommand } from '@/canvas/commands'
import { CanvasContext } from '@/canvas/hooks'
import { emptyCanvasDocument } from '@/canvas/model'
import type { CanvasSelectionTarget } from '@/canvas/persistence'
import {
  defaultCanvasViewState,
  type CanvasStore,
  type CanvasStoreState,
} from '@/canvas/store'
import type {
  ProjectArtifactCatalogApi,
  ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'
import type { SkillAssetApi, SkillAssetCatalogPayload } from '@/skills/client'
import CanvasWorkbench from './CanvasWorkbench'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  act(() => root?.unmount())
  await act(async () => Promise.resolve())
  root = null
  container?.remove()
  container = null
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

class FakeStore {
  readonly listeners = new Set<() => void>()
  state: CanvasStoreState = {
    scope: { projectDir: '/workspace/project-one', branch: 'main' },
    hydration: { status: 'ready', error: null },
    commandSync: { status: 'idle', pendingCount: 0, error: null, conflict: null },
    viewSync: { status: 'idle', error: null },
    envelope: null,
    document: {
      ...emptyCanvasDocument(),
      everCreated: true,
      tasks: [{
        id: 'task-image',
        title: '制作封面',
        goal: '生成封面图',
        anchor: { x: 260, y: 180 },
        origin: { kind: 'user' },
      }],
      nodes: [{
        id: 'node-image',
        type: 'image',
        frame: { x: 800, y: 500, w: 360, h: 300, z: 4 },
        title: '海边封面',
        artifactRefs: [],
        homeTaskId: 'task-image',
        origin: { kind: 'user' },
      }, {
        id: 'node-notes',
        type: 'text',
        frame: { x: 160, y: 120, w: 300, h: 220, z: 2 },
        title: '项目说明',
        text: '背景信息',
        artifactRefs: [],
        origin: { kind: 'user' },
      }],
    },
    view: defaultCanvasViewState(),
    runtimeByTaskId: {},
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.state

  setSelection(selection: CanvasSelectionTarget[]): void {
    this.state = { ...this.state, view: { ...this.state.view, selection } }
    this.emit()
  }

  setCamera(camera: CanvasStoreState['view']['camera']): void {
    this.state = { ...this.state, view: { ...this.state.view, camera } }
    this.emit()
  }

  async dispatchCommand(command: CanvasCommand): Promise<{ mutationId: string }> {
    this.state = {
      ...this.state,
      document: applyCanvasCommand(this.state.document, command),
    }
    this.emit()
    return { mutationId: 'workbench-command' }
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }
}

describe('CanvasWorkbench', () => {
  it('keeps the canvas toolbar focused on project management and locates search results', async () => {
    const store = new FakeStore()
    renderWorkbench(store)

    expect(button('搜索与定位')).toBeDefined()
    expect(button('节点管理')).toBeDefined()
    expect(button('生成内容')).toBeDefined()
    expect(button('历史记录')).toBeDefined()
    expect(button('节点 Skills')).toBeDefined()
    expect(buttonOptional('新建节点')).toBeNull()
    expect(buttonOptional('连线')).toBeNull()

    await click(button('搜索与定位'))
    const search = required<HTMLInputElement>('input[placeholder="搜索名称、类型或所属任务…"]')
    await changeInput(search, '海边')
    expect(container?.textContent).toContain('海边封面')
    expect(container?.textContent).not.toContain('项目说明')

    await click(buttonWithText('海边封面'))
    expect(store.state.view.selection).toEqual([{ kind: 'node', id: 'node-image' }])
    expect(store.state.view.camera).not.toEqual(defaultCanvasViewState().camera)
  })

  it('edits the selected Node instance without exposing raw payload controls', async () => {
    const store = new FakeStore()
    store.setSelection([{ kind: 'node', id: 'node-notes' }])
    renderWorkbench(store)
    await click(button('节点管理'))

    const title = required<HTMLInputElement>('input[maxlength="160"]')
    await changeInput(title, '重新命名的说明')
    await click(buttonWithText('保存名称'))

    expect(store.state.document.nodes.find((node) => node.id === 'node-notes')?.title)
      .toBe('重新命名的说明')
    expect(container?.textContent).not.toContain('payload')
    expect(container?.querySelector('textarea')).toBeNull()
  })

  it('reads trusted project resources in the current branch and links to the full library', async () => {
    const artifact = artifactFixture()
    const artifactApi: ProjectArtifactCatalogApi = {
      list: vi.fn(async () => ({
        schemaVersion: 2 as const,
        artifacts: [artifact],
        partial: false,
        truncated: false,
        nextCursor: null,
      })),
      artifactUrl: (_projectDir, item) => `http://daemon.test/${item.runId}/${item.artifactId}`,
    }
    const store = new FakeStore()
    renderWorkbench(store, { artifactApi })
    await click(button('生成内容'))
    await act(async () => {
      await vi.waitFor(() => expect(container?.textContent).toContain('cover.png'))
    })

    expect(artifactApi.list).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: '/workspace/project-one',
      branch: 'main',
      limit: 24,
    }))
    const libraryLink = required<HTMLAnchorElement>('a[href^="/resources/generated?"]')
    expect(libraryLink.getAttribute('href')).toContain('project=project_11111111111111111111111111111111')
    expect(libraryLink.getAttribute('href')).toContain('branch=main')
  })

  it('saves an explicit Skill binding on the selected Node', async () => {
    const store = new FakeStore()
    store.setSelection([{ kind: 'node', id: 'node-image' }])
    const skillApi = skillApiFixture()
    renderWorkbench(store, { skillApi })
    await click(button('节点 Skills'))
    await act(async () => {
      await vi.waitFor(() => expect(container?.textContent).toContain('摄影构图'))
    })

    await click(buttonWithText('摄影构图'))
    await click(buttonWithText('保存节点 Skills'))

    expect(store.state.document.nodes.find((node) => node.id === 'node-image')?.skillBindings)
      .toEqual({
        inheritType: true,
        skills: [{
          skillId: '@workspace/composition',
          revision: 3,
          digest: 'a'.repeat(64),
        }],
      })
  })

  it('opens version history from the left workbench instead of canvas chrome', async () => {
    const store = new FakeStore()
    const onOpenHistory = vi.fn()
    renderWorkbench(store, { onOpenHistory })

    await click(button('历史记录'))

    expect(onOpenHistory).toHaveBeenCalledOnce()
  })
})

function renderWorkbench(
  fakeStore: FakeStore,
  overrides: {
    artifactApi?: ProjectArtifactCatalogApi
    skillApi?: SkillAssetApi
    onOpenHistory?: () => void
  } = {},
): void {
  const artifactApi = overrides.artifactApi ?? emptyArtifactApi()
  const skillApi = overrides.skillApi ?? emptySkillApi()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <MemoryRouter>
        <CanvasContext.Provider value={fakeStore as unknown as CanvasStore}>
          <CanvasWorkbench
            projectId="project_11111111111111111111111111111111"
            artifactApi={artifactApi}
            skillApi={skillApi}
            onOpenHistory={overrides.onOpenHistory ?? (() => undefined)}
          />
        </CanvasContext.Provider>
      </MemoryRouter>,
    )
  })
}

function emptyArtifactApi(): ProjectArtifactCatalogApi {
  return {
    list: async () => ({
      schemaVersion: 2,
      artifacts: [],
      partial: false,
      truncated: false,
      nextCursor: null,
    }),
    artifactUrl: () => 'http://daemon.test/artifact',
  }
}

function emptySkillApi(): SkillAssetApi {
  return {
    list: async () => ({ schemaVersion: 1, assets: [], typeBindings: [] }),
    import: async () => { throw new Error('not implemented') },
    archive: async () => { throw new Error('not implemented') },
    updateTypeBindings: async () => { throw new Error('not implemented') },
  }
}

function skillApiFixture(): SkillAssetApi {
  const catalog: SkillAssetCatalogPayload = {
    schemaVersion: 1,
    assets: [{
      schemaVersion: 1,
      skillId: '@workspace/composition',
      revision: 3,
      digest: 'a'.repeat(64),
      title: '摄影构图',
      description: '帮助图像节点建立画面层次',
      entrypoint: 'SKILL.md',
      fileCount: 2,
      totalBytes: 512,
      importedAt: '2026-08-11T00:00:00.000Z',
      archived: false,
    }],
    typeBindings: [],
  }
  return {
    list: async () => catalog,
    import: async () => { throw new Error('not implemented') },
    archive: async () => { throw new Error('not implemented') },
    updateTypeBindings: async () => { throw new Error('not implemented') },
  }
}

function artifactFixture(): ProjectArtifactResource {
  return {
    runId: 'run-cover',
    artifactId: 'sha256:' + 'b'.repeat(64),
    taskId: 'task-image',
    canvasBranch: 'main',
    relativePath: 'images/cover.png',
    mediaType: 'image/png',
    size: 1_024,
    contentDigest: 'c'.repeat(64),
    createdAt: Date.parse('2026-08-11T00:00:00.000Z'),
  }
}

function required<ElementType extends Element>(selector: string): ElementType {
  const result = container?.querySelector<ElementType>(selector)
  if (!result) throw new Error(`Missing ${selector}`)
  return result
}

function button(name: string): HTMLButtonElement {
  const result = buttonOptional(name)
  if (!result) throw new Error(`Missing button ${name}`)
  return result
}

function buttonOptional(name: string): HTMLButtonElement | null {
  return [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((entry) => entry.getAttribute('aria-label') === name || entry.textContent?.trim() === name)
    ?? null
}

function buttonWithText(text: string): HTMLButtonElement {
  const result = [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((entry) => entry.textContent?.includes(text))
  if (!result) throw new Error(`Missing button containing ${text}`)
  return result
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}
