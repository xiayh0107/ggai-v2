// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  SkillAssetApi,
  SkillAssetCatalogPayload,
} from '@/skills/client'
import type { SkillAssetSummary } from '@/skills/contracts'
import SkillResourceManager from './SkillResourceManager'

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

describe('SkillResourceManager', () => {
  it('shows workspace Skill assets, immutable revisions, and type bindings', async () => {
    const older = asset({ revision: 1, digest: 'a'.repeat(64) })
    const latest = asset({ revision: 2, digest: 'b'.repeat(64), totalBytes: 2_048 })
    const list = vi.fn<SkillAssetApi['list']>().mockResolvedValue(catalog({
      assets: [older, latest],
      typeBindings: [binding(latest)],
    }))
    await renderManager(skillApi({ list }))

    expect(list).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(container?.textContent).toContain('节点的专属任务能力')
    expect(container?.textContent).toContain('Image direction')
    expect(container?.textContent).toContain('@workspace/image-direction')
    expect(container?.textContent).toContain('修订 2')
    expect(container?.textContent).toContain('2 个不可变修订')
    expect(container?.textContent).toContain('1 类节点使用')
    expect(required<HTMLSelectElement>('select').value).toBe('image')
    expect(required<HTMLInputElement>('input[type="checkbox"]').checked).toBe(true)
    expect(button('保存默认绑定').disabled).toBe(true)
  })

  it('imports a new immutable revision from an explicit absolute directory', async () => {
    const current = asset()
    const imported = asset({ revision: 2, digest: 'c'.repeat(64), title: 'Image direction 2' })
    const api = skillApi({
      list: vi.fn<SkillAssetApi['list']>().mockResolvedValue(catalog({ assets: [current] })),
      import: vi.fn<SkillAssetApi['import']>().mockResolvedValue(imported),
    })
    await renderManager(api)

    act(() => button('安装 Skill').click())
    changeInput(labelInput('Skill 标识'), '@workspace/image-direction')
    changeInput(labelInput('来源目录'), '/Users/test/skills/image-direction')
    expect(document.body.textContent).toContain('将创建修订 2')

    await act(async () => {
      documentButton('移动并安装').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.import).toHaveBeenCalledWith({
      sourcePath: '/Users/test/skills/image-direction',
      skillId: '@workspace/image-direction',
      expectedRevision: 1,
      signal: expect.any(AbortSignal),
    })
    expect(container?.textContent).toContain('Image direction 2')
    expect(container?.textContent).toContain('修订 2')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('updates a Node type default binding with the exact selected revision', async () => {
    const available = asset()
    const updateTypeBindings = vi.fn<SkillAssetApi['updateTypeBindings']>()
      .mockResolvedValue({ ...binding(available), revision: 2 })
    const api = skillApi({
      list: vi.fn<SkillAssetApi['list']>().mockResolvedValue(catalog({
        assets: [available],
        typeBindings: [{
          schemaVersion: 1,
          nodeType: 'image',
          revision: 1,
          skills: [],
          updatedAt: '2026-08-11T12:00:00.000Z',
        }],
      })),
      updateTypeBindings,
    })
    await renderManager(api)

    act(() => required<HTMLInputElement>('input[type="checkbox"]').click())
    expect(button('保存默认绑定').disabled).toBe(false)
    await act(async () => {
      button('保存默认绑定').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(updateTypeBindings).toHaveBeenCalledWith({
      nodeType: 'image',
      expectedRevision: 1,
      skills: [{
        skillId: available.skillId,
        revision: available.revision,
        digest: available.digest,
      }],
      signal: expect.any(AbortSignal),
    })
    expect(button('保存默认绑定').disabled).toBe(true)
    expect(container?.textContent).toContain('绑定修订 2')
  })

  it('archives a Skill without removing its historical binding', async () => {
    const available = asset()
    const archive = vi.fn<SkillAssetApi['archive']>().mockResolvedValue(available.skillId)
    await renderManager(skillApi({
      list: vi.fn<SkillAssetApi['list']>().mockResolvedValue(catalog({
        assets: [available],
        typeBindings: [binding(available)],
      })),
      archive,
    }))

    act(() => required<HTMLButtonElement>('[aria-label="归档 Image direction"]').click())
    expect(document.body.textContent).toContain('现有节点绑定和历史运行不会被删除')
    await act(async () => {
      documentButton('归档 Skill').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(archive).toHaveBeenCalledWith(available.skillId, expect.any(AbortSignal))
    expect(container?.textContent).toContain('已归档')
    expect(container?.textContent).toContain('1 类节点使用')
  })
})

async function renderManager(api: SkillAssetApi): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<MemoryRouter><SkillResourceManager api={api} /></MemoryRouter>)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function skillApi(overrides: Partial<SkillAssetApi> = {}): SkillAssetApi {
  return {
    list: vi.fn<SkillAssetApi['list']>().mockResolvedValue(catalog()),
    import: vi.fn<SkillAssetApi['import']>(),
    archive: vi.fn<SkillAssetApi['archive']>(),
    updateTypeBindings: vi.fn<SkillAssetApi['updateTypeBindings']>(),
    ...overrides,
  }
}

function catalog(overrides: Partial<SkillAssetCatalogPayload> = {}): SkillAssetCatalogPayload {
  return { schemaVersion: 1, assets: [], typeBindings: [], ...overrides }
}

function asset(overrides: Partial<SkillAssetSummary> = {}): SkillAssetSummary {
  return {
    schemaVersion: 1,
    skillId: '@workspace/image-direction',
    revision: 1,
    digest: 'a'.repeat(64),
    title: 'Image direction',
    description: 'Direct the image Node.',
    entrypoint: 'SKILL.md',
    fileCount: 1,
    totalBytes: 42,
    importedAt: '2026-08-11T12:00:00.000Z',
    archived: false,
    ...overrides,
  }
}

function binding(skill: SkillAssetSummary) {
  return {
    schemaVersion: 1 as const,
    nodeType: 'image',
    revision: 1,
    skills: [{ skillId: skill.skillId, revision: skill.revision, digest: skill.digest }],
    updatedAt: '2026-08-11T12:00:00.000Z',
  }
}

function required<T extends Element = HTMLElement>(selector: string): T {
  const element = container?.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function button(label: string): HTMLButtonElement {
  const element = [...(container?.querySelectorAll('button') ?? [])]
    .find((candidate) => candidate.textContent?.trim().includes(label))
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`)
  return element
}

function documentButton(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim().includes(label))
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing document button ${label}`)
  return element
}

function labelInput(label: string): HTMLInputElement {
  const element = [...document.querySelectorAll('label')]
    .find((candidate) => candidate.textContent?.includes(label))
    ?.querySelector('input')
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input ${label}`)
  return element
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
