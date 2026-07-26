import { useState, useEffect, useCallback } from 'react'
import { API_BASE } from './api'

const COLUMNS = [
  { key: 'open', label: 'Open', color: 'bg-blue-500', lightBg: 'bg-blue-50/50' },
  { key: 'under_review', label: 'Under Review', color: 'bg-amber-500', lightBg: 'bg-amber-50/50' },
  { key: 'escalated', label: 'Escalated', color: 'bg-red-500', lightBg: 'bg-red-50/50' },
  { key: 'closed', label: 'Closed', color: 'bg-gray-500', lightBg: 'bg-gray-50/50' },
]

const STATUS_STYLES = {
  open:         'bg-blue-50 text-blue-700 border-blue-200',
  under_review: 'bg-amber-50 text-amber-700 border-amber-200',
  escalated:    'bg-red-50 text-red-700 border-red-200',
  closed:       'bg-gray-100 text-gray-500 border-gray-200',
}

const RESOLUTION_STYLES = {
  true_positive:  'bg-red-50 text-red-600 border-red-200',
  false_positive: 'bg-emerald-50 text-emerald-600 border-emerald-200',
}

const VALID_TRANSITIONS = {
  open:         ['under_review', 'closed'],
  under_review: ['escalated', 'closed'],
  escalated:    ['closed'],
  closed:       [],
}

const fmtDate = str => {
  if (!str) return '—'
  try { return new Date(String(str).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  catch { return str }
}

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.open
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold border ${s}`}>{status.replace('_', ' ')}</span>
}

function CaseCard({ c, onClick }) {
  return (
    <button
      onClick={() => onClick(c)}
      className="w-full text-left bg-[var(--bg-card)] border border-[var(--border-card)] hover:border-orange-300 rounded-lg px-3 py-2.5 transition-all shadow-sm space-y-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono font-bold text-[var(--text-secondary)] truncate">{c.case_id}</span>
        <StatusBadge status={c.status} />
      </div>
      <p className="text-[11px] font-mono font-semibold text-[var(--text-primary)] truncate">{c.account_id}</p>
      <div className="flex items-center justify-between text-[9px] text-[var(--text-muted)]">
        <span>{c.assigned_to || 'unassigned'}</span>
        <span>{fmtDate(c.created_at)}</span>
      </div>
      {c.resolution && (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-bold border ${RESOLUTION_STYLES[c.resolution]}`}>
          {c.resolution === 'true_positive' ? 'TP' : 'FP'}
        </span>
      )}
    </button>
  )
}

