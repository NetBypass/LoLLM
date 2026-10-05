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
  timeouts: {
    connectMs: 8000, // fetch → headers
    firstByteMs: 20000, // headers → chunk pertama (stream)
    totalMs: 180000, // total untuk non-stream
    streamIdleMs: 60000, // jeda maks antar chunk saat streaming
  },
};

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
    // Sanitize & defaults
    this.data.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(this.data.settings || {}) };
    this.data.settings.timeouts = { ...DEFAULT_SETTINGS.timeouts, ...(this.data.settings.timeouts || {}) };
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

  ensureProvider(id) {
    if (!this.data.providers[id]) this.data.providers[id] = { enabled: true, keys: [] };
    return this.data.providers[id];
  }

  addKey(providerId, value, label) {
    const meta = this.providerMeta(providerId);
    if (!meta) throw new Error(`Provider tidak dikenal: ${providerId}`);
    if (meta.keyless) throw new Error(`Provider ${meta.name} tidak butuh API key`);
    value = String(value || '').trim();
    if (!value) throw new Error('API key kosong');
    const p = this.ensureProvider(providerId);
    if (p.keys.some((k) => k.value === value)) throw new Error('Key ini sudah ada di pool');
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
