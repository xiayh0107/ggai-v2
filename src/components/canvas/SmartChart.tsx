import type { SmartParams } from '@/types/canvas'

/** 由 seed 生成确定性的伪随机数据（原型演示用） */
function series(seed: number, n: number): number[] {
  let s = seed * 9301 + 49297
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    s = (s * 233 + 137) % 1000
    out.push(20 + (s % 78))
  }
  return out
}

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F']

export default function SmartChart({ smart }: { smart: SmartParams }) {
  const data = series(smart.seed, 6)
  const W = 320, H = 170, padL = 30, padB = 22, padT = 10
  const iw = W - padL - 8, ih = H - padT - padB
  const max = 100

  const gridLines = [0, 25, 50, 75, 100]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full">
      {/* 网格与刻度 */}
      {gridLines.map((g) => {
        const y = padT + ih - (g / max) * ih
        return (
          <g key={g}>
            <line x1={padL} y1={y} x2={W - 8} y2={y} stroke="#E2E8F0" strokeWidth={1} />
            <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={8.5} fill="#667085">{g}</text>
          </g>
        )
      })}

      {smart.chartType === '柱状图' &&
        data.map((v, i) => {
          const bw = iw / data.length * 0.52
          const x = padL + (iw / data.length) * (i + 0.5) - bw / 2
          const h = (v / max) * ih
          return (
            <rect
              key={i} x={x} y={padT + ih - h} width={bw} height={h} rx={2.5}
              fill={i === data.length - 1 ? '#1769E0' : '#9DBEF0'}
            />
          )
        })}

      {smart.chartType !== '柱状图' && (
        <LineOrArea data={data} area={smart.chartType === '面积图'} padL={padL} padT={padT} iw={iw} ih={ih} max={max} />
      )}

      {LABELS.map((l, i) => {
        const x = smart.chartType === '柱状图'
          ? padL + (iw / data.length) * (i + 0.5)
          : padL + (iw / (data.length - 1)) * i
        return <text key={l} x={x} y={H - 7} textAnchor="middle" fontSize={8.5} fill="#667085">{l}</text>
      })}
    </svg>
  )
}

function LineOrArea({ data, area, padL, padT, iw, ih, max }: {
  data: number[]; area: boolean; padL: number; padT: number; iw: number; ih: number; max: number
}) {
  const pts = data.map((v, i) => ({
    x: padL + (iw / (data.length - 1)) * i,
    y: padT + ih - (v / max) * ih,
  }))
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  return (
    <>
      {area && (
        <path
          d={`${line} L ${pts[pts.length - 1].x} ${padT + ih} L ${pts[0].x} ${padT + ih} Z`}
          fill="#1769E0" opacity={0.08}
        />
      )}
      <path d={line} fill="none" stroke="#1769E0" strokeWidth={1.8} />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.6} fill="#fff" stroke="#1769E0" strokeWidth={1.5} />
      ))}
    </>
  )
}
