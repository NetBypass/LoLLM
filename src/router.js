// LoLLM — Router: resolusi model → rantai kandidat (key × provider) → loop fallback 0ms.
// Daftar model SELALU live dari endpoint provider — tanpa hint/template/dummy.
//
// Yang berubah dibanding versi awal (sesuai temuan QA):
//  • 'auto' tidak lagi "model pertama dari provider pertama". Semua model live dari semua
//    provider dinilai (src/quality.js) dan diurutkan deterministik → kualitas stabil.
//  • Jawaban kosong tidak pernah lagi dikirim sebagai HTTP 200: attempt dengan content kosong
//    dihitung gagal, dicoba ulang di kandidat berikutnya, dan kalau semuanya kosong → 502.
//  • Setiap respons membawa metadata: model akhir, provider, jumlah fallback, alasan pemilihan,
//    task terdeteksi, dan catatan parameter (header x-lollm-* + field x_lollm di body).

import crypto from 'node:crypto';
import { runAttempt, UpstreamError } from './proxy.js';
import { normalizeParams, sanitizeHistory, isEmptyCompletion } from './params.js';
import { detectTask, rankModels, scoreModel, selectionReason } from './quality.js';
import { VERSION } from './version.js';
import { CORS_HEADERS as CORS } from './cors.js';
import {
  pickKey, reportSuccess, reportFailure, providerUsable, providerHealthy, keySummary,
} from './pool.js';

const MODELS_TTL_MS = 10 * 60 * 1000; // cache daftar model live (sukses)
const MODELS_EMPTY_TTL_MS = 30 * 1000; // gagal/kosong → coba lagi cepat, jangan pakai data palsu
const MAX_LOGS = 500;
const AUTO_PLAN_TTL_MS = 20 * 1000; // resolusi 'auto' jangan dihitung ulang tiap request
const MODEL_HEALTH_TTL_MS = 5 * 60 * 1000;
const MODEL_HEALTH_DECAY_MS = 90 * 1000;

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function errTypeFor(status) {
  if (status === 400 || status === 404 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_denied_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 499) return 'client_closed_request';
  if (status === 503) return 'service_unavailable';
  return 'server_error';
}

export class Router {
  constructor(config) {
    this.config = config;
    this.modelsCache = new Map(); // providerId → { ts, models[] }
    this.inflight = new Map();
    this.rrIndex = 0;
    this.stats = this.emptyStats();
    this.logs = [];
    this.autoPlanCache = new Map(); // task → { ts, plans }
    this.sticky = new Map(); // routeKey → { providerId, model, ts }
    this.modelHealth = new Map(); // "provider:model" → { penalty, ts }
  }

  emptyStats() {
    return {
      startedAt: Date.now(),
      requests: 0, ok: 0, fail: 0,
      fallbacks: 0, // jumlah perpindahan kandidat
      emptyRejected: 0, // jawaban 200-content-kosong yang ditolak
      rateLimited: 0,
      totalMs: 0,
      firstTokenMs: 0, firstTokenSamples: 0,
      tokensIn: 0, tokensOut: 0,
      byProvider: {}, // id → { ok, fail, ms }
      byModel: {}, // "provider:model" → { ok, fail }
    };
  }

  bumpProvider(id, field, ms = 0) {
    const p = (this.stats.byProvider[id] = this.stats.byProvider[id] || { ok: 0, fail: 0, ms: 0 });
    p[field]++;
    p.ms += ms;
  }

  bumpModel(key, field) {
    const m = (this.stats.byModel[key] = this.stats.byModel[key] || { ok: 0, fail: 0 });
    m[field]++;
  }

  /** Penalti lunak supaya model yang terbukti bermasalah tidak dipilih terus. */
  noteModelFailure(providerId, model, kind) {
    const key = `${providerId}:${model}`;
    const rec = this.modelHealth.get(key) || { penalty: 0, ts: 0 };
    const weight = kind === 'empty' ? 14 : kind === 'timeout' ? 8 : kind === 'rate' ? 0 : kind === 'server' || kind === 'network' ? 5 : 0;
    if (!weight) return;
    rec.penalty = Math.min(45, rec.penalty + weight);
    rec.ts = Date.now();
    this.modelHealth.set(key, rec);
  }

  noteModelSuccess(providerId, model) {
    const key = `${providerId}:${model}`;
    const rec = this.modelHealth.get(key);
    if (!rec) return;
    rec.penalty = Math.max(0, rec.penalty - 8);
    rec.ts = Date.now();
    if (rec.penalty === 0) this.modelHealth.delete(key);
  }

  modelPenalty(providerId, model, now = Date.now()) {
    const rec = this.modelHealth.get(`${providerId}:${model}`);
    if (!rec) return 0;
    if (now - rec.ts > MODEL_HEALTH_TTL_MS) { this.modelHealth.delete(`${providerId}:${model}`); return 0; }
    // pelan-pelan pulih
    const decayed = rec.penalty * Math.exp(-((now - rec.ts) / MODEL_HEALTH_DECAY_MS) * 0.35);
    return Math.round(decayed);
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
    const result = [...order, ...rest];
    // Penghemat: provider gratis didahulukan, tetapi urutan manual tetap adil
    // di dalam kelompok gratis/berbayar dan fallback tetap identik.
    if (s.strategy === 'free-first') {
      return result.sort((a, b) => {
        const free = (id) => this.config.providerMeta(id)?.tier === 'free' ? 0 : 1;
        return free(a) - free(b);
      });
    }
    return result;
  }

