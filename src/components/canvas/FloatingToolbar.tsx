import {
  Bold, Italic, Heading1, Heading2, AlignLeft, List, Copy, Trash2, Play, RefreshCw, Download, BookmarkPlus, MessageSquareText,
} from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'
import type { CanvasNode } from '@/types/canvas'

interface Props {
  node: CanvasNode
  /** 屏幕坐标：节点顶部中心 */
  sx: number
  sy: number
}

function Btn({ title, onClick, active, danger, children }: {
  title: string; onClick?: () => void; active?: boolean; danger?: boolean; children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-[8px] transition-colors ${
        danger
          ? 'text-gg-muted hover:bg-gg-subtle hover:text-gg-danger'
          : active
            ? 'bg-gg-subtle text-gg-primary'
            : 'text-gg-ink hover:bg-gg-subtle'
      }`}
    >
      {children}
    </button>
  )
}

export default function FloatingToolbar({ node, sx, sy }: Props) {
  const { duplicateNode, removeNode, updateNode, updateInstruction, updateSmart, runInstruction } = useCanvas()
  const instr = node.instruction
  const smart = node.smart

  return (
    <div
      className="absolute z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-[16px] border border-gg-line bg-gg-node p-1 shadow-float"
      style={{ left: sx, top: sy, transform: 'translate(-50%, calc(-100% - 10px))' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 指令面板开关：所有节点通用 */}
      <Btn title="指令面板" active={instr.open} onClick={() => updateInstruction(node.id, { open: !instr.open })}>
        <MessageSquareText size={14} />
      </Btn>

      {/* 文本节点：格式操作 */}
      {node.type === 'text' && (
        <>
          <span className="mx-0.5 h-4 w-px bg-gg-line" />
          <Btn title="粗体" active={node.bold} onClick={() => updateNode(node.id, { bold: !node.bold })}>
            <Bold size={14} />
          </Btn>
          <Btn title="斜体" active={node.italic} onClick={() => updateNode(node.id, { italic: !node.italic })}>
            <Italic size={14} />
          </Btn>
          <Btn title="H1" active={node.heading === 1} onClick={() => updateNode(node.id, { heading: node.heading === 1 ? 0 : 1 })}>
            <Heading1 size={14} />
          </Btn>
          <Btn title="H2" active={node.heading === 2} onClick={() => updateNode(node.id, { heading: node.heading === 2 ? 0 : 2 })}>
            <Heading2 size={14} />
          </Btn>
          <Btn title="对齐"><AlignLeft size={14} /></Btn>
          <Btn title="列表"><List size={14} /></Btn>
        </>
      )}

      {/* 智能节点：执行与产物操作 */}
      {node.type === 'smart' && smart && (
        <>
          <span className="mx-0.5 h-4 w-px bg-gg-line" />
          {instr.phase !== 'done' ? (
            <Btn title="执行" onClick={() => runInstruction(node.id)}><Play size={14} /></Btn>
          ) : (
            <>
              <Btn title="生成变体" onClick={() => { updateSmart(node.id, { seed: smart.seed + 1 }); runInstruction(node.id) }}>
                <RefreshCw size={14} />
              </Btn>
              <Btn title="导出"><Download size={14} /></Btn>
              <Btn title="设为参考"><BookmarkPlus size={14} /></Btn>
            </>
          )}
        </>
      )}

      {/* 通用操作 */}
      <span className="mx-0.5 h-4 w-px bg-gg-line" />
      <Btn title="复制节点" onClick={() => duplicateNode(node.id)}><Copy size={14} /></Btn>
      <Btn title="删除" danger onClick={() => removeNode(node.id)}><Trash2 size={14} /></Btn>
    </div>
  )
}
