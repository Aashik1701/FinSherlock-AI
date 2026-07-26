import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import ForceGraph2D from 'react-force-graph-2d'

const NODE_COLOR = {
  center:       '#ef4444',
  origin:       '#f97316',
  destination:  '#22c55e',
  intermediary: '#3b82f6',
  receiver:     '#3b82f6',
  sender:       '#8b5cf6',
  txn:          '#d1d5db',
}

function lerpColor(a, b, t) {
  const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16)
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff
  const rv = Math.round(ar + (br - ar) * t)
  const gv = Math.round(ag + (bg - ag) * t)
  const bv = Math.round(ab + (bb - ab) * t)
  return `#${rv.toString(16).padStart(2,'0')}${gv.toString(16).padStart(2,'0')}${bv.toString(16).padStart(2,'0')}`
}

function buildStructuring(structEntry) {
  if (!structEntry) return null
  const centerId = structEntry.account_id
  const txns = structEntry.transactions || []
  if (!txns.length) return null

  // Group transactions into weekly buckets (Monday-anchored)
  const buckets = {}
  txns.forEach(txn => {
    const d = new Date(txn.timestamp)
    const monday = new Date(d)
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    const wk = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`
    if (!buckets[wk]) buckets[wk] = { txns: [], monday }
    buckets[wk].txns.push(txn)
  })

  const weeks = Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12) // cap at 12 weekly buckets

  const maxCount = Math.max(...weeks.map(([, v]) => v.txns.length), 1)
  const nodes = [{ id: centerId, nodeType: 'center' }]
  const links = []

  weeks.forEach(([wk, { txns: wTxns, monday }]) => {
    // heat: 1 = very close to $10k (highest risk), 0 = 5% below (lower risk)
    const avgPct = wTxns.reduce((s, t) => s + (t.pct_below_threshold ?? 2.5), 0) / wTxns.length
    const heat = Math.max(0, Math.min(1, 1 - avgPct / 5))
    const total = wTxns.reduce((s, t) => s + t.amount, 0)
    const label = monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    nodes.push({
      id: `w_${wk}`,
      nodeType: 'week',
      label,
      count: wTxns.length,
      total,
      heat,
      value: wTxns.length / maxCount,
    })
    links.push({
      source: centerId,
      target: `w_${wk}`,
      label: `${wTxns.length} txns · $${(total / 1000).toFixed(0)}k`,
      weight: wTxns.length / maxCount,
    })
  })

  return { nodes, links, title: 'Structuring Transactions', meta: { txns, centerId } }
}

function buildSmurfing(entry) {
  const nodes = [{ id: entry.account_id, nodeType: 'center' }]
  const links = []
  const perOut = entry.fan_out_degree > 0 ? `~$${Math.round(entry.total_sent / entry.fan_out_degree).toLocaleString()}` : null
  for (const cp of entry.counterparties_sent_to ?? []) {
    nodes.push({ id: cp, nodeType: 'receiver' })
    links.push({ source: entry.account_id, target: cp, label: perOut })
  }
  const perIn = entry.fan_in_degree > 0 ? `~$${Math.round(entry.total_received / entry.fan_in_degree).toLocaleString()}` : null
  for (const cp of entry.counterparties_received_from ?? []) {
    if (!nodes.find(n => n.id === cp)) nodes.push({ id: cp, nodeType: 'sender' })
    links.push({ source: cp, target: entry.account_id, label: perIn })
  }
  return { nodes, links, title: 'Fan-out / Fan-in Dispersal' }
}

function buildLayering(layerPath) {
  const n = layerPath.path.length
  const seen = new Set()
  const nodes = []
  const links = []
  for (let i = 0; i < n; i++) {
    const id = layerPath.path[i]
    if (!seen.has(id)) {
      seen.add(id)
      nodes.push({ id, nodeType: i === 0 ? 'origin' : i === n - 1 ? 'destination' : 'intermediary' })
    }
    if (i < n - 1) {
      links.push({ source: layerPath.path[i], target: layerPath.path[i + 1], label: `Hop ${i + 1}`, txnId: layerPath.transaction_ids?.[i] ?? '' })
    }
  }
  return { nodes, links, title: 'Layering Chain' }
}

const LEGEND = {
  structuring: [
    { color: '#ef4444', label: 'Flagged account' },
    { color: '#f59e0b', label: 'Weekly cluster (farther below $10k)' },
    { color: '#dc2626', label: 'Weekly cluster (near $10k — high risk)' },
  ],
  smurfing: [
    { color: '#ef4444', label: 'Flagged hub' },
    { color: '#3b82f6', label: 'Receiver' },
    { color: '#8b5cf6', label: 'Sender' },
  ],
  layering: [
    { color: '#f97316', label: 'Origin' },
    { color: '#3b82f6', label: 'Intermediary' },
    { color: '#22c55e', label: 'Destination' },
  ],
}

function AmountDistribution({ txns }) {
  if (!txns || !txns.length) return null
  const amounts = txns.map(t => t.amount)
  const minAmt = Math.min(...amounts)
  const span = 10000 - minAmt || 500
  const NUM_BUCKETS = 6
  const buckets = Array.from({ length: NUM_BUCKETS }, (_, i) => ({
    lo: minAmt + (i / NUM_BUCKETS) * span,
    count: 0,
  }))
  amounts.forEach(a => {
    const idx = Math.min(NUM_BUCKETS - 1, Math.floor(((a - minAmt) / span) * NUM_BUCKETS))
    buckets[idx].count++
  })
  const maxBucket = Math.max(...buckets.map(b => b.count), 1)

  return (
    <div className="p-2.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-card)]">
      <p className="text-[9px] text-[var(--text-secondary)] font-mono mb-2 uppercase tracking-wider">
        Amount Distribution · ${Math.round(minAmt).toLocaleString()} → $10,000
      </p>
      <div className="flex items-end gap-1 h-7">
        {buckets.map((b, i) => (
          <div key={i} className="flex-1 flex flex-col items-center">
            <div
              className="w-full rounded-sm transition-all"
              style={{
                height: `${Math.max(3, (b.count / maxBucket) * 26)}px`,
                background: lerpColor('#f59e0b', '#dc2626', i / (NUM_BUCKETS - 1)),
                opacity: b.count > 0 ? 0.85 : 0.15,
              }}
              title={`${b.count} txns near $${Math.round(b.lo).toLocaleString()}`}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mt-1.5 text-[8px] text-[var(--text-secondary)] font-mono">
        <span>${Math.round(minAmt).toLocaleString()}</span>
        <span className="text-[var(--text-tertiary)]">{txns.length} total transactions</span>
        <span>$10,000</span>
      </div>
    </div>
  )
}

export default function GraphView({ structuringData, smurfingData, layeringData, accountId }) {
  const containerRef = useRef(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setWidth(Math.floor(el.getBoundingClientRect().width))
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { graphData, graphType, graphMeta } = useMemo(() => {
    try {
      const structEntry = structuringData?.flagged_accounts?.find(a => a.account_id === accountId)
      if (structEntry) {
        const g = buildStructuring(structEntry)
        if (g && g.nodes.length > 1) {
          const { meta, ...rest } = g
          return { graphData: rest, graphType: 'structuring', graphMeta: meta }
        }
      }
      const smurfEntry = smurfingData?.flagged_accounts?.find(a => a.account_id === accountId)
      if (smurfEntry) return { graphData: buildSmurfing(smurfEntry), graphType: 'smurfing', graphMeta: null }
      const layerPath = layeringData?.detected_paths?.find(p => Array.isArray(p.path) && p.path.includes(accountId))
      if (layerPath) return { graphData: buildLayering(layerPath), graphType: 'layering', graphMeta: null }
    } catch {}
    return { graphData: null, graphType: null, graphMeta: null }
  }, [structuringData, smurfingData, layeringData, accountId])

  const paintNode = useCallback((node, ctx, globalScale) => {
    if (!isFinite(node.x) || !isFinite(node.y)) return

    const isCenter = node.nodeType === 'center' || node.nodeType === 'origin'
    const isTxn = node.nodeType === 'txn'
    const isWeek = node.nodeType === 'week'

    if (isWeek) {
      const r = 3.5 + 7 * (node.value ?? 0.5)
      const col = lerpColor('#f59e0b', '#dc2626', node.heat ?? 0.5)
      // glow halo
      const grad = ctx.createRadialGradient(node.x, node.y, r * 0.6, node.x, node.y, r + 5)
      grad.addColorStop(0, col + '44')
      grad.addColorStop(1, col + '00')
      ctx.beginPath(); ctx.arc(node.x, node.y, r + 5, 0, 2 * Math.PI)
      ctx.fillStyle = grad; ctx.fill()
      // solid circle
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.fillStyle = col; ctx.fill()
      // txn count inside node
      const insideFs = Math.min(Math.max(r * 0.85, 2), 11 / globalScale)
      ctx.font = `bold ${insideFs}px monospace`
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(node.count ?? ''), node.x, node.y)
      // date label below
      const labelFs = Math.max(8.5 / globalScale, 1.5)
      ctx.font = `${labelFs}px monospace`
      ctx.fillStyle = '#9ca3af'
      ctx.textBaseline = 'top'
      ctx.fillText(node.label ?? '', node.x, node.y + r + 2)
      return
    }

    const r = isCenter ? 7 : isTxn ? 3.5 : 5
    if (isCenter) {
      ctx.beginPath(); ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI)
      ctx.fillStyle = 'rgba(249, 115, 22, 0.15)'; ctx.fill()
      ctx.strokeStyle = 'rgba(249, 115, 22, 0.5)'; ctx.lineWidth = 1; ctx.stroke()
    }
    if (isTxn) {
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.fillStyle = '#e5e7eb'; ctx.fill()
      ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 0.5; ctx.stroke()
      return
    }
    ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
    ctx.fillStyle = NODE_COLOR[node.nodeType] ?? '#3b82f6'; ctx.fill()
    const fontSize = Math.max(10 / globalScale, 1.5)
    ctx.font = `${fontSize}px monospace`
    ctx.fillStyle = isCenter ? '#9a3412' : '#6b7280'
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText(node.id.length > 14 ? node.id.slice(0, 13) + '…' : node.id, node.x, node.y + r + 2)
  }, [])

  const paintLink = useCallback((link, ctx, globalScale) => {
    if (!link.label) return
    const s = link.source; const t = link.target
    if (typeof s !== 'object' || typeof t !== 'object') return
    const mx = (s.x + t.x) / 2; const my = (s.y + t.y) / 2
    const fontSize = Math.max(9 / globalScale, 1.5)
    ctx.font = `${fontSize}px monospace`
    ctx.fillStyle = '#9ca3af'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(link.label, mx, my)
  }, [])

  if (!graphData) return null

  const legend = LEGEND[graphType] ?? []

  return (
    <div className="pt-2 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="eyebrow">Transaction Network · {graphData.title}</p>
        <div className="flex items-center gap-3 flex-wrap">
          {legend.map(({ color, label }) => (
            <span key={label} className="flex items-center gap-1 text-[9px] text-[var(--text-secondary)]">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>
      <div
        ref={containerRef}
        className="rounded-lg overflow-hidden border border-[var(--border-card)] bg-[var(--bg-card)]"
        style={{ height: 260 }}
      >
        {width > 0 && (
          <ForceGraph2D
            graphData={graphData}
            width={width}
            height={260}
            backgroundColor="transparent"
            nodeCanvasObject={paintNode}
            nodeCanvasObjectMode={() => 'replace'}
            nodeRelSize={5}
            linkColor={() => '#374151'}
            linkWidth={link => 0.8 + (link.weight ?? 0) * 2.5}
            linkDirectionalArrowLength={5}
            linkDirectionalArrowRelPos={0.85}
            linkDirectionalArrowColor={() => '#6b7280'}
            linkLabel={link => [link.label, link.txnId].filter(Boolean).join(' · ')}
            linkCanvasObject={paintLink}
            linkCanvasObjectMode={() => 'after'}
            cooldownTicks={100}
            d3AlphaDecay={0.03}
            d3VelocityDecay={0.4}
          />
        )}
      </div>
      {graphType === 'structuring' && graphMeta?.txns?.length > 0 && (
        <AmountDistribution txns={graphMeta.txns} />
      )}
    </div>
  )
}
