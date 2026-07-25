import RiskGauge from './RiskGauge'
import GraphView from './GraphView'
import TimelineView from './TimelineView'
import { openSAR } from './sarExport'

// ─── Helpers ───────────────────────────────────────────────────────────────

const fmtUSD = n =>
  typeof n === 'number'
    ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'

const fmtTS = str => {
  try {
    return new Date(str.replace(' ', 'T')).toLocaleString('en-US', {
      month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return str }
}

// ─── Style maps ────────────────────────────────────────────────────────────

const RISK = {
  high:   { border: 'border-l-red-500',     badge: 'bg-red-950/50 text-red-300 border-red-800',     score: 'text-red-400' },
  medium: { border: 'border-l-amber-500',   badge: 'bg-amber-950/50 text-amber-300 border-amber-800', score: 'text-amber-400' },
  low:    { border: 'border-l-emerald-500', badge: 'bg-emerald-950/50 text-emerald-300 border-emerald-800', score: 'text-emerald-400' },
}

const ESC = {
  report:  'bg-red-950/60 text-red-300 border-red-900',
  review:  'bg-amber-950/60 text-amber-300 border-amber-900',
  monitor: 'bg-emerald-950/60 text-emerald-300 border-emerald-900',
}

// ─── Sub-components ────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div className="space-y-2.5">
      <p className="text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em]">{title}</p>
      {children}
    </div>
  )
}

