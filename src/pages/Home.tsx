import { Loader2, RotateCcw, ShieldAlert } from 'lucide-react'
import { useMemo } from 'react'
import { DAEMON_URL } from '@/agent/config'
import {
  CanvasV2Bootstrap,
  type CanvasV2BootstrapFailure,
} from '@/canvas-v2/CanvasV2Bootstrap'
import { CanvasV2DaemonClient } from '@/canvas-v2/daemonClient'
import CanvasV2Home from './CanvasV2Home'

export default function Home() {
  const capabilityClient = useMemo(
    () => new CanvasV2DaemonClient({ baseUrl: DAEMON_URL }),
    [],
  )
  return (
    <CanvasV2Bootstrap
      client={capabilityClient}
      loading={<CanvasModelLoading />}
      blocked={(failure, retry) => (
        <CanvasV2Unavailable failure={failure} onRetry={retry} />
      )}
    >
      <CanvasV2Home />
    </CanvasV2Bootstrap>
  )
}

function CanvasV2Unavailable({
  failure,
  onRetry,
}: {
  failure: CanvasV2BootstrapFailure
  onRetry: () => void
}) {
  const explanation = failure.reason === 'daemon-v1-diagnostic'
    ? 'daemon 当前以显式 Canvas V1 归档诊断模式运行；应用界面只支持 Canvas V2。请停止 daemon，移除 V1 覆盖后重新启动。'
    : failure.reason === 'reset-required'
      ? '当前项目缺少 Canvas V2 初始化标记。为避免旧数据与 V2 schema 混写，画布不会自动创建或回退。'
      : '无法确认本地 daemon 的 Canvas V2 能力。请确认 daemon 已启动，并检查终端中的启动错误。'

  return (
    <main className="flex h-screen w-screen items-center justify-center bg-gg-bg p-6 font-sans">
      <div role="alert" className="flex max-w-md flex-col items-center gap-3 rounded-[16px] border border-gg-line bg-gg-node p-6 text-center">
        <ShieldAlert size={24} className="text-amber-600" />
        <h1 className="text-[15px] font-semibold text-gg-ink">Canvas V2 尚未就绪</h1>
        <p className="text-[12px] leading-5 text-gg-muted">{explanation}</p>
        {failure.message && (
          <p className="max-w-full break-words rounded-[10px] bg-gg-subtle px-3 py-2 text-[11px] text-gg-muted">
            {failure.message}
          </p>
        )}
        <div className="w-full rounded-[10px] border border-gg-line bg-gg-subtle/70 p-3 text-left">
          <p className="mb-1 text-[11px] text-gg-muted">若终端显示 canvas_reset_required，请先停止 daemon，再运行：</p>
          <code className="select-all text-[11px] text-gg-ink">
            npm run canvas:v2:reset -- --apply
          </code>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="flex h-8 items-center gap-1.5 rounded-[10px] bg-gg-primary px-3 text-[13px] text-white transition-colors hover:bg-gg-select"
        >
          <RotateCcw size={14} /> 重新检查
        </button>
      </div>
    </main>
  )
}

function CanvasModelLoading() {
  return (
    <main className="flex h-screen w-screen items-center justify-center bg-gg-bg font-sans">
      <div className="flex items-center gap-2 text-[13px] text-gg-muted">
        <Loader2 size={16} className="animate-spin" /> 正在确认 Canvas V2 能力…
      </div>
    </main>
  )
}
