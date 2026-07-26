import { useState, useEffect, useCallback } from 'react'

const API_BASE = 'http://localhost:8000'

// ─── Constants ─────────────────────────────────────────────────────────────

const STATUS_STYLES = {
  open:         { bg: 'bg-blue-950/50', text: 'text-blue-300', border: 'border-blue-800', dot: 'bg-blue-500' },
  under_review: { bg: 'bg-amber-950/50', text: 'text-amber-300', border: 'border-amber-800', dot: 'bg-amber-500' },
  escalated:    { bg: 'bg-red-950/50', text: 'text-red-300', border: 'border-red-800', dot: 'bg-red-500' },
  closed:       { bg: 'bg-slate-800/50', text: 'text-slate-400', border: 'border-slate-700', dot: 'bg-slate-500' },
}

const RESOLUTION_STYLES = {
  true_positive:  'bg-red-950/40 text-red-300 border-red-900',
  false_positive: 'bg-emerald-950/40 text-emerald-300 border-emerald-900',
}

const VALID_TRANSITIONS = {
  open:         ['under_review', 'closed'],
  under_review: ['escalated', 'closed'],
  escalated:    ['closed'],
  closed:       [],
}

const fmtDate = str => {
  if (!str) return '—'
  try {
    return new Date(String(str).replace(' ', 'T')).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return str }
}

// ─── Status Badge ──────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.open
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${s.bg} ${s.text} ${s.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {status.replace('_', ' ')}
    </span>
  )
}

// ─── Resolution Badge ──────────────────────────────────────────────────────

