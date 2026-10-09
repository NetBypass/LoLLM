// LoLLM — test unit normalisasi & validasi parameter (src/params.js).
// Menjamin klaim "parameter dihormati": yang sah diteruskan, yang rusak dibersihkan
// dan DILAPORKAN (bukan diperlakukan diam-diam).

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, normalizeParams, sanitizeHistory, guardContext, isEmptyCompletion } from '../src/params.js';

const base = { model: 'x', messages: [{ role: 'user', content: 'hai' }] };

test('validasi: messages kosong / hilang / role aneh → 400', () => {
  for (const body of [{ model: 'x', messages: [] }, { model: 'x' }, { model: 'x', messages: 'nope' }]) {
    assert.throws(() => validateRequest('chat/completions', body), (e) => e.status === 400 && e.param === 'messages');
  }
  assert.throws(() => validateRequest('chat/completions', { model: 'x', messages: [{ role: 'alien', content: 'a' }] }), (e) => /tidak dikenal/.test(e.message));
  assert.throws(() => validateRequest('chat/completions', { model: 'x', messages: [{ role: 'tool', content: 'a' }] }), (e) => /tool_call_id/.test(e.message));
  assert.doesNotThrow(() => validateRequest('chat/completions', base));
});

test('validasi: messages content array bentuk parts diterima', () => {
  assert.doesNotThrow(() => validateRequest('chat/completions', { model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hai' }] }] }));
});

test('validasi: assistant tanpa content tapi dengan tool_calls diterima', () => {
  assert.doesNotThrow(() => validateRequest('chat/completions', {
    model: 'x',
    messages: [{ role: 'user', content: 'cuaca?' }, { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }],
  }));
});

test('validasi: completions & embeddings', () => {
  assert.throws(() => validateRequest('completions', { model: 'x', prompt: '' }), (e) => e.param === 'prompt');
  assert.doesNotThrow(() => validateRequest('completions', { model: 'x', prompt: 'ada' }));
  assert.throws(() => validateRequest('embeddings', { model: 'x', input: [''] }), (e) => /input/.test(e.message));
  assert.doesNotThrow(() => validateRequest('embeddings', { model: 'x', input: ['a', 'b'] }));
});

test('normalize: clamp ke rentang sah + dicatat', () => {
  const { body, meta } = normalizeParams({ ...base, temperature: 4.5, top_p: 3, presence_penalty: -9, n: 40 }, {});
  assert.equal(body.temperature, 2);
  assert.equal(body.top_p, 1);
  assert.equal(body.presence_penalty, -2);
  assert.equal(body.n, 8);
  assert.deepEqual(meta.adjusted.map((a) => a.param).sort(), ['n', 'presence_penalty', 'temperature', 'top_p']);
});

test('normalize: nilai rusak dibuang, dilaporkan, tidak diteruskan', () => {
  const { body, meta } = normalizeParams({ ...base, temperature: null, top_p: 'abc', max_tokens: -5, seed: NaN, stop: [] }, {});
  for (const k of ['temperature', 'top_p', 'max_tokens', 'seed', 'stop']) assert.ok(!(k in body), `${k} tidak boleh diteruskan`);
  assert.ok(meta.ignored.length >= 4, JSON.stringify(meta.ignored));
});

test('normalize: nilai valid utuh apa adanya', () => {
  const { body, meta } = normalizeParams({ ...base, temperature: 0.7, max_tokens: 512, top_p: 0.9, stop: '###', response_format: { type: 'json_object' }, logit_bias: { 5: -2 } }, {});
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_tokens, 512);
  assert.deepEqual(body.stop, ['###']);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.logit_bias, { 5: -2 });
  assert.equal(meta.adjusted.filter((a) => a.param !== 'response_format').length, 0);
});

test('normalize: stream:false tidak dikirim (biar upstream tidak kirim SSE)', () => {
  const { body } = normalizeParams({ ...base, stream: false }, {});
  assert.ok(!('stream' in body));
  const yes = normalizeParams({ ...base, stream: true }, {});
  assert.equal(yes.body.stream, true);
});

test('normalize: parameter tak dikenal diteruskan & dilaporkan sebagai unknown', () => {
  const { body, meta } = normalizeParams({ ...base, provider_routing: { only: ['groq'] } }, {});
  assert.deepEqual(body.provider_routing, { only: ['groq'] });
  assert.ok(meta.unknown.includes('provider_routing'));
});

test('normalize: gaya anthropic memakai max_tokens wajib + stop_sequences', () => {
  const a = normalizeParams({ ...base, stop: ['END'], max_tokens: 300 }, { style: 'anthropic' });
  assert.equal(a.body.max_tokens, 300);
  assert.ok(!('stop' in a.body), 'stop dikonversi, bukan dikirim mentah');
  const b = normalizeParams(base, { style: 'anthropic' });
  assert.equal(b.body.max_tokens, 4096, 'Anthropic butuh max_tokens — jangan 1024 diam-diam');
});

test('sanitizeHistory: parts → string, turn kosong dibuang', () => {
  const body = { messages: [
    { role: 'system', content: 'jadi ringkas' },
    { role: 'user', content: [{ type: 'text', text: 'halo' }, { type: 'text', text: 'dunia' }] },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'lanjut' },
  ] };
  const r = sanitizeHistory(body);
  assert.equal(r.changed, true);
  assert.equal(r.removed, 1);
  assert.equal(body.messages[1].content, 'halo\ndunia');
  assert.equal(body.messages.length, 3);
});

