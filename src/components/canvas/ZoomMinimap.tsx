import { Minus, Plus, Maximize2 } from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'

const MW = 148, MH = 96

export default function ZoomMinimap() {
  const { nodes, camera, zoomTo, fitView } = useCanvas()
  const pct = Math.round(camera.zoom * 100)

  // 小地图：将节点包围盒映射进小地图
  let map: { x: number; y: number; w: number; h: number }[] = []
  let viewport: { x: number; y: number; w: number; h: number } | null = null
  if (nodes.length > 0) {
    const minX = Math.min(...nodes.map((n) => n.x)) - 120
    const minY = Math.min(...nodes.map((n) => n.y)) - 120
    const maxX = Math.max(...nodes.map((n) => n.x + n.w)) + 120
    const maxY = Math.max(...nodes.map((n) => n.y + n.h)) + 160
    const vw = window.innerWidth / camera.zoom
    const vh = window.innerHeight / camera.zoom
    const bx = Math.min(minX, -camera.x / camera.zoom) 
    const by = Math.min(minY, -camera.y / camera.zoom)
    const bw = Math.max(maxX - bx, (-camera.x / camera.zoom + vw) - bx)
    const bh = Math.max(maxY - by, (-camera.y / camera.zoom + vh) - by)
    const k = Math.min(MW / bw, MH / bh)
    map = nodes.map((n) => ({ x: (n.x - bx) * k, y: (n.y - by) * k, w: Math.max(3, n.w * k), h: Math.max(2, n.h * k) }))
    viewport = { x: (-camera.x / camera.zoom - bx) * k, y: (-camera.y / camera.zoom - by) * k, w: vw * k, h: vh * k }
  }

  return (
    <div className="absolute bottom-4 right-4 z-30 flex flex-col items-end gap-2" onPointerDown={(e) => e.stopPropagation()}>
      {/* 小地图 */}
      {nodes.length > 0 && (
        <div className="relative overflow-hidden rounded-[12px] border border-gg-line bg-gg-node shadow-float" style={{ width: MW, height: MH }}>
          {map.map((r, i) => (
            <span key={i} className="absolute rounded-[2px] bg-[#C4D6F5]" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
          ))}
          {viewport && (
            <span className="absolute rounded-[3px] border border-gg-select bg-gg-select/10" style={{ left: viewport.x, top: viewport.y, width: viewport.w, height: viewport.h }} />
          )}
        </div>
      )}

      {/* 缩放控制 */}
      <div className="flex items-center gap-0.5 rounded-[12px] border border-gg-line bg-gg-node p-1 shadow-float">
        <button title="缩小" onClick={() => zoomTo(camera.zoom - 0.2)} className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-ink hover:bg-gg-subtle">
          <Minus size={14} />
        </button>
        <button title="重置为 100%" onClick={() => zoomTo(1)} className="h-7 min-w-[46px] rounded-[8px] px-1 text-[11.5px] tabular-nums text-gg-ink hover:bg-gg-subtle">
          {pct}%
        </button>
        <button title="放大" onClick={() => zoomTo(camera.zoom + 0.2)} className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-ink hover:bg-gg-subtle">
          <Plus size={14} />
        </button>
        <span className="mx-0.5 h-4 w-px bg-gg-line" />
        <button title="适应画布" onClick={fitView} className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-ink hover:bg-gg-subtle">
          <Maximize2 size={13} />
        </button>
      </div>
    </div>
  )
}
