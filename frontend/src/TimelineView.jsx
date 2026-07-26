import { useState } from 'react'

const fmtTS = str => {
  try {
    return new Date(str.replace(' ', 'T')).toLocaleString('en-US', {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    })
  } catch { return str }
}

const fmtUSD = n => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function TimelineView({ structEntry, smurfEntry, layerPath }) {
  const [filter, setFilter] = useState('all')

  // Construct timeline events from detection sources
  const events = []

  // 1. Structuring events
  if (structEntry?.transactions) {
    structEntry.transactions.forEach(t => {
      events.push({
        type: 'structuring',
        timestamp: t.timestamp,
        title: `Near-Threshold Deposit: ${fmtUSD(t.amount)}`,
        subtitle: `${fmtUSD(t.distance_from_threshold)} below $10,000 threshold (${t.pct_below_threshold}% gap)`,
        icon: '💵',
        badge: 'Structuring',
        badgeColor: 'bg-sky-950 text-sky-400 border-sky-800',
        amount: t.amount,
      })
    })
  }

  // 2. Smurfing events
  if (smurfEntry) {
    if (smurfEntry.counterparties_sent_to?.length) {
      events.push({
        type: 'smurfing',
        timestamp: structEntry?.transactions?.[0]?.timestamp || new Date().toISOString(),
        title: `Fan-Out Dispersal: Sent to ${smurfEntry.counterparties_sent_to.length} accounts`,
        subtitle: `Total outbound volume: ${fmtUSD(smurfEntry.total_sent || 0)}`,
        icon: '📤',
        badge: 'Smurfing Fan-Out',
        badgeColor: 'bg-violet-950 text-violet-400 border-violet-800',
      })
    }
    if (smurfEntry.counterparties_received_from?.length) {
      events.push({
        type: 'smurfing',
        timestamp: structEntry?.transactions?.[0]?.timestamp || new Date().toISOString(),
        title: `Fan-In Aggregation: Received from ${smurfEntry.counterparties_received_from.length} accounts`,
        subtitle: `Total inbound volume: ${fmtUSD(smurfEntry.total_received || 0)}`,
        icon: '📥',
        badge: 'Smurfing Fan-In',
        badgeColor: 'bg-purple-950 text-purple-400 border-purple-800',
      })
    }
  }

  // 3. Layering chain events
  if (layerPath) {
    events.push({
      type: 'layering',
      timestamp: structEntry?.transactions?.[0]?.timestamp || new Date().toISOString(),
      title: `Rapid Multi-Hop Layering Chain (${layerPath.hop_count} hops)`,
      subtitle: `Routed ${fmtUSD(layerPath.total_amount)} through ${layerPath.path?.join(' → ')} in ${layerPath.time_span_hours?.toFixed(1)}h`,
      icon: '🔗',
      badge: 'Layering',
      badgeColor: 'bg-amber-950 text-amber-400 border-amber-800',
    })
  }

  // Sort events chronologically
  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))

  if (events.length === 0) return null

  const filteredEvents = events.filter(e => filter === 'all' || e.type === filter)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em]">
          Investigation Timeline ({events.length} Event{events.length === 1 ? '' : 's'})
        </p>
        <div className="flex gap-1 text-[10px]">
          {['all', 'structuring', 'smurfing', 'layering'].map(t => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`px-2 py-0.5 rounded capitalize font-mono transition-colors ${
                filter === t
                  ? 'bg-slate-800 text-slate-200 border border-slate-700'
                  : 'text-slate-600 hover:text-slate-400'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-800">
        {filteredEvents.map((evt, idx) => (
          <div key={idx} className="relative group">
            {/* Timeline node icon */}
            <div className="absolute -left-6 top-0.5 w-5 h-5 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center text-[10px] shadow-sm">
              {evt.icon}
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 space-y-1 hover:border-slate-700 transition-colors">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="font-mono text-[11px] text-slate-400 font-semibold">{fmtTS(evt.timestamp)}</span>
                <span className={`px-2 py-0.5 rounded text-[9px] font-mono border font-semibold ${evt.badgeColor}`}>
                  {evt.badge}
                </span>
              </div>
              <p className="text-xs font-semibold text-slate-200">{evt.title}</p>
              <p className="text-[11px] text-slate-500">{evt.subtitle}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
