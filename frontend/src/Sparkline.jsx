/**
 * Sparkline — pure SVG mini line chart for temporal risk evolution.
 *
 * Props:
 *   data    — [{ label: string, value: number }]
 *   width   — SVG width (default 80)
 *   height  — SVG height (default 28)
 *   color   — override color (default auto from max value)
 */

const COLORS = {
  high:   '#f87171', // red-400
  medium: '#fbbf24', // amber-400
  low:    '#34d399', // emerald-400
}

function riskColor(maxVal) {
  if (maxVal >= 65) return COLORS.high
  if (maxVal >= 40) return COLORS.medium
  return COLORS.low
}

export default function Sparkline({ data = [], width = 80, height = 28, color }) {
  if (!data.length) return null

  const values = data.map(d => d.value)
  const maxVal = Math.max(...values, 1)
  const minVal = 0
  const range = maxVal - minVal || 1

  const padX = 4
  const padY = 4
  const plotW = width - padX * 2
  const plotH = height - padY * 2

  const points = values.map((v, i) => ({
    x: padX + (i / Math.max(values.length - 1, 1)) * plotW,
    y: padY + plotH - ((v - minVal) / range) * plotH,
  }))

  const lineColor = color || riskColor(maxVal)

  // Build SVG path
  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
    >
      {/* Line */}
      <path
        d={pathD}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Dots */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x.toFixed(1)}
          cy={p.y.toFixed(1)}
          r="2.5"
          fill={lineColor}
          stroke="#0f172a"
          strokeWidth="1"
        />
      ))}
    </svg>
  )
}
