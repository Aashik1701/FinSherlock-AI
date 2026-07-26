import { useState, useEffect, useCallback, Fragment } from 'react'
import Sparkline from './Sparkline'

const API_BASE = 'http://localhost:8000'

// ─── Helpers ───────────────────────────────────────────────────────────────

const fmtPct = (v) => `${(v * 100).toFixed(1)}%`

const TREND_ICON = {
  increasing: { label: '↑', cls: 'text-red-400', title: 'Risk increasing over time' },
  decreasing: { label: '↓', cls: 'text-emerald-400', title: 'Risk decreasing over time' },
  stable:     { label: '→', cls: 'text-slate-600', title: 'Risk stable across windows' },
}

const RISK_BADGE = {
  high:   'bg-red-950/50 text-red-300 border-red-800',
  medium: 'bg-amber-950/50 text-amber-300 border-amber-800',
  low:    'bg-emerald-950/50 text-emerald-300 border-emerald-800',
}

function riskLevel(mlProb) {
  if (mlProb >= 0.65) return 'high'
  if (mlProb >= 0.30) return 'medium'
  return 'low'
}

// ─── Sort icon ─────────────────────────────────────────────────────────────

function SortIcon({ active, direction }) {
  if (!active) return <span className="text-slate-800 ml-0.5">↕</span>
  return <span className="text-blue-400 ml-0.5">{direction === 'asc' ? '↑' : '↓'}</span>
}

// ─── Temporal detail panel (expanded row) ──────────────────────────────────

