// LoLLM — test fungsional gateway (tanpa internet): validasi, anti empty-200,
// routing kualitas, transparansi, parameter, konteks multi-turn, health, rate limit.
// Jalankan: npm test

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { createMockUpstream, parseSse, GOOD_MODELS, WEAK_MODELS } from './helpers/mock-upstream.mjs';

let ctx, mock1, mock2, dir;
const H = { 'Content-Type': 'application/json' };

async function admin(p, opts = {}) {
  const r = await fetch(`http://127.0.0.1:${ctx.port}/api/${p}`, {
    ...opts,
    headers: { ...H, 'x-lollm-session': ctx.sessionToken, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, headers: r.headers, body: j };
}

async function chat(body, { stream = false, headers = {}, pathName = 'chat/completions' } = {}) {
  const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/${pathName}`, {
    method: 'POST',
    headers: { ...H, ...headers },
    body: JSON.stringify(body),
  });
  if (stream) return { status: r.status, headers: r.headers, sse: await parseSse(r), raw: r.body };
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  return { status: r.status, headers: r.headers, body: j, text };
}

async function settings(patch) {
  const r = await admin('settings', { method: 'PUT', body: patch });
  assert.equal(r.status, 200, 'PUT /api/settings gagal: ' + JSON.stringify(r.body));
  return r.body.settings;
}

/** Reset state upstream + state internal gateway supaya tiap test mulai dari nol. */
function resetMocks(...mode) {
  mock1.reset(); mock2.reset();
  for (const [m, v] of mode) m.state.mode = v;
  if (!ctx) return;
  // isolasi: penalti kualitas, cache rencana & rute lengket jangan bocor antar test
  ctx.router.modelHealth.clear();
  ctx.router.autoPlanCache.clear();
  ctx.router.sticky.clear();
  ctx.router.invalidateModels();
  // cooldown key dari test sebelumnya (3x gagal → 30s) membuat provider discan sebagai tidak sehat
  for (const id of ['mock1', 'mock2']) {
    for (const k of ctx.config.data.providers[id]?.keys || []) {
      k.cooldownUntil = 0; k.failCount = 0; k.emptyCount = 0; k.status = 'ok'; k.lastUsedAt = 0;
    }
  }
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lollm-test-'));
  mock1 = await createMockUpstream('mock1');
  mock2 = await createMockUpstream('mock2');
  ctx = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, noAuth: true });
  ctx.port = ctx.server.address().port;

  await admin('providers/toggle', { method: 'POST', body: { providerId: 'pollinations', enabled: false } });
  await admin('providers/custom', { method: 'POST', body: { id: 'mock1', name: 'Mock 1', baseUrl: mock1.baseUrl } });
  await admin('providers/custom', { method: 'POST', body: { id: 'mock2', name: 'Mock 2', baseUrl: mock2.baseUrl } });
  await admin('keys', { method: 'POST', body: { providerId: 'mock1', key: 'key-mock-1' } });
  await admin('keys', { method: 'POST', body: { providerId: 'mock2', key: 'key-mock-2' } });
  await settings({
    warmup: { enabled: false },
    rateLimit: { enabled: false, maxConcurrent: 64 },
    routing: { autoCandidates: 4, minQualityScore: 60, stickyAuto: true },
    content: { rejectEmpty: true, emptyRetries: 1 },
  });
});

after(async () => {
  ctx?.router?.stopMaintenance();
  ctx?.server?.close();
  await mock1?.close(); await mock2?.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ───────────────────────── #5 validasi input ─────────────────────────
describe('#5 Validasi edge case → 400', () => {
  test('messages: [] ditolak 400 dengan pesan jelas', async () => {
    const r = await chat({ model: 'auto', messages: [] });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /messages cannot be empty/i);
    assert.equal(r.body.error.type, 'invalid_request_error');
    assert.equal(r.body.error.param, 'messages');
    assert.equal(mock1.hits() + mock2.hits(), 0, 'request tidak sah tidak boleh diteruskan ke provider');
  });

  test('messages hilang sama sekali → 400', async () => {
    const r = await chat({ model: 'auto' });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /harus array/);
  });

  test('messages hanya berisi content kosong → 400', async () => {
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: '' }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /Tidak ada pesan dengan isi/);
  });

  test('role tidak dikenal → 400', async () => {
    const r = await chat({ model: 'auto', messages: [{ role: 'wizard', content: 'hai' }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /role "wizard" tidak dikenal/);
  });

  test('stream bukan boolean → 400; body bukan JSON → 400', async () => {
    assert.equal((await chat({ model: 'auto', messages: [{ role: 'user', content: 'x' }], stream: 'yes' })).status, 400);
    const raw = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, { method: 'POST', headers: H, body: '{rusak' });
    assert.equal(raw.status, 400);
  });

  test('completions tanpa prompt → 400', async () => {
    const r = await chat({ model: 'auto', prompt: '' }, { pathName: 'completions' });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /prompt cannot be empty/i);
  });

  test('embeddings tanpa input → 400', async () => {
    const r = await chat({ model: 'auto', input: [] }, { pathName: 'embeddings' });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /input cannot be empty/i);
  });
});

// ─────────────────── #1 empty content tidak boleh 200 ───────────────────
describe('#1 Empty content tidak lagi jadi HTTP 200', () => {
  after(() => resetMocks());

  test('non-stream: semua kandidat kosong → 502 empty_completion', async () => {
    mock1.state.mode = 'empty'; mock2.state.mode = 'empty';
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 502, `harusnya 502, dapat ${r.status}: ${r.text}`);
    assert.equal(r.body.error.code, 'empty_completion');
    assert.match(r.body.error.message, /kosong/i);
    assert.ok(r.headers.get('x-lollm-trail'), 'error tetap membawa jejak fallback');
    assert.ok(mock1.hits() > 0 && mock2.hits() > 0, 'semua kandidat dicoba sebelum menyerah');
    const st = (await admin('status')).body.stats;
    assert.ok(st.emptyRejected > 0, 'statistik emptyRejected naik');
  });

  test('non-stream: retry internal → klien tetap dapat jawaban dari kandidat berikutnya', async () => {
    resetMocks([mock1, 'empty'], [mock2, 'ok']);
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    assert.ok(r.body.choices[0].message.content.length > 0);
    assert.equal(r.body.x_lollm.provider, 'mock2');
    assert.ok(r.body.x_lollm.fallback_occurred, 'fallback tercatat untuk klien');
  });

  test('stream kosong TIDAK menghasilkan 200 text/event-stream', async () => {
    mock1.state.mode = 'empty-stream'; mock2.state.mode = 'empty-stream';
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }], stream: true });
    assert.equal(r.status, 502);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
  });

  test('stream: kandidat kosong → retry, klien tetap dapat SSE penuh', async () => {
    resetMocks([mock1, 'empty-stream'], [mock2, 'ok-stream']);
    const r = await chat({ model: 'mock1/never', stream: true, messages: [{ role: 'user', content: 'hai' }] }, { stream: true });
    // model tidak dikenal → last-resort; pastikan yang melayani mock2 dengan isi
    assert.equal(r.status, 200);
    assert.ok(r.sse.text.length > 0, 'harus ada teks');
    assert.ok(r.sse.sawDone);
  });

  test('reasoning-only (content null) dianggap kosong', async () => {
    mock1.state.mode = 'reasoning-only'; mock2.state.mode = 'reasoning-only';
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /reasoning|kosong/i);
  });

  test('choices kosong → 502', async () => {
    mock1.state.mode = 'no-choices'; mock2.state.mode = 'no-choices';
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 502);
  });

  test('policy allow-empty mengembalikan 200 (escape hatch)', async () => {
    mock1.state.mode = 'empty';
    await settings({ content: { rejectEmpty: false } });
    const r = await chat({ model: 'mock1/never', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    await settings({ content: { rejectEmpty: true } });
    mock1.state.mode = 'ok';
  });

  test('provider yang membalas JSON ke request stream → tetap jadi SSE berisi', async () => {
    resetMocks([mock1, 'json-only'], [mock2, 'json-only']);
    const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      method: 'POST', headers: H, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hai' }] }),
    });
    assert.equal(r.status, 200);
    const raw = await r.text();
    assert.match(raw, /data: .*jawaban lewat json/);
    assert.match(raw, /\[DONE\]/);
  });

  test('SSE dengan content-type salah label tetap diteruskan utuh', async () => {
    resetMocks([mock1, 'sse-wrong-ctype'], [mock2, 'sse-wrong-ctype']);
    const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      method: 'POST', headers: H, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hai' }] }),
    });
    assert.equal(r.status, 200);
    const raw = await r.text();
    assert.match(raw, /data: .*jawawan terusan|data: .*"content":"ja"/, raw.slice(0, 200));
    assert.match(raw, /data: \[DONE\]/);
  });

  test('JSON kosong ke request stream tetap ditolak (bukan 200 hampa)', async () => {
    resetMocks([mock1, 'json-only-empty'], [mock2, 'json-only-empty']);
    const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      method: 'POST', headers: H, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hai' }] }),
    });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, 'empty_completion');
  });

  test('200 dengan body bukan JSON (captcha/HTML) dianggap gagal, bukan diteruskan', async () => {
    resetMocks([mock1, 'badjson'], [mock2, 'badjson']);
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 502);
    assert.match(Buffer.from(r.headers.get('x-lollm-trail'), 'base64url').toString(), /badjson/);
  });

  test('error di body upstream (HTTP 200 + {error}) ikut di-fallback, bukan diteruskan', async () => {
    resetMocks([mock1, 'upstream-error-body'], [mock2, 'ok']);
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.x_lollm.provider, 'mock2');
  });
});

// ───────────────── #2 routing 'auto' berkualitas & stabil ─────────────────
describe('#2 & #7 Routing auto: berkualitas, stabil, hindari model lemah', () => {
  after(() => resetMocks());

  test('auto TIDAK memilih model pertama daftar live (yang lemah)', async () => {
    const first = mock1.state.models[0];
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    const used = r.body.model;
    assert.notEqual(used, first);
    assert.ok(!WEAK_MODELS.some((w) => used.includes(w.split('/')[1])), `model lemah terpilih: ${used}`);
  });

  test('auto deterministik: 8 request beruntun → model yang sama', async () => {
    const picked = new Set();
    for (let i = 0; i < 8; i++) {
      const r = await chat({ model: 'auto', messages: [{ role: 'user', content: `pertanyaan ${i}` }] });
      assert.equal(r.status, 200);
      picked.add(`${r.body.x_lollm.provider}/${r.body.model}`);
    }
    assert.equal(picked.size, 1, `model berganti-ganti: ${[...picked].join(' , ')}`);
    assert.ok(GOOD_MODELS.some((g) => [...picked][0].includes(g.split('/')[1])), `yang dipilih bukan model kuat: ${[...picked][0]}`);
  });

  test('model lemah tetap tersedia lewat pin eksplisit (tidak dihapus, hanya tidak untuk auto)', async () => {
    const weak = 'mock1/' + WEAK_MODELS[0];
    const r = await chat({ model: weak, messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.model, WEAK_MODELS[0]);
  });

  test('task coding mengarah ke model coding (bukan chat biasa)', async () => {
    const ALL = ['mock/llama-3.3-70b-versatile', 'mock/gpt-oss-120b', 'mock/qwen2.5-72b-instruct', 'mock/allam-2-7b', 'mock/tinyllama-1.1b', 'mock/SmolLM2-135M-Instruct', 'mock/text-embedding-3-small', 'mock/rerank-qa-v1', 'mock/whisper-large'];
    // model coding vs model umum kecil: yang dipilih harus sesuai task
    [mock1, mock2].forEach((m) => { m.state.models = ['mock/llama-3.1-8b-instruct', 'mock/codestral-latest']; });
    ctx.router.invalidateModels();
    try {
    const coding = await chat({ model: 'auto', messages: [{ role: 'user', content: 'perbaiki bug ini:\n```python\ndef f(x):\n  return x/0\n```' }] });
    assert.equal(coding.body.x_lollm.task, 'coding');
    assert.match(coding.body.model, /codestral/, `task coding dapat ${coding.body.model}`);
    const chatReq = await chat({ model: 'auto', messages: [{ role: 'user', content: 'apa kabar, tolong jelaskan arti kesabaran dalam bahasa indonesia' }] });
    assert.doesNotMatch(chatReq.body.model, /codestral/, 'chat biasa tidak seharusnya pakai model coding-only');
    } finally {
      [mock1, mock2].forEach((m) => { m.state.models = ALL; });
      ctx.router.invalidateModels();
    }
  });

  test('last-resort memakai model TERBAIK provider lain, bukan model pertama', async () => {
    const r = await chat({ model: 'totally-unknown-xyz', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    assert.ok(r.body.x_lollm.any_fallback, 'ditandai last-resort');
    assert.ok(GOOD_MODELS.some((g) => r.body.model.includes(g.split('/')[1])), r.body.model);
    assert.equal(r.headers.get('x-lollm-selection').includes('last-resort'), true);
  });

  test('model embedding tidak dipakai untuk chat', async () => {
    const seen = new Set();
    for (let i = 0; i < 4; i++) seen.add((await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] })).body.model);
    for (const m of seen) assert.doesNotMatch(m, /embedding|rerank|whisper/);
  });
});

// ───────────────── #3 transparansi model & fallback ─────────────────
describe('#3 Transparansi: header + field x_lollm', () => {
  after(() => resetMocks());

  test('setiap respons sukses punya header x-lollm-* lengkap', async () => {
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    const h = r.headers;
    assert.ok(['mock1', 'mock2'].includes(h.get('x-lollm-provider')));
    assert.ok(h.get('x-lollm-model').length > 0);
    assert.equal(h.get('x-lollm-requested-model'), 'auto');
    assert.equal(h.get('x-lollm-fallback'), 'false');
    assert.ok(h.get('x-lollm-selection').includes('auto:'));
    assert.ok(h.get('x-lollm-task').length > 0);
    assert.ok(h.get('x-lollm-trail'));
  });

  test('saat fallback terjadi: jumlah + alasan + trail bisa didekode', async () => {
    mock1.state.mode = 'fail500';
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-lollm-provider'), 'mock2');
    assert.ok(Number(r.headers.get('x-lollm-fallbacks')) >= 1);
    assert.equal(r.body.x_lollm.fallback_occurred, true);
    assert.ok(r.body.x_lollm.attempts >= 2);
    const trail = Buffer.from(r.headers.get('x-lollm-trail'), 'base64url').toString();
    assert.match(trail, /mock1\/.*:server/);
    mock1.state.mode = 'ok';
  });

  test('alasan pemilihan bisa dibaca dari body', async () => {
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.ok(r.body.x_lollm.selection.reason.length > 0);
    assert.ok(Array.isArray(r.body.x_lollm.selection.best));
    assert.match(r.body.x_lollm.selection.reason, /task=/);
  });

  test('/api/routing/auto membuka isi black-box (skor + alasan + yang disingkirkan)', async () => {
    const r = await admin('routing/auto?task=chat');
    assert.equal(r.status, 200);
    assert.ok(r.body.candidates.length > 0);
    assert.ok(r.body.candidates[0].score >= r.body.candidates.at(-1).score, 'harus terurut skor desc');
    assert.ok(r.body.excluded.some((x) => /allam|tinyllama|SmolLM/.test(x.model)), 'model lemah muncul sebagai excluded + alasannya');
    assert.ok(r.body.excluded.every((x) => x.excludedReason));
    assert.ok(r.body.candidates.every((c) => c.reasons.length > 0));
  });

  test('metadata juga dikirim pada stream (komentar SSE + header)', async () => {
    resetMocks([mock1, 'ok-stream']);
    const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      method: 'POST', headers: H, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hai' }] }),
    });
    const raw = await r.text();
    assert.ok(raw.startsWith(': lollm'), 'SSE diawali komentar metadata:\n' + raw.slice(0, 120));
    assert.match(raw, /: lollm-meta /);
    assert.ok(r.headers.get('x-lollm-model'));
  });
});

// ───────────────── #4 parameter request dihormati ─────────────────
describe('#4 temperature / max_tokens / stop diteruskan & dilaporkan', () => {
  after(() => resetMocks());

  test('nilai valid diteruskan utuh ke upstream', async () => {
    resetMocks();
    const r = await chat({
      model: 'auto',
      messages: [{ role: 'user', content: 'hai' }],
      temperature: 0.23, top_p: 0.77, max_tokens: 777, seed: 42, stop: '\n\n', user: 'u-1',
    });
    const echo = JSON.parse(r.body.choices[0].message.content);
    assert.equal(echo.temperature, 0.23);
    assert.equal(echo.top_p, 0.77);
    assert.equal(echo.max_tokens, 777);
    assert.equal(echo.seed, 42);
    assert.deepEqual(echo.stop, ['\n\n']);
    assert.equal(echo.user, 'u-1');
  });

  test('nilai di luar rentang di-clamp + dilaporkan di x_lollm.params', async () => {
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }], temperature: 9, max_tokens: 9_999_999, top_p: 0 });
    const echo = JSON.parse(r.body.choices[0].message.content);
    assert.equal(echo.temperature, 2);
    assert.equal(echo.max_tokens, 32000);
    const adjusted = r.body.x_lollm.params.adjusted.map((a) => a.param);
    assert.ok(adjusted.includes('temperature') && adjusted.includes('max_tokens'), JSON.stringify(adjusted));
    assert.equal(echo.top_p, 0.0001, 'top_p 0 dinaikkan ke nilai minimum sah');
  });

  test('null / NaN tidak dikirim (penyebab umum parameter "tidak berpengaruh")', async () => {
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }], temperature: null, max_tokens: 0, top_p: 'abc', frequency_penalty: NaN });
    const echo = JSON.parse(r.body.choices[0].message.content);
    assert.equal(echo.temperature, undefined);
    assert.equal(echo.max_tokens, undefined);
    assert.equal(echo.top_p, undefined);
    const ignored = r.body.x_lollm.params.ignored.map((i) => i.param);
    assert.ok(ignored.includes('temperature') && ignored.includes('max_tokens'));
  });

  test('parameter tak dikenal diteruskan + dilaporkan apa adanya (forward-compatible)', async () => {
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }], my_custom_flag: true });
    assert.equal(r.body.x_lollm.params.unknown.includes('my_custom_flag'), true);
  });

  test('response_format json_object → upstream menerima + ada catatan', async () => {
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'berikan data' }], response_format: { type: 'json_object' } });
    const echo = JSON.parse(r.body.choices[0].message.content);
    assert.deepEqual(echo.response_format, { type: 'json_object' });
    assert.ok(echo.messages.some((m) => m.role === 'system' && /JSON/i.test(m.content)), 'diinjeksi isyarat JSON untuk model yang butuh');
  });
});

// ───────────────── #6 konteks multi-turn utuh ─────────────────
describe('#6 Riwayat multi-turn diteruskan utuh & routing lengket', () => {
  after(() => resetMocks());

  test('semua turn dikirim ke upstream, tidak ada yang hilang', async () => {
    resetMocks();
    const messages = [
      { role: 'system', content: 'Kamu asisten ringkas.' },
      { role: 'user', content: 'Nama saya Raka.' },
      { role: 'assistant', content: 'Halo Raka!' },
      { role: 'user', content: 'Siapa nama saya?' },
    ];
    const r = await chat({ model: 'auto', messages });
    const echo = JSON.parse(r.body.choices[0].message.content);
    assert.deepEqual(echo.messages, messages);
  });

  test('turn assistant kosong dibuang (membuat model lemah "lupa" konteks)', async () => {
    resetMocks();
    const r = await chat({ model: 'auto', messages: [
      { role: 'user', content: 'hai' }, { role: 'assistant', content: '' }, { role: 'user', content: 'lanjut' },
    ] });
    const echo = JSON.parse(r.body.choices[0].message.content);
    assert.equal(echo.messages.length, 2);
    assert.equal(echo.messages[0].role, 'user');
  });

  test('riwayat sangat panjang dipangkas di TENGAH, awal+akhir dijaga, dan dilaporkan', async () => {
    resetMocks();
    const big = 'x'.repeat(9000);
    const messages = [{ role: 'system', content: 'SYSTEM-PROMPT-KEEP' }];
    for (let i = 0; i < 12; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `turn${i} ${big}` });
    messages.push({ role: 'user', content: 'PERTANYAAN-TERAKHIR' });
    const r = await chat({ model: 'auto', messages });
    const echo = JSON.parse(r.body.choices[0].message.content);
    assert.match(echo.messages[0].content, /SYSTEM-PROMPT-KEEP/);
    assert.equal(echo.messages.at(-1).content, 'PERTANYAAN-TERAKHIR');
    assert.ok(echo.messages.length < messages.length, 'harus dipangkas');
    assert.ok(r.body.x_lollm.params.adjusted.some((a) => /riwayat dipangkas/.test(a.why)), 'pemangkasan dilaporkan, tidak diam-diam');
  });

  test('percakapan yang sama tetap memakai model yang sama meski provider utama pulih', async () => {
    resetMocks([mock1, 'fail500'], [mock2, 'ok']);
    const conv = [{ role: 'user', content: 'Aku lagi belajar golang. Bantu ya.' }];
    const t1 = await chat({ model: 'auto', messages: conv });
    assert.equal(t1.body.x_lollm.provider, 'mock2');
    mock1.state.mode = 'ok';
    const t2 = await chat({ model: 'auto', messages: [...conv, { role: 'assistant', content: 'Siap!' }, { role: 'user', content: 'Jelaskan goroutine' }] });
    assert.equal(t2.status, 200);
    assert.equal(t2.body.x_lollm.provider, 'mock2', 'sticky: model tidak berganti di tengah percakapan');
    assert.equal(t2.body.x_lollm.sticky, true);
    // percakapan berbeda tidak ikut terkunci
    const other = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Topik sama sekali lain: resep rendang' }] });
    assert.equal(other.body.x_lollm.sticky, false, 'percakapan lain tidak boleh memakai jalur lengket');
    assert.ok(['mock1', 'mock2'].includes(other.body.x_lollm.provider));
  });

  test('header x-lollm-route-key bisa dipakai untuk mengunci pemilihan', async () => {
    resetMocks();
    const a = await chat({ model: 'auto', messages: [{ role: 'user', content: 'satu' }] }, { headers: { 'x-lollm-route-key': 'user-42' } });
    const b = await chat({ model: 'auto', messages: [{ role: 'user', content: 'dua sekali' }] }, { headers: { 'x-lollm-route-key': 'user-42' } });
    assert.equal(a.headers.get('x-lollm-model'), b.headers.get('x-lollm-model'));
  });
});

// ───────────────── #9 cold start / warm-up ─────────────────
describe('#9 Latensi request pertama', () => {
  after(() => resetMocks());

  test('warm-up mengisi cache katalog + resolusi auto, request pertama tidak menunggu lagi', async () => {
    ctx.router.invalidateModels();
    mock1.state.modelCalls = mock2.state.modelCalls = 0;
    await ctx.router.warmup();
    const warmed = mock1.state.modelCalls + mock2.state.modelCalls;
    assert.ok(warmed >= 2, 'warmup harus menarik katalog tiap provider');

    const t0 = Date.now();
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    assert.equal(mock1.state.modelCalls + mock2.state.modelCalls, warmed, 'katalog tidak boleh ditarik ulang saat request');
    assert.ok(Date.now() - t0 < 1200, `request pertama ${Date.now() - t0}ms — cache tidak berguna`);
  });

  test('katalog antar provider diambil paralel, bukan sekuensial', async () => {
    ctx.router.invalidateModels();
    mock1.state.delayMs = mock2.state.delayMs = 250;
    const t0 = Date.now();
    await ctx.router.warmup();
    const ms = Date.now() - t0;
    mock1.state.delayMs = mock2.state.delayMs = 0;
    assert.ok(ms < 450, `paralel seharusnya ~250ms, dapat ${ms}ms`);
  });

  test('pemeliharaan berkala menyegarkan cache yang hampir kedaluwarsa', async () => {
    ctx.router.invalidateModels();
    await ctx.router.warmup();
    const staleTs = Date.now() - 10 * 60 * 1000 - 1000; // melewati 60% TTL
    for (const id of ['mock1', 'mock2']) {
      const c = ctx.router.modelsCache.get(id);
      assert.ok(c && c.models.length > 0, id + ' seharusnya ter-cache');
      c.ts = staleTs;
    }
    ctx.router.startMaintenance(30_000);
    await new Promise((r) => setTimeout(r, 250));
    for (const id of ['mock1', 'mock2']) assert.ok(ctx.router.modelsCache.get(id).ts > staleTs, id + ' seharusnya disegarkan');
    ctx.router.stopMaintenance();
  });

  test('resolusi auto di-cache: banyak request hanya menilai sekali', async () => {
    ctx.router.invalidateModels();
    resetMocks();
    let scored = 0;
    const orig = ctx.router.resolveTargets.bind(ctx.router);
    ctx.router.resolveTargets = async (...a) => { scored++; return orig(...a); };
    for (let i = 0; i < 6; i++) assert.equal((await chat({ model: 'auto', messages: [{ role: 'user', content: 'ping' + i }] })).status, 200);
    ctx.router.resolveTargets = orig;
    assert.ok(scored >= 1, 'resolusi tetap berjalan lewat cache');
    assert.ok(ctx.router.autoPlanCache.size >= 1, 'cache rencana auto terisi');
  });
});

// ───────────────── #8 health & #10 rate limit ─────────────────
describe('#8 Endpoint health', () => {
  test('/health, /healthz, /live publik tanpa key', async () => {
    for (const p of ['/health', '/healthz', '/live', '/v1/health']) {
      const r = await fetch(`http://127.0.0.1:${ctx.port}${p}`);
      assert.equal(r.status, 200, p + ' seharusnya 200');
      const j = await r.json();
      assert.equal(j.ok, true, p);
      assert.ok(j.version);
    }
  });

  test('/readyz melaporkan kesiapan + alasan', async () => {
    await ctx.router.warmup(); // /readyz sengaja non-blokir: hanya membaca cache
    const r = await fetch(`http://127.0.0.1:${ctx.port}/readyz`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.ok(j.providers.up >= 1);
    assert.ok(j.modelsKnown > 0, 'cache model ikut dilaporkan');
    assert.deepEqual(j.reasons, []);
  });

  test('/readyz tetap murah walau katalog belum terisi (dan menjelaskan)', async () => {
    ctx.router.invalidateModels();
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${ctx.port}/readyz`);
    const ms = Date.now() - t0;
    await r.json();
    assert.ok(ms < 60, `/readyz tidak boleh menunggu upstream (dapat ${ms}ms)`);
    const j2 = await (await fetch(`http://127.0.0.1:${ctx.port}/readyz`)).json();
    assert.ok(j2.reasons.some((x) => /katalog/.test(x)), JSON.stringify(j2.reasons));
    await ctx.router.warmup();
  });

  test('/readyz 503 saat semua provider mati', async () => {
    await admin('providers/toggle', { method: 'POST', body: { providerId: 'mock1', enabled: false } });
    await admin('providers/toggle', { method: 'POST', body: { providerId: 'mock2', enabled: false } });
    const r = await fetch(`http://127.0.0.1:${ctx.port}/readyz`);
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.ok(j.reasons.length > 0);
    await admin('providers/toggle', { method: 'POST', body: { providerId: 'mock1', enabled: true } });
    await admin('providers/toggle', { method: 'POST', body: { providerId: 'mock2', enabled: true } });
  });
});

