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
        <div className="absolute bottom-16 right-0 w-96 max-w-[calc(100vw-3rem)] h-[520px] bg-[#0b0f19]/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200">

          {/* Modal Header */}
          <div className="px-4 py-3.5 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-indigo-950 border border-indigo-700/60 flex items-center justify-center font-bold text-indigo-400 text-xs shadow-sm">
                🤖
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-100 flex items-center gap-2">
                  FinSherlock Copilot
                  <span className="px-1.5 py-0.5 rounded text-[8px] font-mono font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800">
                    Online
                  </span>
                </h3>
                <p className="text-[9px] text-slate-500">AI Compliance & Regulatory Assistant</p>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="w-6 h-6 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 flex items-center justify-center text-xs transition-colors"
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
                      ? 'bg-blue-600 text-white rounded-br-none'
                      : m.isError
                        ? 'bg-red-950/60 text-red-300 border border-red-900/60 rounded-bl-none'
                        : 'bg-slate-900 border border-slate-800/80 text-slate-200 rounded-bl-none shadow-sm'
                  }`}
                >
                  <p>{m.text}</p>
                </div>
                <div className="flex items-center gap-1.5 px-1 text-[9px] text-slate-600 font-mono">
                  <span>{m.ts}</span>
                  {m.source && <span className="text-indigo-400">· {m.source}</span>}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-[10px] text-slate-500 italic pl-1">
                <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
                Copilot is thinking…
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Quick Prompts */}
          <div className="px-3 py-2 bg-slate-950/40 border-t border-slate-800/60 overflow-x-auto flex gap-1.5 [scrollbar-width:none]">
            {QUICK_PROMPTS.map((p, i) => (
              <button
                key={i}
                onClick={() => send(p)}
                disabled={loading}
                className="shrink-0 px-2.5 py-1 rounded-lg border border-slate-800 bg-slate-900/80 hover:bg-slate-800 text-[9px] text-slate-400 hover:text-slate-200 font-mono transition-all disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>

          {/* Input Bar */}
          <div className="p-3 bg-slate-900/80 border-t border-slate-800 flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && send()}
              placeholder="Ask Copilot a compliance question…"
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-all font-mono"
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || loading}
              className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:bg-slate-800 text-white font-semibold text-xs transition-all shadow-md shrink-0 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Floating Toggle Button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="relative group flex items-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold rounded-full shadow-lg shadow-indigo-950/50 transition-all hover:scale-105"
      >
        <span className="text-base">🤖</span>
        <span className="text-xs tracking-tight font-semibold">Copilot</span>
        <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-500 rounded-full border-2 border-slate-950 animate-pulse" />
      </button>
    </div>
  )
}
