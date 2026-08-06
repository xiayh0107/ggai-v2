import { useSyncExternalStore } from 'react'
import { useCanvas } from '@/hooks/useCanvasStore'
import { listCreatablePlugins, subscribePlugins } from '@/plugins/types'

/** 空白画布首屏：平铺展示所有启用中的节点插件（规范 3.3 / 10.1） */
export default function EmptyState() {
  const { addNode, camera } = useCanvas()
  useSyncExternalStore(subscribePlugins, () => 0)
  const plugins = listCreatablePlugins()

  const create = (id: string) => {
    // 落在当前视口中心，按类型序号轻微错位避免重叠
    const i = plugins.findIndex((p) => p.id === id)
    const wx = (window.innerWidth / 2 - camera.x) / camera.zoom - 150 + (i % 3) * 36
    const wy = (window.innerHeight / 2 - camera.y) / camera.zoom - 130 + Math.floor(i / 3) * 30
    addNode(id, wx, wy)
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div
        className="pointer-events-auto w-[640px] max-w-[86vw]"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <h1 className="text-center text-[22px] font-semibold tracking-wide text-gg-ink">从创建节点开始</h1>
        <p className="mt-2 text-center text-[13px] text-gg-muted">
          选择节点类型，也可以直接把文件拖进画布
        </p>
        <div className="mt-7 grid grid-cols-3 gap-3">
          {plugins.map((p) => {
            const Icon = p.icon
            return (
              <button
                key={p.id}
                onClick={() => create(p.id)}
                className="group flex flex-col gap-2.5 rounded-[14px] border border-gg-line bg-gg-node p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-gg-select hover:shadow-float"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gg-subtle text-gg-muted transition-colors group-hover:bg-[#EAF1FD] group-hover:text-gg-primary">
                  <Icon size={17} strokeWidth={1.8} />
                </span>
                <span>
                  <span className="block text-[13.5px] font-medium text-gg-ink">{p.label}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-4 text-gg-muted">{p.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
        <p className="mt-6 text-center text-[11.5px] text-[#98A2B3]">
          提示：双击画布空白处，或从节点端口拖出连线，也可以随时创建节点
        </p>
      </div>
    </div>
  )
}