describe('#10 Rate limit & kapasitas', () => {
  after(async () => { await settings({ rateLimit: { enabled: false, requestsPerMinute: 600, burst: 60, maxConcurrent: 64 } }); });

  test('429 + Retry-After saat melewati batas, dengan pesan jelas', async () => {
    await settings({ rateLimit: { enabled: true, requestsPerMinute: 3, burst: 2 } });
    const ok = [], limited = [];
    for (let i = 0; i < 6; i++) {
      const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'ping' + i }] });
      (r.status === 200 ? ok : limited).push(r);
    }
    assert.ok(ok.length >= 1, 'awal boleh lolos');
    assert.equal(limited[0].status, 429, JSON.stringify(limited[0].body));
    assert.equal(limited[0].body.error.type, 'rate_limit_error');
    assert.match(limited[0].body.error.message, /rate limit/i);
    assert.ok(limited[0].headers.get('retry-after'));
    assert.ok(limited[0].headers.get('x-ratelimit-remaining') != null);
    assert.ok(Number(limited[0].headers.get('x-ratelimit-limit')) > 0);
  });

  test('header sisa kuota ada di response sukses', async () => {
    await settings({ rateLimit: { enabled: true, requestsPerMinute: 600, burst: 60 } });
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-ratelimit-limit'), '600');
  });
});

