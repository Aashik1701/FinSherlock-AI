import { useState } from 'react'

const TYPOLOGIES = [
  {
    key: 'structuring',
    label: 'Structuring',
    tag: 'BSA · CTR',
    tagCls: 'text-sky-400 border-sky-900 bg-sky-950/40',
    subtitle: 'Sub-threshold cash deposits',
    description:
      'Multiple deposits clustered just below the $10,000 FinCEN reporting threshold — a federal offense under 31 U.S.C. § 5324.',
    query: 'Find structuring patterns in recent transactions',
    accent: 'text-sky-400',
    border: 'border-sky-900/50',
    hover: 'hover:border-sky-700',
    bg: 'from-sky-950/30',
    icon: (
      <svg viewBox="0 0 28 20" className="w-7 h-5" fill="currentColor">
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
    tagCls: 'text-violet-400 border-violet-900 bg-violet-950/40',
    subtitle: 'Multi-account fund dispersal',
    description:
      'Funds split across many counterparty accounts to evade detection — identified by fan-out / fan-in degree in the transaction graph.',
    query: 'Are there smurfing or fan-out patterns across multiple accounts?',
    accent: 'text-violet-400',
    border: 'border-violet-900/50',
    hover: 'hover:border-violet-700',
    bg: 'from-violet-950/30',
    icon: (
      <svg viewBox="0 0 28 28" className="w-7 h-7" fill="currentColor">
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
    tagCls: 'text-amber-400 border-amber-900 bg-amber-950/40',
    subtitle: 'Multi-hop chain obfuscation',
    description:
      'Rapid sequential transfers through intermediary accounts to obscure fund origin — detected via time-constrained DFS path-finding.',
    query: 'Analyze the transaction network for suspicious layering chains',
    accent: 'text-amber-400',
    border: 'border-amber-900/50',
    hover: 'hover:border-amber-700',
    bg: 'from-amber-950/30',
    icon: (
      <svg viewBox="0 0 36 14" className="w-9 h-3.5" fill="currentColor">
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
    <section className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
          Investigation Query
        </h2>
        <p className="text-xs text-slate-600">
          Ask in plain English — the planner agent decides which tools to call.
        </p>
      </div>

      {/* Input row */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && run()}
            placeholder="e.g. Find structuring patterns in the last 30 days…"
            className="w-full bg-slate-900 border border-slate-800 rounded-xl px-5 py-3.5 text-sm text-slate-100 placeholder-slate-700 focus:outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-700/15 transition-all font-mono"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400 text-xs leading-none"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={() => run()}
          disabled={!query.trim() || loading}
          className="px-6 py-3.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-blue-950/50 disabled:shadow-none whitespace-nowrap"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Running…
            </span>
          ) : 'Investigate'}
        </button>
      </div>

      {/* Typology preset cards */}
      <div className="grid grid-cols-3 gap-4">
        {TYPOLOGIES.map(t => (
          <button
            key={t.key}
            onClick={() => run(t.query)}
            disabled={loading}
            className={`group text-left p-4 rounded-xl bg-gradient-to-br ${t.bg} to-slate-900 border ${t.border} ${t.hover} disabled:opacity-40 transition-all space-y-3`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className={t.accent}>{t.icon}</span>
              <span className={`shrink-0 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border ${t.tagCls}`}>
                {t.tag}
              </span>
            </div>
            <div>
              <p className={`text-sm font-bold ${t.accent}`}>{t.label}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">{t.subtitle}</p>
            </div>
            <p className="text-[10px] text-slate-600 leading-relaxed border-t border-slate-800/50 pt-2.5">
              {t.description}
            </p>
          </button>
        ))}
      </div>
    </section>
  )
}
