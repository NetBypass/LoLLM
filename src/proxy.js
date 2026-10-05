// LoLLM — Proxy: satu percobaan upstream dengan timeout presisi & streaming pass-through.
// Style 'anthropic' ditranslasi otomatis OpenAI ⇄ Anthropic Messages API.

import { Readable } from 'node:stream';

export class UpstreamError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = opts.kind || 'network'; // auth|rate|timeout|server|network|model|client|aborted
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

function classifyStatus(status, headers) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 404) return 'model';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'client'; // 400 dsb — kemungkinan salah body/param
}

// ---------- Translasi Anthropic ----------

function openaiToAnthropic(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const system = msgs.filter((m) => m.role === 'system').map((m) =>
    typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.text).map((p) => p.text).join('\n')
  ).join('\n');
  const out = {
    model: body.model,
    max_tokens: body.max_tokens ?? 1024,
    messages: msgs
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.text).map((p) => p.text).join('\n'),
      })),
  };
  if (system) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length) out.stop_sequences = body.stop;
  else if (typeof body.stop === 'string') out.stop_sequences = [body.stop];
  if (body.stream) out.stream = true;
  return out;
}

function anthropicToOpenAI(a, model) {
  const text = (a.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return {
    id: a.id || 'chatcmpl-lollm',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: a.model || model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: a.stop_reason === 'max_tokens' ? 'length' : 'stop',
    }],
    usage: {
      prompt_tokens: a.usage?.input_tokens ?? 0,
      completion_tokens: a.usage?.output_tokens ?? 0,
      total_tokens: (a.usage?.input_tokens ?? 0) + (a.usage?.output_tokens ?? 0),
    },
  };
}

