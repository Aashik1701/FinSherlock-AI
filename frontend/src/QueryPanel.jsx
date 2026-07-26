import { useState, useCallback } from 'react'

const TYPOLOGIES = [
  { key: 'structuring', label: 'Structuring', tag: 'BSA · CTR', color: '#0ea5e9', bg: '#f0f9ff', border: '#bae6fd',
    subtitle: 'Sub-threshold cash deposits', query: 'Find structuring patterns in recent transactions' },
  { key: 'smurfing', label: 'Smurfing', tag: 'BSA · SAR', color: '#8b5cf6', bg: '#f5f3ff', border: '#ddd6fe',
    subtitle: 'Multi-account fund dispersal', query: 'Are there smurfing or fan-out patterns across multiple accounts?' },
  { key: 'layering', label: 'Layering', tag: 'BSA · SAR', color: '#f59e0b', bg: '#fffbeb', border: '#fde68a',
    subtitle: 'Multi-hop chain obfuscation', query: 'Analyze the transaction network for suspicious layering chains' },
  { key: 'mule_ring', label: 'Mule Rings', tag: 'Graph · Louvain', color: '#e11d48', bg: '#fff1f2', border: '#fecdd3',
    subtitle: 'Coordinated ring detection', query: 'Find coordinated mule ring communities in the transaction network' },
  { key: 'velocity', label: 'Velocity Spikes', tag: 'FinCEN · SAR', color: '#f97316', bg: '#fff7ed', border: '#fed7aa',
    subtitle: 'Sudden transaction frequency surge', query: 'Which accounts showed sudden velocity spikes in transaction frequency?' },
]

const AUTOPILOT_SCRIPT = [
  'Find structuring patterns in recent transactions',
  'Find coordinated mule ring communities in the transaction network',
  'Which accounts showed sudden velocity spikes in transaction frequency?',
]

const fmtAge = ts => {
  const diff = Date.now() - ts
  if (diff < 60_000)     return 'just now'
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

export default function QueryPanel({ onSubmit, loading, queryHistory = [] }) {
  const [query,       setQuery]       = useState('')
  const [autopilot,   setAutopilot]   = useState(false)
  const [apStep,      setApStep]      = useState(-1)
  const [showHistory, setShowHistory] = useState(false)

  const run = useCallback((q) => {
    const target = (q ?? query).trim()
    if (!target || loading) return
    setQuery(target)
    onSubmit(target)
  }, [query, loading, onSubmit])

  const startAutopilot = async () => {
    if (loading || autopilot) return
    setAutopilot(true)
    for (let i = 0; i < AUTOPILOT_SCRIPT.length; i++) {
      setApStep(i)
      setQuery(AUTOPILOT_SCRIPT[i])
      onSubmit(AUTOPILOT_SCRIPT[i])
      if (i < AUTOPILOT_SCRIPT.length - 1) await new Promise(r => setTimeout(r, 4000))
    }
    setAutopilot(false)
    setApStep(-1)
  }

  return (
    <section className="space-y-5">
      {/* Eyebrow + Demo Autopilot */}
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">Agentic Investigator</p>
          <h2 className="text-xl font-bold text-gray-900 mt-1">Ask FinSherlock in plain English.</h2>
        </div>
        <button
          onClick={startAutopilot}
          disabled={loading || autopilot}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-600 active:bg-orange-700 disabled:bg-gray-200 disabled:text-gray-400 text-white text-[11px] font-bold transition-all disabled:cursor-not-allowed shadow-sm"
        >
          {autopilot ? (
            <>
              <span className="w-2 h-2 rounded-full bg-white animate-ping" />
              Demo Running ({apStep + 1}/{AUTOPILOT_SCRIPT.length})…
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Demo Autopilot
            </>
          )}
        </button>
      </div>

      {/* Input */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && run()}
            placeholder="e.g. Find structuring patterns in the last 30 days across cash deposits under $10,000"
            className="w-full bg-white border border-gray-300 rounded-xl pl-10 pr-5 py-3.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all font-mono shadow-sm"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={() => run()}
          disabled={!query.trim() || loading}
          className="px-6 py-3.5 bg-orange-500 hover:bg-orange-600 active:bg-orange-700 disabled:bg-gray-200 disabled:text-gray-400 text-white text-sm font-semibold rounded-xl transition-all shadow-sm disabled:shadow-none"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Running…
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Investigate
            </span>
          )}
        </button>
      </div>

      {/* Quick filter chips + Query history */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold text-gray-400 tracking-wider uppercase mr-1">Quick:</span>
        {TYPOLOGIES.map(t => (
          <button
            key={t.key}
            onClick={() => run(t.query)}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg border text-[10px] font-semibold font-mono transition-all disabled:opacity-40 hover:shadow-sm"
            style={{ borderColor: t.border, backgroundColor: t.bg, color: t.color }}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={async () => {
            try {
              const res = await fetch('http://localhost:8000/simulate-attack', { method: 'POST' })
              const data = await res.json()
              if (data.query) run(data.query)
            } catch { /* ignore */ }
          }}
          className="px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 text-red-600 font-mono text-[10px] font-semibold transition-all hover:bg-red-100"
        >
          Live Attack
        </button>
        {queryHistory.length > 0 && (
          <button
            onClick={() => setShowHistory(h => !h)}
            className="px-3 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 font-mono text-[10px] hover:text-gray-700 transition-all ml-auto"
          >
            {showHistory ? '↑ History' : `↓ History (${queryHistory.length})`}
          </button>
        )}
      </div>

      {/* History */}
      {showHistory && queryHistory.length > 0 && (
        <div className="bg-white border border-gray-200/80 rounded-xl p-3 space-y-1 shadow-sm">
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">Recent Queries</p>
          {queryHistory.map((h, i) => (
            <button key={i} onClick={() => { run(h.query); setShowHistory(false) }} disabled={loading}
              className="w-full text-left flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-gray-50/80 transition-colors">
              <span className="text-xs text-gray-600 font-mono truncate">{h.query}</span>
              <span className="text-[10px] text-gray-400 shrink-0">{fmtAge(h.ts)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
