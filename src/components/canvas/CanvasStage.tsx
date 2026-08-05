import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, MessageSquarePlus, Plus, Trash2 } from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'
import type { CanvasNode, PortSide } from '@/types/canvas'
import NodeCard from './NodeCard'
import EdgeLayer, { autoSides, path, portPos } from './EdgeLayer'
import FloatingToolbar from './FloatingToolbar'
import InstructionPanel from './InstructionPanel'
import CreateMenu from './CreateMenu'
import EmptyState from './EmptyState'
import ZoomMinimap from './ZoomMinimap'

type Drag =
  | { kind: 'pan'; startX: number; startY: number; camX: number; camY: number }
  | { kind: 'node'; id: string; startX: number; startY: number; origX: number; origY: number }
  | { kind: 'resize'; id: string; startX: number; origW: number }
  | { kind: 'connect'; fromId: string; side: PortSide }
  | { kind: 'box'; startX: number; startY: number }

/** 框选矩形（世界坐标） */
interface BoxRect { x1: number; y1: number; x2: number; y2: number }

export default function CanvasStage() {
  const store = useCanvas()
  const {
    nodes, edges, camera, selectedId, selectedIds, connecting, createMenu, everCreated,
    setCamera, zoomTo, select, selectMany, toggleSelect, updateNode, removeNode, duplicateNode,
    addEdge, setConnecting, openCreateMenu, updateInstruction,
  } = store
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [boxRect, setBoxRect] = useState<BoxRect | null>(null)

  const toWorld = useCallback((sx: number, sy: number) => ({
    x: (sx - camera.x) / camera.zoom,
    y: (sy - camera.y) / camera.zoom,
  }), [camera])

  /* ---------- 滚轮缩放（以光标为中心） ---------- */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.92 : 1.09
      zoomTo(camera.zoom * factor, e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [camera.zoom, zoomTo])

  /* ---------- 键盘：删除 / 取消选择 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]')) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        selectedIds.forEach((id) => removeNode(id))
      }
      if (e.key === 'Escape') { select(null); setConnecting(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, removeNode, select, setConnecting])

  /* ---------- 拖拽主循环 ---------- */
  const startWindowDrag = useCallback((drag: Drag) => {
    dragRef.current = drag
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const cam = store.camera
      if (d.kind === 'pan') {
        setCamera({ x: d.camX + (e.clientX - d.startX), y: d.camY + (e.clientY - d.startY), zoom: cam.zoom })
      } else if (d.kind === 'node') {
        updateNode(d.id, {
          x: d.origX + (e.clientX - d.startX) / cam.zoom,
          y: d.origY + (e.clientY - d.startY) / cam.zoom,
        })
      } else if (d.kind === 'resize') {
        const w = Math.min(560, Math.max(220, d.origW + (e.clientX - d.startX) / cam.zoom))
        updateNode(d.id, { w })
      } else if (d.kind === 'connect') {
        setConnecting({ fromId: d.fromId, side: d.side, sx: e.clientX, sy: e.clientY })
      } else if (d.kind === 'box') {
        const w1 = (d.startX - cam.x) / cam.zoom
        const h1 = (d.startY - cam.y) / cam.zoom
        const w2 = (e.clientX - cam.x) / cam.zoom
        const h2 = (e.clientY - cam.y) / cam.zoom
        setBoxRect({ x1: Math.min(w1, w2), y1: Math.min(h1, h2), x2: Math.max(w1, w2), y2: Math.max(h1, h2) })
      }
    }
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (d?.kind === 'node'
        && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) {
        // 原地点击（非拖拽）选中节点：直接弹出指令面板，便于连续提示；
        // 生成中不打扰（底栏已有进度与取消）。
        const clicked = store.nodes.find((n) => n.id === d.id)
        if (clicked && clicked.instruction.phase !== 'generating') {
          updateInstruction(d.id, { open: true })
        }
      } else if (d?.kind === 'connect') {
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]')
        const targetId = hit?.getAttribute('data-node-id')
        if (targetId && targetId !== d.fromId) {
          addEdge(d.fromId, targetId)
          setConnecting(null)
        } else if (!targetId) {
          // 拖到空白：弹出垂直创建菜单（规范 10.2）。
          // 不把 connecting 清空后再开菜单——直接把来源/端口/释放点写进菜单状态，
          // 菜单打开期间持续绘制同一条虚线，创建后无缝变成真实连线。
          const cam = store.camera
          const wx = (e.clientX - cam.x) / cam.zoom
          const wy = (e.clientY - cam.y) / cam.zoom
          openCreateMenu({
            sx: e.clientX + 8, sy: e.clientY - 20,
            wx: wx - 60, wy: wy - 40,
            sourceIds: [d.fromId], fromSide: d.side, tipWx: wx, tipWy: wy,
          })
          setConnecting(null)
        } else {
          setConnecting(null)
        }
      } else if (d?.kind === 'box') {
        setBoxRect((rect) => {
          if (!rect) return null
          const small = rect.x2 - rect.x1 < 6 && rect.y2 - rect.y1 < 6
          if (small) return null
          const hits = store.nodes
            .filter((n) => n.x < rect.x2 && n.x + n.w > rect.x1 && n.y < rect.y2 && n.y + n.h > rect.y1)
            .map((n) => n.id)
          selectMany(hits)
          return null
        })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [store, setCamera, updateNode, updateInstruction, setConnecting, addEdge, openCreateMenu, selectMany])

  /* ---------- 画布空白：平移 / 框选（Shift） / 取消选择 ---------- */
  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-node-id]')) return
    if (e.shiftKey) {
      startWindowDrag({ kind: 'box', startX: e.clientX, startY: e.clientY })
      return
    }
    select(null)
    startWindowDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y })
  }

  const onStageDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-node-id]')) return
    const w = toWorld(e.clientX, e.clientY)
    openCreateMenu({ sx: e.clientX, sy: e.clientY, wx: w.x - 60, wy: w.y - 40 })
  }

  const onNodeDragStart = (e: React.PointerEvent, node: CanvasNode) => {
    if (e.shiftKey) { toggleSelect(node.id); return }
    if (!selectedIds.includes(node.id)) select(node.id)
    startWindowDrag({ kind: 'node', id: node.id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y })
  }

  const onPortDown = (e: React.PointerEvent, node: CanvasNode, side: PortSide) => {
    setConnecting({ fromId: node.id, side, sx: e.clientX, sy: e.clientY })
    startWindowDrag({ kind: 'connect', fromId: node.id, side })
  }

  const onResizeStart = (e: React.PointerEvent, node: CanvasNode) => {
    startWindowDrag({ kind: 'resize', id: node.id, startX: e.clientX, origW: node.w })
  }

  const selected = nodes.find((n) => n.id === selectedId) ?? null
  const selSx = selected ? selected.x * camera.zoom + camera.x + (selected.w * camera.zoom) / 2 : 0
  const selSyTop = selected ? selected.y * camera.zoom + camera.y : 0
  const selSyBottom = selected ? (selected.y + selected.h) * camera.zoom + camera.y : 0
  const selSxLeft = selected ? selected.x * camera.zoom + camera.x : 0

  // 多选（≥2）：形成一个整体「组框」套住选中节点（类似打组），
  // 新建节点后组框随选择清空而消失，只保留各节点 → 新节点的连线
  const multiNodes = selectedIds.length >= 2 ? nodes.filter((n) => selectedIds.includes(n.id)) : []
  const GROUP_PAD = 14
  let groupFrame: { x: number; y: number; w: number; h: number } | null = null
  let groupBar: { sx: number; sy: number } | null = null
  if (multiNodes.length >= 2) {
    const minX = Math.min(...multiNodes.map((n) => n.x))
    const minY = Math.min(...multiNodes.map((n) => n.y))
    const maxX = Math.max(...multiNodes.map((n) => n.x + n.w))
    const maxY = Math.max(...multiNodes.map((n) => n.y + n.h))
    groupFrame = {
      x: minX - GROUP_PAD, y: minY - GROUP_PAD,
      w: maxX - minX + GROUP_PAD * 2, h: maxY - minY + GROUP_PAD * 2,
    }
    if (!connecting && !createMenu) {
      groupBar = {
        sx: ((minX + maxX) / 2) * camera.zoom + camera.x,
        sy: (minY - GROUP_PAD) * camera.zoom + camera.y,
      }
    }
  }

  // 临时连线（屏幕层，拖拽中跟随光标）；多选组拖出时从组框端口出发
  let tempPath: string | null = null
  if (connecting) {
    const from = nodes.find((n) => n.id === connecting.fromId)
    if (from) {
      let a: { x: number; y: number; dx: number; dy: number }
      if (selectedIds.length >= 2 && groupFrame) {
        const gp = {
          top: { x: groupFrame.x + groupFrame.w / 2, y: groupFrame.y, dx: 0, dy: -1 },
          right: { x: groupFrame.x + groupFrame.w, y: groupFrame.y + groupFrame.h / 2, dx: 1, dy: 0 },
          bottom: { x: groupFrame.x + groupFrame.w / 2, y: groupFrame.y + groupFrame.h, dx: 0, dy: 1 },
          left: { x: groupFrame.x, y: groupFrame.y + groupFrame.h / 2, dx: -1, dy: 0 },
        }[connecting.side]
        a = gp
      } else {
        a = portPos(from, connecting.side)
      }
      const ax = a.x * camera.zoom + camera.x
      const ay = a.y * camera.zoom + camera.y
      const c = Math.max(40, Math.hypot(connecting.sx - ax, connecting.sy - ay) * 0.4)
      tempPath = `M ${ax} ${ay} C ${ax + a.dx * c} ${ay + a.dy * c}, ${connecting.sx - a.dx * c} ${connecting.sy - a.dy * c}, ${connecting.sx} ${connecting.sy}`
    }
  }

  // 创建菜单打开期间的持续虚线（世界层）：来源端口 → 触发点，创建后无缝变成真实连线
  const pendingPaths: string[] = []
  if (createMenu?.sourceIds?.length && createMenu.tipWx !== undefined && createMenu.tipWy !== undefined) {
    const tip = createMenu
    const DIR: Record<PortSide, { dx: number; dy: number }> = {
      top: { dx: 0, dy: -1 }, right: { dx: 1, dy: 0 }, bottom: { dx: 0, dy: 1 }, left: { dx: -1, dy: 0 },
    }
    if (createMenu.groupPort) {
      // 组框端口出发：一条虚线代表整组
      const dir = DIR[createMenu.groupPort.side]
      const a = { x: createMenu.groupPort.wx, y: createMenu.groupPort.wy, ...dir }
      pendingPaths.push(path(a, { x: tip.tipWx!, y: tip.tipWy!, dx: -dir.dx, dy: -dir.dy }))
    } else {
      for (const sid of createMenu.sourceIds) {
        const from = nodes.find((n) => n.id === sid)
        if (!from) continue
        let side: PortSide
        if (createMenu.sourceIds.length === 1 && createMenu.fromSide) {
          side = createMenu.fromSide
        } else {
          // 多来源：按相对位置自动选择出线侧
          const pseudo = { x: tip.tipWx! - 50, y: tip.tipWy! - 30, w: 100, h: 60 } as CanvasNode
          side = autoSides(from, pseudo)[0]
        }
        const a = portPos(from, side)
        const b = { x: tip.tipWx!, y: tip.tipWy!, dx: -a.dx, dy: -a.dy }
        pendingPaths.push(path(a, b))
      }
    }
  }

  const openMenuFromSelection = () => {
    if (multiNodes.length < 2 || !groupFrame) return
    const cx = groupFrame.x + groupFrame.w / 2
    const cy = groupFrame.y + groupFrame.h
    openCreateMenu({
      sx: cx * camera.zoom + camera.x + 8,
      sy: cy * camera.zoom + camera.y + 40,
      wx: cx - 150, wy: cy + 80,
      sourceIds: selectedIds,
      tipWx: cx, tipWy: cy,
    })
  }

  // 从组框端口拖出：相当于同时从全部选中节点拖出（大号节点的连接点）
  const onGroupPortDown = (e: React.PointerEvent, side: PortSide) => {
    if (!groupFrame || multiNodes.length < 2) return
    e.stopPropagation()
    const sp = {
      top: { x: groupFrame.x + groupFrame.w / 2, y: groupFrame.y },
      right: { x: groupFrame.x + groupFrame.w, y: groupFrame.y + groupFrame.h / 2 },
      bottom: { x: groupFrame.x + groupFrame.w / 2, y: groupFrame.y + groupFrame.h },
      left: { x: groupFrame.x, y: groupFrame.y + groupFrame.h / 2 },
    }[side]
    dragRef.current = { kind: 'connect', fromId: multiNodes[0].id, side }
    const onMove = (ev: PointerEvent) =>
      setConnecting({ fromId: multiNodes[0].id, side, sx: ev.clientX, sy: ev.clientY })
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragRef.current = null
      const cam = store.camera
      const wx = (ev.clientX - cam.x) / cam.zoom
      const wy = (ev.clientY - cam.y) / cam.zoom
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-node-id]')
      const targetId = hit?.getAttribute('data-node-id')
      if (targetId && !selectedIds.includes(targetId)) {
        // 组 → 已有节点：每个成员各连一条
        selectedIds.forEach((sid) => addEdge(sid, targetId))
        setConnecting(null)
      } else if (!targetId) {
        // 组 → 空白：菜单期间虚线从组框端口出发，创建后 N 条边一次成形
        openCreateMenu({
          sx: ev.clientX + 8, sy: ev.clientY - 20,
          wx: wx - 150, wy: wy - 40,
          sourceIds: selectedIds, tipWx: wx, tipWy: wy,
          groupPort: { side, wx: sp.x, wy: sp.y },
        })
        setConnecting(null)
      } else {
        setConnecting(null)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      ref={stageRef}
      className="absolute inset-0 overflow-hidden bg-gg-bg"
      style={{
        backgroundImage: 'radial-gradient(circle, #D9E2EC 1px, transparent 1px)',
        backgroundSize: `${26 * camera.zoom}px ${26 * camera.zoom}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
        cursor: connecting ? 'crosshair' : undefined,
      }}
      onPointerDown={onStagePointerDown}
      onDoubleClick={onStageDoubleClick}
    >
      {/* 世界层 */}
      <div
        className="absolute left-0 top-0"
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`, transformOrigin: '0 0' }}
      >
        <EdgeLayer />
        {/* 创建菜单打开期间的持续虚线 */}
        {pendingPaths.length > 0 && (
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
            {pendingPaths.map((d, i) => (
              <path key={i} d={d} fill="none" stroke="#2F80ED" strokeWidth={1.6} strokeDasharray="5 4" />
            ))}
          </svg>
        )}
        {/* 多选组框：一个「大号节点」——白底卡片质感 + 同款连接端口（世界层，随画布缩放）。
            渲染在成员节点之前，作为底板；白底同时盖住穿过组内的无关连线 */}
        {groupFrame && (
          <div
            className="absolute rounded-[18px] border-[1.5px] border-gg-select bg-gg-node shadow-float"
            style={{
              left: groupFrame.x, top: groupFrame.y,
              width: groupFrame.w, height: groupFrame.h,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {(['top', 'right', 'bottom', 'left'] as PortSide[]).map((side) => {
              const style: React.CSSProperties = {
                top: { left: '50%', top: 0, transform: 'translate(-50%, -50%)' },
                right: { left: '100%', top: '50%', transform: 'translate(-50%, -50%)' },
                bottom: { left: '50%', top: '100%', transform: 'translate(-50%, -50%)' },
                left: { left: 0, top: '50%', transform: 'translate(-50%, -50%)' },
              }[side]
              return (
                <button
                  key={side}
                  title="从所选节点组拖出：连接或新建节点"
                  className="absolute z-10 flex h-[18px] w-[18px] cursor-crosshair items-center justify-center rounded-full border-[1.5px] border-gg-select bg-white text-gg-select transition-transform hover:scale-110"
                  style={style}
                  onPointerDown={(e) => onGroupPortDown(e, side)}
                >
                  <Plus size={11} strokeWidth={2.2} />
                </button>
              )
            })}
          </div>
        )}
        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            selected={selectedIds.includes(n.id) && selectedIds.length < 2}
            onDragStart={onNodeDragStart}
            onPortDown={onPortDown}
            onResizeStart={onResizeStart}
          />
        ))}
      </div>

      {/* 临时连线（拖拽中） */}
      {tempPath && (
        <svg className="pointer-events-none absolute inset-0 z-40 h-full w-full">
          <path d={tempPath} fill="none" stroke="#2F80ED" strokeWidth={1.6} strokeDasharray="5 4" />
        </svg>
      )}

      {/* 框选矩形（屏幕层） */}
      {boxRect && (
        <div
          className="pointer-events-none absolute z-40 rounded-[4px] border border-gg-select bg-[#1769E0]/[0.06]"
          style={{
            left: boxRect.x1 * camera.zoom + camera.x,
            top: boxRect.y1 * camera.zoom + camera.y,
            width: (boxRect.x2 - boxRect.x1) * camera.zoom,
            height: (boxRect.y2 - boxRect.y1) * camera.zoom,
          }}
        />
      )}

      {/* 屏幕层浮动控件 */}
      {selected && !connecting && selectedIds.length < 2 && (
        <FloatingToolbar node={selected} sx={selSx} sy={selSyTop} />
      )}
      {selected && selected.instruction.open && !connecting && selectedIds.length < 2 && (
        <InstructionPanel node={selected} sx={selSxLeft} sy={selSyBottom} />
      )}

      {/* 多选组工具条：与单节点悬浮工具条同款图标按钮 */}
      {groupBar && (
        <div
          className="gg-pop absolute z-40 flex items-center gap-0.5 rounded-[16px] border border-gg-line bg-gg-node p-1 shadow-float"
          style={{ left: groupBar.sx, top: groupBar.sy, transform: 'translate(-50%, calc(-100% - 10px))' }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            title={`以所选 ${multiNodes.length} 个节点为来源新建节点`}
            onClick={openMenuFromSelection}
            className="flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[12px] font-medium text-gg-primary transition-colors hover:bg-gg-subtle"
          >
            <MessageSquarePlus size={14} /> 新建节点
          </button>
          <span className="mx-0.5 h-4 w-px bg-gg-line" />
          <button
            title="复制所选节点"
            onClick={() => selectedIds.forEach((id) => duplicateNode(id))}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-ink transition-colors hover:bg-gg-subtle"
          >
            <Copy size={14} />
          </button>
          <button
            title="取消成组（仅取消选择，不删除节点）"
            onClick={() => select(null)}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted transition-colors hover:bg-gg-subtle hover:text-gg-danger"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {createMenu && <CreateMenu menu={createMenu} />}
      {/* 平铺创建面板仅在首次启动时出现；创建过节点后永久隐藏（规范 3.4） */}
      {nodes.length === 0 && !everCreated && <EmptyState />}
      {nodes.length === 0 && everCreated && !createMenu && (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 text-center text-[12.5px] text-[#98A2B3]">
          双击空白处，或从左侧「创建节点」继续
        </p>
      )}
      <ZoomMinimap />

      {/* 连线计数（调试用小提示，融入右下角缩放控件区上方） */}
      {edges.length > 0 && null}
    </div>
  )
}
