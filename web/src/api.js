// LoLLM dashboard — API client (session, login, streaming chat).

const BOOT = (typeof window !== 'undefined' && window.__LOLLM__) || {};
export const VERSION = BOOT.version || '';

let SESSION = BOOT.session || '';
try { if (!SESSION && typeof sessionStorage !== 'undefined') SESSION = sessionStorage.getItem('lollm-session') || ''; } catch { /* ignore */ }

let sessionPromise = null;

export function hasSession() {
  return !!SESSION;
}

export function setSession(s) {
  SESSION = s || '';
  try { sessionStorage.setItem('lollm-session', SESSION); } catch { /* ignore */ }
  if (SESSION) sessionPromise = null;
}

function clearSession() {
  SESSION = '';
  sessionPromise = null;
  try { sessionStorage.removeItem('lollm-session'); } catch { /* ignore */ }
}

function needsLoginEvent() {
  try { dispatchEvent(new CustomEvent('lollm:needs-login')); } catch { /* ignore */ }
}

// Untuk dev mode (vite) atau setelah gateway restart dengan login nonaktif.
async function ensureSession() {
  if (SESSION) return;
  if (!sessionPromise) {
    sessionPromise = fetch('/api/session')
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (j?.session) { setSession(j.session); return; }
        if (j?.error?.loginRequired || r.status === 401) needsLoginEvent();
      })
      .catch(() => {});
  }
  await sessionPromise;
}

export async function login(password) {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error?.message || 'Login gagal');
    err.wrongPassword = !!j?.error?.wrongPassword;
    err.tooMany = r.status === 429;
    throw err;
  }
  setSession(j.session);
  return j;
}

export async function logout() {
  clearSession();
  needsLoginEvent();
}

export async function api(path, opts = {}) {
  await ensureSession();
  const o = {
    method: opts.method || 'GET',
    headers: { 'x-lollm-session': SESSION, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  };
  if (opts.body) o.body = JSON.stringify(opts.body);
  let r = await fetch('/api/' + path, o);
  if (r.status === 401) {
    const j = await r.json().catch(() => ({}));
    if (j?.error?.loginRequired) {
      clearSession();
      needsLoginEvent();
      throw new Error('Login diperlukan');
    }
    // session basi (gateway restart & login nonaktif) — ambil ulang sekali
    clearSession();
    await ensureSession();
    if (!SESSION) throw new Error('Login diperlukan');
    o.headers['x-lollm-session'] = SESSION;
    r = await fetch('/api/' + path, o);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || j?.error || 'HTTP ' + r.status);
  return j;
}

export function decodeTrail(b64) {
  try {
    const s = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(s); // array "provider/key:kind"
  } catch { return []; }
}

/**
 * Streaming chat ke /v1/chat/completions (SSE). onDelta dipanggil dengan teks kumulatif.
 * Metadata gateway dibaca dari header x-lollm-* supaya user tahu model mana yang
 * benar-benar menjawab dan apakah fallback terjadi.
 * Return { text, provider, model, requestedModel, task, selection, fallbacks, lowConfidence, ms, trail }
 */
export async function streamChat({ model, messages, signal, onDelta, params }) {
  const t0 = performance.now();
  await ensureSession();
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lollm-session': SESSION },
    body: JSON.stringify({ model, stream: true, messages, ...(params || {}) }),
    signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(j?.error?.message || 'HTTP ' + res.status);
    err.status = res.status;
    err.code = j?.error?.code;
    throw err;
  }
  const h = res.headers;
  const meta = {
    provider: h.get('x-lollm-provider') || '?',
    model: h.get('x-lollm-model') || model,
    requestedModel: h.get('x-lollm-requested-model') || model,
    task: h.get('x-lollm-task') || '',
    selection: h.get('x-lollm-selection') || '',
    selectionReason: h.get('x-lollm-selection-reason') || '',
    fallbacks: Number(h.get('x-lollm-fallbacks') || 0),
    attempts: Number(h.get('x-lollm-attempts') || 1),
    lowConfidence: h.get('x-lollm-low-confidence') === 'true',
    emptyRetries: Number(h.get('x-lollm-empty-retries') || 0),
    params: decodeParams(h.get('x-lollm-params')),
    trail: decodeTrail(h.get('x-lollm-trail') || ''),
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta?.content;
        if (d) { text += d; onDelta?.(text); }
      } catch { /* lewati baris rusak */ }
    }
  }
  return { text, ...meta, ms: Math.round(performance.now() - t0) };
}

/** x-lollm-params: base64url "adjusted=a:1→2 | ignored=b" */
function decodeParams(b64) {
  if (!b64) return null;
  try {
    const s = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
    const out = { raw: s, adjusted: [], ignored: [], unknown: [] };
    for (const part of s.split(' | ')) {
      const [k, v] = part.split('=');
      if (k === 'adjusted') out.adjusted = v.split(',');
      else if (k === 'ignored') out.ignored = v.split(',');
      else if (k === 'unknown') out.unknown = v.split(',');
    }
    return out;
  } catch { return null; }
}

// ---------- clipboard ----------
// Salin teks dengan rantai fallback: Clipboard API → execCommand → prompt manual.
// Wajib ada fallback: navigator.clipboard gagal di iframe (butuh permission
// clipboard-write) dan di konteks http non-localhost.
export async function copyText(text) {
  const s = String(text ?? '');
  if (!s) return false;

  // 1) Clipboard API — hanya jalan di secure context & dengan permission
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* jatuh ke fallback */ }

  // 2) execCommand('copy') — deprecated tapi bekerja di hampir semua konteks (http, iframe)
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    const sel = document.getSelection();
    const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (savedRange) { try { sel.removeAllRanges(); sel.addRange(savedRange); } catch { /* ignore */ } }
    if (ok) return true;
  } catch { /* jatuh ke fallback */ }

  // 3) Terakhir: prompt supaya user tetap bisa menyalin manual
  try { window.prompt('Klik teks lalu salin manual (Ctrl+C / Cmd+C):', s); } catch { /* ignore */ }
  return false;
}

// ---------- format helpers ----------
export const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');
export const fmtNum = (n) => (n ?? 0).toLocaleString('id');
export const fmtUptime = (s) =>
  s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';

export function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 5000) return 'baru saja';
  if (d < 60000) return Math.floor(d / 1000) + 's lalu';
  if (d < 3600000) return Math.floor(d / 60000) + 'm lalu';
  return new Date(ts).toLocaleTimeString('id');
}
