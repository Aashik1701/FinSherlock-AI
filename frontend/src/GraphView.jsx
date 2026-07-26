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

function buildStructuring(structEntry) {
  if (!structEntry) return null
  const centerId = structEntry.account_id
  const nodes = [{ id: centerId, nodeType: 'center' }]
  const links = []
  const txns = structEntry.transactions || []
  txns.forEach((txn, i) => {
    const txnId = `txn_${i}_${String(txn.transaction_id).slice(-6)}`
    nodes.push({ id: txnId, nodeType: 'txn', amount: txn.amount, ts: txn.timestamp })
    links.push({ source: centerId, target: txnId, label: `$${Math.round(txn.amount).toLocaleString()}`, amount: txn.amount })
  })
  return { nodes, links, title: 'Structuring Transactions' }
}

function buildSmurfing(entry) {
  const nodes = [{ id: entry.account_id, nodeType: 'center' }]
  const links = []
  const perOut = entry.fan_out_degree > 0 ? `~$${Math.round(entry.total_sent / entry.fan_out_degree).toLocaleString()}` : null
  for (const cp of entry.counterparties_sent_to ?? []) { nodes.push({ id: cp, nodeType: 'receiver' }); links.push({ source: entry.account_id, target: cp, label: perOut }) }
  const perIn = entry.fan_in_degree > 0 ? `~$${Math.round(entry.total_received / entry.fan_in_degree).toLocaleString()}` : null
  for (const cp of entry.counterparties_received_from ?? []) { if (!nodes.find(n => n.id === cp)) nodes.push({ id: cp, nodeType: 'sender' }); links.push({ source: cp, target: entry.account_id, label: perIn }) }
  return { nodes, links, title: 'Fan-out / Fan-in Dispersal' }
}

function buildLayering(layerPath) {
  const n = layerPath.path.length; const seen = new Set(); const nodes = []; const links = []
  for (let i = 0; i < n; i++) {
    const id = layerPath.path[i]
    if (!seen.has(id)) { seen.add(id); nodes.push({ id, nodeType: i === 0 ? 'origin' : i === n - 1 ? 'destination' : 'intermediary' }) }
    if (i < n - 1) links.push({ source: layerPath.path[i], target: layerPath.path[i + 1], label: `Hop ${i + 1}`, txnId: layerPath.transaction_ids?.[i] ?? '' })
  }
  return { nodes, links, title: 'Layering Chain' }
}

const LEGEND = {
  structuring: [
    { color: '#ef4444', label: 'Flagged account' },
    { color: '#d1d5db', label: 'Transaction' },
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

export default function GraphView({ structuringData, smurfingData, layeringData, accountId }) {
  const containerRef = useRef(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current; if (!el) return
    setWidth(Math.floor(el.getBoundingClientRect().width))
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el); return () => ro.disconnect()
  }, [])

  const { graphData, graphType } = useMemo(() => {
    try {
      const structEntry = structuringData?.flagged_accounts?.find(a => a.account_id === accountId)
      if (structEntry) {
        const g = buildStructuring(structEntry)
        if (g && g.nodes.length > 1) return { graphData: g, graphType: 'structuring' }
      }
      const smurfEntry = smurfingData?.flagged_accounts?.find(a => a.account_id === accountId)
      if (smurfEntry) return { graphData: buildSmurfing(smurfEntry), graphType: 'smurfing' }
      const layerPath = layeringData?.detected_paths?.find(p => Array.isArray(p.path) && p.path.includes(accountId))
      if (layerPath) return { graphData: buildLayering(layerPath), graphType: 'layering' }
    } catch {}
    return { graphData: null, graphType: null }
  }, [structuringData, smurfingData, layeringData, accountId])

  const paintNode = useCallback((node, ctx, globalScale) => {
    const isCenter = node.nodeType === 'center' || node.nodeType === 'origin'
    const isTxn = node.nodeType === 'txn'
    const r = isCenter ? 7 : isTxn ? 3.5 : 5
    if (isCenter) {
      ctx.beginPath(); ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(249, 115, 22, 0.15)'; ctx.fill()
      ctx.strokeStyle = 'rgba(249, 115, 22, 0.5)'; ctx.lineWidth = 1; ctx.stroke()
    }
    if (isTxn) {
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI); ctx.fillStyle = '#e5e7eb'; ctx.fill()
      ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 0.5; ctx.stroke()
      return
    }
    ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI); ctx.fillStyle = NODE_COLOR[node.nodeType] ?? '#3b82f6'; ctx.fill()
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
    ctx.font = `${fontSize}px monospace`; ctx.fillStyle = '#9ca3af'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
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
            <span key={label} className="flex items-center gap-1 text-[9px] text-gray-500">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />{label}
            </span>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="rounded-lg overflow-hidden border border-gray-200 bg-white" style={{ height: 260 }}>
        {width > 0 && (
          <ForceGraph2D
            graphData={graphData} width={width} height={260} backgroundColor="#ffffff"
            nodeCanvasObject={paintNode} nodeCanvasObjectMode={() => 'replace'} nodeRelSize={5}
            linkColor={() => '#d1d5db'} linkWidth={1.5} linkDirectionalArrowLength={5}
            linkDirectionalArrowRelPos={0.85} linkDirectionalArrowColor={() => '#9ca3af'}
            linkLabel={link => [link.label, link.txnId].filter(Boolean).join(' · ')}
            linkCanvasObject={paintLink} linkCanvasObjectMode={() => 'after'}
            cooldownTicks={100} d3AlphaDecay={0.03} d3VelocityDecay={0.4}
          />
        )}
      </div>
    </div>
  )
}
