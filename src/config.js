// LoLLM — Config: load/save atomik, defaults, provider & key management.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CATALOG, DEFAULT_ON, catalogById } from './catalog.js';

export const DEFAULT_SETTINGS = {
  strategy: 'failover', // 'failover' | 'round-robin' | 'free-first'
  providerOrder: [], // [providerId] manual order (yang pertama = prioritas)
  maxAttempts: 6,
  authRequired: true,
  allowAnyFallback: true, // last-resort: pakai provider sehat mana pun kalau model asli habis
  hiddenModels: [], // model live yang disembunyikan: "provider:model"
  timeouts: {
    connectMs: 8000, // fetch → headers
    firstByteMs: 20000, // headers → chunk pertama (stream)
    totalMs: 180000, // total untuk non-stream
    streamIdleMs: 60000, // jeda maks antar chunk saat streaming
  },
  // ---- Routing kualitas (perbaikan "model Berganti-ganti / jatuh ke model lemah") ----
  routing: {
    autoCandidates: 4,      // berapa kandidat terbaik yang disiapkan untuk 'auto'
    minQualityScore: 45,    // di bawah ini model dianggap lemah untuk tugas umum
    blocklist: [],          // tambahan pola nama model yang dihindari (substring atau /regex/i)
    allowLowQuality: true,  // tak ada yang lolos ambang → pakai yang terbaik & tandai, jangan 404
    stickyAuto: true,       // 1 percakapan → 1 model (multi-turn tidak berganti karakter)
    stickyTtlMin: 30,
  },
  // ---- Anti "200 tapi kosong" ----
  content: {
    rejectEmpty: true,      // content kosong = attempt gagal, bukan sukses hampa
    emptyRetries: 1,        // retry kandidat yang sama sebelum pindah provider
  },
  // ---- Parameter request ----
  params: {
    maxTokensCap: 32000,
    maxN: 8,
    anthropicMaxTokens: 4096,
  },
  // ---- Konteks multi-turn ----
  context: {
    enabled: true,
    maxChars: 60000,        // lebih dari ini → pangkas turn TENGAH, jangan biarkan provider memotong
    minRecentTurns: 4,
  },
  // ---- Rate limit & kapasitas ----
  rateLimit: {
    enabled: true,
    requestsPerMinute: 600,
    burst: 60,
    maxConcurrent: 32,      // request upstream serentak; lebih dari ini → 429, bukan jawaban kosong
  },
  // ---- Warm-up anti cold start ----
  warmup: { enabled: true, intervalMs: 240000 },
};

export const NUM_BOUNDS = {
  maxAttempts: [1, 12],
  'routing.autoCandidates': [1, 12],
  'routing.minQualityScore': [0, 100],
  'routing.stickyTtlMin': [1, 1440],
  'content.emptyRetries': [0, 4],
  'params.maxTokensCap': [256, 200000],
  'params.maxN': [1, 32],
  'params.anthropicMaxTokens': [64, 64000],
  'context.maxChars': [1000, 4000000],
  'context.minRecentTurns': [1, 64],
  'rateLimit.requestsPerMinute': [1, 1000000],
  'rateLimit.burst': [1, 100000],
  'rateLimit.maxConcurrent': [1, 4096],
  'warmup.intervalMs': [15000, 86400000],
};

