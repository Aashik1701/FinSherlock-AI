import { useState, useEffect } from 'react'
import QueryPanel    from './QueryPanel'
import ExecutionPlan from './ExecutionPlan'
import FindingCard   from './FindingCard'
import MetricsPanel  from './MetricsPanel'
import HeatmapView   from './HeatmapView'
import ErrorBoundary from './ErrorBoundary'
import Watchlist     from './Watchlist'
import Cases         from './Cases'
import LiveStream    from './LiveStream'

const API_BASE = 'http://localhost:8000'

// ─── Utilities ─────────────────────────────────────────────────────────────

const fmtDate = str => {
  try {
    return new Date(str.replace(' ', 'T')).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch { return str }
}

const fmtShortDate = str => {
  try {
    return new Date(str.replace(' ', 'T')).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    })
  } catch { return str }
}

// ─── Small components ───────────────────────────────────────────────────────

function LiveClock() {
  const [t, setT] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="font-mono text-[11px] text-slate-600 tabular-nums">
      {t.toLocaleTimeString('en-US', { hour12: false })}
    </span>
  )
}

function Stat({ label, value, sub, accent = 'text-slate-100' }) {
  return (
    <div className="bg-slate-900/80 border border-slate-800/80 rounded-xl px-4 py-3.5 space-y-1 min-w-0 shadow-sm hover:border-slate-700/80 transition-colors">
      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.18em] truncate">{label}</p>
      <p className={`text-xl font-bold font-mono leading-none ${accent}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-500 truncate">{sub}</p>}
    </div>
  )
}

function RiskDistBar({ explanations }) {
  if (!explanations.length) return null
  const n = explanations.length
  const high = explanations.filter(e => e.risk_level === 'high').length
  const med  = explanations.filter(e => e.risk_level === 'medium').length
  const low  = n - high - med
  return (
    <div className="space-y-1.5">
      <div className="flex h-2 rounded-full overflow-hidden gap-px">
        {high > 0 && <div className="bg-red-500 rounded-l-full" style={{ flex: high }} />}
        {med  > 0 && <div className="bg-amber-500" style={{ flex: med }} />}
        {low  > 0 && <div className="bg-emerald-500 rounded-r-full" style={{ flex: low }} />}
      </div>
      <div className="flex gap-4 text-[10px]">
        {high > 0 && <span className="flex items-center gap-1 text-red-400"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />{high} High</span>}
        {med  > 0 && <span className="flex items-center gap-1 text-amber-400"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{med} Medium</span>}
        {low  > 0 && <span className="flex items-center gap-1 text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{low} Low</span>}
      </div>
    </div>
  )
}

function DatasetOverview({ eda, engineerFeatures, structuringData, smurfingData, layeringData, explanations }) {
  if (!eda && !engineerFeatures) return null

  const launderingRows = eda?.laundering_label_dist?.find(r => r.is_laundering === true)
  const launderingCount = launderingRows?.count ?? 0

  return (
    <section className="space-y-3">
      <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
        Dataset Overview
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          label="Transactions Analyzed"
          value={eda?.total_rows?.toLocaleString() ?? '—'}
          sub={eda?.date_range ? `${fmtShortDate(eda.date_range.earliest)} – ${fmtShortDate(eda.date_range.latest)}` : null}
          accent="text-blue-400"
        />
        <Stat
          label="Avg Transaction"
          value={eda?.amount_stats ? `$${Math.round(eda.amount_stats.mean).toLocaleString()}` : '—'}
          sub={eda?.amount_stats ? `±$${Math.round(eda.amount_stats.stddev).toLocaleString()} std · median $${Math.round(eda.amount_stats.median).toLocaleString()}` : null}
        />
        <Stat
          label="Accounts Processed"
          value={(engineerFeatures?.accounts_processed ?? structuringData?.accounts_scanned ?? '—').toLocaleString?.() ?? '—'}
          sub="unique senders in window"
        />
        <Stat
          label="Labeled Laundering"
          value={launderingCount > 0 ? launderingCount.toLocaleString() : '—'}
          sub={launderingCount > 0 && eda?.total_rows ? `${((launderingCount / eda.total_rows) * 100).toFixed(3)}% of dataset` : 'IBM AML ground truth'}
          accent={launderingCount > 0 ? 'text-red-400' : 'text-slate-500'}
        />
      </div>

      {/* Detection summary */}
      {(structuringData || smurfingData || layeringData) && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3.5">
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-[11px]">
            {structuringData && (
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" />
                <span className="text-slate-500">Structuring threshold:</span>
                <span className="font-mono text-slate-300">${structuringData.threshold?.toLocaleString()} · band ${structuringData.near_lo?.toLocaleString()}–${structuringData.threshold?.toLocaleString()}</span>
              </span>
            )}
            {smurfingData && (
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-violet-500 shrink-0" />
                <span className="text-slate-500">Smurfing threshold:</span>
                <span className="font-mono text-slate-300">fan-out/in ≥ {smurfingData.fan_out_threshold}</span>
              </span>
            )}
            {layeringData && (
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                <span className="text-slate-500">Layering:</span>
                <span className="font-mono text-slate-300">min {layeringData.min_hops} hops · max {layeringData.max_gap_hours}h gap</span>
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function FindingsSection({ explanations, structuringData, smurfingData, layeringData, classifyData }) {
  return (
    <section className="space-y-4">
      {/* Section header */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">Findings</h2>
          <p className="text-[11px] text-slate-700">
            {explanations.length} account{explanations.length !== 1 ? 's' : ''} flagged for investigation
          </p>
        </div>
        {explanations.length > 0 && (
          <div className="w-48">
            <RiskDistBar explanations={explanations} />
          </div>
        )}
      </div>

      {/* Cards */}
      {explanations.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl px-6 py-14 text-center space-y-2">
          <p className="text-slate-500 font-medium">No accounts flagged for this query</p>
          <p className="text-xs text-slate-700 max-w-md mx-auto leading-relaxed">
            The investigation chain ran successfully — no patterns exceeded detection thresholds.
            Try loading more data with <code className="bg-slate-800 px-1 rounded text-slate-500">--limit 1000000</code>,
            or try a different typology query.
          </p>
        </div>
      ) : (
        explanations.map(exp => (
          <FindingCard
            key={exp.account_id}
            exp={exp}
            structuringData={structuringData}
            smurfingData={smurfingData}
            layeringData={layeringData}
            classifyData={classifyData}
          />
        ))
      )}
    </section>
  )
}

function RawResponse({ data }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-slate-800 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-3.5 bg-slate-900/60 hover:bg-slate-900 transition-colors"
      >
        <span className="text-[10px] font-mono text-slate-600">raw API response JSON</span>
        <span className="text-slate-700 text-[10px]">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>
      {open && (
        <pre className="bg-slate-950 px-5 py-4 text-[10px] text-slate-600 font-mono overflow-x-auto max-h-[480px] overflow-y-auto border-t border-slate-800 leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

function LoadingState() {
  const steps = [
    'Parsing query intent and building execution plan…',
    'Running exploratory analysis on the dataset…',
    'Applying detection algorithms…',
    'Classifying risk and generating explanations…',
  ]
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
      <div className="flex items-center gap-3">
        <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
        <span className="text-sm text-slate-300 font-medium">Running agentic investigation chain…</span>
      </div>
      <div className="space-y-3 pl-1">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3">
            <span
              className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0"
              style={{ animationDelay: `${i * 300}ms` }}
            />
            <span className="text-xs text-slate-600">{step}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Root ───────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab,  setActiveTab]  = useState('investigate')
  const [loading,    setLoading]    = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState(null)
  const [toolStatus, setToolStatus] = useState({})

  const investigate = async (query) => {
    setLoading(true)
    setResult(null)
    setError(null)
    setToolStatus({})

    try {
      const res = await fetch(`${API_BASE}/investigate/stream`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query }),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`)
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event
          try { event = JSON.parse(line.slice(6)) } catch { continue }

          if (event.type === 'plan') {
            const initial = {}
            for (const step of event.plan?.plan ?? []) initial[step.tool] = 'pending'
            setToolStatus(initial)
            setResult({ plan: event.plan, results: {}, timing: {}, errors: [] })

          } else if (event.type === 'tool_start') {
            setToolStatus(prev => ({ ...prev, [event.tool]: 'running' }))

          } else if (event.type === 'tool_done') {
            setToolStatus(prev => ({ ...prev, [event.tool]: 'done' }))
            setResult(prev => prev ? {
              ...prev,
              results: { ...prev.results, [event.tool]: event.result },
              timing:  { ...prev.timing,  [event.tool]: event.elapsed },
            } : prev)

          } else if (event.type === 'tool_error') {
            setToolStatus(prev => ({ ...prev, [event.tool]: 'error' }))
            setResult(prev => prev ? {
              ...prev,
              errors:  [...prev.errors, event.tool],
              timing:  { ...prev.timing, [event.tool]: event.elapsed },
            } : prev)

          } else if (event.type === 'error') {
            setError(event.error)
          }
          // 'complete' → loading cleared in finally
        }
      }
    } catch (e) {
      const msg = String(e.message ?? e)
      setError(
        msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network')
          ? 'Cannot reach the backend at http://localhost:8000. Is uvicorn running?'
          : msg
      )
    } finally {
      setLoading(false)
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────
  const plan             = result?.plan?.plan               ?? []
  const plannerSource    = result?.plan?.planner_source     ?? ''
  const timing           = result?.timing                   ?? {}
  const errors           = result?.errors                   ?? []
  const eda              = result?.results?.run_eda         ?? null
  const engineerFeatures = result?.results?.engineer_features ?? null
  const structuringData  = result?.results?.detect_structuring ?? null
  const smurfingData     = result?.results?.detect_smurfing    ?? null
  const layeringData     = result?.results?.detect_layering    ?? null
  const classifyData     = result?.results?.classify_risk              ?? null
  const explanations     = result?.results?.explain_flag?.explanations ?? []

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 bg-[#0b0f19]/90 backdrop-blur-md border-b border-slate-800/80">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center font-mono font-bold text-blue-400 text-sm shadow-sm">
              FS
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold text-slate-100 tracking-tight">FinSherlock AI</h1>
                <span className="px-2 py-0.5 rounded text-[9px] font-mono font-semibold bg-blue-950/60 text-blue-300 border border-blue-800/60">
                  Soci&eacute;t&eacute; G&eacute;n&eacute;rale Hackathon
                </span>
              </div>
              <p className="text-[10px] text-slate-500 mt-0.5">
                Agentic Anti-Money Laundering Investigation Platform
              </p>
            </div>
          </div>

          {/* Tab navigation */}
          <nav className="flex items-center gap-1 bg-slate-950/60 rounded-lg p-0.5 border border-slate-800/50">
            <button
              onClick={() => setActiveTab('investigate')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all ${
                activeTab === 'investigate'
                  ? 'bg-slate-800 text-slate-100 shadow-sm'
                  : 'text-slate-600 hover:text-slate-400'
              }`}
            >
              Investigate
            </button>
            <button
              onClick={() => setActiveTab('watchlist')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all ${
                activeTab === 'watchlist'
                  ? 'bg-slate-800 text-slate-100 shadow-sm'
                  : 'text-slate-600 hover:text-slate-400'
              }`}
            >
              Watchlist
            </button>
            <button
              onClick={() => setActiveTab('cases')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all ${
                activeTab === 'cases'
                  ? 'bg-slate-800 text-slate-100 shadow-sm'
                  : 'text-slate-600 hover:text-slate-400'
              }`}
            >
              Cases
            </button>
            <button
              onClick={() => setActiveTab('stream')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all ${
                activeTab === 'stream'
                  ? 'bg-slate-800 text-slate-100 shadow-sm'
                  : 'text-slate-600 hover:text-slate-400'
              }`}
            >
              Live Stream
            </button>
          </nav>

          <div className="flex items-center gap-5 shrink-0">
            {result && (
              <div className="hidden sm:flex items-center gap-4 text-[10px] text-slate-500 font-mono">
                <span>{explanations.length} flagged</span>
                <span className="w-px h-3 bg-slate-800" />
                <span>{Object.values(timing).reduce((a, b) => a + b, 0).toFixed(2)}s</span>
              </div>
            )}
            <div className="w-px h-4 bg-slate-800 hidden sm:block" />
            <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              localhost:8000
            </div>
            <div className="w-px h-4 bg-slate-800 hidden sm:block" />
            <LiveClock />
          </div>
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-10 space-y-10">

        {activeTab === 'investigate' && (
          <>
            <QueryPanel onSubmit={investigate} loading={loading} />

            {/* Loading — only while waiting for the first plan event */}
            {loading && !result && <LoadingState />}

            {/* Error */}
            {error && (
              <div className="bg-red-950/20 border border-red-900/40 rounded-2xl p-5 flex gap-4">
                <span className="text-red-500 text-base shrink-0 mt-0.5">!</span>
                <div className="space-y-1 min-w-0">
                  <p className="text-sm font-semibold text-red-300">Investigation Failed</p>
                  <p className="text-xs text-red-500 break-words">{error}</p>
                </div>
              </div>
            )}

            {/* Results — rendered progressively as stream events arrive */}
            {result && (
              <div className="space-y-8">

                <ExecutionPlan
                  plan={plan}
                  plannerSource={plannerSource}
                  timing={timing}
                  errors={errors}
                  toolStatus={toolStatus}
                />

                <DatasetOverview
                  eda={eda}
                  engineerFeatures={engineerFeatures}
                  structuringData={structuringData}
                  smurfingData={smurfingData}
                  layeringData={layeringData}
                  explanations={explanations}
                />

                <FindingsSection
                  explanations={explanations}
                  structuringData={structuringData}
                  smurfingData={smurfingData}
                  layeringData={layeringData}
                  classifyData={classifyData}
                />

                {!loading && <RawResponse data={result} />}
              </div>
            )}
          </>
        )}

        {/* Results — rendered progressively as stream events arrive */}
        {result && (
          <ErrorBoundary>
            <div className="space-y-8">

              <ExecutionPlan
                plan={plan}
                plannerSource={plannerSource}
                timing={timing}
                errors={errors}
                toolStatus={toolStatus}
                fullResult={result}
              />

              <DatasetOverview
                eda={eda}
                engineerFeatures={engineerFeatures}
                structuringData={structuringData}
                smurfingData={smurfingData}
                layeringData={layeringData}
                explanations={explanations}
              />

              {eda && <HeatmapView edaData={eda} />}

              <FindingsSection
                explanations={explanations}
                structuringData={structuringData}
                smurfingData={smurfingData}
                layeringData={layeringData}
                classifyData={classifyData}
              />

              {!loading && <MetricsPanel />}

              {!loading && <RawResponse data={result} />}
            </div>
          </ErrorBoundary>
        {activeTab === 'watchlist' && (
          <Watchlist />
        )}

        {activeTab === 'cases' && (
          <Cases />
        )}

        {activeTab === 'stream' && (
          <LiveStream />
        )}
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-slate-900 mt-auto">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <p className="text-[10px] text-slate-800 font-mono">
            deterministic detection &middot; evidence-grounded explanations &middot; LLM never decides risk
          </p>
          <p className="text-[10px] text-slate-800 shrink-0">
            IBM HI-Small AML Dataset &middot; FinSherlock AI v1.0
          </p>
        </div>
      </footer>
    </div>
  )
}
