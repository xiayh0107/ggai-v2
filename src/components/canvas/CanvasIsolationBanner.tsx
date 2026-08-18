export default function CanvasIsolationBanner({
  nodeId,
  onClose,
}: {
  nodeId: string
  onClose: () => void
}) {
  return (
    <div
      data-testid="canvas-isolation-banner"
      data-isolation-node-id={nodeId}
      className="absolute left-1/2 top-4 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-[12px] border border-gg-line bg-white px-3 py-2 text-[11px] text-gg-ink shadow-sm"
    >
      <span>组合隔离编辑</span>
      <button type="button" onClick={onClose} className="rounded-[7px] bg-gg-subtle px-2 py-1 text-gg-primary">
        退出
      </button>
    </div>
  )
}
