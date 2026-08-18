import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ExternalLink, LocateFixed, Search } from 'lucide-react'
import { Link } from 'react-router'
import type { CanvasNode, CanvasTask } from '@/canvas/model'
import { deriveTaskStatus, type CanvasTaskRuntime } from '@/canvas/selectors'
import { getPlugin, nodeTypeIcon } from '@/plugins/types'

interface CanvasWorkbenchNodesProps {
  mode: 'search' | 'nodes'
  nodes: readonly CanvasNode[]
  tasks: readonly CanvasTask[]
  runtimeByTaskId: Readonly<Record<string, CanvasTaskRuntime>>
  selectedNode: CanvasNode | null
  onSelectNode: (node: CanvasNode) => void
  onUpdateTitle: (nodeId: string, title: string) => Promise<unknown>
  onReparent: (nodeId: string, parentId: string | null) => Promise<unknown>
  onReorder: (
    parentId: string | null,
    moves: Array<{ nodeId: string; orderKey: string }>,
  ) => Promise<unknown>
}

export default function CanvasWorkbenchNodes({
  mode,
  nodes,
  tasks,
  runtimeByTaskId,
  selectedNode,
  onSelectNode,
  onUpdateTitle,
  onReparent,
  onReorder,
}: CanvasWorkbenchNodesProps) {
  const [query, setQuery] = useState('')
  const [titleDraft, setTitleDraft] = useState(selectedNode?.title ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTitleDraft(selectedNode?.title ?? '')
    setError(null)
  }, [selectedNode?.id, selectedNode?.title])

  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  )
  const visibleNodes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return [...nodes]
      .filter((node) => {
        if (!normalized) return true
        const plugin = getPlugin(node.typeRef.id)
        const task = node.homeTaskId ? taskById.get(node.homeTaskId) : undefined
        return [node.title, node.typeRef.id, plugin.label, task?.title ?? '']
          .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalized))
      })
      .sort((left, right) => hierarchySortKey(left, nodes)
        .localeCompare(hierarchySortKey(right, nodes))
        || left.title.localeCompare(right.title, 'zh-CN'))
  }, [nodes, query, taskById])

  const saveTitle = async () => {
    if (!selectedNode) return
    const title = titleDraft.trim()
    if (!title || title === selectedNode.title || saving) return
    setSaving(true)
    setError(null)
    try {
      await onUpdateTitle(selectedNode.id, title)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '节点名称保存失败')
    } finally {
      setSaving(false)
    }
  }

  const parentCandidates = selectedNode
    ? nodes.filter((candidate) => canParentNode(candidate, selectedNode, nodes))
    : []
  const reorderSelected = async (direction: -1 | 1) => {
    if (!selectedNode) return
    const siblings = nodes.filter((node) => node.parentId === selectedNode.parentId)
      .sort((left, right) => left.orderKey.localeCompare(right.orderKey))
    const current = siblings.findIndex((node) => node.id === selectedNode.id)
    const target = current + direction
    if (current < 0 || target < 0 || target >= siblings.length) return
    const peer = siblings[target]!
    await onReorder(selectedNode.parentId, [{
      nodeId: selectedNode.id,
      orderKey: peer.orderKey,
    }, {
      nodeId: peer.id,
      orderKey: selectedNode.orderKey,
    }])
  }

  return (
    <div className="space-y-3">
      {mode === 'nodes' && (
        selectedNode
          ? (
              <section className="rounded-[12px] border border-gg-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] text-gg-muted">当前节点</p>
                    <p className="mt-0.5 truncate text-[12px] font-medium">
                      {getPlugin(selectedNode.typeRef.id).label}
                    </p>
                  </div>
                  <span className="rounded-full bg-gg-subtle px-2 py-1 text-[9.5px] text-gg-muted">
                    {selectedNode.artifactRefs.length} 个资源
                  </span>
                </div>
                <label className="mt-3 block text-[10.5px] text-gg-muted">
                  节点名称
                  <input
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveTitle()
                    }}
                    maxLength={160}
                    className="mt-1.5 h-9 w-full rounded-[9px] border border-gg-line bg-white px-2.5 text-[11.5px] text-gg-ink outline-none focus:border-gg-primary"
                  />
                </label>
                {error && <p role="alert" className="mt-2 text-[10.5px] text-red-700">{error}</p>}
                <label className="mt-3 block text-[10.5px] text-gg-muted">
                  父节点
                  <select
                    value={selectedNode.parentId ?? ''}
                    onChange={(event) => void onReparent(
                      selectedNode.id,
                      event.target.value || null,
                    )}
                    className="mt-1.5 h-9 w-full rounded-[9px] border border-gg-line bg-white px-2.5 text-[11px] text-gg-ink outline-none focus:border-gg-primary"
                  >
                    <option value="">画布根层</option>
                    {parentCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.title}</option>
                    ))}
                  </select>
                </label>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <Link
                    to="/node-studio"
                    className="inline-flex items-center gap-1 text-[10.5px] text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
                  >
                    编辑节点类型 <ExternalLink size={11} aria-hidden="true" />
                  </Link>
                  <span className="flex items-center gap-1">
                    <button type="button" aria-label="在同层上移" onClick={() => void reorderSelected(-1)} className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-gg-line text-gg-muted hover:bg-gg-subtle"><ArrowUp size={12} /></button>
                    <button type="button" aria-label="在同层下移" onClick={() => void reorderSelected(1)} className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-gg-line text-gg-muted hover:bg-gg-subtle"><ArrowDown size={12} /></button>
                    <button
                      type="button"
                      onClick={() => void saveTitle()}
                      disabled={!titleDraft.trim() || titleDraft.trim() === selectedNode.title || saving}
                      className="h-8 rounded-[8px] bg-gg-primary px-3 text-[10.5px] font-medium text-white outline-none disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-gg-primary/35"
                    >
                      {saving ? '保存中…' : '保存名称'}
                    </button>
                  </span>
                </div>
              </section>
            )
          : (
              <div className="rounded-[12px] border border-dashed border-gg-line px-3 py-4 text-center">
                <p className="text-[11px] font-medium text-gg-ink">选择一个节点开始编辑</p>
                <p className="mt-1 text-[10px] leading-4 text-gg-muted">
                  可从下方列表定位节点，再编辑实例名称、Skills 或节点类型。
                </p>
              </div>
            )
      )}

      <label className="flex h-9 items-center gap-2 rounded-[9px] border border-gg-line px-2.5 text-gg-muted focus-within:border-gg-primary">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">搜索画布节点</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、类型或所属任务…"
          autoFocus={mode === 'search'}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-gg-ink outline-none placeholder:text-gg-muted"
        />
      </label>

      <div className="flex items-center justify-between text-[9.5px] text-gg-muted">
        <span>{visibleNodes.length} / {nodes.length} 个节点</span>
        <span>点击后定位</span>
      </div>

      {nodes.length === 0 && (
        <p className="rounded-[12px] border border-dashed border-gg-line px-3 py-6 text-center text-[10.5px] text-gg-muted">
          当前画布还没有节点。可在画布空白处双击创建。
        </p>
      )}
      {nodes.length > 0 && visibleNodes.length === 0 && (
        <p className="rounded-[12px] border border-dashed border-gg-line px-3 py-6 text-center text-[10.5px] text-gg-muted">
          没有匹配的节点。
        </p>
      )}
      <div className="space-y-1" role="list" aria-label="画布节点">
        {visibleNodes.map((node) => {
          const plugin = getPlugin(node.typeRef.id)
          const Icon = nodeTypeIcon(plugin)
          const task = node.homeTaskId ? taskById.get(node.homeTaskId) : undefined
          const taskNodes = node.homeTaskId
            ? nodes.filter((candidate) => candidate.homeTaskId === node.homeTaskId)
            : []
          const status = node.homeTaskId
            ? deriveTaskStatus(runtimeByTaskId[node.homeTaskId], taskNodes)
            : null
          return (
            <button
              key={node.id}
              type="button"
              role="listitem"
              aria-current={selectedNode?.id === node.id ? 'true' : undefined}
              onClick={() => onSelectNode(node)}
              style={{ paddingLeft: 10 + nodeDepth(node, nodes) * 14 }}
              className={`flex w-full items-center gap-2.5 rounded-[10px] py-2 pr-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
                selectedNode?.id === node.id
                  ? 'bg-gg-subtle text-gg-primary'
                  : 'hover:bg-gg-subtle'
              }`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-gg-line bg-white text-gg-muted">
                <Icon size={14} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-gg-ink">{node.title}</span>
                <span className="mt-0.5 block truncate text-[9.5px] text-gg-muted">
                  {plugin.label}{task ? ` · ${task.title}` : ' · 独立节点'}
                  {node.parentId ? ` · 层级 ${nodeDepth(node, nodes)}` : ''}
                  {status ? ` · ${status.label}` : ''}
                </span>
              </span>
              <LocateFixed size={13} className="shrink-0 text-gg-muted" aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function nodeDepth(node: CanvasNode, nodes: readonly CanvasNode[]): number {
  const byId = new Map(nodes.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  let depth = 0
  let parentId = node.parentId
  while (parentId && depth < 32 && !seen.has(parentId)) {
    seen.add(parentId)
    depth += 1
    parentId = byId.get(parentId)?.parentId ?? null
  }
  return depth
}

function hierarchySortKey(node: CanvasNode, nodes: readonly CanvasNode[]): string {
  const byId = new Map(nodes.map((entry) => [entry.id, entry]))
  const parts = [`${node.orderKey}:${node.id}`]
  let parentId = node.parentId
  const seen = new Set<string>()
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    parts.unshift(`${parent.orderKey}:${parent.id}`)
    parentId = parent.parentId
  }
  return parts.join('/')
}

function canParentNode(
  candidate: CanvasNode,
  child: CanvasNode,
  nodes: readonly CanvasNode[],
): boolean {
  if (candidate.id === child.id) return false
  const definition = getPlugin(candidate.typeRef.id)
  if (!definition.containment.canHaveChildren) return false
  if (definition.containment.allowedChildTypes.length > 0
    && !definition.containment.allowedChildTypes.includes(child.typeRef.id)) return false
  const byId = new Map(nodes.map((entry) => [entry.id, entry]))
  let parentId = candidate.parentId
  while (parentId) {
    if (parentId === child.id) return false
    parentId = byId.get(parentId)?.parentId ?? null
  }
  return true
}
