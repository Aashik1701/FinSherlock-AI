import { useMemo, useState } from 'react'

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtUSD = n =>
  typeof n === 'number'
    ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : '—'

const RISK_CLS = {
  high:   'bg-red-950/60 text-red-300 border-red-800',
  medium: 'bg-amber-950/60 text-amber-300 border-amber-800',
  low:    'bg-slate-800 text-slate-400 border-slate-700',
}

const ESC_CLS = {
  report:  'text-red-400',
  review:  'text-amber-400',
  monitor: 'text-emerald-400',
}

// ─── Circular ring SVG renderer ──────────────────────────────────────────────

function RingGraph({ members, accountColors }) {
  const count  = members.length
  const cx     = 120
  const cy     = 120
  const r      = 85
  const nodeR  = 10

  const points = members.map((_, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    }
  })

  return (
    <svg viewBox="0 0 240 240" className="w-full max-w-[200px] mx-auto">
      {/* Centre hub glow */}
      <circle cx={cx} cy={cy} r="28" className="fill-rose-950/40" />
      <circle cx={cx} cy={cy} r="20" className="fill-rose-900/30" strokeWidth="1" stroke="#f43f5e" strokeDasharray="4 3" />
      <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" className="fill-rose-400 text-[7px] font-bold" fontSize="7" fontFamily="monospace">RING</text>

      {/* Edges: each member connects to center hub */}
      {points.map((p, i) => (
        <line
          key={i}
          x1={cx} y1={cy}
          x2={p.x} y2={p.y}
          stroke="#f43f5e"
          strokeWidth="1"
          strokeDasharray="3 2"
          opacity="0.35"
        />
      ))}

      {/* Circular flow arrows between adjacent members */}
      {points.map((p, i) => {
        const next = points[(i + 1) % count]
        const mx   = (p.x + next.x) / 2
        const my   = (p.y + next.y) / 2
        return (
          <g key={`arrow-${i}`}>
            <line x1={p.x} y1={p.y} x2={next.x} y2={next.y} stroke="#6366f1" strokeWidth="0.8" opacity="0.3" />
            {/* Arrow head at midpoint */}
            <circle cx={mx} cy={my} r="1.5" fill="#6366f1" opacity="0.5" />
          </g>
        )
      })}

      {/* Member nodes */}
      {points.map((p, i) => (
        <g key={`node-${i}`}>
          <circle
            cx={p.x} cy={p.y} r={nodeR}
            fill="#0f172a"
            stroke={accountColors[i % accountColors.length]}
            strokeWidth="1.5"
          />
          <text
            x={p.x} y={p.y + 0.5}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="5"
            fontFamily="monospace"
            fill="#94a3b8"
          >
            {String(members[i]).slice(-4)}
          </text>
        </g>
      ))}
    </svg>
  )
}

// ─── Ring card ───────────────────────────────────────────────────────────────

