import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { RefreshCw, ScrollText, Trash2, Zap } from 'lucide-react';
import { useStore } from '../store.jsx';
import { api, fmtMs, timeAgo } from '../api.js';
import { Btn, Card, ConfirmBtn, Empty } from '../components/ui.jsx';

const KIND_COLOR = {
  auth: 'bg-red-400/10 text-red-300 border-red-400/20',
  rate: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  timeout: 'bg-orange-400/10 text-orange-300 border-orange-400/20',
  server: 'bg-red-400/10 text-red-300 border-red-400/20',
  network: 'bg-slate-400/10 text-slate-300 border-slate-400/20',
  model: 'bg-brand-400/10 text-brand-400 border-brand-400/20',
  client: 'bg-slate-400/10 text-slate-300 border-slate-400/20',
};

function TrailChip({ t }) {
  const kind = t.kind || '?';
  return (
    <span className={clsx('inline-block font-mono text-[10px] px-1.5 py-0.5 rounded border', KIND_COLOR[kind] || KIND_COLOR.client)}>
      {t.provider}/{t.key}:{kind}
    </span>
  );
}

export default function Logs() {
  const { logs, toast, refreshLogs } = useStore();
  const [filter, setFilter] = useState('all');
  const [live, setLive] = useState(true);

  const filtered = useMemo(() => {
    if (filter === 'ok') return logs.filter((l) => l.status === 200);
    if (filter === 'fail') return logs.filter((l) => l.status !== 200);
    return logs;
  }, [logs, filter]);

  // Polling dikendalikan lewat store interval; di sini hanya manual refresh.
  // (Interval store tetap jalan; toggle "live" hanya menghentikan refresh manual otomatis di tab ini.)

  async function clear() {
    try { await api('logs/clear', { method: 'POST' }); toast('Log dibersihkan'); refreshLogs(); }
    catch (e) { toast(e.message, 'err'); }
  }

  const counts = {
    all: logs.length,
    ok: logs.filter((l) => l.status === 200).length,
    fail: logs.filter((l) => l.status !== 200).length,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <SectionTitle icon={ScrollText} hint="terbaru dulu, maks 500">{''}</SectionTitle>
        <div className="flex gap-1.5">
          {[['all', 'Semua'], ['ok', 'Sukses'], ['fail', 'Gagal']].map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)}
              className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border transition-all cursor-pointer',
                filter === id ? 'bg-brand-500/15 border-brand-400/40 text-white' : 'bg-white/[0.03] border-white/[0.08] text-mist-500 hover:text-mist-300')}>
              {label} <span className="font-mono opacity-70">{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Btn size="sm" onClick={() => refreshLogs()}><RefreshCw size={12} /></Btn>
          <ConfirmBtn onConfirm={clear}><Trash2 size={12} /></ConfirmBtn>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty>
          {logs.length === 0
            ? <>Belum ada request lewat gateway. Coba Playground 🚀</>
            : <>Tidak ada log dengan filter ini.</>}
        </Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-mist-500 border-b border-white/[0.07]">
                <th className="px-4 py-3 font-semibold">Waktu</th>
                <th className="px-4 py-3 font-semibold">Model</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Tipe</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Durasi</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Token</th>
                <th className="px-4 py-3 font-semibold">Jejak fallback</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l, i) => (
                <tr key={i} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-mist-500 whitespace-nowrap">{timeAgo(l.ts)}</td>
                  <td className="px-4 py-2.5 font-mono text-[11.5px] text-mist-300 max-w-[220px] truncate">
                    {l.model}
                    {l.finalModel && l.finalModel !== l.model && <span className="text-mist-500"> → {l.finalModel}</span>}
                  </td>
                  <td className="px-4 py-2.5 hidden md:table-cell text-[11px] text-mist-500">{l.stream ? 'sse' : 'json'}</td>
                  <td className="px-4 py-2.5">
                    <span className={clsx('font-mono text-[11.5px] font-semibold',
                      l.status === 200 ? 'text-emerald-400' : l.status === 'aborted' ? 'text-mist-500' : 'text-red-400')}>
                      {l.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11.5px] text-mist-400">{fmtMs(l.ms)}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-mist-500 hidden lg:table-cell">{l.usage || '—'}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1 max-w-[280px]">
                      {l.status === 200 && (
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded border bg-emerald-400/10 text-emerald-300 border-emerald-400/20">
                          <Zap size={9} /> {l.provider}{l.key ? '/' + l.key : ''} ✓
                        </span>
                      )}
                      {(l.trail || []).map((t, j) => <TrailChip key={j} t={t} />)}
                      {l.status !== 200 && !(l.trail || []).length && <span className="text-[11px] text-mist-500">—</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
