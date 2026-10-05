import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Check, Copy } from 'lucide-react';

export function Btn({ variant = 'default', size = 'md', className, ...props }) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all active:scale-[.97] disabled:opacity-40 disabled:pointer-events-none cursor-pointer whitespace-nowrap',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        variant === 'primary' && 'bg-gradient-to-r from-brand-500 to-brand-600 text-white shadow-lg shadow-brand-500/20 hover:shadow-brand-500/40 hover:brightness-110',
        variant === 'default' && 'bg-white/[0.04] border border-white/10 text-mist-400 hover:text-white hover:border-white/25',
        variant === 'danger' && 'bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/25',
        variant === 'ghost' && 'text-mist-500 hover:text-white',
        className
      )}
      {...props}
    />
  );
}

export function Toggle({ checked, onChange, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange(!checked)}
      className={clsx('relative w-9 h-5 rounded-full transition-colors cursor-pointer shrink-0', checked ? 'bg-brand-500' : 'bg-ink-600')}
    >
      <span className={clsx('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform', checked && 'translate-x-4')} />
    </button>
  );
}

export function Dot({ state, className }) {
  const map = {
    up: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.8)]',
    cooling: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,.6)]',
    down: 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,.6)]',
    off: 'bg-red-400/50',
    empty: 'bg-ink-600',
  };
  return <span className={clsx('inline-block w-2 h-2 rounded-full shrink-0', map[state] || map.empty, className)} />;
}

export function TierBadge({ tier }) {
  const map = {
    free: ['bg-emerald-400/10 text-emerald-300 border-emerald-400/20', 'GRATIS'],
    freemium: ['bg-amber-400/10 text-amber-300 border-amber-400/20', 'FREEMIUM'],
    paid: ['bg-red-400/10 text-red-300 border-red-400/20', 'BERBAYAR'],
    custom: ['bg-brand-400/10 text-brand-400 border-brand-400/25', 'CUSTOM'],
  };
  const [cls, label] = map[tier] || map.custom;
  return <span className={clsx('text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border', cls)}>{label}</span>;
}

export function CopyBtn({ text, label }) {
  const [ok, setOk] = useState(false);
  return (
    <Btn size="sm" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      } catch { /* ignore */ }
    }}>
      {ok ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
      {label}
    </Btn>
  );
}

export function Card({ className, children, ...props }) {
  return (
    <div className={clsx('rounded-2xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-sm', className)} {...props}>
      {children}
    </div>
  );
}

export function SectionTitle({ icon: Icon, children, hint }) {
  return (
    <div className="flex items-center gap-2.5 mb-4 flex-wrap">
      {Icon && <Icon size={16} className="text-brand-400 shrink-0" />}
      <h2 className="text-[15px] font-semibold text-white">{children}</h2>
      {hint && <span className="text-xs text-mist-500">{hint}</span>}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="text-center text-sm text-mist-500 py-8 px-4 border border-dashed border-white/10 rounded-2xl">{children}</div>;
}

export function ConfirmBtn({ onConfirm, children, ...props }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Btn size="sm" variant={armed ? 'danger' : 'default'} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }} {...props}>
      {armed ? 'Yakin?' : children}
    </Btn>
  );
}

export function Sparkline({ values, className }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / (max - min || 1)) * 27}`)
    .join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={className}>
      <polyline points={pts} fill="none" stroke="url(#spark-gradient)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      <defs>
        <linearGradient id="spark-gradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#7c5cff" />
          <stop offset="100%" stopColor="#00d4ff" />
        </linearGradient>
      </defs>
    </svg>
  );
}
