import { useState } from 'react'

const fmtTS = str => {
  try { return new Date(str.replace(' ', 'T')).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) }
  catch { return str }
}

const fmtUSD = n => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const BADGE = {
  structuring: 'bg-sky-50 text-sky-700 border-sky-200',
  smurfing:    'bg-violet-50 text-violet-700 border-violet-200',
  layering:    'bg-amber-50 text-amber-700 border-amber-200',
}

export default function TimelineView({ structEntry, smurfEntry, layerPath }) {
  const [filter, setFilter] = useState('all')
  const events = []

  if (structEntry?.transactions) {
    structEntry.transactions.forEach(t => {
      events.push({ type: 'structuring', timestamp: t.timestamp, title: `Near-Threshold Deposit: ${fmtUSD(t.amount)}`, subtitle: `${fmtUSD(t.distance_from_threshold)} below $10,000 threshold`, icon: '💵', badge: 'Structuring' })
    })
  }

  if (smurfEntry) {
    if (smurfEntry.counterparties_sent_to?.length) {
      events.push({ type: 'smurfing', timestamp: structEntry?.transactions?.[0]?.timestamp || new Date().toISOString(), title: `Fan-Out: Sent to ${smurfEntry.counterparties_sent_to.length} accounts`, subtitle: `Total outbound: ${fmtUSD(smurfEntry.total_sent || 0)}`, icon: '📤', badge: 'Smurfing Fan-Out' })
    }
    if (smurfEntry.counterparties_received_from?.length) {
      events.push({ type: 'smurfing', timestamp: structEntry?.transactions?.[0]?.timestamp || new Date().toISOString(), title: `Fan-In: Received from ${smurfEntry.counterparties_received_from.length} accounts`, subtitle: `Total inbound: ${fmtUSD(smurfEntry.total_received || 0)}`, icon: '📥', badge: 'Smurfing Fan-In' })
    }
  }

  if (layerPath) {
    events.push({ type: 'layering', timestamp: structEntry?.transactions?.[0]?.timestamp || new Date().toISOString(), title: `Layering Chain (${layerPath.hop_count} hops)`, subtitle: `Routed ${fmtUSD(layerPath.total_amount)} through ${layerPath.path?.join(' → ')} in ${layerPath.time_span_hours?.toFixed(1)}h`, icon: '🔗', badge: 'Layering' })
  }

  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
  if (events.length === 0) return null

  const filteredEvents = events.filter(e => filter === 'all' || e.type === filter)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Investigation Timeline ({events.length} Event{events.length === 1 ? '' : 's'})</p>
        <div className="flex gap-1 text-[10px]">
          {['all', 'structuring', 'smurfing', 'layering'].map(t => (
            <button key={t} onClick={() => setFilter(t)}
              className={`px-2 py-0.5 rounded capitalize font-mono transition-colors ${
                filter === t ? 'bg-[var(--border-card)] text-[var(--text-primary)] border border-[var(--border-card)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-[var(--border-card)]">
        {filteredEvents.map((evt, idx) => (
          <div key={idx} className="relative group">
            <div className="absolute -left-6 top-0.5 w-5 h-5 rounded-full bg-[var(--bg-card)] border border-[var(--border-card)] flex items-center justify-center text-[10px] shadow-sm">{evt.icon}</div>
            <div className="bg-[var(--bg-card)] border border-[var(--border-card)] rounded-xl p-3.5 space-y-1 hover:border-[var(--text-muted)] transition-colors">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="font-mono text-[11px] text-[var(--text-secondary)] font-semibold">{fmtTS(evt.timestamp)}</span>
                <span className={`px-2 py-0.5 rounded text-[9px] font-mono border font-semibold ${BADGE[evt.type]}`}>{evt.badge}</span>
              </div>
              <p className="text-xs font-semibold text-[var(--text-primary)]">{evt.title}</p>
              <p className="text-[11px] text-[var(--text-secondary)]">{evt.subtitle}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
