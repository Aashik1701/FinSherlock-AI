const TOOL_META = {
  run_eda:            { label: 'EDA',        dot: 'bg-blue-500',    text: 'text-blue-400' },
  engineer_features:  { label: 'Features',   dot: 'bg-indigo-500',  text: 'text-indigo-400' },
  detect_structuring: { label: 'Structuring',dot: 'bg-sky-500',     text: 'text-sky-400' },
  detect_anomalies:   { label: 'Anomaly',    dot: 'bg-purple-500',  text: 'text-purple-400' },
  detect_smurfing:    { label: 'Smurfing',   dot: 'bg-violet-500',  text: 'text-violet-400' },
  detect_layering:    { label: 'Layering',   dot: 'bg-amber-500',   text: 'text-amber-400' },
  ml_risk_score:      { label: 'ML Score',   dot: 'bg-rose-500',    text: 'text-rose-400' },
  classify_risk:      { label: 'Classify',   dot: 'bg-orange-500',  text: 'text-orange-400' },
  explain_flag:       { label: 'Explain',    dot: 'bg-emerald-500', text: 'text-emerald-400' },
}

function PlannerBadge({ source }) {
  if (!source) return null
  const isLLM = source.startsWith('llm:')
  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono border ${
      isLLM
        ? 'bg-violet-950/60 text-violet-300 border-violet-800'
        : 'bg-slate-800 text-slate-400 border-slate-700'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isLLM ? 'bg-violet-400 animate-pulse' : 'bg-slate-500'}`} />
      {isLLM ? source.replace('llm:', '') : 'deterministic planner'}
    </div>
  )
}

export default function ExecutionPlan({ plan = [], plannerSource, timing = {}, errors = [] }) {
  const totalTime = Object.values(timing).reduce((a, b) => a + b, 0)

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 px-5 py-4 border-b border-slate-800/60">
        <div className="space-y-0.5">
          <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
            Agentic Execution Plan
          </h2>
          <p className="text-[10px] text-slate-700 font-mono">
            {plan.length} tools · {totalTime.toFixed(2)}s wall-clock
          </p>
        </div>
        <PlannerBadge source={plannerSource} />
      </div>

      {/* Steps */}
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-start gap-y-3 gap-x-1">
          {plan.map((step, i) => {
            const meta = TOOL_META[step.tool] ?? { label: step.tool, dot: 'bg-slate-500', text: 'text-slate-400' }
            const t = timing[step.tool]
            const failed = errors.includes(step.tool)

            return (
              <span key={i} className="inline-flex items-center gap-1">
                <span className={`inline-flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border transition-colors ${
                  failed
                    ? 'bg-red-950/30 border-red-900/60'
                    : 'bg-slate-800/70 border-slate-700/60'
                }`}>
                  {/* Step number + dot */}
                  <span className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${failed ? 'bg-red-500' : meta.dot}`} />
                    <span className={`text-[10px] font-bold font-mono ${failed ? 'text-red-400' : meta.text}`}>
                      {step.tool}
                    </span>
                  </span>
                  {/* Timing */}
                  <span className="text-[9px] text-slate-600 font-mono">
                    {failed ? '✕ failed' : t != null ? `${t.toFixed(2)}s` : '—'}
                  </span>
                  {/* Timing bar */}
                  {t != null && !failed && (
                    <div className="w-full h-0.5 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${meta.dot} opacity-60`}
                        style={{ width: `${Math.min((t / Math.max(...Object.values(timing))) * 100, 100)}%` }}
                      />
                    </div>
                  )}
                </span>

                {i < plan.length - 1 && (
                  <span className="text-slate-700 text-xs pb-5">→</span>
                )}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
