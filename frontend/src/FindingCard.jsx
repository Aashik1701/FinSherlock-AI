import { useState, useCallback } from 'react'
import RiskGauge from './RiskGauge'
import GraphView from './GraphView'
import TimelineView from './TimelineView'
import { openSAR } from './sarExport'

const fmtUSD = n => typeof n === 'number' ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }` : '—'

const fmtTS = str => {
  try {
    return new Date(str.replace(' ', 'T')).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return str }
}

const RISK_CLS = {
  high:   { border: 'border-l-red-500', badge: 'badge-red' },
  medium: { border: 'border-l-amber-500', badge: 'badge-amber' },
  low:    { border: 'border-l-emerald-500', badge: 'badge-emerald' },
}

const ESC_CLS = {
  report:  'bg-red-50 text-red-700 border-red-200',
  review:  'bg-amber-50 text-amber-700 border-amber-200',
  monitor: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

const TYPOLOGY_LABELS = {
  structuring: { label: 'Structuring', color: 'text-blue-600' },
  smurfing: { label: 'Smurfing', color: 'text-purple-600' },
  layering: { label: 'Layering', color: 'text-amber-600' },
}

function Section({ title, children }) {
  return (
    <div className="space-y-2.5">
      <p className="eyebrow">{title}</p>
      {children}
    </div>
  )
}

function StructuringDetail({ entry }) {
  if (!entry?.transactions?.length) return null
  const shown = entry.transactions.slice(0, 6)
  return (
    <Section title={`Near-Threshold Deposits · ${entry.near_threshold_txn_count} transactions · ${fmtUSD(entry.total_amount_structured)} total`}>
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-3 py-2 text-gray-400 font-semibold text-[10px]">Timestamp</th>
              <th className="text-right px-3 py-2 text-gray-400 font-semibold text-[10px]">Amount</th>
              <th className="text-right px-3 py-2 text-gray-400 font-semibold text-[10px]">Below Limit</th>
              <th className="text-right px-3 py-2 text-gray-400 font-semibold text-[10px]">Txn ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {shown.map((txn, i) => (
              <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                <td className="px-3 py-2 font-mono text-gray-500">{fmtTS(txn.timestamp)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-gray-800">{fmtUSD(txn.amount)}</td>
                <td className="px-3 py-2 text-right font-mono text-red-600">{fmtUSD(txn.distance_from_threshold)} <span className="text-gray-400">({txn.pct_below_threshold?.toFixed(1)}%)</span></td>
                <td className="px-3 py-2 text-right font-mono text-gray-400 text-[10px]">{String(txn.transaction_id).slice(-8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entry.transactions.length > 6 && <p className="px-3 py-2 text-[10px] text-gray-400 border-t border-gray-100">+ {entry.transactions.length - 6} more</p>}
      </div>
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
            <p className="text-[10px] text-gray-500">Sent to <span className="text-violet-600 font-semibold">{entry.counterparties_sent_to.length}</span> accounts · {fmtUSD(entry.total_sent)} total</p>
            <div className="flex flex-wrap gap-1.5">
              {entry.counterparties_sent_to.map(cp => (
                <span key={cp} className="px-2 py-0.5 bg-violet-50 border border-violet-200 rounded-md text-[10px] text-violet-700 font-mono">{cp}</span>
              ))}
            </div>
          </div>
        )}
        {entry.counterparties_received_from?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-gray-500">Received from <span className="text-purple-600 font-semibold">{entry.counterparties_received_from.length}</span> accounts · {fmtUSD(entry.total_received)} total</p>
            <div className="flex flex-wrap gap-1.5">
              {entry.counterparties_received_from.map(cp => (
                <span key={cp} className="px-2 py-0.5 bg-purple-50 border border-purple-200 rounded-md text-[10px] text-purple-700 font-mono">{cp}</span>
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
      <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/50">
        <div className="flex flex-wrap items-center gap-y-2">
          {path.map((node, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <span className={`px-2.5 py-1.5 rounded-lg border font-mono text-[10px] font-semibold ${
                i === 0 ? 'bg-amber-50 border-amber-200 text-amber-700' :
                i === path.length - 1 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                'bg-white border-gray-200 text-gray-600'
              }`}>{node}</span>
              {i < path.length - 1 && <span className="text-gray-400 text-xs px-1">→</span>}
            </span>
          ))}
        </div>
        <div className="mt-3 flex gap-6 text-[10px] text-gray-400 border-t border-gray-200 pt-2.5">
          <span>Origin = {path[0]}</span>
          <span>Destination = {path[path.length - 1]}</span>
          <span>{hop_count} intermediar{hop_count === 1 ? 'y' : 'ies'}</span>
        </div>
      </div>
    </Section>
  )
}

function SHAPPanel({ accountId, windowDays }) {
  const [state, setState] = useState('idle')
  const [data, setData] = useState(null)
  const [errMsg, setErrMsg] = useState('')

  const load = useCallback(async () => {
    setState('loading')
    try {
      const res = await fetch('http://localhost:8000/tools/shap_explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: { account_ids: [accountId], window_days: windowDays ?? 30 } }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json.ready) throw new Error(json.message ?? 'SHAP not ready')
      setData(json.explanations?.[0] ?? null)
      setState('done')
    } catch (err) {
      setErrMsg(err.message)
      setState('error')
    }
  }, [accountId, windowDays])

  if (state === 'idle') return <button onClick={load} className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-500 border border-indigo-200 hover:border-indigo-300 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-all">Explain with SHAP</button>
  if (state === 'loading') return <div className="text-xs text-gray-500 animate-pulse">Computing SHAP values…</div>
  if (state === 'error') return <div className="text-xs text-red-600">SHAP error: {errMsg}</div>
  if (!data) return <div className="text-xs text-gray-500">No SHAP data for this account.</div>

  const maxAbs = Math.max(...data.shap_values.map(s => Math.abs(s.shap_value)), 0.0001)

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 leading-relaxed italic border-l-2 border-indigo-300 pl-3">{data.narrative}</p>
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <span className="eyebrow">SHAP Feature Attribution · txn {String(data.transaction_id).slice(-8)}</span>
          <span className="text-[9px] text-gray-400 font-mono">p={data.ml_probability.toFixed(3)} · base={data.base_probability.toFixed(3)}</span>
        </div>
        <div className="divide-y divide-gray-100">
          {data.shap_values.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_6rem_3.5rem] items-center gap-3 px-3 py-1.5">
              <span className="text-[10px] text-gray-500 truncate" title={s.label}>{s.label}</span>
              <div className="relative flex items-center h-3 w-full">
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-200" />
                {s.shap_value >= 0 ? (
                  <div className="absolute left-1/2 h-2 rounded-r bg-red-400" style={{ width: `${Math.abs(s.shap_value) / maxAbs * 50}%` }} />
                ) : (
                  <div className="absolute right-1/2 h-2 rounded-l bg-emerald-400" style={{ width: `${Math.abs(s.shap_value) / maxAbs * 50}%` }} />
                )}
              </div>
              <span className={`text-[10px] font-mono text-right tabular-nums ${s.shap_value >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                {s.shap_value >= 0 ? '+' : ''}{s.shap_value.toFixed(3)}
              </span>
            </div>
          ))}
        </div>
        <div className="px-3 py-1.5 border-t border-gray-200 flex gap-6 text-[9px] text-gray-400 bg-gray-50">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-r bg-red-400" /> increases risk</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-l bg-emerald-400" /> decreases risk</span>
        </div>
      </div>
    </div>
  )
}

