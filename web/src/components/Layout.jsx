import clsx from 'clsx';
import { Zap, LayoutDashboard, MessagesSquare, KeyRound, Route, ScrollText, Settings } from 'lucide-react';
import { useStore } from '../store.jsx';
import { fmtUptime, VERSION } from '../api.js';

export const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'playground', label: 'Playground', icon: MessagesSquare },
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'routing', label: 'Routing', icon: Route },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'admin', label: 'Admin', icon: Settings },
];

export default function Layout({ children }) {
  const { tab, go, status } = useStore();
  const up = status?.uptimeSec ?? 0;
  const healthy = (status?.health || []).filter((p) => p.state === 'up').length;

  return (
    <div className="min-h-screen bg-ink-900">
      {/* ambient glow */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-48 -left-48 w-[28rem] h-[28rem] rounded-full bg-brand-500/10 blur-3xl animate-[float_14s_ease-in-out_infinite]" />
        <div className="absolute top-1/3 -right-48 w-[28rem] h-[28rem] rounded-full bg-neon-400/[0.06] blur-3xl animate-[float_18s_ease-in-out_infinite_reverse]" />
      </div>

      {/* Sidebar (desktop) */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-60 flex-col border-r border-white/[0.06] bg-ink-900/80 backdrop-blur-xl z-30">
        <div className="flex items-center gap-3 px-5 h-16 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-neon-400 flex items-center justify-center shadow-lg shadow-brand-500/30 transition-transform hover:scale-105">
            <Zap size={18} className="text-white" fill="white" />
          </div>
          <div>
            <div className="font-bold text-white leading-none tracking-wide">LoLLM</div>
            <div className="text-[10px] text-mist-500 mt-1">GATEWAY v{VERSION}</div>
          </div>
        </div>
        <nav className="flex-1 px-3 space-y-1 mt-2 overflow-y-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              className={clsx(
                'group relative w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer',
                tab === t.id ? 'bg-white/[0.07] text-white' : 'text-mist-500 hover:text-mist-300 hover:bg-white/[0.03] hover:translate-x-0.5'
              )}
            >
              {tab === t.id && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r bg-gradient-to-b from-brand-400 to-neon-400" />}
              <t.icon size={17} className={clsx('transition-transform', tab !== t.id && 'group-hover:scale-110')} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="p-4 shrink-0">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-xs">
            <div className="flex items-center gap-2 text-mist-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Aktif · {fmtUptime(up)}
            </div>
            <div className="text-mist-500 mt-1.5">{healthy} provider sehat</div>
          </div>
        </div>
      </aside>

      {/* Header (mobile) */}
      <header className="lg:hidden sticky top-0 z-30 flex items-center gap-3 px-4 h-14 border-b border-white/[0.06] bg-ink-900/85 backdrop-blur-xl">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-neon-400 flex items-center justify-center shadow-lg shadow-brand-500/25">
          <Zap size={15} className="text-white" fill="white" />
        </div>
        <span className="font-bold text-white">LoLLM</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-mist-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          {fmtUptime(up)}
        </span>
      </header>

      {/* Content */}
      <main className="relative lg:pl-60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-28 lg:pb-10">{children}</div>
      </main>

      {/* Bottom nav (mobile) */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-white/[0.06] bg-ink-900/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              className={clsx(
                'flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-all cursor-pointer',
                tab === t.id ? 'text-brand-400' : 'text-mist-500'
              )}
            >
              <t.icon size={18} className={clsx('transition-transform', tab === t.id && 'scale-110')} />
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
