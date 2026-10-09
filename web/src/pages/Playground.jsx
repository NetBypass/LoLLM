import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Bot, Check, Gauge, Loader2, Send, Sparkles, Square, Target, User } from 'lucide-react';
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

function Meta({ m }) {
  if (!m) return null;
  const params = m.params && (m.params.adjusted?.length || m.params.ignored?.length) ? m.params : null;
  return (
    <div className="mt-2.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-mist-500">
        <span className="flex items-center gap-1 text-emerald-400 font-medium"><Check size={12} /> {m.provider}</span>
        <span className="font-mono text-mist-300">{m.model}</span>
        <span>· {m.ms}ms</span>
        {m.task && m.task !== 'chat' && (
          <span className="font-mono text-[10.5px] text-brand-300 bg-brand-400/10 border border-brand-400/20 rounded px-1.5 py-0.5"
            title={`task terdeteksi: ${m.task}`}>task: {m.task}</span>
        )}
        {m.selection && (
          <span className="font-mono text-[10.5px] text-mist-400" title={m.selectionReason}>
            {m.selection}{m.selectionReason ? ' · ' + m.selectionReason : ''}
          </span>
        )}
        {m.fallbacks > 0
          ? <span className="flex items-center gap-1 text-[10.5px] text-amber-300" title={`${m.attempts} percobaan sebelum sukses`}>
              <Gauge size={11} /> fallback ×{m.fallbacks}
            </span>
          : <span className="flex items-center gap-1 text-[10.5px] text-mist-500/70">first hit <Target size={11} /></span>}
        {m.trail?.length > 0 && <TrailChips trail={m.trail} />}
      </div>
      {(m.lowConfidence || m.emptyRetries > 0 || params) && (
        <div className="flex flex-wrap gap-1.5 text-[10.5px]">
          {m.lowConfidence && (
            <span className="flex items-center gap-1 text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded px-1.5 py-0.5">
              <AlertTriangle size={10} /> tak ada model di atas ambang kualitas — jawaban bisa di bawah harapan
            </span>
          )}
          {m.emptyRetries > 0 && (
            <span className="text-amber-300/90 bg-amber-400/10 border border-amber-400/20 rounded px-1.5 py-0.5">
              {m.emptyRetries}× jawaban kosong ditolak &amp; diulang
            </span>
          )}
          {params && (
            <span className="text-mist-400 bg-white/[0.04] border border-white/10 rounded px-1.5 py-0.5 font-mono" title={params.raw}>
              params: {[...(params.adjusted || []).map((x) => 'diubah ' + x.split(':')[0]), ...(params.ignored || []).map((x) => 'diabaikan ' + x)].join(', ')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function Playground() {
  const { models, toast } = useStore();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState('auto');
  const [system, setSystem] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');
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
    setErr('');
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
        params: { temperature: Number(temperature), max_tokens: Number(maxTokens) },
        onDelta: (t) => patchLast((m) => ({ ...m, content: t })),
      });
      patchLast((m) => ({ ...m, content: r.text || '(kosong)' }));
      setMeta(r);
      if (!r.text) toast('Jawaban kosong — gateway sudah mencoba ulang tapi model tetap tidak menghasilkan isi', 'err');
    } catch (e) {
      if (e.name === 'AbortError') {
        setMessages((m) => (m[m.length - 1]?.content ? m : m.slice(0, -1)));
      } else {
        patchLast((m) => ({ ...m, content: '✕ ' + e.message, error: true }));
        setErr(e.code ? `${e.message} (kode: ${e.code})` : e.message);
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
            <p className="text-[11px] text-mist-500/80 mt-1.5 leading-relaxed">
              <code className="font-mono text-neon-400">auto</code> = model berkualitas terbaik dari provider sehat (dipilih per task, lengket per percakapan) ·{' '}
              <code className="font-mono text-neon-400">groq/nama-model</code> = pin provider
            </p>
            {(!models || models.length === 0) && (
              <p className="text-[11px] text-amber-300/80 mt-1">Belum ada model live — daftar muncul otomatis setelah API key ditambahkan di tab Providers.</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-mist-500 mb-1.5">System prompt (opsional)</label>
            <textarea className="field" rows={4} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="Kamu asisten yang membantu…" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-mist-500 mb-1.5">temperature <span className="font-mono text-mist-400">{temperature}</span></label>
              <input type="range" min="0" max="2" step="0.05" value={temperature} onChange={(e) => setTemperature(e.target.value)} className="w-full accent-brand-500" />
            </div>
            <div>
              <label className="block text-xs text-mist-500 mb-1.5">max_tokens</label>
              <input type="number" min="1" step="64" className="field field-mono" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
            </div>
          </div>
          <p className="text-[10.5px] text-mist-500/80 leading-relaxed">
            Parameter diteruskan apa adanya ke provider; nilai di luar rentang akan di-clamp dan dilaporkan di bawah jawaban.
          </p>
          <Btn className="w-full" onClick={() => { setMessages([]); setMeta(null); setErr(''); }}>
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
              <p className="text-xs">saksikan fallback & pemilihan model bekerja live</p>
            </div>
          )}
          {messages.filter((m) => m.role !== 'system').map((m, i) => (
            <div key={i} className={clsx('flex gap-2.5 max-w-[88%]', m.role === 'user' ? 'ml-auto flex-row-reverse' : '')}>
              <div className={clsx('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
                m.role === 'user' ? 'bg-white/[0.07] border border-white/10' : 'bg-gradient-to-br from-brand-500 to-brand-600 shadow-lg shadow-brand-500/25')}>
                {m.role === 'user' ? <User size={14} className="text-mist-400" /> : <Bot size={14} className="text-white" />}
              </div>
              <div className={clsx(
                'px-3.5 py-2.5 rounded-2xl text-[13.5px] leading-relaxed whitespace-pre-wrap break-words animate-[pop_.22s_ease]',
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

        {err && (
          <div className="mt-2 text-[11.5px] text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">{err}</div>
        )}
        <div className="mt-2.5 min-h-[20px]">
          {busy && <span className="flex items-center gap-1.5 text-xs text-brand-400"><Loader2 size={12} className="animate-spin" /> menghubungi provider…</span>}
          {!busy && <Meta m={meta} />}
        </div>
      </Card>
    </div>
  );
}
