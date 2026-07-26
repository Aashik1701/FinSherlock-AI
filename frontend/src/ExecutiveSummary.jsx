import { useEffect, useState } from 'react'
import { BarChart3, AlertTriangle, FileText, Clock, Printer } from 'lucide-react'

const API_BASE = 'http://localhost:8000'

function KpiCard({ label, value, sub, accent = 'text-gray-900', loading: isLoading, icon, iconBg }) {
  return (
    <div className="kpi-card">
      <div className="flex items-center justify-between">
        <p className="eyebrow">{label}</p>
        {icon && (
          <div className={`kpi-icon ${iconBg || 'bg-orange-50'}`}>
            {icon}
          </div>
        )}
      </div>
      {isLoading ? (
        <p className="text-2xl font-bold font-mono text-gray-300 animate-pulse mt-1">—</p>
      ) : (
        <p className={`text-2xl font-bold font-mono leading-none mt-1 ${accent}`}>{value ?? '—'}</p>
      )}
      {sub && <p className="text-[10px] text-gray-400 mt-1">{sub}</p>}
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
          <p className="text-sm font-semibold text-gray-900 mt-1">Portfolio-Wide AML Snapshot</p>
        </div>
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 text-[10px] font-semibold text-gray-600 hover:text-gray-800 transition-all">
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
          accent="text-orange-600"
          loading={loading}
          icon={<BarChart3 size={16} className="text-orange-500" />}
          iconBg="bg-orange-50"
        />
        <KpiCard
          label="Flagged Accounts"
          value={totalFlagged?.toLocaleString() ?? '—'}
          sub={
            hasTiers
              ? `${highRisk.toLocaleString()} HIGH · ${medRisk.toLocaleString()} MED · ${lowRisk.toLocaleString()} LOW`
              : ''
          }
          accent="text-amber-600"
          loading={loading}
          icon={<AlertTriangle size={16} className="text-amber-500" />}
          iconBg="bg-amber-50"
        />
        <KpiCard
          label="SAR Filings Required"
          value={sarRequired}
          sub="Escalate within 30 days · FinCEN"
          accent={sarRequired > 0 ? 'text-red-600' : 'text-emerald-600'}
          loading={loading}
          icon={<FileText size={16} className="text-red-500" />}
          iconBg="bg-red-50"
        />
        <KpiCard
          label="Analyst Hours Saved"
          value={analystHoursSaved?.toLocaleString() ?? '—'}
          sub={`${(summary?.coverage_pct ?? 0).toFixed(1)}% coverage · ${summary?.accounts_analyzed?.toLocaleString() ?? '—'} analyzed`}
          accent="text-emerald-600"
          loading={loading}
          icon={<Clock size={16} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
        />
      </div>

      {/* Risk distribution bar — always from full-dataset tiers */}
      {hasTiers && (
        <div className="space-y-2">
          <p className="eyebrow">Risk Distribution</p>
          <div className="flex h-2 rounded-full overflow-hidden gap-px">
            {highRisk > 0 && <div className="bg-red-500 transition-all" style={{ flex: highRisk }} />}
            {medRisk  > 0 && <div className="bg-amber-500 transition-all" style={{ flex: medRisk }} />}
            {lowRisk  > 0 && <div className="bg-emerald-500 transition-all" style={{ flex: lowRisk }} />}
          </div>
          <div className="flex gap-4 text-[10px] text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              {highRisk.toLocaleString()} HIGH → immediate report
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              {medRisk.toLocaleString()} MED → review within 5 days
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              {lowRisk.toLocaleString()} LOW → continue monitoring
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