test('sanitizeHistory: riwayat assistant berisi dibiarkan (penting untuk konteks)', () => {
  const body = { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };
  assert.equal(sanitizeHistory(body).changed, false);
  assert.equal(body.messages.length, 3);
});

test('sanitizeHistory: bagian non-teks (image) tidak diratakan', () => {
  const body = { messages: [
    { role: 'user', content: [{ type: 'text', text: 'apa ini?' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
  ] };
  sanitizeHistory(body, { flattenContent: true });
  assert.ok(Array.isArray(body.messages[0].content), 'multimodal dibiarkan utuh');
  const texty = { messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] };
  sanitizeHistory(texty, { flattenContent: true });
  assert.equal(texty.messages[0].content, 'a\nb', 'array murni teks diratakan');
});

test('guardContext: potong di tengah, jaga system + akhir', () => {
  const messages = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 40; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(3000) });
  messages.push({ role: 'user', content: 'TERAKHIR' });
  const body = { messages };
  const r = guardContext(body, { enabled: true, maxChars: 20000, minRecentTurns: 4 });
  assert.ok(r.dropped > 0, 'harus ada yang dipangkas');
  assert.ok(body.messages.length < messages.length);
  assert.equal(body.messages[0].content, 'S');
  assert.equal(body.messages.at(-1).content, 'TERAKHIR');
  assert.ok(body.messages[1].content.includes('dipangkas'), 'ada catatan transparan untuk model');
});

test('guardContext: riwayat pendek tidak disentuh sama sekali', () => {
  const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  const body = { messages: [...messages] };
  assert.equal(guardContext(body, { enabled: true, maxChars: 60000, minRecentTurns: 4 }).dropped, 0);
  assert.deepEqual(body.messages, messages);
});

test('isEmptyCompletion: semua varian kosong tertangkap', () => {
  assert.equal(isEmptyCompletion({ choices: [] }).empty, true);
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: '' } }] }).empty, true);
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: '  \n ' }, finish_reason: 'stop' }] }).empty, true);
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: null, reasoning_content: 'mikir' } }] }).why, 'reasoning-only');
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: '' , tool_calls: [{ id: 'c' }] } }] }).empty, false);
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: 'jawaban' } }] }).empty, false);
  assert.equal(isEmptyCompletion(null).empty, true);
  assert.equal(isEmptyCompletion({ error: { message: 'x' } }).empty, false, 'error upstream ditangani jalur sendiri');
});
