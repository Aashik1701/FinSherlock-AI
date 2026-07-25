import { useState } from 'react'

const API_BASE = 'http://localhost:8000'

const EXAMPLES = [
  {
    label: 'Structuring',
    sub: 'Sub-threshold cash deposits',
    query: 'Find structuring patterns in recent transactions',
  },
  {
    label: 'Smurfing',
    sub: 'Multi-account dispersion',
    query: 'Are there smurfing or fan-out patterns across multiple accounts?',
  },
  {
    label: 'Layering',
    sub: 'Multi-hop fund movement',
    query: 'Analyze the transaction network for suspicious layering chains',
  },
]

const RISK_STYLES = {
  high:   { border: 'border-l-red-500',     badge: 'bg-red-900/50 text-red-300 border-red-800',     score: 'text-red-400' },
  medium: { border: 'border-l-amber-500',   badge: 'bg-amber-900/50 text-amber-300 border-amber-800', score: 'text-amber-400' },
  low:    { border: 'border-l-emerald-500', badge: 'bg-emerald-900/50 text-emerald-300 border-emerald-800', score: 'text-emerald-400' },
}

const ESC_STYLES = {
  report:  'text-red-400 bg-red-950/60 border-red-900',
  review:  'text-amber-400 bg-amber-950/60 border-amber-900',
  monitor: 'text-emerald-400 bg-emerald-950/60 border-emerald-900',
}

