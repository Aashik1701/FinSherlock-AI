import { useEffect, useState } from 'react'
import { BarChart3, AlertTriangle, FileText, Clock, Printer } from 'lucide-react'

const API_BASE = 'http://localhost:8000'

function KpiCard({ label, value, sub, accent = 'text-[var(--text-primary)]', loading: isLoading, icon, iconBg }) {
  return (
    <div className="kpi-card">
      <div className="flex items-center justify-between">
        <p className="eyebrow">{label}</p>
        {icon && (
          <div className={`kpi-icon ${iconBg || 'bg-[var(--orange-bg)]'}`}>
            {icon}
          </div>
        )}
      </div>
      {isLoading ? (
        <p className="text-2xl font-bold font-mono text-[var(--text-muted)] animate-pulse mt-1">—</p>
      ) : (
        <p className={`text-2xl font-bold font-mono leading-none mt-1 ${accent}`}>{value ?? '—'}</p>
      )}
      {sub && <p className="text-[10px] text-[var(--text-muted)] mt-1">{sub}</p>}
    </div>
  )
}

const fmtUSD = (n) => {
  if (typeof n !== 'number' || n === 0) return '—'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString()}`
}

export default function ExecutiveSummary({ version = 0 }) {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${API_BASE}/dashboard/summary`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setSummary(d) })
      .catch(() => { if (!cancelled) setSummary(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [version])

  const tiers = summary?.risk_tiers ?? {}
  const highRisk = tiers.high ?? 0
  const medRisk  = tiers.medium ?? 0
  const lowRisk  = tiers.low ?? 0
  const sarRequired = summary?.sar_filing_required ?? 0
  const analystHoursSaved = summary?.accounts_analyzed ? Math.floor(summary.accounts_analyzed * 17) : null
  const totalFlagged = summary?.flagged_accounts ?? 0
  const hasTiers = highRisk + medRisk + lowRisk > 0

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">Executive Summary</p>
          <p className="text-sm font-semibold text-[var(--text-primary)] mt-1">Portfolio-Wide AML Snapshot</p>
        </div>
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-card)] bg-[var(--bg-card-hover)] hover:bg-[var(--border-card)] text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all">
          <Printer size={14} />
          Print Official Report
        </button>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard
          label="At-Risk Capital"
          value={fmtUSD(summary?.at_risk_capital)}
          sub="Exposure across flagged patterns"
          accent="text-[var(--orange)]"
          loading={loading}
          icon={<BarChart3 size={16} className="text-[var(--orange)]" />}
          iconBg="bg-[var(--orange-bg)]"
        />
        <KpiCard
          label="Flagged Accounts"
          value={totalFlagged?.toLocaleString() ?? '—'}
          sub={
            hasTiers
              ? `${highRisk.toLocaleString()} HIGH · ${medRisk.toLocaleString()} MED · ${lowRisk.toLocaleString()} LOW`
              : ''
          }
          accent="text-[var(--amber)]"
          loading={loading}
          icon={<AlertTriangle size={16} className="text-[var(--amber)]" />}
          iconBg="bg-[var(--amber-bg)]"
        />
        <KpiCard
          label="SAR Filings Required"
          value={sarRequired}
          sub="Escalate within 30 days · FinCEN"
          accent={sarRequired > 0 ? 'text-[var(--red)]' : 'text-[var(--emerald)]'}
          loading={loading}
          icon={<FileText size={16} className="text-[var(--red)]" />}
          iconBg="bg-[var(--red-bg)]"
        />
        <KpiCard
          label="Analyst Hours Saved"
          value={analystHoursSaved?.toLocaleString() ?? '—'}
          sub={`${(summary?.coverage_pct ?? 0).toFixed(1)}% coverage · ${summary?.accounts_analyzed?.toLocaleString() ?? '—'} analyzed`}
          accent="text-[var(--emerald)]"
          loading={loading}
          icon={<Clock size={16} className="text-[var(--emerald)]" />}
          iconBg="bg-[var(--emerald-bg)]"
        />
      </div>

      {/* Risk distribution bar — always from full-dataset tiers */}
      {hasTiers && (
        <div className="space-y-2">
          <p className="eyebrow">Risk Distribution</p>
          <div className="flex h-2 rounded-full overflow-hidden gap-px">
            {highRisk > 0 && <div className="bg-[var(--red)] transition-all" style={{ flex: highRisk }} />}
            {medRisk  > 0 && <div className="bg-[var(--amber)] transition-all" style={{ flex: medRisk }} />}
            {lowRisk  > 0 && <div className="bg-[var(--emerald)] transition-all" style={{ flex: lowRisk }} />}
          </div>
          <div className="flex gap-4 text-[10px] text-[var(--text-secondary)]">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--red)]" />
              {highRisk.toLocaleString()} HIGH → immediate report
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--amber)]" />
              {medRisk.toLocaleString()} MED → review within 5 days
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--emerald)]" />
              {lowRisk.toLocaleString()} LOW → continue monitoring
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
