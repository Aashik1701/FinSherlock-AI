import { useState, useEffect } from 'react'

const API_BASE = 'http://localhost:8000'

function MetricBar({ label, value, max = 1, color = 'bg-blue-500' }) {
  const pct = Math.min(value / max * 100, 100)
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px]">
        <span className="text-slate-500">{label}</span>
        <span className="font-mono text-slate-300">{(value * 100).toFixed(1)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function RuleCard({ rule, naive }) {
  const name = rule.rule
    .replace('structuring (≥2 near-threshold txns)', 'Structuring')
    .replace(/smurfing \(fan-out ≥ (\d+)\)/, 'Smurfing (fan≥$1)')
  
  const reductionPct = naive?.flagged > 0 && rule.tp > 0
    ? ((1 - rule.flagged / naive.flagged) * 100).toFixed(1)
    : null

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-300">{name}</span>
        <span className="text-[9px] font-mono text-slate-600">
          {rule.flagged.toLocaleString()} flagged
        </span>
      </div>
      <MetricBar label="Precision" value={rule.precision} color="bg-emerald-500" />
      <MetricBar label="Recall" value={rule.recall} color="bg-blue-500" />
      <MetricBar label="F1 Score" value={rule.f1} color="bg-violet-500" />
      {reductionPct && (
        <div className="flex items-center gap-2 pt-1 border-t border-slate-800/60">
          <span className="text-[9px] text-slate-600">vs naive baseline:</span>
          <span className="text-[10px] font-bold font-mono text-emerald-400">
            ↓{reductionPct}% fewer flags
          </span>
        </div>
      )}
    </div>
  )
}

export default function MetricsPanel() {
  const [metrics, setMetrics] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [open, setOpen]       = useState(false)

  const fetchMetrics = async () => {
    if (metrics) return  // already loaded
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/metrics?limit=500000`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setMetrics(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    if (!open && !metrics) fetchMetrics()
    setOpen(o => !o)
  }

  const nb = metrics?.naive_baseline
  const xgb = metrics?.xgboost

  return (
    <div className="border border-slate-800 rounded-2xl overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-5 py-3.5 bg-slate-900/60 hover:bg-slate-900 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
          <span className="text-[11px] font-semibold text-slate-400">
            Model Performance vs. Ground Truth
          </span>
          {metrics && (
            <span className="text-[9px] font-mono text-slate-600">
              {metrics.dataset.total_rows.toLocaleString()} rows · {metrics.dataset.labeled_laundering.toLocaleString()} laundering labels
            </span>
          )}
        </div>
        <span className="text-slate-700 text-[10px]">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-800 px-5 py-5 space-y-5">
          {loading && (
            <div className="flex items-center gap-3 py-6 justify-center">
              <span className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-slate-500">Evaluating against IBM AML ground truth…</span>
            </div>
          )}
          {error && (
            <p className="text-xs text-red-400 text-center py-4">Failed to load metrics: {error}</p>
          )}
          {metrics && metrics.dataset && (
            <>
              {/* Naive baseline callout */}
              {nb && (
                <div className="bg-red-950/20 border border-red-900/30 rounded-xl px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="text-red-500 text-sm mt-0.5 shrink-0">⚠</span>
                    <div className="space-y-1 min-w-0">
                      <p className="text-[11px] font-semibold text-red-300">
                        Naive Baseline: flag any account with txn ≥ $10,000
                      </p>
                      <p className="text-[10px] text-red-500/80">
                        {nb.flagged?.toLocaleString() ?? 0} accounts flagged ·
                        Precision {((nb.precision ?? 0) * 100).toFixed(2)}% ·
                        Recall {((nb.recall ?? 0) * 100).toFixed(1)}% ·
                        F1 {((nb.f1 ?? 0) * 100).toFixed(2)}%
                      </p>
                      <p className="text-[10px] text-slate-600 italic">
                        This is the "traditional approach" problem — excessive false positives, low precision
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Rule-based cards */}
              {Array.isArray(metrics.rules) && (
                <div>
                  <h3 className="text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em] mb-3">
                    FinSherlock Detection Rules
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {metrics.rules.map((rule, i) => (
                      <RuleCard key={i} rule={rule} naive={nb} />
                    ))}
                  </div>
                </div>
              )}

              {/* XGBoost model */}
              {xgb && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-300">
                      XGBoost Supervised Model
                    </span>
                    <span className="text-[9px] font-mono text-slate-600">
                      threshold: {xgb.threshold} · PR-AUC: {xgb.pr_auc}
                    </span>
                  </div>
                  <MetricBar label="Precision" value={xgb.precision} color="bg-emerald-500" />
                  <MetricBar label="Recall" value={xgb.recall} color="bg-blue-500" />
                  <MetricBar label="F1 Score" value={xgb.f1} color="bg-violet-500" />
                </div>
              )}

              {/* Dataset summary */}
              {metrics.dataset && (
                <div className="text-[9px] text-slate-700 text-center font-mono">
                  IBM HI-Small AML · {metrics.dataset.total_rows?.toLocaleString() ?? 0} transactions ·
                  {' '}{metrics.dataset.labeled_laundering?.toLocaleString() ?? 0} labeled laundering
                  ({metrics.dataset.laundering_rate_pct ?? 0}%)
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
