import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Activity, KeyRound, Lock, LockOpen, RefreshCw, Save, ShieldCheck, ShieldOff } from 'lucide-react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Btn, Card, ConfirmBtn, CopyBtn, SectionTitle, Toggle } from '../components/ui.jsx';

function PasswordField({ label, value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="block text-xs text-mist-500 mb-1.5">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          className="field field-mono pr-10"
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-mist-500 hover:text-mist-300 cursor-pointer" tabIndex={-1}>
          {show ? <LockOpen size={13} /> : <Lock size={13} />}
        </button>
      </div>
    </div>
  );
}

export default function Admin() {
  const { boot, toast, reload } = useStore();
  const dash = boot?.dashboard || { loginEnabled: true, defaultPassword: false };

  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const [err, setErr] = useState('');

  useEffect(() => { setCur(''); setNext(''); setConfirm(''); setErr(''); }, [boot?.dashboard]);

  async function savePassword() {
    setErr('');
    if (!cur || !next) return setErr('Isi password saat ini & baru');
    if (next.length < 6) return setErr('Password baru minimal 6 karakter');
    if (next !== confirm) { setErr('Konfirmasi tidak sama'); setShakeKey((k) => k + 1); return; }
    setSaving(true);
    try {
      await api('dashboard/password', { method: 'POST', body: { current: cur, next } });
      toast('Password dashboard diganti', 'okk');
      setCur(''); setNext(''); setConfirm('');
      await reload();
    } catch (e) {
      setErr(e.message);
      setShakeKey((k) => k + 1);
    } finally {
      setSaving(false);
    }
  }

  async function toggleLogin(enabled) {
    try {
      await api('dashboard', { method: 'PUT', body: { loginEnabled: enabled } });
      toast(enabled ? 'Panel login diaktifkan' : 'Panel login dinonaktifkan — dashboard terbuka', 'okk');
      await reload();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function rotate() {
    try { await api('gateway/rotate', { method: 'POST' }); toast('Gateway key baru dibuat', 'okk'); await reload(); }
    catch (e) { toast(e.message, 'err'); }
  }

  async function resetStats() {
    try { await api('stats/reset', { method: 'POST' }); toast('Statistik direset', 'okk'); await reload(); }
    catch (e) { toast(e.message, 'err'); }
  }

  const gwKey = (boot?.gatewayKeys || [])[0] || '-';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Admin <span className="gtext">Settings</span></h1>
        <p className="text-sm text-mist-500 mt-1">Akses dashboard, keamanan, dan maintenance gateway.</p>
      </div>

      {/* Akses dashboard */}
      <section>
        <SectionTitle icon={ShieldCheck} hint="wajib password saat membuka dashboard">Akses dashboard</SectionTitle>
        <Card className="p-5 space-y-5">
          <label className="flex items-start gap-3.5 cursor-pointer">
            <Toggle checked={dash.loginEnabled} onChange={toggleLogin} />
            <span className="text-sm leading-relaxed">
              <b className="text-mist-300 block mb-0.5">Wajib password untuk membuka dashboard</b>
              <span className="text-xs text-mist-500">
                {dash.loginEnabled
                  ? 'Dashboard terkunci — password diminta setiap sesi baru. Ini API /v1 tetap memakai gateway key.'
                  : 'Dashboard terbuka tanpa login (tidak disarankan jika gateway bisa diakses jaringan lain).'}
              </span>
            </span>
          </label>

          <div className={clsx('pt-5 border-t border-white/[0.06]', !dash.loginEnabled && 'opacity-40 pointer-events-none')}>
            <div className="flex items-center gap-2 mb-4">
              <KeyRound size={14} className="text-brand-400" />
              <b className="text-sm text-white">Ganti password</b>
              {dash.defaultPassword && (
                <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border bg-amber-400/10 text-amber-300 border-amber-400/25">
                  MASIH DEFAULT
                </span>
              )}
            </div>
            <div key={shakeKey} className={clsx('grid grid-cols-1 sm:grid-cols-3 gap-3', err && 'animate-[shake_.4s_ease]')}>
              <PasswordField label="Password saat ini" value={cur} onChange={setCur} placeholder="••••••••" autoComplete="current-password" />
              <PasswordField label="Password baru (min. 6)" value={next} onChange={setNext} placeholder="••••••••" autoComplete="new-password" />
              <PasswordField label="Ulangi password baru" value={confirm} onChange={setConfirm} placeholder="••••••••" autoComplete="new-password" />
            </div>
            {err && <p className="text-xs text-red-300 mt-2.5 animate-[pop_.2s_ease]">{err}</p>}
            <div className="mt-4">
              <Btn variant="primary" onClick={savePassword} disabled={saving || !cur || !next}>
                <Save size={14} /> {saving ? 'Menyimpan…' : 'Simpan password baru'}
              </Btn>
            </div>
          </div>
        </Card>
      </section>

      {/* Gateway API key */}
      <section>
        <SectionTitle icon={KeyRound} hint="dipakai client menuju /v1">Gateway API key</SectionTitle>
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <code className="text-xs font-mono bg-ink-800 border border-white/[0.08] rounded-lg px-3 py-2 text-mist-300 select-all break-all">{gwKey}</code>
            <CopyBtn text={gwKey} label="Salin" />
            <ConfirmBtn onConfirm={rotate} className="!text-red-300"><RefreshCw size={12} /> Rotate</ConfirmBtn>
          </div>
          <p className="text-[11.5px] text-mist-500 mt-3">Rotate membatalkan key lama — client harus memakai key baru.</p>
        </Card>
      </section>

      {/* Maintenance */}
      <section>
        <SectionTitle icon={Activity}>Maintenance</SectionTitle>
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-xs text-mist-500 flex-1 min-w-[200px]">
              Reset statistik (jumlah request, sukses/gagal, token, latensi) kembali ke nol. Log request tidak terhapus.
            </div>
            <ConfirmBtn onConfirm={resetStats}>Reset statistik</ConfirmBtn>
          </div>
        </Card>
      </section>
    </div>
  );
}
