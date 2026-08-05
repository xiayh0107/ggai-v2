import { AlertTriangle, Check, ChevronLeft, Clock3, Loader2, RotateCcw, Share2 } from 'lucide-react'
import { Link } from 'react-router'
import { useCanvas } from '@/hooks/useCanvasStore'
import CanvasVersionManager from './CanvasVersionManager'

export default function TopBar() {
  const {
    branch,
    savedState,
    saveError,
    retrySave,
    preserveConflictAsBranch,
  } = useCanvas()
  const saveIndicator = (() => {
    switch (savedState) {
      case 'loading':
        return <><Loader2 size={12} className="animate-spin" /> 正在载入…</>
      case 'local-pending':
        return <><Clock3 size={12} /> 等待保存</>
      case 'saving':
        return <><Loader2 size={12} className="animate-spin" /> 保存中…</>
      case 'error':
        return (
          <button
            type="button"
            title={saveError ?? '保存失败'}
            onClick={retrySave}
            className="flex items-center gap-1 text-gg-danger hover:underline"
          >
            <RotateCcw size={12} /> 保存失败，重试
          </button>
        )
      case 'conflict':
        return (
          <span title={saveError ?? '存在版本冲突'} className="flex items-center gap-1 text-gg-danger">
            <AlertTriangle size={12} /> 存在保存冲突
          </span>
        )
      case 'saved':
        return <><Check size={12} className="text-gg-success" /> 已保存</>
    }
  })()
  return (
    <header className="absolute inset-x-0 top-0 z-30 flex h-[52px] items-center justify-between border-b border-gg-line bg-gg-node px-4">
      <div className="flex items-center gap-3">
        <Link
          to="/"
          title="返回工作空间"
          className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted transition-colors hover:bg-gg-subtle hover:text-gg-ink"
        >
          <ChevronLeft size={16} />
        </Link>
        <div className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-gg-primary text-[13px] font-semibold text-white">
          G
        </div>
        <span className="text-[14px] font-semibold text-gg-ink">GGAI</span>
        <span className="h-4 w-px bg-gg-line" />
        <span className="text-[13px] text-gg-ink">未命名项目</span>
        {branch !== 'main' && (
          <span className="rounded-[6px] bg-gg-subtle px-1.5 py-0.5 text-[11px] text-gg-muted">
            {branch}
          </span>
        )}
        <span className="flex items-center gap-1 text-[12px] text-gg-muted">
          {saveIndicator}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <CanvasVersionManager
          branch={branch}
          canChangeBranch={savedState === 'saved'}
          conflict={savedState === 'conflict'}
          onPreserveConflict={preserveConflictAsBranch}
        />
        <button className="flex h-8 items-center gap-1.5 rounded-[10px] bg-gg-primary px-3 text-[13px] text-white transition-colors hover:bg-gg-select">
          <Share2 size={14} /> 分享
        </button>
      </div>
    </header>
  )
}
