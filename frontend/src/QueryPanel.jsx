import { useState } from 'react'

const TYPOLOGIES = [
  {
    key: 'structuring',
    label: 'Structuring',
    tag: 'BSA · CTR',
    tagCls: 'text-sky-400 border-sky-800/80 bg-sky-950/40',
    subtitle: 'Sub-threshold cash deposits',
    description:
      'Multiple deposits clustered just below the $10,000 FinCEN reporting threshold — a federal offense under 31 U.S.C. § 5324.',
    query: 'Find structuring patterns in recent transactions',
    accent: 'text-sky-400',
    border: 'border-slate-800 hover:border-sky-700/60',
    bg: 'bg-slate-900/60 hover:bg-slate-900',
    icon: (
      <svg viewBox="0 0 28 20" className="w-6 h-4" fill="currentColor">
        <rect x="0"  y="12" width="5" height="8" rx="1" opacity="0.4" />
        <rect x="7"  y="7"  width="5" height="13" rx="1" opacity="0.65" />
        <rect x="14" y="2"  width="5" height="18" rx="1" opacity="0.9" />
        <rect x="21" y="4"  width="5" height="16" rx="1" opacity="0.75" />
        <line x1="0" y1="5" x2="28" y2="5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 2" opacity="0.5" />
      </svg>
    ),
  },
  {
    key: 'smurfing',
    label: 'Smurfing',
    tag: 'BSA · SAR',
    tagCls: 'text-violet-400 border-violet-800/80 bg-violet-950/40',
    subtitle: 'Multi-account fund dispersal',
    description:
      'Funds split across many counterparty accounts to evade detection — identified by fan-out / fan-in degree in the transaction graph.',
    query: 'Are there smurfing or fan-out patterns across multiple accounts?',
    accent: 'text-violet-400',
    border: 'border-slate-800 hover:border-violet-700/60',
    bg: 'bg-slate-900/60 hover:bg-slate-900',
    icon: (
      <svg viewBox="0 0 28 28" className="w-6 h-6" fill="currentColor">
        <circle cx="14" cy="14" r="3" />
        {[0, 51, 102, 153, 204, 255, 306].map((deg, i) => {
          const a = (deg * Math.PI) / 180
          const x = 14 + 10 * Math.cos(a)
          const y = 14 + 10 * Math.sin(a)
          return (
            <g key={i} opacity={0.6 + i * 0.04}>
              <line x1="14" y1="14" x2={x} y2={y} stroke="currentColor" strokeWidth="1" />
              <circle cx={x} cy={y} r="1.8" />
            </g>
          )
        })}
      </svg>
    ),
  },
  {
    key: 'layering',
    label: 'Layering',
    tag: 'BSA · SAR',
    tagCls: 'text-amber-400 border-amber-800/80 bg-amber-950/40',
    subtitle: 'Multi-hop chain obfuscation',
    description:
      'Rapid sequential transfers through intermediary accounts to obscure fund origin — detected via time-constrained DFS path-finding.',
    query: 'Analyze the transaction network for suspicious layering chains',
    accent: 'text-amber-400',
    border: 'border-slate-800 hover:border-amber-700/60',
    bg: 'bg-slate-900/60 hover:bg-slate-900',
    icon: (
      <svg viewBox="0 0 36 14" className="w-8 h-3" fill="currentColor">
        {[0, 1, 2, 3].map(i => (
          <circle key={i} cx={3 + i * 10} cy="7" r="3" opacity={1 - i * 0.15} />
        ))}
        {[0, 1, 2].map(i => (
          <path key={i} d={`M${7 + i * 10} 7 L${10 + i * 10} 7`} stroke="currentColor" strokeWidth="1.5"
            fill="none" markerEnd="none" opacity={0.5} />
        ))}
        <polygon points="11,5 14,7 11,9" opacity="0.45" />
        <polygon points="21,5 24,7 21,9" opacity="0.45" />
        <polygon points="31,5 34,7 31,9" opacity="0.45" />
      </svg>
    ),
  },
]

export default function QueryPanel({ onSubmit, loading }) {
  const [query, setQuery] = useState('')

  const run = (q) => {
    const target = (q ?? query).trim()
    if (!target || loading) return
    setQuery(target)
    onSubmit(target)
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">
            Investigation Query
          </h2>
          <p className="text-xs text-slate-500">
            Ask in natural language — FinSherlock AI plans and runs the analytical tools automatically.
          </p>
        </div>
      </div>

      {/* Input bar */}
      <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
        <div className="relative flex-1">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && run()}
            placeholder="e.g. Find structuring patterns in the last 30 days…"
            className="w-full bg-slate-900/90 border border-slate-800 rounded-xl px-4 sm:px-5 py-3 sm:py-3.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all font-mono shadow-inner"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs leading-none"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={() => run()}
          disabled={!query.trim() || loading}
          className="w-full sm:w-auto px-6 py-3 sm:py-3.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:bg-slate-800/80 disabled:text-slate-600 text-white text-sm font-semibold rounded-xl transition-all shadow-md shadow-blue-950/40 disabled:shadow-none"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Running…
            </span>
          ) : 'Investigate'}
        </button>
      </div>

      {/* Preset demo chips */}
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <span className="text-slate-500 font-mono font-medium">Quick Presets:</span>
        <button
          onClick={() => run("Find structuring patterns in recent transactions")}
          className="px-3 py-1 rounded-lg border border-slate-800 bg-slate-900/80 hover:bg-slate-800 hover:border-slate-700 text-sky-400 font-mono transition-all"
        >
          Structuring ($9,500–$9,900)
        </button>
        <button
          onClick={() => run("Are there smurfing or fan-out patterns across multiple accounts?")}
          className="px-3 py-1 rounded-lg border border-slate-800 bg-slate-900/80 hover:bg-slate-800 hover:border-slate-700 text-violet-400 font-mono transition-all"
        >
          Smurfing (Fan-out ≥ 3)
        </button>
        <button
          onClick={() => run("Investigate customer ACC_BENIGN_5K with $5,000 deposits")}
          className="px-3 py-1 rounded-lg border border-emerald-900/50 bg-emerald-950/20 hover:bg-emerald-900/40 text-emerald-400 font-mono transition-all"
          title="Adversarial query: verify system does NOT flag benign sub-threshold activity"
        >
          🛡 Benign Test ($5,000 - No Flag)
        </button>
      </div>

      {/* Typology cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
        {TYPOLOGIES.map(t => (
          <button
            key={t.key}
            onClick={() => run(t.query)}
            disabled={loading}
            className={`group text-left p-4 rounded-xl border ${t.bg} ${t.border} disabled:opacity-40 transition-all space-y-3 shadow-sm`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className={t.accent}>{t.icon}</span>
              <span className={`shrink-0 text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border ${t.tagCls}`}>
                {t.tag}
              </span>
            </div>
            <div>
              <p className={`text-sm font-bold ${t.accent}`}>{t.label}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{t.subtitle}</p>
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed border-t border-slate-800/60 pt-2.5">
              {t.description}
            </p>
          </button>
        ))}
      </div>
    </section>
  )
}
