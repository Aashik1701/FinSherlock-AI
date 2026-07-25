const COLORS = {
  high:   '#ef4444',
  medium: '#f59e0b',
  low:    '#22c55e',
}

const cx = 100, cy = 108, r = 78
const CIRC = Math.PI * r // half-circle arc length

export default function RiskGauge({ score = 0, riskLevel = 'low', uid = 'g' }) {
  const s = Math.min(Math.max(score, 0.5), 99.5)
  const filled = (s / 100) * CIRC
  const color = COLORS[riskLevel] ?? '#94a3b8'

  // Needle tip
  const angle = (1 - s / 100) * Math.PI
  const nx = cx + (r - 18) * Math.cos(angle)
  const ny = cy - (r - 18) * Math.sin(angle)

  // Zone markers at 33 and 66
  const ticks = [0, 25, 50, 75, 100]
  const zones = [
    { from: 0,  to: 33,  color: '#16a34a22' },
    { from: 33, to: 66,  color: '#d9770622' },
    { from: 66, to: 100, color: '#dc262622' },
  ]

  const filterId = `glow-${uid}`

  return (
    <svg viewBox="0 0 200 148" className="w-full select-none" aria-label={`Risk gauge: ${score?.toFixed(0)} ${riskLevel}`}>
      <defs>
        <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <linearGradient id={`track-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stopColor="#22c55e" stopOpacity="0.6" />
          <stop offset="50%"  stopColor="#f59e0b" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0.6" />
        </linearGradient>
      </defs>

      {/* Background track */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none" stroke="#1e293b" strokeWidth={16} strokeLinecap="round"
      />

      {/* Gradient full track (subtle) */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none" stroke={`url(#track-${uid})`} strokeWidth={16} strokeLinecap="round"
        opacity={0.3}
      />

      {/* Filled arc up to score */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none" stroke={color} strokeWidth={16} strokeLinecap="round"
        strokeDasharray={`${filled} ${CIRC}`}
        filter={`url(#${filterId})`}
        opacity={0.95}
      />

      {/* Tick marks */}
      {ticks.map(tick => {
        const a = (1 - tick / 100) * Math.PI
        const ox = cx + (r + 6) * Math.cos(a)
        const oy = cy - (r + 6) * Math.sin(a)
        const ix = cx + (r + 13) * Math.cos(a)
        const iy = cy - (r + 13) * Math.sin(a)
        return <line key={tick} x1={ox} y1={oy} x2={ix} y2={iy} stroke="#334155" strokeWidth={1.5} />
      })}

      {/* Zone labels */}
      <text x={cx - r - 4} y={cy + 18} textAnchor="middle" fill="#22c55e" fontSize={8} fontFamily="monospace" opacity={0.7}>0</text>
      <text x={cx + r + 4} y={cy + 18} textAnchor="middle" fill="#ef4444" fontSize={8} fontFamily="monospace" opacity={0.7}>100</text>

      {/* Needle */}
      <line
        x1={cx} y1={cy} x2={nx} y2={ny}
        stroke={color} strokeWidth={2.5} strokeLinecap="round" opacity={0.9}
      />
      <circle cx={cx} cy={cy} r={5} fill={color} opacity={0.9} />
      <circle cx={cx} cy={cy} r={2} fill="#020617" />

      {/* Score */}
      <text x={cx} y={cy - 16} textAnchor="middle" fill={color}
        fontSize={30} fontWeight="700" fontFamily="monospace">
        {score?.toFixed(0) ?? '—'}
      </text>

      {/* Risk level label */}
      <text x={cx} y={cy + 6} textAnchor="middle" fill="#475569"
        fontSize={9} fontFamily="sans-serif" letterSpacing={2.5} fontWeight="600">
        {riskLevel?.toUpperCase()} RISK
      </text>
    </svg>
  )
}
