import { useState, useEffect, useCallback, Fragment } from 'react'
import Sparkline from './Sparkline'
import { API_BASE } from './api'

const fmtPct = (v) => `${(v * 100).toFixed(1)}%`

const TREND_ICON = {
  increasing: { label: '↑', cls: 'text-[var(--red)]', title: 'Risk increasing' },
  decreasing: { label: '↓', cls: 'text-[var(--emerald)]', title: 'Risk decreasing' },
  stable:     { label: '→', cls: 'text-[var(--text-muted)]', title: 'Risk stable' },
}

const RISK_BADGE = {
  high:   'badge-red',
  medium: 'badge-amber',
  low:    'badge-emerald',
}

function riskLevel(mlProb) {
  if (mlProb >= 0.65) return 'high'
  if (mlProb >= 0.30) return 'medium'
  return 'low'
}

function SortIcon({ active, direction }) {
  if (!active) return <span className="text-[var(--text-muted)] ml-0.5">↕</span>
  return <span className="text-orange-500 ml-0.5">{direction === 'asc' ? '↑' : '↓'}</span>
}

function TemporalDetail({ temporalData, loading, error }) {
  if (loading) return <div className="px-6 py-4 flex items-center gap-2"><span className="w-3.5 h-3.5 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" /><span className="text-xs text-[var(--text-secondary)]">Loading temporal analysis…</span></div>
  if (error) return <div className="px-6 py-4"><p className="text-xs text-red-600">{error}</p></div>
  if (!temporalData?.temporal_profiles?.length) return <div className="px-6 py-4"><p className="text-xs text-[var(--text-muted)]">No temporal data available.</p></div>

  const profile = temporalData.temporal_profiles[0]
  const windows = profile.windows

  return (
    <div className="px-6 py-4 space-y-3 bg-[var(--bg-card-hover)]">
      <div className="flex items-center gap-3">
        <p className="eyebrow">Temporal Risk Evolution</p>
        <span className={`text-xs font-bold ${TREND_ICON[profile.trend]?.cls ?? 'text-[var(--text-secondary)]'}`}>
          {TREND_ICON[profile.trend]?.label} {profile.trend}
        </span>
      </div>
      <div className="border border-[var(--border-card)] rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--border-card)] bg-[var(--bg-card)]">
              <th className="text-left px-3 py-2 text-[var(--text-secondary)] font-semibold">Window</th>
              <th className="text-right px-3 py-2 text-[var(--text-secondary)] font-semibold">ML Prob</th>
              <th className="text-right px-3 py-2 text-[var(--text-secondary)] font-semibold">Structuring</th>
              <th className="text-right px-3 py-2 text-[var(--text-secondary)] font-semibold">Smurfing</th>
              <th className="text-right px-3 py-2 text-[var(--text-secondary)] font-semibold">Layering</th>
              <th className="text-right px-3 py-2 text-[var(--text-secondary)] font-semibold">Risk Score</th>
            </tr>
          </thead>
              <tbody className="divide-y divide-[var(--border-card)]">
            {windows.map((w) => {
              const rl = riskLevel(w.ml_prob)
              return (
                <tr key={w.window_days} className="hover:bg-[var(--bg-card-hover)] transition-colors bg-[var(--bg-card)]">
                  <td className="px-3 py-2 font-mono font-semibold text-[var(--text-primary)]">{w.window_days}d</td>
                  <td className="px-3 py-2 text-right font-mono">
                    <span className={rl === 'high' ? 'text-red-600' : rl === 'medium' ? 'text-amber-600' : 'text-emerald-600'}>{fmtPct(w.ml_prob)}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--text-secondary)]">{w.structuring_count > 0 ? <span className={w.structuring_count >= 4 ? 'text-red-600' : 'text-amber-600'}>{w.structuring_count}</span> : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--text-secondary)]">{w.smurfing_fan_out > 0 || w.smurfing_fan_in > 0 ? <span className="text-violet-600">{w.smurfing_fan_out}/{w.smurfing_fan_in}</span> : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--text-secondary)]">{w.layering_hops > 0 ? <span className="text-amber-600">{w.layering_hops}</span> : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    <span className={`font-semibold ${w.composite_risk >= 65 ? 'text-red-600' : w.composite_risk >= 40 ? 'text-amber-600' : 'text-emerald-600'}`}>{w.composite_risk.toFixed(1)}</span>
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

export default function Watchlist() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sortCol, setSortCol] = useState('ml_probability')
  const [sortDir, setSortDir] = useState('desc')
  const [expanded, setExpanded] = useState(null)
  const [temporalData, setTemporalData] = useState(null)
  const [temporalLoading, setTemporalLoading] = useState(false)
  const [temporalError, setTemporalError] = useState(null)
  const [sparklineData, setSparklineData] = useState({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${API_BASE}/watchlist?top_n=50`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(async data => {
        if (cancelled) return
        const accts = data.scored_accounts ?? []
        setAccounts(accts)
        const top10 = accts.slice(0, 10)
        if (top10.length > 0) {
          const ids = top10.map(a => a.account_id).join(',')
          try {
            const res = await fetch(`${API_BASE}/watchlist/temporal?account_ids=${ids}&windows=7,30,90`)
            if (!res.ok || cancelled) return
            const temporal = await res.json()
            if (cancelled) return
            const sparks = {}
            for (const p of temporal.temporal_profiles ?? []) {
              sparks[p.account_id] = p.windows.map(w => ({ label: `${w.window_days}d`, value: w.composite_risk }))
            }
            setSparklineData(sparks)
          } catch { /* optional */ }
        }
      })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const fetchTemporal = useCallback(async (accountId) => {
    setTemporalLoading(true)
    setTemporalError(null)
    setTemporalData(null)
    try {
      const res = await fetch(`${API_BASE}/watchlist/temporal?account_ids=${accountId}&windows=7,30,90`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setTemporalData(await res.json())
    } catch (e) { setTemporalError(e.message) }
    finally { setTemporalLoading(false) }
  }, [])

  const toggleExpand = (acctId) => {
    if (expanded === acctId) { setExpanded(null); setTemporalData(null) }
    else { setExpanded(acctId); fetchTemporal(acctId) }
  }

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const sorted = [...accounts].sort((a, b) => {
    const av = a[sortCol] ?? 0; const bv = b[sortCol] ?? 0
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return sortDir === 'asc' ? av - bv : bv - av
  })

  return (
    <section className="space-y-4">
      <div>
        <p className="eyebrow">Risk Watchlist</p>
        <p className="text-sm text-[var(--text-secondary)] mt-0.5">
          {accounts.length} accounts ranked by ML probability · daily analyst briefing
        </p>
      </div>

      {loading && (
        <div className="card flex items-center gap-3">
          <span className="w-4 h-4 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-[var(--text-secondary)]">Loading watchlist…</span>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5 flex gap-4">
          <span className="text-red-500 text-base shrink-0 mt-0.5 font-bold">!</span>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-red-800">Watchlist Failed</p>
            <p className="text-xs text-red-600 break-words">{error}</p>
          </div>
        </div>
      )}

      {!loading && !error && accounts.length > 0 && (
        <div className="card !p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border-card)] bg-[var(--bg-card-hover)]">
                  <th className="text-left px-4 py-3 text-[var(--text-secondary)] font-semibold w-8">#</th>
                  <th className="text-left px-4 py-3 text-[var(--text-secondary)] font-semibold cursor-pointer hover:text-[var(--text-primary)]" onClick={() => handleSort('account_id')}>
                    Account <SortIcon active={sortCol === 'account_id'} direction={sortDir} />
                  </th>
                  <th className="text-center px-4 py-3 text-[var(--text-secondary)] font-semibold">Score</th>
                  <th className="text-right px-4 py-3 text-[var(--text-secondary)] font-semibold cursor-pointer hover:text-[var(--text-primary)]" onClick={() => handleSort('txn_count')}>
                    Txns <SortIcon active={sortCol === 'txn_count'} direction={sortDir} />
                  </th>
                  <th className="text-center px-4 py-3 text-[var(--text-secondary)] font-semibold">Capital at Risk</th>
                  <th className="text-center px-4 py-3 text-[var(--text-secondary)] font-semibold">Trend</th>
                  <th className="w-16 px-4 py-3" />
                </tr>
              </thead>
          <tbody className="divide-y divide-[var(--border-card)]">
                {sorted.map((acct, i) => {
                  const rl = riskLevel(acct.ml_probability)
                  const isExpanded = expanded === acct.account_id
                  const capitalAtRisk = (acct.total_volume ?? 0) * acct.ml_probability
                  return (
                    <Fragment key={acct.account_id}>
                      <tr className={`hover:bg-[var(--bg-card-hover)] transition-colors cursor-pointer ${isExpanded ? 'bg-[var(--orange-bg)]/50' : ''}`} onClick={() => toggleExpand(acct.account_id)}>
                        <td className="px-4 py-3 font-mono text-[var(--text-muted)]">{i + 1}</td>
                        <td className="px-4 py-3 font-mono font-bold text-[var(--text-primary)]">{acct.account_id}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${RISK_BADGE[rl]}`}>
                            {fmtPct(acct.ml_probability)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-[var(--text-secondary)]">{acct.txn_count?.toLocaleString()}</td>
                        <td className="px-4 py-3 text-center font-mono text-[var(--text-secondary)]">
                          {capitalAtRisk > 1000 ? `$${(capitalAtRisk / 1000).toFixed(0)}K` : '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <div className="flex justify-center">
                            {sparklineData[acct.account_id] ? (
                              <Sparkline data={sparklineData[acct.account_id]} width={64} height={22} />
                            ) : (
                              <Sparkline data={[{ label: 'current', value: acct.ml_probability * 100 }]} width={48} height={20} />
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-[var(--text-muted)] text-[10px]">{isExpanded ? '▲' : '▼'}</td>
                      </tr>
                      {isExpanded && (
                        <tr><td colSpan={7} className="p-0 border-t border-[var(--border-card)]"><TemporalDetail temporalData={temporalData} loading={temporalLoading} error={temporalError} /></td></tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && !error && accounts.length === 0 && (
        <div className="card py-14 text-center space-y-2">
          <p className="text-[var(--text-secondary)] font-medium">No accounts in watchlist</p>
          <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto">Load the IBM AML dataset and run the XGBoost training script to populate the watchlist.</p>
        </div>
      )}
    </section>
  )
}
