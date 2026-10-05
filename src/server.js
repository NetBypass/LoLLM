// LoLLM — Server HTTP: satu port untuk dashboard (/), API (/v1), admin (/api).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Config } from './config.js';
import { Router, ApiError } from './router.js';
import { testKey } from './proxy.js';
import { CATALOG, catalogById } from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';
const MAX_BODY = 20 * 1024 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-lollm-session',
};

export async function startServer(opts = {}) {
  const port = opts.port || Number(process.env.PORT) || 5151;
  const host = opts.host || process.env.HOST || '0.0.0.0';
  const dataDir = opts.dataDir || process.env.LOLLM_HOME || path.resolve(process.cwd(), 'data');

  const config = new Config(dataDir).load();
  if (opts.noAuth) config.data.settings.authRequired = false;
  const router = new Router(config);

  // Session token dashboard (per boot)
  const sessionToken = crypto.randomBytes(24).toString('hex');
  let dashboardHtml = null;
  try {
    dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8')
      .replace('__LOLLM_SESSION__', sessionToken)
      .replace('__LOLLM_VERSION__', VERSION);
  } catch {
    dashboardHtml = `<!doctype html><html><body><h1>LoLLM</h1><p>dashboard.html tidak ditemukan.</p></body></html>`;
  }

  // ---------- helpers ----------
  const json = (res, status, obj, extraHeaders = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders });
    res.end(JSON.stringify(obj));
  };

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

  const isGatewayKey = (req) => {
    const h = req.headers['authorization'] || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    return !!m && config.data.gateway.apiKeys.includes(m[1].trim());
  };

  const isSession = (req) => req.headers['x-lollm-session'] === sessionToken;

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
      });
    }

    if (method === 'GET' && sub === 'status') {
      const up = Math.floor((Date.now() - router.stats.startedAt) / 1000);
      return json(res, 200, {
        version: VERSION, uptimeSec: up, port,
        stats: { ...router.stats, startedAt: undefined, byProvider: router.stats.byProvider },
        health: router.healthSummary(),
        settings: config.data.settings,
      });
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
      const models = await router.allModels();
      return json(res, 200, { models });
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
        return json(res, 201, { ok: true, added, skipped: results.length - added, results });
      }
      if (!b.providerId || !b.key) throw new ApiError(400, 'providerId dan key wajib');
      const key = config.addKey(b.providerId, b.key, b.label);
      return json(res, 201, { ok: true, key: sanitizeKey(key) });
    }

    if (method === 'POST' && sub === 'keys/test') {
      const b = JSON.parse(await readBody(req) || '{}');
      const key = config.findKey(b.providerId, b.keyId);
      const meta = config.providerMeta(b.providerId);
      if (!key || !meta) throw new ApiError(404, 'Key/provider tidak ditemukan');
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
      return json(res, 200, { ok: true });
    }

    if (method === 'DELETE' && sub === 'keys') {
      const b = JSON.parse(await readBody(req) || '{}');
      const ok = config.removeKey(b.providerId, b.keyId);
      if (!ok) throw new ApiError(404, 'Key tidak ditemukan');
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && sub === 'providers/toggle') {
      const b = JSON.parse(await readBody(req) || '{}');
      const p = config.ensureProvider(b.providerId);
      p.enabled = b.enabled !== false;
      config.save();
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
      return json(res, 201, { ok: true, provider: entry });
    }

    if (method === 'PUT' && sub === 'settings') {
      const b = JSON.parse(await readBody(req) || '{}');
      const s = config.data.settings;
      if (b.strategy && ['failover', 'round-robin', 'free-first'].includes(b.strategy)) s.strategy = b.strategy;
      if (Array.isArray(b.providerOrder)) s.providerOrder = b.providerOrder.filter((x) => typeof x === 'string');
      if (Number.isFinite(Number(b.maxAttempts))) s.maxAttempts = Math.min(Math.max(Number(b.maxAttempts), 1), 12);
      if (typeof b.authRequired === 'boolean') s.authRequired = b.authRequired;
      if (typeof b.allowAnyFallback === 'boolean') s.allowAnyFallback = b.allowAnyFallback;
      if (b.timeouts) {
        for (const k of ['connectMs', 'firstByteMs', 'totalMs', 'streamIdleMs']) {
          const v = Number(b.timeouts[k]);
          if (Number.isFinite(v)) s.timeouts[k] = Math.min(Math.max(v, 1000), 600000);
        }
      }
      config.save();
      return json(res, 200, { ok: true, settings: s });
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
            keys: Array.isArray(p.keys) ? p.keys.filter((k) => k && k.value !== undefined).map((k) => ({
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
      if (c.settings && typeof c.settings === 'object') {
        const s = config.data.settings;
        const inc = c.settings;
        if (['failover', 'round-robin', 'free-first'].includes(inc.strategy)) s.strategy = inc.strategy;
        if (Array.isArray(inc.providerOrder)) s.providerOrder = inc.providerOrder.filter((x) => typeof x === 'string');
        if (Number.isFinite(Number(inc.maxAttempts))) s.maxAttempts = Math.min(Math.max(Number(inc.maxAttempts), 1), 12);
        if (typeof inc.authRequired === 'boolean') s.authRequired = inc.authRequired;
        if (typeof inc.allowAnyFallback === 'boolean') s.allowAnyFallback = inc.allowAnyFallback;
        if (inc.timeouts) {
          for (const k of ['connectMs', 'firstByteMs', 'totalMs', 'streamIdleMs']) {
            const v = Number(inc.timeouts[k]);
            if (Number.isFinite(v)) s.timeouts[k] = Math.min(Math.max(v, 1000), 600000);
          }
        }
      }
      config.save();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: { message: `Endpoint /api/${sub} tidak ada` } });
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
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch {
        throw new ApiError(400, 'Body JSON tidak valid');
      }
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
      });
      return;
    }

    return json(res, 404, { error: { message: `Endpoint /v1/${sub} tidak ada`, type: 'invalid_request_error' } });
  }

  // ---------- handler utama ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }

      if (p === '/healthz') return json(res, 200, { ok: true, version: VERSION, uptimeSec: Math.floor((Date.now() - router.stats.startedAt) / 1000) });

      // Dashboard
      if (p === '/' || p === '/index.html' || p === '/favicon.ico') {
        if (p === '/favicon.ico') {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
          return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="26" font-size="26">⚡</text></svg>`);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(dashboardHtml);
      }

      // API publik
      if (p === '/v1' || p.startsWith('/v1/')) {
        if (config.data.settings.authRequired && !isGatewayKey(req) && !isSession(req)) {
          return json(res, 401, { error: { message: 'API key gateway tidak valid. Kirim header Authorization: Bearer <gateway-key>.', type: 'auth_error' } });
        }
        return await handleV1(req, res, url);
      }

      // Admin API
      if (p === '/api' || p.startsWith('/api/')) {
        if (!isSession(req) && !isGatewayKey(req)) {
          return json(res, 401, { error: { message: 'Akses dashboard ditolak.' } });
        }
        return await handleApi(req, res, url);
      }

      return json(res, 404, { error: { message: `Path ${p} tidak ada` } });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (!res.headersSent) {
        json(res, status, { error: { message: err.message || 'Internal error', ...(err.extra || {}) } });
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

  return { server, config, router, port, host, sessionToken };
}

function sanitizeKeyUnused() {} // (keep simple)
