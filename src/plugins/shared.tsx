import { Upload, type LucideIcon } from 'lucide-react'
import type { CanvasNode } from '@/types/canvas'

/** 通用空白态：虚线框 + 类型图标 + 操作引导（各插件仅替换文案） */
export function makeEmptyView(Icon: LucideIcon, action: string, hint: string) {
  return function EmptyView() {
    return (
      <div className="flex h-[96px] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-gg-line">
        <Icon size={18} className="text-[#98A2B3]" strokeWidth={1.5} />
        <span className="flex items-center gap-1 text-[12px] text-gg-muted">
          <Upload size={11} /> {action}
        </span>
        <span className="text-[11px] text-[#98A2B3]">{hint}</span>
      </div>
    )
  }
}

/** 结果摘要行：指令完成后追加的「✓ 已完成」记录 */
export function MetaLines({ node }: { node: CanvasNode }) {
  if (!node.meta?.length) return null
  return (
    <div className="mt-2.5 space-y-0.5">
      {node.meta.map((m) => (
        <p key={m} className={`text-[11.5px] leading-4 ${m.startsWith('✓') ? 'text-gg-success' : 'text-gg-muted'}`}>{m}</p>
      ))}
    </div>
  )
}
