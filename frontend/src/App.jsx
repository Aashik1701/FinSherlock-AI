import { useState, useEffect, useCallback } from 'react'
import QueryPanel      from './QueryPanel'
import ExecutionPlan   from './ExecutionPlan'
import FindingCard     from './FindingCard'
import HeatmapView     from './HeatmapView'
import Watchlist       from './Watchlist'
import Cases           from './Cases'
import LiveStream      from './LiveStream'
import ExecutiveSummary from './ExecutiveSummary'
import RingView        from './RingView'
import ThreatRadar     from './ThreatRadar'
import VelocitySurgeTable from './VelocitySurgeTable'
import { useTheme } from './ThemeContext'
import CopilotWidget  from './CopilotWidget'

const API_BASE = 'http://localhost:8000'

function ThemeToggle() {
  const { isDark, toggleTheme } = useTheme()
  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ) : (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  )
}

function LiveClock() {
  const [t, setT] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="font-mono text-[11px] text-gray-500 tabular-nums">
      {t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      {' · '}
      {t.toLocaleTimeString('en-US', { hour12: false })}
    </span>
  )
}

function HealthDot() {
  const [ok, setOk] = useState(true)
  useEffect(() => {
    const check = () => {
      fetch(`${API_BASE}/`)
        .then(r => setOk(r.ok))
        .catch(() => setOk(false))
    }
    check()
    const id = setInterval(check, 15000)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
      <span className="text-[10px] text-gray-400 font-mono">localhost:8000</span>
    </span>
  )
}

export default function App() {
  const [activeTab,  setActiveTab]  = useState('investigate')
  const [loading,    setLoading]    = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState(null)
  const [toolStatus, setToolStatus] = useState({})

  const [summaryVersion, setSummaryVersion] = useState(0)

  const refreshSummary = useCallback(() => setSummaryVersion(v => v + 1), [])

  const [queryHistory, setQueryHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fs_query_history') ?? '[]') }
    catch { return [] }
  })

  const addToHistory = useCallback((q) => {
    setQueryHistory(prev => {
      const next = [{ query: q, ts: Date.now() }, ...prev.filter(h => h.query !== q)].slice(0, 8)
      try { localStorage.setItem('fs_query_history', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const investigate = async (query) => {
    setLoading(true)
    setResult(null)
    setError(null)
    setToolStatus({})
    addToHistory(query)

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
      refreshSummary()
    }
  }

  const plan             = result?.plan?.plan                      ?? []
  const plannerSource    = result?.plan?.planner_source             ?? ''
  const timing           = result?.timing                          ?? {}
  const errors           = result?.errors                          ?? []
  const eda              = result?.results?.run_eda                ?? null
  const engineerFeatures = result?.results?.engineer_features      ?? null
  const structuringData  = result?.results?.detect_structuring     ?? null
  const smurfingData     = result?.results?.detect_smurfing        ?? null
  const layeringData     = result?.results?.detect_layering        ?? null
  const classifyData     = result?.results?.classify_risk          ?? null
  const explanations     = result?.results?.explain_flag?.explanations ?? []
  const muleRingData     = result?.results?.detect_mule_rings      ?? null
  const velocityData     = result?.results?.detect_velocity_spikes ?? null
  const shapData         = result?.results?.shap_explain           ?? null

  const TABS = [
    { key: 'investigate', label: 'Investigate' },
    { key: 'watchlist',   label: 'Watchlist' },
    { key: 'cases',       label: 'Cases' },
    { key: 'stream',      label: 'Live Stream' },
  ]

return (
    <div className="min-h-screen bg-[var(--bg-page)] flex flex-col">

      {/* ─── Header ───────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 bg-[var(--bg-card)]/95 backdrop-blur-md border-b border-[var(--border-card)]/80 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14 sm:h-16">

            {/* Logo */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center font-mono font-bold text-white text-sm shadow-md shrink-0">
                FS
                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-orange-500 rounded-full border-2 border-white" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-sm font-bold text-[var(--text-primary)] tracking-tight whitespace-nowrap">FinSherlockAI</h1>
                  
                </div>
                <p className="hidden sm:block text-[10px] text-[var(--text-muted)] mt-0.5 truncate">
                  Autonomous Agentic AML Investigation
                </p>
              </div>
            </div>

            {/* Right side */}
            <div className="flex items-center gap-3 shrink-0">
              <HealthDot />
              <div className="w-px h-4 bg-[var(--border-card)]" />
              <LiveClock />
              <div className="w-px h-4 bg-[var(--border-card)]" />
              <ThemeToggle />
              <a
                href="#"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-card)] bg-[var(--bg-card-hover)] hover:bg-[var(--border-card)]/50 text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
                Docs
              </a>
            </div>
          </div>

          {/* Tab nav */}
          <nav className="flex items-center gap-0 -mb-px overflow-x-auto">
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-4 py-2.5 text-[11px] font-semibold whitespace-nowrap border-b-2 transition-all ${
                  activeTab === key
                    ? 'border-orange-500 text-[var(--text-primary)]'
                    : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-card)]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* ─── Main ─────────────────────────────────────────────── */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 space-y-6">

        {activeTab === 'investigate' && (
          <div className="space-y-6">
            {/* Hero + Query */}
            <QueryPanel onSubmit={investigate} loading={loading} queryHistory={queryHistory} />

            {/* Loading state */}
            {loading && !result && (
              <div className="card space-y-4">
                <div className="flex items-center gap-3">
                  <span className="w-4 h-4 border-2 border-orange-500 border-t-transparent rounded-full animate-spin shrink-0" />
                  <span className="text-sm text-[var(--text-secondary)] font-medium">Running agentic investigation chain…</span>
                </div>
                <div className="space-y-2">
                  {[
                    'Parsing query intent and building execution plan…',
                    'Running feature engineering on the dataset…',
                    'Applying detection algorithms…',
                    'Classifying risk and generating explanations…',
                  ].map((step, i) => (
                    <div key={i} className="flex items-center gap-2.5 text-xs text-[var(--text-muted)]">
                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse shrink-0" style={{ animationDelay: `${i * 300}ms` }} />
                      {step}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="bg-[var(--red-bg)] border border-[var(--red-border)] rounded-2xl p-5 flex gap-3">
                <span className="text-[var(--red)] text-base shrink-0 mt-0.5 font-bold">!</span>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-[var(--red)]">Investigation Failed</p>
                  <p className="text-xs text-[var(--red)] break-words">{error}</p>
                </div>
              </div>
            )}

            {/* Results */}
            {result && (
              <div className="space-y-6">

                {/* Executive Summary + Plan Trace — side by side */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 card">
                    <ExecutiveSummary version={summaryVersion} />
                  </div>
                  <div className="card">
                    <ExecutionPlan
                      plan={plan}
                      plannerSource={plannerSource}
                      timing={timing}
                      errors={errors}
                      toolStatus={toolStatus}
                      fullResult={result}
                    />
                  </div>
                </div>

                {/* Threat Radar + Velocity Surge Table — side by side */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="card">
                    <ThreatRadar version={summaryVersion} />
                  </div>
                  <div className="card">
                    <VelocitySurgeTable velocityData={velocityData} />
                  </div>
                </div>

                {/* 24-Hour Transaction Density — full width */}
                {eda && (
                  <div className="card">
                    <HeatmapView edaData={eda} />
                  </div>
                )}

                {/* Mule Rings */}
                <RingView
                  muleRingData={muleRingData}
                  velocityData={velocityData}
                />

                {/* Evidence-Grounded Findings */}
                {explanations.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="eyebrow">Evidence-Grounded Findings</p>
                        <p className="text-sm text-[var(--text-secondary)] mt-1">
                          Results for: <span className="font-semibold text-orange-600 italic">"{result?.plan?.query ?? 'investigation'}"</span>
                        </p>
                      </div>
                      <span className="text-[10px] text-[var(--text-muted)] font-mono">
                        {explanations.length} finding{explanations.length !== 1 ? 's' : ''} · sorted by risk
                      </span>
                    </div>
                    {explanations.map(exp => (
                      <FindingCard
                        key={exp.account_id}
                        exp={exp}
                        structuringData={structuringData}
                        smurfingData={smurfingData}
                        layeringData={layeringData}
                        classifyData={classifyData}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'watchlist' && <Watchlist />}
        {activeTab === 'cases' && <Cases />}
        {activeTab === 'stream' && <LiveStream />}
      </main>

      {/* ─── Footer ───────────────────────────────────────────── */}
      <footer className="border-t border-[var(--border-card)]/80 bg-[var(--bg-card)]/80 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col sm:flex-row items-center sm:justify-between gap-1">
          <p className="text-[10px] text-[var(--text-muted)] font-mono text-center sm:text-left">
            deterministic detection · evidence-grounded explanations · LLM never decides risk
          </p>
          <p className="text-[10px] text-[var(--text-muted)] text-center sm:text-right">
            IBM HI-Small AML Dataset · FinSherlock AI v1.0
          </p>
        </div>
      </footer>

      <CopilotWidget />
    </div>
  )
}