/** Clamp/normalisasi blok settings (dipakai PUT /api/settings dan config/import). */
export function sanitizeSettings(target, incoming = {}) {
  if (!incoming || typeof incoming !== 'object') return target;
  const oneOf = (v, list) => (list.includes(v) ? v : undefined);
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const intIn = (path, v) => {
    const [lo, hi] = NUM_BOUNDS[path] || [-Infinity, Infinity];
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : undefined;
  };

  const s = oneOf(incoming.strategy, ['failover', 'round-robin', 'free-first']); if (s) target.strategy = s;
  if (Array.isArray(incoming.providerOrder)) target.providerOrder = incoming.providerOrder.filter((x) => typeof x === 'string');
  const maxAttempts = intIn('maxAttempts', incoming.maxAttempts); if (maxAttempts != null) target.maxAttempts = maxAttempts;
  const authRequired = bool(incoming.authRequired); if (authRequired !== undefined) target.authRequired = authRequired;
  const allowAnyFallback = bool(incoming.allowAnyFallback); if (allowAnyFallback !== undefined) target.allowAnyFallback = allowAnyFallback;
  if (Array.isArray(incoming.hiddenModels)) target.hiddenModels = [...new Set(incoming.hiddenModels.filter((x) => typeof x === 'string'))].slice(0, 10000);

  if (incoming.timeouts) {
    for (const k of ['connectMs', 'firstByteMs', 'totalMs', 'streamIdleMs']) {
      const v = Number(incoming.timeouts[k]);
      if (Number.isFinite(v)) target.timeouts[k] = Math.min(Math.max(v, 1000), 600000);
    }
  }
  if (incoming.routing) {
    const r = incoming.routing;
    const v = intIn('routing.autoCandidates', r.autoCandidates); if (v != null) target.routing.autoCandidates = v;
    const q = intIn('routing.minQualityScore', r.minQualityScore); if (q != null) target.routing.minQualityScore = q;
    const t = intIn('routing.stickyTtlMin', r.stickyTtlMin); if (t != null) target.routing.stickyTtlMin = t;
    if (Array.isArray(r.blocklist)) target.routing.blocklist = r.blocklist.map(String).filter(Boolean).slice(0, 500);
    const alq = bool(r.allowLowQuality); if (alq !== undefined) target.routing.allowLowQuality = alq;
    const st = bool(r.stickyAuto); if (st !== undefined) target.routing.stickyAuto = st;
  }
  if (incoming.content) {
    const c = incoming.content;
    const re = bool(c.rejectEmpty); if (re !== undefined) target.content.rejectEmpty = re;
    const er = intIn('content.emptyRetries', c.emptyRetries); if (er != null) target.content.emptyRetries = er;
  }
  if (incoming.params) {
    const p = incoming.params;
    const cap = intIn('params.maxTokensCap', p.maxTokensCap); if (cap != null) target.params.maxTokensCap = cap;
    const n = intIn('params.maxN', p.maxN); if (n != null) target.params.maxN = n;
    const am = intIn('params.anthropicMaxTokens', p.anthropicMaxTokens); if (am != null) target.params.anthropicMaxTokens = am;
  }
  if (incoming.context) {
    const c = incoming.context;
    const en = bool(c.enabled); if (en !== undefined) target.context.enabled = en;
    const mc = intIn('context.maxChars', c.maxChars); if (mc != null) target.context.maxChars = mc;
    const mr = intIn('context.minRecentTurns', c.minRecentTurns); if (mr != null) target.context.minRecentTurns = mr;
  }
  if (incoming.rateLimit) {
    const rl = incoming.rateLimit;
    const en = bool(rl.enabled); if (en !== undefined) target.rateLimit.enabled = en;
    const rpm = intIn('rateLimit.requestsPerMinute', rl.requestsPerMinute); if (rpm != null) target.rateLimit.requestsPerMinute = rpm;
    const bu = intIn('rateLimit.burst', rl.burst); if (bu != null) target.rateLimit.burst = bu;
    const mc = intIn('rateLimit.maxConcurrent', rl.maxConcurrent); if (mc != null) target.rateLimit.maxConcurrent = mc;
  }
  if (incoming.warmup) {
    const w = incoming.warmup;
    const en = bool(w.enabled); if (en !== undefined) target.warmup.enabled = en;
    const im = intIn('warmup.intervalMs', w.intervalMs); if (im != null) target.warmup.intervalMs = im;
    const s2 = str(w.note); if (s2) target.warmup.note = s2;
  }
  return target;
}

/** Error dengan status HTTP — supaya validasi config tidak berakhir sebagai 500. */
function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Direktori data: opsi CLI > env LOLLM_HOME > ./data (dipakai server & CLI supaya tidak beda jalan). */
export function resolveDataDir(opts = {}) {
  return opts.dataDir || process.env.LOLLM_HOME || path.resolve(process.cwd(), 'data');
}