function PlannerBadge({ source }) {
  if (!source) return null
  const isLLM = source.startsWith('llm:')
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-mono border ${
      isLLM
        ? 'bg-violet-900/40 text-violet-300 border-violet-800'
        : 'bg-gray-800 text-gray-400 border-gray-700'
    }`}>
      {isLLM ? `LLM · ${source.replace('llm:', '')}` : 'deterministic'}
    </span>
  )
}

function ExecutionPlan({ plan, source, timing, errors }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
          Agentic Execution Plan
        </h2>
        <PlannerBadge source={source} />
      </div>

      <div className="flex flex-wrap items-start gap-1.5">
        {plan.map((step, i) => {
          const t = timing?.[step.tool]
          return (
            <span key={i} className="inline-flex items-center gap-1.5">
              <span className="inline-flex flex-col items-center">
                <span className="px-2.5 py-1 bg-gray-800 border border-gray-700 rounded-lg font-mono text-xs text-blue-300 whitespace-nowrap">
                  {step.tool}
                </span>
                {t != null && (
                  <span className="text-gray-700 text-[10px] mt-0.5">{t.toFixed(2)}s</span>
                )}
              </span>
              {i < plan.length - 1 && (
                <span className="text-gray-700 text-sm pb-4">&rarr;</span>
              )}
            </span>
          )
        })}
      </div>

      {errors?.length > 0 && (
        <p className="text-xs text-red-400">Failed: {errors.join(', ')}</p>
      )}
    </div>
  )
}

function FindingCard({ exp }) {
  const risk = RISK_STYLES[exp.risk_level] ?? RISK_STYLES.low
  const escCls = ESC_STYLES[exp.escalation] ?? 'text-gray-400 bg-gray-800 border-gray-700'

  return (
    <div className={`bg-gray-900 border border-gray-800 border-l-4 ${risk.border} rounded-xl p-5 space-y-4`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono font-bold text-gray-100 text-base">{exp.account_id}</span>
          <span className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide border ${risk.badge}`}>
            {exp.risk_level}
          </span>
          <span className="text-gray-600 text-sm">
            score: <span className={risk.score}>{exp.risk_score?.toFixed(1)}</span>
          </span>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${escCls}`}>
          {exp.escalation}
        </span>
      </div>

      {exp.instruction && (
        <p className="text-xs text-gray-500 italic border-l-2 border-gray-800 pl-3">
          {exp.instruction}
        </p>
      )}

      <p className="text-sm text-gray-200 leading-relaxed">{exp.explanation}</p>

      {exp.evidence_cited?.length > 0 && (
        <div className="pt-1">
          <p className="text-[10px] text-gray-600 uppercase tracking-widest mb-2">Evidence Cited</p>
          <div className="space-y-1.5">
            {exp.evidence_cited.map((e, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-indigo-600 text-xs mt-0.5 shrink-0">&#9670;</span>
                <span className="text-xs text-gray-400 font-mono leading-relaxed">{e}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RawResponse({ data }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-900/60 hover:bg-gray-900 text-sm text-gray-500 hover:text-gray-400 transition-colors"
      >
        <span className="font-mono text-xs">raw response JSON</span>
        <span className="text-gray-700 text-xs">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>
      {open && (
        <pre className="bg-gray-950 px-5 py-4 text-[11px] text-gray-500 font-mono overflow-x-auto max-h-96 overflow-y-auto border-t border-gray-800 leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

export default function App() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const investigate = async (overrideQuery) => {
    const q = (overrideQuery ?? query).trim()
    if (!q || loading) return
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Server returned ${res.status}${body ? ': ' + body : ''}`)
      }
      setResult(await res.json())
    } catch (e) {
      const msg = String(e.message ?? e)
      setError(
        msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network')
          ? 'Cannot reach the backend. Is uvicorn running on http://localhost:8000?'
          : msg,
      )
    } finally {
      setLoading(false)
    }
  }

  const handleExample = (q) => {
    setQuery(q)
    investigate(q)
  }

  const plan         = result?.plan?.plan ?? []
  const planSource   = result?.plan?.planner_source ?? ''
  const timing       = result?.timing ?? {}
  const errors       = result?.errors ?? []
  const explanations = result?.results?.explain_flag?.explanations ?? []

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">

      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-base font-bold text-blue-400 tracking-tight">FinSherlock AI</h1>
            <p className="text-[11px] text-gray-600 mt-0.5">
              Agentic AML Investigation &middot; Societe Generale Hackathon
            </p>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-gray-600 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            localhost:8000
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-5 py-8 space-y-6">

        {/* Query panel */}
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map(({ label, sub, query: q }) => (
              <button
                key={label}
                onClick={() => handleExample(q)}
                disabled={loading}
                className="group flex flex-col text-left px-3 py-2 rounded-lg border border-gray-800 bg-gray-900 hover:border-blue-700 hover:bg-blue-950/30 disabled:opacity-40 transition-all"
              >
                <span className="text-xs font-semibold text-gray-300 group-hover:text-blue-300">{label}</span>
                <span className="text-[10px] text-gray-600 group-hover:text-blue-500">{sub}</span>
              </button>
            ))}
          </div>

          <div className="flex gap-3">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && investigate()}
              placeholder="e.g. Find structuring patterns in the last 30 days..."
              className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-gray-100 placeholder-gray-700 focus:outline-none focus:border-blue-700 focus:ring-1 focus:ring-blue-700/20 transition-colors font-mono"
            />
            <button
              onClick={() => investigate()}
              disabled={!query.trim() || loading}
              className="px-5 py-2.5 bg-blue-700 hover:bg-blue-600 active:bg-blue-800 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
            >
              {loading ? 'Running...' : 'Investigate'}
            </button>
          </div>
        </section>

        {/* Loading */}
        {loading && (
          <div className="flex items-center gap-3 px-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-400">
            <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
            Running agentic investigation chain...
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="flex items-start gap-3 px-4 py-3 bg-red-950/30 border border-red-900/50 rounded-xl text-sm text-red-300">
            <span className="shrink-0 text-red-500 mt-0.5 font-bold">!</span>
            <span>{error}</span>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-5">

            <ExecutionPlan
              plan={plan}
              source={planSource}
              timing={timing}
              errors={errors}
            />

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
                  Findings
                </h2>
                {explanations.length > 0 && (
                  <span className="text-xs text-gray-500">
                    <span className="text-blue-400 font-semibold">{explanations.length}</span>
                    {' '}account{explanations.length !== 1 ? 's' : ''} flagged
                  </span>
                )}
              </div>

              {explanations.length === 0 ? (
                <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-10 text-center space-y-2">
                  <p className="text-sm text-gray-500">No accounts flagged for this query.</p>
                  <p className="text-xs text-gray-700">
                    The investigation ran successfully — no patterns exceeded the detection threshold.
                    Try loading the IBM AML dataset, or adjust the query.
                  </p>
                </div>
              ) : (
                explanations.map(exp => (
                  <FindingCard key={exp.account_id} exp={exp} />
                ))
              )}
            </section>

            <RawResponse data={result} />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-900 px-6 py-3">
        <p className="text-center text-[10px] text-gray-800 font-mono">
          deterministic detection &middot; evidence-grounded explanations &middot; no hallucinated numbers
        </p>
      </footer>
    </div>
  )
}