  isModelHidden(providerId, model) {
    return (this.config.data.settings.hiddenModels || []).includes(`${providerId}:${model}`);
  }

  availableProviders(now = Date.now()) {
    return this.providerOrder()
      .map((id, index) => ({ id, index, pconf: this.config.data.providers[id], meta: this.config.providerMeta(id) }))
      .filter((p) => p.pconf && p.meta && providerUsable(p.pconf, now));
  }

  // ---- Live model list (cache) ----
  // Gagal fetch = kosong (cache 30s). Sukses = cache 10 menit. Tidak pernah ada daftar palsu.
  liveModels(id, pconf, meta) {
    const cached = this.modelsCache.get(id);
    if (cached) {
      const ttl = cached.models.length ? MODELS_TTL_MS : MODELS_EMPTY_TTL_MS;
      if (Date.now() - cached.ts < ttl) return Promise.resolve(cached.models);
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
        const models = (j?.data || []).map((m) => m.id || m?.model || m?.name).filter(Boolean);
        const uniq = [...new Set(models)];
        this.modelsCache.set(id, { ts: Date.now(), models: uniq });
        return uniq;
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

  /** Semua provider paralel — dulu sekuensial dan itu penyebab utama request pertama lambat. */
  async liveModelsFor(providers) {
    const lists = await Promise.all(providers.map(async (p) => {
      try { return await this.liveModels(p.id, p.pconf, p.meta); } catch { return []; }
    }));
    const map = new Map();
    providers.forEach((p, i) => map.set(p.id, lists[i] || []));
    return map;
  }

  // Bust cache daftar model (dipanggil setelah key/provider berubah).
  invalidateModels(providerId) {
    if (providerId) this.modelsCache.delete(providerId);
    else this.modelsCache.clear();
    this.autoPlanCache.clear();
    if (providerId) for (const [k, v] of this.sticky) if (v.providerId === providerId && !this.stickyValid(v)) this.sticky.delete(k);
  }

  stickyValid(rec) {
    const ttl = Math.max(60_000, (this.config.data.settings.routing?.stickyTtlMin ?? 30) * 60_000);
    if (!rec || Date.now() - rec.ts > ttl) return false;
    const pconf = this.config.data.providers[rec.providerId];
    const meta = this.config.providerMeta(rec.providerId);
    if (!pconf || !meta || pconf.enabled === false) return false;
    return providerHealthy(pconf);
  }

  async allModels({ includeHidden = false } = {}) {
    const providers = this.availableProviders();
    const lists = await this.liveModelsFor(providers);
    const out = [];
    const seen = new Set();
    for (const p of providers) {
      for (const m of lists.get(p.id) || []) {
        const k = `${p.id}:${m}`;
        if (!seen.has(k) && (includeHidden || !this.isModelHidden(p.id, m))) {
          seen.add(k);
          out.push({ id: m, provider: p.id, hidden: this.isModelHidden(p.id, m) });
        }
      }
    }
    return out;
  }

  // ---- Resolusi model → targets [{providerId, model}] ----
  /**
   * @returns {Promise<{plans:Array, selection:object}>}
   */
  async resolveTargets(model, { path = 'chat/completions', task = 'chat', routeKey = null } = {}) {
    const now = Date.now();
    const routing = this.config.data.settings.routing || {};
    const avail = this.availableProviders(now);
    const selection = { mode: 'auto', task, reason: '', sticky: false, lowConfidence: false, candidates: 0, scored: true };
    if (avail.length === 0) return { plans: [], selection };

    const lists = await this.liveModelsFor(avail);
    const visible = (id, models) => (models || []).filter((m) => !this.isModelHidden(id, m));
    const rankOpts = { task, blocklist: routing.blocklist || [], minScore: routing.minQualityScore ?? 45, path, allowLowQuality: routing.allowLowQuality !== false };

    // 1) auto / lollm → peringkat kualitas lintas semua provider (deterministik)
    if (model === 'auto' || model === 'lollm' || model === 'lollm-auto' || String(model).startsWith('auto:')) {
      const forcedTask = String(model).includes(':') ? String(model).split(':')[1] : task;
      const opts = { ...rankOpts, task: ['coding', 'reasoning', 'translation', 'id-chat', 'structured', 'summarize', 'chat'].includes(forcedTask) ? forcedTask : task };
      selection.task = opts.task;
      const cacheKey = `${opts.task}|${path}`;
      const cached = this.autoPlanCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < AUTO_PLAN_TTL_MS) {
        const plans = cached.plans.map((p) => ({ ...p }));
        const sticky = this.applySticky(plans, routeKey, selection);
        selection.mode = sticky ? 'auto:sticky' : 'auto:quality';
        selection.candidates = plans.length;
        selection.lowConfidence = cached.lowConfidence;
        selection.bestScores = cached.bestScores;
        selection.reason = selectionReason({ task: opts.task, model: (sticky || plans[0])?.model, score: plans[0]?.rawScore, lowConfidence: cached.lowConfidence, sticky: !!sticky });
        return { plans, selection };
      }

      const all = [];
      for (const p of avail) {
        if (!providerHealthy(p.pconf, now)) continue;
        const ranked = rankModels(visible(p.id, lists.get(p.id)), opts);
        for (const r of ranked) {
          const penalty = this.modelPenalty(p.id, r.model, now);
          all.push({
            providerId: p.id, model: r.model, score: r.score - penalty, rawScore: r.score, penalty,
            tags: r.tags, reasons: r.reasons, providerPriority: p.index, lowConfidence: r.lowConfidence,
          });
        }
      }
      // Deterministik: skor desc, lalu prioritas provider, lalu nama model.
      all.sort((a, b) => (b.score - a.score) || (a.providerPriority - b.providerPriority) || String(a.model).localeCompare(String(b.model)));
      const limit = Math.max(1, Math.min(routing.autoCandidates ?? 4, 12));
      const plans = all.slice(0, limit);
      if (plans.length === 0) return { plans: [], selection };
      const summary = {
        lowConfidence: plans.every((p) => p.lowConfidence),
        bestScores: plans.slice(0, 3).map((p) => `${p.providerId}/${p.model}:${p.rawScore}${p.penalty ? `-${p.penalty}` : ''}`),
      };
      this.autoPlanCache.set(cacheKey, { ts: Date.now(), plans: plans.map((p) => ({ ...p })), ...summary });
      const sticky = this.applySticky(plans, routeKey, selection);
      Object.assign(selection, summary, {
        mode: sticky ? 'auto:sticky' : 'auto:quality',
        candidates: plans.length,
        reason: selectionReason({ task: opts.task, model: (sticky || plans[0]).model, score: (sticky || plans[0]).rawScore, lowConfidence: summary.lowConfidence, sticky: !!sticky }),
      });
      return { plans, selection };
    }

    // 2) Pin provider: "groq/llama-..." — percaya user, langsung pakai
    const pin = String(model).match(/^([a-z0-9_-]+)[/:](.+)$/i);
    if (pin) {
      const provId = pin[1].toLowerCase();
      const rest = pin[2];
      const p = avail.find((x) => x.id === provId);
      if (p && !this.isModelHidden(p.id, rest)) {
        selection.mode = 'pin';
        selection.reason = `provider dipin: ${provId}`;
        selection.scored = false;
        return { plans: [{ providerId: p.id, model: rest, pinned: true, providerPriority: p.index }], selection };
      }
    }

    // 3) Model persis ada di daftar live provider (semua provider dinilai paralel)
    const exact = [];
    const fuzzy = [];
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]+/g, '');
    const want = norm(model.replace(/:free$|:thinking$/i, ''));
    for (const p of avail) {
      const models = visible(p.id, lists.get(p.id));
      if (models.includes(model)) {
        const s = rankModels([model], rankOpts)[0];
        exact.push({ providerId: p.id, model, score: s?.score ?? 60, providerPriority: p.index, tags: s?.tags });
      } else {
        const hit = models.map((m) => norm(m)).findIndex((n) => n === want || (n.length > 8 && (n.includes(want) || want.includes(n))) || startsWithKey(n, want));
        if (hit >= 0) {
          const real = models[hit];
          const s = rankModels([real], rankOpts)[0];
          fuzzy.push({ providerId: p.id, model: real, score: (s?.score ?? 60) - 3, providerPriority: p.index, fuzzy: true, tags: s?.tags });
        }
      }
    }
    let plans = exact.sort((a, b) => (a.providerPriority - b.providerPriority));
    if (plans.length) { selection.mode = 'exact'; selection.reason = `${plans.length} provider punya model ini`; }
    else {
      plans = fuzzy.sort((a, b) => (b.score - a.score) || (a.providerPriority - b.providerPriority));
      if (plans.length) { selection.mode = 'fuzzy'; selection.reason = `nama tidak persis — dipakai: ${plans[0].model}`; }
    }
    selection.candidates = plans.length;
    return { plans, selection };
  }

  applySticky(plans, routeKey, selection) {
    const routing = this.config.data.settings.routing || {};
    if (!routing.stickyAuto || !routeKey || plans.length < 2) return null;
    const rec = this.sticky.get(routeKey);
    if (!rec || !this.stickyValid(rec)) { if (rec) this.sticky.delete(routeKey); return null; }
    const idx = plans.findIndex((p) => p.providerId === rec.providerId && p.model === rec.model);
    if (idx < 0) return null;
    const [hit] = plans.splice(idx, 1);
    plans.unshift(hit);
    selection.sticky = true;
    rec.ts = Date.now();
    return hit;
  }

  rememberSticky(routeKey, plan) {
    const routing = this.config.data.settings.routing || {};
    if (!routing.stickyAuto || !routeKey || !plan) return;
    this.sticky.set(routeKey, { providerId: plan.providerId, model: plan.model, ts: Date.now() });
    if (this.sticky.size > 5000) {
      const now = Date.now();
      for (const [k, v] of this.sticky) if (now - v.ts > 30 * 60_000) this.sticky.delete(k);
      while (this.sticky.size > 5000) this.sticky.delete(this.sticky.keys().next().value);
    }
  }

  // ---- Loop utama ----
  /**
   * route({ path, body, stream, clientRes, signal, requestId, routeKey })
   * Menulis response ke clientRes (baik sukses maupun error akhir).
   * Return { ok, providerId, model, status, ms, trail, meta }
   */
  async route({ path, body, stream, clientRes, signal, requestId, routeKey, extraHeaders = {} }) {
    const t0 = Date.now();
    const settings = this.config.data.settings;
    const contentPolicy = settings.content || {};
    const rejectEmpty = contentPolicy.rejectEmpty !== false;
    const requestedModel = body.model || 'auto';
    this.stats.requests++;

    const task = detectTask(body).task;
    const trail = [];
    const meta = {
      requestedModel,
      model: null,
      provider: null,
      task,
      attempts: 0,
      fallbacks: 0,
      selection: { mode: 'auto', task },
      params: null,
      sticky: false,
      lowConfidence: false,
      retriedEmpty: 0,
      headers: extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {},
    };

    const fail = (status, message, extra = {}) => {
      this.stats.fail++;
      this.pushLog({ ts: Date.now(), requestId, model: requestedModel, stream, status, ms: Date.now() - t0, trail, task, error: String(message).slice(0, 200) });
      if (!clientRes.headersSent) {
        clientRes.writeHead(status, {
          'Content-Type': 'application/json',
          'x-lollm-error': errTypeFor(status),
          'x-lollm-provider': meta.provider || 'none',
          'x-lollm-model': meta.model || requestedModel,
          'x-lollm-attempts': String(meta.attempts),
          'x-lollm-trail': encodeTrail(trail),
          ...extraHeaders,
          ...CORS,
        });
        clientRes.end(JSON.stringify(errorPayload(message, status, extra)));
      } else {
        clientRes.end();
      }
      return { ok: false, status, ms: Date.now() - t0, trail, meta };
    };

    // ---- kapasitas & rencana ----
    let { plans, selection } = await this.resolveTargets(requestedModel, { path, task, routeKey });
    meta.selection = selection;
    meta.sticky = !!selection.sticky;
    meta.lowConfidence = !!selection.lowConfidence;

    // Last resort: provider sehat mana pun + model TERBAIK-nya (bukan model pertama)
    if (settings.allowAnyFallback && path === 'chat/completions') {
      const now = Date.now();
      const already = new Set(plans.map((p) => p.providerId));
      const avail = this.availableProviders(now).filter((p) => !already.has(p.id));
      const lists = await this.liveModelsFor(avail);
      for (const p of avail) {
        const ranked = rankModels((lists.get(p.id) || []).filter((m) => !this.isModelHidden(p.id, m)), {
          task, blocklist: settings.routing?.blocklist || [], minScore: settings.routing?.minQualityScore ?? 45, path,
        });
        if (ranked.length > 0) {
          const best = ranked[0];
          plans.push({ providerId: p.id, model: best.model, score: best.score, rawScore: best.score, anyFallback: true, providerPriority: p.index, lowConfidence: best.lowConfidence });
        }
      }
    }

    if (plans.length === 0) {
      const models = (await this.allModels().catch(() => [])).slice(0, 30).map((m) => m.id);
      return fail(404, `Model "${requestedModel}" tidak tersedia. Daftar model diambil live dari endpoint provider — kosong berarti belum ada API key aktif atau endpoint belum bisa dihubungi. Tambahkan API key di dashboard, lalu cek /v1/models.`, { type: 'invalid_request_error', param: 'model', available: [...new Set(models)] });
    }

    // Round-robin: rotasi urutan plans (hanya untuk mode non-kualitas)
    if (settings.strategy === 'round-robin' && requestedModel !== 'auto') {
      const start = this.rrIndex % plans.length;
      this.rrIndex = (this.rrIndex + 1) % plans.length;
      plans = [...plans.slice(start), ...plans.slice(0, start)];
    }

    let attemptsLeft = Math.max(1, settings.maxAttempts);
    let lastErr = null;
    let lastEmptyWhy = null;
    const queue = plans.map((p) => ({ ...p, _retries: 0 }));
    let firstAny = false;

    for (let qi = 0; qi < queue.length && attemptsLeft > 0; qi++) {
      const plan = queue[qi];
      const pconf = this.config.data.providers[plan.providerId];
      const metaProv = this.config.providerMeta(plan.providerId);
      if (!pconf || !metaProv) continue;

      const triedKeys = new Set();
      while (attemptsLeft > 0) {
        const key = pickKey(pconf);
        if (!key || triedKeys.has(key.id)) break; // pool provider ini habis
        triedKeys.add(key.id);
        attemptsLeft--;
        meta.attempts++;
        if (meta.attempts > 1) meta.fallbacks = meta.attempts - 1;

        // Normalisasi parameter per provider (style/limit) + catat penyesuaian.
        sanitizeHistory(body, { flattenContent: true });
        const norm = normalizeParams({ ...body, model: plan.model, stream: stream || undefined }, {
          path,
          style: metaProv.style || 'openai',
          model: plan.model,
          limits: { maxTokensCap: settings.params?.maxTokensCap ?? 32000, maxN: settings.params?.maxN ?? 8, anthropicMaxTokens: settings.params?.anthropicMaxTokens ?? 4096 },
          content: settings.context || {},
        });
        const attemptBody = norm.body;
        if (attemptBody.__lollm_jsonHint) {
          delete attemptBody.__lollm_jsonHint;
          if (!/json/i.test(String(attemptBody.messages?.find((m) => m.role === 'system')?.content || ''))) {
            attemptBody.messages = [{ role: 'system', content: 'Balas HANYA dengan objek JSON valid, tanpa teks lain.' }, ...(attemptBody.messages || [])];
          }
        }
        if (attemptBody.stream === undefined) delete attemptBody.stream;

        let usage = null;
        const onUsage = stream
          ? { scan: (chunk) => { const u = scanUsage(chunk); if (u) usage = u; }, report: (u) => { usage = u; } }
          : { report: (u) => { usage = u; } };

        const attemptMeta = {
          'x-lollm-provider': plan.providerId,
          'x-lollm-model': plan.model,
          'x-lollm-requested-model': String(requestedModel),
          'x-lollm-task': meta.task,
          'x-lollm-attempts': String(meta.attempts),
          'x-lollm-fallbacks': String(meta.fallbacks),
          'x-lollm-selection': selectionModeTag(selection, plan),
          'x-lollm-trail': encodeTrail(trail),
          ...extraHeaders,
          ...CORS,
        };
        // Seed lebih dulu supaya respons error pun menyebut model/provider yang dicoba.
        if (!firstAny) { firstAny = true; meta.model = plan.model; meta.provider = plan.providerId; }

        try {
          const result = await runAttempt({
            pconf, meta: metaProv, key, path,
            body: attemptBody, stream,
            settings, clientSignal: signal, clientRes,
            onUsage,
            streamHeaders: attemptMeta,
            streamPrefix: stream ? sseMetaComment(meta, selection, plan) : null,
            allowEmpty: !rejectEmpty,
          });

          // ---- cek jawaban kosong pada non-stream ----
          let parsed = null;
          if (!stream && result.buffer) {
            try { parsed = JSON.parse(result.buffer.toString('utf8')); } catch { parsed = null; }
            if (!parsed && rejectEmpty) {
              // 200 tapi body bukan JSON (halaman captcha/proxy HTML/empty body) — bukan jawaban valid.
              lastErr = new UpstreamError(`Body non-JSON dari ${plan.providerId} (${(result.buffer || '').length} byte)`, { kind: 'server', status: 200 });
              reportFailure(pconf, key.id, 'server', { error: 'badjson' });
              this.noteModelFailure(plan.providerId, plan.model, 'server');
              trail.push({ provider: plan.providerId, key: key.label, model: plan.model, kind: 'badjson', status: 200, error: 'body bukan JSON', ms: Date.now() - t0 });
              this.bumpProvider(plan.providerId, 'fail');
              continue;
            }
            if (parsed?.error) {
              lastErr = new UpstreamError(`Upstream melaporkan error: ${parsed.error.message || 'unknown'}`, { kind: 'server', status: 200 });
              reportFailure(pconf, key.id, 'server', { error: String(parsed.error.message || 'upstream error').slice(0, 200) });
              trail.push({ provider: plan.providerId, key: key.label, model: plan.model, kind: 'upstream_error', status: 200, error: String(parsed.error.message || '').slice(0, 160), ms: Date.now() - t0 });
              this.bumpProvider(plan.providerId, 'fail');
              this.noteModelFailure(plan.providerId, plan.model, 'server');
              continue;
            }
            if (rejectEmpty && parsed) {
              const check = isEmptyCompletion(parsed);
              if (check.empty) {
                lastEmptyWhy = check.why;
                this.stats.emptyRejected++;
                meta.retriedEmpty++;
                reportFailure(pconf, key.id, 'empty', { error: `empty content (${check.why})` });
                this.noteModelFailure(plan.providerId, plan.model, 'empty');
                trail.push({ provider: plan.providerId, key: key.label, model: plan.model, kind: 'empty', status: 200, error: check.why, ms: Date.now() - t0 });
                this.bumpModel(`${plan.providerId}:${plan.model}`, 'fail');
                if (plan._retries < (contentPolicy.emptyRetries ?? 1) && attemptsLeft > 0) {
                  plan._retries++;
                  queue.push({ ...plan, _retries: plan._retries });
                }
                continue;
              }
            }
          }

          // ---- sukses ----
          reportSuccess(pconf, key.id);
          this.noteModelSuccess(plan.providerId, plan.model);
          this.bumpModel(`${plan.providerId}:${plan.model}`, 'ok');
          this.rememberSticky(routeKey, plan);
          const ms = Date.now() - t0;
          this.stats.ok++;
          this.stats.totalMs += ms;
          this.stats.fallbacks += trail.length;
          if (stream) { this.stats.firstTokenMs += ms; this.stats.firstTokenSamples++; }
          this.bumpProvider(plan.providerId, 'ok', ms);

          if (!stream && parsed?.usage) usage = parsed.usage;
          const finalUsage = usage || result.usage || null;
          if (finalUsage) {
            this.stats.tokensIn += finalUsage.prompt_tokens || 0;
            this.stats.tokensOut += finalUsage.completion_tokens || 0;
          }

          meta.model = plan.model;
          meta.provider = plan.providerId;
          meta.selectionTag = selectionModeTag(selection, plan);
          meta.params = norm.meta;
          meta.anyFallback = !!plan.anyFallback;

          if (!stream && !clientRes.headersSent) {
            const payload = this.augmentBody(parsed, result.buffer, meta, { ms, usage: finalUsage });
            clientRes.writeHead(result.status, { 'Content-Type': 'application/json', ...metaHeaders(meta, trail), ...CORS });
            clientRes.end(payload);
          }
          // Saat stream, header+isi sudah ditulis attempt (deferred writer) — tidak ada lagi yang perlu dilakukan.


          this.pushLog({
            ts: Date.now(), requestId, model: requestedModel, finalModel: plan.model,
            provider: plan.providerId, key: key.label, stream, status: 200, ms, task,
            usage: finalUsage ? `${finalUsage.prompt_tokens || 0}→${finalUsage.completion_tokens || 0}` : '',
            chars: result.chars, anyFallback: !!plan.anyFallback, selection: selectionModeTag(selection, plan),
            lowConfidence: !!plan.lowConfidence, trail,
          });
          this.config.scheduleSave();
          return { ok: true, providerId: plan.providerId, model: plan.model, status: 200, ms, trail, meta };
        } catch (err) {
          if (err instanceof UpstreamError && err.kind === 'aborted') {
            this.pushLog({ ts: Date.now(), requestId, model: requestedModel, stream, status: 499, ms: Date.now() - t0, trail });
            return { ok: false, status: 499, ms: Date.now() - t0, trail, meta };
          }
          lastErr = err;
          const kind = err.kind || 'network';
          if (kind === 'empty') {
            this.stats.emptyRejected++;
            meta.retriedEmpty++;
            lastEmptyWhy = String(err.message);
          }
          reportFailure(pconf, key.id, kind, { error: err.message, retryAfterSec: err.retryAfterSec });
          this.noteModelFailure(plan.providerId, plan.model, kind);
          this.bumpModel(`${plan.providerId}:${plan.model}`, 'fail');
          this.config.scheduleSave();
          trail.push({
            provider: plan.providerId, key: key.label, model: plan.model,
            kind, status: err.status || 0, error: String(err.message).slice(0, 160), ms: Date.now() - t0,
          });
          this.bumpProvider(plan.providerId, 'fail');

          // Stream sudah terlanjur dikirim sebagian → tidak bisa retry diam-diam.
          if (stream && clientRes.headersSent) {
            this.stats.fail++;
            this.pushLog({ ts: Date.now(), requestId, model: requestedModel, stream, status: 'stream-cut', ms: Date.now() - t0, trail });
            try { clientRes.end(); } catch { /* ignore */ }
            return { ok: false, status: 502, ms: Date.now() - t0, trail, meta, streamCut: true };
          }
          // Error client (400 dst): jangan habiskan key lain di provider yang sama — beda provider mungkin menerimanya.
          if (kind === 'client') break;
          if (kind === 'empty' && plan._retries < (contentPolicy.emptyRetries ?? 1) && attemptsLeft > 0) {
            plan._retries++;
            queue.push({ ...plan, _retries: plan._retries });
          }
          continue;
        }
      }
    }

    if (lastEmptyWhy && trail.some((tr) => tr.kind === 'empty')) {
      return fail(502, `Semua kandidat mengirim jawaban kosong (HTTP 200 tanpa content). Penyebab: ${lastEmptyWhy}. Sudah dicoba ${meta.attempts} percobaan — naikkan max_tokens atau pilih model lain (mis. "provider/model").`, {
        type: 'server_error', code: 'empty_completion', model: meta.model, provider: meta.provider, trail,
      });
    }
    const unavailable = meta.attempts === 0 || plans.every((p) => !p.model);
    return fail(unavailable ? 503 : 502, `Semua kandidat gagal (${meta.attempts} percobaan)${lastErr ? ` — terakhir: ${String(lastErr.message).slice(0, 200)}` : ''}.`, {
      code: 'all_attempts_failed', model: meta.model, provider: meta.provider, trail,
    });
  }

  /** Tambahkan field x_lollm pada body non-stream (aman: klien OpenAI mengabaikan field asing). */
  augmentBody(parsed, buffer, meta, { ms, usage }) {
    try {
      const j = parsed ?? JSON.parse(buffer.toString('utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        j.x_lollm = publicMeta(meta, { ms, usage });
        return Buffer.from(JSON.stringify(j));
      }
    } catch { /* body bukan JSON → kirim apa adanya */ }
    return buffer;
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
      const cached = this.modelsCache.get(id);
      const state = pconf.enabled === false ? 'off'
        : keys.ok > 0 ? 'up'
        : keys.cooling > 0 ? 'cooling'
        : keys.dead + keys.disabled > 0 ? 'down'
        : 'empty';
      out.push({
        id, name: meta.name, tier: meta.tier, state, keys,
        models: cached?.models?.length || 0,
        modelsAt: cached?.ts || 0,
        baseUrl: meta.baseUrl, keyless: !!meta.keyless,
      });
    }
    return out;
  }

  /** Readiness non-blokir: hanya memakai cache, supaya /readyz tetap < 1ms. */
  readiness() {
    const health = this.healthSummary();
    const up = health.filter((h) => h.state === 'up');
    const usable = health.filter((h) => h.state !== 'off');
    const knownModels = up.reduce((n, h) => n + (h.models || 0), 0);
    const ready = usable.length > 0 && up.length > 0;
    return {
      ready,
      providersTotal: health.length,
      providersUp: up.length,
      providersUsable: usable.length,
      modelsKnown: knownModels,
      reasons: !usable.length ? ['tidak ada provider aktif']
        : !up.length ? ['semua provider sedang cooldown/mati']
        : knownModels === 0 ? ['katalog model live belum dimuat (akan terisi otomatis)'] : [],
      health,
    };
  }

  /** Warm-up: isi cache model + hangatkan koneksi TLS ke tiap provider. */
  async warmup({ force = false } = {}) {
    const providers = this.availableProviders();
    if (force) this.modelsCache.clear();
    await this.liveModelsFor(providers);
    // Prime resolusinya supaya request pertama tidak bayar fetch+ranking.
    for (const task of ['chat', 'coding']) {
      try { await this.resolveTargets('auto', { path: 'chat/completions', task, routeKey: null }); } catch { /* biarkan */ }
    }
    return { providers: providers.length, models: providers.reduce((n, p) => n + ((this.modelsCache.get(p.id)?.models || []).length), 0) };
  }

  /** Refresh periodik cache supaya tidak pernah kedaluwarsa saat dipakai (anti cold start). */
  startMaintenance(intervalMs = 240_000) {
    this.stopMaintenance();
    const tick = () => {
      const now = Date.now();
      const stale = this.availableProviders(now).filter((p) => {
        const c = this.modelsCache.get(p.id);
        if (!c) return true;
        const ttl = c.models.length ? MODELS_TTL_MS : MODELS_EMPTY_TTL_MS;
        return now - c.ts > ttl * 0.6;
      });
      if (stale.length) this.liveModelsFor(stale).catch(() => {});
      for (const [k, v] of this.modelHealth) if (now - v.ts > MODEL_HEALTH_TTL_MS) this.modelHealth.delete(k);
      for (const [k, v] of this.sticky) if (!this.stickyValid(v)) this.sticky.delete(k);
    };
    this.maintTimer = setInterval(tick, Math.max(30_000, intervalMs));
    this.maintTimer.unref?.();
    tick();
    return () => this.stopMaintenance();
  }

  stopMaintenance() {
    if (this.maintTimer) clearInterval(this.maintTimer);
    this.maintTimer = null;
  }

  /** Ringkasan untuk dashboard: kualitas routing saat ini. */
  routingInsight() {
    const entries = [...this.autoPlanCache.values()].map((v) => v.plans).flat();
    return {
      candidates: entries.slice(0, 8),
      modelsTried: [...this.modelHealth.entries()].map(([k, v]) => ({ model: k, penalty: v.penalty, at: v.ts })),
      stickyEntries: this.sticky.size,
    };
  }

  /**
   * Jendela transparansi: kenapa `auto` memilih model itu. Menilai SEMUA model live
   * (tidak dipotong ke autoCandidates) supaya model yang tersingkir juga terlihat.
   */
  async previewAuto({ task = 'chat', path = 'chat/completions', limit = 20 } = {}) {
    const now = Date.now();
    const routing = this.config.data.settings.routing || {};
    const minScore = routing.minQualityScore ?? 45;
    const avail = this.availableProviders(now);
    const lists = await this.liveModelsFor(avail);
    const all = [];
    for (const p of avail) {
      const models = (lists.get(p.id) || []).filter((m) => !this.isModelHidden(p.id, m));
      for (const m of models) {
        const s = scoreModel(m, { task, blocklist: routing.blocklist || [] });
        const penalty = this.modelPenalty(p.id, m, now);
        all.push({
          provider: p.id, model: m,
          score: Math.max(0, s.score - penalty), base: s.score, penalty,
          tags: s.tags, reasons: s.reasons,
          blocked: s.blocked, nonChat: s.nonChat, excludedReason: s.excludedReason,
          providerPriority: p.index,
          providerState: providerHealthy(p.pconf, now) ? 'up' : 'cooling',
        });
      }
    }
    all.sort((a, b) => (b.score - a.score) || (a.providerPriority - b.providerPriority) || String(a.model).localeCompare(String(b.model)));
    const eligible = all.filter((x) => !x.blocked && !x.nonChat);
    const chosen = eligible.filter((x) => x.score >= minScore);
    return {
      task,
      minQualityScore: minScore,
      providersScanned: avail.length,
      modelsScanned: all.length,
      eligible: eligible.length,
      aboveThreshold: chosen.length,
      willUseLowQuality: chosen.length === 0 && eligible.length > 0,
      candidates: eligible.slice(0, limit),
      excluded: all.filter((x) => x.blocked || x.nonChat).slice(0, limit),
    };
  }
}

