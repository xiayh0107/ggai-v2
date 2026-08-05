import { ArrowUp, Loader2, Mic, Paperclip, Plus, X } from 'lucide-react'
import { useCanvas } from '@/hooks/useCanvasStore'
import type { CanvasNode } from '@/types/canvas'
import { getPlugin } from '@/plugins/types'
import type { SuggestedAction } from '@/agent/outcome'

interface Props {
  node: CanvasNode
  /** 屏幕坐标：节点左下角 */
  sx: number
  sy: number
}

/** 来源节点的迷你预览缩略图：按内容类型渲染小窗（替代纯文字标注） */
function SourceThumb({ src }: { src: CanvasNode }) {
  const Icon = getPlugin(src.type).icon
  const inner = (() => {
    switch (src.type) {
      case 'text': {
        const t = src.text?.trim()
        return t
          ? <span className="block w-full px-[3px] text-left text-[4px] leading-[6px] text-[#475467]">{t.slice(0, 30)}</span>
          : <Icon size={12} className="text-[#98A2B3]" strokeWidth={1.6} />
      }
      case 'image':
        return (
          <svg width="26" height="16" viewBox="0 0 26 16">
            <rect width="26" height="16" rx="2" fill="#E4EAF2" />
            <circle cx="7" cy="5" r="2" fill="#B8C4D4" />
            <path d="M2 14 L10 7 L15 11 L19 8 L24 14 Z" fill="#98A2B3" />
          </svg>
        )
      case 'pdf':
        return (
          <svg width="26" height="16" viewBox="0 0 26 16">
            {[2, 6, 10].map((y) => <rect key={y} x="4" y={y} width={18 - y} height="2" rx="1" fill="#B8C4D4" />)}
          </svg>
        )
      case 'table':
        return (
          <svg width="26" height="16" viewBox="0 0 26 16">
            <rect x="3" y="2" width="20" height="12" rx="1.5" fill="none" stroke="#B8C4D4" strokeWidth="1" />
            <path d="M3 6.5 H 23 M 3 10.5 H 23 M 10 2 V 14 M 16.5 2 V 14" stroke="#B8C4D4" strokeWidth="1" />
          </svg>
        )
      case 'code':
        return (
          <svg width="26" height="16" viewBox="0 0 26 16">
            <rect x="3" y="3" width="10" height="2" rx="1" fill="#98A2B3" />
            <rect x="6" y="7" width="14" height="2" rx="1" fill="#B8C4D4" />
            <rect x="6" y="11" width="8" height="2" rx="1" fill="#B8C4D4" />
          </svg>
        )
      case 'formula':
        return <span className="font-serif text-[10px] italic text-[#667085]">ƒ(x)</span>
      case 'smart':
        return (
          <svg width="26" height="16" viewBox="0 0 26 16">
            <rect x="4" y="8" width="3.5" height="6" rx="1" fill="#1769E0" opacity="0.7" />
            <rect x="11" y="5" width="3.5" height="9" rx="1" fill="#1769E0" />
            <rect x="18" y="10" width="3.5" height="4" rx="1" fill="#1769E0" opacity="0.5" />
          </svg>
        )
      default:
        // 未特化的插件类型：用插件自己的图标作预览
        return <Icon size={12} className="text-[#98A2B3]" strokeWidth={1.6} />
    }
  })()
  return (
    <span className="flex h-[34px] w-[46px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-gg-line bg-white">
      {inner}
    </span>
  )
}

/**
 * 指令面板（精简版）：输入框即主体。
 * 左侧 ＋ 收拢附件/来源；底部一条紧凑控制条；圆形发送按钮。
 * 占位提示 / 快捷指令 / 参数槽全部来自节点插件；不显示模型名与积分（规范 5.5）。
 */
