// LoLLM dashboard — API client (session bootstrap + streaming chat).

const BOOT = (typeof window !== 'undefined' && window.__LOLLM__) || {};
export const VERSION = BOOT.version || '';

let SESSION = BOOT.session || '';
let sessionPromise = null;

// Fallback untuk dev mode (vite) atau setelah gateway restart: ambil session per-boot.
async function ensureSession() {
  if (SESSION) return;
  if (!sessionPromise) {
    sessionPromise = fetch('/api/session')
      .then((r) => r.json())
      .then((j) => { SESSION = j.session || ''; })
      .catch(() => {});
  }
  await sessionPromise;
}

function resetSession() {
  SESSION = '';
  sessionPromise = null;
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
    // session mungkin berganti (gateway restart) — ambil ulang & coba sekali lagi
    resetSession();
    await ensureSession();
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
 * Return { text, provider, model, ms, trail }
 */
export async function streamChat({ model, messages, signal, onDelta }) {
  const t0 = performance.now();
  await ensureSession();
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lollm-session': SESSION },
    body: JSON.stringify({ model, stream: true, messages }),
    signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error?.message || 'HTTP ' + res.status);
  }
  const provider = res.headers.get('x-lollm-provider') || '?';
  const finalModel = res.headers.get('x-lollm-model') || model;
  const trailRaw = res.headers.get('x-lollm-trail') || '';

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
  return { text, provider, model: finalModel, ms: Math.round(performance.now() - t0), trail: decodeTrail(trailRaw) };
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
