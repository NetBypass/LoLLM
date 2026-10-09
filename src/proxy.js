// LoLLM — Proxy: satu percobaan upstream dengan timeout presisi & streaming pass-through.
// Style 'anthropic' ditranslasi otomatis OpenAI ⇄ Anthropic Messages API.
//
// PENTING: header response ke client baru ditulis SETELAH ada bukti jawaban nyata
// (delta konten / tool_calls). Sebelum itu chunk hanya dibuffer di memori. Kalau upstream
// menutup stream tanpa isi, attempt dianggap gagal (kind: 'empty') dan router mencoba
// kandidat berikutnya — jadi client tidak pernah lagi dapat HTTP 200 dengan content kosong.

import { Readable } from 'node:stream';
import { contentLength } from './params.js';

export class UpstreamError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = opts.kind || 'network'; // auth|rate|timeout|server|network|model|client|aborted|empty
    this.status = opts.status || 0;
    this.retryAfterSec = opts.retryAfterSec || null;
    this.body = opts.body || '';
  }
}

class TimeoutReason extends Error {
  constructor(which) {
    super(`timeout: ${which}`);
    this.which = which;
  }
}

function parseRetryAfter(headers) {
  const v = headers.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(v);
  if (!Number.isNaN(d)) return Math.ceil((d - Date.now()) / 1000);
  return null;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 404) return 'model';
  if (status === 408 || status === 503 || status === 529) return 'timeout';
  if (status >= 500) return 'server';
  return 'client'; // 400 dsb — kemungkinan salah body/param
}

// ---------- Penulis tertunda (deferred writer) ----------
/**
 * Buffer chunk sampai yakin upstream benar-benar menjawab. settle() menulis header +
 * seluruh buffer. Sebelum settle, router masih bebas mengganti status (400/502/503)
 * atau mencoba kandidat berikutnya.
 */
export function createDeferredWriter(clientRes, headers = {}, { maxBufferBytes = 1024 * 1024, onForceSettle } = {}) {
  const buf = [];
  let bytes = 0;
  let settled = false;
  let prefix = null;
  return {
    get settled() { return settled; },
    get buffered() { return bytes; },
    setPrefix(s) { prefix = s; },
    write(chunk) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (settled) return clientRes.write(b);
      buf.push(b);
      bytes += b.length;
      // Katup aman: aliran reasoning panjang tidak boleh menahan memori tanpa batas —
      // lewati 1MB kami commit dan lanjut stream-through (jawabannya tetap sampai ke user).
      if (bytes > maxBufferBytes) { this.settle(); onForceSettle?.(); }
      return true;
    },
    settle() {
      if (settled) return false;
      settled = true;
      if (!clientRes.headersSent) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...headers,
        });
      }
      clientRes.socket?.setNoDelay(true);
      if (prefix) clientRes.write(prefix);
      for (const b of buf) clientRes.write(b);
      buf.length = 0;
      bytes = 0;
      return true;
    },
    /** Isi yang masih tertahan (belum dikirim ke klien) — untuk pemeriksaan akhir. */
    bufferedText() { return settled ? '' : Buffer.concat(buf).toString('utf8'); },
    /** Buang semua yang ter-buffer; client belum menerima apa pun. */
    abort() { buf.length = 0; bytes = 0; return !settled; },
    end() { if (settled) clientRes.end(); },
  };
}

// ---------- Probe SSE ----------
/**
 * Membaca aliran SSE hanya untuk menilai status (ada isi? error? usage?) — byte yang
 * diteruskan ke client tidak pernah diubah. onEvent dipakai jalur Anthropic yang perlu
 * menerjemahkan event, bukan hanya mengintip.
 */
