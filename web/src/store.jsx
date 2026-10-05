import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, hasSession } from './api.js';

const Ctx = createContext(null);
export const StoreContext = Ctx;
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }) {
  const [tab, setTab] = useState(() =>
    typeof location !== 'undefined' ? (location.hash.replace(/^#\/?/, '') || 'overview') : 'overview'
  );
  const [needsLogin, setNeedsLogin] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !!window.__LOLLM__?.loginRequired && !hasSession();
  });
  const [boot, setBoot] = useState(null);
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [models, setModels] = useState(null);
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((msg, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-4), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const refreshBoot = useCallback(async () => {
    try { setBoot(await api('bootstrap')); } catch { /* halaman lain menampilkan error */ }
  }, []);
  const refreshStatus = useCallback(async () => {
    try { setStatus(await api('status')); } catch { /* silent */ }
  }, []);
  const refreshLogs = useCallback(async () => {
    try { setLogs((await api('logs?limit=150')).logs); } catch { /* silent */ }
  }, []);
  const refreshModels = useCallback(async (refresh = false) => {
    try { setModels((await api('models' + (refresh ? '?refresh=1' : ''))).models); } catch { /* silent */ }
  }, []);
  const reload = useCallback(async () => {
    await Promise.all([refreshBoot(), refreshStatus()]);
  }, [refreshBoot, refreshStatus]);

  // Login flow
  const onLogin = useCallback((session) => {
    setNeedsLogin(false);
    reload();
    refreshLogs();
  }, [reload, refreshLogs]);

  useEffect(() => {
    const h = () => setNeedsLogin(true);
    addEventListener('lollm:needs-login', h);
    return () => removeEventListener('lollm:needs-login', h);
  }, []);

  // Hash routing
  const go = useCallback((t) => { location.hash = '#/' + t; setTab(t); }, []);
  useEffect(() => {
    const onHash = () => setTab(location.hash.replace(/^#\/?/, '') || 'overview');
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  // Initial + polling (berhenti saat belum login)
  useEffect(() => {
    if (needsLogin) return;
    reload();
    refreshLogs();
  }, [needsLogin, reload, refreshLogs]);
  useEffect(() => {
    if (needsLogin) return;
    const t = setInterval(refreshStatus, 8000);
    return () => clearInterval(t);
  }, [needsLogin, refreshStatus]);
  useEffect(() => {
    if (needsLogin) return;
    const t = setInterval(refreshLogs, 4000);
    return () => clearInterval(t);
  }, [needsLogin, refreshLogs]);

  // Model list (playground/providers) — lazy
  useEffect(() => {
    if (needsLogin) return;
    if ((tab === 'playground' || tab === 'providers') && models === null) refreshModels();
  }, [tab, needsLogin, models, refreshModels]);

  return (
    <Ctx.Provider value={{ tab, go, needsLogin, onLogin, boot, status, logs, models, toasts, toast, reload, refreshBoot, refreshStatus, refreshLogs, refreshModels }}>
      {children}
    </Ctx.Provider>
  );
}
