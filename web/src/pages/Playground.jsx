import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Send, Sparkles, Square, User, Bot } from 'lucide-react';
import { useStore } from '../store.jsx';
import { streamChat } from '../api.js';
import { Btn, Card } from '../components/ui.jsx';

function TrailChips({ trail }) {
  if (!trail?.length) return null;
  return (
    <span className="font-mono text-[10.5px] text-amber-300/90 bg-amber-400/10 border border-amber-400/20 rounded-md px-2 py-0.5">
      {trail.join('  →  ')}
    </span>
  );
}

export default function Playground() {
  const { models, toast } = useStore();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState('auto');
  const [system, setSystem] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null);
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const opts = [...new Set((models || []).map((m) => m.id))].slice(0, 400);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  function stop() { abortRef.current?.abort(); }

  function patchLast(updater) {
    setMessages((m) => { const c = [...m]; c[c.length - 1] = updater(c[c.length - 1]); return c; });
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setBusy(true);
    setMeta(null);
    const history = system
      ? [{ role: 'system', content: system }, ...messages.filter((m) => m.role !== 'system'), { role: 'user', content: text }]
      : [...messages, { role: 'user', content: text }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await streamChat({
        model,
        messages: history,
        signal: ac.signal,
        onDelta: (t) => patchLast((m) => ({ ...m, content: t })),
      });
      patchLast((m) => ({ ...m, content: r.text || '(kosong)' }));
      setMeta(r);
    } catch (e) {
      if (e.name === 'AbortError') {
        setMessages((m) => (m[m.length - 1]?.content ? m : m.slice(0, -1)));
      } else {
        patchLast((m) => ({ ...m, content: '✕ ' + e.message, error: true }));
        toast(e.message, 'err');
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 items-stretch">
      {/* Side panel */}
      <div className="lg:w-80 shrink-0 space-y-4">
        <Card className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-mist-500 mb-1.5">Model</label>
            <input className="field field-mono" list="pg-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="auto" />
            <datalist id="pg-models">{opts.map((m) => <option key={m} value={m} />)}</datalist>
            <p className="text-[11px] text-mist-500/80 mt-1.5">auto = provider sehat terbaik · provider/model = pin</p>
          </div>
          <div>
            <label className="block text-xs text-mist-500 mb-1.5">System prompt (opsional)</label>
            <textarea className="field" rows={4} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="Kamu asisten yang membantu…" />
          </div>
          <Btn className="w-full" onClick={() => { setMessages([]); setMeta(null); }}>
            <Sparkles size={14} /> Chat baru
          </Btn>
        </Card>
      </div>

      {/* Chat */}
      <Card className="flex-1 flex flex-col p-4 min-h-[60vh]">
        <div className="flex-1 overflow-y-auto space-y-3 pr-1" style={{ maxHeight: '56vh' }}>
          {messages.length === 0 && (
            <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center gap-2 text-mist-500">
              <Bot size={28} className="text-brand-400/60" />
              <p className="text-sm">Kirim pesan pertamamu —</p>
              <p className="text-xs">saksikan fallback bekerja live ⚡</p>
            </div>
          )}
          {messages.filter((m) => m.role !== 'system').map((m, i) => (
            <div key={i} className={clsx('flex gap-2.5 max-w-[88%]', m.role === 'user' ? 'ml-auto flex-row-reverse' : '')}>
              <div className={clsx('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
                m.role === 'user' ? 'bg-white/[0.07] border border-white/10' : 'bg-gradient-to-br from-brand-500 to-brand-600 shadow-lg shadow-brand-500/25')}>
                {m.role === 'user' ? <User size={14} className="text-mist-400" /> : <Bot size={14} className="text-white" />}
              </div>
              <div className={clsx(
                'px-3.5 py-2.5 rounded-2xl text-[13.5px] leading-relaxed whitespace-pre-wrap break-words',
                m.role === 'user'
                  ? 'bg-gradient-to-br from-brand-500 to-brand-600 text-white rounded-tr-md'
                  : m.error ? 'bg-red-500/10 border border-red-500/25 text-red-200 rounded-tl-md'
                  : 'bg-white/[0.05] border border-white/[0.07] text-mist-300 rounded-tl-md'
              )}>
                {m.content || (busy && i === messages.length - 1 ? <span className="inline-block w-2 h-4 bg-brand-400 animate-[blink_1s_infinite] align-middle" /> : '…')}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div className="mt-3 flex gap-2 items-end">
          <textarea
            ref={inputRef}
            className="field flex-1 resize-none min-h-[64px] max-h-40"
            rows={2}
            value={input}
            placeholder="Tulis pesan… (Enter = kirim, Shift+Enter = baris baru)"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          {busy
            ? <Btn variant="danger" onClick={stop}><Square size={14} /> Stop</Btn>
            : <Btn variant="primary" onClick={send} disabled={!input.trim()}><Send size={14} /> Kirim</Btn>}
        </div>

        <div className="mt-2.5 min-h-[20px] text-xs text-mist-500 flex flex-wrap items-center gap-2">
          {meta && (
            <>
              <span className="text-emerald-400 font-medium">✓ {meta.provider}</span>
              <span className="font-mono">{meta.model}</span>
              <span>· {meta.ms}ms</span>
              {meta.trail?.length
                ? <TrailChips trail={meta.trail} />
                : <span className="text-mist-500/70">· first hit 🎯</span>}
            </>
          )}
          {busy && <span className="text-brand-400">⚡ menghubungi provider…</span>}
        </div>
      </Card>
    </div>
  );
}
