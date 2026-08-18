import {
  Copy,
  CopyPlus,
  ExternalLink,
  Eye,
  FolderMinus,
  Loader2,
  LogOut,
  MessageSquarePlus,
  PackageX,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { runArtifactUrl } from '@/agent/config'
import { loadArtifactProjection } from '@/agent/artifactProjection'
import { nodeHasVisibleContent } from '@/canvas/contextComposer'
import type { CanvasNode } from '@/canvas/model'
import type { CanvasBounds, CanvasTaskStatus } from '@/canvas/selectors'
import {
  artifactViewerKindForMediaType,
  useOpenCanvasArtifactViewer,
} from '@/canvas/artifactViewerContext'
import {
  getPlugin,
  NodeTypeIconView,
  nodeTypeIcon,
  nodeTypeIsEmpty,
  type NodeTypeDefinition,
  type TrustedArtifactProjection,
} from '@/plugins/types'
import NodeArtifactTemplateView from '@/plugins/NodeArtifactTemplateView'
import NodeTemplateView from '@/plugins/NodeTemplateView'
import { type CanvasMenuItem } from './CanvasEntityMenu'
import CanvasNodeActivityStrip from './CanvasNodeActivity'
import CanvasNodeShell from './CanvasNodeShell'

/** 节点右上角水平图标条的动作图标：与旧版 ⋯ 菜单同一套动作 id。 */
const NODE_ACTION_ICONS: Record<string, LucideIcon> = {
  'task:continue': MessageSquarePlus,
  'task:duplicate': CopyPlus,
  'task:delete': PackageX,
  duplicate: Copy,
  'detach-task': LogOut,
  'remove-collection': FolderMinus,
  delete: Trash2,
}

export interface CanvasNodeCardProps {
  node: CanvasNode
  /** Node Studio preview only; production cards always resolve the registered plugin. */
  pluginOverride?: NodeTypeDefinition
  frame?: CanvasBounds
  projectDir: string
  selected: boolean
  compoundSelected?: boolean
  compact?: boolean
  /** 所属任务的当前状态与运行 id，用于节点底部的 Agent 活动记录条。 */
  taskStatus?: CanvasTaskStatus
  taskRunId?: string
  /**
   * 父 Task 正在运行，或该节点仍是父 Task 的空输出槽时，结构操作必须锁定。
   * 这不是 disabled chrome：直接不渲染，避免复制 / 移出 / 删除破坏运行归属。
   */
  controlsLocked?: boolean
  /**
   * 追加到节点图标条开头的额外项（如单产物任务隐藏标题条后并入的任务操作）。
   * 以 `task:` 开头的 id 由调用方路由回任务级处理器。
   */
  extraMenuItems?: CanvasMenuItem[]
  tabIndex: number
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onDragStart: (event: PointerEvent<HTMLElement>, node: CanvasNode) => void
  onResizeStart: (event: PointerEvent<HTMLButtonElement>, node: CanvasNode) => void
  onMenuAction?: (node: CanvasNode, action: string) => void
  registerFocusable: (element: HTMLButtonElement | null) => void
}

export default function CanvasNodeCard({
  node,
  pluginOverride,
  frame = node.frame,
  projectDir,
  selected,
  compoundSelected = false,
  compact = false,
  taskStatus,
  taskRunId,
  controlsLocked = false,
  extraMenuItems,
  tabIndex,
  onFocus,
  onKeyDown,
  onDragStart,
  onResizeStart,
  onMenuAction,
  registerFocusable,
}: CanvasNodeCardProps) {
  const plugin = pluginOverride ?? getPlugin(node.type)
  const Icon = nodeTypeIcon(plugin)
  const label = `${plugin.label}节点：${node.title || plugin.label}`
  const showActivityStrip = !compact && (
    node.origin.kind === 'agent-output'
    || Boolean(node.homeTaskId && taskRunId && !nodeHasVisibleContent(node))
  )
  const actionItems: CanvasMenuItem[] = controlsLocked
    ? []
    : [
        ...(extraMenuItems ?? []),
        { id: 'duplicate', label: '复制节点' },
        ...(node.homeTaskId
          ? [{ id: 'detach-task', label: '移出任务' }]
          : []),
        ...(node.collectionId
          ? [{ id: 'remove-collection', label: '移出集合' }]
          : []),
        { id: 'delete', label: '从画布移除', destructive: true },
      ]

  const actions = onMenuAction && actionItems.length > 0 ? (
    <div
      role="group"
      aria-label={`${node.title || plugin.label}节点操作`}
      className={`absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-[8px] bg-gg-node/95 p-0.5 ${
        selected
          ? ''
          : 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none'
      }`}
    >
      {actionItems.map((item) => {
        const ActionIcon = NODE_ACTION_ICONS[item.id]
        if (!ActionIcon) return null
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            data-node-action={item.id}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onMenuAction(node, item.id)}
            className={`flex h-6 w-6 items-center justify-center rounded-[7px] outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
              item.destructive
                ? 'text-gg-muted hover:bg-gg-subtle hover:text-gg-danger'
                : 'text-gg-muted hover:bg-gg-subtle hover:text-gg-ink'
            }`}
          >
            <ActionIcon size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )
      })}
    </div>
  ) : undefined
  const resizeHandle = selected && !compoundSelected && !compact ? (
    <button
      type="button"
      aria-label={`调整${node.title || plugin.label}节点大小`}
      title="调整节点大小"
      data-node-resize={node.id}
      onPointerDown={(event) => {
        event.stopPropagation()
        onResizeStart(event, node)
      }}
      className="absolute bottom-1 right-1 h-3.5 w-3.5 cursor-nwse-resize rounded-[4px] border-[1.5px] border-gg-select bg-white outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
    />
  ) : undefined

  return (
    <CanvasNodeShell
      role="group"
      aria-label={label}
      data-canvas-entity="node"
      data-node-id={node.id}
      data-selected={selected ? 'true' : 'false'}
      data-compound-selected={compoundSelected ? 'true' : 'false'}
      frame={frame}
      zIndex={node.frame.z + 10}
      pointerEvents="auto"
      selected={selected}
      compoundSelected={compoundSelected}
      icon={Icon}
      title={node.title || plugin.label}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button, a, input, textarea, select, [data-no-drag]')) {
          return
        }
        onDragStart(event, node)
      }}
      headerButtonRef={registerFocusable}
      headerButton={{
        pressed: selected,
        tabIndex,
        focusKey: `node:${node.id}`,
        onFocus,
        onKeyDown,
        onPointerDown: (event) => onDragStart(event, node),
      }}
      actions={actions}
      footer={showActivityStrip ? (
        <CanvasNodeActivityStrip
          node={node}
          taskStatus={taskStatus}
          taskRunId={taskRunId}
        />
      ) : undefined}
      overlay={resizeHandle}
    >
      <CanvasNodeContent
        node={node}
        plugin={plugin}
        projectDir={projectDir}
        compact={compact}
        taskStatus={taskStatus}
      />
    </CanvasNodeShell>
  )
}