/** Komentar SSE di awal aliran: metadata tanpa merusak format OpenAI. */
function sseMetaComment(meta, selection, plan) {
  try {
    const o = {
      provider: plan.providerId,
      model: plan.model,
      requested_model: String(meta.requestedModel || ''),
      task: meta.task,
      attempts: meta.attempts,
      fallbacks: meta.fallbacks,
      selection: selectionModeTag(selection, plan),
      low_confidence: !!plan.lowConfidence,
    };
    return `: lollm-meta ${JSON.stringify(o)}\n\n`;
  } catch { return null; }
}

function startsWithKey(a, b) {
  return b.length > 10 && a.startsWith(b);
}

/** Bentuk error ala OpenAI: pesan + type + code + param, extra apa pun ikut terbawa. */
export function errorPayload(message, status, extra = {}) {
  const { type, code, param, ...rest } = extra || {};
  const out = { message, type: type || errTypeFor(status) };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v;
  out.code = code ?? status;
  out.param = param ?? null;
  return { error: out };
}

function strip(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}


function selectionModeTag(selection, plan) {
  const bits = [selection.mode || 'exact'];
  if (plan?.anyFallback) bits.push('last-resort');
  if (plan?.pinned) bits.push('pinned');
  if (plan?.lowConfidence) bits.push('low-confidence');
  if (plan?.penalty) bits.push(`penalty-${plan.penalty}`);
  if (selection.sticky) bits.push('sticky');
  return bits.join(',');
}