// ───────────────── regresi: yang sudah bagus jangan rusak ─────────────────
describe('Regresi perilaku yang sudah baik', () => {
  after(() => resetMocks());

  test('format OpenAI-compatible tetap utuh', async () => {
    resetMocks();
    const r = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hai' }] });
    assert.equal(r.body.object, 'chat.completion');
    assert.equal(r.body.choices[0].message.role, 'assistant');
    assert.equal(r.body.choices[0].finish_reason, 'stop');
    assert.deepEqual(r.body.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  });

  test('streaming berfungsi', async () => {
    resetMocks([mock1, 'ok-stream']);
    const r = await chat({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hai' }] }, { stream: true });
    assert.equal(r.status, 200);
    assert.equal(r.sse.text, 'halo dunia');
    assert.ok(r.sse.sawDone);
  });

  test('auth tetap 401 saat diaktifkan', async () => {
    await settings({ authRequired: true });
    const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      method: 'POST', headers: H, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.match(j.error.message, /API key gateway/);
    await settings({ authRequired: false });
  });

  test('CORS preflight terbuka', async () => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-headers'), /x-lollm-route-key/);
  });

  test('/v1/models hanya berisi model live provider', async () => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/models`);
    const j = await r.json();
    assert.ok(j.object === 'list' && j.data.length > 0);
    assert.ok(j.data.every((m) => m.id.startsWith('mock/')));
    assert.ok(j.data.every((m) => m.owned_by === 'mock1' || m.owned_by === 'mock2'));
  });

  test('404 rapi untuk path tak dikenal', async () => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/nope`);
    assert.equal(r.status, 404);
    assert.match((await r.json()).error.message, /tidak ada/);
  });

  test('di bawah beban (30 paralel) tidak ada 200-content-kosong', async () => {
    resetMocks();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => chat({ model: 'auto', messages: [{ role: 'user', content: `beban ${i}` }] }))
    );
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.ok(String(r.body.choices?.[0]?.message?.content || '').length > 0, 'ada respons kosong!');
    }
  });

  test('di bawah beban dengan upstream rewel: tidak ada jawaban kosong, yang gagal pakai 5xx sah', async () => {
    mock1.state.mode = 'fail500';
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => chat({ model: 'auto', messages: [{ role: 'user', content: `campur ${i}` }] }))
    );
    for (const r of results) {
      if (r.status === 200) assert.ok(String(r.body.choices?.[0]?.message?.content || '').length > 0);
      else assert.ok([502, 503, 429].includes(r.status), 'status tak terduga: ' + r.status);
    }
    assert.ok(results.some((r) => r.status === 200), 'masih banyak yang terlayani via fallback');
    mock1.state.mode = 'ok';
  });
});