export function newGatewayKey() {
  return 'lollm-' + crypto.randomBytes(20).toString('hex');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export const DEFAULT_DASHBOARD_PASSWORD = 'Edoll123';

function newKeyId() {
  return 'k_' + crypto.randomBytes(6).toString('hex');
}

export class Config {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.data = null;
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      raw = null;
    }
    this.data = {
      version: 1,
      gateway: { apiKeys: [newGatewayKey()] },
      settings: structuredClone(DEFAULT_SETTINGS),
      dashboard: { loginEnabled: true },
      providers: {},
      customProviders: [],
      ...(raw || {}),
    };
    // Sanitize & defaults (section dalam di-merge per-kunci supaya config lama tetap lengkap)
    this.data.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(this.data.settings || {}) };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === 'hiddenModels' || key === 'providerOrder') continue;
      if (DEFAULT_SETTINGS[key] && typeof DEFAULT_SETTINGS[key] === 'object' && !Array.isArray(DEFAULT_SETTINGS[key])) {
        this.data.settings[key] = { ...structuredClone(DEFAULT_SETTINGS[key]), ...(this.data.settings[key] || {}) };
      }
    }
    for (const [k, bounds] of Object.entries(NUM_BOUNDS)) {
      if (k.includes('.')) {
        const [sec, field] = k.split('.');
        const v = Number(this.data.settings[sec]?.[field]);
        if (Number.isFinite(v)) this.data.settings[sec][field] = Math.min(Math.max(Math.round(v), bounds[0]), bounds[1]);
        else this.data.settings[sec][field] = DEFAULT_SETTINGS[sec][field];
      } else {
        const v = Number(this.data.settings[k]);
        if (Number.isFinite(v)) this.data.settings[k] = Math.min(Math.max(Math.round(v), bounds[0]), bounds[1]);
      }
    }
    if (!Array.isArray(this.data.settings.routing?.blocklist)) this.data.settings.routing.blocklist = [];
    this.data.settings.hiddenModels = Array.isArray(this.data.settings.hiddenModels)
      ? [...new Set(this.data.settings.hiddenModels.filter((x) => typeof x === 'string'))].slice(0, 10000)
      : [];
    this.data.gateway = this.data.gateway || { apiKeys: [newGatewayKey()] };
    // Dashboard auth — default AKTIF dengan password default (disimpan sebagai hash)
    this.data.dashboard = this.data.dashboard || {};
    if (!this.data.dashboard.passwordHash) this.data.dashboard.passwordHash = sha256(DEFAULT_DASHBOARD_PASSWORD);
    this.data.dashboard.loginEnabled = this.data.dashboard.loginEnabled !== false;
    if (!Array.isArray(this.data.gateway.apiKeys) || this.data.gateway.apiKeys.length === 0) {
      this.data.gateway.apiKeys = [newGatewayKey()];
    }
    this.data.providers = this.data.providers || {};
    this.data.customProviders = this.data.customProviders || [];

    // Provider keyless default-on
    this.ensureKeylessDefaults();
    // Ensure shape for all providers
    for (const p of Object.values(this.data.providers)) {
      p.keys = Array.isArray(p.keys) ? p.keys : [];
      p.enabled = p.enabled !== false;
      for (const k of p.keys) {
        k.status = k.status || 'ok';
        k.failCount = k.failCount || 0;
        k.success = k.success || 0;
        k.fail = k.fail || 0;
        k.enabled = k.enabled !== false;
      }
    }
    this.save();
    return this;
  }

  // Pastikan provider keyless (mis. Pollinations) selalu tersedia & aktif.
  ensureKeylessDefaults() {
    for (const id of DEFAULT_ON) {
      const meta = catalogById(id);
      if (!meta || !meta.keyless) continue;
      if (!this.data.providers[id]) {
        this.data.providers[id] = { enabled: true, keys: [] };
      }
      const p = this.data.providers[id];
      p.enabled = p.enabled !== false;
      if (!p.keys.some((k) => k.id === 'keyless')) {
        p.keys.push({
          id: 'keyless',
          label: 'keyless',
          value: '',
          addedAt: Date.now(),
          status: 'ok',
          enabled: true,
          failCount: 0,
          success: 0,
          fail: 0,
        });
      }
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Statistik berubah pada tiap request. Tunda penulisan agar jalur panas tidak
  // melakukan I/O sinkron berulang, tanpa mengorbankan persistensi konfigurasi.
  scheduleSave(delayMs = 750) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { this.save(); } catch { /* akan dicoba lagi pada perubahan berikutnya */ }
    }, delayMs);
    this.saveTimer.unref?.();
  }

  ensureProvider(id) {
    if (!this.data.providers[id]) this.data.providers[id] = { enabled: true, keys: [] };
    return this.data.providers[id];
  }

  addKey(providerId, value, label) {
    const meta = this.providerMeta(providerId);
    if (!meta) throw httpError(`Provider tidak dikenal: ${providerId}`, 400);
    if (meta.keyless) throw httpError(`Provider ${meta.name} tidak butuh API key`, 400);
    value = String(value || '').trim();
    if (!value) throw httpError('API key kosong', 400);
    const p = this.ensureProvider(providerId);
    // Duplikat → 409, bukan 500: pemakai sering paste key yang sama dua kali.
    if (p.keys.some((k) => k.value === value)) throw httpError('Key ini sudah ada di pool', 409);
    const key = {
      id: newKeyId(),
      label: String(label || '').trim() || `key-${p.keys.length + 1}`,
      value,
      addedAt: Date.now(),
      status: 'ok',
      enabled: true,
      failCount: 0,
      success: 0,
      fail: 0,
    };
    p.keys.push(key);
    p.enabled = true;
    this.save();
    return key;
  }

  removeKey(providerId, keyId) {
    const p = this.data.providers[providerId];
    if (!p) return false;
    const before = p.keys.length;
    p.keys = p.keys.filter((k) => k.id !== keyId);
    if (p.keys.length === before) return false;
    this.save();
    return true;
  }

  isDefaultDashboardPassword() {
    return this.data.dashboard.passwordHash === sha256(DEFAULT_DASHBOARD_PASSWORD);
  }

  verifyDashboardPassword(pw) {
    return !!pw && this.data.dashboard.passwordHash === sha256(String(pw));
  }

  setDashboardPassword(pw) {
    this.data.dashboard.passwordHash = sha256(String(pw));
    this.save();
  }

  findKey(providerId, keyId) {
    const p = this.data.providers[providerId];
    return p ? p.keys.find((k) => k.id === keyId) || null : null;
  }

  providerMeta(id) {
    return catalogById(id) || this.data.customProviders.find((c) => c.id === id) || null;
  }

  // Semua provider yang sudah "ada" (punya entri config)
  configuredProviderIds() {
    return Object.keys(this.data.providers);
  }
}
