import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'
import type { CanvasNode, PortSide } from '@/types/canvas'

export function portPos(n: CanvasNode, side: PortSide) {
  switch (side) {
    case 'top': return { x: n.x + n.w / 2, y: n.y, dx: 0, dy: -1 }
    case 'bottom': return { x: n.x + n.w / 2, y: n.y + n.h, dx: 0, dy: 1 }
    case 'left': return { x: n.x, y: n.y + n.h / 2, dx: -1, dy: 0 }
    case 'right': return { x: n.x + n.w, y: n.y + n.h / 2, dx: 1, dy: 0 }
  }
}

/** 依据两节点相对位置自动选择出线侧 */
export function autoSides(a: CanvasNode, b: CanvasNode): [PortSide, PortSide] {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2
  const dx = bcx - acx, dy = bcy - acy
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right']
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom']
}

export function path(a: ReturnType<typeof portPos>, b: ReturnType<typeof portPos>) {
  const c = Math.max(48, Math.hypot(b.x - a.x, b.y - a.y) * 0.4)
  return `M ${a.x} ${a.y} C ${a.x + a.dx * c} ${a.y + a.dy * c}, ${b.x + b.dx * c} ${b.y + b.dy * c}, ${b.x} ${b.y}`
}

export default function EdgeLayer() {
  const { nodes, edges, camera, removeEdge, cycleEdgeLabel, openCreateMenu } = useCanvas()
  const [hoverId, setHoverId] = useState<string | null>(null)

  return (
    <>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
        {edges.map((e) => {
          const from = nodes.find((n) => n.id === e.from)
          const to = nodes.find((n) => n.id === e.to)
          if (!from || !to) return null
          const [fs, ts] = autoSides(from, to)
          const d = path(portPos(from, fs), portPos(to, ts))
          const active = hoverId === e.id
          return (
            <g key={e.id}>
              {/* 加宽的透明热区 */}
              <path
                d={d} fill="none" stroke="transparent" strokeWidth={14}
                className="pointer-events-auto cursor-pointer"
                onPointerEnter={() => setHoverId(e.id)}
                onPointerLeave={() => setHoverId(null)}
              />
              <path
                d={d} fill="none"
                stroke={active ? '#2F80ED' : '#B8C4D4'}
                strokeWidth={active ? 1.8 : 1.4}
              />
            </g>
          )
        })}
      </svg>

      {/* 关系标签：默认只显示线，悬停后显示（规范 4.3） */}
      {edges.map((e) => {
        if (hoverId !== e.id) return null
        const from = nodes.find((n) => n.id === e.from)
        const to = nodes.find((n) => n.id === e.to)
        if (!from || !to) return null
        const mx = (from.x + from.w / 2 + to.x + to.w / 2) / 2
        const my = (from.y + from.h / 2 + to.y + to.h / 2) / 2
        // 从连线创建：新节点同时引用连线两端的节点
        const createFromEdge = () => {
          openCreateMenu({
            sx: mx * camera.zoom + camera.x + 8,
            sy: my * camera.zoom + camera.y - 20,
            wx: mx - 150, wy: my + 90,
            sourceIds: [e.from, e.to],
            tipWx: mx, tipWy: my,
          })
          setHoverId(null)
        }
        return (
          <div
            key={e.id}
            className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-gg-line bg-gg-node py-0.5 pl-2.5 pr-1 text-[11px] text-gg-muted shadow-float"
            style={{ left: mx, top: my }}
            onPointerEnter={() => setHoverId(e.id)}
            onPointerLeave={() => setHoverId(null)}
          >
            <button className="hover:text-gg-primary" title="点击切换关系" onClick={() => cycleEdgeLabel(e.id)}>
              {e.label}
            </button>
            <button
              className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-gg-subtle hover:text-gg-primary"
              title="从连线创建节点（同时引用两端）"
              onClick={createFromEdge}
            >
              <Plus size={10} />
            </button>
            <button
              className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-gg-subtle hover:text-gg-danger"
              title="删除连线"
              onClick={() => removeEdge(e.id)}
            >
              <X size={10} />
            </button>
          </div>
        )
      })}
    </>
  )
}