function CreateCaseModal({ onClose, onCreated }) {
  const [accountId, setAccountId] = useState('')
  const [queryText, setQueryText] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!accountId.trim()) return
    setSubmitting(true); setError(null)
    try {
      const res = await fetch(`${API_BASE}/cases`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId.trim(), query_text: queryText.trim(), notes: notes.trim() }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onCreated()
    } catch (err) { setError(err.message) }
    finally { setSubmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-[var(--bg-card)] border border-[var(--border-card)] rounded-xl w-full max-w-md mx-3 p-5 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[var(--text-primary)]">New Case</h3>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider mb-1">Account ID *</label>
            <input value={accountId} onChange={e => setAccountId(e.target.value)} className="w-full border border-[var(--border-card)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" placeholder="e.g. ACC_A" required />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider mb-1">Query / Context</label>
            <input value={queryText} onChange={e => setQueryText(e.target.value)} className="w-full border border-[var(--border-card)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" placeholder="What triggered this case?" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider mb-1">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="w-full border border-[var(--border-card)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 resize-none" />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
            <button type="submit" disabled={submitting || !accountId.trim()} className="px-4 py-1.5 rounded-lg text-xs font-bold bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40">{submitting ? 'Creating…' : 'Create Case'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function CaseDetailModal({ caseData, onClose, onUpdated }) {
  const [notes, setNotes] = useState(caseData.notes || '')
  const [updating, setUpdating] = useState(false)
  const [actionError, setActionError] = useState(null)

  const _patch = async (body) => {
    const res = await fetch(`${API_BASE}/cases/${caseData.case_id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
    return res
  }

  const transitionTo = async (newStatus) => {
    setUpdating(true); setActionError(null)
    try { await _patch({ status: newStatus }); onUpdated() }
    catch (err) { setActionError(err.message) }
    finally { setUpdating(false) }
  }

  const markResolution = async (resolution) => {
    setUpdating(true); setActionError(null)
    try { await _patch({ resolution }); onUpdated() }
    catch (err) { setActionError(err.message) }
    finally { setUpdating(false) }
  }

  const saveNotes = async () => {
    setUpdating(true); setActionError(null)
    try { await _patch({ notes }); onUpdated() }
    catch (err) { setActionError(err.message) }
    finally { setUpdating(false) }
  }

  const transitions = VALID_TRANSITIONS[caseData.status] || []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-[var(--bg-card)] border border-[var(--border-card)] rounded-xl w-full max-w-lg mx-3 p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-[var(--text-primary)] font-mono">{caseData.case_id}</h3>
              <StatusBadge status={caseData.status} />
              {caseData.resolution && <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${RESOLUTION_STYLES[caseData.resolution]}`}>{caseData.resolution === 'true_positive' ? 'True Positive' : 'False Positive'}</span>}
            </div>
            <p className="text-xs text-[var(--text-secondary)]">Account <span className="font-mono text-[var(--text-primary)]">{caseData.account_id}</span> · Created {fmtDate(caseData.created_at)}</p>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">&times;</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-[var(--bg-card-hover)] rounded-lg px-3 py-2 border border-[var(--border-card)]">
            <p className="text-[9px] font-bold text-[var(--text-secondary)] uppercase tracking-widest">Risk Score</p>
            <p className={`text-lg font-bold font-mono ${caseData.risk_score != null && caseData.risk_score >= 0.65 ? 'text-red-600' : caseData.risk_score >= 0.30 ? 'text-amber-600' : 'text-emerald-600'}`}>{caseData.risk_score != null ? caseData.risk_score.toFixed(3) : '—'}</p>
          </div>
          <div className="bg-[var(--bg-card-hover)] rounded-lg px-3 py-2 border border-[var(--border-card)]">
            <p className="text-[9px] font-bold text-[var(--text-secondary)] uppercase tracking-widest">Assigned To</p>
            <p className="text-sm font-semibold text-[var(--text-primary)]">{caseData.assigned_to || '—'}</p>
          </div>
        </div>

        {caseData.query_text && (
          <div className="bg-[var(--bg-card-hover)] rounded-lg px-4 py-3 border border-[var(--border-card)]">
            <p className="text-[9px] font-bold text-[var(--text-secondary)] uppercase tracking-widest mb-1">Query</p>
            <p className="text-xs text-[var(--text-secondary)] font-mono">{caseData.query_text}</p>
          </div>
        )}

        <div>
          <label className="block text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest mb-1">Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4} className="w-full border border-[var(--border-card)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 resize-none" placeholder="Add findings, rationale, or next steps…" />
          <button onClick={saveNotes} disabled={updating || notes === (caseData.notes || '')} className="mt-1.5 px-3 py-1 rounded text-[10px] font-semibold bg-[var(--border-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors">Save Notes</button>
        </div>

        {actionError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{actionError}</p>}

        <div className="border-t border-[var(--border-card)] pt-4 space-y-3">
          {transitions.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-[var(--text-secondary)] uppercase tracking-widest mb-2">Advance</p>
              <div className="flex flex-wrap gap-2">
                {transitions.map(s => (
                  <button key={s} onClick={() => transitionTo(s)} disabled={updating}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${
                      s === 'escalated' ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100' :
                      s === 'under_review' ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100' :
                      'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                    }`}>
                    {s === 'under_review' ? '→ Under Review' : s === 'escalated' ? '→ Escalate' : '→ Close'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!caseData.resolution && caseData.status === 'closed' && (
            <div>
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-2">Resolution</p>
              <div className="flex gap-2">
                <button onClick={() => markResolution('true_positive')} disabled={updating} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100">True Positive</button>
                <button onClick={() => markResolution('false_positive')} disabled={updating} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">False Positive</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Cases() {
  const [cases, setCases] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedCase, setSelectedCase] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [feedbackStats, setFeedbackStats] = useState(null)
  const [retraining, setRetraining] = useState(false)
  const [retrainResult, setRetrainResult] = useState(null)

  const fetchCases = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${API_BASE}/cases?limit=200`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setCases(data.cases); setTotal(data.total)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchCases() }, [fetchCases])

  useEffect(() => {
    fetch(`${API_BASE}/feedback/stats`).then(r => r.ok ? r.json() : null).then(setFeedbackStats).catch(() => {})
  }, [])

  const handleRetrain = async () => {
    setRetraining(true); setRetrainResult(null)
    try {
      const res = await fetch(`${API_BASE}/feedback/retrain`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setRetrainResult(data)
      const statsRes = await fetch(`${API_BASE}/feedback/stats`)
      if (statsRes.ok) setFeedbackStats(await statsRes.json())
    } catch (err) { setRetrainResult({ error: err.message }) }
    finally { setRetraining(false) }
  }

  const handleUpdated = () => {
    fetchCases()
    if (selectedCase) {
      fetch(`${API_BASE}/cases/${selectedCase.case_id}`).then(r => r.json()).then(setSelectedCase).catch(() => setSelectedCase(null))
    }
  }

  const grouped = COLUMNS.map(col => ({
    ...col,
    items: cases.filter(c => c.status === col.key),
  }))

  const statusCounts = cases.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc }, {})

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">Investigation Cases</p>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">{total} case{total !== 1 ? 's' : ''} · Track investigations, assign reviewers, mark resolutions</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-4 py-1.5 rounded-lg text-[11px] font-bold bg-orange-500 text-white hover:bg-orange-600 transition-all">+ New Case</button>
      </div>

      {/* Active Learning strip */}
      {feedbackStats && feedbackStats.total > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">Active Learning Loop</p>
            <button onClick={handleRetrain} disabled={retraining || feedbackStats.total < 2}
              className="px-3 py-1 rounded-lg text-[10px] font-bold bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 transition-all">
              {retraining ? 'Retraining…' : 'Retrain Model'}
            </button>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div><p className="text-[9px] text-indigo-500 font-bold uppercase">Labels</p><p className="text-lg font-bold font-mono text-indigo-900">{feedbackStats.total}</p></div>
            <div><p className="text-[9px] text-indigo-500 font-bold uppercase">TP</p><p className="text-lg font-bold font-mono text-red-600">{feedbackStats.true_positives}</p></div>
            <div><p className="text-[9px] text-indigo-500 font-bold uppercase">FP</p><p className="text-lg font-bold font-mono text-emerald-600">{feedbackStats.false_positives}</p></div>
            <div><p className="text-[9px] text-indigo-500 font-bold uppercase">Precision</p><p className="text-lg font-bold font-mono text-amber-600">{feedbackStats.precision != null ? `${(feedbackStats.precision * 100).toFixed(1)}%` : '—'}</p></div>
          </div>
          {retrainResult && (
            <div className={`rounded-lg p-2.5 text-xs font-mono ${retrainResult.error ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-emerald-50 text-emerald-600 border border-emerald-200'}`}>
              {retrainResult.error ? `Failed: ${retrainResult.error}` : `Model retrained · v${retrainResult.model_version}`}
            </div>
          )}
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-600">{error}</div>}

      {loading && (
        <div className="grid grid-cols-4 gap-4">
          {COLUMNS.map(col => <div key={col.key} className="card h-48 animate-pulse" />)}
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 overflow-x-auto">
          {grouped.map(col => (
            <div key={col.key} className="space-y-3">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${col.color}`} />
                <p className="text-xs font-bold text-[var(--text-primary)]">{col.label}</p>
                <span className="text-xs font-mono text-[var(--text-muted)] px-1.5 py-0.5 rounded bg-[var(--bg-card-hover)] border border-[var(--border-card)]">{col.items.length}</span>
              </div>
              <div className="space-y-2 min-h-[200px]">
                {col.items.map(c => <CaseCard key={c.case_id} c={c} onClick={setSelectedCase} />)}
                {col.items.length === 0 && (
                  <div className="text-center py-8">
                    <p className="text-xs text-[var(--text-muted)]">No cases</p>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && <CreateCaseModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); fetchCases() }} />}
      {selectedCase && <CaseDetailModal caseData={selectedCase} onClose={() => setSelectedCase(null)} onUpdated={handleUpdated} />}
    </div>
  )
}
