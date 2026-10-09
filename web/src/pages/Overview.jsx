import { Activity, ArrowLeftRight, Coins, Gauge, KeyRound, Terminal, Zap, ShieldCheck } from 'lucide-react';
import { useStore } from '../store.jsx';
import { fmtMs, fmtNum } from '../api.js';
import { Card, CopyBtn, Dot, KeyCounts, SectionTitle, Sparkline, TierBadge, useCountUp } from '../components/ui.jsx';

function Stat({ icon: Icon, label, value, sub, spark, countTo, fmt }) {
  const n = useCountUp(typeof countTo === 'number' ? countTo : 0);
  return (
    <Card className="p-4 overflow-hidden relative transition-all duration-300 hover:-translate-y-0.5 hover:border-white/[0.14]">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[22px] font-bold text-white font-mono leading-tight">{countTo != null ? (fmt ? fmt(n) : n) : value}</div>
          <div className="text-[11px] text-mist-500 mt-1">{label}</div>
        </div>
        <div className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/[0.06] flex items-center justify-center">
          <Icon size={15} className="text-brand-400" />
        </div>
      </div>
      <div className="text-[11px] text-mist-500 mt-2">{sub}</div>
      {spark && spark.length > 1 && <Sparkline values={spark} className="absolute bottom-0 left-0 right-0 h-8 w-full opacity-40" />}
    </Card>
  );
}

export default function Overview() {
  const { boot, status, logs } = useStore();
  const st = status?.stats || {};
  const health = status?.health || [];
  const okRate = st.requests ? Math.round((st.ok / st.requests) * 100) : 100;
  const avg = st.ok ? st.totalMs / st.ok : 0;
  const spark = logs.filter((l) => l.status === 200 && l.ms).slice(0, 24).reverse().map((l) => l.ms);
  const gwKey = (boot?.gatewayKeys || [])[0] || '-';
  const origin = (typeof location !== 'undefined' && location.origin) || 'http://localhost:5151';
  const base = `${origin}/v1`;
  const curl = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${gwKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"halo!"}]}'`;

  const stats = [
    { icon: Activity, label: 'Requests', value: fmtNum(st.requests), countTo: st.requests, fmt: fmtNum, sub: `${fmtNum(st.ok)} sukses · ${fmtNum(st.fail)} gagal`, spark },
    { icon: Gauge, label: 'Tingkat sukses', value: okRate + '%', countTo: okRate, fmt: (v) => v + '%', sub: 'fallback tak terasa' },
    { icon: Gauge, label: 'Latensi rata²', value: fmtMs(avg), sub: st.firstTokenSamples ? `stream pertama ${fmtMs(st.firstTokenMs / st.firstTokenSamples)}` : 'first hit per request' },
    { icon: ArrowLeftRight, label: 'Perpindahan fallback', value: fmtNum(st.fallbacks), countTo: st.fallbacks, fmt: fmtNum, sub: `${fmtNum(st.emptyRejected || 0)} jawaban kosong ditolak · ${fmtNum(st.rateLimited || 0)} dibatasi` },
    { icon: Coins, label: 'Token', value: fmtNum(st.tokensIn) + '→' + fmtNum(st.tokensOut), sub: 'masuk → keluar' },
    { icon: KeyRound, label: 'Key sehat', value: health.reduce((a, p) => a + (p.keys?.ok || 0), 0), countTo: health.reduce((a, p) => a + (p.keys?.ok || 0), 0), fmt: (v) => v, sub: `${health.filter((p) => p.state === 'up').length} provider aktif` },
  ];

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Gateway <span className="gtext">siap tempur</span>
          </h1>
          <p className="text-sm text-mist-500 mt-1">Satu port untuk semua model — pool key, fallback kilat, provider gratis.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-mist-500">
          <ShieldCheck size={14} className="text-emerald-400" />
          {st.requests ? `${fmtNum(st.requests)} request dilayani` : 'menunggu request pertama'}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {stats.map((s) => <Stat key={s.label} {...s} />)}
      </div>

      {/* Provider health */}
      <section>
        <SectionTitle icon={Zap} hint={`${health.length} provider terdaftar`}>Kesehatan provider</SectionTitle>
        {health.length === 0 ? (
          <Card className="p-6 text-center text-sm text-mist-500">
            Belum ada provider dengan key — buka tab <b className="text-mist-300">Providers</b> dan tempel API key gratis.
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {health.map((p) => {
              const k = p.keys || { ok: 0, cooling: 0, dead: 0, disabled: 0 };
              return (
                <Card key={p.id} className="p-4 hover:border-white/[0.14] transition-colors">
                  <div className="flex items-center gap-2.5">
                    <Dot state={p.state} />
                    <span className="font-semibold text-white text-sm">{p.name}</span>
                    <TierBadge tier={p.tier} />
                    <span className="ml-auto text-[10px] font-mono text-mist-500 uppercase">{p.state}</span>
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-[11px] text-mist-500">
                    <KeyCounts k={k} />
                    <span className="ml-auto truncate max-w-[45%] font-mono text-mist-500/70">{p.baseUrl?.replace(/^https?:\/\//, '')}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Quickstart */}
      <section>
        <SectionTitle icon={Terminal} hint="pakai seperti OpenAI SDK">Quickstart</SectionTitle>
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="text-xs text-mist-500">Gateway key:</span>
            <code className="text-xs font-mono bg-ink-800 border border-white/[0.08] rounded-lg px-3 py-1.5 text-mist-300 select-all">{gwKey}</code>
            <CopyBtn text={gwKey} label="Salin" />
          </div>
          <div className="relative">
            <pre className="text-[12px] font-mono leading-relaxed bg-ink-950/80 border border-white/[0.07] rounded-xl p-4 overflow-x-auto text-emerald-200/90">{curl}</pre>
            <div className="absolute top-2.5 right-2.5"><CopyBtn text={curl} /></div>
          </div>
          <p className="text-xs text-mist-500 mt-3 leading-relaxed">
            <code className="font-mono text-neon-400">auto</code> menilai semua model live (skor kualitas + task) lalu menguncinya per percakapan ·{' '}
            <code className="font-mono text-neon-400">groq/llama-3.3-70b-versatile</code> mem-pin provider ·{' '}
            header <code className="font-mono text-neon-400">x-lollm-model</code> / <code className="font-mono text-neon-400">x-lollm-fallbacks</code> /{' '}
            <code className="font-mono text-neon-400">x-lollm-trail</code> dan field <code className="font-mono text-neon-400">x_lollm</code> menjelaskan apa yang terjadi.
          </p>
        </Card>
      </section>
    </div>
  );
}