function StructuringDetail({ entry }) {
  if (!entry?.transactions?.length) return null
  const shown = entry.transactions.slice(0, 6)
  return (
    <Section title={`Near-Threshold Deposits · ${entry.near_threshold_txn_count} transactions · ${fmtUSD(entry.total_amount_structured)} total`}>
      <div className="bg-slate-950/50 border border-slate-800 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/60">
              <th className="text-left px-3 py-2 text-slate-600 font-semibold">Timestamp</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Amount</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Below Limit</th>
              <th className="text-right px-3 py-2 text-slate-600 font-semibold">Txn ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {shown.map((txn, i) => (
              <tr key={i} className="hover:bg-slate-800/20 transition-colors">
                <td className="px-3 py-2 font-mono text-slate-400">{fmtTS(txn.timestamp)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-slate-200">{fmtUSD(txn.amount)}</td>
                <td className="px-3 py-2 text-right font-mono">
                  <span className="text-red-400">{fmtUSD(txn.distance_from_threshold)}</span>
                  <span className="text-slate-700 ml-1 text-[10px]">({txn.pct_below_threshold?.toFixed(1)}%)</span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-700 text-[10px]">
                  {String(txn.transaction_id).slice(-8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entry.transactions.length > 6 && (
          <p className="px-3 py-2 text-[10px] text-slate-700 border-t border-slate-800">
            + {entry.transactions.length - 6} more transactions not shown
          </p>
        )}
      </div>
      {entry.date_range && (
        <p className="text-[10px] text-slate-700">
          Period: {fmtTS(entry.date_range.first)} — {fmtTS(entry.date_range.last)}
        </p>
      )}
    </Section>
  )
}

function SmurfingDetail({ entry }) {
  if (!entry) return null
  return (
    <Section title={`Network Dispersal · Fan-out ${entry.fan_out_degree} · Fan-in ${entry.fan_in_degree}`}>
      <div className="space-y-3">
        {entry.counterparties_sent_to?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-slate-600">
              Sent to <span className="text-violet-400 font-semibold">{entry.counterparties_sent_to.length}</span> accounts
              <span className="text-slate-700 ml-2">· {fmtUSD(entry.total_sent)} total</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {entry.counterparties_sent_to.map(cp => (
                <span key={cp} className="px-2 py-0.5 bg-violet-950/40 border border-violet-900/50 rounded-md text-[10px] text-violet-300 font-mono">
                  {cp}
                </span>
              ))}
            </div>
          </div>
        )}
        {entry.counterparties_received_from?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-slate-600">
              Received from <span className="text-purple-400 font-semibold">{entry.counterparties_received_from.length}</span> accounts
              <span className="text-slate-700 ml-2">· {fmtUSD(entry.total_received)} total</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {entry.counterparties_received_from.map(cp => (
                <span key={cp} className="px-2 py-0.5 bg-purple-950/40 border border-purple-900/50 rounded-md text-[10px] text-purple-300 font-mono">
                  {cp}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  )
}

function LayeringDetail({ layerPath }) {
  if (!layerPath) return null
  const { path, transaction_ids, hop_count, total_amount, time_span_hours } = layerPath
  return (
    <Section title={`Layering Chain · ${hop_count} hops · ${fmtUSD(total_amount)} · ${time_span_hours?.toFixed(1)}h span`}>
      <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-y-2">
          {path.map((node, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <span className={`px-2.5 py-1.5 rounded-lg border font-mono text-[10px] font-semibold ${
                i === 0
                  ? 'bg-amber-950/60 border-amber-800 text-amber-300'
                  : i === path.length - 1
                    ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                    : 'bg-slate-800 border-slate-700 text-slate-300'
              }`}>
                {node}
              </span>
              {i < path.length - 1 && (
                <span className="flex flex-col items-center px-1">
                  <span className="text-[9px] text-slate-700 font-mono">{transaction_ids?.[i]?.slice(-6) ?? ''}</span>
                  <span className="text-slate-600 text-xs">→</span>
                </span>
              )}
            </span>
          ))}
        </div>
        <div className="mt-3 flex gap-6 text-[10px] text-slate-600 border-t border-slate-800 pt-2.5">
          <span><span className="text-amber-400 font-semibold">Origin</span> = {path[0]}</span>
          <span><span className="text-emerald-400 font-semibold">Destination</span> = {path[path.length - 1]}</span>
          <span>{hop_count} intermediar{hop_count === 1 ? 'y' : 'ies'}</span>
        </div>
      </div>
    </Section>
  )
}

// ─── Main card ─────────────────────────────────────────────────────────────

export default function FindingCard({ exp, structuringData, smurfingData, layeringData, classifyData }) {
  const [feedback, setFeedback] = useState(null) // 'confirmed' | 'false_positive'
  const risk = RISK[exp.risk_level] ?? RISK.low
  const escCls = ESC[exp.escalation] ?? 'bg-slate-800 text-slate-400 border-slate-700'

  const structEntry   = structuringData?.flagged_accounts?.find(a => a.account_id === exp.account_id)
  const smurfEntry    = smurfingData?.flagged_accounts?.find(a => a.account_id === exp.account_id)
  const layerPath     = layeringData?.detected_paths?.find(p => p.path?.includes(exp.account_id))
  const classifyEntry = classifyData?.classifications?.find(c => c.account_id === exp.account_id)

  const handleExportSAR = () => {
    openSAR({
      exp,
      classify:    classifyEntry ?? null,
      structEntry: structEntry   ?? null,
      smurfEntry:  smurfEntry    ?? null,
      layerPath:   layerPath     ?? null,
      filingDate:  new Date().toISOString().split('T')[0],
    })
  }

  const hasDetails = structEntry || smurfEntry || layerPath
  const hasGraph   = smurfEntry || layerPath

  return (
    <article className={`bg-slate-900 border border-slate-800 border-l-4 ${risk.border} rounded-2xl overflow-hidden`}>

      {/* ── Card header ─────────────────────────────────────────────── */}
      <header className="px-6 pt-5 pb-4 border-b border-slate-800/60 flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono font-bold text-slate-100 text-lg">{exp.account_id}</span>
          <span className={`px-2.5 py-0.5 rounded border text-[10px] font-bold uppercase tracking-widest ${risk.badge}`}>
            {exp.risk_level} risk
          </span>
          <span className="text-slate-700 text-sm font-mono">
            score&nbsp;
            <span className={`font-bold ${risk.score}`}>{exp.risk_score?.toFixed(1)}</span>
            <span className="text-slate-800">/100</span>
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Feedback controls */}
          {feedback ? (
            <span className={`px-2.5 py-1 rounded text-[10px] font-mono border font-semibold ${
              feedback === 'confirmed'
                ? 'bg-red-950/60 text-red-300 border-red-800'
                : 'bg-emerald-950/60 text-emerald-300 border-emerald-800'
            }`}>
              {feedback === 'confirmed' ? '✓ Confirmed Suspicious' : '✕ Tagged False Positive'}
            </span>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setFeedback('confirmed')}
                className="px-2 py-1 rounded border border-slate-800 bg-slate-900 hover:border-red-800 hover:text-red-300 text-[10px] text-slate-500 transition-colors font-mono"
                title="Mark as confirmed suspicious pattern"
              >
                + Confirm
              </button>
              <button
                onClick={() => setFeedback('false_positive')}
                className="px-2 py-1 rounded border border-slate-800 bg-slate-900 hover:border-emerald-800 hover:text-emerald-300 text-[10px] text-slate-500 transition-colors font-mono"
                title="Dismiss as false positive"
              >
                Dismiss
              </button>
            </div>
          )}

          <span className={`px-3.5 py-1 rounded-full border text-[10px] font-bold uppercase tracking-widest ${escCls}`}>
            {exp.escalation}
          </span>
          <button
            onClick={handleExportSAR}
            title="Export SAR draft as HTML (printable to PDF)"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-slate-700 bg-slate-800/60 hover:bg-slate-700 hover:border-slate-500 text-[10px] font-semibold text-slate-400 hover:text-slate-200 transition-all"
          >
            <svg viewBox="0 0 14 14" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 10v2h10v-2M7 2v7M4.5 6.5L7 9l2.5-2.5" />
            </svg>
            Export SAR
          </button>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="p-6 space-y-6">

        {/* Gauge + explanation side-by-side */}
        <div className="flex gap-6 items-start">
          <div className="shrink-0 w-40">
            <RiskGauge score={exp.risk_score ?? 0} riskLevel={exp.risk_level} uid={exp.account_id} />
          </div>
          <div className="flex-1 space-y-3 min-w-0">
            {exp.instruction && (
              <p className="text-[11px] text-slate-600 italic leading-relaxed border-l-2 border-slate-800 pl-3">
                {exp.instruction}
              </p>
            )}
            <p className="text-sm text-slate-200 leading-relaxed">{exp.explanation}</p>
            {exp.counterfactual && (
              <div className="bg-indigo-950/30 border border-indigo-900/40 rounded-xl p-3 flex items-start gap-2.5">
                <span className="text-indigo-400 text-xs mt-0.5 font-bold shrink-0">↺</span>
                <div className="space-y-0.5">
                  <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">Counterfactual Analysis</p>
                  <p className="text-[11px] text-indigo-200/80 leading-relaxed">{exp.counterfactual}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Evidence cited */}
        {exp.evidence_cited?.length > 0 && (
          <Section title="Evidence Cited">
            <div className="flex flex-wrap gap-2">
              {exp.evidence_cited.map((e, i) => (
                <span key={i} className="inline-flex items-start gap-1.5 px-3 py-1.5 bg-slate-800/70 border border-slate-700 rounded-lg max-w-full">
                  <span className="text-indigo-500 text-[10px] mt-px shrink-0">◆</span>
                  <span className="text-[11px] text-slate-400 font-mono leading-snug break-all">{e}</span>
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Detection detail panels */}
        {hasDetails && (
          <div className="border border-slate-800 bg-slate-950/30 rounded-xl p-4 space-y-5">
            {structEntry && <StructuringDetail entry={structEntry} />}
            {smurfEntry  && <SmurfingDetail entry={smurfEntry} />}
            {layerPath   && <LayeringDetail layerPath={layerPath} />}
            
            {/* Timeline */}
            <TimelineView
              structEntry={structEntry}
              smurfEntry={smurfEntry}
              layerPath={layerPath}
            />
          </div>
        )}

        {/* Graph visualization */}
        {hasGraph && (
          <GraphView
            smurfingData={smurfingData}
            layeringData={layeringData}
            accountId={exp.account_id}
          />
        )}
      </div>
    </article>
  )
}
