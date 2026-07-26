import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import ForceGraph2D from 'react-force-graph-2d'

const NODE_COLOR = {
  center:       '#ef4444', // smurfing hub
  origin:       '#f97316', // layering start
  destination:  '#22c55e', // layering end
  intermediary: '#60a5fa', // layering middle
  receiver:     '#60a5fa', // smurfing receiver
  sender:       '#a78bfa', // smurfing sender
}

function buildSmurfing(entry) {
  const nodes = [{ id: entry.account_id, nodeType: 'center' }]
  const links = []

  const perOut = entry.fan_out_degree > 0
    ? `~$${Math.round(entry.total_sent / entry.fan_out_degree).toLocaleString()}`
    : null

  for (const cp of entry.counterparties_sent_to ?? []) {
    nodes.push({ id: cp, nodeType: 'receiver' })
    links.push({ source: entry.account_id, target: cp, label: perOut })
  }

  const perIn = entry.fan_in_degree > 0
    ? `~$${Math.round(entry.total_received / entry.fan_in_degree).toLocaleString()}`
    : null

  for (const cp of entry.counterparties_received_from ?? []) {
    if (!nodes.find(n => n.id === cp)) nodes.push({ id: cp, nodeType: 'sender' })
    links.push({ source: cp, target: entry.account_id, label: perIn })
  }

  return { nodes, links }
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
      nodes.push({
        id,
        nodeType: i === 0 ? 'origin' : i === n - 1 ? 'destination' : 'intermediary',
      })
    }
    if (i < n - 1) {
      links.push({
        source: layerPath.path[i],
        target: layerPath.path[i + 1],
        label: `Hop ${i + 1}`,
        txnId: layerPath.transaction_ids?.[i] ?? '',
      })
    }
  }

  return { nodes, links }
}

const LEGEND = {
  smurfing: [
    { color: '#ef4444', label: 'Flagged hub' },
    { color: '#60a5fa', label: 'Receiver' },
    { color: '#a78bfa', label: 'Sender' },
  ],
  layering: [
    { color: '#f97316', label: 'Origin' },
    { color: '#60a5fa', label: 'Intermediary' },
    { color: '#22c55e', label: 'Destination' },
  ],
}

export default function GraphView({ smurfingData, layeringData, accountId }) {
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

  const { graphData, graphType } = useMemo(() => {
    try {
      const smurfEntry = smurfingData?.flagged_accounts?.find(a => a.account_id === accountId)
      if (smurfEntry) return { graphData: buildSmurfing(smurfEntry), graphType: 'smurfing' }

      const layerPath = layeringData?.detected_paths?.find(
        p => Array.isArray(p.path) && p.path.includes(accountId)
      )
      if (layerPath) return { graphData: buildLayering(layerPath), graphType: 'layering' }
    } catch (err) {
      console.warn('GraphView: build failed', err)
    }
    return { graphData: null, graphType: null }
  }, [smurfingData, layeringData, accountId])

  const paintNode = useCallback((node, ctx, globalScale) => {
    const isCenter = node.nodeType === 'center' || node.nodeType === 'origin'
    const r = isCenter ? 7 : 5

    // Glowing halo for Mule Controller hub node
    if (isCenter) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI)
      ctx.fillStyle = 'rgba(234, 179, 8, 0.25)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(234, 179, 8, 0.8)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    ctx.beginPath()
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
    ctx.fillStyle = NODE_COLOR[node.nodeType] ?? '#60a5fa'
    ctx.fill()

    const fontSize = Math.max(10 / globalScale, 1.5)
    ctx.font = `${fontSize}px monospace`
    ctx.fillStyle = isCenter ? '#fef08a' : '#9ca3af'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const label = (isCenter ? '★ HUB: ' : '') + (node.id.length > 12 ? node.id.slice(0, 11) + '…' : node.id)
    ctx.fillText(label, node.x, node.y + r + 2)
  }, [])

  const paintLink = useCallback((link, ctx, globalScale) => {
    if (!link.label) return
    const s = link.source
    const t = link.target
    if (typeof s !== 'object' || typeof t !== 'object') return

    const mx = (s.x + t.x) / 2
    const my = (s.y + t.y) / 2
    const fontSize = Math.max(9 / globalScale, 1.5)
    ctx.font = `${fontSize}px monospace`
    ctx.fillStyle = '#6b7280'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(link.label, mx, my)
  }, [])

  if (!graphData) return null

  const legend = LEGEND[graphType] ?? []
  const title = graphType === 'smurfing' ? 'Fan-out / Fan-in' : 'Layering Chain'

  return (
    <div className="pt-2 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-[10px] text-gray-600 uppercase tracking-widest">
          Transaction Graph &middot; {title}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          {legend.map(({ color, label }) => (
            <span key={label} className="flex items-center gap-1 text-[9px] text-gray-500">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        className="rounded-lg overflow-hidden border border-gray-800 bg-gray-950"
        style={{ height: 280 }}
      >
        {width > 0 && (
          <ForceGraph2D
            graphData={graphData}
            width={width}
            height={280}
            backgroundColor="#030712"
            nodeCanvasObject={paintNode}
            nodeCanvasObjectMode={() => 'replace'}
            nodeRelSize={5}
            nodeLabel={node => `${node.id} (${node.nodeType})`}
            linkColor={() => '#374151'}
            linkWidth={1.5}
            linkDirectionalArrowLength={5}
            linkDirectionalArrowRelPos={0.85}
            linkDirectionalArrowColor={() => '#4b5563'}
            linkLabel={link => [link.label, link.txnId].filter(Boolean).join(' · ')}
            linkCanvasObject={paintLink}
            linkCanvasObjectMode={() => 'after'}
            cooldownTicks={100}
            d3AlphaDecay={0.03}
            d3VelocityDecay={0.4}
          />
        )}
      </div>
    </div>
  )
}
