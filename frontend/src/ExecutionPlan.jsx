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

export default function ExecutionPlan({ plan = [], plannerSource, timing = {}, errors = [], toolStatus = {}, fullResult = null }) {
  const totalTime = Object.values(timing).reduce((a, b) => a + b, 0)
  const maxTime   = Math.max(...Object.values(timing), 0.001)

  const handleExportAudit = () => {
    const auditData = {
      timestamp: new Date().toISOString(),
      planner_source: plannerSource,
      wall_clock_seconds: totalTime,
      plan_steps: plan,
      step_timing: timing,
      errors: errors,
      full_result: fullResult
    }
    const blob = new Blob([JSON.stringify(auditData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fin_sherlock_audit_log_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 px-5 py-4 border-b border-slate-800/60">
        <div className="space-y-0.5">
          <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
            Agentic Execution Plan
          </h2>
          <p className="text-[10px] text-slate-700 font-mono">
            {plan.length} tools · {totalTime > 0 ? `${totalTime.toFixed(2)}s wall-clock` : 'running…'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExportAudit}
            className="px-2.5 py-1 rounded border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-[10px] font-mono text-slate-300 transition-colors"
            title="Download complete decision audit log as JSON"
          >
            ↓ Export Audit Log
          </button>
          <PlannerBadge source={plannerSource} />
        </div>
      </div>

      {/* Steps */}
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-start gap-y-3 gap-x-1">
          {plan.map((step, i) => {
            const meta    = TOOL_META[step.tool] ?? { label: step.tool, dot: 'bg-slate-500', text: 'text-slate-400' }
            const t       = timing[step.tool]
            const status  = toolStatus[step.tool]
            const isFailed  = status === 'error' || errors.includes(step.tool)
            const isRunning = status === 'running'
            const isPending = status === 'pending'
            const isDone    = !isPending && !isRunning && !isFailed

            return (
              <span key={i} className="inline-flex items-center gap-1">
                <span className={`inline-flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border transition-all duration-300 ${
                  isFailed
                    ? 'bg-red-950/30 border-red-900/60'
                    : isRunning
                      ? 'bg-slate-800/90 border-slate-600 shadow-sm shadow-blue-950/30'
                      : isPending
                        ? 'bg-slate-900/40 border-slate-800/40 opacity-40'
                        : 'bg-slate-800/70 border-slate-700/60'
                }`}>
                  {/* Dot + label */}
                  <span className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      isFailed  ? 'bg-red-500' :
                      isRunning ? `${meta.dot} animate-pulse` :
                      isPending ? 'bg-slate-600' :
                      meta.dot
                    }`} />
                    <span className={`text-[10px] font-bold font-mono ${
                      isFailed  ? 'text-red-400' :
                      isPending ? 'text-slate-600' :
                      meta.text
                    }`}>
                      {step.tool}
                    </span>
                  </span>

                  {/* Timing / status line */}
                  <span className="text-[9px] font-mono text-slate-600">
                    {isFailed  ? '✕ failed' :
                     isRunning ? (
                       <span className="flex items-center gap-1">
                         <span className="w-2 h-2 border border-slate-500 border-t-slate-300 rounded-full animate-spin" />
                         running…
                       </span>
                     ) :
                     isPending ? '—' :
                     t != null  ? `${t.toFixed(2)}s` : '—'}
                  </span>

                  {/* Timing bar — only when done with a time value */}
                  {isDone && t != null && !isFailed && (
                    <div className="w-full h-0.5 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${meta.dot} opacity-60 transition-all duration-500`}
                        style={{ width: `${Math.min((t / maxTime) * 100, 100)}%` }}
                      />
                    </div>
                  )}
                </span>

                {i < plan.length - 1 && (
                  <span className={`text-xs pb-5 transition-colors duration-300 ${
                    isPending ? 'text-slate-800' : 'text-slate-700'
                  }`}>→</span>
                )}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
