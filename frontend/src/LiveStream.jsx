import { useState, useEffect, useRef, useCallback } from 'react'
import { API_BASE } from './api'

const fmtUSD = n => typeof n === 'number' ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'

const fmtTS = str => {
  if (!str) return '—'
  try { return new Date(String(str).replace('/', '-').replace('/', '-').replace(' ', 'T')).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }
  catch { return str }
}

const FLAG_LEVEL = {
  high:   'badge-red',
  medium: 'badge-amber',
  low:    'badge-teal',
}

const ALERT_STYLES = {
  structuring:       { border: 'border-red-200', bg: 'bg-red-50', text: 'text-red-800', icon: '⚡', label: 'Structuring' },
  large_transaction: { border: 'border-amber-200', bg: 'bg-amber-50', text: 'text-amber-800', icon: '💰', label: 'Large Txn' },
  smurfing:          { border: 'border-purple-200', bg: 'bg-purple-50', text: 'text-purple-800', icon: '🔄', label: 'Smurfing' },
}

const SPEED_PRESETS = [
  { label: '10x', value: 10 }, { label: '50x', value: 50 }, { label: '100x', value: 100 },
  { label: '500x', value: 500 }, { label: '1000x', value: 1000 },
]

function TxnRow({ txn, isNew }) {
  const level = txn.is_laundering ? 'high' : (txn.synthetic ? 'medium' : 'low')
  return (
    <div className={`flex items-center gap-3 px-3 py-1.5 text-[11px] font-mono border-b border-[var(--border-card)] transition-all ${isNew ? 'bg-[var(--orange-bg)]' : 'hover:bg-[var(--bg-card-hover)]/50'} ${txn.synthetic ? 'bg-purple-50 border-l-2 border-l-purple-400' : ''}`}>
      <span className="text-[var(--text-secondary)] w-28 shrink-0">{fmtTS(txn.timestamp)}</span>
      <span className={`font-semibold w-20 shrink-0 ${txn.is_laundering ? 'text-red-600' : 'text-[var(--text-primary)]'}`}>{fmtUSD(txn.amount)}</span>
      <span className="text-[var(--text-secondary)] shrink-0 font-mono text-[10px]">{txn.sender?.slice(-10)}</span>
      <span className="text-[var(--text-muted)]">→</span>
      <span className="text-[var(--text-secondary)] shrink-0 font-mono text-[10px]">{txn.receiver?.slice(-10)}</span>
      <span className={`ml-auto inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold ${FLAG_LEVEL[level] || 'badge-teal'}`}>
        {txn.synthetic ? 'SYNTH' : level.toUpperCase()}
      </span>
    </div>
  )
}

