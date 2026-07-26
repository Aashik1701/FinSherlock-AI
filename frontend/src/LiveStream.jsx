import { useState, useEffect, useRef, useCallback } from 'react'

const API_BASE = 'http://localhost:8000'

// ─── Helpers ───────────────────────────────────────────────────────────────

const fmtUSD = n =>
  typeof n === 'number'
    ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'

const fmtTS = str => {
  if (!str) return '—'
  try {
    return new Date(String(str).replace('/', '-').replace('/', '-').replace(' ', 'T')).toLocaleString('en-US', {
      month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
  } catch { return str }
}

const ALERT_STYLES = {
  structuring:       { bg: 'bg-red-950/40', border: 'border-red-800', text: 'text-red-300', icon: '⚡', label: 'Structuring' },
  large_transaction: { bg: 'bg-amber-950/40', border: 'border-amber-800', text: 'text-amber-300', icon: '💰', label: 'Large Transaction' },
}

const SEVERITY_STYLES = {
  high:   'bg-red-500/20 text-red-400 border-red-800',
  medium: 'bg-amber-500/20 text-amber-400 border-amber-800',
  low:    'bg-slate-700/40 text-slate-400 border-slate-600',
}

// ─── Transaction Row ───────────────────────────────────────────────────────

function TxnRow({ txn, isNew }) {
  return (
    <div className={`flex items-center gap-3 px-3 py-1.5 text-[11px] font-mono border-b border-slate-800/30 transition-all ${
      isNew ? 'bg-blue-950/20 animate-pulse' : 'hover:bg-slate-800/20'
    }`}>
      <span className="text-slate-600 w-28 shrink-0">{fmtTS(txn.timestamp)}</span>
      <span className={`font-semibold w-20 shrink-0 ${txn.is_laundering ? 'text-red-400' : 'text-slate-300'}`}>
        {fmtUSD(txn.amount)}
      </span>
      <span className="text-slate-500 shrink-0">{txn.sender?.slice(-8)}</span>
      <span className="text-slate-700">→</span>
      <span className="text-slate-500 shrink-0">{txn.receiver?.slice(-8)}</span>
      <span className="text-slate-700 ml-auto">{txn.tx_type}</span>
    </div>
  )
}

// ─── Alert Card ────────────────────────────────────────────────────────────

function AlertCard({ alert }) {
  const style = ALERT_STYLES[alert.alert_type] || ALERT_STYLES.structuring
  const sev = SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.medium
  return (
    <div className={`${style.bg} border ${style.border} rounded-xl px-4 py-3 space-y-1.5`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">{style.icon}</span>
          <span className={`text-xs font-bold ${style.text}`}>{style.label}</span>
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${sev}`}>
            {alert.severity?.toUpperCase()}
          </span>
        </div>
        <span className="text-[10px] text-slate-600 font-mono">{fmtTS(alert.timestamp || alert.last_ts)}</span>
      </div>
      <p className="text-[11px] text-slate-400">{alert.message}</p>
      <div className="flex gap-4 text-[10px] text-slate-600">
        <span>Account: <span className="font-mono text-slate-400">{alert.account_id}</span></span>
        {alert.near_threshold_count && (
          <span>Near-threshold: <span className="font-mono text-amber-400">{alert.near_threshold_count}</span></span>
        )}
        {alert.amount && (
          <span>Amount: <span className="font-mono text-amber-400">{fmtUSD(alert.amount)}</span></span>
        )}
      </div>
    </div>
  )
}

// ─── Speed Presets ─────────────────────────────────────────────────────────

const SPEED_PRESETS = [
  { label: '10x',  value: 10 },
  { label: '50x',  value: 50 },
  { label: '100x', value: 100 },
  { label: '500x', value: 500 },
  { label: '1000x', value: 1000 },
]

// ─── Main Component ────────────────────────────────────────────────────────

export default function LiveStream() {
  const [status, setStatus] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [alerts, setAlerts] = useState([])
  const [speed, setSpeed] = useState(100)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)
  const evtSourceRef = useRef(null)
  const txnListRef = useRef(null)
  const alertListRef = useRef(null)
  const prevTxnCount = useRef(0)

  // Fetch initial status
  useEffect(() => {
    fetch(`${API_BASE}/stream/status`)
      .then(r => r.json())
      .then(setStatus)
      .catch(() => {})
  }, [])

  // Track previous transaction count so only newly-arrived rows are highlighted
  useEffect(() => {
    const id = setTimeout(() => {
      prevTxnCount.current = transactions.length
    }, 600)  // slightly longer than the animate-pulse duration
    return () => clearTimeout(id)
  }, [transactions])

  // Auto-scroll transaction list
  useEffect(() => {
    if (txnListRef.current) {
      txnListRef.current.scrollTop = txnListRef.current.scrollHeight
    }
  }, [transactions])

  // Auto-scroll alert list
  useEffect(() => {
    if (alertListRef.current && alerts.length > 0) {
      alertListRef.current.scrollTop = alertListRef.current.scrollHeight
    }
  }, [alerts])

  const connectSSE = useCallback(() => {
    if (evtSourceRef.current) {
      evtSourceRef.current.close()
    }

    const es = new EventSource(`${API_BASE}/stream/events`)
    evtSourceRef.current = es
    setConnected(true)
    setError(null)

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)

        if (data.type === 'status' || (!data.type && data.running !== undefined)) {
          setStatus(data)
        } else if (data.type === 'transaction') {
          setTransactions(prev => {
            const next = [...prev, data]
            // Keep last 200 transactions in memory
            return next.length > 200 ? next.slice(-200) : next
          })
        } else if (data.type === 'alert') {
          setAlerts(prev => [...prev, data])
        } else if (data.type === 'complete') {
          setStatus(data)
          es.close()
          setConnected(false)
        } else if (data.running !== undefined) {
          setStatus(data)
        }
      } catch { /* ignore parse errors */ }
    }

    es.onerror = () => {
      setConnected(false)
      // Don't set error on heartbeat timeouts
    }
  }, [])

  const disconnectSSE = useCallback(() => {
    if (evtSourceRef.current) {
      evtSourceRef.current.close()
      evtSourceRef.current = null
    }
    setConnected(false)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => disconnectSSE()
  }, [disconnectSSE])

  const handleStart = async () => {
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/stream/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speed }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${res.status}`)
      }
      setStatus(await res.json())
      setTransactions([])
      setAlerts([])
      prevTxnCount.current = 0
      connectSSE()
    } catch (err) {
      setError(err.message)
    }
  }

  const handleStop = async () => {
    try {
      await fetch(`${API_BASE}/stream/stop`, { method: 'POST' })
      disconnectSSE()
      const res = await fetch(`${API_BASE}/stream/status`)
      setStatus(await res.json())
    } catch (err) {
      setError(err.message)
    }
  }

  const handlePause = async () => {
    try {
      const res = await fetch(`${API_BASE}/stream/pause`, { method: 'POST' })
      setStatus(await res.json())
    } catch {}
  }

  const handleResume = async () => {
    try {
      const res = await fetch(`${API_BASE}/stream/resume`, { method: 'POST' })
      setStatus(await res.json())
    } catch {}
  }

  const isRunning = status?.running && !status?.paused
  const isPaused = status?.running && status?.paused
  const progress = status?.progress ?? 0

  return (
    <div className="space-y-5">

      {/* ── Header + Controls ──────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
            Live Transaction Stream
          </h2>
          <p className="text-[11px] text-slate-700">
            Replay the IBM AML dataset chronologically — watch fraud detection fire in real-time
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Speed selector */}
          <div className="flex items-center gap-1 bg-slate-900/60 rounded-lg p-0.5 border border-slate-800/50">
            {SPEED_PRESETS.map(p => (
              <button
                key={p.value}
                onClick={() => setSpeed(p.value)}
                className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all ${
                  speed === p.value
                    ? 'bg-slate-800 text-slate-100 shadow-sm'
                    : 'text-slate-600 hover:text-slate-400'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Control buttons */}
          {!status?.running ? (
            <button
              onClick={handleStart}
              className="px-4 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
            >
              ▶ Start Stream
            </button>
          ) : (
            <div className="flex items-center gap-2">
              {isPaused ? (
                <button
                  onClick={handleResume}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-blue-600 text-white hover:bg-blue-500 transition-colors"
                >
                  ▶ Resume
                </button>
              ) : (
                <button
                  onClick={handlePause}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-amber-600 text-white hover:bg-amber-500 transition-colors"
                >
                  ❚❚ Pause
                </button>
              )}
              <button
                onClick={handleStop}
                className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-red-600 text-white hover:bg-red-500 transition-colors"
              >
                ■ Stop
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-950/20 border border-red-900/40 rounded-xl p-3 flex gap-3">
          <span className="text-red-500 text-sm shrink-0">!</span>
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* ── Status Bar ─────────────────────────────────────────────────── */}
      {status && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          {/* Progress bar */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  status.running && !status.paused
                    ? 'bg-blue-500 animate-pulse'
                    : status.paused
                    ? 'bg-amber-500'
                    : 'bg-slate-600'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[11px] font-mono text-slate-400 shrink-0">{progress.toFixed(1)}%</span>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Status</p>
              <p className={`text-sm font-bold ${isRunning ? 'text-emerald-400' : isPaused ? 'text-amber-400' : 'text-slate-500'}`}>
                {isRunning ? 'Streaming' : isPaused ? 'Paused' : status.running ? 'Running' : 'Idle'}
              </p>
            </div>
            <div className="bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Rows</p>
              <p className="text-sm font-bold font-mono text-blue-400">
                {status.rows_inserted?.toLocaleString() ?? 0}
                <span className="text-slate-700 text-[10px]">/{status.total_rows?.toLocaleString()}</span>
              </p>
            </div>
            <div className="bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Speed</p>
              <p className="text-sm font-bold font-mono text-violet-400">{status.speed}x</p>
            </div>
            <div className="bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Alerts</p>
              <p className={`text-sm font-bold font-mono ${status.alerts_fired > 0 ? 'text-red-400' : 'text-slate-500'}`}>
                {status.alerts_fired ?? 0}
              </p>
            </div>
            <div className="bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Data Time</p>
              <p className="text-sm font-bold font-mono text-slate-300 truncate">
                {status.current_timestamp ? fmtTS(status.current_timestamp) : '—'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Alerts + Transactions Grid ────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Alerts Panel */}
        <div className="lg:col-span-1 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
              Alerts {alerts.length > 0 && <span className="text-red-400 ml-1">({alerts.length})</span>}
            </h3>
            {alerts.length > 0 && (
              <button
                onClick={() => setAlerts([])}
                className="text-[10px] text-slate-700 hover:text-slate-500 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <div
            ref={alertListRef}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-3 space-y-2 max-h-[400px] overflow-y-auto"
          >
            {alerts.length === 0 ? (
              <div className="py-8 text-center space-y-1">
                <p className="text-slate-700 text-xs">No alerts yet</p>
                <p className="text-slate-800 text-[10px]">Start the stream to see live detection</p>
              </div>
            ) : (
              alerts.map((a, i) => <AlertCard key={i} alert={a} />)
            )}
          </div>
        </div>

        {/* Transaction Feed */}
        <div className="lg:col-span-2 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">
              Transaction Feed {transactions.length > 0 && <span className="text-slate-700 ml-1">({transactions.length})</span>}
            </h3>
            {transactions.length > 0 && (
              <button
                onClick={() => setTransactions([])}
                className="text-[10px] text-slate-700 hover:text-slate-500 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <div
            ref={txnListRef}
            className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden max-h-[400px] overflow-y-auto"
          >
            {transactions.length === 0 ? (
              <div className="py-14 text-center space-y-1">
                <p className="text-slate-700 text-xs">Waiting for stream…</p>
                <p className="text-slate-800 text-[10px]">Transactions will appear here as they are inserted</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <div className="divide-y divide-slate-800/30 min-w-[480px]">
                {/* Header */}
                <div className="flex items-center gap-3 px-3 py-2 bg-slate-900/80 border-b border-slate-800 text-[10px] text-slate-600 font-semibold uppercase tracking-wider">
                  <span className="w-28 shrink-0">Timestamp</span>
                  <span className="w-20 shrink-0">Amount</span>
                  <span className="w-20 shrink-0">Sender</span>
                  <span className="w-4" />
                  <span className="w-20 shrink-0">Receiver</span>
                  <span className="ml-auto">Type</span>
                </div>
                {transactions.map((txn, i) => (
                  <TxnRow
                    key={txn.transaction_id || i}
                    txn={txn}
                    isNew={i >= prevTxnCount.current}
                  />
                ))}
              </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Info footer ─────────────────────────────────────────────────── */}
      <div className="bg-slate-900/50 border border-slate-800/50 rounded-xl px-4 py-3 text-[10px] text-slate-700 space-y-1">
        <p>
          <span className="text-slate-500 font-semibold">How it works:</span>{' '}
          The simulator reads the IBM AML CSV chronologically and inserts transactions into DuckDB at accelerated speed.
          After each batch, lightweight detection checks fire for structuring patterns and large transactions.
        </p>
        <p>
          <span className="text-slate-500 font-semibold">Detection thresholds:</span>{' '}
          Structuring = {`≥2 near-threshold deposits ($9,500–$10,000) within 30 days`} ·
          Large transaction = single amount ≥ $50,000
        </p>
      </div>
    </div>
  )
}
