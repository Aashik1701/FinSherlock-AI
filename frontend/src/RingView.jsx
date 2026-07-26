import { useState, useMemo, useCallback } from 'react'

const fmtUSD = n => typeof n === 'number' ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'

const PALETTE = ['#e11d48', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#06b6d4', '#ec4899', '#84cc16']

function forceLayout(members, edges, width, height) {
  const n = members.length
  if (n === 0) return []
  const positions = members.map((_, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    return { x: width / 2 + (Math.min(width, height) * 0.32) * Math.cos(angle), y: height / 2 + (Math.min(width, height) * 0.32) * Math.sin(angle), vx: 0, vy: 0 }
  })
  const REP = 6000, ATTR = 0.005, DAMP = 0.85, ITERS = 50
  for (let iter = 0; iter < ITERS; iter++) {
    for (let i = 0; i < n; i++) {
      let fx = 0, fy = 0
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const dx = positions[i].x - positions[j].x
        const dy = positions[i].y - positions[j].y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        fx += (dx / d) * REP / (d * d)
        fy += (dy / d) * REP / (d * d)
      }
      const edgeConnected = edges.some(e => (e.source === i && e.target === j) || (e.source === j && e.target === i))
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const dx = positions[j].x - positions[i].x
        const dy = positions[j].y - positions[i].y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        fx += dx * ATTR
        fy += dy * ATTR
      }
      positions[i].vx = (positions[i].vx + fx) * DAMP
      positions[i].vy = (positions[i].vy + fy) * DAMP
      positions[i].x += positions[i].vx
      positions[i].y += positions[i].vy
      const pad = 30
      positions[i].x = Math.max(pad, Math.min(width - pad, positions[i].x))
      positions[i].y = Math.max(pad, Math.min(height - pad, positions[i].y))
    }
  }
  return positions
}

