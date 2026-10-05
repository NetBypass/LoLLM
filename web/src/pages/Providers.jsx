import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Beaker, Check, ChevronDown, Coins, CreditCard, ExternalLink, Gift, KeyRound, Loader2, Plus, Search, Trash2, Wrench, X } from 'lucide-react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Btn, Card, ConfirmBtn, Dot, Empty, SectionTitle, TierBadge, Toggle } from '../components/ui.jsx';

const GROUPS = [
  ['free', 'Provider gratis', 'tempel API key, langsung jalan — tanpa setup apa pun', Gift],
  ['freemium', 'Freemium', 'kredit trial / kuota terbatas', Coins],
  ['paid', 'Berbayar', 'provider utama (opsional)', CreditCard],
  ['custom', 'Custom', 'provider OpenAI-compatible milikmu sendiri', Wrench],
];

function keyState(k) {
  if (k.enabled === false) return 'off';
  if (k.status === 'dead') return 'down';
  if (k.cooldownUntil && k.cooldownUntil > Date.now()) return 'cooling';
  return 'up';
}

function KeyRow({ pid, k, onAction }) {
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const masked = k.id === 'keyless' ? 'tanpa key' : reveal ? k.value : (k.value || '').slice(0, 6) + '…' + (k.value || '').slice(-4);

  async function test() {
    setTesting(true);
    try {
      const r = await api('keys/test', { method: 'POST', body: { providerId: pid, keyId: k.id } });
      if (r.ok) onAction.toast(`Key sehat ✓ ${r.ms}ms${r.modelsCount != null ? ' · ' + r.modelsCount + ' model' : ''}`, 'okk');
      else onAction.toast(`Key bermasalah: ${r.error} (${r.kind})`, 'err');
      onAction.reload();
    } catch (e) { onAction.toast(e.message, 'err'); }
    setTesting(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 rounded-xl bg-ink-850/60 border border-white/[0.05] hover:border-white/[0.12] transition-colors">
      <Dot state={keyState(k)} />
      <span className="text-[13px] font-semibold text-mist-300">{k.label}</span>
      <button className="font-mono text-[11.5px] text-mist-500 hover:text-neon-400 cursor-pointer transition-colors" onClick={() => setReveal(!reveal)} title="Klik untuk lihat/sembunyikan">
        {masked}
      </button>
      <span className="flex items-center gap-2 font-mono text-[11px] text-mist-500">
        <span className="flex items-center gap-0.5 text-emerald-400" title="sukses"><Check size={11} />{k.success || 0}</span>
        <span className="flex items-center gap-0.5 text-red-400" title="gagal"><X size={11} />{k.fail || 0}</span>
        {k.lastError && <AlertTriangle size={11} className="text-amber-400 cursor-help" title={k.lastError} />}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <Btn size="sm" onClick={test} disabled={testing}>
          {testing ? <Loader2 size={12} className="animate-spin" /> : <Beaker size={12} />} Test
        </Btn>
        {k.id !== 'keyless' && (
          <>
            <Btn size="sm" onClick={() => onAction.toggleKey(pid, k.id, k.enabled !== false)}>
              {k.enabled !== false ? 'Nonaktif' : 'Aktifkan'}
            </Btn>
            <ConfirmBtn onConfirm={() => onAction.delKey(pid, k.id)}><Trash2 size={12} /></ConfirmBtn>
          </>
        )}
      </div>
    </div>
  );
}

function ProviderCard({ p, conf, actions, liveAll, idx = 0 }) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const [keyVal, setKeyVal] = useState('');
  const [label, setLabel] = useState('');
  const [bulkVal, setBulkVal] = useState('');
  const [adding, setAdding] = useState(false);
  const keys = conf?.keys || [];
  const live = (liveAll || []).filter((m) => m.provider === p.id).map((m) => m.id);

  async function add() {
    if (!keyVal.trim()) return actions.toast('Key-nya kosong dulu, dewa 🙏', 'err');
    setAdding(true);
    try { await actions.addKey(p.id, keyVal.trim(), label.trim()); setKeyVal(''); setLabel(''); }
    catch (e) { actions.toast(e.message, 'err'); }
    setAdding(false);
  }

  async function bulkAdd() {
    const list = bulkVal.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return actions.toast('Tidak ada key yang terbaca', 'err');
    try {
      const r = await api('keys', { method: 'POST', body: { providerId: p.id, keys: list } });
      actions.toast(`${r.added} key masuk pool${r.skipped ? ' · ' + r.skipped + ' dilewati' : ''}`, 'okk');
      setBulkVal(''); setBulkOpen(false);
      await actions.reload();
      actions.refreshModels(true);
    } catch (e) { actions.toast(e.message, 'err'); }
  }

  return (
    <Card className="p-5 animate-[pop_.3s_ease_both]" style={{ animationDelay: `${Math.min(idx, 8) * 35}ms` }}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-bold text-white text-[15px]">{p.name}</span>
        <TierBadge tier={p.tier} />
        {p.keyless && <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border bg-brand-400/10 text-brand-400 border-brand-400/25">KEYLESS</span>}
        <span className="hidden sm:block font-mono text-[11px] text-mist-500 truncate max-w-[220px]">{p.baseUrl}</span>
        <div className="ml-auto flex items-center gap-2.5">
          {p.getKey && (
            <a href={p.getKey} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[12px] text-neon-400 hover:text-neon-400/80 transition-colors">
              {p.tier === 'free' ? 'Ambil key gratis' : 'Ambil key'} <ExternalLink size={11} />
            </a>
          )}
          <Toggle checked={conf?.enabled !== false} onChange={(v) => actions.toggleProvider(p.id, v)} title="Aktif/nonaktifkan provider" />
        </div>
      </div>
      {p.note && <p className="text-[12.5px] text-mist-500 mt-2.5 leading-relaxed">{p.note}</p>}
      {live.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-wider text-emerald-300 mr-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> LIVE · {live.length}
          </span>
          {live.slice(0, 5).map((m) => (
            <span key={m} title={m} className="font-mono text-[11px] text-neon-400/90 bg-neon-400/[0.07] border border-neon-400/15 rounded-md px-2 py-0.5 max-w-[200px] truncate">{m}</span>
          ))}
          {live.length > 5 && <span className="font-mono text-[11px] text-mist-500 px-1 py-0.5">+{live.length - 5} lagi</span>}
        </div>
      ) : keys.length > 0 ? (
        <p className="text-[11px] text-mist-500 mt-3">Daftar model belum bisa diambil dari endpoint — cek key/koneksi lalu muat ulang halaman.</p>
      ) : (
        <p className="text-[11px] text-mist-500/70 mt-3">Model list kosong — terisi otomatis (live dari endpoint) setelah API key ditambahkan.</p>
      )}

      <div className="mt-4 space-y-2">
        {keys.length === 0
          ? <div className="text-center text-xs text-mist-500 py-3.5 border border-dashed border-white/10 rounded-xl">Belum ada key di pool{p.keyless ? ' — provider ini tidak butuh key.' : '.'}</div>
          : keys.map((k) => <KeyRow key={k.id} pid={p.id} k={k} onAction={actions} />)}
      </div>

      {!p.keyless && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-2">
            <input className="field field-mono flex-1 min-w-[170px]" placeholder={`Tempel ${p.name} API key…`} value={keyVal} onChange={(e) => setKeyVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <input className="field w-32" placeholder="label (opsional)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Btn variant="primary" onClick={add} disabled={adding}><Plus size={14} /> Pool</Btn>
            <Btn onClick={() => setBulkOpen(!bulkOpen)} title="Tempel banyak key sekaligus"><ChevronDown size={14} className={clsx('transition-transform', bulkOpen && 'rotate-180')} /> Bulk</Btn>
          </div>
          {bulkOpen && (
            <div className="mt-2.5 animate-[fadein_.2s_ease]">
              <textarea className="field font-mono" rows={4} placeholder={'Satu key per baris — tempel sebanyak apa pun, duplikat otomatis dilewati…'} value={bulkVal} onChange={(e) => setBulkVal(e.target.value)} />
              <div className="flex items-center gap-2.5 mt-2">
                <Btn variant="primary" size="sm" onClick={bulkAdd}><Plus size={12} /> Masukkan semuanya</Btn>
                <span className="text-[11px] text-mist-500">duplikat otomatis dilewati</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Providers() {
  const { boot, status, toast, reload, models, refreshModels } = useStore();
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [style, setStyle] = useState('openai');

  const actions = {
    toast,
    reload,
    addKey: async (pid, key, label) => {
      try {
        await api('keys', { method: 'POST', body: { providerId: pid, key, label } });
        toast('Key masuk pool', 'okk');
        await reload();
        refreshModels(true);
      } catch (e) { throw e; }
    },
    refreshModels,
    delKey: async (pid, kid) => {
      try { await api('keys', { method: 'DELETE', body: { providerId: pid, keyId: kid } }); toast('Key dihapus'); await reload(); }
      catch (e) { toast(e.message, 'err'); }
    },
    toggleKey: async (pid, kid, enabled) => {
      try { await api('keys/toggle', { method: 'POST', body: { providerId: pid, keyId: kid, enabled } }); await reload(); }
      catch (e) { toast(e.message, 'err'); }
    },
    toggleProvider: async (pid, enabled) => {
      try { await api('providers/toggle', { method: 'POST', body: { providerId: pid, enabled } }); await reload(); }
      catch (e) { toast(e.message, 'err'); }
    },
  };

  const all = useMemo(() => [...(boot?.catalog || []), ...(boot?.customProviders || [])], [boot]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return all;
    return all.filter((p) =>
      p.name.toLowerCase().includes(s) || p.id.includes(s) ||
      (p.models || []).some((m) => m.toLowerCase().includes(s))
    );
  }, [all, q]);

  async function addCustom() {
    if (!name.trim() || !url.trim()) return toast('Nama & base URL wajib', 'err');
    try {
      await api('providers/custom', { method: 'POST', body: { name: name.trim(), baseUrl: url.trim(), style } });
      toast('Provider custom dibuat', 'okk');
      setName(''); setUrl('');
      await reload();
    } catch (e) { toast(e.message, 'err'); }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-mist-500" />
          <input className="field pl-10" placeholder="Cari provider atau model…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="text-xs text-mist-500">{filtered.length} provider</span>
      </div>

      {GROUPS.map(([tier, title, desc, Icon]) => {
        const list = filtered.filter((p) => p.tier === tier);
        if (!list.length) return null;
        return (
          <section key={tier}>
            <SectionTitle icon={Icon} hint={desc}>{title}</SectionTitle>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
              {list.map((p, i) => <ProviderCard key={p.id} p={p} conf={boot?.providers?.[p.id]} actions={actions} liveAll={models} idx={i} />)}
            </div>
          </section>
        );
      })}

      {filtered.length === 0 && <Empty>Tidak ada provider yang cocok dengan “{q}”.</Empty>}

      <section>
        <SectionTitle icon={KeyRound}>Tambah provider custom</SectionTitle>
        <Card className="p-5">
          <div className="flex flex-wrap gap-2">
            <input className="field flex-1 min-w-[150px]" style={{ fontFamily: 'inherit' }} placeholder="Nama, mis. OpenRouter-Lama" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="field field-mono flex-[2] min-w-[220px]" placeholder="https://base-url/v1" value={url} onChange={(e) => setUrl(e.target.value)} />
            <select className="field w-36" value={style} onChange={(e) => setStyle(e.target.value)}>
              <option value="openai">OpenAI style</option>
              <option value="anthropic">Anthropic</option>
            </select>
            <Btn variant="primary" onClick={addCustom}><Plus size={14} /> Tambah</Btn>
          </div>
          <p className="text-[11.5px] text-mist-500 mt-2.5">Setelah dibuat, tempel key-nya di kartu provider custom di atas.</p>
        </Card>
      </section>
    </div>
  );
}
