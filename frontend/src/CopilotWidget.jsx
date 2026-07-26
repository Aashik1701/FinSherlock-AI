import { useState, useRef, useEffect } from 'react'

const QUICK_PROMPTS = [
  "What is the BSA CTR Structuring rule?",
  "What is the FinCEN SAR filing deadline?",
  "How does Louvain Mule Ring detection work?",
  "How does Two-Brain Architecture prevent hallucinations?",
]

export default function CopilotWidget() {
  const [open,     setOpen]     = useState(false)
  const [messages, setMessages] = useState([
    {
      sender: 'bot',
      text: 'Hello! I am your AI Compliance Copilot. Ask me about BSA/FinCEN regulations, SAR deadlines, typology math, or platform architecture.',
      ts: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    },
  ])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const chatEndRef = useRef(null)

  useEffect(() => {
    if (open) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const send = async (msgText) => {
    const text = (msgText ?? input).trim()
    if (!text || loading) return

    const userMsg = {
      sender: 'user',
      text,
      ts: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('http://localhost:8000/copilot', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      const botMsg = {
        sender: 'bot',
        text: data.answer ?? 'Sorry, I could not process that query.',
        source: data.source,
        ts: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      }
      setMessages(prev => [...prev, botMsg])
    } catch (e) {
      setMessages(prev => [
        ...prev,
        {
          sender: 'bot',
          text: 'Backend copilot endpoint unavailable. Ensure uvicorn server is running on localhost:8000.',
          ts: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          isError: true,
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-50">

      {/* Floating Modal Window */}
      {open && (
        <div className="absolute bottom-16 right-0 w-96 max-w-[calc(100vw-3rem)] h-[520px] bg-[var(--bg-card)]/95 backdrop-blur-xl border border-[var(--border-card)] rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200">

          {/* Modal Header */}
          <div className="px-4 py-3.5 bg-[var(--bg-card-hover)]/80 border-b border-[var(--border-card)] flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-[var(--indigo-bg)] border border-[var(--indigo-border)]/60 flex items-center justify-center font-bold text-[var(--indigo)] text-xs shadow-sm">
                🤖
              </div>
              <div>
                <h3 className="text-xs font-bold text-[var(--text-primary)] flex items-center gap-2">
                  FinSherlock Copilot
                  <span className="px-1.5 py-0.5 rounded text-[8px] font-mono font-semibold bg-[var(--emerald-bg)] text-[var(--emerald)] border border-[var(--emerald-border)]">
                    Online
                  </span>
                </h3>
                <p className="text-[9px] text-[var(--text-muted)]">AI Compliance & Regulatory Assistant</p>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="w-6 h-6 rounded-md hover:bg-[var(--border-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center text-xs transition-colors"
            >
              ✕
            </button>
          </div>

          {/* Chat Messages Body */}
          <div className="flex-1 p-4 space-y-3.5 overflow-y-auto font-sans text-xs">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex flex-col space-y-1 ${
                  m.sender === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3.5 py-2.5 leading-relaxed ${
                    m.sender === 'user'
                      ? 'bg-[var(--indigo)] text-white rounded-br-none'
                      : m.isError
                        ? 'bg-[var(--red-bg)]/60 text-[var(--red)] border border-[var(--red-border)]/60 rounded-bl-none'
                        : 'bg-[var(--bg-card)] border border-[var(--border-card)]/80 text-[var(--text-primary)] rounded-bl-none shadow-sm'
                  }`}
                >
                  <p>{m.text}</p>
                </div>
                <div className="flex items-center gap-1.5 px-1 text-[9px] text-[var(--text-secondary)] font-mono">
                  <span>{m.ts}</span>
                  {m.source && <span className="text-[var(--indigo)]">· {m.source}</span>}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] italic pl-1">
                <span className="w-2 h-2 rounded-full bg-[var(--indigo)] animate-ping" />
                Copilot is thinking…
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Quick Prompts */}
          <div className="px-3 py-2 bg-[var(--bg-card-hover)]/40 border-t border-[var(--border-card)]/60 overflow-x-auto flex gap-1.5 [scrollbar-width:none]">
            {QUICK_PROMPTS.map((p, i) => (
              <button
                key={i}
                onClick={() => send(p)}
                disabled={loading}
                className="shrink-0 px-2.5 py-1 rounded-lg border border-[var(--border-card)] bg-[var(--bg-card-hover)]/80 hover:bg-[var(--border-card)] text-[9px] text-[var(--text-muted)] hover:text-[var(--text-primary)] font-mono transition-all disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>

          {/* Input Bar */}
          <div className="p-3 bg-[var(--bg-card-hover)]/80 border-t border-[var(--border-card)] flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && send()}
              placeholder="Ask Copilot a compliance question…"
              className="flex-1 bg-[var(--bg-card-hover)] border border-[var(--border-card)] rounded-xl px-3 py-2 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--indigo)] transition-all font-mono"
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || loading}
              className="px-3.5 py-2 rounded-xl bg-[var(--indigo)] hover:bg-[var(--indigo-hover)] active:bg-[var(--indigo)]/90 disabled:bg-[var(--border-card)] text-white font-semibold text-xs transition-all shadow-md shrink-0 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Floating Toggle Button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="relative group w-14 h-14 rounded-2xl transition-all duration-200 hover:scale-110 active:scale-95 focus:outline-none"
        style={{
          background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
          boxShadow: open
            ? '0 0 0 3px rgba(99,102,241,0.4), 0 8px 24px rgba(79,70,229,0.5)'
            : '0 4px 20px rgba(79,70,229,0.45), 0 2px 8px rgba(0,0,0,0.3)',
        }}
        aria-label="Open Compliance Copilot"
      >
        {/* Animated ring */}
        <span className="absolute inset-0 rounded-2xl animate-ping opacity-20"
          style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', animationDuration: '2.5s' }} />

        {/* Icon — morphs between sparkle (closed) and X (open) */}
        <span className="relative flex items-center justify-center w-full h-full">
          {open ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" strokeOpacity="0.3" />
              <path d="M8 12h.01M12 12h.01M16 12h.01" strokeWidth="2.5" />
            </svg>
          )}
        </span>

        {/* Online dot */}
        {!open && (
          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-white"
            style={{ background: '#10b981', boxShadow: '0 0 6px rgba(16,185,129,0.8)' }} />
        )}

        {/* Tooltip label */}
        <span className="absolute right-full mr-3 top-1/2 -translate-y-1/2 whitespace-nowrap
          px-2.5 py-1 rounded-lg text-[11px] font-semibold text-white pointer-events-none
          opacity-0 group-hover:opacity-100 translate-x-1 group-hover:translate-x-0
          transition-all duration-150"
          style={{ background: 'rgba(15,15,30,0.9)', backdropFilter: 'blur(8px)', border: '1px solid rgba(99,102,241,0.3)' }}>
          AI Copilot
        </span>
      </button>
    </div>
  )
}
