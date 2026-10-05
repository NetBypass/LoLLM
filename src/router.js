// LoLLM — Router: resolusi model → rantai kandidat (key × provider) → loop fallback 0ms.
// Daftar model SELALU live dari endpoint provider — tanpa hint/template/dummy.

import { runAttempt, UpstreamError } from './proxy.js';
import {
  pickKey, reportSuccess, reportFailure, providerUsable, providerHealthy, keySummary,
} from './pool.js';

const MODELS_TTL_MS = 10 * 60 * 1000; // cache daftar model live (sukses)
const MODELS_EMPTY_TTL_MS = 30 * 1000; // gagal/kosong → coba lagi cepat, jangan pakai data palsu
const MAX_LOGS = 500;

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class Router {
  constructor(config) {
    this.config = config;
    this.modelsCache = new Map(); // providerId → { ts, models[] }
    this.inflight = new Map();
    this.rrIndex = 0;
    this.stats = this.emptyStats();
    this.logs = [];
  }

  emptyStats() {
    return {
      startedAt: Date.now(),
      requests: 0, ok: 0, fail: 0,
      fallbacks: 0, // jumlah perpindahan kandidat
      totalMs: 0,
      tokensIn: 0, tokensOut: 0,
      byProvider: {}, // id → { ok, fail, ms }
    };
  }

  bumpProvider(id, field, ms = 0) {
    const p = (this.stats.byProvider[id] = this.stats.byProvider[id] || { ok: 0, fail: 0, ms: 0 });
    p[field]++;
    p.ms += ms;
  }

  pushLog(entry) {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.shift();
  }

  // ---- Urutan provider efektif ----
  providerOrder() {
    const s = this.config.data.settings;
    const ids = new Set(this.config.configuredProviderIds());
    const order = [];
    for (const id of s.providerOrder) if (ids.has(id)) { order.push(id); ids.delete(id); }
    const rest = [...ids].sort((a, b) => {
      const pa = this.config.providerMeta(a)?.priority ?? 999;
      const pb = this.config.providerMeta(b)?.priority ?? 999;
      return pa - pb;
    });
    return [...order, ...rest];
  }

  availableProviders(now = Date.now()) {
    return this.providerOrder()
      .map((id) => ({ id, pconf: this.config.data.providers[id], meta: this.config.providerMeta(id) }))
      .filter((p) => p.pconf && p.meta && providerUsable(p.pconf, now));
  }

  // ---- Live model list (cache) ----
  // Gagal fetch = kosong (cache 30s). Sukses = cache 10 menit. Tidak pernah ada daftar palsu.
  async liveModels(id, pconf, meta) {
    const cached = this.modelsCache.get(id);
    if (cached) {
      const ttl = cached.models.length ? MODELS_TTL_MS : MODELS_EMPTY_TTL_MS;
      if (Date.now() - cached.ts < ttl) return cached.models;
    }
    if (this.inflight.has(id)) return this.inflight.get(id);

    const key = pickKey(pconf);
    const task = (async () => {
      const base = (meta.baseUrl || '').replace(/\/+$/, '');
      const url = meta.style === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
      const headers = {};
      if (meta.style === 'anthropic') {
        if (key?.value) headers['x-api-key'] = key.value;
        headers['anthropic-version'] = '2023-06-01';
      } else if (key?.value) {
        headers['Authorization'] = `Bearer ${key.value}`;
      }
      Object.assign(headers, meta.extraHeaders || {});
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10_000);
      try {
        const res = await fetch(url, { headers, signal: ac.signal });
        if (!res.ok) throw new Error(String(res.status));
        const j = await res.json();
        const models = (j?.data || []).map((m) => m.id).filter(Boolean);
        this.modelsCache.set(id, { ts: Date.now(), models });
        return models;
      } catch {
        // Endpoint tidak bisa dihubungi → KOSONG, bukan daftar palsu.
        this.modelsCache.set(id, { ts: Date.now(), models: [] });
        return [];
      } finally {
        clearTimeout(timer);
        this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, task);
    return task;
  }

  // Bust cache daftar model (dipanggil setelah key/provider berubah).
  invalidateModels(providerId) {
    if (providerId) this.modelsCache.delete(providerId);
    else this.modelsCache.clear();
  }

  async allModels() {
    const out = [];
    const seen = new Set();
    for (const p of this.availableProviders()) {
      let models = [];
      try { models = await this.liveModels(p.id, p.pconf, p.meta); } catch { /* kosong */ }
      for (const m of models) {
        const k = `${p.id}:${m}`;
        if (!seen.has(k)) { seen.add(k); out.push({ id: m, provider: p.id }); }
      }
    }
    return out;
  }

  // ---- Resolusi model → targets [{providerId, model}] ----
  // Semua keputusan memakai daftar model LIVE dari endpoint. Tanpa alias/template.
  async resolveTargets(model) {
    const now = Date.now();
    const avail = this.availableProviders(now);
    if (avail.length === 0) return [];

    // 1) auto → provider sehat pertama yang punya model live, pakai model pertamanya
    if (model === 'auto' || model === 'lollm' || model === 'lollm-auto') {
      for (const p of avail) {
        if (!providerHealthy(p.pconf, now)) continue;
        const models = await this.liveModels(p.id, p.pconf, p.meta);
        if (models.length > 0) return [{ providerId: p.id, model: models[0] }];
      }
      return [];
    }

    // 2) Pin provider: "groq/llama-..." — percaya user, langsung pakai
    const pin = model.match(/^([a-z0-9_-]+)[/:](.+)$/i);
    if (pin) {
      const provId = pin[1].toLowerCase();
      const rest = pin[2];
      const p = avail.find((x) => x.id === provId);
      if (p) return [{ providerId: p.id, model: rest }];
    }

    // 3) Model persis ada di daftar live provider (urut prioritas)
    const targets = [];
    for (const p of avail) {
      let models = [];
      try { models = await this.liveModels(p.id, p.pconf, p.meta); } catch { /* kosong */ }
      if (models.includes(model)) targets.push({ providerId: p.id, model });
    }
    return targets;
  }

  // ---- Loop utama ----
  /**
   * route({ path, body, stream, clientRes, signal, requestId })
   * Menulis response ke clientRes (baik sukses maupun error akhir).
   * Return { ok, providerId, model, status, ms, trail }
   */
  async route({ path, body, stream, clientRes, signal, requestId }) {
    const t0 = Date.now();
    const settings = this.config.data.settings;
    const requestedModel = body.model || 'auto';
    this.stats.requests++;

    const trail = [];
    const fail = (status, message, extra = {}) => {
      this.stats.fail++;
      this.pushLog({
        ts: Date.now(), requestId, model: requestedModel, stream,
        status, ms: Date.now() - t0, trail,
      });
      if (!clientRes.headersSent) {
        clientRes.writeHead(status, { 'Content-Type': 'application/json', 'x-lollm-trail': encodeTrail(trail) });
        clientRes.end(JSON.stringify({ error: { message, type: 'lollm_error', code: status, ...extra } }));
      } else {
        clientRes.end();
      }
      return { ok: false, status, ms: Date.now() - t0, trail };
    };

    let plans = await this.resolveTargets(requestedModel);

    // Last resort: provider sehat mana pun + model live pertamanya
    if (settings.allowAnyFallback && path === 'chat/completions') {
      const now = Date.now();
      const already = new Set(plans.map((p) => p.providerId));
      for (const p of this.availableProviders(now)) {
        if (already.has(p.id)) continue;
        let models = [];
        try { models = await this.liveModels(p.id, p.pconf, p.meta); } catch { /* kosong */ }
        if (models.length > 0) plans.push({ providerId: p.id, model: models[0], anyFallback: true });
      }
    }

    if (plans.length === 0) {
      const models = (await this.allModels().catch(() => [])).slice(0, 30).map((m) => m.id);
      return fail(404, `Model "${requestedModel}" tidak tersedia. Daftar model diambil live dari endpoint provider — kosong berarti belum ada API key aktif atau endpoint belum bisa dihubungi. Tambahkan API key di dashboard, lalu cek /v1/models.`, { available: [...new Set(models)] });
    }

    // Round-robin: rotasi urutan plans
    if (settings.strategy === 'round-robin') {
      this.rrIndex = (this.rrIndex + 1) % plans.length;
      plans = [...plans.slice(this.rrIndex), ...plans.slice(0, this.rrIndex)];
    }

    const usedAny = [];
    let attemptsLeft = Math.max(1, settings.maxAttempts);
    let lastErr = null;

    for (const plan of plans) {
      if (attemptsLeft <= 0) break;
      const pconf = this.config.data.providers[plan.providerId];
      const meta = this.config.providerMeta(plan.providerId);
      if (!pconf || !meta) continue;

      const triedKeys = new Set();
      while (attemptsLeft > 0) {
        const key = pickKey(pconf);
        if (!key || triedKeys.has(key.id)) break; // pool provider ini habis
        triedKeys.add(key.id);

        const attemptBody = { ...body, model: plan.model };
        let usage = null;
        // Best-effort token counting pada stream pass-through
        const onUsage = stream
          ? {
              scan: (chunk) => {
                const s = chunk.toString('utf8');
                const m = s.match(/"usage"\s*:\s*\{[^}]*"prompt_tokens"\s*:\s*(\d+)[^}]*"completion_tokens"\s*:\s*(\d+)/);
                if (m) usage = { prompt_tokens: +m[1], completion_tokens: +m[2] };
              },
              report: (u) => { usage = u; },
            }
          : { report: (u) => { usage = u; } };

        try {
          const result = await runAttempt({
            pconf, meta, key, path,
            body: attemptBody, stream,
            settings, clientSignal: signal, clientRes,
            onUsage: { scan: onUsage.scan, report: onUsage.report },
            streamHeaders: {
              'x-lollm-provider': plan.providerId,
              'x-lollm-model': plan.model,
              'x-lollm-trail': encodeTrail(trail),
            },
          });

          // Sukses
          reportSuccess(pconf, key.id);
          const ms = Date.now() - t0;
          this.stats.ok++;
          this.stats.totalMs += ms;
          this.stats.fallbacks += trail.length;
          this.bumpProvider(plan.providerId, 'ok', ms);
          if (plan.anyFallback) usedAny.push(plan.providerId);

          // Parse usage non-stream
          if (!stream && result.buffer) {
            try {
              const j = JSON.parse(result.buffer.toString('utf8'));
              if (j.usage) usage = j.usage;
            } catch { /* ignore */ }
          }
          if (usage) {
            this.stats.tokensIn += usage.prompt_tokens || 0;
            this.stats.tokensOut += usage.completion_tokens || 0;
          }

          if (!stream && !clientRes.headersSent) {
            clientRes.writeHead(result.status, {
              'Content-Type': 'application/json',
              'x-lollm-provider': plan.providerId,
              'x-lollm-model': plan.model,
              'x-lollm-trail': encodeTrail(trail),
            });
            clientRes.end(result.buffer);
          }

          this.pushLog({
            ts: Date.now(), requestId, model: requestedModel, finalModel: plan.model,
            provider: plan.providerId, key: key.label, stream, status: 200, ms,
            usage: usage ? `${usage.prompt_tokens || 0}→${usage.completion_tokens || 0}` : '',
            anyFallback: plan.anyFallback || false,
            trail,
          });
          this.config.save();
          return { ok: true, providerId: plan.providerId, model: plan.model, status: 200, ms, trail };
        } catch (err) {
          if (err instanceof UpstreamError && err.kind === 'aborted') {
            this.pushLog({ ts: Date.now(), requestId, model: requestedModel, stream, status: 'aborted', ms: Date.now() - t0, trail });
            return { ok: false, status: 499, ms: Date.now() - t0, trail };
          }
          lastErr = err;
          reportFailure(pconf, key.id, err.kind || 'network', { error: err.message, retryAfterSec: err.retryAfterSec });
          trail.push({
            provider: plan.providerId, key: key.label, model: plan.model,
            kind: err.kind, status: err.status || 0, error: String(err.message).slice(0, 160),
            ms: Date.now() - t0,
          });
          this.bumpProvider(plan.providerId, 'fail');
          attemptsLeft--;

          // Error client (400 dst): jangan habiskan key lain di provider yang sama — beda provider mungkin menerimanya.
          if (err.kind === 'client') break;
          continue;
        }
      }
    }

    return fail(502, `Semua kandidat gagal${lastErr ? ` — terakhir: ${String(lastErr.message).slice(0, 200)}` : ''}.`, { trail });
  }

  // ---- Health ringkas untuk dashboard ----
  healthSummary() {
    const now = Date.now();
    const out = [];
    for (const id of this.config.configuredProviderIds()) {
      const pconf = this.config.data.providers[id];
      const meta = this.config.providerMeta(id);
      if (!meta) continue;
      const keys = keySummary(pconf);
      const state = pconf.enabled === false ? 'off'
        : keys.ok > 0 ? 'up'
        : keys.cooling > 0 ? 'cooling'
        : keys.dead + keys.disabled > 0 ? 'down'
        : 'empty';
      out.push({
        id, name: meta.name, tier: meta.tier, state, keys,
        baseUrl: meta.baseUrl, keyless: !!meta.keyless,
      });
    }
    return out;
  }
}

export function encodeTrail(trail) {
  try {
    return Buffer.from(JSON.stringify(trail.map((t) => `${t.provider}/${t.key}:${t.kind || 'ok'}`))).toString('base64url');
  } catch {
    return '';
  }
}
