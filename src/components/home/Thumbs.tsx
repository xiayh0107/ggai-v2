/** 项目卡缩略图（原型演示用 SVG） */

export function ThumbMito() {
  return (
    <svg viewBox="0 0 340 150" className="h-full w-full">
      <rect width="340" height="150" fill="#F7F9FC" />
      <g fill="none" stroke="#C9D6E8" strokeWidth="1.2">
        <circle cx="70" cy="58" r="26" />
        <ellipse cx="70" cy="58" rx="15" ry="9" stroke="#E8A23A" />
        <circle cx="160" cy="58" r="26" />
        <ellipse cx="160" cy="58" rx="15" ry="9" stroke="#E8A23A" />
        <circle cx="250" cy="58" r="26" />
        <ellipse cx="250" cy="58" rx="15" ry="9" stroke="#E8A23A" />
        <path d="M 100 58 L 130 58 M 190 58 L 220 58" stroke="#98A2B3" strokeWidth="1.4" />
        <circle cx="110" cy="112" r="16" />
        <circle cx="205" cy="112" r="16" />
        <path d="M 130 112 L 185 112" stroke="#98A2B3" strokeWidth="1.4" />
      </g>
      <text x="70" y="100" textAnchor="middle" fontSize="8" fill="#667085">Autophagy</text>
      <text x="160" y="100" textAnchor="middle" fontSize="8" fill="#667085">Mitophagy</text>
      <text x="250" y="100" textAnchor="middle" fontSize="8" fill="#667085">Lysosome</text>
    </svg>
  )
}

export function ThumbBars() {
  const a = [52, 38, 30, 24]
  const b = [50, 40, 24, 20]
  return (
    <svg viewBox="0 0 340 150" className="h-full w-full">
      <rect width="340" height="150" fill="#F7F9FC" />
      {[0, 1, 2, 3].map((i) => (
        <line key={i} x1="36" y1={28 + i * 26} x2="318" y2={28 + i * 26} stroke="#E2E8F0" />
      ))}
      {a.map((v, i) => (
        <g key={i}>
          <rect x={58 + i * 70} y={132 - v} width="22" height={v} rx="2" fill="#1769E0" opacity="0.85" />
          <rect x={84 + i * 70} y={132 - b[i]} width="22" height={b[i]} rx="2" fill="#22A06B" opacity="0.7" />
          <line x1={58 + i * 70 + 11} y1={126 - v} x2={84 + i * 70 + 11} y2={126 - v} stroke="#667085" strokeWidth="1" />
          <text x={80 + i * 70} y="144" textAnchor="middle" fontSize="8" fill="#667085">指标 {i + 1}</text>
        </g>
      ))}
      <rect x="236" y="16" width="8" height="8" fill="#1769E0" opacity="0.85" />
      <text x="248" y="23" fontSize="8" fill="#667085">药物A</text>
      <rect x="278" y="16" width="8" height="8" fill="#22A06B" opacity="0.7" />
      <text x="290" y="23" fontSize="8" fill="#667085">药物B</text>
    </svg>
  )
}

export function ThumbSankey() {
  return (
    <svg viewBox="0 0 340 150" className="h-full w-full">
      <rect width="340" height="150" fill="#F7F9FC" />
      <g fill="none" strokeWidth="7" opacity="0.35">
        <path d="M 30 30 C 130 30, 190 20, 300 24" stroke="#1769E0" />
        <path d="M 30 52 C 130 52, 190 46, 300 48" stroke="#22A06B" />
        <path d="M 30 74 C 130 74, 190 74, 300 72" stroke="#E8A23A" />
        <path d="M 30 96 C 130 96, 190 100, 300 96" stroke="#7C6FCE" />
        <path d="M 30 118 C 130 118, 190 124, 300 120" stroke="#E5484D" />
      </g>
      <g fontSize="8" fill="#667085">
        <text x="24" y="33" textAnchor="end">1990</text>
        <text x="24" y="99" textAnchor="end">2010</text>
        <text x="306" y="28">电力</text>
        <text x="306" y="52">工业</text>
        <text x="306" y="76">交通</text>
        <text x="306" y="100">建筑</text>
        <text x="306" y="124">农业</text>
      </g>
    </svg>
  )
}
