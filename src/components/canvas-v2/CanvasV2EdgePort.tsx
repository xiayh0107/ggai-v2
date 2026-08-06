import { Link2 } from 'lucide-react'

export default function CanvasV2EdgePort({
  label,
  active,
  onActivate,
}: {
  label: string
  active: boolean
  onActivate: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-edge-port
      data-no-drag
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onActivate}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/40 ${
        active
          ? 'border-gg-primary bg-[#EAF1FD] text-gg-primary'
          : 'border-gg-line bg-white text-gg-muted hover:border-gg-primary hover:text-gg-primary'
      }`}
    >
      <Link2 size={12} aria-hidden="true" />
    </button>
  )
}
