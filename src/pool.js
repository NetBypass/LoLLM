// LoLLM — Key pool: status key, rotasi LRU, cooldown, circuit breaker ringan.
// Murni fungsi di atas object provider config (persistence di Config).

// Status sebuah key pada saat now: 'ok' | 'cooling' | 'dead' | 'disabled'
export function keyState(key, now = Date.now()) {
  if (key.enabled === false) return 'disabled';
  if (key.status === 'dead') return 'dead';
  if (key.cooldownUntil && key.cooldownUntil > now) return 'cooling';
  return 'ok';
}

// Key sehat untuk dipakai (rotasi LRU: paling lama tidak dipakai menang).
export function healthyKeys(pconf, now = Date.now()) {
  return pconf.keys
    .filter((k) => keyState(k, now) === 'ok')
    .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
}

export function pickKey(pconf, now = Date.now()) {
  return healthyKeys(pconf, now)[0] || null;
}

// Provider layak dicoba? (enabled, punya key yang tidak dead/disabled)
export function providerUsable(pconf, now = Date.now()) {
  if (pconf.enabled === false) return false;
  return pconf.keys.some((k) => keyState(k, now) !== 'dead' && keyState(k, now) !== 'disabled');
}

// Provider "sehat" = usable + minimal satu key ok (bukan cooling).
export function providerHealthy(pconf, now = Date.now()) {
  if (pconf.enabled === false) return false;
  return pconf.keys.some((k) => keyState(k, now) === 'ok');
}

export function reportSuccess(pconf, keyId) {
  const k = pconf.keys.find((x) => x.id === keyId);
  if (!k) return;
  k.status = 'ok';
  k.cooldownUntil = 0;
  k.failCount = 0;
  k.emptyCount = 0;
  k.success = (k.success || 0) + 1;
  k.lastUsedAt = Date.now();
}

/**
 * kind: 'auth' (401/403) | 'rate' (429) | 'timeout' | 'server' | 'network' | 'model' | 'client' | 'empty'
 */
export function reportFailure(pconf, keyId, kind, info = {}) {
  const k = pconf.keys.find((x) => x.id === keyId);
  if (!k || k.id === 'keyless') return;
  k.fail = (k.fail || 0) + 1;
  k.lastError = info.error ? String(info.error).slice(0, 300) : kind;
  k.lastErrorAt = Date.now();
  if (kind === 'auth') {
    k.status = 'dead';
  } else if (kind === 'rate') {
    const sec = Math.min(Math.max(Number(info.retryAfterSec) || 60, 20), 600);
    k.cooldownUntil = Date.now() + sec * 1000;
  } else if (kind === 'empty') {
    // 200 tanpa isi bukan kesalahan kredensial: jangan cooldown key (itu memicu 503
    // berantai saat satu provider sedang ngadat). Yang dihukum adalah MODEL-nya,
    // lewat Router.noteModelFailure → skor routing turun & pulih sendiri.
    k.emptyCount = (k.emptyCount || 0) + 1;
  } else if (kind === 'timeout' || kind === 'network' || kind === 'server') {
    k.failCount = (k.failCount || 0) + 1;
    // 3x gagal beruntun → cooldown singkat 30s
    if (k.failCount >= 3) {
      k.cooldownUntil = Date.now() + 30_000;
      k.failCount = 0;
    }
  } else if (kind === 'client' || kind === 'model') {
    k.emptyCount = 0;
    k.failCount = 0;
  }
}

export function keySummary(pconf) {
  const now = Date.now();
  const counts = { ok: 0, cooling: 0, dead: 0, disabled: 0 };
  for (const k of pconf.keys) counts[keyState(k, now)]++;
  return counts;
}
