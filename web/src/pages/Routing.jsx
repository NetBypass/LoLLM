import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowDown, ArrowUp, Ban, Download, Gauge, Layers, MessageSquareWarning, Route as RouteIcon,
  Save, ShieldCheck, Sparkles, Timer, Upload, Webhook,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Btn, Card, Empty, SectionTitle, Toggle } from '../components/ui.jsx';

const STRATEGIES = [
  { id: 'failover', title: 'Failover', desc: 'Urutan prioritas; key & provider berikutnya dicoba instan saat gagal.' },
  { id: 'round-robin', title: 'Round-robin', desc: 'Sebar beban merata ke semua kandidat sehat.' },
  { id: 'free-first', title: 'Free-first', desc: 'Provider gratis didahulukan, berbayar hanya cadangan.' },
];

const TIMEOUTS = [
  ['connectMs', 'Connect', 'fetch → headers'],
  ['firstByteMs', 'First byte', 'headers → chunk pertama (stream)'],
  ['totalMs', 'Total', 'non-stream keseluruhan'],
  ['streamIdleMs', 'Stream idle', 'jeda maks antar chunk'],
];

const TASKS = ['chat', 'coding', 'reasoning', 'translation', 'id-chat', 'structured', 'summarize'];

function Num({ label, hint, value, onChange, min, max, step, className }) {
  return (
    <div className={className}>
      <label className="block text-xs text-mist-400 mb-1.5">{label}</label>
      <input type="number" className="field field-mono" value={value ?? ''} min={min} max={max} step={step}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      {hint && <p className="text-[10.5px] text-mist-500/80 mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

function Switch({ label, desc, checked, onChange }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <Toggle checked={checked} onChange={onChange} />
      <span className="text-xs text-mist-400 leading-relaxed">
        <b className="text-mist-300 block mb-0.5">{label}</b>{desc}
      </span>
    </label>
  );
}

function ScoreBar({ score }) {
  const color = score >= 85 ? 'from-emerald-400 to-emerald-500' : score >= 70 ? 'from-brand-400 to-brand-500' : score >= 55 ? 'from-amber-400 to-amber-500' : 'from-red-400 to-red-500';
  return (
    <span className="inline-flex items-center gap-1.5 w-24 shrink-0" title={`skor kualitas ${score}/100`}>
      <span className="font-mono text-[11px] text-mist-300 w-6 text-right">{score}</span>
      <span className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <span className={clsx('block h-full rounded-full bg-gradient-to-r', color)} style={{ width: `${Math.max(4, Math.min(100, score))}%` }} />
      </span>
    </span>
  );
}

export default function Routing() {
  const { boot, status, toast, reload } = useStore();
  const s = boot?.settings;
  const health = status?.health || [];

  const [strategy, setStrategy] = useState('failover');
  const [timeouts, setTimeouts] = useState({});
  const [maxAttempts, setMaxAttempts] = useState(6);
  const [authRequired, setAuthRequired] = useState(true);
  const [allowAny, setAllowAny] = useState(true);
  const [order, setOrder] = useState(null);
  const [routing, setRouting] = useState({});
  const [content, setContent] = useState({});
  const [context, setContext] = useState({});
  const [rateLimit, setRateLimit] = useState({});
  const [warmup, setWarmup] = useState({});
  const [blocklistText, setBlocklistText] = useState('');
  const [previewTask, setPreviewTask] = useState('chat');
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const touch = (fn) => (v) => { fn(v); setDirty(true); };
  const patch = (setter) => (key, val) => setter((prev) => ({ ...prev, [key]: val }));

  useEffect(() => {
    if (!s) return;
    setStrategy(s.strategy);
    setTimeouts({ ...s.timeouts });
    setMaxAttempts(s.maxAttempts);
    setAuthRequired(s.authRequired);
    setAllowAny(s.allowAnyFallback);
    setRouting({ autoCandidates: 4, minQualityScore: 45, allowLowQuality: true, stickyAuto: true, blocklist: [], ...(s.routing || {}) });
    setContent({ rejectEmpty: true, emptyRetries: 1, ...(s.content || {}) });
    setContext({ enabled: true, maxChars: 60000, minRecentTurns: 4, ...(s.context || {}) });
    setRateLimit({ enabled: true, requestsPerMinute: 600, burst: 60, maxConcurrent: 32, ...(s.rateLimit || {}) });
    setWarmup({ enabled: true, intervalMs: 240000, ...(s.warmup || {}) });
    setBlocklistText((s.routing?.blocklist || []).join('\n'));
    setOrder(null);
    setDirty(false);
  }, [s]);

  async function loadPreview(task = previewTask) {
    setPreviewBusy(true);
    try { setPreview(await api('routing/auto?task=' + encodeURIComponent(task) + '&limit=12')); }
    catch (e) { setPreview(null); toast('Preview gagal: ' + e.message, 'err'); }
    setPreviewBusy(false);
  }
  useEffect(() => { if (s && !preview && !previewBusy) loadPreview(); }, [s]); // eslint-disable-line

  if (!s) return <Card className="p-8 text-center text-sm text-mist-500">Memuat pengaturan…</Card>;

  const currentOrder = order ?? [...new Set([...(s.providerOrder || []), ...health.map((h) => h.id)])];

  function move(id, dir) {
    const arr = [...currentOrder];
    const i = arr.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setOrder(arr);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      await api('settings', {
        method: 'PUT',
        body: {
          strategy,
          timeouts,
          maxAttempts: Number(maxAttempts),
          authRequired,
          allowAnyFallback: allowAny,
          providerOrder: currentOrder,
          routing: {
            ...routing,
            autoCandidates: Number(routing.autoCandidates) || 4,
            minQualityScore: Number(routing.minQualityScore) || 0,
            blocklist: blocklistText.split('\n').map((x) => x.trim()).filter(Boolean),
          },
          content: { rejectEmpty: content.rejectEmpty !== false, emptyRetries: Number(content.emptyRetries) || 0 },
          context: { enabled: context.enabled !== false, maxChars: Number(context.maxChars) || 60000, minRecentTurns: Number(context.minRecentTurns) || 4 },
          rateLimit: {
            enabled: rateLimit.enabled !== false,
            requestsPerMinute: Number(rateLimit.requestsPerMinute) || 600,
            burst: Number(rateLimit.burst) || 60,
            maxConcurrent: Number(rateLimit.maxConcurrent) || 32,
          },
          warmup: { enabled: warmup.enabled !== false, intervalMs: Number(warmup.intervalMs) || 240000 },
        },
      });
      toast('Pengaturan tersimpan ✓', 'okk');
      setDirty(false);
      await reload();
      loadPreview();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  }

  async function exportCfg() {
    try {
      const c = await api('config/export');
      const blob = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lollm-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Config di-export ✓', 'okk');
    } catch (e) { toast(e.message, 'err'); }
  }

  function importCfg(file, ev) {
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
      try {
        const cfg = JSON.parse(r.result);
        await api('config/import', { method: 'POST', body: { config: cfg } });
        toast('Config di-import ✓', 'okk');
        await reload();
      } catch (e) { toast('Import gagal: ' + e.message, 'err'); }
    };
    r.readAsText(file);
    if (ev) ev.target.value = '';
  }

  async function warmNow() {
    setPreviewBusy(true);
    try {
      const r = await api('routing/warmup', { method: 'POST' });
      toast(`Warm-up selesai — ${r.providers} provider, ${r.models} model siap`, 'okk');
      await Promise.all([reload(), loadPreview()]);
    } catch (e) { toast(e.message, 'err'); }
    setPreviewBusy(false);
  }

  const stats = status?.stats || {};

  return (
    <div className="space-y-8">
      {/* Sticky save bar */}
      <div className={clsx(
        'sticky top-16 lg:top-4 z-20 flex items-center gap-3 px-4 py-3 rounded-2xl border backdrop-blur-xl transition-all',
        dirty ? 'bg-brand-500/10 border-brand-400/30' : 'bg-ink-850/70 border-white/[0.06]'
      )}>
        <RouteIcon size={15} className={clsx(dirty ? 'text-brand-400' : 'text-mist-500')} />
        <span className="text-xs text-mist-400">{dirty ? 'Ada perubahan belum disimpan' : 'Pengaturan routing'}</span>
        <div className="ml-auto flex gap-2">
          {dirty && <Btn size="sm" variant="ghost" onClick={() => { setOrder(null); setDirty(false); }}>Batal</Btn>}
          <Btn size="sm" variant="primary" onClick={save} disabled={saving || !dirty}><Save size={13} /> Simpan</Btn>
        </div>
      </div>

      <section>
        <SectionTitle icon={RouteIcon}>Strategi routing</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {STRATEGIES.map((st) => (
            <button key={st.id} onClick={() => { setStrategy(st.id); setDirty(true); }}
              className={clsx('text-left rounded-2xl border p-4 transition-all cursor-pointer',
                strategy === st.id ? 'bg-brand-500/10 border-brand-400/40 shadow-lg shadow-brand-500/10' : 'bg-white/[0.03] border-white/[0.07] hover:border-white/20')}>
              <div className="flex items-center gap-2.5">
                <span className={clsx('w-4 h-4 rounded-full border-2 flex items-center justify-center', strategy === st.id ? 'border-brand-400' : 'border-mist-500')}>
                  {strategy === st.id && <span className="w-2 h-2 rounded-full bg-brand-400" />}
                </span>
                <b className="text-sm text-white">{st.title}</b>
              </div>
              <p className="text-xs text-mist-500 mt-2 leading-relaxed">{st.desc}</p>
            </button>
          ))}
        </div>
      </section>

      {/* ---------- Kualitas 'auto' ---------- */}
      <section>
        <SectionTitle icon={Gauge} hint="biar auto tidak jatuh ke model lemah">Kualitas model untuk “auto”</SectionTitle>
        <Card className="p-5 space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Num label="Skor minimum (0–100)" value={routing.minQualityScore} min={0} max={100}
              onChange={touch((v) => setRouting((r) => ({ ...r, minQualityScore: v })))}
              hint="Model di bawah skor ini tidak dipilih auto. 45 = aman, 65 = ketat." />
            <Num label="Jumlah kandidat" value={routing.autoCandidates} min={1} max={12}
              onChange={touch((v) => setRouting((r) => ({ ...r, autoCandidates: v })))}
              hint="Berapa model terbaik yang disiapkan sebagai rantai fallback." />
            <div className="col-span-2 grid gap-3 content-start">
              <Switch checked={routing.stickyAuto !== false} onChange={touch((v) => setRouting((r) => ({ ...r, stickyAuto: v })))}
                label="Routing lengket per percakapan"
                desc="Satu percakapan memakai model yang sama — jawaban multi-turn tidak berubah karakter di tengah jalan." />
              <Switch checked={routing.allowLowQuality !== false} onChange={touch((v) => setRouting((r) => ({ ...r, allowLowQuality: v })))}
                label="Bolehkan model di bawah ambang"
                desc="Kalau tidak ada yang lolos, pakai yang terbaik yang ada (diberi label low-confidence) daripada gagal. Matikan untuk menolak keras." />
            </div>
          </div>

          <div>
            <label className="block text-xs text-mist-400 mb-1.5">Blocklist model untuk auto <span className="text-mist-500/70">(satu per baris; substring atau /regex/i)</span></label>
            <textarea className="field field-mono" rows={3} value={blocklistText}
              onChange={(e) => { setBlocklistText(e.target.value); setDirty(true); }}
              placeholder={'allam\ntinyllama\n/small-\\d+b/'} />
            <p className="text-[10.5px] text-mist-500/80 mt-1.5">
              Bawaan sudah termasuk model yang terbukti lemah untuk bahasa Indonesia & reasoning (allam, tinyllama, smollm, gemma-2-2b, dst).
              Model yang dibloki <b className="text-mist-300">tetap bisa dipakai</b> lewat pin <code className="font-mono text-neon-400">provider/model</code>.
            </p>
          </div>

          {/* Preview */}
          <div className="rounded-xl border border-white/[0.07] bg-ink-950/50 p-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Sparkles size={14} className="text-brand-400" />
              <b className="text-xs text-mist-300">Preview pemilihan “auto”</b>
              <select className="rounded-lg bg-ink-800 border border-white/[0.08] hover:border-white/20 text-mist-300 font-mono text-[11.5px] px-2 py-1 cursor-pointer" value={previewTask}
                onChange={(e) => { setPreviewTask(e.target.value); loadPreview(e.target.value); }}>
                {TASKS.map((tk) => <option key={tk} value={tk}>task: {tk}</option>)}
              </select>
              <Btn size="sm" variant="ghost" onClick={() => loadPreview()} disabled={previewBusy}><Timer size={12} /> Hitung ulang</Btn>
              <Btn size="sm" variant="ghost" onClick={warmNow} disabled={previewBusy} title="Isi cache katalog + hangatkan koneksi">
                <Webhook size={12} /> Warm-up sekarang
              </Btn>
            </div>
            {previewBusy && <div className="text-xs text-mist-500 py-4 text-center">menilai model live…</div>}
            {!previewBusy && !preview && <Empty>Belum ada model live — tambahkan API key di tab Providers.</Empty>}
            {!previewBusy && preview && (
              <>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-mist-500 mb-3">
                  <span>{preview.providersScanned} provider · {preview.modelsScanned} model dinilai</span>
                  <span className="text-emerald-400">{preview.aboveThreshold} di atas ambang ({preview.minQualityScore})</span>
                  {preview.willUseLowQuality && <span className="text-amber-300">⚠ tak ada yang lolos ambang — auto akan pakai yang terbaik & menandainya</span>}
                </div>
                <div className="space-y-1.5">
                  {preview.candidates.map((c, i) => (
                    <div key={c.provider + ':' + c.model} className="flex items-center gap-2.5 text-[11.5px]">
                      <span className="w-4 text-center font-mono text-mist-500">{i + 1}</span>
                      <ScoreBar score={c.score} />
                      <span className="font-mono text-mist-300 truncate max-w-[36%]" title={c.model}>{c.provider}/{c.model}</span>
                      {i === 0 && <span className="text-[9.5px] uppercase tracking-wide bg-brand-500/20 text-brand-300 rounded px-1.5 py-0.5">dipilih</span>}
                      {c.penalty > 0 && <span className="text-[9.5px] text-amber-300" title="penalti otomatis karena gagal beruntun">-{c.penalty} kualitas</span>}
                      <span className="ml-auto text-[10px] text-mist-500/80 font-mono truncate max-w-[30%]" title={c.reasons.join(' ')}>{c.reasons.slice(0, 3).join(' ')}</span>
                    </div>
                  ))}
                  {preview.excluded?.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-[11px] text-mist-500 cursor-pointer hover:text-mist-300">
                        <Ban size={10} className="inline mr-1" />{preview.excluded.length} model disingkirkan dari auto
                      </summary>
                      <div className="mt-1.5 space-y-1">
                        {preview.excluded.map((c) => (
                          <div key={c.provider + ':' + c.model} className="flex items-center gap-2 text-[11px] font-mono text-mist-500">
                            <ScoreBar score={c.score} />
                            <span className="truncate">{c.provider}/{c.model}</span>
                            <span className="ml-auto text-red-300/80 shrink-0">{c.excludedReason}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </>
            )}
          </div>
        </Card>
      </section>

      {/* ---------- Anti jawaban kosong ---------- */}
      <section>
        <SectionTitle icon={MessageSquareWarning} hint={`${stats.emptyRejected || 0} jawaban kosong ditolak sejauh ini`}>Jawaban kosong &amp; fallback</SectionTitle>
        <Card className="p-5 grid grid-cols-1 md:grid-cols-3 gap-5">
          <Switch checked={content.rejectEmpty !== false} onChange={touch((v) => setContent((c) => ({ ...c, rejectEmpty: v })))}
            label="Tolak HTTP 200 tanpa isi"
            desc="Kalau model menjawab 200 tapi content kosong, percobaan dihitung gagal → dicoba kandidat lain → kalau semua kosong balas 502 (bukan 200 hampa)." />
          <Num label="Retry kandidat yang sama" value={content.emptyRetries} min={0} max={4}
            onChange={touch((v) => setContent((c) => ({ ...c, emptyRetries: v })))}
            hint="Banyak jawaban kosong bersifat sementara." />
          <Switch checked={allowAny} onChange={touch(setAllowAny)}
            label="Last-resort fallback"
            desc="Jika model asli habis, pakai model terbaik dari provider sehat mana pun (dilaporkan di x-lollm-selection)." />
        </Card>
      </section>

      {/* ---------- Konteks ---------- */}
      <section>
        <SectionTitle icon={Layers} hint="riwayat dikirim utuh; yang dipangkas selalu dilaporkan">Konteks multi-turn</SectionTitle>
        <Card className="p-5 grid grid-cols-1 md:grid-cols-4 gap-5">
          <Switch checked={context.enabled !== false} onChange={touch((v) => setContext((c) => ({ ...c, enabled: v })))}
            label="Pemangkasan aman"
            desc="Saat riwayat terlalu panjang, potong turn di TENGAH (jaga system + turn terakhir) supaya provider tidak memotong sendiri." />
          <Num label="Maks karakter riwayat" value={context.maxChars} min={1000} step={1000}
            onChange={touch((v) => setContext((c) => ({ ...c, maxChars: v })))} hint="≈ 4 karakter = 1 token" />
          <Num label="Turn terakhir wajib utuh" value={context.minRecentTurns} min={1} max={64}
            onChange={touch((v) => setContext((c) => ({ ...c, minRecentTurns: v })))} hint="minimal ini selalu dikirim" />
          <div className="text-[11px] text-mist-500 leading-relaxed">
            <b className="text-mist-300 block mb-1">Catatan</b>
            Turn assistant yang kosong dibuang sebelum dikirim — bikin model kecil “lupa” konteks.
          </div>
        </Card>
      </section>

      {/* ---------- Rate limit ---------- */}
      <section>
        <SectionTitle icon={ShieldCheck} hint={`429 jelas > jawaban diam-diam · in-flight ${status?.rateLimit?.inFlight ?? 0}`}>Rate limit &amp; kapasitas</SectionTitle>
        <Card className="p-5 grid grid-cols-1 md:grid-cols-4 gap-5">
          <Switch checked={rateLimit.enabled !== false} onChange={touch((v) => setRateLimit((c) => ({ ...c, enabled: v })))}
            label="Batas per klien"
            desc="Dihitung per gateway key (atau IP bila tanpa key)." />
          <Num label="Request / menit" value={rateLimit.requestsPerMinute} min={1}
            onChange={touch((v) => setRateLimit((c) => ({ ...c, requestsPerMinute: v })))} hint="termasuk burst di awal" />
          <Num label="Burst" value={rateLimit.burst} min={1}
            onChange={touch((v) => setRateLimit((c) => ({ ...c, burst: v })))} hint="token awal tersedia seketika" />
          <Num label="Maks request serentak" value={rateLimit.maxConcurrent} min={1}
            onChange={touch((v) => setRateLimit((c) => ({ ...c, maxConcurrent: v })))} hint="lebih dari ini → antre ≤5s lalu 429" />
        </Card>
      </section>

      <section>
        <SectionTitle icon={Timer} hint="inilah rahasia fallback secepat kilat">Timeout (ms)</SectionTitle>
        <Card className="p-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {TIMEOUTS.map(([k, label, desc]) => (
              <Num key={k} label={label} value={timeouts[k] ?? 0} min={1000} max={600000}
                onChange={(v) => { setTimeouts((t) => ({ ...t, [k]: v })); setDirty(true); }} hint={desc} />
            ))}
          </div>
          <p className="text-[11.5px] text-mist-500 mt-4">Makin pendek → fallback makin cepat; terlalu pendek → request lambat terpotong.</p>
          <div className="mt-4 pt-4 border-t border-white/[0.06] grid grid-cols-1 md:grid-cols-2 gap-4">
            <Switch checked={warmup.enabled !== false} onChange={touch((v) => setWarmup((c) => ({ ...c, enabled: v })))}
              label="Warm-up & keep-warm"
              desc="Katalog model & koneksi provider dipanaskan saat boot lalu disegarkan berkala — request pertama tidak lambat." />
            <Num label="Selang penyegaran (ms)" value={warmup.intervalMs} min={15000} step={10000}
              onChange={touch((v) => setWarmup((c) => ({ ...c, intervalMs: v })))} hint="300000 = 5 menit" />
          </div>
        </Card>
      </section>

      <section>
        <SectionTitle icon={RouteIcon}>Umum</SectionTitle>
        <Card className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
          <Num label="Maks percobaan per request" value={maxAttempts} min={1} max={12}
            onChange={touch(setMaxAttempts)} hint="termasuk retry jawaban kosong" />
          <Switch checked={authRequired} onChange={touch(setAuthRequired)}
            label="Autentikasi gateway key wajib"
            desc="Client /v1 harus membawa Bearer key." />
        </Card>
      </section>

      <section>
        <SectionTitle icon={ArrowUp} hint="kosong = pakai prioritas katalog">Urutan prioritas provider</SectionTitle>
        <Card className="p-3">
          {currentOrder.length === 0
            ? <div className="text-center text-xs text-mist-500 py-6">Tambahkan key dulu di tab Providers, lalu atur urutan di sini.</div>
            : currentOrder.map((id, i) => {
              const h = health.find((x) => x.id === id);
              return (
                <div key={id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.03] transition-colors">
                  <span className="w-6 text-center font-mono text-[11px] text-mist-500">{i + 1}.</span>
                  <b className="text-sm text-mist-300">{h?.name || id}</b>
                  <span className="font-mono text-[11px] text-mist-500">{id}</span>
                  {h?.models > 0 && <span className="text-[10.5px] text-mist-500/80 font-mono">{h.models} model</span>}
                  <div className="ml-auto flex gap-0.5">
                    <Btn size="sm" variant="ghost" onClick={() => move(id, -1)} disabled={i === 0}><ArrowUp size={14} /></Btn>
                    <Btn size="sm" variant="ghost" onClick={() => move(id, 1)} disabled={i === currentOrder.length - 1}><ArrowDown size={14} /></Btn>
                  </div>
                </div>
              );
            })}
        </Card>
      </section>

      <section>
        <SectionTitle icon={Download}>Backup &amp; restore config</SectionTitle>
        <Card className="p-5">
          <p className="text-xs text-mist-500 leading-relaxed mb-4">
            Export seluruh provider, pool key &amp; pengaturan ke satu file JSON — pindah mesin tinggal import.
            <b className="text-amber-300"> ⚠ File berisi API key asli, simpan di tempat aman.</b>
          </p>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={exportCfg}><Download size={14} /> Export config</Btn>
            <label className="inline-flex">
              <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => importCfg(e.target.files?.[0], e)} />
              <span className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium bg-white/[0.04] border border-white/10 text-mist-400 hover:text-white hover:border-white/25 transition-all cursor-pointer active:scale-[.97]">
                <Upload size={14} /> Import config
              </span>
            </label>
          </div>
        </Card>
      </section>
    </div>
  );
}
