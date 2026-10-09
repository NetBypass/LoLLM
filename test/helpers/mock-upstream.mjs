// LoLLM — mock upstream (OpenAI-compatible) untuk test gateway tanpa internet.
// Setiap mock punya `state` yang bisa diubah-ubah untuk mensimulasikan: jawaban normal,
// 200-content-kosong, stream kosong, 5xx, 429, delay, dsb.

import http from 'node:http';

export const GOOD_MODELS = [
  'mock/llama-3.3-70b-versatile',
  'mock/gpt-oss-120b',
  'mock/qwen2.5-72b-instruct',
];
export const WEAK_MODELS = ['mock/allam-2-7b', 'mock/tinyllama-1.1b', 'mock/SmolLM2-135M-Instruct'];
export const NON_CHAT_MODELS = ['mock/text-embedding-3-small', 'mock/rerank-qa-v1', 'mock/whisper-large'];

export function defaultModels() {
  return [...NON_CHAT_MODELS, ...WEAK_MODELS, ...GOOD_MODELS]; // urut SENGAJA buruk di depan
}

export async function createMockUpstream(name = 'mock', { models = defaultModels() } = {}) {
  const state = {
    mode: 'ok', // ok | empty | empty-stream | fail500 | rate429 | timeout | partial
    requests: [],
    modelCalls: 0,
    models,
    delayMs: 0,
    reply: null, // fungsi (body) => string | object
    streamChunks: 4,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        state.modelCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: state.models.map((id) => ({ id, object: 'model', owned_by: name })) }));
      }
      if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* biarkan */ }
        state.requests.push({ at: Date.now(), body, headers: req.headers });
        if (state.delayMs) await sleep(state.delayMs);

        if (state.mode === 'fail500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: `${name}: boom` } }));
        }
        if (state.mode === 'rate429') {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          return res.end(JSON.stringify({ error: { message: `${name}: rate limited` } }));
        }
        if (state.mode === 'rejectParam') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: `${name}: unsupported parameter`, param: 'max_tokens' } }));
        }
        if (state.mode === 'badjson') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end('bukan json sama sekali');
        }
        if (state.mode === 'empty') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'cmpl-empty', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: '   ' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
          }));
        }
        if (state.mode === 'no-choices') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'cmpl-x', object: 'chat.completion', model: body.model, choices: [] }));
        }
        if (state.mode === 'upstream-error-body') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: `${name}: upstream menolak` } }));
        }
        if (state.mode === 'reasoning-only') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'cmpl-r', object: 'chat.completion', model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning_content: 'hmm…' }, finish_reason: 'stop' }],
          }));
        }
        if (state.mode === 'sse-wrong-ctype') {
          // SSE betulan tapi content-type salah label (terjadi di beberapa provider gratis)
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write(`data: ${JSON.stringify({ id: 'w1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
          for (const piece of ['ja', 'wan', ' terusan']) {
            res.write(`data: ${JSON.stringify({ id: 'w1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id: 'w1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        if (state.mode === 'json-only') {
          // Provider yang mengabaikan stream:true dan membalas JSON biasa
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'cmpl-json-only', object: 'chat.completion', model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'jawaban lewat json' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }));
        }
        if (state.mode === 'json-only-empty') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }));
        }
        if (state.mode === 'empty-stream' || state.mode === 'ok-stream' || state.mode === 'partial-stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
          if (state.mode !== 'empty-stream') {
            const text = state.mode === 'partial-stream' ? 'separuh' : 'halo dunia';
            for (const piece of text.match(/.{1,3}/g) || []) {
              res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
            }
          }
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        if (state.mode === 'timeout') { await sleep(30_000); return res.end(); }

        // default: mode ok — gema parameter supaya test bisa cek penerusan
        const content = state.reply ? state.reply(body) : JSON.stringify({
          provider: name,
          model: body.model,
          temperature: body.temperature,
          top_p: body.top_p,
          max_tokens: body.max_tokens,
          stop: body.stop,
          n: body.n,
          seed: body.seed,
          response_format: body.response_format,
          user: body.user,
          messages: body.messages,
          stream: body.stream,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'cmpl-' + state.requests.length, object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }));
      }
      if (req.method === 'POST' && url.pathname.endsWith('/embeddings')) {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* biarkan */ }
        state.requests.push({ at: Date.now(), body, headers: req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }], model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `${name}: ${req.method} ${url.pathname} tidak ada` } }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    name, state, server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits: () => state.requests.length,
    last: () => state.requests.at(-1)?.body,
    reset: () => { state.requests.length = 0; state.mode = 'ok'; state.delayMs = 0; state.reply = null; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Baca seluruh SSE dan kembalikan { text, raw, events, firstByteMs }. */
export function parseSse(res) {
  return res.text().then((raw) => {
    let text = '';
    let reasoning = '';
    const events = [];
    let sawDone = false;
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const payload = l.slice(5).trim();
      if (payload === '[DONE]') { sawDone = true; continue; }
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      events.push(j);
      const d = j.choices?.[0]?.delta;
      if (d?.content) text += d.content;
      if (d?.reasoning_content) reasoning += d.reasoning_content;
    }
    return { text, reasoning, events, raw, sawDone };
  });
}