export function createSseProbe(style = 'openai', { onUsage, onEvent } = {}) {
  const dec = new TextDecoder();
  let tail = '';
  const state = { content: false, toolCalls: false, reasoning: false, error: null, done: false, chars: 0, usage: null };
  const pending = { input: 0 };

  const openaiLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { state.done = true; return; }
    let j;
    try { j = JSON.parse(payload); } catch { return; }
    if (j?.error) { state.error = j.error.message || j.error.type || 'upstream error'; return; }
    if (j.usage) {
      const p = +j.usage.prompt_tokens ?? +j.usage.input_tokens ?? 0;
      const c = +j.usage.completion_tokens ?? +j.usage.output_tokens ?? 0;
      state.usage = { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
      onUsage?.report?.(state.usage);
    }
    const ch = Array.isArray(j.choices) ? j.choices[0] : null;
    const delta = ch?.delta || ch?.message;
    if (delta) {
      const len = contentLength(delta.content);
      if (len > 0) { state.content = true; state.chars += len; }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) state.toolCalls = true;
      if (delta.function_call && Object.keys(delta.function_call).length) state.toolCalls = true;
      const rc = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_summary_text;
      if (typeof rc === 'string' && rc.trim()) state.reasoning = true;
    }
    if (typeof ch?.text === 'string' && ch.text.length) { state.content = true; state.chars += ch.text.length; }
  };

  const anthropicEvent = (j) => {
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta.text) {
      state.content = true; state.chars += j.delta.text.length;
    } else if (j.type === 'content_block_delta' && j.delta?.type === 'thinking_delta') {
      state.reasoning = true;
    } else if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
      state.toolCalls = true;
    } else if (j.type === 'message_start') {
      pending.input = j.message?.usage?.input_tokens ?? 0;
      state.usage = { prompt_tokens: pending.input, completion_tokens: 0, total_tokens: pending.input };
    } else if (j.type === 'message_delta') {
      const c = j.usage?.output_tokens;
      if (c != null) state.usage = { prompt_tokens: pending.input, completion_tokens: c, total_tokens: pending.input + c };
    } else if (j.type === 'message_stop') {
      state.done = true;
    } else if (j.type === 'error') {
      state.error = j.error?.message || 'anthropic stream error';
    }
    onEvent?.(j);
  };

  const SEP = style === 'anthropic' ? '\n\n' : '\n';
  const handleBlock = (block) => {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (style === 'anthropic') {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p) continue;
        try { anthropicEvent(JSON.parse(p)); } catch { /* baris rusak */ }
      } else {
        openaiLine(line);
      }
    }
  };

  let chunkCount = 0;
  return {
    state,
    get meaningful() { return state.content || state.toolCalls; },
    feed(chunk) {
      chunkCount++;
      tail += dec.decode(chunk, { stream: true });
      let idx;
      let guard = 0;
      while ((idx = tail.indexOf(SEP)) >= 0 && guard++ < 5000) {
        const block = tail.slice(0, idx);
        tail = tail.slice(idx + SEP.length);
        if (block) handleBlock(block);
      }
      if (tail.length > 256_000) tail = tail.slice(-4000); // jaga memori pada aliran aneh
    },
    end() {
      if (tail) { handleBlock(tail); tail = ''; }
    },
    chunks: () => chunkCount,
  };
}

/** Ubah satu JSON chat.completion jadi aliran SSE (untuk provider yang menolak stream). */
function emitJsonAsSse(json, clientRes, ctx, meta) {
  if (json?.error) throw new UpstreamError(`Upstream ${meta.name} menolak: ${json.error.message || 'unknown'}`, { kind: 'server' });
  const model = json.model || ctx.body?.model || '';
  const headers = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...(ctx.streamHeaders || {}) };
  const write = (obj) => clientRes.write(`data: ${JSON.stringify(obj)}\n\n`);
  const msg = json.choices?.[0]?.message || {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!content && !Array.isArray(msg.tool_calls) && ctx.allowEmpty !== true) {
    throw new UpstreamError(`Upstream ${meta.name} membalas JSON tanpa isi (content kosong)`, { kind: 'empty' });
  }
  if (!clientRes.headersSent) clientRes.writeHead(200, headers);
  if (ctx.streamPrefix) clientRes.write(ctx.streamPrefix);
  const base = { id: json.id || 'chatcmpl-lollm', object: 'chat.completion.chunk', created: json.created || Math.floor(Date.now() / 1000), model };
  write({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  if (content) write({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: json.choices?.[0]?.finish_reason || 'stop' }] });
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    write({ ...base, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls.map((tc, i) => ({ index: i, id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments } })) }, finish_reason: 'tool_calls' }] });
  }
  write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: json.choices?.[0]?.finish_reason || 'stop' }], ...(json.usage ? { usage: json.usage } : {}) });
  clientRes.write('data: [DONE]\n\n');
  clientRes.end();
  return { ok: true, streamed: true, empty: !content, chars: content.length, usage: json.usage || null, fromJson: true };
}

