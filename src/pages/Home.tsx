import { CanvasCtx, useCanvasStore } from '@/hooks/useCanvasStore'
import TopBar from '@/components/canvas/TopBar'
import LeftSidebar from '@/components/canvas/LeftSidebar'
import CanvasStage from '@/components/canvas/CanvasStage'
import CanvasVersionManager from '@/components/canvas/CanvasVersionManager'
import { Loader2, RotateCcw } from 'lucide-react'

export default function Home() {
  const store = useCanvasStore()
  return (
    <CanvasCtx.Provider value={store}>
      {store.hydrationState === 'loading' ? (
        <main className="flex h-screen w-screen items-center justify-center bg-gg-bg font-sans">
          <div className="flex items-center gap-2 text-[13px] text-gg-muted">
            <Loader2 size={16} className="animate-spin" /> 正在恢复画布…
          </div>
        </main>
      ) : store.hydrationState === 'error' ? (
        <main className="flex h-screen w-screen items-center justify-center bg-gg-bg p-6 font-sans">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-[16px] border border-gg-line bg-gg-node p-6 text-center">
            <h1 className="text-[15px] font-semibold text-gg-ink">画布加载失败</h1>
            <p className="text-[12px] leading-5 text-gg-muted">
              {store.hydrationError ?? '无法读取画布数据'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={store.retryHydration}
                className="flex h-8 items-center gap-1.5 rounded-[10px] bg-gg-primary px-3 text-[13px] text-white transition-colors hover:bg-gg-select"
              >
                <RotateCcw size={14} /> 重试
              </button>
              <CanvasVersionManager branch={store.branch} canChangeBranch />
            </div>
            <p className="text-[11px] leading-4 text-gg-muted">
              如果当前快照损坏，可从“版本”的检查点恢复到新分支。
            </p>
          </div>
        </main>
      ) : (
      <div className="relative h-screen w-screen overflow-hidden bg-gg-bg font-sans">
        <TopBar />
        <LeftSidebar />
        <div className="absolute inset-0 pt-[52px] pl-[52px]">
          <CanvasStage />
        </div>
      </div>
      )}
    </CanvasCtx.Provider>
  )
}