export default function FindingCard({ exp, structuringData, smurfingData, layeringData, classifyData, onFeedback }) {
  const risk = RISK_CLS[exp.risk_level] ?? RISK_CLS.low
  const escCls = ESC_CLS[exp.escalation] ?? 'bg-gray-100 text-gray-500 border-gray-200'
  const [feedbackState, setFeedbackState] = useState(null)
  const [error, setError] = useState(null)

  const structEntry   = structuringData?.flagged_accounts?.find(a => a.account_id === exp.account_id)
  const smurfEntry    = smurfingData?.flagged_accounts?.find(a => a.account_id === exp.account_id)
  const layerPath     = layeringData?.detected_paths?.find(p => p.path?.includes(exp.account_id))
  const classifyEntry = classifyData?.classifications?.find(c => c.account_id === exp.account_id)

  const handleExportSAR = () => {
    openSAR({ exp, classify: classifyEntry ?? null, structEntry: structEntry ?? null, smurfEntry: smurfEntry ?? null, layerPath: layerPath ?? null, filingDate: new Date().toISOString().split('T')[0] })
  }

  const handleFeedback = async (label) => {
    setFeedbackState('submitting')
    setError(null)
    try {
      const res = await fetch('http://localhost:8000/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: exp.account_id, label, risk_score: (exp.risk_score ?? 0) / 100, query_text: exp.explanation }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setFeedbackState(label ? 'tp' : 'fp')
      if (onFeedback) onFeedback(exp.account_id, label)
    } catch (err) {
      setError(err.message)
      setFeedbackState(null)
    }
  }

  const hasGraph = !!(structEntry || smurfEntry || layerPath)

  return (
    <article className={`bg-white border border-gray-200/80 border-l-4 ${risk.border} rounded-2xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]`}>
      {/* Card header */}
      <header className="px-5 pt-4 pb-3 border-b border-gray-100 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <span className="font-mono font-bold text-gray-900 text-base break-all">{exp.account_id}</span>
          <span className={risk.badge}>{exp.risk_level}</span>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${escCls}`}>
            {exp.escalation}
          </span>
          {exp.typology && (
            <span className={`text-[10px] font-semibold ${TYPOLOGY_LABELS[exp.typology]?.color || 'text-gray-500'}`}>
              · {TYPOLOGY_LABELS[exp.typology]?.label || exp.typology}
            </span>
          )}
        </div>
        <div className="flex items-center flex-wrap gap-2">
          {/* Feedback buttons */}
          {feedbackState !== 'tp' && feedbackState !== 'fp' ? (
            <div className="flex items-center gap-1.5">
              <button onClick={() => handleFeedback(true)} disabled={feedbackState === 'submitting'}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-gray-200 bg-gray-50 hover:bg-gray-100 text-[10px] font-bold text-gray-700 transition-all disabled:opacity-40">
                ✓ Confirm TP
              </button>
              <button onClick={() => handleFeedback(false)} disabled={feedbackState === 'submitting'}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-gray-200 bg-gray-50 hover:bg-gray-100 text-[10px] font-bold text-gray-700 transition-all disabled:opacity-40">
                ✕ Dismiss FP
              </button>
            </div>
          ) : (
            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[10px] font-bold ${feedbackState === 'tp' ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-gray-200 bg-gray-50 text-gray-600'}`}>
              ✓ {feedbackState === 'tp' ? 'Confirmed TP' : 'Dismissed as FP'}
            </span>
          )}
          {error && <span className="text-[10px] text-red-600">{error}</span>}

          <button onClick={handleExportSAR} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-gray-200 bg-gray-50 hover:bg-gray-100 text-[10px] font-semibold text-gray-600 hover:text-gray-800 transition-all">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export SAR
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="px-5 py-4 space-y-5">
        {/* Gauge + Explanation row */}
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          <div className="shrink-0 w-32 sm:w-36 mx-auto sm:mx-0">
            <RiskGauge score={exp.risk_score ?? 0} riskLevel={exp.risk_level} uid={exp.account_id} />
          </div>
          <div className="flex-1 space-y-3 min-w-0">
            {exp.instruction && <p className="text-xs text-gray-500 italic leading-relaxed border-l-2 border-gray-200 pl-3">{exp.instruction}</p>}
            <p className="text-sm text-gray-800 leading-relaxed">{exp.explanation}</p>

            {/* Counterfactual */}
            {exp.counterfactual && (
              <div className="bg-indigo-50/80 border border-indigo-200/60 rounded-xl p-3 flex items-start gap-2.5">
                <span className="text-indigo-400 text-xs mt-0.5 font-bold shrink-0">↺</span>
                <div className="space-y-0.5">
                  <p className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">Counterfactual Analysis</p>
                  <p className="text-xs text-indigo-700/80 leading-relaxed">{exp.counterfactual}</p>
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
                <span key={i} className="inline-flex items-start gap-1.5 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg">
                  <span className="text-indigo-400 text-[10px] mt-px shrink-0">◆</span>
                  <span className="text-xs text-gray-600 font-mono leading-snug">{e}</span>
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* SHAP */}
        <Section title="ML Explanation">
          <SHAPPanel accountId={exp.account_id} windowDays={30} />
        </Section>

        {/* Detection details */}
        {(structEntry || smurfEntry || layerPath) && (
          <div className="border border-gray-200 bg-gray-50/50 rounded-xl p-4 space-y-5">
            {structEntry && <StructuringDetail entry={structEntry} />}
            {smurfEntry  && <SmurfingDetail entry={smurfEntry} />}
            {layerPath   && <LayeringDetail layerPath={layerPath} />}
          </div>
        )}

        {/* Timeline + Network Graph — side by side */}
        {(hasGraph || (structEntry || smurfEntry || layerPath)) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(structEntry || smurfEntry || layerPath) && (
              <div className="card p-4">
                <TimelineView structEntry={structEntry} smurfEntry={smurfEntry} layerPath={layerPath} />
              </div>
            )}
            {hasGraph && (
              <div className="card p-4">
                <GraphView structuringData={structuringData} smurfingData={smurfingData} layeringData={layeringData} accountId={exp.account_id} />
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
