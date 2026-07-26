import { useMemo } from 'react'

const HOURS = Array.from({ length: 24 }, (_, i) => i)

export default function HeatmapView({ edaData }) {
  const hourly = edaData?.temporal_distribution?.hourly
  const totalRows = edaData?.total_rows ?? 0

  if (!hourly || Object.keys(hourly).length === 0) return null

  const entries = useMemo(() => {
    return Object.entries(hourly).map(([h, v]) => [Number(h), v])
  }, [hourly])

  const maxVal = Math.max(...entries.map(([, v]) => v), 1)

  const peakInfo = useMemo(() => {
    const sorted = [...entries].sort((a, b) => b[1] - a[1])
    const top = sorted.slice(0, 3).map(([h]) => h)
    return {
      peakHours: top,
      peakDesc: top.map(h => `${String(h).padStart(2, '0')}:00`).join(', '),
      peakPct: totalRows > 0 ? ((sorted[0][1] / totalRows) * 100).toFixed(1) : '0',
    }
  }, [entries, totalRows])

  const quietInfo = useMemo(() => {
    const sorted = [...entries].sort((a, b) => a[1] - b[1])
    const bottom = sorted.slice(0, 2).map(([h]) => h)
    return {
      quietHours: bottom,
      quietDesc: bottom.map(h => `${String(h).padStart(2, '0')}:00`).join(', '),
    }
  }, [entries])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">24-Hour Transaction Density</p>
          <p className="text-sm font-semibold text-gray-900 mt-1">
            {totalRows.toLocaleString()} transactions · hourly distribution
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
          <span>low</span>
          {[0.1, 0.2, 0.35, 0.5, 0.7, 0.85, 1].map((opacity, i) => (
            <div key={i} className="w-3 h-3 rounded-sm" style={{ backgroundColor: `rgba(251, 146, 60, ${opacity})` }} />
          ))}
          <span>high</span>
        </div>
      </div>

      {/* Data-driven observation */}
      <div className="bg-orange-50/80 border border-orange-200/60 rounded-xl px-4 py-2.5 text-xs text-orange-800 leading-relaxed">
        <span className="font-semibold">Peak hour{peakInfo.peakHours.length > 1 ? 's' : ''}: </span>
        <span className="font-mono font-bold">{peakInfo.peakDesc}</span>
        {' · '}{peakInfo.peakPct}% of all transactions
        {quietInfo.quietHours.length > 0 && (
          <>
            <span className="mx-1.5 text-orange-300">|</span>
            <span className="font-semibold">Lowest: </span>
            <span className="font-mono font-bold">{quietInfo.quietDesc}</span>
          </>
        )}
      </div>

      {/* Hourly heatmap — single row showing hour-of-day distribution */}
      <div className="overflow-x-auto">
        <div className="space-y-1">
          {/* Hour labels */}
          <div className="grid grid-cols-24 gap-[3px] text-[9px] min-w-[600px]">
            {HOURS.map(h => (
              <div key={h} className="text-center font-mono text-gray-400 py-1">
                {String(h).padStart(2, '0')}
              </div>
            ))}
          </div>

          {/* Heatmap row */}
          <div className="grid grid-cols-24 gap-[3px] min-w-[600px]">
            {HOURS.map(h => {
              const val = hourly[h] ?? hourly[String(h)] ?? 0
              const intensity = maxVal > 0 ? val / maxVal : 0
              return (
                <div
                  key={h}
                  className="rounded-sm h-8 transition-all hover:ring-1 hover:ring-orange-300 cursor-default"
                  style={{
                    backgroundColor: intensity > 0
                      ? `rgba(251, 146, 60, ${0.08 + intensity * 0.75})`
                      : '#f9fafb',
                  }}
                  title={`${String(h).padStart(2, '0')}:00 — ${val.toLocaleString()} txns (${(val / totalRows * 100).toFixed(1)}%)`}
                />
              )
            })}
          </div>

          {/* Volume labels */}
          <div className="grid grid-cols-24 gap-[3px] text-[8px] font-mono text-gray-400 min-w-[600px]">
            {HOURS.map(h => {
              const val = hourly[h] ?? hourly[String(h)] ?? 0
              const pct = totalRows > 0 ? ((val / totalRows) * 100).toFixed(1) : '0'
              return (
                <div key={h} className="text-center truncate">
                  {pct}%
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Insight summary */}
      <div className="flex gap-4 text-[10px] text-gray-400 border-t border-gray-100 pt-3">
        <span>Ø {(totalRows / 24).toLocaleString(undefined, { maximumFractionDigits: 0 })} txns/hour</span>
        <span>Max: {maxVal.toLocaleString()} txns at {peakInfo.peakDesc}</span>
        <span>Range: {quietInfo.quietHours.length > 0 ? `${Math.min(...entries.map(([, v]) => v)).toLocaleString()}–${maxVal.toLocaleString()}` : ''}</span>
      </div>
    </div>
  )
}