export function metaHeaders(meta, trail) {
  const h = {
    'x-lollm-provider': meta.provider || 'none',
    'x-lollm-model': meta.model || meta.requestedModel || 'auto',
    'x-lollm-requested-model': String(meta.requestedModel || ''),
    'x-lollm-task': meta.task || 'chat',
    'x-lollm-attempts': String(meta.attempts || 0),
    'x-lollm-fallbacks': String(meta.fallbacks || 0),
    'x-lollm-fallback': meta.fallbacks ? 'true' : 'false',
    'x-lollm-selection': meta.selectionTag || meta.selection?.mode || 'exact',
    'x-lollm-selection-reason': (meta.selection?.reason || '').replace(/[^\x20-\x7e]/g, '').slice(0, 180),
    'x-lollm-trail': encodeTrail(trail || []),
  };
  if (meta.lowConfidence) h['x-lollm-low-confidence'] = 'true';
  if (meta.retriedEmpty) h['x-lollm-empty-retries'] = String(meta.retriedEmpty);
  if (meta.params) h['x-lollm-params'] = encodeParams(meta.params);
  return { ...h, ...(meta.headers || {}), ...CORS };
}

function encodeParams(p) {
  const bits = [];
  if (p.adjusted?.length) bits.push('adjusted=' + p.adjusted.map((a) => `${a.param}:${a.from}→${a.to}`).join(','));
  if (p.ignored?.length) bits.push('ignored=' + p.ignored.map((a) => a.param).join(','));
  if (p.unknown?.length) bits.push('unknown=' + p.unknown.join(','));
  const s = bits.join(' | ') || 'all-forwarded';
  return Buffer.from(s).toString('base64url');
}

