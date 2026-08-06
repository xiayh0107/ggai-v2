import { ExternalLink, Grip, Maximize2 } from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { runArtifactUrl } from '@/agent/config'
import { loadArtifactProjectionV2 } from '@/agent/artifactProjectionV2'
import type { CanvasNodeV2 } from '@/canvas-v2/model'
import type { CanvasBoundsV2 } from '@/canvas-v2/selectors'
import {
  getPlugin,
  projectArtifactContentV2,
  type TrustedArtifactProjectionV2,
} from '@/plugins/types'
import CanvasV2EdgePort from './CanvasV2EdgePort'
import CanvasV2EntityMenu from './CanvasV2EntityMenu'

export interface CanvasV2NodeCardProps {
  node: CanvasNodeV2
  frame?: CanvasBoundsV2
  projectDir: string
  selected: boolean
  compact?: boolean
  tabIndex: number
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onDragStart: (event: PointerEvent<HTMLElement>, node: CanvasNodeV2) => void
  onResizeStart: (event: PointerEvent<HTMLButtonElement>, node: CanvasNodeV2) => void
  onPortActivate?: (node: CanvasNodeV2) => void
  connectionActive?: boolean
  onMenuAction?: (node: CanvasNodeV2, action: string) => void
  registerFocusable: (element: HTMLButtonElement | null) => void
}

export default function CanvasV2NodeCard({
  node,
  frame = node.frame,
  projectDir,
  selected,
  compact = false,
  tabIndex,
  onFocus,
  onKeyDown,
  onDragStart,
  onResizeStart,
  onPortActivate,
  connectionActive = false,
  onMenuAction,
  registerFocusable,
}: CanvasV2NodeCardProps) {
  const plugin = getPlugin(node.type)
  const Icon = plugin.icon
  const label = `${plugin.label}节点：${node.title || plugin.label}`

  return (
    <article
      role="group"
      aria-label={label}
      data-v2-entity="node"
      data-node-id={node.id}
      data-selected={selected ? 'true' : 'false'}
      className={`pointer-events-auto absolute overflow-hidden rounded-[16px] border bg-gg-node shadow-sm motion-reduce:transition-none ${
        selected
          ? 'border-[1.5px] border-gg-select shadow-float'
          : 'border-gg-line hover:border-[#C7D2E0]'
      }`}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: frame.h,
        zIndex: node.frame.z + 10,
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button, a, input, textarea, select, [data-no-drag]')) {
          return
        }
        onDragStart(event, node)
      }}
    >
      <header className="flex h-10 items-center gap-2 border-b border-gg-line px-3">
        <button
          ref={registerFocusable}
          type="button"
          data-focus-key={`node:${node.id}`}
          aria-pressed={selected}
          tabIndex={tabIndex}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => onDragStart(event, node)}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-[8px] text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 active:cursor-grabbing"
        >
          <Icon size={14} className="shrink-0 text-gg-muted" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-gg-ink">
            {node.title || plugin.label}
          </span>
          <Grip size={13} className="shrink-0 text-[#98A2B3]" aria-hidden="true" />
        </button>
        {onPortActivate && (
          <CanvasV2EdgePort
            label={connectionActive
              ? `取消从节点${node.title || plugin.label}的连接`
              : `从节点${node.title || plugin.label}开始或完成连接`}
            active={connectionActive}
            onActivate={() => onPortActivate(node)}
          />
        )}
        {onMenuAction && (
          <CanvasV2EntityMenu
            label={`${node.title || plugin.label}节点菜单`}
            items={[
              { id: 'duplicate', label: '复制节点' },
              ...(node.homeTaskId
                ? [{ id: 'detach-task', label: '移出任务' }]
                : []),
              ...(node.collectionId
                ? [{ id: 'remove-collection', label: '移出集合' }]
                : []),
              { id: 'delete', label: '删除节点', destructive: true },
            ]}
            onAction={(action) => onMenuAction(node, action)}
          />
        )}
      </header>

      <div className="h-[calc(100%-2.5rem)] overflow-hidden p-3">
        <CanvasV2NodeContent
          node={node}
          projectDir={projectDir}
          compact={compact}
        />
      </div>

      {selected && !compact && (
        <button
          type="button"
          aria-label={`调整${node.title || plugin.label}节点大小`}
          title="调整节点大小"
          data-node-resize={node.id}
          onPointerDown={(event) => {
            event.stopPropagation()
            onResizeStart(event, node)
          }}
          className="absolute bottom-1 right-1 flex h-6 w-6 cursor-nwse-resize items-end justify-end rounded-[7px] p-1 text-gg-select outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35 motion-reduce:transition-none"
        >
          <Maximize2 size={13} aria-hidden="true" />
        </button>
      )}
    </article>
  )
}

