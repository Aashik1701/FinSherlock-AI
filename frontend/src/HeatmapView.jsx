import { useState, useEffect } from 'react'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

export default function HeatmapView({ edaData }) {
  if (!edaData?.temporal_distribution?.hourly && !edaData?.amount_stats) {
    // Generate an illustrative hour-of-day distribution based on standard banking / anomaly hours if full EDA data isn't expanded
    return null
  }

  const hourly = edaData?.temporal_distribution?.hourly || {}
  
  // Compute max count for color scaling
  const maxVal = Math.max(...Object.values(hourly), 1)

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
            Temporal Velocity Heatmap (Hour of Day)
          </h3>
          <p className="text-[11px] text-slate-600">
            Transaction frequency concentration across 24-hour cycle
          </p>
        </div>
      </div>

      {/* 24-hour grid */}
      <div className="grid grid-cols-12 sm:grid-cols-24 gap-1 pt-2">
        {HOURS.map(h => {
          const val = hourly[h] || hourly[String(h)] || 0
          const intensity = Math.min(val / maxVal, 1)
          
          return (
            <div key={h} className="group relative flex flex-col items-center">
              <div
                className="w-full h-8 rounded-md transition-all hover:scale-105 border border-slate-800/80 cursor-pointer"
                style={{
                  backgroundColor: intensity > 0
                    ? `rgba(59, 130, 246, ${Math.max(intensity, 0.15)})`
                    : 'rgba(30, 41, 59, 0.4)'
                }}
              />
              <span className="text-[9px] font-mono text-slate-600 mt-1">{h}h</span>

              {/* Tooltip */}
              <div className="absolute bottom-full mb-2 hidden group-hover:block z-30 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[10px] whitespace-nowrap text-slate-300 font-mono shadow-lg">
                Hour {h}:00 — {val.toLocaleString()} txns
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-600 border-t border-slate-800/60 pt-3">
        <span>Low Activity (0h–6h)</span>
        <div className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-slate-800" />
          <span>Less</span>
          <div className="w-12 h-2.5 rounded bg-gradient-to-r from-blue-900 to-blue-500" />
          <span>More</span>
        </div>
        <span>Peak Volume (10h–16h)</span>
      </div>
    </div>
  )
}
