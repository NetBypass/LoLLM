// LoLLM — Rate limit (token bucket) + batas konkurensi.
//
// Tujuannya sesuai temuan stress test: di bawah beban tinggi, gateway harus menjawab
// "429 + Retry-After yang jelas" alih-alih diam-diam mengembalikan content kosong.
// Nol dependensi, tanpa timer global: bucket di-prune saat diakses + saat prune periodik.

export class TokenBucket {
  constructor({ perMinute, burst }) {
    this.rate = Math.max(0.001, perMinute / 60); // token per detik
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.ts = Date.now();
    this.hits = 0;
  }

  take(now = Date.now()) {
    const elapsed = (now - this.ts) / 1000;
    this.ts = now;
    if (elapsed > 0) this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    if (this.tokens >= 1) { this.tokens -= 1; this.hits++; return { allowed: true }; }
    const need = 1 - this.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(need / this.rate));
    this.hits++;
    return { allowed: false, retryAfterSec, resetAt: now + retryAfterSec * 1000 };
  }
}

export class RateLimiter {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.perMinute = Math.max(1, Number(opts.requestsPerMinute) || 600);
    this.burst = Math.max(1, Number(opts.burst) || Math.ceil(this.perMinute / 10));
    this.buckets = new Map(); // key → TokenBucket
    this.maxEntries = Math.max(64, Number(opts.maxEntries) || 5000);
  }

  reconfigure(opts = {}) {
    if (opts === null) { this.enabled = false; return; }
    this.enabled = opts.enabled !== false;
    if (Number.isFinite(Number(opts.requestsPerMinute))) this.perMinute = Math.max(1, Number(opts.requestsPerMinute));
    if (Number.isFinite(Number(opts.burst))) this.burst = Math.max(1, Number(opts.burst));
    // Kapasitas/rate baru → bucket lama tidak relevan lagi; jangan bikin client
    // yang kebetulan habis kuota tetap kena 429 setelah limit dinaikkan.
    this.buckets.clear();
  }

  prune(now = Date.now()) {
    if (this.buckets.size <= this.maxEntries) return;
    const idleMs = Math.ceil(60_000 * 60 / this.perMinute) + 120_000;
    for (const [k, b] of this.buckets) {
      if (now - b.ts > idleMs) this.buckets.delete(k);
    }
    // Masih terlalu besar? buang yang paling lama tidak dipakai.
    if (this.buckets.size > this.maxEntries) {
      const sorted = [...this.buckets.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [k] of sorted.slice(0, this.buckets.size - this.maxEntries)) this.buckets.delete(k);
    }
  }

  /** @returns {{allowed:boolean, limit:number, remaining:number, retryAfterSec?:number}} */
  check(key, now = Date.now()) {
    if (!this.enabled) return { allowed: true, limit: this.perMinute, remaining: this.perMinute };
    let b = this.buckets.get(key);
    if (!b) { b = new TokenBucket({ perMinute: this.perMinute, burst: this.burst }); this.buckets.set(key, b); this.prune(now); }
    const r = b.take(now);
    const remaining = Math.max(0, Math.floor(b.tokens));
    return r.allowed
      ? { allowed: true, limit: Math.round(b.capacity), remaining }
      : { allowed: false, limit: Math.round(b.capacity), remaining: 0, retryAfterSec: r.retryAfterSec };
  }
}

/** Semaphore sederhana untuk membatasi request upstream yang sedang berjalan. */
export class Semaphore {
  constructor(max = 32) {
    this.max = Math.max(1, Number(max) || 1);
    this.active = 0;
    this.waiters = [];
  }

  setMax(max) { this.max = Math.max(1, Number(max) || this.max); this.#drain(); }

  tryAcquire() {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }

  acquire() {
    if (this.active < this.max) { this.active++; return Promise.resolve(true); }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.#drain();
  }

  #drain() {
    while (this.waiters.length && this.active < this.max) { this.active++; this.waiters.shift()(true); }
  }
}

/** Kunci identitas pembatas: gateway key lebih dulu, lalu IP klien. */
export function rateKeyFor(req, gatewayKeyId) {
  const auth = String(req.headers['authorization'] || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return `k:${hash(m[1].trim())}`;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return `ip:${fwd || req.socket?.remoteAddress || '?'}`;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
