import { useEffect, useMemo, useState } from 'react'

const API_BASE = 'http://localhost:8000'

const SEGMENTS = [
  {
    key:     'structuring',
    label:   'Structuring',
    color:   '#4C8DFF',
    glow:    'rgba(76,141,255,0.30)',
    tag:     'BSA CTR evasion',
    statute: '31 U.S.C. § 5324',
    band:    '$9,500 – $9,999',
    method:  'Rule engine · rolling 30-day window',
    detail:  'Accounts depositing just below the $10,000 BSA threshold repeatedly to avoid mandatory Currency Transaction Reports.',
    action:  'File CTR · SAR review',
  },
  {
    key:     'smurfing',
    label:   'Smurfing',
    color:   '#9D8CFF',
    glow:    'rgba(157,140,255,0.30)',
    tag:     'Multi-account dispersal',
    statute: 'FATF Typology R.3',
    band:    'Fan-out ≥ 5 accounts',
    method:  'Graph fan-in/fan-out · Louvain',
    detail:  'A single account dispersing funds to or collecting from many satellite accounts ("smurfs") to fragment transaction trails.',
    action:  'Map network · freeze hub',
  },
  {
    key:     'layering',
    label:   'Layering',
    color:   '#F2A93B',
    glow:    'rgba(242,169,59,0.30)',
    tag:     'Multi-hop chains',
    statute: 'FATF Recommendation 16',
    band:    '≥ 3 hops · < 24 h/hop',
    method:  'Graph path detection · holding-time',
    detail:  'Funds moved rapidly through intermediary accounts to obscure origin, often crossing institutions or jurisdictions.',
    action:  'Trace chain · PEP check',
  },
  {
    key:     'mule_rings',
    label:   'Mule Rings',
    color:   '#FF5D6C',
    glow:    'rgba(255,93,108,0.30)',
    tag:     'Louvain clusters',
    statute: '18 U.S.C. § 1956',
    band:    'Community ≥ 4 accounts',
    method:  'Louvain community detection',
    detail:  'Coordinated clusters of accounts acting as money mules — receiving, holding, and re-transmitting illicit funds for an orchestrator.',
    action:  'Block cluster · SAR batch',
  },
  {
    key:     'velocity',
    label:   'Velocity Surges',
    color:   '#34D6C1',
    glow:    'rgba(52,214,193,0.30)',
    tag:     'Behavioral spikes',
    statute: 'FinCEN Advisory FIN-2014-A005',
    band:    '> 3× 90-day baseline',
    method:  'Rolling velocity · z-score baseline',
    detail:  'Accounts whose recent transaction frequency or volume spikes far above their own historical baseline — a leading indicator of account takeover or mule activation.',
    action:  'Freeze · step-up KYC',
  },
]

const AXES    = SEGMENTS.length
const CENTER  = 170
const R_OUTER = 106
const RINGS   = [0.25, 0.5, 0.75, 1]

function ang(i)        { return -Math.PI / 2 + i * ((2 * Math.PI) / AXES) }
function polar(a, r)   { return [CENTER + r * Math.cos(a), CENTER + r * Math.sin(a)] }
function ringPts(f)    { return Array.from({ length: AXES }, (_, i) => polar(ang(i), f * R_OUTER).join(',')).join(' ') }
function tAnchor(a)    { const c = Math.cos(a); return c > 0.2 ? 'start' : c < -0.2 ? 'end' : 'middle' }
function sev(cnt, max) { if (!cnt) return 'NIL'; if (cnt / max > 0.65) return 'HIGH'; if (cnt / max > 0.3) return 'MED'; return 'LOW' }

const SEV_STYLE = {
  HIGH: { background: '#FFF1F3', border: '1px solid #FF5D6C', color: '#D73A4A' },
  MED:  { background: '#FFF8EA', border: '1px solid #F2A93B', color: '#B97910' },
  LOW:  { background: '#ECFBF8', border: '1px solid #34D6C1', color: '#1E8E82' },
  NIL:  { background: '#F4F7FA', border: '1px solid #D6DEE8', color: '#7A8794' },
}