function NetworkGraph({ members, edges, sampleTxns, onHover, hovered, selected }) {
  const width = 360, height = 280
  const positions = useMemo(() => forceLayout(members, edges, width, height), [members, edges])

  const edgeSet = new Set(edges.map(e => `${Math.min(e.source, e.target)}-${Math.max(e.source, e.target)}`))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full">
      <defs>
        <radialGradient id="nodeGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="white" stopOpacity="0.6" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        {PALETTE.map((c, i) => (
          <radialGradient key={i} id={`grad_${i}`} cx="40%" cy="35%" r="60%">
            <stop offset="0%" stopColor={c} stopOpacity="0.3" />
            <stop offset="100%" stopColor={c} stopOpacity="0.8" />
          </radialGradient>
        ))}
      </defs>

      {/* Edges between connected members */}
      {edges.map((e, i) => {
        const p1 = positions[e.source], p2 = positions[e.target]
        if (!p1 || !p2) return null
        const isHighlighted = hovered !== null && (e.source === hovered || e.target === hovered)
        const txn = sampleTxns[i]
        return (
          <g key={`edge-${i}`}>
            <line
              x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
              stroke={isHighlighted ? '#6366f1' : '#d1d5db'}
              strokeWidth={isHighlighted ? 2 : 0.8}
              strokeOpacity={isHighlighted ? 0.7 : 0.3}
              className="transition-all duration-300"
            />
            {isHighlighted && txn && (
              <text
                x={(p1.x + p2.x) / 2} y={(p1.y + p2.y) / 2 - 6}
                textAnchor="middle" fontSize="6" fill="#6366f1" fontFamily="monospace"
              >
                ${Number(txn.amount).toLocaleString()}
              </text>
            )}
          </g>
        )
      })}

      {/* Non-edges (faint connector lines between non-connected nodes) */}
      {positions.map((p, i) =>
        positions.slice(i + 1).map((q, j) => {
          const actualJ = i + 1 + j
          const key = `${Math.min(i, actualJ)}-${Math.max(i, actualJ)}`
          if (edgeSet.has(key)) return null
          return (
            <line
              key={`non-${key}`}
              x1={p.x} y1={p.y} x2={q.x} y2={q.y}
              stroke="#e5e7eb" strokeWidth="0.3" strokeOpacity="0.15"
            />
          )
        })
      )}

      {/* Connection ring (inner circle) */}
      <circle
        cx={width / 2} cy={height / 2} r={Math.min(width, height) * 0.2}
        fill="none" stroke="#f3f4f6" strokeWidth="0.5" strokeDasharray="4 4" opacity="0.4"
      />

      {/* Nodes */}
      {positions.map((p, i) => {
        const isHovered = hovered === i
        const isSelected = selected === i
        return (
          <g
            key={`node-${i}`}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            style={{ cursor: 'pointer' }}
            className="transition-all duration-300"
          >
            <circle
              cx={p.x} cy={p.y}
              r={isHovered || isSelected ? 16 : 12}
              fill={`url(#grad_${i % PALETTE.length})`}
              stroke={isHovered || isSelected ? '#1f2937' : PALETTE[i % PALETTE.length]}
              strokeWidth={isHovered || isSelected ? 2.5 : 1.5}
              className="transition-all duration-300"
            />
            <circle
              cx={p.x} cy={p.y}
              r={isHovered || isSelected ? 18 : 14}
              fill="none" stroke={PALETTE[i % PALETTE.length]}
              strokeWidth="0.5" opacity="0.3"
              className="transition-all duration-300"
            />
            <text
              x={p.x} y={p.y + 0.5}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={isHovered ? 7 : 6}
              fontFamily="monospace" fontWeight="600"
              fill={isHovered || isSelected ? '#fff' : '#374151'}
              className="transition-all duration-300 pointer-events-none"
            >
              {String(members[i]).slice(-4)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function RingCard({ ring, index }) {
  const [expanded, setExpanded] = useState(false)
  const [hoveredNode, setHoveredNode] = useState(null)
  const [selectedNode, setSelectedNode] = useState(null)
  const riskCls = ring.risk_level === 'high' ? 'bg-red-50 text-red-700 border-red-200' : ring.risk_level === 'medium' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'
  const escColor = ring.escalation === 'report' ? 'text-red-700' : ring.escalation === 'review' ? 'text-amber-700' : 'text-emerald-700'
  const escBg = ring.escalation === 'report' ? 'bg-red-50 border-red-200' : ring.escalation === 'review' ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'

  const members = ring.member_accounts || []
  const sampleTxns = ring.sample_transactions || []
  const edges = useMemo(() => {
    const memberSet = new Set(members)
    return sampleTxns
      .filter(t => memberSet.has(t.sender) && memberSet.has(t.receiver))
      .map(t => ({
        source: members.indexOf(t.sender),
        target: members.indexOf(t.receiver),
        amount: t.amount,
      }))
      .filter(e => e.source >= 0 && e.target >= 0)
  }, [members, sampleTxns])

  const handleHover = useCallback((idx) => setHoveredNode(idx), [])
  const handleSelect = useCallback((idx) => {
    setSelectedNode(prev => prev === idx ? null : idx)
  }, [])

  return (
    <article className="bg-white border border-gray-200/80 rounded-2xl overflow-hidden shadow-sm">
      {/* Header */}
      <header className="px-5 pt-4 pb-3 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold font-mono text-gray-400">RING-{String(index + 1).padStart(2, '0')}</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${riskCls}`}>{ring.risk_level}</span>
          <span className="text-[10px] text-gray-400 font-mono">
            score <span className="font-bold text-gray-600">{ring.suspicion_score.toFixed(0)}</span>/100
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-md border ${escBg} ${escColor}`}>{ring.escalation}</span>
          <button
            onClick={() => setExpanded(e => !e)}
            className="px-2.5 py-1 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 text-[10px] text-gray-500 hover:text-gray-700 transition-all font-medium"
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </header>

      <div className="px-5 py-4 space-y-4">
        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-gray-50/60 rounded-xl px-3 py-2 space-y-0.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Members</p>
            <p className="text-lg font-bold font-mono text-gray-800">{ring.member_count}</p>
          </div>
          <div className="bg-gray-50/60 rounded-xl px-3 py-2 space-y-0.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Volume</p>
            <p className="text-lg font-bold font-mono text-gray-800">{fmtUSD(ring.internal_volume_usd)}</p>
          </div>
          <div className="bg-gray-50/60 rounded-xl px-3 py-2 space-y-0.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Circulation</p>
            <p className="text-lg font-bold font-mono text-gray-800">{(ring.internal_ratio * 100).toFixed(0)}%</p>
          </div>
          <div className="bg-gray-50/60 rounded-xl px-3 py-2 space-y-0.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Density</p>
            <p className="text-lg font-bold font-mono text-gray-800">{(ring.graph_density * 100).toFixed(0)}%</p>
          </div>
        </div>

        {/* Network graph + member list */}
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="shrink-0 w-full lg:w-[360px] bg-gray-50/40 rounded-xl border border-gray-100 p-2">
            <NetworkGraph
              members={members}
              edges={edges}
              sampleTxns={sampleTxns}
              onHover={handleHover}
              hovered={hoveredNode}
              selected={selectedNode}
            />
            <div className="flex items-center justify-between px-2 pt-1">
              <p className="text-[9px] text-gray-400 font-mono">{members.length} nodes · {edges.length} edges</p>
              {hoveredNode !== null && (
                <p className="text-[9px] font-semibold text-indigo-600 font-mono">{members[hoveredNode]}</p>
              )}
            </div>
          </div>

          <div className="flex-1 space-y-2">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Members</p>
            <div className="flex flex-wrap gap-1.5">
              {members.map((acc, i) => (
                <span
                  key={i}
                  onMouseEnter={() => setHoveredNode(i)}
                  onMouseLeave={() => setHoveredNode(null)}
                  onClick={() => handleSelect(i)}
                  className={`px-2 py-0.5 rounded-md border text-[10px] font-mono transition-all cursor-pointer ${
                    selectedNode === i
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                      : hoveredNode === i
                      ? 'border-gray-400 bg-gray-100 text-gray-700'
                      : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:bg-gray-100'
                  }`}
                >
                  {acc}
                </span>
              ))}
            </div>
            {ring.avg_ml_risk > 0 && (
              <p className="text-[10px] text-gray-400 mt-1">
                Mean ML risk: <span className="font-mono font-semibold text-amber-600">{(ring.avg_ml_risk * 100).toFixed(1)}%</span>
              </p>
            )}
          </div>
        </div>

        {/* Expanded transaction table */}
        {expanded && sampleTxns.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Sample Transactions</p>
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/80">
                    <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-400">Sender</th>
                    <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-400">Receiver</th>
                    <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-400">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sampleTxns.map((t, i) => (
                    <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-3 py-1.5 font-mono text-[10px] text-gray-700">{t.sender}</td>
                      <td className="px-3 py-1.5 font-mono text-[10px] text-gray-700">{t.receiver}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[10px] font-semibold text-gray-600">{fmtUSD(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SAR alert for high-risk */}
        {ring.risk_level === 'high' && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 flex items-start gap-2.5">
            <span className="text-red-500 text-sm shrink-0 mt-0.5 font-bold">!</span>
            <p className="text-xs text-red-800">
              <span className="font-bold">SAR Recommended:</span> Coordinated ring of {ring.member_count} accounts with {(ring.internal_ratio * 100).toFixed(0)}% internal circulation.
            </p>
          </div>
        )}
      </div>
    </article>
  )
}

export default function RingView({ muleRingData }) {
  const rings = muleRingData?.rings ?? []
  if (rings.length === 0) return null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">Money Mule Rings</p>
          <p className="text-sm font-semibold text-gray-900 mt-1">
            Louvain Community Detection · {rings.length} ring{rings.length !== 1 ? 's' : ''} found
          </p>
        </div>
        <span className="text-[10px] text-gray-400 font-mono">
          Ø density {(rings.reduce((s, r) => s + r.graph_density, 0) / rings.length * 100).toFixed(1)}%
        </span>
      </div>

      <div className="space-y-4">
        {rings.map((ring, i) => (
          <RingCard key={ring.community_id ?? i} ring={ring} index={i} />
        ))}
      </div>
    </div>
  )
}