export default function InstructionPanel({ node, sx, sy }: Props) {
  const { nodes, edges, camera, updateInstruction, runInstruction, addEdge } = useCanvas()
  const plugin = getPlugin(node.type)
  const instr = node.instruction
  const sourceIds = [...new Set(edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => edge.from))]
  const sourceNodes = sourceIds
    .map((sid) => nodes.find((n) => n.id === sid))
    .filter((n): n is CanvasNode => Boolean(n))
  const fallbackActions = [
    ...plugin.instr.actions,
    ...(plugin.instr.actionsFor?.(node, sourceNodes) ?? []),
  ].map((prompt, index): SuggestedAction => ({
    id: `fallback-${index}-${prompt}`,
    label: prompt,
    prompt,
  }))
  // Agent 结果是首选。只有本次 run 没有产出结构化建议时才使用插件静态兜底。
  const actions = instr.suggestedActions
    ? instr.suggestedActions.actions
    : fallbackActions
  const ParamSlot = plugin.instr.ParamSlot
  const generating = instr.phase === 'generating'

  // 固定尺寸：不随画布缩放变化，只跟随节点位置
  const w = Math.min(430, Math.max(360, node.w + 70))
  // 逐段估算真实高度（避免翻转贴到节点上方时留出过大空隙）
  const promptRows = Math.max(2, Math.ceil((instr.prompt.length || 0) / 26))
  const inputH = Math.min(140, 20 + promptRows * 20) // 输入框：padding + 行高
  const estH =
    (actions.length > 0 ? 32 : 0) +                       // 快捷指令行
    (instr.attachments.length || sourceIds.length ? 48 : 0) + // 附件/来源小窗行
    inputH +                                              // 输入区
    40 +                                                  // 底部控制条
    20                                                    // 面板 padding
  const GAP = 8

  let left = sx - 20 * camera.zoom
  let top = sy + GAP
  if (left + w > window.innerWidth - 12) {
    left = sx + node.w * camera.zoom - w + 20 * camera.zoom
  }
  left = Math.max(12, left)
  const nodeTop = sy - node.h * camera.zoom
  if (top + estH > window.innerHeight - 12 && nodeTop - estH - GAP > 56) {
    top = nodeTop - estH - GAP
  }

  const others = nodes.filter((n) => n.id !== node.id && !sourceIds.includes(n.id))
  const canRun = !generating && (instr.prompt.trim().length > 0 || node.type === 'smart')

  return (
    <div
      className="absolute z-40 rounded-[16px] border border-gg-line bg-gg-node p-2.5 shadow-float"
      style={{ left, top, width: w }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 专精节点的快捷指令：轻量胶囊行，点击即填入 */}
      {actions.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1 px-1">
          {actions.slice(0, 5).map((action) => (
            <button
              key={action.id}
              onClick={() => updateInstruction(node.id, { prompt: action.prompt })}
              className={`rounded-full px-2 py-[3px] text-[11px] transition-colors ${
                instr.prompt === action.prompt
                  ? 'bg-[#EAF1FD] text-gg-primary'
                  : 'text-gg-muted hover:bg-gg-subtle hover:text-gg-ink'
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* 附件 / 来源小窗（有内容时才占行） */}
      {(instr.attachments.length > 0 || sourceIds.length > 0) && (
        <div className="mb-1.5 flex flex-wrap gap-1 px-1">
          {instr.attachments.map((a, i) => (
            <span key={a} className="flex items-center gap-1 rounded-full bg-gg-subtle px-2 py-0.5 text-[11px] text-gg-ink">
              <Paperclip size={10} /> {a}
              <button
                className="text-gg-muted hover:text-gg-danger"
                onClick={() => updateInstruction(node.id, { attachments: instr.attachments.filter((_, j) => j !== i) })}
              >
                <X size={9} />
              </button>
            </span>
          ))}
          {sourceIds.map((sid) => {
            const src = nodes.find((n) => n.id === sid)
            if (!src) return null
            const SrcIcon = getPlugin(src.type).icon
            return (
              <span
                key={sid}
                className="flex items-center gap-1.5 rounded-[8px] border border-gg-line bg-white py-1 pl-1 pr-1.5"
                title={`来源 · ${src.title || getPlugin(src.type).label}`}
              >
                <SourceThumb src={src} />
                <span className="flex items-center gap-1 text-[11px] text-gg-ink">
                  <SrcIcon size={10} className="text-gg-muted" strokeWidth={1.8} />
                  {src.title || getPlugin(src.type).label}
                </span>
              </span>
            )
          })}
        </div>
      )}

      {/* 输入区：＋ 收拢附件与来源 */}
      <div className="flex items-start gap-2 rounded-[12px] border border-gg-line bg-white p-2 transition-colors focus-within:border-gg-select">
        <button
          title="添加附件"
          onClick={() => updateInstruction(node.id, { attachments: [...instr.attachments, `附件_${instr.attachments.length + 1}.png`] })}
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-gg-subtle text-gg-muted transition-colors hover:text-gg-ink"
        >
          <Plus size={14} />
        </button>
        <textarea
          autoFocus={instr.phase === 'idle' && !instr.prompt}
          value={instr.prompt}
          onChange={(e) => updateInstruction(node.id, { prompt: e.target.value })}
          placeholder={plugin.instr.placeholder}
          rows={2}
          className="max-h-[120px] min-h-[44px] w-full resize-none bg-transparent pt-1 text-[13px] leading-5 text-gg-ink outline-none placeholder:text-[#98A2B3]"
        />
      </div>

      {/* 底部紧凑控制条 */}
      <div className="mt-1.5 flex items-center gap-1 px-1">
        {/* 来源节点 */}
        {others.length > 0 && (
          <select
            value=""
            title="添加来源节点"
            onChange={(e) => { if (e.target.value) addEdge(e.target.value, node.id) }}
            className="h-7 cursor-pointer appearance-none rounded-full border border-gg-line bg-white bg-[url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22%3E%3Cpath d=%22M1 1l4 4 4-4%22 stroke=%22%23667085%22 fill=%22none%22 stroke-width=%221.5%22 stroke-linecap=%22round%22/%3E%3C/svg%3E&quot;)] bg-[position:right_9px_center] bg-no-repeat py-0 pl-2.5 pr-6 text-[11.5px] text-gg-ink outline-none focus:border-gg-select"
          >
            <option value="">来源 {sourceIds.length > 0 ? sourceIds.length : ''}</option>
            {others.map((n) => <option key={n.id} value={n.id}>{n.title || '未命名节点'}</option>)}
          </select>
        )}

        {/* 插件参数槽（如智能节点的图表类型 / 风格 / 张数） */}
        {ParamSlot && <ParamSlot node={node} />}

        <span className="flex-1" />

        <button title="语音输入（原型占位）" className="flex h-7 w-7 items-center justify-center rounded-full text-gg-muted transition-colors hover:bg-gg-subtle hover:text-gg-ink">
          <Mic size={13} />
        </button>

        {/* 圆形发送按钮 */}
        <button
          onClick={() => canRun && runInstruction(node.id)}
          disabled={!canRun}
          title={generating ? '生成中' : '执行'}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            canRun ? 'bg-gg-primary text-white hover:bg-gg-select' : 'bg-gg-subtle text-[#98A2B3]'
          }`}
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} strokeWidth={2.2} />}
        </button>
      </div>
    </div>
  )
}
