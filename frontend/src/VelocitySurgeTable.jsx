import { useEffect, useState } from 'react'

const API_BASE = 'http://localhost:8000'

const fmtUSD = n =>
  typeof n === 'number'
    ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : '—'

const fmtDate = s => {
  try { return new Date(String(s).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  catch { return s }
}

const RISK_CFG = {
  high:   { label: 'HIGH',   bg: '#FFF1F3', border: '#FF5D6C', text: '#D73A4A', bar: '#FF5D6C' },
  medium: { label: 'MED',    bg: '#FFF8EA', border: '#F2A93B', text: '#B97910', bar: '#F2A93B' },
}

const ESC_CFG = {
  report: { label: 'File SAR',        color: '#FF5D6C' },
  review: { label: 'Analyst Review',  color: '#F2A93B' },
}

const CSS = `
  .vs { --bg:var(--bg-page);--bd:var(--border-card);--tx:var(--text-primary);--dim:var(--text-secondary);--mu:var(--text-muted);
    background:var(--bg);border:1px solid var(--bd);border-radius:12px;
    padding:22px;color:var(--tx);position:relative;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif; }
  .vs::before { content:none; }
  .mn { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,Consolas,monospace; }

  .vs-hd  { display:flex;align-items:flex-start;justify-content:space-between;position:relative;z-index:1;margin-bottom:16px; }
  .vs-ey  { display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim); }
  .vs-ld  { width:6px;height:6px;border-radius:50%;background:#F2A93B;animation:vsp 2s infinite; }
  @keyframes vsp { 0%{box-shadow:0 0 0 0 rgba(242,169,59,.55)} 70%{box-shadow:0 0 0 6px rgba(242,169,59,0)} 100%{box-shadow:0 0 0 0 rgba(242,169,59,0)} }
  .vs-ti  { font-size:15px;font-weight:600;margin-top:5px;letter-spacing:-.01em; }
  .vs-sb  { font-size:11px;color:var(--dim);margin-top:2px; }

  .vs-meta { display:flex;gap:16px;margin-bottom:16px;position:relative;z-index:1; }
  .vs-mc   { background:var(--bg-card);border:1px solid var(--bd);border-radius:8px;padding:10px 14px;flex:1; }
  .vs-mcl  { font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--mu); }
  .vs-mcv  { font-size:20px;font-weight:700;line-height:1.2;margin-top:3px; }
  .vs-mcs  { font-size:10px;color:var(--dim);margin-top:1px; }

  .vs-list { position:relative;z-index:1;border-top:1px solid var(--bd); }
  .vs-row  { border-bottom:1px solid var(--bd);cursor:pointer;transition:background .12s; }
  .vs-row:hover { background:rgba(76,141,255,.04); }
  .vs-row.open  { background:rgba(76,141,255,.07); }

  .vs-main { display:grid;grid-template-columns:1fr 90px 70px 56px;align-items:center;gap:12px;padding:10px 4px; }
  .vs-acct { font-size:12px;font-weight:700;color:var(--text-primary);font-family:ui-monospace,monospace; }
  .vs-date { font-size:10px;color:var(--dim);margin-top:2px; }

  .vs-vbar-wrap { display:flex;flex-direction:column;gap:3px; }
  .vs-vbar-row  { display:flex;align-items:center;gap:5px; }
  .vs-vbar-lbl  { font-size:8.5px;color:var(--mu);width:20px;flex-shrink:0; }
  .vs-vbar-track{ flex:1;height:4px;background:var(--border-card);border-radius:2px;overflow:hidden; }
  .vs-vbar-fill { height:100%;border-radius:2px;transition:width .4s ease; }
  .vs-vbar-val  { font-size:9px;font-family:ui-monospace,monospace;color:var(--dim);width:30px;text-align:right; }

  .vs-ratio { text-align:right; }
  .vs-ratio-v { font-size:18px;font-weight:700;font-family:ui-monospace,monospace;line-height:1; }
  .vs-ratio-l { font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--mu);margin-top:2px; }

  .vs-badge { font-size:8px;font-weight:700;letter-spacing:.08em;padding:2px 5px;border-radius:3px;border-width:1px;border-style:solid;font-family:ui-monospace,monospace; }

  .vs-detail { padding:0 4px 12px;border-top:1px solid var(--bd); }
  .vs-dg { display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:10px; }
  .vs-dc { background:var(--bg-card-hover);border:1px solid var(--bd);border-radius:6px;padding:8px 10px; }
  .vs-dcl { font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--mu); }
  .vs-dcv { font-size:12px;font-weight:700;margin-top:3px; }

  .vs-esc { display:flex;align-items:center;justify-content:space-between;margin-top:10px;
    background:var(--bg-card-hover);border-radius:6px;padding:8px 12px;border:1px solid var(--bd); }
  .vs-esc-l { font-size:10px;color:var(--dim); }
  .vs-esc-a { font-size:11px;font-weight:700; }

  .vs-empty { display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 20px;position:relative;z-index:1; }
  .vs-skel  { animation:vsf 1.4s ease-in-out infinite; }
  @keyframes vsf { 0%,100%{opacity:.3} 50%{opacity:.6} }
`

export default function VelocitySurgeTable({ velocityData: propData }) {
  const [fetched,  setFetched]  = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    if (propData) return
    setLoading(true)
    setError(null)
    fetch(`${API_BASE}/tools/detect_velocity_spikes`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args: { window_days: 7, baseline_days: 30, top_n: 10 } }),
    })
      .then(r => { if (r.ok) return r.json(); throw new Error(`HTTP ${r.status}`) })
      .then(d => setFetched(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [propData])

  const data     = propData || fetched
  const accounts = data?.flagged_accounts ?? []
  const maxRatio = Math.max(1, ...accounts.map(a => a.spike_ratio))
  const maxVel   = Math.max(1, ...accounts.map(a => a.current_velocity_per_day))

  const toggle = key => setExpanded(e => e === key ? null : key)

  return (
    <div className="vs">
      <style>{CSS}</style>

      {/* Header */}
      <div className="vs-hd">
        <div>
          <div className="vs-ey"><span className="vs-ld" />Behavioral Intelligence · Live</div>
          <div className="vs-ti">Velocity Surge Monitor</div>
          <div className="vs-sb">Accounts with abnormal transaction frequency spikes</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Flagged</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'ui-monospace,monospace', lineHeight: 1.1, color: '#F2A93B' }}>
            {loading ? '—' : accounts.length}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
            {data?.accounts_scanned != null ? `of ${data.accounts_scanned.toLocaleString()} scanned` : ''}
          </div>
        </div>
      </div>

      {/* Summary cards */}
      {!loading && accounts.length > 0 && (
        <div className="vs-meta">
          <div className="vs-mc">
            <div className="vs-mcl">Window</div>
            <div className="vs-mcv mn" style={{ color: '#F2A93B', fontSize: 14 }}>
              {data?.window_days}d current vs {data?.baseline_days}d baseline
            </div>
            <div className="vs-mcs">{data?.as_of ? `as of ${fmtDate(data.as_of)}` : ''}</div>
          </div>
          <div className="vs-mc">
            <div className="vs-mcl">Peak Spike Ratio</div>
            <div className="vs-mcv mn" style={{ color: '#FF5D6C' }}>{maxRatio.toFixed(1)}×</div>
            <div className="vs-mcs">vs. account baseline</div>
          </div>
          <div className="vs-mc">
            <div className="vs-mcl">High Severity</div>
            <div className="vs-mcv mn" style={{ color: '#FF5D6C' }}>
              {accounts.filter(a => a.risk_level === 'high').length}
            </div>
            <div className="vs-mcs">require SAR filing</div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ position: 'relative', zIndex: 1 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="vs-skel" style={{
              height: 56, background: 'var(--bg-card-hover)', border: '1px solid var(--border-card)', borderRadius: 6, marginBottom: 8,
              opacity: 1 - i * 0.15,
            }} />
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div style={{ position: 'relative', zIndex: 1, background: 'var(--red-bg)', border: '1px solid var(--red-border)',
          borderRadius: 8, padding: '12px 16px', fontSize: 11, color: '#D73A4A' }}>
          Failed to load velocity data: {error}
        </div>
      )}

      {/* Empty */}
      {!loading && !error && accounts.length === 0 && (
        <div className="vs-empty">
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--bg-card-hover)',
            border: '1px solid var(--border-card)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>No velocity spikes detected</p>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6, textAlign: 'center' }}>
            {data?.accounts_scanned != null
              ? `${data.accounts_scanned.toLocaleString()} accounts scanned · threshold ≥${data.spike_ratio_threshold}× baseline`
              : 'No accounts met the spike threshold in this window'}
          </p>
        </div>
      )}

      {/* Account rows */}
      {!loading && accounts.length > 0 && (
        <div className="vs-list">
          {accounts.map((acct, i) => {
            const cfg    = RISK_CFG[acct.risk_level] ?? RISK_CFG.medium
            const esc    = ESC_CFG[acct.escalation]  ?? ESC_CFG.review
            const isOpen = expanded === acct.account_id
            const curPct = (acct.current_velocity_per_day / maxVel) * 100
            const basePct = Math.min((acct.baseline_velocity_per_day / maxVel) * 100, curPct)
            const ratioPct = Math.min((acct.spike_ratio / maxRatio) * 100, 100)

            return (
              <div key={acct.account_id} className={`vs-row${isOpen ? ' open' : ''}`}
                onClick={() => toggle(acct.account_id)}>

                {/* Main row */}
                <div className="vs-main">
                  {/* Account + date */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <div className="vs-acct">{acct.account_id}</div>
                      <span className="vs-badge" style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.text }}>
                        {cfg.label}
                      </span>
                    </div>
                    <div className="vs-date">Spike started {fmtDate(acct.spike_date)}</div>
                  </div>

                  {/* Velocity bars */}
                  <div className="vs-vbar-wrap">
                    <div className="vs-vbar-row">
                      <span className="vs-vbar-lbl">Now</span>
                      <div className="vs-vbar-track">
                        <div className="vs-vbar-fill" style={{ width: `${curPct}%`, background: cfg.bar }} />
                      </div>
                      <span className="vs-vbar-val" style={{ color: cfg.text }}>{acct.current_velocity_per_day.toFixed(1)}</span>
                    </div>
                    <div className="vs-vbar-row">
                      <span className="vs-vbar-lbl">Base</span>
                      <div className="vs-vbar-track">
                        <div className="vs-vbar-fill" style={{ width: `${basePct}%`, background: 'var(--text-muted)' }} />
                      </div>
                      <span className="vs-vbar-val">{acct.baseline_velocity_per_day.toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Volume */}
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'ui-monospace,monospace', color: 'var(--text-primary)' }}>
                      {fmtUSD(acct.total_volume_recent_usd)}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginTop: 1 }}>{acct.txn_count_recent} txns</div>
                  </div>

                  {/* Spike ratio */}
                  <div className="vs-ratio">
                    <div className="vs-ratio-v" style={{ color: cfg.text }}>{acct.spike_ratio.toFixed(1)}×</div>
                    <div className="vs-ratio-l">spike</div>
                  </div>
                </div>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="vs-detail">
                    <div className="vs-dg">
                      <div className="vs-dc">
                        <div className="vs-dcl">Current Velocity</div>
                        <div className="vs-dcv mn" style={{ color: cfg.text }}>{acct.current_velocity_per_day.toFixed(3)} txns/day</div>
                      </div>
                      <div className="vs-dc">
                        <div className="vs-dcl">Baseline Velocity</div>
                        <div className="vs-dcv mn" style={{ color: 'var(--text-secondary)' }}>{acct.baseline_velocity_per_day.toFixed(3)} txns/day</div>
                      </div>
                      <div className="vs-dc">
                        <div className="vs-dcl">Total Volume ({data?.window_days}d)</div>
                        <div className="vs-dcv mn" style={{ color: 'var(--text-primary)' }}>{fmtUSD(acct.total_volume_recent_usd)}</div>
                      </div>
                      <div className="vs-dc">
                        <div className="vs-dcl">Transactions ({data?.window_days}d)</div>
                        <div className="vs-dcv mn" style={{ color: 'var(--text-primary)' }}>{acct.txn_count_recent}</div>
                      </div>
                      <div className="vs-dc">
                        <div className="vs-dcl">Spike Detected</div>
                        <div className="vs-dcv mn" style={{ color: 'var(--text-secondary)' }}>{fmtDate(acct.spike_date)}</div>
                      </div>
                      <div className="vs-dc">
                        <div className="vs-dcl">Spike Ratio</div>
                        <div className="vs-dcv mn" style={{ color: cfg.text }}>{acct.spike_ratio.toFixed(2)}× baseline</div>
                      </div>
                    </div>

                    {/* Spike ratio bar */}
                    <div style={{ marginTop: 10, background: 'var(--bg-card-hover)', borderRadius: 6, padding: '8px 12px', border: '1px solid var(--bd)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '.1em', textTransform: 'uppercase' }}>Spike Intensity</span>
                        <span style={{ fontSize: 9, color: cfg.text, fontFamily: 'ui-monospace,monospace' }}>{acct.spike_ratio.toFixed(1)}× / {maxRatio.toFixed(1)}× max</span>
                      </div>
                      <div style={{ height: 6, background: 'var(--border-card)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${ratioPct}%`, background: `linear-gradient(90deg, ${cfg.bar}88, ${cfg.bar})`, borderRadius: 3, transition: 'width .4s ease' }} />
                      </div>
                    </div>

                    {/* Escalation recommendation */}
                    <div className="vs-esc">
                      <div>
                        <div className="vs-esc-l">Recommended Action</div>
                        <div className="vs-esc-a" style={{ color: esc.color }}>{esc.label}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="vs-esc-l">FinCEN Reference</div>
                        <div style={{ fontSize: 10, fontFamily: 'ui-monospace,monospace', color: 'var(--text-secondary)', marginTop: 2 }}>FIN-2014-A005</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!loading && accounts.length > 0 && (
        <div style={{ position: 'relative', zIndex: 1, fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', paddingTop: 10 }}>
          Click a row to expand details · {data?.spike_ratio_threshold}× baseline threshold · {data?.window_days}d window
        </div>
      )}
    </div>
  )
}
