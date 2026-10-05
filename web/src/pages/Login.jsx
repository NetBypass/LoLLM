import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Eye, EyeOff, Loader2, Lock, ShieldAlert, Zap } from 'lucide-react';
import { login, VERSION } from '../api.js';
import { Btn } from '../components/ui.jsx';

export default function Login({ onLogin, defaultPassword }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [shakeKey, setShakeKey] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => document.getElementById('lollm-pw')?.focus(), 250);
    return () => clearTimeout(t);
  }, []);

  async function submit(e) {
    e?.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr('');
    try {
      const j = await login(pw);
      onLogin?.(j.session);
    } catch (e2) {
      setErr(e2.message);
      setShakeKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-ink-900 grid place-items-center px-4 relative overflow-hidden">
      {/* blobs animasi */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-brand-500/15 blur-3xl animate-[float_9s_ease-in-out_infinite]" />
        <div className="absolute -bottom-32 -right-24 w-[26rem] h-[26rem] rounded-full bg-neon-400/10 blur-3xl animate-[float_11s_ease-in-out_infinite_reverse]" />
        <div className="absolute top-1/3 right-1/4 w-64 h-64 rounded-full bg-brand-600/10 blur-3xl animate-[float_13s_ease-in-out_infinite]" />
      </div>

      <div key={shakeKey} className={clsx('w-full max-w-sm relative', err ? 'animate-[shake_.4s_ease]' : 'animate-[pop_.4s_ease]')}>
        <div className="rounded-3xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-2xl p-8 shadow-2xl shadow-black/50">
          <div className="flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-500 to-neon-400 flex items-center justify-center shadow-xl shadow-brand-500/30 animate-[pop_.5s_ease]">
              <Zap size={26} className="text-white" fill="white" />
            </div>
            <h1 className="text-xl font-bold text-white mt-4 tracking-tight">LoLLM Gateway</h1>
            <p className="text-xs text-mist-500 mt-1.5">Masukkan password untuk membuka dashboard{VERSION ? ` · v${VERSION}` : ''}</p>
          </div>

          <form onSubmit={submit} className="mt-7 space-y-3.5">
            <div className="relative">
              <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-mist-500" />
              <input
                id="lollm-pw"
                type={show ? 'text' : 'password'}
                className="field pl-10 pr-10"
                placeholder="Password dashboard"
                value={pw}
                autoComplete="current-password"
                onChange={(e) => setPw(e.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => setShow(!show)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-mist-500 hover:text-mist-300 cursor-pointer transition-colors"
                tabIndex={-1}
              >
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>

            {err && (
              <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2 flex items-center gap-2 animate-[pop_.25s_ease]">
                <ShieldAlert size={13} className="shrink-0" /> {err}
              </p>
            )}

            <Btn variant="primary" className="w-full !py-2.5" onClick={submit} disabled={busy || !pw} type="submit">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={14} />}
              {busy ? 'Memeriksa…' : 'Masuk'}
            </Btn>
          </form>

          {defaultPassword && (
            <p className="text-[11px] text-amber-300/80 mt-5 text-center leading-relaxed animate-[fadein_.5s_ease_.3s_both]">
              Masih memakai password default — segera ganti di tab <b>Admin</b> setelah masuk.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