function RingCard({ ring, index }) {
  const [expanded, setExpanded] = useState(false)
  const riskCls  = RISK_CLS[ring.risk_level]  ?? RISK_CLS.low
  const escColor = ESC_CLS[ring.escalation]   ?? 'text-slate-400'

  // Generate consistent node colours
  const PALETTE = ['#f43f5e', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#06b6d4', '#ec4899', '#a3e635']
  const accountColors = PALETTE

  // Show at most 8 nodes in the ring graph (clip large rings)
  const graphMembers = ring.member_accounts.slice(0, 8)

  return (
    <article className="bg-slate-900 border border-slate-800 border-l-4 border-l-rose-600 rounded-2xl overflow-hidden">
      {/* Header */}
      <header className="px-4 sm:px-5 pt-4 pb-3 border-b border-slate-800/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-rose-400 font-bold text-xs font-mono">
            🔴 RING-{String(index + 1).padStart(2, '0')}
          </span>
          <span className={`px-2.5 py-0.5 rounded border text-[10px] font-bold uppercase tracking-widest ${riskCls}`}>
            {ring.risk_level} risk
          </span>
          <span className="text-slate-600 font-mono text-[10px]">
            score <span className="text-rose-400 font-bold">{ring.suspicion_score.toFixed(0)}</span>/100
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-bold uppercase tracking-wider ${escColor}`}>
            → {ring.escalation}
          </span>
          <button
            onClick={() => setExpanded(e => !e)}
            className="px-3 py-1 rounded-lg border border-slate-700 bg-slate-800/60 hover:bg-slate-700 text-[10px] text-slate-400 hover:text-slate-200 transition-all font-semibold"
          >
            {expanded ? 'Collapse ▲' : 'Expand ▼'}
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="p-4 sm:p-5 space-y-4">
        {/* Ring metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-slate-950/50 border border-slate-800 rounded-xl px-3 py-2.5 space-y-0.5">
            <p className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Members</p>
            <p className="text-lg font-bold font-mono text-rose-400">{ring.member_count}</p>
            <p className="text-[9px] text-slate-700">coordinated accounts</p>
          </div>
          <div className="bg-slate-950/50 border border-slate-800 rounded-xl px-3 py-2.5 space-y-0.5">
            <p className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Internal Volume</p>
            <p className="text-lg font-bold font-mono text-amber-400">{fmtUSD(ring.internal_volume_usd)}</p>
            <p className="text-[9px] text-slate-700">{ring.internal_txn_count} txns inside ring</p>
          </div>
          <div className="bg-slate-950/50 border border-slate-800 rounded-xl px-3 py-2.5 space-y-0.5">
            <p className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Internal Ratio</p>
            <p className="text-lg font-bold font-mono text-sky-400">{(ring.internal_ratio * 100).toFixed(0)}%</p>
            <p className="text-[9px] text-slate-700">txns staying inside ring</p>
          </div>
          <div className="bg-slate-950/50 border border-slate-800 rounded-xl px-3 py-2.5 space-y-0.5">
            <p className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Graph Density</p>
            <p className="text-lg font-bold font-mono text-violet-400">{(ring.graph_density * 100).toFixed(0)}%</p>
            <p className="text-[9px] text-slate-700">cluster cohesion</p>
          </div>
        </div>

        {/* Ring graph + member list */}
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          {/* Circular graph */}
          <div className="shrink-0 w-full sm:w-48">
            <RingGraph members={graphMembers} accountColors={accountColors} />
            {ring.member_accounts.length > 8 && (
              <p className="text-[10px] text-slate-700 text-center mt-1">
                +{ring.member_accounts.length - 8} more accounts
              </p>
            )}
          </div>

          {/* Member account chips */}
          <div className="flex-1 space-y-2">
            <p className="text-[9px] font-bold text-slate-600 uppercase tracking-wider">Ring Members</p>
            <div className="flex flex-wrap gap-1.5">
              {ring.member_accounts.map((acc, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 rounded-md border border-rose-900/50 bg-rose-950/30 text-[10px] text-rose-300 font-mono"
                >
                  {acc}
                </span>
              ))}
            </div>
            {ring.avg_ml_risk > 0 && (
              <p className="text-[10px] text-slate-600">
                Avg ML risk: <span className="text-amber-400 font-mono font-bold">{(ring.avg_ml_risk * 100).toFixed(1)}%</span>
              </p>
            )}
          </div>
        </div>

        {/* Sample transactions inside the ring */}
        {expanded && ring.sample_transactions?.length > 0 && (
          <div className="space-y-2">
            <p className="text-[9px] font-bold text-slate-600 uppercase tracking-wider">Sample Internal Transactions</p>
            <div className="bg-slate-950/50 border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/60">
                    <th className="text-left px-3 py-2 text-slate-600 font-semibold">Sender</th>
                    <th className="text-left px-3 py-2 text-slate-600 font-semibold">Receiver</th>
                    <th className="text-right px-3 py-2 text-slate-600 font-semibold">Amount</th>
                    <th className="text-right px-3 py-2 text-slate-600 font-semibold">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  {ring.sample_transactions.map((t, i) => (
                    <tr key={i} className="hover:bg-slate-800/20 transition-colors">
                      <td className="px-3 py-1.5 font-mono text-rose-300/80 text-[10px]">{t.sender}</td>
                      <td className="px-3 py-1.5 font-mono text-sky-300/80 text-[10px]">{t.receiver}</td>
                      <td className="px-3 py-1.5 text-right font-mono font-semibold text-slate-200">{fmtUSD(t.amount)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-slate-600 text-[10px]">
                        {typeof t.timestamp === 'string' ? t.timestamp.slice(0, 16) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SAR recommendation */}
        {ring.risk_level === 'high' && (
          <div className="bg-red-950/20 border border-red-900/40 rounded-xl px-4 py-2.5 flex items-center gap-2.5">
            <span className="text-red-400 text-sm shrink-0">⚠</span>
            <p className="text-[11px] text-red-300">
              <span className="font-bold">SAR Recommended:</span> Coordinated ring of {ring.member_count} accounts with {(ring.internal_ratio * 100).toFixed(0)}% internal circulation. File BSA Suspicious Activity Report covering all member accounts.
            </p>
          </div>
        )}
      </div>
    </article>
  )
}

// ─── Velocity Spike Card ─────────────────────────────────────────────────────

function VelocitySpikeSection({ velocityData }) {
  if (!velocityData?.flagged_accounts?.length) return null

  const accounts = velocityData.flagged_accounts.slice(0, 5)

  return (
    <div className="space-y-3">
      <p className="text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em]">
        ⚡ Velocity Spikes — Top {accounts.length} of {velocityData.flagged_accounts.length}
      </p>
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/60">
              <th className="text-left px-3 py-2 text-slate-600 font-semibold">Account</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Current (txn/day)</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Baseline</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Spike</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Volume</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Risk</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {accounts.map((acct, i) => (
              <tr key={i} className="hover:bg-slate-800/20 transition-colors">
                <td className="px-3 py-2 font-mono text-orange-300 text-[10px]">{acct.account_id}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-200 font-semibold">{acct.current_velocity_per_day.toFixed(1)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-500">{acct.baseline_velocity_per_day.toFixed(1)}</td>
                <td className="px-3 py-2 text-right font-mono font-bold text-orange-400">{acct.spike_ratio.toFixed(1)}×</td>
                <td className="px-3 py-2 text-right font-mono text-slate-300">{fmtUSD(acct.total_volume_recent_usd)}</td>
                <td className="px-3 py-2 text-right">
                  <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${
                    acct.risk_level === 'high' ? 'bg-red-950/60 text-red-300' : 'bg-amber-950/60 text-amber-300'
                  }`}>
                    {acct.risk_level}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Root export ─────────────────────────────────────────────────────────────

export default function RingView({ muleRingData, velocityData }) {
  const hasRings    = (muleRingData?.rings?.length    ?? 0) > 0
  const hasVelocity = (velocityData?.flagged_accounts?.length ?? 0) > 0

  if (!hasRings && !hasVelocity) return null

  return (
    <section className="space-y-6">
      {/* Mule rings */}
      {hasRings && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
                Money Mule Rings
              </h2>
              <p className="text-[11px] text-slate-700">
                {muleRingData.rings.length} suspicious communit{muleRingData.rings.length === 1 ? 'y' : 'ies'} detected
                · {muleRingData.communities_scanned} total communities scanned
                · Louvain community detection
              </p>
            </div>
            <span className="text-[9px] font-bold text-rose-400 border border-rose-900/50 bg-rose-950/30 px-2 py-0.5 rounded uppercase tracking-wider">
              🔴 AML Alert
            </span>
          </div>

          <div className="space-y-4">
            {muleRingData.rings.map((ring, i) => (
              <RingCard key={ring.community_id ?? i} ring={ring} index={i} />
            ))}
          </div>
        </div>
      )}

      {/* Velocity spikes */}
      {hasVelocity && (
        <div className="bg-slate-900/80 border border-orange-900/30 rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold text-orange-400 uppercase tracking-[0.2em]">
                Transaction Velocity Spikes
              </p>
              <p className="text-[11px] text-slate-600 mt-0.5">
                Accounts with sudden {velocityData.spike_ratio_threshold}× or greater surge vs {velocityData.baseline_days}-day baseline
              </p>
            </div>
            <span className="text-[9px] font-bold text-orange-400 border border-orange-900/50 bg-orange-950/30 px-2 py-0.5 rounded uppercase tracking-wider">
              ⚡ Velocity Alert
            </span>
          </div>
          <VelocitySpikeSection velocityData={velocityData} />
        </div>
      )}
    </section>
  )
}