function AlertCard({ alert }) {
  const style = ALERT_STYLES[alert.alert_type] || ALERT_STYLES.structuring
  const sevCls = alert.severity === 'high' ? 'badge-red' : 'badge-amber'
  return (
    <div className={`${style.bg} border ${style.border} rounded-xl px-4 py-3 space-y-1.5 ${alert.synthetic ? 'border-l-4 border-l-purple-500' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>{style.icon}</span>
          <span className={`text-xs font-bold ${style.text}`}>{style.label}</span>
          <span className={sevCls}>{alert.severity?.toUpperCase()}</span>
          {alert.synthetic && <span className="badge-emerald">SYNTH</span>}
        </div>
        <span className="text-[10px] text-[var(--text-secondary)] font-mono">{fmtTS(alert.timestamp || alert.last_ts)}</span>
      </div>
      <p className="text-xs text-[var(--text-secondary)]">{alert.message}</p>
      <div className="flex gap-4 text-[10px] text-[var(--text-secondary)]">
        <span>Account: <span className="font-mono text-[var(--text-primary)]">{alert.account_id?.slice(-12)}</span></span>
        {alert.near_threshold_count != null && <span>Near-threshold: <span className="font-mono text-amber-700">{alert.near_threshold_count}</span></span>}
        {alert.fan_out_count != null && <span>Receivers: <span className="font-mono text-purple-700">{alert.fan_out_count}</span></span>}
        {alert.amount != null && <span>Amount: <span className="font-mono">{fmtUSD(alert.amount)}</span></span>}
        {alert.total_spread != null && <span>Spread: <span className="font-mono">{fmtUSD(alert.total_spread)}</span></span>}
      </div>
    </div>
  )
}

export default function LiveStream() {
  const [status, setStatus] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [alerts, setAlerts] = useState([])
  const [speed, setSpeed] = useState(100)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)
  const [injecting, setInjecting] = useState(false)
  const evtSourceRef = useRef(null)
  const txnListRef = useRef(null)
  const alertListRef = useRef(null)
  const prevTxnCount = useRef(0)

  useEffect(() => {
    fetch(`${API_BASE}/stream/status`).then(r => r.json()).then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    const id = setTimeout(() => { prevTxnCount.current = transactions.length }, 600)
    return () => clearTimeout(id)
  }, [transactions])

  useEffect(() => { if (txnListRef.current) txnListRef.current.scrollTop = txnListRef.current.scrollHeight }, [transactions])
  useEffect(() => { if (alertListRef.current && alerts.length > 0) alertListRef.current.scrollTop = alertListRef.current.scrollHeight }, [alerts])

  const connectSSE = useCallback(() => {
    if (evtSourceRef.current) evtSourceRef.current.close()
    const es = new EventSource(`${API_BASE}/stream/events`)
    evtSourceRef.current = es
    setConnected(true); setError(null)
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'status' || (!data.type && data.running !== undefined)) setStatus(data)
        else if (data.type === 'transaction') setTransactions(prev => { const next = [...prev, data]; return next.length > 200 ? next.slice(-200) : next })
        else if (data.type === 'alert') setAlerts(prev => [...prev, data])
        else if (data.type === 'complete') { setStatus(data); es.close(); setConnected(false) }
        else if (data.running !== undefined) setStatus(data)
      } catch { /* ignore */ }
    }
    es.onerror = () => setConnected(false)
  }, [])

  const disconnectSSE = useCallback(() => {
    if (evtSourceRef.current) { evtSourceRef.current.close(); evtSourceRef.current = null }
    setConnected(false)
  }, [])

  useEffect(() => { return () => disconnectSSE() }, [disconnectSSE])

  const handleStart = async () => {
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/stream/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speed }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus(await res.json())
      setTransactions([]); setAlerts([]); prevTxnCount.current = 0
      connectSSE()
    } catch (err) { setError(err.message) }
  }

  const handleStop = async () => {
    try { await fetch(`${API_BASE}/stream/stop`, { method: 'POST' }); disconnectSSE(); setStatus(await (await fetch(`${API_BASE}/stream/status`)).json()) }
    catch (err) { setError(err.message) }
  }

  const handlePause = async () => { try { setStatus(await (await fetch(`${API_BASE}/stream/pause`, { method: 'POST' })).json()) } catch {} }
  const handleResume = async () => { try { setStatus(await (await fetch(`${API_BASE}/stream/resume`, { method: 'POST' })).json()) } catch {} }

  const handleInjectAttack = async () => {
    setInjecting(true)
    try {
      const res = await fetch(`${API_BASE}/stream/inject-attack`, { method: 'POST' })
      const data = await res.json()
      if (data.error) setError(data.error)
    } catch (err) { setError(err.message) }
    finally { setInjecting(false) }
  }

  const isRunning = status?.running && !status?.paused
  const isPaused = status?.running && status?.paused
  const progress = status?.progress ?? 0
  const syntheticCount = transactions.filter(t => t.synthetic).length

  return (
    <div className="space-y-5">
      {/* Header + Controls */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <p className="eyebrow">Live Transaction Stream</p>
          <p className="text-sm text-[var(--text-secondary)] mt-1">Replay the IBM AML dataset chronologically — watch fraud detection fire in real-time</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-[var(--bg-card-hover)] rounded-xl p-1 border border-[var(--border-card)]">
            {SPEED_PRESETS.map(p => (
              <button key={p.value} onClick={() => setSpeed(p.value)}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all ${speed === p.value ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm border border-[var(--border-card)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{p.label}</button>
            ))}
          </div>
          {!status?.running ? (
            <button onClick={handleStart} className="px-5 py-2 rounded-xl text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-500 transition-all shadow-sm">▶ Start Stream</button>
          ) : (
            <div className="flex items-center gap-2">
              {isPaused ? <button onClick={handleResume} className="px-4 py-2 rounded-xl text-[11px] font-bold bg-blue-600 text-white hover:bg-blue-500 transition-all shadow-sm">▶ Resume</button>
              : <button onClick={handlePause} className="px-4 py-2 rounded-xl text-[11px] font-bold bg-amber-600 text-white hover:bg-amber-500 transition-all shadow-sm">❚❚ Pause</button>}
              <button onClick={handleStop} className="px-4 py-2 rounded-xl text-[11px] font-bold bg-red-600 text-white hover:bg-red-500 transition-all shadow-sm">■ Stop</button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-xs text-red-600">{error}</div>}

      {/* Stats */}
      {status && (
        <div className="card space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-[var(--border-card)] rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-300 ${isRunning ? 'bg-orange-500 animate-pulse' : isPaused ? 'bg-amber-500' : 'bg-[var(--text-muted)]'}`} style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs font-mono text-[var(--text-secondary)] shrink-0">{progress.toFixed(1)}%</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <div className="bg-[var(--bg-card-hover)]/80 rounded-xl px-3 py-2 border border-[var(--border-card)]/60">
              <p className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest">Status</p>
              <p className={`text-sm font-bold ${isRunning ? 'text-emerald-600' : isPaused ? 'text-amber-600' : 'text-[var(--text-secondary)]'}`}>{isRunning ? 'Streaming' : isPaused ? 'Paused' : 'Idle'}</p>
            </div>
            <div className="bg-[var(--bg-card-hover)]/80 rounded-xl px-3 py-2 border border-[var(--border-card)]/60">
              <p className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest">Events</p>
              <p className="text-sm font-bold font-mono text-orange-600">{transactions.length}<span className="text-[var(--text-muted)] text-[10px]">/{status.total_rows?.toLocaleString()}</span></p>
            </div>
            <div className="bg-[var(--bg-card-hover)]/80 rounded-xl px-3 py-2 border border-[var(--border-card)]/60">
              <p className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest">Flagged</p>
              <p className="text-sm font-bold font-mono text-red-600">{[...new Set(alerts.map(a => a.account_id))].length}</p>
            </div>
            <div className="bg-[var(--bg-card-hover)]/80 rounded-xl px-3 py-2 border border-[var(--border-card)]/60">
              <p className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest">Volume</p>
              <p className="text-sm font-bold font-mono text-[var(--text-primary)]">{fmtUSD(transactions.reduce((s, t) => s + (t.amount || 0), 0))}</p>
            </div>
            <div className="bg-[var(--bg-card-hover)]/80 rounded-xl px-3 py-2 border border-[var(--border-card)]/60">
              <p className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest">Alerts</p>
              <p className={`text-sm font-bold font-mono ${alerts.length > 0 ? 'text-red-600' : 'text-[var(--text-secondary)]'}`}>{alerts.length}</p>
            </div>
            <div className="bg-[var(--bg-card-hover)]/80 rounded-xl px-3 py-2 border border-[var(--border-card)]/60">
              <p className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest">Latency</p>
              <p className="text-sm font-bold font-mono text-[var(--text-secondary)]">&lt;100ms SSE</p>
            </div>
          </div>
        </div>
      )}

      {/* Attack Simulator */}
      {status?.running && (
        <div className="card !bg-purple-50/80 !border-purple-200/60 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold text-purple-700 uppercase tracking-wider">Live Attack Simulator</p>
            <p className="text-xs text-purple-600 mt-1">Inject a synthetic structuring pattern into the live stream — clearly labeled for demo purposes</p>
          </div>
          <button
            onClick={handleInjectAttack}
            disabled={injecting}
            className="px-4 py-2 rounded-xl text-[11px] font-bold bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 transition-all flex items-center gap-2 shadow-sm"
          >
            {injecting ? (
              <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Injecting…</>
            ) : (
              '⚡ Inject Attack'
            )}
          </button>
        </div>
      )}

      {/* Synthetic count badge */}
      {syntheticCount > 0 && (
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-purple-50 border border-purple-200 text-[10px] font-mono text-purple-700">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
          {syntheticCount} synthetic transaction{syntheticCount !== 1 ? 's' : ''} injected
        </div>
      )}

      {/* Alerts + Transaction Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-[0.2em]">Alerts {alerts.length > 0 && <span className="text-red-600 ml-1">({alerts.length})</span>}</h3>
            {alerts.length > 0 && <button onClick={() => setAlerts([])} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">Clear</button>}
          </div>
          <div ref={alertListRef} className="border border-[var(--border-card)]/80 rounded-2xl p-3 space-y-2 max-h-[400px] overflow-y-auto bg-[var(--bg-card)] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
            {alerts.length === 0 ? (
              <div className="py-8 text-center space-y-1"><p className="text-[var(--text-muted)] text-xs">No alerts yet</p><p className="text-[var(--text-muted)] text-[10px]">Start the stream to see live detection</p></div>
            ) : alerts.map((a, i) => <AlertCard key={i} alert={a} />)}
          </div>
        </div>

        <div className="lg:col-span-2 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-[0.2em]">Transaction Feed {transactions.length > 0 && <span className="text-[var(--text-secondary)] ml-1">({transactions.length})</span>}</h3>
            {transactions.length > 0 && <button onClick={() => setTransactions([])} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">Clear</button>}
          </div>
          <div ref={txnListRef} className="border border-[var(--border-card)]/80 rounded-2xl overflow-hidden max-h-[400px] overflow-y-auto bg-[var(--bg-card)] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
            {transactions.length === 0 ? (
              <div className="py-14 text-center space-y-1"><p className="text-[var(--text-muted)] text-xs">Waiting for stream…</p><p className="text-[var(--text-muted)] text-[10px]">Transactions will appear here as they are inserted</p></div>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[500px]">
                  <div className="flex items-center gap-3 px-3 py-2 bg-[var(--bg-card-hover)] border-b border-[var(--border-card)] text-[10px] text-[var(--text-muted)] font-semibold uppercase tracking-wider">
                    <span className="w-28 shrink-0">Timestamp</span><span className="w-20 shrink-0">Amount</span><span className="w-20 shrink-0">Sender</span><span className="w-4" /><span className="w-20 shrink-0">Receiver</span><span className="ml-auto">Flag</span>
                  </div>
                  {transactions.map((txn, i) => <TxnRow key={txn.transaction_id || i} txn={txn} isNew={i >= prevTxnCount.current} />)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Info */}
      {!status?.running && (
        <div className="bg-[var(--bg-card-hover)]/80 border border-[var(--border-card)]/60 rounded-2xl px-4 py-3 text-[10px] text-[var(--text-muted)] space-y-1">
          <p><span className="font-semibold text-[var(--text-secondary)]">How it works:</span> The simulator reads the IBM AML CSV chronologically and inserts transactions into DuckDB at accelerated speed. After each batch, lightweight detection checks fire for structuring patterns and large transactions.</p>
          <p><span className="font-semibold text-[var(--text-secondary)]">Detection thresholds:</span> Structuring = 2+ near-threshold deposits ($9,500–$10,000) within 30 days · Large transaction = single amount $50,000+ · Smurfing = 3+ distinct receivers within 7 days</p>
        </div>
      )}
    </div>
  )
}
