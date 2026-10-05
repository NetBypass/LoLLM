import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Download, KeyRound, RefreshCw, Route as RouteIcon, Save, Timer, Upload } from 'lucide-react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Btn, Card, ConfirmBtn, CopyBtn, SectionTitle, Toggle } from '../components/ui.jsx';

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
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!s) return;
    setStrategy(s.strategy);
    setTimeouts({ ...s.timeouts });
    setMaxAttempts(s.maxAttempts);
    setAuthRequired(s.authRequired);
    setAllowAny(s.allowAnyFallback);
    setOrder(null);
    setDirty(false);
  }, [s]);

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
        },
      });
      toast('Pengaturan tersimpan ✓', 'okk');
      setDirty(false);
      await reload();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  }

  async function rotate() {
    try { await api('gateway/rotate', { method: 'POST' }); toast('Gateway key baru dibuat ✓', 'okk'); await reload(); }
    catch (e) { toast(e.message, 'err'); }
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

  const gwKey = (boot?.gatewayKeys || [])[0] || '-';

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

      <section>
        <SectionTitle icon={Timer} hint="inilah rahasia fallback secepat kilat">Timeout (ms)</SectionTitle>
        <Card className="p-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {TIMEOUTS.map(([k, label, desc]) => (
              <div key={k}>
                <label className="block text-xs text-mist-400 mb-1.5">{label}</label>
                <input type="number" className="field field-mono" value={timeouts[k] ?? 0}
                  onChange={(e) => { setTimeouts((t) => ({ ...t, [k]: Number(e.target.value) })); setDirty(true); }} />
                <p className="text-[10.5px] text-mist-500/80 mt-1.5">{desc}</p>
              </div>
            ))}
          </div>
          <p className="text-[11.5px] text-mist-500 mt-4">Makin pendek → fallback makin cepat; terlalu pendek → request lambat terpotong.</p>
        </Card>
      </section>

      <section>
        <SectionTitle icon={RouteIcon}>Umum</SectionTitle>
        <Card className="p-5 grid grid-cols-1 md:grid-cols-3 gap-5">
          <div>
            <label className="block text-xs text-mist-400 mb-1.5">Maks percobaan per request</label>
            <input type="number" min="1" max="12" className="field field-mono w-28" value={maxAttempts}
              onChange={(e) => { setMaxAttempts(e.target.value); setDirty(true); }} />
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <Toggle checked={authRequired} onChange={(v) => { setAuthRequired(v); setDirty(true); }} />
            <span className="text-xs text-mist-400 leading-relaxed"><b className="text-mist-300 block mb-0.5">Autentikasi gateway key wajib</b>Client /v1 harus membawa Bearer key.</span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <Toggle checked={allowAny} onChange={(v) => { setAllowAny(v); setDirty(true); }} />
            <span className="text-xs text-mist-400 leading-relaxed"><b className="text-mist-300 block mb-0.5">Last-resort fallback</b>Jika model asli habis, pakai provider sehat mana pun.</span>
          </label>
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
        <SectionTitle icon={KeyRound}>Gateway API key</SectionTitle>
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <code className="text-xs font-mono bg-ink-800 border border-white/[0.08] rounded-lg px-3 py-2 text-mist-300 select-all break-all">{gwKey}</code>
            <CopyBtn text={gwKey} label="Salin" />
            <ConfirmBtn onConfirm={rotate} className="!text-red-300"><RefreshCw size={12} /> Rotate</ConfirmBtn>
          </div>
          <p className="text-[11.5px] text-mist-500 mt-3">Dipakai client sebagai <code className="font-mono">Authorization: Bearer …</code> menuju /v1. Rotate membatalkan key lama.</p>
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