// SSE Anthropic → SSE OpenAI chunks
async function pipeAnthropicStream(upstreamBody, clientRes, model, idleMs, firstByteMs, onUsage, ac) {
  const dec = new TextDecoder();
  let buf = '';
  let id = 'chatcmpl-lollm';
  let created = Math.floor(Date.now() / 1000);
  let finishReason = null;
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let seenChunk = false;
  let done = false;

  const emit = (delta, extra = {}) => {
    clientRes.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: extra.finish ?? null }],
      ...(extra.usage ? { usage } : {}),
    })}\n\n`);
  };

  const handleEvent = (ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'message_start') {
      id = ev.message?.id || id;
      usage.prompt_tokens = ev.message?.usage?.input_tokens ?? 0;
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      emit({ role: 'assistant', content: '' });
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      emit({ content: ev.delta.text });
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
      if (ev.usage?.output_tokens != null) {
        usage.completion_tokens = ev.usage.output_tokens;
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      }
    } else if (ev.type === 'message_end') {
      emit({}, { finish: finishReason || 'stop', usage: true });
      clientRes.write('data: [DONE]\n\n');
      done = true;
      onUsage?.report?.(usage);
    } else if (ev.type === 'error') {
      throw new UpstreamError(`Anthropic stream error: ${ev.error?.message || 'unknown'}`, { kind: 'server' });
    }
  };

  let idleTimer = setTimeout(() => ac.abort(new TimeoutReason(seenChunk ? 'idle' : 'first-byte')), firstByteMs);
  const bump = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(new TimeoutReason(seenChunk ? 'idle' : 'first-byte')), seenChunk ? idleMs : firstByteMs);
  };

  try {
    for await (const chunk of upstreamBody) {
      seenChunk = true;
      bump();
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try { handleEvent(JSON.parse(payload)); } catch { /* lewati baris rusak */ }
        }
      }
    }
    if (!done) {
      emit({}, { finish: finishReason || 'stop', usage: true });
      clientRes.write('data: [DONE]\n\n');
      onUsage?.(usage);
    }
  } finally {
    clearTimeout(idleTimer);
    clientRes.end();
  }
}

// ---------- Attempt utama ----------

/**
 * Jalankan SATU percobaan upstream.
 * ctx: { pconf, meta, key, path, body, stream, settings, clientSignal, clientRes, onUsage }
 * path: 'chat/completions' | 'completions' | 'embeddings'
 *
 * Return:
 *   { ok:true, streamed:true }                     — sudah ditulis ke clientRes (SSE)
 *   { ok:true, status, contentType, buffer }       — non-stream, router yang menulis
 * throw UpstreamError kalau gagal.
 */
export async function runAttempt(ctx) {
  const { meta, key, path, body, stream, settings, clientSignal, clientRes, onUsage } = ctx;
  const t = settings.timeouts;
  const style = meta.style || 'openai';
  const base = (ctx.baseUrl || meta.baseUrl).replace(/\/+$/, '');
  const keyless = meta.keyless === true;

  if (style === 'anthropic' && path !== 'chat/completions') {
    throw new UpstreamError(`Anthropic style hanya mendukung chat/completions`, { kind: 'client' });
  }

  let url, payload = body, headers = { 'Content-Type': 'application/json' };
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
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    clearTimeout(connectTimer);
    connectTimer = null;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new UpstreamError(
        `HTTP ${res.status} dari ${meta.name}: ${text.slice(0, 300)}`,
        {
          kind: classifyStatus(res.status, res.headers),
          status: res.status,
          retryAfterSec: parseRetryAfter(res.headers),
          body: text.slice(0, 500),
        }
      );
    }

    if (!stream) {
      const totalTimer = setTimeout(() => ac.abort(new TimeoutReason('total')), t.totalMs);
      try {
        let buffer = Buffer.from(await res.arrayBuffer());
        if (style === 'anthropic') {
          // Translasi balik Anthropic → OpenAI
          const j = JSON.parse(buffer.toString('utf8'));
          buffer = Buffer.from(JSON.stringify(anthropicToOpenAI(j, body.model)));
        }
        return { ok: true, status: res.status, contentType: 'application/json', buffer };
      } finally {
        clearTimeout(totalTimer);
      }
    }

    // Streaming
    clientRes.writeHead(res.status, {
      'Content-Type': res.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clientRes.socket?.setNoDelay(true);

    if (style === 'anthropic') {
      await pipeAnthropicStream(res.body, clientRes, body.model, t.streamIdleMs, t.firstByteMs, onUsage, ac);
      return { ok: true, streamed: true };
    }

    // OpenAI-compatible: pass-through mentah, zero buffering.
    const nodeStream = Readable.fromWeb(res.body);
    let seenChunk = false;
    let idleTimer = setTimeout(() => nodeStream.destroy(new TimeoutReason(seenChunk ? 'idle' : 'first-byte')), t.firstByteMs);
    nodeStream.on('data', (c) => {
      seenChunk = true;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => nodeStream.destroy(new TimeoutReason('idle')), t.streamIdleMs);
      onUsage?.scan?.(c);
      clientRes.write(c);
    });
    const finished = new Promise((resolve, reject) => {
      nodeStream.on('end', () => { clearTimeout(idleTimer); clientRes.end(); resolve(); });
      nodeStream.on('error', (err) => { clearTimeout(idleTimer); clientRes.end(); reject(err); });
      clientRes.on('close', () => { clearTimeout(idleTimer); nodeStream.destroy(); resolve(); });
    });
    await finished;
    return { ok: true, streamed: true };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err?.which === 'connect' || err?.which === 'total' || err?.which === 'first-byte' || err?.which === 'idle') {
      throw new UpstreamError(`Timeout ${err.which} dari ${meta.name}`, { kind: 'timeout' });
    }
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

// Tes sebuah key: GET /models (murah, tanpa token).
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
      return { ok: false, status: res.status, ms, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, kind: classifyStatus(res.status, res.headers) };
    }
    let count = null;
    try {
      const j = await res.json();
      count = Array.isArray(j?.data) ? j.data.length : null;
    } catch { /* biarkan null */ }
    return { ok: true, status: 200, ms, modelsCount: count };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(err?.message || err), kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