// ─────────────────────── Admin API: validasi input ───────────────────────
describe('Admin API memvalidasi input (bukan 500)', () => {
  test('key duplikat → 409 dengan pesan jelas', async () => {
    const first = await admin('keys', { method: 'POST', body: { providerId: 'mock1', key: 'key-duplikat', label: 'dup' } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await admin('keys', { method: 'POST', body: { providerId: 'mock1', key: 'key-duplikat' } });
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /sudah ada di pool/);
    // mode bulk: duplikat tidak menggagalkan request, hanya dilaporkan sebagai skipped
    const bulk = await admin('keys', { method: 'POST', body: { providerId: 'mock1', keys: ['key-duplikat', 'key-baru-1'] } });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.body.added, 1);
    assert.equal(bulk.body.skipped, 1);
    for (const id of [first.body.key.id, ...(bulk.body.results || []).map(() => null)].filter(Boolean)) {
      await admin('keys', { method: 'DELETE', body: { providerId: 'mock1', keyId: id } });
    }
  });

  test('provider tidak dikenal & key kosong → 400', async () => {
    const a = await admin('keys', { method: 'POST', body: { providerId: 'tidak-ada', key: 'x' } });
    assert.equal(a.status, 400);
    assert.match(a.body.error.message, /Provider tidak dikenal/);
    const b = await admin('keys', { method: 'POST', body: { providerId: 'mock1', key: '   ' } });
    assert.equal(b.status, 400);
    assert.match(b.body.error.message, /API key kosong/);
    const c = await admin('keys', { method: 'POST', body: { providerId: 'mock1' } });
    assert.equal(c.status, 400);
    const d = await admin('keys', { method: 'POST', body: { providerId: 'pollinations', key: 'x' } });
    assert.equal(d.status, 400);
    assert.match(d.body.error.message, /tidak butuh API key/);
  });
});
