const TOOL_META = {
  run_eda:              { label: 'Exploratory data analysis',           color: '#3b82f6', icon: '📊' },
  engineer_features:    { label: 'Feature engineering',                 color: '#6366f1', icon: '🔧' },
  detect_structuring:   { label: 'detect_structuring()',                color: '#0ea5e9', icon: '⚡' },
  detect_anomalies:     { label: 'isolation_forest() · anomaly',        color: '#a855f7', icon: '🔍' },
  detect_smurfing:      { label: 'graph_smurfing() · fan-out',          color: '#8b5cf6', icon: '🔄' },
  detect_layering:      { label: 'graph_layering() · NetworkX',         color: '#f59e0b', icon: '🔗' },
  ml_risk_score:        { label: 'ml_risk_score() · XGBoost',           color: '#f43f5e', icon: '🎯' },
  classify_risk:        { label: 'classify_risk() · H/M/L',            color: '#f97316', icon: '📋' },
  explain_flag:         { label: 'draft_sar() · BSA/FinCEN',            color: '#10b981', icon: '📝' },
  detect_mule_rings:    { label: 'louvain_communities() · mule rings',  color: '#e11d48', icon: '⭕' },
  detect_velocity_spikes: { label: 'velocity_spikes() · behavioral',   color: '#f97316', icon: '📈' },
  compute_pagerank:     { label: 'PageRank · centrality',               color: '#06b6d4', icon: '🌐' },
  detect_round_trips:   { label: 'round_trip() · cycle detection',      color: '#8b5cf6', icon: '🔄' },
  detect_cycles:        { label: 'cycle_detection() · graph cycles',    color: '#8b5cf6', icon: '🔄' },
  shap_explain:         { label: 'shap_explain() · attribution',        color: '#6366f1', icon: '🧬' },
}

export default function ExecutionPlan({ plan = [], plannerSource = '', timing = {}, errors = [], toolStatus = {}, fullResult = null }) {
  const totalTime = Object.values(timing).reduce((a, b) => a + b, 0)

  const handleExportAudit = () => {
    const audit = { timestamp: new Date().toISOString(), planner_source: plannerSource, wall_clock_seconds: totalTime, plan_steps: plan, step_timing: timing, errors, full_result: fullResult }
    const blob = new Blob([JSON.stringify(audit, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fin_sherlock_audit_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">Two-Brain Plan Trace</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            <span className="font-semibold text-[var(--text-primary)]">LLM Planner → Deterministic Tools</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-[var(--text-muted)] font-mono">
            total <span className="font-bold text-[var(--text-primary)]">{totalTime > 0 ? `${(totalTime * 1000).toFixed(0)}ms` : '…'}</span>
          </span>
          <button
            onClick={handleExportAudit}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-card)] bg-[var(--bg-card-hover)] hover:bg-[var(--border-card)] text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export Audit Log
          </button>
        </div>
      </div>

      {/* Step list */}
      <div className="space-y-1.5">
        {plan.map((step, i) => {
          const meta  = TOOL_META[step.tool] ?? { label: step.tool, color: '#9ca3af', icon: '🔧' }
          const t     = timing[step.tool]
          const status = toolStatus[step.tool]
          const isDone = status === 'done' || (status !== 'pending' && status !== 'running' && status !== 'error' && t != null)
          const isFailed = status === 'error' || errors.includes(step.tool)
          const isRunning = status === 'running'
          const isPending = status === 'pending' || !status

          return (
            <div
              key={i}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border transition-all ${
                isFailed
                  ? 'bg-red-50 border-red-200'
                  : isRunning
                    ? 'bg-orange-50 border-orange-200'
                    : isPending
                      ? 'bg-[var(--bg-card-hover)]/50 border-[var(--border-card)]'
                      : 'bg-[var(--bg-card)] border-[var(--border-card)]'
              }`}
            >
              {/* Step indicator */}
              <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                isFailed
                  ? 'bg-red-100 text-red-600'
                  : isDone
                    ? 'bg-emerald-100 text-emerald-600'
                    : isRunning
                      ? 'bg-orange-100 text-orange-600'
                      : 'bg-[var(--border-card)] text-[var(--text-muted)]'
              }`}>
                {isDone ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : isFailed ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <span className="text-[9px] font-bold font-mono">{String(i + 1).padStart(2, '0')}</span>
                )}
              </div>

              {/* Tool name */}
              <span className="flex-1 text-xs font-mono font-semibold" style={{ color: meta.color }}>
                {meta.label}
              </span>

              {/* Timing badge */}
              <span className={`text-[10px] font-mono tabular-nums ${
                isFailed  ? 'text-[var(--red)]' :
                isRunning ? 'text-[var(--orange)] animate-pulse' :
                isPending ? 'text-[var(--text-muted)]' :
                t != null ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'
              }`}>
                {isRunning  ? 'running…' :
                 isPending  ? '—' :
                 isFailed   ? `${(t * 1000).toFixed(0)}ms` :
                 t != null  ? `${(t * 1000).toFixed(0)}ms` : '—'}
              </span>

              {/* Status icon */}
              {isDone && (
                <svg className="w-4 h-4 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              {isRunning && (
                <span className="w-4 h-4 border-2 border-orange-400 border-t-transparent rounded-full animate-spin shrink-0" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