function CanvasNodeContent({
  node,
  plugin,
  projectDir,
  compact,
  taskStatus,
}: {
  node: CanvasNode
  plugin: NodeTypeDefinition
  projectDir: string
  compact: boolean
  taskStatus?: CanvasTaskStatus
}) {
  const generating = taskStatus?.kind === 'queued' || taskStatus?.kind === 'generating'
  const primaryArtifact = node.artifactRefs[0]
  const artifactKey = primaryArtifact
    ? `${primaryArtifact.runId}:${primaryArtifact.artifactId}`
    : null
  const [artifactState, setArtifactState] = useState<{
    key: string
    status: 'resolved' | 'error'
    artifact?: TrustedArtifactProjection
  } | null>(null)

  useEffect(() => {
    if (!artifactKey || !primaryArtifact) return
    const abort = new AbortController()
    void loadArtifactProjection({
      runId: primaryArtifact.runId,
      artifactId: primaryArtifact.artifactId,
      projectDir,
      title: node.title || plugin.label,
      signal: abort.signal,
    }).then(
      (artifact) => setArtifactState({ key: artifactKey, status: 'resolved', artifact }),
      (error: unknown) => {
        if (abort.signal.aborted) return
        void error
        setArtifactState({ key: artifactKey, status: 'error' })
      },
    )
    return () => abort.abort()
  }, [artifactKey, node.title, plugin, primaryArtifact, projectDir])

  const resolvedArtifact = artifactState?.key === artifactKey
    && artifactState.status === 'resolved'
    ? artifactState.artifact
    : undefined
  const projectedContent = useMemo(() => resolvedArtifact
    ? { title: node.title || resolvedArtifact.title }
    : null, [node.title, resolvedArtifact])
  // 主产物已内联渲染且只有一个产物时，不再重复显示「产物 1」链接条
  // （内联视图自带「打开产物」入口）。
  const inlineRendered = Boolean(resolvedArtifact && projectedContent)

  if (compact) {
    return (
      <div className="flex h-full items-center justify-center gap-2 rounded-[10px] bg-gg-subtle text-[11px] text-gg-muted">
        <NodeTypeIconView definition={plugin} size={18} strokeWidth={1.5} />
        <span>{node.artifactRefs.length > 0 ? `${node.artifactRefs.length} 个产物` : '内容节点'}</span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      {resolvedArtifact && projectedContent ? (
        <div className="min-h-0 flex-1">
          <NodeArtifactTemplateView
            artifact={resolvedArtifact}
            content={projectedContent}
            node={node}
            template={plugin.ui.template}
          />
        </div>
      ) : primaryArtifact && artifactState?.key !== artifactKey ? (
          <CanvasGeneratingSurface label="正在验证生成内容" />
      ) : !nodeTypeIsEmpty(plugin, node) ? (
        <div className="min-h-0 flex-1">
          <NodeTemplateView node={node} template={plugin.ui.template} />
        </div>
      ) : generating ? (
        <CanvasGeneratingSurface label="正在生成内容" />
      ) : (
        <div
          data-testid="canvas-empty-surface"
          aria-label="空白内容区"
          className="min-h-0 flex-1"
        />
      )}

      {node.artifactRefs.length > 0
        && !(inlineRendered && node.artifactRefs.length === 1) && (
        <CanvasArtifactRefLinks node={node} projectDir={projectDir} />
      )}
    </div>
  )
}

export function CanvasGeneratingSurface({ label }: { label: string }) {
  return (
    <div
      aria-label={label}
      data-testid="canvas-generating-surface"
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
    >
      <span className="sr-only">{label}</span>
      <span className="grid grid-cols-3 gap-3" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => (
          <span
            key={index}
            className="h-1.5 w-1.5 rounded-full bg-gg-primary/55 motion-safe:animate-pulse"
            style={{ animationDelay: `${index * 110}ms` }}
          />
        ))}
      </span>
    </div>
  )
}