// ---------- Translasi Anthropic ----------

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n');
  return '';
}

function openaiToAnthropic(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const system = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).filter(Boolean).join('\n');
  const out = {
    model: body.model,
    max_tokens: Number.isFinite(Number(body.max_tokens)) && Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 4096,
    messages: msgs
      .filter((m) => m.role !== 'system' && m.role !== 'developer')
      .map((m) => ({ role: m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user', content: textOf(m.content) }))
      .filter((m) => m.content.length > 0),
  };
  if (system) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length) out.stop_sequences = body.stop;
  else if (typeof body.stop === 'string' && body.stop) out.stop_sequences = [body.stop];
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools.map((tool) => ({
      name: tool.function?.name, description: tool.function?.description, input_schema: tool.function?.parameters,
    })).filter((tool) => tool.name && tool.input_schema);
    if (tools.length) out.tools = tools;
  }
  if (body.stream) out.stream = true;
  return out;
}

function anthropicToOpenAI(a, model) {
  const text = (a.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const toolCalls = (a.content || []).filter((c) => c.type === 'tool_use').map((c, i) => ({
    id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
  }));
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const inTok = a.usage?.input_tokens ?? 0;
  const outTok = a.usage?.output_tokens ?? 0;
  return {
    id: a.id || 'chatcmpl-lollm',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: a.model || model,
    choices: [{
      index: 0,
      message,
      finish_reason: a.stop_reason === 'max_tokens' ? 'length' : a.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// ---------- Attempt utama ----------

/**
 * Jalankan SATU percobaan upstream.
 * ctx: { pconf, meta, key, path, body, stream, settings, clientSignal, clientRes, onUsage,
 *        streamHeaders, allowEmpty }
 *
 * Return:
 *   { ok:true, streamed:true, empty, chars, usage }   — SSE (deferred writer)
 *   { ok:true, status, contentType, buffer }            — non-stream; router yang menulis
 * throw UpstreamError kalau gagal (termasuk kind 'empty').
 */
export async function runAttempt(ctx) {
  const { meta, key, path, body, stream, settings, clientSignal, clientRes, onUsage } = ctx;
  const t = settings.timeouts;
  const style = meta.style || 'openai';
  const base = (ctx.baseUrl || meta.baseUrl).replace(/\/+$/, '');
  const keyless = meta.keyless === true;

  if (style === 'anthropic' && path !== 'chat/completions') {
    throw new UpstreamError('Anthropic style hanya mendukung chat/completions', { kind: 'client' });
  }

  let url, payload = body;
  const headers = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' };
  if (style === 'anthropic') {
    url = `${base}/v1/messages`;
    payload = openaiToAnthropic(body);
    headers['x-api-key'] = key?.value || '';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = `${base}/${path}`;
    if (!keyless && key?.value) headers['Authorization'] = `Bearer ${key.value}`;
  }
  for (const [h, v] of Object.entries(meta.extraHeaders || {})) headers[h] = v;

  const ac = new AbortController();
  const onClientAbort = () => ac.abort(new Error('client-aborted'));
  clientSignal?.addEventListener('abort', onClientAbort, { once: true });

  let connectTimer = setTimeout(() => ac.abort(new TimeoutReason('connect')), t.connectMs);

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
    clearTimeout(connectTimer);
    connectTimer = null;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new UpstreamError(`HTTP ${res.status} dari ${meta.name}: ${text.slice(0, 300)}`, {
        kind: classifyStatus(res.status),
        status: res.status,
        retryAfterSec: parseRetryAfter(res.headers),
        body: text.slice(0, 500),
      });
    }

    // ---- non-stream ----
    if (!stream) {
      const totalTimer = setTimeout(() => ac.abort(new TimeoutReason('total')), t.totalMs);
      try {
        let buffer = Buffer.from(await res.arrayBuffer());
        if (style === 'anthropic') buffer = Buffer.from(JSON.stringify(anthropicToOpenAI(JSON.parse(buffer.toString('utf8')), body.model)));
        return { ok: true, status: res.status, contentType: 'application/json', buffer };
      } finally {
        clearTimeout(totalTimer);
      }
    }

    // ---- streaming: header ditunda sampai ada bukti isi ----
    const ctype = String(res.headers.get('content-type') || '');
    if (!ctype.includes('event-stream') && (ctype.includes('json') || !ctype)) {
      // Provider yang mengabaikan stream:true dan membalas satu body JSON — tetap kami
      // sajikan sebagai SSE, bukan ditolak sebagai "jawaban kosong".
      const totalTimer = setTimeout(() => ac.abort(new TimeoutReason('total')), t.totalMs);
      try {
        const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
        const trimmed = text.trimStart();
        if (trimmed.startsWith('data:') || trimmed.startsWith(':')) {
          // SSE betulan tapi content-type-nya salah label → teruskan apa adanya.
          const probe = createSseProbe(style, { onUsage });
          probe.feed(Buffer.from(text));
          probe.end();
          if (!probe.meaningful && ctx.allowEmpty !== true) {
            throw new UpstreamError(`Stream dari ${meta.name} berakhir tanpa isi (0 token konten)`, { kind: 'empty' });
          }
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...(ctx.streamHeaders || {}),
          });
          if (ctx.streamPrefix) clientRes.write(ctx.streamPrefix);
          clientRes.write(text);
          if (!/\[DONE\]/.test(text)) clientRes.write('data: [DONE]\n\n');
          clientRes.end();
          return { ok: true, streamed: true, empty: !probe.meaningful, chars: probe.state.chars, usage: probe.state.usage };
        }
        let json;
        try { json = JSON.parse(text); } catch {
          throw new UpstreamError(`Balasan ${meta.name} bukan JSON maupun SSE (${text.length} byte)`, { kind: 'server' });
        }
        if (style === 'anthropic') json = anthropicToOpenAI(json, body.model);
        return emitJsonAsSse(json, clientRes, ctx, meta);
      } finally {
        clearTimeout(totalTimer);
      }
    }
    const writer = createDeferredWriter(clientRes, ctx.streamHeaders || {});
    if (ctx.streamPrefix) writer.setPrefix(ctx.streamPrefix);
    const allowEmpty = ctx.allowEmpty === true;
    const nodeStream = Readable.fromWeb(res.body);
    let idleTimer = setTimeout(() => nodeStream.destroy(new TimeoutReason('first-byte')), t.firstByteMs);
    const probe = createSseProbe(style, {
      onUsage,
      onEvent: style === 'anthropic' ? handleAnthropicEvent : undefined,
    });
    let streamErr = null;

    const emit = (delta, extra = {}) => {
      writer.write(`data: ${JSON.stringify({
        id: emit.id, object: 'chat.completion.chunk', created: emit.created, model: body.model,
        choices: [{ index: 0, delta, finish_reason: extra.finish ?? null }],
        ...(extra.usage ? { usage: emit.usage } : {}),
      })}\n\n`);
    };
    emit.id = 'chatcmpl-lollm';
    emit.created = Math.floor(Date.now() / 1000);
    emit.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let finishReason = null;
    let anthropicDone = false;

    function handleAnthropicEvent(ev) {
      if (ev.type === 'message_start') {
        emit.id = ev.message?.id || emit.id;
        emit.usage.prompt_tokens = ev.message?.usage?.input_tokens ?? 0;
        emit.usage.total_tokens = emit.usage.prompt_tokens;
        emit({ role: 'assistant', content: '' });
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        emit({ content: ev.delta.text });
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
        emit({ reasoning_content: ev.delta.thinking });
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) {
          finishReason = ev.delta.stop_reason === 'max_tokens' ? 'length' : ev.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';
        }
        if (ev.usage?.output_tokens != null) {
          emit.usage.completion_tokens = ev.usage.output_tokens;
          emit.usage.total_tokens = emit.usage.prompt_tokens + emit.usage.output_tokens;
        }
      } else if (ev.type === 'message_stop') {
        emit({}, { finish: finishReason || 'stop', usage: true });
        writer.write('data: [DONE]\n\n');
        anthropicDone = true;
      }
    }

    nodeStream.on('data', (c) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => nodeStream.destroy(new TimeoutReason('idle')), t.streamIdleMs);
      probe.feed(c);
      if (style !== 'anthropic') { onUsage?.scan?.(c); writer.write(c); }
      // Commit HTTP 200 hanya setelah ada isi nyata (atau untuk Anthropic, setelah event awal).
      if (style === 'anthropic' ? probe.state.content || anthropicDone : probe.meaningful) writer.settle();
    });

    const finished = new Promise((resolve) => {
      nodeStream.on('end', () => { clearTimeout(idleTimer); probe.end(); resolve(); });
      nodeStream.on('error', (err) => { clearTimeout(idleTimer); streamErr = err; resolve(); });
      clientRes.on('close', () => {
        clearTimeout(idleTimer);
        if (!nodeStream.destroyed) nodeStream.destroy();
        if (clientSignal?.aborted && String(clientSignal.reason?.message || '').includes('client-aborted')) streamErr = streamErr || new Error('client-aborted');
        resolve();
      });
    });
    await finished;

    if (streamErr) {
      const aborted = clientSignal?.aborted || streamErr.message === 'client-aborted';
      if (aborted && !writer.settled) {
        writer.abort();
        throw new UpstreamError('Client memutus koneksi', { kind: 'aborted' });
      }
      if (!writer.settled) {
        writer.abort();
        if (streamErr?.which) throw new UpstreamError(`Timeout ${streamErr.which} dari ${meta.name}`, { kind: 'timeout' });
        throw new UpstreamError(`Stream ${meta.name} putus: ${String(streamErr.message || streamErr)}`, { kind: 'network' });
      }
      writer.end();
      if (aborted) throw new UpstreamError('Client memutus koneksi', { kind: 'aborted' });
      if (streamErr?.which) throw new UpstreamError(`Timeout ${streamErr.which} dari ${meta.name} saat streaming`, { kind: 'timeout' });
      throw new UpstreamError(`Stream ${meta.name} putus di tengah jawab`, { kind: 'network' });
    }
    if (probe.state.error && !writer.settled) {
      writer.abort();
      throw new UpstreamError(`Stream error dari ${meta.name}: ${probe.state.error}`, { kind: 'server' });
    }

    if (style === 'anthropic' && !anthropicDone) {
      emit({}, { finish: finishReason || 'stop', usage: true });
      writer.write('data: [DONE]\n\n');
    }

    if (!probe.meaningful && !allowEmpty) {
      const held = writer.bufferedText();
      if (held.trimStart().startsWith('{')) {
        try {
          const j = JSON.parse(held);
          if (j && (Array.isArray(j.choices) || j.content)) {
            writer.abort();
            return emitJsonAsSse(style === 'anthropic' ? anthropicToOpenAI(j, body.model) : j, clientRes, ctx, meta);
          }
        } catch { /* bukan JSON → anggap benar-benar kosong */ }
      }
      writer.abort();
      throw new UpstreamError(
        probe.state.reasoning
          ? `${meta.name} hanya menghasilkan reasoning tanpa jawaban final (content kosong)`
          : `Stream dari ${meta.name} berakhir tanpa isi (0 token konten)`,
        { kind: 'empty', status: 0 }
      );
    }
    writer.settle();
    writer.end();
    return { ok: true, streamed: true, empty: !probe.meaningful, chars: probe.state.chars, usage: probe.state.usage };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err?.which) throw new UpstreamError(`Timeout ${err.which} dari ${meta.name}`, { kind: 'timeout' });
    if (err?.message === 'client-aborted' || clientSignal?.aborted) {
      throw new UpstreamError('Client memutus koneksi', { kind: 'aborted' });
    }
    const msg = String(err?.cause?.message || err?.message || err);
    throw new UpstreamError(`Network error ke ${meta.name}: ${msg}`, { kind: 'network' });
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    clientSignal?.removeEventListener('abort', onClientAbort);
  }
}

/** Tes sebuah key: GET /models (murah, tanpa token). */
export async function testKey(meta, key, timeoutMs = 12000) {
  const base = (meta.baseUrl || '').replace(/\/+$/, '');
  const url = meta.style === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
  const headers = {};
  if (meta.style === 'anthropic') {
    headers['x-api-key'] = key.value;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key.value) {
    headers['Authorization'] = `Bearer ${key.value}`;
  }
  for (const [h, v] of Object.entries(meta.extraHeaders || {})) headers[h] = v;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, ms, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, kind: classifyStatus(res.status) };
    }
    let count = null;
    try { const j = await res.json(); count = Array.isArray(j?.data) ? j.data.length : null; } catch { /* biarkan null */ }
    return { ok: true, status: 200, ms, modelsCount: count };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(err?.message || err), kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
