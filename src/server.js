// LoLLM — Server HTTP: satu port untuk dashboard (/), API (/v1), admin (/api).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Config, sanitizeSettings, resolveDataDir } from './config.js';
import { Router, ApiError, routeKeyFor } from './router.js';
import { testKey } from './proxy.js';
import { validateRequest } from './params.js';
import { RateLimiter, Semaphore } from './ratelimit.js';
import { CATALOG, catalogById } from './catalog.js';
import { VERSION } from './version.js';
import { CORS_HEADERS } from './cors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 20 * 1024 * 1024;


// Path yang selalu publik (monitoring / load balancer) — tidak perlu gateway key.
const PUBLIC_PATHS = new Set(['/health', '/healthz', '/live', '/ready', '/readyz', '/health/ready', '/v1/health', '/status']);

export async function startServer(opts = {}) {
  const envPort = Number(process.env.PORT);
  const port = Number.isFinite(Number(opts.port)) && String(opts.port) !== ''
    ? Number(opts.port)
    : (Number.isFinite(envPort) && envPort > 0 ? envPort : 5151);
  const host = opts.host || process.env.HOST || '0.0.0.0';
  const dataDir = resolveDataDir(opts);

  const config = new Config(dataDir).load();
  if (opts.noAuth) config.data.settings.authRequired = false;
  const router = new Router(config);
  const limiter = new RateLimiter(config.data.settings.rateLimit);
  const gate = new Semaphore(config.data.settings.rateLimit?.maxConcurrent ?? 32);

  // Session token dashboard (per boot)
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const publicDir = path.resolve(__dirname, '..', 'public');
  const loginAttempts = new Map(); // ip → { count, resetAt } — throttle login

  const MIME = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
  };

  // Dashboard: serve build React (public/) + inject status login/sesi per boot.
  function serveDashboard(res) {
    try {
      let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
      const loginEnabled = config.data.dashboard.loginEnabled !== false;
      const inject = `<script>window.__LOLLM__=${JSON.stringify({
        version: VERSION,
        loginRequired: loginEnabled,
        session: loginEnabled ? null : sessionToken,
        defaultPassword: config.isDefaultDashboardPassword(),
      })};</script>`;
      html = html.replace('<head>', '<head>' + inject);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><head><title>LoLLM</title></head><body style="font-family:system-ui;background:#0b0f17;color:#e7ecf5;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:20px;margin:0 0 8px">LoLLM Gateway</h1><p style="color:#8b98ad;font-size:14px;margin:0">Build dashboard tidak ditemukan. Jalankan <code>npm run build:web</code>.</p></div></body></html>');
    }
  }

  // ---------- helpers ----------
  const json = (res, status, obj, extraHeaders = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders });
    res.end(JSON.stringify(obj));
  };

  const apiErrorBody = (message, type = 'server_error', extra = {}) => ({ error: { message, type, ...extra } });

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, 'Body terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const bearerToken = (req) => {
    const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : '';
  };
  const isGatewayKey = (req) => {
    const tok = bearerToken(req);
    return !!tok && config.data.gateway.apiKeys.includes(tok);
  };
  const isSession = (req) => req.headers['x-lollm-session'] === sessionToken;

  // ---------- health ----------
  function handleHealth(res, mode) {
    const up = Math.floor((Date.now() - router.stats.startedAt) / 1000);
    const health = router.healthSummary();
    const providersUp = health.filter((h) => h.state === 'up').length;
    if (mode === 'live') {
      return json(res, 200, { ok: true, status: 'alive', version: VERSION, uptimeSec: up }, { 'Cache-Control': 'no-store' });
    }
    if (mode === 'ready') {
      const r = router.readiness();
      return json(res, r.ready ? 200 : 503, {
        ok: r.ready, status: r.ready ? 'ready' : 'degraded', version: VERSION, uptimeSec: up,
        providers: { total: r.providersTotal, up: r.providersUp, usable: r.providersUsable },
        modelsKnown: r.modelsKnown,
        reasons: r.reasons,
      }, { 'Cache-Control': 'no-store' });
    }
    return json(res, 200, {
      ok: true, version: VERSION, name: 'lollm', uptimeSec: up,
      providers: { total: health.length, up: providersUp },
      stats: { requests: router.stats.requests, ok: router.stats.ok, fail: router.stats.fail, fallbacks: router.stats.fallbacks, emptyRejected: router.stats.emptyRejected, rateLimited: router.stats.rateLimited },
      rateLimit: { enabled: limiter.enabled, requestsPerMinute: limiter.perMinute, burst: limiter.burst, maxConcurrent: gate.max },
      gateway: { authRequired: config.data.settings.authRequired },
    }, { 'Cache-Control': 'no-store' });
  }

  // ---------- admin API ----------
  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const sub = parts.slice(1).join('/');
    const method = req.method;

    if (method === 'GET' && sub === 'bootstrap') {
      const providers = {};
      for (const id of config.configuredProviderIds()) {
        const meta = config.providerMeta(id);
        if (!meta) continue;
        providers[id] = { ...config.data.providers[id], meta: { name: meta.name, tier: meta.tier, baseUrl: meta.baseUrl } };
      }
      return json(res, 200, {
        version: VERSION,
        catalog: CATALOG,
        customProviders: config.data.customProviders,
        providers,
        settings: config.data.settings,
        gatewayKeys: config.data.gateway.apiKeys,
        dashboard: {
          loginEnabled: config.data.dashboard.loginEnabled !== false,
          defaultPassword: config.isDefaultDashboardPassword(),
        },
      });
    }

    if (method === 'GET' && sub === 'status') {
      const up = Math.floor((Date.now() - router.stats.startedAt) / 1000);
      return json(res, 200, {
        version: VERSION, uptimeSec: up, port,
        stats: { ...router.stats, startedAt: undefined, byProvider: router.stats.byProvider },
        health: router.healthSummary(),
        settings: config.data.settings,
        routing: router.routingInsight(),
        rateLimit: {
          enabled: limiter.enabled, requestsPerMinute: limiter.perMinute, burst: limiter.burst,
          maxConcurrent: gate.max, inFlight: gate.active, trackedClients: limiter.buckets.size,
        },
      });
    }

    // Transparansi routing: lihat apa yang akan dipilih 'auto' + alasannya.
    if (method === 'GET' && (sub === 'routing/auto' || sub === 'routing/preview')) {
      const task = url.searchParams.get('task') || 'chat';
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 200);
      return json(res, 200, await router.previewAuto({ task, limit }));
    }

    if (method === 'POST' && sub === 'routing/warmup') {
      const r = await router.warmup({ force: true });
      return json(res, 200, { ok: true, ...r });
    }

    if (method === 'GET' && sub === 'logs') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
      return json(res, 200, { logs: router.logs.slice(-limit).reverse() });
    }

    if (method === 'POST' && sub === 'logs/clear') {
      router.logs = [];
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && sub === 'models') {
      if (url.searchParams.get('refresh')) router.invalidateModels();
      const includeHidden = url.searchParams.get('hidden') === '1';
      const models = await router.allModels({ includeHidden });
      return json(res, 200, { models, hiddenCount: config.data.settings.hiddenModels.length });
    }

    // "Hapus" model live berarti sembunyikan secara persisten dari katalog dan routing;
    // model upstream tidak mungkin dihapus dari server milik provider.
    if (method === 'DELETE' && sub === 'models') {
      const b = JSON.parse(await readBody(req) || '{}');
      const visible = await router.allModels({ includeHidden: false });
      const requested = b.all === true ? visible : (Array.isArray(b.models) ? b.models : []);
      const valid = requested.slice(0, 10000)
        .map((m) => typeof m === 'string' ? m : `${m?.provider || ''}:${m?.id || ''}`)
        .filter((key) => visible.some((m) => `${m.provider}:${m.id}` === key));
      if (!valid.length) throw new ApiError(400, 'Pilih minimal satu model yang valid');
      config.data.settings.hiddenModels = [...new Set([...config.data.settings.hiddenModels, ...valid])];
      config.save();
      router.invalidateModels();
      return json(res, 200, { ok: true, removed: valid.length, hiddenCount: config.data.settings.hiddenModels.length });
    }

    if (method === 'POST' && sub === 'models/restore') {
      const b = JSON.parse(await readBody(req) || '{}');
      const keys = Array.isArray(b.models) ? new Set(b.models.map(String)) : null;
      const before = config.data.settings.hiddenModels.length;
      config.data.settings.hiddenModels = b.all === true
        ? []
        : config.data.settings.hiddenModels.filter((key) => !keys?.has(key));
      config.save();
      router.invalidateModels();
      return json(res, 200, { ok: true, restored: before - config.data.settings.hiddenModels.length });
    }

    if (method === 'POST' && sub === 'keys') {
      const b = JSON.parse(await readBody(req) || '{}');
      // Bulk: { providerId, keys: [..], label? }
      if (Array.isArray(b.keys)) {
        if (!b.providerId) throw new ApiError(400, 'providerId wajib');
        const results = [];
        for (const raw of b.keys.slice(0, 200)) {
          const v = String(raw || '').trim();
          if (!v) continue;
          try {
            const key = config.addKey(b.providerId, v, b.label);
            results.push({ ok: true, label: key.label });
          } catch (e) {
            results.push({ ok: false, key: v.slice(0, 6) + '…', error: e.message });
          }
        }
        const added = results.filter((r) => r.ok).length;
        if (added === 0 && results.length > 0) throw new ApiError(400, results[0].error || 'Tidak ada key valid');
        router.invalidateModels(b.providerId);
        return json(res, 201, { ok: true, added, skipped: results.length - added, results });
      }
      if (!b.providerId || !b.key) throw new ApiError(400, 'providerId dan key wajib');
      const key = config.addKey(b.providerId, b.key, b.label);
      router.invalidateModels(b.providerId);
      return json(res, 201, { ok: true, key: sanitizeKey(key) });
    }

    if (method === 'POST' && sub === 'keys/test') {
      const b = JSON.parse(await readBody(req) || '{}');
      const key = config.findKey(b.providerId, b.keyId);
      const meta = config.providerMeta(b.providerId);
      if (!key || !meta) throw new ApiError(404, 'Key/provider tidak ditemukan');
      router.invalidateModels(b.providerId);
      const result = await testKey(meta, key);
      if (result.ok && key.status === 'dead') { key.status = 'ok'; key.cooldownUntil = 0; config.save(); }
      if (result.ok && key.cooldownUntil) { key.cooldownUntil = 0; config.save(); }
      return json(res, 200, { ...result, revived: result.ok });
    }

    if (method === 'POST' && sub === 'keys/toggle') {
      const b = JSON.parse(await readBody(req) || '{}');
      const key = config.findKey(b.providerId, b.keyId);
      if (!key) throw new ApiError(404, 'Key tidak ditemukan');
      key.enabled = b.enabled !== false;
      config.save();
      router.invalidateModels(b.providerId);
      return json(res, 200, { ok: true });
    }

    if (method === 'DELETE' && sub === 'keys') {
      const b = JSON.parse(await readBody(req) || '{}');
      const ok = config.removeKey(b.providerId, b.keyId);
      if (!ok) throw new ApiError(404, 'Key tidak ditemukan');
      router.invalidateModels(b.providerId);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && sub === 'providers/toggle') {
      const b = JSON.parse(await readBody(req) || '{}');
      const p = config.ensureProvider(b.providerId);
      p.enabled = b.enabled !== false;
      config.save();
      router.invalidateModels(b.providerId);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && sub === 'providers/custom') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.name || !b.baseUrl) throw new ApiError(400, 'name dan baseUrl wajib');
      const id = String(b.id || b.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || 'custom';
      if (catalogById(id)) throw new ApiError(409, `Id "${id}" bentrok dengan katalog bawaan`);
      const existing = config.data.customProviders.find((c) => c.id === id);
      const entry = {
        id, name: String(b.name).slice(0, 40),
        tier: 'custom', style: b.style === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: String(b.baseUrl).replace(/\/+$/, ''),
        getKey: null, note: 'Custom provider',
        defaultModel: b.defaultModel || '', models: b.models || [],
        priority: 60,
      };
      if (existing) Object.assign(existing, entry);
      else config.data.customProviders.push(entry);
      config.ensureProvider(id);
      config.save();
      router.invalidateModels();
      return json(res, 201, { ok: true, provider: entry });
    }

    if (method === 'PUT' && sub === 'settings') {
      const b = JSON.parse(await readBody(req) || '{}');
      sanitizeSettings(config.data.settings, b);
      config.save();
      limiter.reconfigure(config.data.settings.rateLimit);
      gate.setMax(config.data.settings.rateLimit.maxConcurrent);
      router.invalidateModels(); // kebijakan routing memengaruhi pilihan 'auto'
      return json(res, 200, { ok: true, settings: config.data.settings });
    }

    if (method === 'POST' && sub === 'gateway/rotate') {
      const key = 'lollm-' + crypto.randomBytes(20).toString('hex');
      config.data.gateway.apiKeys = [key];
      config.save();
      return json(res, 200, { ok: true, apiKey: key });
    }

    // Backup / restore penuh (PERINGATAN: berisi API key asli)
    if (method === 'GET' && sub === 'config/export') {
      return json(res, 200, config.data);
    }

    if (method === 'POST' && sub === 'config/import') {
      const b = JSON.parse(await readBody(req) || '{}');
      const c = b.config;
      if (!c || typeof c !== 'object') throw new ApiError(400, 'Field "config" tidak valid');
      if (Array.isArray(c.customProviders)) {
        const ids = new Set(CATALOG.map((p) => p.id));
        config.data.customProviders = c.customProviders.filter((p) => p && p.id && p.baseUrl && !ids.has(p.id));
      }
      if (c.providers && typeof c.providers === 'object') {
        const clean = {};
        for (const [id, p] of Object.entries(c.providers)) {
          if (!p || typeof p !== 'object') continue;
          clean[id] = {
            enabled: p.enabled !== false,
            keys: Array.isArray(p.keys) ? p.keys.filter((k) => k.value !== undefined).map((k) => ({
              id: k.id || 'k_' + crypto.randomBytes(6).toString('hex'),
              label: k.label || 'key',
              value: String(k.value || ''),
              addedAt: k.addedAt || Date.now(),
              status: k.status === 'dead' ? 'dead' : 'ok',
              enabled: k.enabled !== false,
              failCount: 0, success: k.success || 0, fail: k.fail || 0,
              cooldownUntil: 0,
            })) : [],
          };
        }
        config.data.providers = clean;
        // Pastikan provider keyless default tetap ada (tanpa membaca ulang file lama)
        config.ensureKeylessDefaults();
      }
      if (c.settings && typeof c.settings === 'object') sanitizeSettings(config.data.settings, c.settings);
      config.save();
      limiter.reconfigure(config.data.settings.rateLimit);
      gate.setMax(config.data.settings.rateLimit.maxConcurrent);
      router.invalidateModels();
      return json(res, 200, { ok: true });
    }

    // ---- Admin: dashboard & statistik ----
    if (method === 'PUT' && sub === 'dashboard') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (typeof b.loginEnabled === 'boolean') {
        config.data.dashboard.loginEnabled = b.loginEnabled;
        config.save();
      }
      return json(res, 200, {
        ok: true,
        dashboard: {
          loginEnabled: config.data.dashboard.loginEnabled !== false,
          defaultPassword: config.isDefaultDashboardPassword(),
        },
      });
    }

    if (method === 'POST' && sub === 'dashboard/password') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (!config.verifyDashboardPassword(b.current)) throw new ApiError(401, 'Password saat ini salah');
      const next = String(b.next || '');
      if (next.length < 6) throw new ApiError(400, 'Password baru minimal 6 karakter');
      config.setDashboardPassword(next);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && sub === 'stats/reset') {
      router.stats = router.emptyStats();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, apiErrorBody(`Endpoint /api/${sub} tidak ada`, 'invalid_request_error'));
  }

  function sanitizeKey(key) {
    return { ...key };
  }

  // ---------- OpenAI-compatible /v1 ----------
  async function handleV1(req, res, url) {
    const sub = url.pathname.replace(/^\/v1\/?/, '');

    if (req.method === 'GET' && (sub === 'models' || sub === '')) {
      const models = await router.allModels();
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => ({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider })),
      });
    }

    if (req.method === 'POST' && ['chat/completions', 'completions', 'embeddings'].includes(sub)) {
      // ---- rate limit (per gateway key, fallback IP) ----
      const rlKey = rateIdentity(req);
      const rl = limiter.check(rlKey);
      const rlHeaders = {
        'x-ratelimit-limit': String(limiter.perMinute),
        'x-ratelimit-remaining': String(rl.remaining),
        'x-ratelimit-window': '60',
      };
      if (!rl.allowed) {
        router.stats.rateLimited++;
        return json(res, 429, apiErrorBody(
          `Rate limit ${limiter.perMinute} request/menit tercapai. Tunggu ${rl.retryAfterSec}s lalu kirim lagi (retry otomatis dengan backoff disarankan).`,
          'rate_limit_error', { code: 429, retry_after: rl.retryAfterSec }
        ), { ...rlHeaders, 'Retry-After': String(rl.retryAfterSec) });
      }

      // ---- batas konkurensi: 429 jelas > jawaban kosong diam-diam ----
      let acquired = gate.tryAcquire();
      if (!acquired) {
        acquired = await Promise.race([
          gate.acquire().then(() => true),
          new Promise((r) => setTimeout(() => r(false), 5000)),
        ]);
      }
      if (!acquired) {
        router.stats.rateLimited++;
        return json(res, 429, apiErrorBody(
          `Gateway sibuk: ${gate.active}/${gate.max} request sedang berjalan. Coba lagi sebentar.`,
          'rate_limit_error', { code: 429, retry_after: 2 }
        ), { ...rlHeaders, 'Retry-After': '2' });
      }

      try {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch {
          throw new ApiError(400, 'Body JSON tidak valid', { type: 'invalid_request_error', param: 'body' });
        }
        // ---- validasi input → 400, bukan jawaban ngawur ----
        validateRequest(sub, body);

        const stream = body.stream === true;
        const requestId = 'req_' + crypto.randomBytes(6).toString('hex');

        // Propagasi disconnect client ke attempt upstream
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(new Error('client-aborted')); });

        const result = await router.route({
          path: sub,
          body,
          stream,
          clientRes: res,
          signal: ac.signal,
          requestId,
          routeKey: routeKeyFor(body, req.headers),
          extraHeaders: rlHeaders,
        });
        return result;
      } finally {
        gate.release();
      }
    }

    return json(res, 404, apiErrorBody(`Endpoint /v1/${sub} tidak ada`, 'invalid_request_error'));
  }

  function rateIdentity(req) {
    const tok = bearerToken(req);
    if (tok) return 'k:' + hash32(tok);
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return 'ip:' + (fwd || req.socket?.remoteAddress || '?');
  }

  // ---------- handler utama ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' });
        return res.end();
      }

      // Health / monitoring — selalu publik & murah.
      if (p === '/healthz' || p === '/health' || p === '/status') return handleHealth(res, 'full');
      if (p === '/live' || p === '/livez') return handleHealth(res, 'live');
      if (p === '/ready' || p === '/readyz' || p === '/health/ready') return handleHealth(res, 'ready');
      if (p === '/v1/health' || p === '/v1/healthz') return handleHealth(res, 'full');

      // Static assets dashboard (nama file hashed → cache immutable)
      if (p.startsWith('/assets/')) {
        const rel = path.normalize(p.slice('/assets/'.length)).replace(/^(\.\.[/\\])+/g, '');
        const file = path.join(publicDir, 'assets', rel);
        if (!file.startsWith(path.join(publicDir, 'assets') + path.sep) && file !== path.join(publicDir, 'assets')) {
          return json(res, 404, apiErrorBody('Not found', 'invalid_request_error'));
        }
        return fs.readFile(file, (err, data) => {
          if (err) return json(res, 404, apiErrorBody('Not found', 'invalid_request_error'));
          const ext = path.extname(file).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
          });
          res.end(data);
        });
      }

      // Dashboard
      if (p === '/' || p === '/index.html' || p === '/favicon.ico') {
        if (p === '/favicon.ico') {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
          return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#00d4ff"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="#0b0f17"/><path fill="url(#g)" d="M13 2 4.5 13.5h5.2L10 22l8.5-11.5h-5.2L13 2z"/></svg>`);
        }
        return serveDashboard(res);
      }

      // Session untuk dev mode / re-bootstrap setelah restart.
      // Saat login dashboard aktif, session HANYA diberikan lewat POST /api/login.
      if (p === '/api/session') {
        if (config.data.dashboard.loginEnabled !== false) {
          return json(res, 401, apiErrorBody('Login dashboard diperlukan', 'authentication_error', { loginRequired: true }));
        }
        return json(res, 200, { session: sessionToken, version: VERSION });
      }

      // Login dashboard — throttle 10 percobaan/menit per IP
      if (p === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || '?';
        const now = Date.now();
        const rec = loginAttempts.get(ip);
        if (rec && rec.count >= 10 && now < rec.resetAt) {
          return json(res, 429, apiErrorBody('Terlalu banyak percobaan login. Tunggu sebentar.', 'rate_limit_error'), { 'Retry-After': String(Math.max(1, Math.ceil((rec.resetAt - now) / 1000))) });
        }
        let b = {};
        try { b = JSON.parse(await readBody(req) || '{}'); } catch { /* body kosong */ }
        if (config.verifyDashboardPassword(b.password)) {
          loginAttempts.delete(ip);
          return json(res, 200, { ok: true, session: sessionToken });
        }
        loginAttempts.set(ip, { count: (rec && now < rec.resetAt ? rec.count : 0) + 1, resetAt: now + 60_000 });
        if (loginAttempts.size > 1000) for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
        return json(res, 401, apiErrorBody('Password salah', 'authentication_error', { wrongPassword: true }));
      }

      // API publik
      if (p === '/v1' || p.startsWith('/v1/')) {
        if (config.data.settings.authRequired && !isGatewayKey(req) && !isSession(req) && !PUBLIC_PATHS.has(p)) {
          return json(res, 401, apiErrorBody(
            'API key gateway tidak valid. Kirim header Authorization: Bearer <gateway-key>.',
            'authentication_error', { code: 'invalid_api_key' }
          ));
        }
        return await handleV1(req, res, url);
      }

      // Admin API
      if (p === '/api' || p.startsWith('/api/')) {
        if (!isSession(req) && !isGatewayKey(req)) {
          return json(res, 401, apiErrorBody('Akses dashboard ditolak.', 'authentication_error'));
        }
        return await handleApi(req, res, url);
      }

      return json(res, 404, apiErrorBody(`Path ${p} tidak ada`, 'invalid_request_error'));
    } catch (err) {
      const status = err.status || (err instanceof ApiError ? err.status : 500);
      const type = err.type || (status >= 500 ? 'server_error' : 'invalid_request_error');
      if (!res.headersSent) {
        const extra = { ...(err.extra || {}) };
        for (const k of ['param', 'code', 'retry_after', 'available', 'trail']) if (err[k] !== undefined) extra[k] = err[k];
        json(res, status, apiErrorBody(err.message || 'Internal error', type, { code: status, param: err.param ?? null, ...extra }));
      } else {
        res.end();
      }
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address()?.port || port;

  // ---- Warm-up: pangkas latensi request pertama ----
  // Cache daftar model + koneksi TLS sudah panas sebelum traffic masuk; lalu dijaga tetap segar.
  if (config.data.settings.warmup?.enabled !== false) {
    router.warmup().catch(() => {});
    router.startMaintenance(config.data.settings.warmup?.intervalMs || 240_000);
  }

  return { server, config, router, port: actualPort, requestedPort: port, host, sessionToken, limiter, gate };
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