/**
 * 多产物节点的产物链接条：优先在画布内查看面板打开（点击时才按 ref 加载
 * manifest 元数据），无查看面板 Provider 时退回新标签页外链。
 */
function CanvasArtifactRefLinks({
  node,
  projectDir,
}: {
  node: CanvasNode
  projectDir: string
}) {
  const plugin = getPlugin(node.type)
  const openViewer = useOpenCanvasArtifactViewer()
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const openInViewer = async (runId: string, artifactId: string, index: number) => {
    if (!openViewer || pendingKey) return
    const key = `${runId}:${artifactId}`
    const title = `${node.title || plugin.label} · 产物 ${index + 1}`
    setPendingKey(key)
    try {
      const artifact = await loadArtifactProjection({
        runId,
        artifactId,
        projectDir,
        title,
      })
      if (!aliveRef.current) return
      openViewer({
        artifact,
        kind: artifactViewerKindForMediaType(artifact.mediaType),
        title,
        nodeId: node.id,
      })
    } catch {
      // 元数据读取失败时退回新标签页，不让产物打不开
      window.open(runArtifactUrl(runId, artifactId, projectDir), '_blank', 'noreferrer')
    } finally {
      if (aliveRef.current) setPendingKey(null)
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1" aria-label="运行产物">
      {node.artifactRefs.map((artifact, index) => {
        const key = `${artifact.runId}:${artifact.artifactId}`
        const pending = pendingKey === key
        if (!openViewer) {
          return (
            <a
              key={key}
              href={runArtifactUrl(artifact.runId, artifact.artifactId, projectDir)}
              target="_blank"
              rel="noreferrer"
              data-no-drag
              onPointerDown={(event) => event.stopPropagation()}
              className="flex max-w-full items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10px] text-gg-primary outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              <ExternalLink size={10} aria-hidden="true" />
              <span className="truncate">产物 {index + 1}</span>
            </a>
          )
        }
        return (
          <button
            key={key}
            type="button"
            data-no-drag
            disabled={pending}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void openInViewer(artifact.runId, artifact.artifactId, index)}
            className="flex max-w-full items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10px] text-gg-primary outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:opacity-60"
          >
            {pending ? (
              <Loader2 size={10} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <Eye size={10} aria-hidden="true" />
            )}
            <span className="truncate">产物 {index + 1}</span>
          </button>
        )
      })}
    </div>
  )
}
