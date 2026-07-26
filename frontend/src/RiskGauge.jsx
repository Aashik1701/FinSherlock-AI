export default function RiskGauge({ score = 0, riskLevel = 'low', uid = '' }) {
  const normalized = Math.min(Math.max(score, 0), 100)
  const angle = (normalized / 100) * 180
  const radians = (angle * Math.PI) / 180
  const color = riskLevel === 'high' ? '#ef4444' : riskLevel === 'medium' ? '#f59e0b' : '#10b981'
  const bgColor = riskLevel === 'high' ? '#fef2f2' : riskLevel === 'medium' ? '#fffbeb' : '#ecfdf5'

  const cx = 80, cy = 80, r = 60
  const endX = cx + r * Math.sin(radians)
  const endY = cy - r * Math.cos(radians)

  return (
    <div className="flex flex-col items-center" style={{ backgroundColor: bgColor, borderRadius: '12px', padding: '8px' }}>
      <svg viewBox="0 0 160 100" className="w-full">
        {/* Background arc */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="12"
          strokeLinecap="round"
        />
        {/* Score arc */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${endX} ${endY}`}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          style={{ transition: 'all 0.8s ease-out' }}
        />
        {/* Center text */}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="24" fontWeight="bold" fill={color} fontFamily="inherit">
          {normalized.toFixed(0)}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="9" fill="#9ca3af" fontFamily="monospace">
          / 100
        </text>
      </svg>
      <span className={`text-[10px] font-bold uppercase tracking-wider mt-1 ${
        riskLevel === 'high' ? 'text-red-600' : riskLevel === 'medium' ? 'text-amber-600' : 'text-emerald-600'
      }`}>
        {riskLevel} risk
      </span>
    </div>
  )
}