const CSS = `
  .tr { --bg:#FFFFFF;--bd:#DDE4EC;--tx:#12212F;--dim:#5F7082;--mu:#7A8794;
    background:linear-gradient(180deg,#FFFFFF 0%,#F8FBFE 100%);border:1px solid var(--bd);border-radius:12px;
    padding:22px;color:var(--tx);position:relative;overflow:hidden;user-select:none;
    box-shadow:0 12px 32px rgba(18,33,47,.06);
    font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif; }
  .tr::before { content:'';position:absolute;inset:0;
    background-image:linear-gradient(var(--bd) 1px,transparent 1px),linear-gradient(90deg,var(--bd) 1px,transparent 1px);
    background-size:28px 28px;opacity:.03;pointer-events:none; }
  .mn { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,Consolas,monospace; }

  .tr-hd { display:flex;align-items:flex-start;justify-content:space-between;position:relative;z-index:1;margin-bottom:16px; }
  .tr-ey { display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim); }
  .tr-ld { width:6px;height:6px;border-radius:50%;background:#34D6C1;animation:trp 2s infinite; }
  @keyframes trp { 0%{box-shadow:0 0 0 0 rgba(52,214,193,.42)} 70%{box-shadow:0 0 0 6px rgba(52,214,193,0)} 100%{box-shadow:0 0 0 0 rgba(52,214,193,0)} }
  .tr-ti { font-size:15px;font-weight:600;margin-top:5px;letter-spacing:-.01em; }
  .tr-sb { font-size:11px;color:var(--dim);margin-top:2px; }

  .tr-sv { text-align:right; }
  .tr-svl { font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--mu); }
  .tr-svv { font-size:24px;font-weight:700;line-height:1.1;margin-top:2px; }
  .tr-svs { font-size:10px;color:var(--dim);margin-top:2px; }
  .tr-bt { width:88px;height:2px;background:#E8EEF5;border-radius:2px;margin-top:7px;overflow:hidden;margin-left:auto; }
  .tr-bf { height:100%;background:linear-gradient(90deg,#4C8DFF,#34D6C1);transition:width .6s ease; }

  .tr-rw { position:relative;display:flex;justify-content:center;margin:0 0 14px;z-index:1; }
  .tr-sw { transform-origin:170px 170px;animation:trs 8s linear infinite; }
  @keyframes trs { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @media (prefers-reduced-motion:reduce) { .tr-sw{animation:none} .tr-ld{animation:none} }
  .tr-sk { animation:trf 1.4s ease-in-out infinite; }
  @keyframes trf { 0%,100%{opacity:.35} 50%{opacity:.65} }

  .tr-dp { position:relative;z-index:1;background:#FFFFFF;border-radius:8px;padding:14px;margin-bottom:14px;transition:opacity .2s;box-shadow:0 6px 18px rgba(18,33,47,.04); }
  .tr-dg { display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px; }
  .tr-dc { background:#F8FBFE;border:1px solid var(--bd);border-radius:6px;padding:8px 10px; }
  .tr-dcl { font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--mu); }
  .tr-dcv { font-size:11px;font-weight:600;color:var(--dim);margin-top:3px; }

  .tr-rs { position:relative;z-index:1;border-top:1px solid var(--bd); }
  .tr-row { display:grid;grid-template-columns:10px 1fr auto 56px auto;align-items:center;gap:10px;
    padding:9px 4px;border-bottom:1px solid var(--bd);cursor:pointer;transition:background .12s; }
  .tr-row:hover { background:rgba(76,141,255,.04); }
  .tr-row.on { background:rgba(76,141,255,.07); }
  .tr-dot { width:8px;height:8px;border-radius:2px;flex-shrink:0; }
  .tr-rl { font-size:12px;font-weight:600; }
  .tr-rt { font-size:10px;color:var(--dim);margin-top:1px; }
  .tr-rc { font-size:14px;font-weight:700;text-align:right; }
  .tr-rtr { height:2px;background:#E8EEF5;border-radius:2px;overflow:hidden; }
  .tr-rfi { height:100%;border-radius:2px;transition:width .4s ease; }
  .tr-sv-badge { font-size:8px;font-weight:700;letter-spacing:.08em;padding:2px 5px;border-radius:3px;font-family:ui-monospace,monospace; }
  .tr-hn { font-size:10px;color:var(--mu);text-align:center;padding:10px 0 2px; }
`