function ResolutionBadge({ resolution }) {
  if (!resolution) return null
  const cls = RESOLUTION_STYLES[resolution] || ''
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${cls}`}>
      {resolution === 'true_positive' ? 'TP — Confirmed' : 'FP — Dismissed'}
    </span>
  )
}

// ─── Create Case Modal ─────────────────────────────────────────────────────

function CreateCaseModal({ onClose, onCreated }) {
  const [accountId, setAccountId] = useState('')
  const [queryText, setQueryText] = useState('')
  const [riskScore, setRiskScore] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!accountId.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId.trim(),
          query_text: queryText.trim(),
          risk_score: riskScore ? parseFloat(riskScore) : null,
          notes: notes.trim(),
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      onCreated()
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100">New Investigation Case</h3>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-lg leading-none">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Account ID *</label>
            <input
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-700 focus:outline-none focus:border-blue-600"
              placeholder="e.g. ACC_A"
              required
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Query / Context</label>
            <input
              value={queryText}
              onChange={e => setQueryText(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-700 focus:outline-none focus:border-blue-600"
              placeholder="What triggered this case?"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Risk Score</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={riskScore}
              onChange={e => setRiskScore(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-700 focus:outline-none focus:border-blue-600"
              placeholder="0.0 – 1.0"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-700 focus:outline-none focus:border-blue-600 resize-none"
              placeholder="Analyst notes…"
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-500 hover:text-slate-300 transition-colors">Cancel</button>
            <button
              type="submit"
              disabled={submitting || !accountId.trim()}
              className="px-4 py-1.5 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
            >
              {submitting ? 'Creating…' : 'Create Case'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Case Detail Panel ─────────────────────────────────────────────────────

function CaseDetail({ caseData, onClose, onUpdated }) {
  const [notes, setNotes] = useState(caseData.notes || '')
  const [updating, setUpdating] = useState(false)
  const [actionError, setActionError] = useState(null)

  const _patch = async (body) => {
    const res = await fetch(`${API_BASE}/cases/${caseData.case_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `HTTP ${res.status}`)
    }
    return res
  }

  const transitionTo = async (newStatus) => {
    setUpdating(true)
    setActionError(null)
    try {
      await _patch({ status: newStatus })
      onUpdated()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setUpdating(false)
    }
  }

  const markResolution = async (resolution) => {
    setUpdating(true)
    setActionError(null)
    try {
      // Case is already closed when this button is shown — send only resolution,
      // not status, to avoid a "cannot transition closed→closed" 400 error.
      await _patch({ resolution })
      onUpdated()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setUpdating(false)
    }
  }

  const saveNotes = async () => {
    setUpdating(true)
    setActionError(null)
    try {
      await _patch({ notes })
      onUpdated()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setUpdating(false)
    }
  }

  const transitions = VALID_TRANSITIONS[caseData.status] || []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg p-6 space-y-5 shadow-2xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-slate-100 font-mono">{caseData.case_id}</h3>
              <StatusBadge status={caseData.status} />
              <ResolutionBadge resolution={caseData.resolution} />
            </div>
            <p className="text-[11px] text-slate-600">
              Account <span className="font-mono text-slate-400">{caseData.account_id}</span> &middot; Created {fmtDate(caseData.created_at)}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-lg leading-none shrink-0">&times;</button>
        </div>

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
            <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Risk Score</p>
            <p className={`text-lg font-bold font-mono ${caseData.risk_score != null && caseData.risk_score >= 0.65 ? 'text-red-400' : caseData.risk_score >= 0.30 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {caseData.risk_score != null ? caseData.risk_score.toFixed(3) : '—'}
            </p>
          </div>
          <div className="bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
            <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Assigned To</p>
            <p className="text-sm font-semibold text-slate-300">{caseData.assigned_to || '—'}</p>
          </div>
        </div>

        {/* Query context */}
        {caseData.query_text && (
          <div className="bg-slate-950 rounded-lg px-4 py-3 border border-slate-800">
            <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Investigation Query</p>
            <p className="text-xs text-slate-400 font-mono leading-relaxed">{caseData.query_text}</p>
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="block text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Analyst Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={4}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-700 focus:outline-none focus:border-blue-600 resize-none"
            placeholder="Add findings, rationale, or next steps…"
          />
          <button
            onClick={saveNotes}
            disabled={updating || notes === (caseData.notes || '')}
            className="mt-1.5 px-3 py-1 rounded text-[10px] font-semibold bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 transition-colors"
          >
            Save Notes
          </button>
        </div>

        {/* Action error */}
        {actionError && (
          <p className="text-xs text-red-400 bg-red-950/20 border border-red-900/40 rounded-lg px-3 py-2">{actionError}</p>
        )}

        {/* Actions */}
        <div className="border-t border-slate-800 pt-4 space-y-3">
          {/* Status transitions */}
          {transitions.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-2">Transition Status</p>
              <div className="flex flex-wrap gap-2">
                {transitions.map(s => (
                  <button
                    key={s}
                    onClick={() => transitionTo(s)}
                    disabled={updating}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${
                      s === 'escalated'
                        ? 'bg-red-950/40 text-red-300 border-red-900 hover:bg-red-950/70'
                        : s === 'under_review'
                        ? 'bg-amber-950/40 text-amber-300 border-amber-900 hover:bg-amber-950/70'
                        : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                    }`}
                  >
                    {s === 'under_review' ? '→ Under Review' : s === 'escalated' ? '→ Escalate' : '→ Close'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Resolution (only if not already resolved) */}
          {!caseData.resolution && caseData.status === 'closed' && (
            <div>
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-2">Mark Resolution</p>
              <div className="flex gap-2">
                <button
                  onClick={() => markResolution('true_positive')}
                  disabled={updating}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-red-950/40 text-red-300 border border-red-900 hover:bg-red-950/70 transition-colors"
                >
                  True Positive (Confirmed)
                </button>
                <button
                  onClick={() => markResolution('false_positive')}
                  disabled={updating}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-950/40 text-emerald-300 border border-emerald-900 hover:bg-emerald-950/70 transition-colors"
                >
                  False Positive (Dismiss)
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Cases Component ──────────────────────────────────────────────────

export default function Cases() {
  const [cases, setCases] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedCase, setSelectedCase] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [feedbackStats, setFeedbackStats] = useState(null)
  const [retraining, setRetraining] = useState(false)
  const [retrainResult, setRetrainResult] = useState(null)

  const fetchCases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      params.set('limit', '100')
      const res = await fetch(`${API_BASE}/cases?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCases(data.cases)
      setTotal(data.total)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { fetchCases() }, [fetchCases])

  // Fetch feedback stats
  useEffect(() => {
    fetch(`${API_BASE}/feedback/stats`)
      .then(r => r.ok ? r.json() : null)
      .then(setFeedbackStats)
      .catch(() => {})
  }, [])

  const handleRetrain = async () => {
    setRetraining(true)
    setRetrainResult(null)
    try {
      const res = await fetch(`${API_BASE}/feedback/retrain`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setRetrainResult(data)
      // Refresh stats
      const statsRes = await fetch(`${API_BASE}/feedback/stats`)
      if (statsRes.ok) setFeedbackStats(await statsRes.json())
    } catch (err) {
      setRetrainResult({ error: err.message })
    } finally {
      setRetraining(false)
    }
  }

  const handleUpdated = () => {
    fetchCases()
    if (selectedCase) {
      // Refresh the selected case
      fetch(`${API_BASE}/cases/${selectedCase.case_id}`)
        .then(r => r.json())
        .then(setSelectedCase)
        .catch(() => setSelectedCase(null))
    }
  }

  const statusCounts = cases.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">Investigation Cases</h2>
          <p className="text-[11px] text-slate-700">
            {total} case{total !== 1 ? 's' : ''} &middot; Track investigations, assign reviewers, mark resolutions
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-1.5 rounded-lg text-[11px] font-bold bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          + New Case
        </button>
      </div>

      {/* Active Learning / Feedback Dashboard */}
      {feedbackStats && feedbackStats.total > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">Active Learning Loop</h3>
              <p className="text-[11px] text-slate-700">
                Analyst feedback improves the XGBoost model with each label
              </p>
            </div>
            <button
              onClick={handleRetrain}
              disabled={retraining || feedbackStats.total < 2}
              title={feedbackStats.total < 2 ? 'Need at least 2 feedback labels to retrain' : 'Retrain model with analyst feedback'}
              className="px-4 py-1.5 rounded-lg text-[11px] font-bold bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {retraining ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Retraining…
                </span>
              ) : 'Retrain Model'}
            </button>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Total Labels</p>
              <p className="text-xl font-bold font-mono text-blue-400">{feedbackStats.total}</p>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">True Positives</p>
              <p className="text-xl font-bold font-mono text-red-400">{feedbackStats.true_positives}</p>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">False Positives</p>
              <p className="text-xl font-bold font-mono text-emerald-400">{feedbackStats.false_positives}</p>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">
              <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Model Precision</p>
              <p className="text-xl font-bold font-mono text-amber-400">
                {feedbackStats.precision != null ? `${(feedbackStats.precision * 100).toFixed(1)}%` : '—'}
              </p>
            </div>
          </div>

          {retrainResult && (
            <div className={`rounded-xl p-3 text-xs font-mono ${
              retrainResult.error
                ? 'bg-red-950/30 border border-red-900/50 text-red-400'
                : 'bg-emerald-950/30 border border-emerald-900/50 text-emerald-400'
            }`}>
              {retrainResult.error ? (
                <span>Retrain failed: {retrainResult.error}</span>
              ) : (
                <span>Model retrained · v{retrainResult.model_version} · {retrainResult.output?.match(/PR-AUC.*?([\d.]+)/)?.[1] ?? '—'} PR-AUC</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Status filter tabs */}
      <div className="flex items-center gap-1 bg-slate-900/60 rounded-lg p-0.5 border border-slate-800/50 w-fit">
        {[
          { key: '', label: 'All' },
          { key: 'open', label: 'Open' },
          { key: 'under_review', label: 'Under Review' },
          { key: 'escalated', label: 'Escalated' },
          { key: 'closed', label: 'Closed' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setStatusFilter(tab.key)}
            className={`px-3 py-1 rounded-md text-[10px] font-semibold transition-all ${
              statusFilter === tab.key
                ? 'bg-slate-800 text-slate-100 shadow-sm'
                : 'text-slate-600 hover:text-slate-400'
            }`}
          >
            {tab.label}
            {tab.key === '' && total > 0 && <span className="ml-1 text-slate-700">{total}</span>}
            {tab.key !== '' && statusCounts[tab.key] && (
              <span className="ml-1 text-slate-700">{statusCounts[tab.key]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-950/20 border border-red-900/40 rounded-xl p-4 flex gap-3">
          <span className="text-red-500 text-sm shrink-0">!</span>
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl h-20 animate-pulse" />
          ))}
        </div>
      )}

      {/* Cases list */}
      {!loading && cases.length === 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl px-6 py-14 text-center space-y-2">
          <p className="text-slate-500 font-medium">No cases found</p>
          <p className="text-xs text-slate-700 max-w-md mx-auto leading-relaxed">
            {statusFilter ? 'Try a different filter or ' : ''}Create a case from the Watchlist or Investigation tab to start tracking an account.
          </p>
        </div>
      )}

      {!loading && cases.length > 0 && (
        <div className="space-y-2">
          {cases.map(c => (
            <button
              key={c.case_id}
              onClick={() => setSelectedCase(c)}
              className="w-full text-left bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl px-5 py-3.5 transition-colors group"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-mono font-bold text-slate-400 shrink-0">{c.case_id}</span>
                  <StatusBadge status={c.status} />
                  {c.resolution && <ResolutionBadge resolution={c.resolution} />}
                </div>
                <div className="flex items-center gap-4 text-[10px] text-slate-600 shrink-0">
                  {c.risk_score != null && (
                    <span className={`font-mono font-bold ${c.risk_score >= 0.65 ? 'text-red-400' : c.risk_score >= 0.30 ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {c.risk_score.toFixed(3)}
                    </span>
                  )}
                  <span className="font-mono">{c.account_id}</span>
                  <span>{fmtDate(c.created_at)}</span>
                  <span className="text-slate-800 group-hover:text-slate-600 transition-colors">→</span>
                </div>
              </div>
              {c.query_text && (
                <p className="mt-1.5 text-[11px] text-slate-700 truncate max-w-2xl">{c.query_text}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Modals */}
      {showCreate && (
        <CreateCaseModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); fetchCases() }}
        />
      )}
      {selectedCase && (
        <CaseDetail
          caseData={selectedCase}
          onClose={() => setSelectedCase(null)}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  )
}
