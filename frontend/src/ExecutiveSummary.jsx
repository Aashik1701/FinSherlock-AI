import { useMemo } from 'react'

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtUSD = (n, compact = false) => {
  if (typeof n !== 'number' || n === 0) return '—'
  if (compact) {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  }
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

// ─── Stat card ──────────────────────────────────────────────────────────────

function SummaryStat({ label, value, sub, accent, icon }) {
  return (
    <div className="flex flex-col gap-1 bg-slate-900/80 border border-slate-800 rounded-xl px-4 py-3.5 min-w-0 hover:border-slate-700 transition-colors">
      <div className="flex items-center gap-2 text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em]">
        {icon && <span>{icon}</span>}
        {label}
      </div>
      <p className={`text-2xl font-bold font-mono leading-none ${accent}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-600 leading-snug">{sub}</p>}
    </div>
  )
}

// ─── Typology pill ───────────────────────────────────────────────────────────

function TypePill({ label, count, cls }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-[10px] font-bold ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
      {label}
      {count > 0 && <span className="ml-1 opacity-70">× {count}</span>}
    </span>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ExecutiveSummary({
  explanations = [],
  structuringData,
  smurfingData,
  layeringData,
  muleRingData,
  velocityData,
  classifyData,
  eda,
}) {
  const summary = useMemo(() => {
    const high   = explanations.filter(e => e.risk_level === 'high').length
    const medium = explanations.filter(e => e.risk_level === 'medium').length
    const low    = explanations.filter(e => e.risk_level === 'low').length
    const sarRequired = high

    // At-risk capital: sum of total_amount_structured + smurfing volumes + layering amounts
    let atRiskCapital = 0
    structuringData?.flagged_accounts?.forEach(a => { atRiskCapital += a.total_amount_structured ?? 0 })
    smurfingData?.flagged_accounts?.forEach(a => {
      atRiskCapital += (a.total_sent ?? 0) + (a.total_received ?? 0)
    })
    layeringData?.detected_paths?.forEach(p => { atRiskCapital += p.total_amount ?? 0 })
    velocityData?.flagged_accounts?.forEach(a => { atRiskCapital += a.total_volume_recent_usd ?? 0 })

    // De-duplicate (rough: cap at plausible max)
    atRiskCapital = atRiskCapital / 1.5

    // Detected typologies
    const typologies = []
    if ((structuringData?.flagged_accounts?.length ?? 0) > 0)
      typologies.push({ label: 'Structuring (BSA CTR)', count: structuringData.flagged_accounts.length, cls: 'bg-sky-950/60 text-sky-300 border-sky-800' })
    if ((smurfingData?.flagged_accounts?.length ?? 0) > 0)
      typologies.push({ label: 'Smurfing (SAR)', count: smurfingData.flagged_accounts.length, cls: 'bg-violet-950/60 text-violet-300 border-violet-800' })
    if ((layeringData?.detected_paths?.length ?? 0) > 0)
      typologies.push({ label: 'Layering (SAR)', count: layeringData.detected_paths.length, cls: 'bg-amber-950/60 text-amber-300 border-amber-800' })
    if ((muleRingData?.rings?.length ?? 0) > 0)
      typologies.push({ label: 'Mule Rings', count: muleRingData.rings.length, cls: 'bg-rose-950/60 text-rose-300 border-rose-800' })
    if ((velocityData?.flagged_accounts?.length ?? 0) > 0)
      typologies.push({ label: 'Velocity Spikes', count: velocityData.flagged_accounts.length, cls: 'bg-orange-950/60 text-orange-300 border-orange-800' })

    // Time saved estimate: 45min per manual review → auto-triaged to high/medium
    const reviewsSaved = high + medium
    const hoursSaved   = Math.round(reviewsSaved * 0.75 * 10) / 10

    // Dataset size
    const txnCount = eda?.total_rows ?? 0

    return { high, medium, low, sarRequired, atRiskCapital, typologies, reviewsSaved, hoursSaved, txnCount }
  }, [explanations, structuringData, smurfingData, layeringData, muleRingData, velocityData, eda])

  if (explanations.length === 0 && !muleRingData && !velocityData) return null

  const totalFlagged = explanations.length
  const ringsFound   = muleRingData?.rings?.length ?? 0
  const velocitySpiked = velocityData?.flagged_accounts?.length ?? 0

  return (
    <section className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="space-y-0.5">
          <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
            Executive Summary
          </h2>
          <p className="text-[11px] text-slate-600">
            Investigation complete · {new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/60 hover:bg-slate-700 text-[10px] font-semibold text-slate-400 hover:text-slate-200 transition-all"
        >
          <svg viewBox="0 0 14 14" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3V1h8v2M3 9v4h8V9" />
            <rect x="1" y="5" width="12" height="6" rx="1" />
          </svg>
          Print Report
        </button>
      </div>

      {/* High-impact alert if SARs needed */}
      {summary.sarRequired > 0 && (
        <div className="bg-red-950/20 border border-red-900/50 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-red-400 text-base shrink-0">⚠</span>
          <p className="text-sm text-red-300 font-semibold">
            {summary.sarRequired} account{summary.sarRequired !== 1 ? 's' : ''} require immediate SAR filing
            <span className="font-normal text-red-400/80 ml-2 text-xs">
              (FinCEN deadline: 30 days from detection)
            </span>
          </p>
        </div>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryStat
          label="At-Risk Capital"
          value={summary.atRiskCapital > 0 ? fmtUSD(summary.atRiskCapital, true) : '—'}
          sub="Estimated laundering exposure"
          accent="text-red-400"
          icon="💰"
        />
        <SummaryStat
          label="Accounts Flagged"
          value={totalFlagged > 0 ? totalFlagged : (ringsFound > 0 ? `${ringsFound} rings` : '—')}
          sub={`${summary.high} HIGH · ${summary.medium} MED · ${summary.low} LOW`}
          accent="text-amber-400"
          icon="🚩"
        />
        {ringsFound > 0 && (
          <SummaryStat
            label="Mule Rings Detected"
            value={ringsFound}
            sub={`${muleRingData?.rings?.reduce((a, r) => a + r.member_count, 0) ?? 0} total accounts in rings`}
            accent="text-rose-400"
            icon="🔴"
          />
        )}
        {velocitySpiked > 0 && (
          <SummaryStat
            label="Velocity Spikes"
            value={velocitySpiked}
            sub={`Avg spike: ${(velocityData?.flagged_accounts?.reduce((a, v) => a + v.spike_ratio, 0) / velocitySpiked).toFixed(1)}× baseline`}
            accent="text-orange-400"
            icon="⚡"
          />
        )}
        {ringsFound === 0 && velocitySpiked === 0 && (
          <>
            <SummaryStat
              label="SAR Filings Required"
              value={summary.sarRequired > 0 ? summary.sarRequired : '0'}
              sub="High-risk accounts → report"
              accent={summary.sarRequired > 0 ? 'text-red-400' : 'text-emerald-400'}
              icon="📋"
            />
            <SummaryStat
              label="Analyst Hours Saved"
              value={`${summary.hoursSaved}h`}
              sub={`${summary.reviewsSaved} reviews auto-triaged`}
              accent="text-emerald-400"
              icon="⏱"
            />
          </>
        )}
        {ringsFound > 0 && velocitySpiked === 0 && (
          <SummaryStat
            label="Analyst Hours Saved"
            value={`${summary.hoursSaved}h`}
            sub={`${summary.reviewsSaved} reviews auto-triaged`}
            accent="text-emerald-400"
            icon="⏱"
          />
        )}
      </div>

      {/* Detected typologies */}
      {summary.typologies.length > 0 && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 flex items-center flex-wrap gap-2">
          <span className="text-[9px] font-bold text-slate-600 uppercase tracking-wider mr-2">Typologies Detected:</span>
          {summary.typologies.map((t, i) => (
            <TypePill key={i} {...t} />
          ))}
        </div>
      )}

      {/* Risk distribution bar */}
      {explanations.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
            {summary.high   > 0 && <div className="bg-red-500 transition-all"    style={{ flex: summary.high }} />}
            {summary.medium > 0 && <div className="bg-amber-500 transition-all"  style={{ flex: summary.medium }} />}
            {summary.low    > 0 && <div className="bg-emerald-500 transition-all" style={{ flex: summary.low }} />}
          </div>
          <div className="flex gap-4 text-[10px] text-slate-600">
            <span>{summary.high} HIGH → immediate report</span>
            <span className="w-px h-3 bg-slate-800" />
            <span>{summary.medium} MED → review within 5 days</span>
            <span className="w-px h-3 bg-slate-800" />
            <span>{summary.low} LOW → continue monitoring</span>
          </div>
        </div>
      )}
    </section>
  )
}