export default function ThreatRadar({ version = 0 }) {
  const [summary,  setSummary]  = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [hovered,  setHovered]  = useState(null)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    fetch(`${API_BASE}/dashboard/summary`)
      .then(r => r.json())
      .then(d => { if (!c) setSummary(d) })
      .catch(() => { if (!c) setSummary(null) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [version])

  const counts = useMemo(() => {
    const tc = summary?.typology_counts ?? {}
    const c  = {}
    SEGMENTS.forEach(s => { c[s.key] = tc[s.key] ?? 0 })
    c.total = SEGMENTS.reduce((a, s) => a + c[s.key], 0)
    return c
  }, [summary])

  const maxCount = Math.max(1, ...SEGMENTS.map(s => counts[s.key]))

  const verts = SEGMENTS.map((seg, i) => {
    const a        = ang(i)
    const raw      = counts[seg.key]
    const frac     = raw > 0 ? Math.max(raw / maxCount, 0.08) : 0.015
    const [x, y]   = polar(a, frac * R_OUTER)
    const [lx, ly] = polar(a, R_OUTER * 1.35)
    return { ...seg, count: raw, x, y, lx, ly, anchor: tAnchor(a), sin: Math.sin(a), sev: sev(raw, maxCount) }
  })

  const shapePoints = verts.map(v => `${v.x},${v.y}`).join(' ')

  const activeKey = selected ?? hovered
  const activeSeg = activeKey ? SEGMENTS.find(s => s.key === activeKey) : null
  const activeVtx = activeKey ? verts.find(v => v.key === activeKey)    : null
  const activeCnt = activeKey ? counts[activeKey]                        : null

  const [sx1, sy1] = polar(-Math.PI / 2, R_OUTER + 6)
  const [sx2, sy2] = polar(-Math.PI / 2 + 0.55, R_OUTER + 6)

  const toggle = key => setSelected(p => p === key ? null : key)
  const enter  = key => { if (!selected) setHovered(key) }
  const leave  = ()  => { if (!selected) setHovered(null) }

  return (
    <div className="tr">
      <style>{CSS}</style>

      {/* Header */}
      <div className="tr-hd">
        <div>
          <div className="tr-ey"><span className="tr-ld" />Financial Crime · Live</div>
          <div className="tr-ti">Threat Radar</div>
          <div className="tr-sb">AML coverage &amp; attack-vector surveillance</div>
        </div>
        <div className="tr-sv">
          <div className="tr-svl">Coverage</div>
          <div className="tr-svv mn">{summary?.coverage_pct != null ? `${summary.coverage_pct}%` : '—'}</div>
          <div className="tr-svs mn">
            {summary?.accounts_analyzed?.toLocaleString() ?? '—'} / {summary?.total_accounts?.toLocaleString() ?? '—'} accts
          </div>
          <div className="tr-bt"><div className="tr-bf" style={{ width: summary?.coverage_pct != null ? `${Math.min(100, summary.coverage_pct)}%` : '0%' }} /></div>
        </div>
      </div>

      {/* Radar SVG */}
      <div className="tr-rw">
        <svg viewBox="0 0 340 340" width="268" height="268">
          <defs>
            <radialGradient id="tg0" cx="50%" cy="50%" r="60%">
              <stop offset="0%"   stopColor="#34D6C1" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#34D6C1" stopOpacity="0.03" />
            </radialGradient>
            {SEGMENTS.map(s => (
              <radialGradient key={s.key} id={`tg-${s.key}`} cx="50%" cy="50%" r="60%">
                <stop offset="0%"   stopColor={s.color} stopOpacity="0.20" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.04" />
              </radialGradient>
            ))}
            <linearGradient id="tsg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stopColor="#34D6C1" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#34D6C1" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Grid rings */}
          {RINGS.map((lvl, i) => (
            <polygon key={i} points={ringPts(lvl)} fill="none" stroke="#DDE4EC" strokeWidth="1" />
          ))}

          {/* Spokes — highlighted for active axis */}
          {SEGMENTS.map((seg, i) => {
            const [x, y] = polar(ang(i), R_OUTER)
            const on     = activeKey === seg.key
            return <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y}
                stroke={on ? seg.color : '#DDE4EC'} strokeWidth={on ? 1.5 : 1} opacity={on ? 0.75 : 1} />
          })}

          {/* Ring % labels */}
          {[0.25, 0.5, 0.75].map(lvl => {
            const [rx, ry] = polar(-Math.PI / 2 + 0.2, lvl * R_OUTER)
            return <text key={lvl} x={rx} y={ry} fontSize="7" fill="#7A8794" textAnchor="middle" className="mn">
              {Math.round(lvl * 100)}%
            </text>
          })}

          {loading ? (
            <polygon points={ringPts(0.35)} fill="#DDE4EC" opacity="0.55" className="tr-sk" />
          ) : (
            <>
              {/* Sweep line */}
              <g className="tr-sw">
                <path d={`M ${CENTER} ${CENTER} L ${sx1} ${sy1} A ${R_OUTER + 6} ${R_OUTER + 6} 0 0 1 ${sx2} ${sy2} Z`}
                  fill="url(#tsg)" />
              </g>

              {/* Radar shape */}
              <polygon points={shapePoints}
                fill={activeSeg ? `url(#tg-${activeSeg.key})` : 'url(#tg0)'}
                stroke={activeSeg ? activeSeg.color : '#34D6C1'}
                strokeWidth="1.5" opacity="0.9"
                style={{ transition: 'stroke .2s' }}
              />

              {/* Vertices */}
              {verts.map(v => {
                const on = activeKey === v.key
                return (
                  <g key={v.key} style={{ cursor: 'pointer' }}
                    onClick={() => toggle(v.key)}
                    onMouseEnter={() => enter(v.key)}
                    onMouseLeave={leave}
                  >
                    {/* Glow */}
                    {(on || v.sev === 'HIGH') && (
                      <circle cx={v.x} cy={v.y} r={on ? 15 : 10}
                        fill={v.glow} stroke="none"
                        style={{ transition: 'r .2s' }} />
                    )}
                    {/* Dot */}
                    <circle cx={v.x} cy={v.y}
                      r={on ? 7 : v.count > 0 ? 5 : 3}
                      fill={v.count > 0 ? v.color : '#2A3542'}
                      stroke="#FFFFFF" strokeWidth="1.5"
                      style={{ transition: 'r .15s, fill .15s' }} />
                    {/* Axis label */}
                    <text x={v.lx} y={v.ly + (v.sin < -0.3 ? -3 : v.sin > 0.3 ? 8 : 2)}
                      textAnchor={v.anchor} fontSize="9" className="mn"
                      fill={on ? v.color : '#7C8B9B'} letterSpacing="0.06em"
                      style={{ transition: 'fill .15s' }}>
                      {v.label.toUpperCase()}
                    </text>
                    {/* Count */}
                    <text x={v.lx} y={v.ly + (v.sin < -0.3 ? 9 : v.sin > 0.3 ? 21 : 14)}
                      textAnchor={v.anchor} fontSize="13" fontWeight="700" className="mn"
                      fill={on ? v.color : v.count > 0 ? v.color : '#46525E'}
                      style={{ transition: 'fill .15s' }}>
                      {v.count}
                    </text>
                  </g>
                )
              })}
            </>
          )}

          {/* Center */}
          <circle cx={CENTER} cy={CENTER} r="28" fill="#FFFFFF" stroke="#DDE4EC" strokeWidth="1" />
          <line x1={CENTER - 5} y1={CENTER} x2={CENTER + 5} y2={CENTER} stroke="#34D6C1" strokeWidth="0.8" />
          <line x1={CENTER} y1={CENTER - 5} x2={CENTER} y2={CENTER + 5} stroke="#34D6C1" strokeWidth="0.8" />
          {activeSeg ? (<>
            <text x={CENTER} y={CENTER - 6} textAnchor="middle" fontSize="18" fontWeight="700" className="mn" fill={activeSeg.color}>{activeCnt}</text>
            <text x={CENTER} y={CENTER + 7} textAnchor="middle" fontSize="6.5" className="mn" fill="#46525E" letterSpacing="0.12em">CASES</text>
          </>) : (<>
            <text x={CENTER} y={CENTER - 6} textAnchor="middle" fontSize="18" fontWeight="700" className="mn" fill="#12212F">{counts.total}</text>
            <text x={CENTER} y={CENTER + 7} textAnchor="middle" fontSize="6.5" className="mn" fill="#46525E" letterSpacing="0.12em">ACTIVE</text>
          </>)}
        </svg>
      </div>

      {/* Detail panel */}
      {activeSeg && (
        <div className="tr-dp" style={{ border: `1px solid ${activeSeg.color}44` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: activeSeg.color, flexShrink: 0, display: 'inline-block' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: activeSeg.color }}>{activeSeg.label}</span>
                <span className="tr-sv-badge" style={SEV_STYLE[activeVtx?.sev ?? 'NIL']}>{activeVtx?.sev}</span>
                {selected && (
                  <button onClick={() => setSelected(null)}
                    style={{ marginLeft: 'auto', fontSize: 11, color: '#5F7082', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    ✕ dismiss
                  </button>
                )}
              </div>
              <p style={{ fontSize: 11, color: '#5F7082', lineHeight: 1.6 }}>{activeSeg.detail}</p>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: activeSeg.color, fontFamily: 'ui-monospace,monospace', lineHeight: 1 }}>{activeCnt}</div>
              <div style={{ fontSize: 9, color: '#46525E', marginTop: 3, letterSpacing: '.1em' }}>ACCOUNTS</div>
            </div>
          </div>
          <div className="tr-dg">
            {[
              { label: 'Statute / Standard',   value: activeSeg.statute, mono: true  },
              { label: 'Detection Threshold',   value: activeSeg.band,    mono: true  },
              { label: 'Detection Method',      value: activeSeg.method,  mono: false },
              { label: 'Recommended Action',    value: activeSeg.action,  mono: false, accent: activeSeg.color },
            ].map(({ label, value, mono, accent }) => (
              <div key={label} className="tr-dc">
                <div className="tr-dcl">{label}</div>
                <div className={`tr-dcv${mono ? ' mn' : ''}`} style={accent ? { color: accent } : {}}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Row list */}
      <div className="tr-rs">
        {verts.map(v => {
          const pct = maxCount > 0 ? Math.round((v.count / maxCount) * 100) : 0
          const on  = activeKey === v.key
          return (
            <div key={v.key} className={`tr-row${on ? ' on' : ''}`}
              onClick={() => toggle(v.key)}
              onMouseEnter={() => enter(v.key)}
              onMouseLeave={leave}
            >
              <span className="tr-dot" style={{ background: v.count > 0 ? v.color : '#2A3542' }} />
              <div>
                <div className="tr-rl" style={{ color: on ? v.color : v.count > 0 ? '#12212F' : '#7A8794' }}>{v.label}</div>
                <div className="tr-rt">{v.tag}</div>
              </div>
              <div className="tr-rc mn" style={{ color: v.count > 0 ? v.color : '#46525E' }}>
                {loading ? '—' : v.count.toLocaleString()}
              </div>
              <div className="tr-rtr">
                <div className="tr-rfi" style={{ width: `${loading ? 0 : pct}%`, background: v.color }} />
              </div>
              <span className="tr-sv-badge" style={SEV_STYLE[v.sev]}>
                {loading ? '···' : v.sev}
              </span>
            </div>
          )
        })}
      </div>

      {!selected && !hovered && (
        <div className="tr-hn">Click or hover a typology to inspect</div>
      )}
    </div>
  )
}
