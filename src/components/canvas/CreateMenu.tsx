import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useCanvas } from '@/hooks/useCanvasStore'
import type { CreateMenuState } from '@/types/canvas'
import { listCreatablePlugins, subscribePlugins } from '@/plugins/types'

/** 已有节点后的轻量垂直创建菜单（规范 3.4），贴近触发点；条目 = 全部已注册节点插件 */
export default function CreateMenu({ menu }: { menu: CreateMenuState }) {
  const { createFromMenu, closeCreateMenu } = useCanvas()
  const ref = useRef<HTMLDivElement>(null)
  useSyncExternalStore(subscribePlugins, () => 0)

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeCreateMenu()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeCreateMenu() }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [closeCreateMenu])

  // 防止菜单超出视口
  const top = Math.min(menu.sy, window.innerHeight - 380)
  const left = Math.min(menu.sx, window.innerWidth - 220)

  return (
    <div
      ref={ref}
      className="gg-pop absolute z-50 w-[200px] rounded-[14px] border border-gg-line bg-gg-node p-1.5 shadow-float"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <p className="px-2.5 pb-1.5 pt-2 text-[11px] font-medium text-gg-muted">
        {menu.sourceIds?.length
          ? menu.sourceIds.length > 1
            ? `创建并引用 ${menu.sourceIds.length} 个节点`
            : '创建并连接'
          : '创建节点'}
      </p>
      {listCreatablePlugins().map((p) => {
        const Icon = p.icon
        return (
          <button
            key={p.id}
            onClick={() => createFromMenu(p.id)}
            className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-left text-[12.5px] text-gg-ink transition-colors hover:bg-gg-subtle"
          >
            <Icon size={14} className="text-gg-muted" strokeWidth={1.8} />
            {p.label}
          </button>
        )
      })}
      <button className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-left text-[12.5px] text-gg-muted transition-colors hover:bg-gg-subtle">
        <span className="w-[14px] text-center">…</span> 更多
      </button>
    </div>
  )
}
