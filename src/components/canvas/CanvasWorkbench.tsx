import { useState, useSyncExternalStore } from 'react'
import {
  Boxes,
  FolderOpen,
  History,
  ListTree,
  Search,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCanvasState, useCanvasStore } from '@/canvas/hooks'
import { canvasNodeWorldFrame, type CanvasNode } from '@/canvas/model'
import {
  useOptionalCanvasWorkbenchController,
  type CanvasWorkbenchSection,
} from '@/canvas/workbenchController'
import {
  getPluginRegistryVersion,
  subscribePlugins,
} from '@/plugins/types'
import type { ProjectArtifactCatalogApi } from '@/resources/artifactCatalogClient'
import type { SkillAssetApi } from '@/skills/client'
import CanvasWorkbenchNodes from './CanvasWorkbenchNodes'
import CanvasWorkbenchResources from './CanvasWorkbenchResources'
import CanvasWorkbenchSkills from './CanvasWorkbenchSkills'

interface CanvasWorkbenchProps {
  projectId?: string
  artifactApi: ProjectArtifactCatalogApi
  skillApi: SkillAssetApi
  onOpenHistory: () => void
}

const SECTION_META: Record<CanvasWorkbenchSection, {
  label: string
  description: string
  icon: LucideIcon
}> = {
  search: {
    label: '搜索与定位',
    description: '查找节点并把它带回视野中心',
    icon: Search,
  },
  nodes: {
    label: '节点管理',
    description: '查看节点层级并编辑当前节点',
    icon: ListTree,
  },
  resources: {
    label: '生成内容',
    description: '查看当前项目可信的生成内容',
    icon: FolderOpen,
  },
  skills: {
    label: '节点 Skills',
    description: '浏览能力并绑定到当前节点',
    icon: WandSparkles,
  },
}

const SECTIONS = Object.keys(SECTION_META) as CanvasWorkbenchSection[]

export default function CanvasWorkbench({
  projectId,
  artifactApi,
  skillApi,
  onOpenHistory,
}: CanvasWorkbenchProps) {
  const store = useCanvasStore()
  const state = useCanvasState()
  const controller = useOptionalCanvasWorkbenchController()
  useSyncExternalStore(
    subscribePlugins,
    getPluginRegistryVersion,
    getPluginRegistryVersion,
  )
  const [localSection, setLocalSection] = useState<CanvasWorkbenchSection | null>(null)
  const section = controller?.section ?? localSection
  const setSection = (next: CanvasWorkbenchSection | null) => {
    if (!controller) {
      setLocalSection(next)
      return
    }
    if (next) controller.openSection(next)
    else controller.closeSection()
  }
  const sectionMeta = section ? SECTION_META[section] : null
  const selectedNode = selectedCanvasNode(state.document.nodes, state.view.selection)

  const selectAndLocate = (node: CanvasNode) => {
    const zoom = state.view.camera.zoom
    const frame = canvasNodeWorldFrame(state.document, node)
    const viewportWidth = Math.max(480, globalThis.innerWidth)
    const viewportHeight = Math.max(360, globalThis.innerHeight - 52)
    const availableLeft = section ? 400 : 72
    const centerX = availableLeft + (viewportWidth - availableLeft) / 2
    store.setSelection([{ kind: 'node', id: node.id }])
    store.setCamera({
      zoom,
      x: Math.round(centerX - (frame.x + frame.w / 2) * zoom),
      y: Math.round(viewportHeight / 2 - (frame.y + frame.h / 2) * zoom),
    })
  }

  return (
    <aside
      aria-label="画布工作台"
      data-canvas-side-panel
      data-no-drag
      className="pointer-events-none absolute bottom-4 left-4 top-4 z-[60] flex items-start gap-2"
    >
      <nav
        aria-label="画布工作台入口"
        className="pointer-events-auto flex w-12 flex-col items-center gap-1 rounded-[14px] border border-gg-line bg-white p-1.5 shadow-float"
      >
        <span
          title="画布工作台"
          className="mb-0.5 flex h-8 w-8 items-center justify-center text-gg-primary"
        >
          <Boxes size={17} aria-hidden="true" />
          <span className="sr-only">画布工作台</span>
        </span>
        {SECTIONS.map((item) => {
          const Icon = SECTION_META[item].icon
          const active = item === section
          return (
            <button
              key={item}
              type="button"
              aria-label={SECTION_META[item].label}
              aria-expanded={active}
              title={SECTION_META[item].label}
              onClick={() => controller
                ? controller.toggleSection(item)
                : setLocalSection(active ? null : item)}
              className={`flex h-9 w-9 items-center justify-center rounded-[9px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
                active
                  ? 'bg-gg-subtle text-gg-primary'
                  : 'text-gg-muted hover:bg-gg-subtle hover:text-gg-ink'
              }`}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          )
        })}
        <span aria-hidden="true" className="my-0.5 h-px w-6 bg-gg-line" />
        <button
          type="button"
          aria-label="历史记录"
          aria-haspopup="dialog"
          title="历史记录"
          onClick={() => {
            setSection(null)
            onOpenHistory()
          }}
          className="flex h-9 w-9 items-center justify-center rounded-[9px] text-gg-muted outline-none transition-colors hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <History size={16} aria-hidden="true" />
        </button>
      </nav>

      {section && sectionMeta && (
        <section
          aria-label={sectionMeta.label}
          className="pointer-events-auto flex max-h-full w-[min(348px,calc(100vw-5.5rem))] flex-col overflow-hidden rounded-[16px] border border-gg-line bg-white shadow-float"
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-gg-line px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-semibold text-gg-ink">{sectionMeta.label}</h2>
              <p className="mt-0.5 text-[10.5px] leading-4 text-gg-muted">
                {sectionMeta.description}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSection(null)}
              aria-label={`关闭${sectionMeta.label}`}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {(section === 'search' || section === 'nodes') && (
              <CanvasWorkbenchNodes
                mode={section}
                nodes={state.document.nodes}
                tasks={state.document.tasks}
                runtimeByTaskId={state.runtimeByTaskId}
                selectedNode={selectedNode}
                onSelectNode={selectAndLocate}
                onUpdateTitle={(nodeId, title) => store.dispatchCommand({
                  type: 'UpdateNodeContent',
                  nodeId,
                  patch: { title },
                })}
                onReparent={(nodeId, parentId) => store.dispatchCommand({
                  type: 'ReparentNodes',
                  nodeIds: [nodeId],
                  parentId,
                })}
                onReorder={(parentId, moves) => store.dispatchCommand({
                  type: 'ReorderChildren',
                  parentId,
                  moves,
                })}
              />
            )}
            {section === 'resources' && (
              <CanvasWorkbenchResources
                key={`${state.scope.projectDir}:${state.scope.branch}`}
                api={artifactApi}
                projectId={projectId}
                projectDir={state.scope.projectDir}
                branch={state.scope.branch}
              />
            )}
            {section === 'skills' && (
              <CanvasWorkbenchSkills
                api={skillApi}
                selectedNode={selectedNode}
                onSave={(nodeId, bindings) => store.dispatchCommand({
                  type: 'UpdateNodeSkillBindings',
                  nodeId,
                  bindings,
                })}
              />
            )}
          </div>
        </section>
      )}
    </aside>
  )
}

function selectedCanvasNode(
  nodes: readonly CanvasNode[],
  selection: readonly { kind: string; id: string }[],
): CanvasNode | null {
  if (selection.length !== 1 || selection[0]?.kind !== 'node') return null
  return nodes.find((node) => node.id === selection[0]?.id) ?? null
}