function TemporalDetail({ temporalData, loading, error }) {
  if (loading) {
    return (
      <div className="px-6 py-4 flex items-center gap-2">
        <span className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-slate-600">Loading temporal analysis…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-6 py-4">
        <p className="text-xs text-red-500">{error}</p>
      </div>
    )
  }

  if (!temporalData?.temporal_profiles?.length) {
    return (
      <div className="px-6 py-4">
        <p className="text-xs text-slate-600">No temporal data available.</p>
      </div>
    )
  }

  const profile = temporalData.temporal_profiles[0]
  const windows = profile.windows

  return (
    <div className="px-6 py-4 space-y-3">
      <div className="flex items-center gap-3">
        <p className="text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em]">
          Temporal Risk Evolution
        </p>
        <span className={`text-xs font-bold ${TREND_ICON[profile.trend]?.cls ?? 'text-slate-600'}`}>
          {TREND_ICON[profile.trend]?.label} {profile.trend}
        </span>
      </div>

      <div className="bg-slate-950/50 border border-slate-800 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/60">
              <th className="text-left px-3 py-2 text-slate-600 font-semibold">Window</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">ML Prob</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Structuring</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Smurfing</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Layering</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Risk Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {windows.map((w) => {
              const rl = riskLevel(w.ml_prob)
              return (
                <tr key={w.window_days} className="hover:bg-slate-800/20 transition-colors">
                  <td className="px-3 py-2 font-mono font-semibold text-slate-300">
                    {w.window_days}d
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    <span className={
                      rl === 'high' ? 'text-red-400' :
                      rl === 'medium' ? 'text-amber-400' :
                      'text-emerald-400'
                    }>
                      {fmtPct(w.ml_prob)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">
                    {w.structuring_count > 0 ? (
                      <span className={w.structuring_count >= 4 ? 'text-red-400' : 'text-amber-400'}>
                        {w.structuring_count}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">
                    {w.smurfing_fan_out > 0 || w.smurfing_fan_in > 0 ? (
                      <span className="text-violet-400">
                        {w.smurfing_fan_out}/{w.smurfing_fan_in}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">
                    {w.layering_hops > 0 ? (
                      <span className="text-amber-400">{w.layering_hops}</span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    <span className={`font-semibold ${
                      w.composite_risk >= 65 ? 'text-red-400' :
                      w.composite_risk >= 40 ? 'text-amber-400' :
                      'text-emerald-400'
                    }`}>
                      {w.composite_risk.toFixed(1)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Main Watchlist component ──────────────────────────────────────────────

export default function Watchlist() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sortCol, setSortCol] = useState('ml_probability')
  const [sortDir, setSortDir] = useState('desc')
  const [expanded, setExpanded] = useState(null) // account_id
  const [temporalData, setTemporalData] = useState(null)
  const [temporalLoading, setTemporalLoading] = useState(false)
  const [temporalError, setTemporalError] = useState(null)
  const [sparklineData, setSparklineData] = useState({}) // account_id → [{label, value}]

  // Fetch watchlist on mount, then pre-fetch temporal for top 10
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${API_BASE}/watchlist?top_n=50`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(async data => {
        if (cancelled) return
        const accts = data.scored_accounts ?? []
        setAccounts(accts)

        // Pre-fetch temporal for top 10 accounts (parallel)
        const top10 = accts.slice(0, 10)
        if (top10.length > 0) {
          const ids = top10.map(a => a.account_id).join(',')
          try {
            const res = await fetch(
              `${API_BASE}/watchlist/temporal?account_ids=${ids}&windows=7,30,90`
            )
            if (!res.ok || cancelled) return
            const temporal = await res.json()
            if (cancelled) return
            const sparks = {}
            for (const p of temporal.temporal_profiles ?? []) {
              sparks[p.account_id] = p.windows.map(w => ({
                label: `${w.window_days}d`,
                value: w.composite_risk,
              }))
            }
            setSparklineData(sparks)
          } catch { /* sparklines optional */ }
        }
      })
      .catch(e => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Fetch temporal data when row expanded
  const fetchTemporal = useCallback(async (accountId) => {
    setTemporalLoading(true)
    setTemporalError(null)
    setTemporalData(null)
    try {
      const res = await fetch(
        `${API_BASE}/watchlist/temporal?account_ids=${accountId}&windows=7,30,90`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTemporalData(data)
    } catch (e) {
      setTemporalError(e.message)
    } finally {
      setTemporalLoading(false)
    }
  }, [])

  const toggleExpand = (acctId) => {
    if (expanded === acctId) {
      setExpanded(null)
      setTemporalData(null)
    } else {
      setExpanded(acctId)
      fetchTemporal(acctId)
    }
  }

  // Sort
  const handleSort = (col) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('desc')
    }
  }

  const sorted = [...accounts].sort((a, b) => {
    const av = a[sortCol] ?? 0
    const bv = b[sortCol] ?? 0
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return sortDir === 'asc' ? av - bv : bv - av
  })


  return (
    <section className="space-y-4">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
            Risk Watchlist
          </h2>
          <p className="text-xs text-slate-600">
            {accounts.length} accounts ranked by ML probability · daily analyst briefing
          </p>
        </div>
        {accounts.length > 0 && (
          <div className="flex items-center gap-4 text-[10px] text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
              {accounts.filter(a => a.ml_probability >= 0.65).length} high
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              {accounts.filter(a => a.ml_probability >= 0.30 && a.ml_probability < 0.65).length} medium
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {accounts.filter(a => a.ml_probability < 0.30).length} low
            </span>
          </div>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex items-center gap-3">
          <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-slate-300">Loading watchlist…</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-950/20 border border-red-900/40 rounded-2xl p-5 flex gap-4">
          <span className="text-red-500 text-base shrink-0 mt-0.5">!</span>
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-semibold text-red-300">Watchlist Failed</p>
            <p className="text-xs text-red-500 break-words">{error}</p>
          </div>
        </div>
      )}

      {/* Table */}
      {!loading && !error && accounts.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/80">
                  <th className="text-left px-4 py-3 text-slate-600 font-semibold w-10">#</th>
                  <th
                    className="text-left px-4 py-3 text-slate-600 font-semibold cursor-pointer hover:text-slate-400 transition-colors"
                    onClick={() => handleSort('account_id')}
                  >
                    Account <SortIcon active={sortCol === 'account_id'} direction={sortDir} />
                  </th>
                  <th
                    className="text-right px-4 py-3 text-slate-600 font-semibold cursor-pointer hover:text-slate-400 transition-colors"
                    onClick={() => handleSort('ml_probability')}
                  >
                    ML Prob <SortIcon active={sortCol === 'ml_probability'} direction={sortDir} />
                  </th>
                  <th
                    className="text-right px-4 py-3 text-slate-600 font-semibold cursor-pointer hover:text-slate-400 transition-colors"
                    onClick={() => handleSort('txn_count')}
                  >
                    Txns <SortIcon active={sortCol === 'txn_count'} direction={sortDir} />
                  </th>
                  <th className="text-center px-4 py-3 text-slate-600 font-semibold">Flagged</th>
                  <th className="text-center px-4 py-3 text-slate-600 font-semibold">Trend</th>
                  <th className="w-24 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40">
                {sorted.map((acct, i) => {
                  const rl = riskLevel(acct.ml_probability)
                  const isExpanded = expanded === acct.account_id
                  return (
                    <Fragment key={acct.account_id}>
                      <tr
                        className={`hover:bg-slate-800/20 transition-colors cursor-pointer ${
                          isExpanded ? 'bg-slate-800/10' : ''
                        }`}
                        onClick={() => toggleExpand(acct.account_id)}
                      >
                        <td className="px-4 py-3 font-mono text-slate-700">{i + 1}</td>
                        <td className="px-4 py-3 font-mono font-bold text-slate-100">
                          {acct.account_id}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          <span className={`font-bold ${
                            rl === 'high' ? 'text-red-400' :
                            rl === 'medium' ? 'text-amber-400' :
                            'text-emerald-400'
                          }`}>
                            {fmtPct(acct.ml_probability)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-400">
                          {acct.txn_count.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {acct.ml_flagged ? (
                            <span className="inline-flex px-2 py-0.5 rounded border text-[9px] font-bold uppercase tracking-widest bg-red-950/50 text-red-300 border-red-800">
                              Yes
                            </span>
                          ) : (
                            <span className="text-slate-700">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <div className="flex justify-center">
                            {sparklineData[acct.account_id] ? (
                              <Sparkline
                                data={sparklineData[acct.account_id]}
                                width={64}
                                height={22}
                              />
                            ) : (
                              <Sparkline
                                data={[{ label: 'current', value: acct.ml_probability * 100 }]}
                                width={48}
                                height={20}
                              />
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-slate-700 text-[10px]">
                            {isExpanded ? '▲' : '▼'}
                          </span>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={7} className="p-0 border-t border-slate-800/60 bg-slate-950/30">
                            <TemporalDetail
                              temporalData={temporalData}
                              loading={temporalLoading}
                              error={temporalError}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && accounts.length === 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl px-6 py-14 text-center space-y-2">
          <p className="text-slate-500 font-medium">No accounts in watchlist</p>
          <p className="text-xs text-slate-700 max-w-md mx-auto leading-relaxed">
            Load the IBM AML dataset and run the XGBoost training script to populate the watchlist.
          </p>
        </div>
      )}
    </section>
  )
}