function CanvasV2NodeContent({
  node,
  projectDir,
  compact,
}: {
  node: CanvasNodeV2
  projectDir: string
  compact: boolean
}) {
  const plugin = getPlugin(node.type)
  const Icon = plugin.icon
  const primaryArtifact = node.artifactRefs[0]
  const artifactKey = primaryArtifact
    ? `${primaryArtifact.runId}:${primaryArtifact.artifactId}`
    : null
  const [artifactState, setArtifactState] = useState<{
    key: string
    status: 'resolved' | 'error'
    artifact?: TrustedArtifactProjectionV2
  } | null>(null)

  useEffect(() => {
    if (!artifactKey || !primaryArtifact || !plugin.projectArtifact || !plugin.views.Artifact) return
    const abort = new AbortController()
    void loadArtifactProjectionV2({
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
  const projectedContent = useMemo(() => {
    if (!resolvedArtifact) return null
    try {
      return projectArtifactContentV2(plugin, resolvedArtifact)
    } catch {
      return null
    }
  }, [plugin, resolvedArtifact])
  const ArtifactView = plugin.views.Artifact

  if (compact) {
    return (
      <div className="flex h-full items-center justify-center gap-2 rounded-[10px] bg-gg-subtle text-[11px] text-gg-muted">
        <Icon size={18} strokeWidth={1.5} />
        <span>{node.artifactRefs.length > 0 ? `${node.artifactRefs.length} 个产物` : '内容节点'}</span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      {resolvedArtifact && projectedContent && ArtifactView ? (
        <div className="min-h-0 flex-1">
          <ArtifactView artifact={resolvedArtifact} content={projectedContent} />
        </div>
      ) : primaryArtifact && plugin.projectArtifact && ArtifactView
        && artifactState?.key !== artifactKey ? (
          <div
            role="status"
            className="flex min-h-0 flex-1 items-center justify-center rounded-[10px] bg-gg-subtle text-[11px] text-gg-muted"
          >
            正在验证产物…
          </div>
      ) : node.text ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[10px] bg-gg-subtle p-3 text-[11.5px] leading-5 text-gg-ink">
          {node.text}
        </pre>
      ) : node.payload && Object.keys(node.payload).length > 0 ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[10px] bg-gg-subtle p-3 font-mono text-[10.5px] leading-5 text-gg-muted">
          {JSON.stringify(node.payload, null, 2)}
        </pre>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-[10px] bg-gg-subtle text-gg-muted">
          <Icon size={26} strokeWidth={1.35} />
          <span className="text-[11px]">等待内容</span>
        </div>
      )}

      {node.artifactRefs.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5" aria-label="运行产物">
          {node.artifactRefs.map((artifact, index) => (
            <a
              key={`${artifact.runId}:${artifact.artifactId}`}
              href={runArtifactUrl(artifact.runId, artifact.artifactId, projectDir)}
              target="_blank"
              rel="noreferrer"
              data-no-drag
              onPointerDown={(event) => event.stopPropagation()}
              className="flex max-w-full items-center gap-1 rounded-[7px] bg-gg-subtle px-2 py-1 text-[10px] text-gg-primary outline-none hover:bg-[#EAF1FD] focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              <ExternalLink size={10} aria-hidden="true" />
              <span className="truncate">产物 {index + 1}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