/** Field x_lollm di body non-stream. */
export function publicMeta(meta, { ms, usage } = {}) {
  return {
    requested_model: meta.requestedModel,
    model: meta.model,
    provider: meta.provider,
    task: meta.task,
    attempts: meta.attempts,
    fallbacks: meta.fallbacks,
    fallback_occurred: meta.fallbacks > 0,
    any_fallback: !!meta.anyFallback,
    sticky: !!meta.sticky,
    low_confidence: !!meta.lowConfidence,
    empty_retries: meta.retriedEmpty,
    selection: { mode: meta.selection?.mode, reason: meta.selection?.reason, best: meta.selection?.bestScores },
    params: meta.params ? { adjusted: meta.params.adjusted, ignored: meta.params.ignored, forwarded: meta.params.forwarded, unknown: meta.params.unknown } : null,
    gateway_ms: ms,
    usage: usage || null,
    version: VERSION,
  };
}

export function encodeTrail(trail) {
  try {
    return Buffer.from(JSON.stringify(trail.map((t) => `${t.provider}/${t.key}:${t.kind || 'ok'}`))).toString('base64url');
  } catch {
    return '';
  }
}

export function scanUsage(chunk) {
  const s = chunk.toString('utf8');
  const m = s.match(/"usage"\s*:\s*\{[^}]*"prompt_tokens"\s*:\s*(\d+)[^}]*"completion_tokens"\s*:\s*(\d+)/);
  if (m) return { prompt_tokens: +m[1], completion_tokens: +m[2] };
  return null;
}

/** Kunci sticky: header eksplisit → hash percakapan (deterministik lintas request). */
export function routeKeyFor(body, headers = {}) {
  const explicit = headers['x-lollm-route-key'] || headers['x-lollm-conversation-id'];
  if (explicit) return 'h:' + String(explicit).slice(0, 128);
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  if (!msgs.length) return null;
  const first = msgs.find((m) => m?.role === 'user');
  const sys = msgs.find((m) => m?.role === 'system');
  if (!first && !sys) return null;
  const basis = `${textOfSafe(sys?.content).slice(0, 200)}|${textOfSafe(first?.content).slice(0, 400)}`;
  if (!basis.replace('|', '').trim()) return null;
  return 'c:' + crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24);
}

function textOfSafe(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ');
  return '';
}
