// LoLLM — test unit pemilihan kualitas model (src/quality.js).
// Ini yang menjaga "auto" tetap masuk akal: model lemah tidak terpilih,
// dan pilihan tidak berubah-ubah tanpa sebab.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreModel, rankModels, detectTask, paramSize, DEFAULT_BLOCKLIST } from '../src/quality.js';

const score = (m, task = 'chat') => scoreModel(m, { task }).score;

test('ukuran parameter terbaca dari nama model', () => {
  assert.equal(paramSize('llama-3.3-70b-versatile'), 70);
  assert.equal(paramSize('qwen2.5-coder-32b'), 32);
  assert.equal(paramSize('mixtral-8x7b'), 56);
  assert.equal(paramSize('gemma-3-4b-it'), 4);
  assert.equal(paramSize('gpt-oss-120b'), 120);
  assert.equal(paramSize('gpt-4.1-mini'), null);
});

test('model lemah yang bikin kualitas anjlok tidak lolos auto', () => {
  for (const weak of ['allam-2-7b', 'TinyLlama-1.1B', 'SmolLM2-135M-Instruct', 'qwen2.5-0.5b', 'llama-3.2-1b-it', 'gemma-2-2b-it', 'phi-2']) {
    const r = scoreModel(weak, { task: 'chat' });
    assert.ok(r.blocked, `${weak} seharusnya di-block dari auto`);
  }
  assert.ok(DEFAULT_BLOCKLIST.includes('allam'));
});

test('model kuat selalu menang atas model lemah dalam satu daftar', () => {
  const ranked = rankModels(['allam-2-7b', 'tinyllama-1.1b', 'llama-3.3-70b-versatile', 'gpt-oss-20b', 'qwen2.5-72b-instruct'], { task: 'id-chat', minScore: 40 });
  assert.ok(ranked.length >= 3, 'model lemah tersaring, bukan seluruh daftar');
  assert.match(ranked[0].model, /(llama-3\.3-70b|gpt-oss-20b|qwen2\.5-72b)/);
  assert.ok(!ranked.some((r) => /allam|tinyllama/.test(r.model)));
  // terurut skor desc & deterministik
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
  const again = rankModels(['qwen2.5-72b-instruct', 'llama-3.3-70b-versatile', 'gpt-oss-20b'], { task: 'id-chat', minScore: 40 });
  assert.deepEqual(again.map((r) => r.model), ranked.map((r) => r.model), 'urutan harus stabil walau urutan input berubah');
});

test('ranking tidak bergantung urutan daftar live provider', () => {
  const a = ['mock/allam-2-7b', 'mock/qwen2.5-72b-instruct', 'mock/gpt-oss-120b'];
  const b = [...a].reverse();
  assert.equal(rankModels(a, { task: 'chat' })[0].model, rankModels(b, { task: 'chat' })[0].model);
});

test('model non-chat (embedding/audio/rerank) tidak pernah dipakai untuk chat', () => {
  for (const m of ['text-embedding-3-small', 'bge-reranker-v2', 'whisper-large-v3', 'llama-guard-3-8b', 'sensevoice-small']) {
    const r = scoreModel(m, { task: 'chat' });
    assert.ok(r.nonChat || r.blocked, `${m} harus disingkirkan dari jalur chat`);
  }
  assert.deepEqual(rankModels(['text-embedding-3-small', 'gpt-oss-120b'], { task: 'chat' }).map((x) => x.model), ['gpt-oss-120b']);
});

test('task terdeteksi dari prompt (ID + EN)', () => {
  const t = (content, extra = {}) => detectTask({ messages: [{ role: 'user', content }], ...extra }).task;
  assert.equal(t('perbaiki kode ini:\n```python\ndef f():\n  pass\n```'), 'coding');
  assert.equal(t('terjemahkan kalimat ini ke bahasa inggris'), 'translation');
  assert.equal(t('jelaskan langkah demi langkah mengapa resultannya 42'), 'reasoning');
  assert.equal(t('rangkum paragraf berikut jadi tiga poin'), 'summarize');
  assert.equal(t('apa kabar hari ini, ceritakan sedikit tentang harimu'), 'id-chat');
  assert.equal(t('hai'), 'chat');
  assert.equal(t('keluarkan data', { response_format: { type: 'json_object' } }), 'structured');
  assert.equal(t('pakai alat ini', { tools: [{ type: 'function', function: { name: 'x' } }] }), 'coding');
});

test('prompt Indonesia tidak jatuh ke model yang condong bahasa Arab', () => {
  const id = scoreModel('llama-3.1-70b-instruct', { task: 'id-chat' });
  const ar = scoreModel('allam-2-7b', { task: 'id-chat' });
  assert.ok(id.score > ar.score, `${id.score} harus > ${ar.score}`);
  assert.ok(id.reasons.some((r) => r.includes('multilingual-id')));
});

test('blocklist bisa ditambah & regex didukung', () => {
  const r = scoreModel('mistral-nemo-latest', { task: 'chat', blocklist: ['/nemo/'] });
  assert.ok(r.blocked);
  assert.ok(scoreModel('mistral-nemo-latest', { task: 'chat' }).score > 0);
});

test('model kecil tetap dapat skor rendah walau tidak di-block', () => {
  assert.ok(score('qwen2.5-1.5b') < score('qwen2.5-32b-instruct'));
  assert.ok(score('llama-3.1-405b') > score('llama-3.1-8b-instruct'));
});

test('model tidak dikenal tidak dapat skor penuh (butuh bukti, bukan asumsi)', () => {
  const r = scoreModel('perusahaan-xyz/besar-7b', { task: 'chat' });
  assert.ok(r.score < 70, String(r.score));
  assert.ok(r.reasons.includes('unknown-family:baseline'));
});

test('allowLowQuality=false → tidak ada kandidat bila semua di bawah ambang', () => {
  assert.deepEqual(rankModels(['acme-mini-2b'], { task: 'chat', minScore: 80, allowLowQuality: false }), []);
  const soft = rankModels(['acme-mini-2b'], { task: 'chat', minScore: 80, allowLowQuality: true });
  assert.equal(soft.length, 1, 'tanpa ambang ketat: tetap jawab, tapi ditandai lowConfidence');
  assert.equal(soft[0].lowConfidence, true);
});

test('path embeddings justru memilih model embedding', () => {
  const r = rankModels(['gpt-oss-120b', 'text-embedding-3-small', 'bge-m3'], { path: 'embeddings' });
  assert.ok(r.length === 2 && r.every((x) => /embed|bge/.test(x.model)), JSON.stringify(r));
});
