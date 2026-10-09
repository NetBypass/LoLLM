// LoLLM — Validasi request & normalisasi parameter upstream.
//
// Dua masalah yang dibereskan di sini:
//  1) Request cacat (mis. `messages: []`) dulu lolos dan menghasilkan jawaban ngawur →
//     sekarang ditolak 400 dengan pesan + `param` ala OpenAI.
//  2) `temperature` / `max_tokens` kadang "tidak berpengaruh" karena provider menolak
//     nilai di luar rentang atau karena nilai null/NaN ikut dikirim. Semua angka dibersihkan,
//     di-clamp ke rentang sah, dan SETIAP penyesuaian dicatat supaya bisa dilihat client
//     (header `x-lollm-params` / field `x_lollm.params`).

export const VALID_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function', 'model']);

/** Param yang kami kenal. Lainnya diteruskan apa adanya (forward-compatible). */
export const KNOWN_PARAMS = [
  'model', 'messages', 'prompt', 'suffix', 'best_of', 'echo', 'logit_bias', 'logprobs', 'top_logprobs',
  'max_tokens', 'max_completion_tokens', 'n', 'presence_penalty', 'frequency_penalty', 'logit_bias',
  'response_format', 'seed', 'stop', 'stream', 'stream_options', 'temperature', 'top_p', 'tools', 'tool_choice',
  'parallel_tool_calls', 'functions', 'function_call', 'user', 'audio', 'modalities', 'prediction',
  'reasoning', 'reasoning_effort', 'thinking', 'input', 'encoding_format', 'dimensions',
];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const isInt = (v) => Number.isFinite(v) && Number.isInteger(v);
const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

function partText(p) {
  if (typeof p === 'string') return p;
  if (!p || typeof p !== 'object') return '';
  if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text' || p.type === 'summary_text') return String(p.text || '');
  if (p.type === 'input_audio') return ' '; // dihitung sebagai konten
  if (p.type === 'image_url' || p.type === 'image') return ' ';
  return String(p.text || '');
}

export function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((n, p) => n + partText(p).length, 0);
  return 0;
}

/**
 * Validasi body untuk /v1/<path>. Melempar Error dengan .status/.param/.type bila tidak sah.
 */
export function validateRequest(path, body) {
  const bad = (message, param, extra = {}) => {
    const e = new Error(message);
    e.status = 400;
    e.type = 'invalid_request_error';
    e.param = param;
    Object.assign(e, extra);
    return e;
  };

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('Body harus berupa objek JSON', 'body');
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
    throw bad('Field "model" harus string tidak kosong', 'model');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw bad('Field "stream" harus boolean', 'stream');
  }

  if (path === 'chat/completions') {
    if (!Array.isArray(body.messages)) throw bad('Field "messages" harus array', 'messages');
    if (body.messages.length === 0) {
      throw bad('messages cannot be empty — kirim minimal satu pesan {role, content}', 'messages');
    }
    if (body.messages.length > 2000) throw bad('Maksimal 2000 pesan per request', 'messages');
    let hasAnyContent = false;
    body.messages.forEach((m, i) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad(`messages[${i}] harus objek`, `messages[${i}]`);
      if (!nonEmptyStr(m.role)) throw bad(`messages[${i}].role wajib ada`, `messages[${i}].role`);
      if (!VALID_ROLES.has(String(m.role).toLowerCase())) {
        throw bad(`messages[${i}].role "${m.role}" tidak dikenal (pakai: ${[...VALID_ROLES].join(', ')})`, `messages[${i}].role`);
      }
      const isAssistantToolCall = m.role === 'assistant' && (Array.isArray(m.tool_calls) || (Array.isArray(m.function_call) ? m.function_call : m.function_call));
      if (m.content === undefined && !isAssistantToolCall && m.role !== 'tool') {
        throw bad(`messages[${i}].content wajib ada (string atau array bagian)`, `messages[${i}].content`);
      }
      if (m.content !== undefined && m.content !== null && typeof m.content !== 'string' && !Array.isArray(m.content)) {
        throw bad(`messages[${i}].content harus string atau array`, `messages[${i}].content`);
      }
      if (m.role === 'tool' && !m.tool_call_id) throw bad(`messages[${i}] role "tool" butuh tool_call_id`, `messages[${i}].tool_call_id`);
      if (contentLength(m.content) > 0 && (m.role === 'user' || m.role === 'system' || m.role === 'developer')) hasAnyContent = true;
    });
    if (!hasAnyContent) {
      throw bad('Tidak ada pesan dengan isi — isi "content" minimal salah satu pesan', 'messages');
    }
    return;
  }

  if (path === 'completions') {
    const p = body.prompt;
    const okStr = nonEmptyStr(p);
    const okArr = Array.isArray(p) && p.length > 0 && p.every((x) => nonEmptyStr(x) || (Array.isArray(x) && x.length));
    if (!okStr && !okArr) throw bad('prompt cannot be empty — kirim "prompt" string/array tidak kosong', 'prompt');
    return;
  }

  if (path === 'embeddings') {
    const i = body.input;
    if (typeof i === 'string') { if (!i.trim()) throw bad('input cannot be empty', 'input'); return; }
    if (Array.isArray(i)) {
      if (!i.length) throw bad('input cannot be empty', 'input');
      if (!i.some((x) => (typeof x === 'string' ? x.trim() : x != null))) throw bad('input contains only empty items', 'input');
      return;
    }
    if (typeof i === 'number' || (Array.isArray(i) && i.every((x) => typeof x === 'number'))) return;
    throw bad('Field "input" harus string atau array', 'input');
  }
}

/**
 * Bersihkan + clamp parameter, catat penyesuaian.
 * @returns {{body:object, meta:{forwarded:string[], adjusted:array, ignored:array}}}
 */
export function normalizeParams(body, { path = 'chat/completions', style = 'openai', model = '', limits = {}, content = {} } = {}) {
  const adjusted = [];
  const ignored = [];
  const forwarded = [];
  const out = { ...body };

  const note = (name, from, to, why) => adjusted.push({ param: name, from, to, why });

  const num = (name, { min, max, int = false, dropIfInvalid = true, scale, why } = {}) => {
    if (!(name in out)) return;
    let v = out[name];
    if (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) {
      if (dropIfInvalid) { ignored.push({ param: name, why: 'null/NaN — tidak dikirim ke upstream' }); delete out[name]; }
      return;
    }
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
    if (typeof v !== 'number') { ignored.push({ param: name, why: `tipe harus number (dapat ${typeof v})` }); delete out[name]; return; }
    let nv = v * (scale || 1);
    if (int) nv = Math.round(nv);
    const lo = min ?? -Infinity;
    const hi = max ?? Infinity;
    if (nv < lo || nv > hi) { nv = clamp(nv, lo, hi); note(name, v, nv, why || `di-clamp ke rentang [${lo === -Infinity ? '-∞' : lo}, ${hi === Infinity ? '∞' : hi}]`); }
    if (int) nv = Math.trunc(nv);
    out[name] = nv;
    forwarded.push(name);
  };

  num('temperature', { min: 0, max: 2 });
  num('top_p', { min: 0.0001, max: 1 });
  num('presence_penalty', { min: -2, max: 2 });
  num('frequency_penalty', { min: -2, max: 2 });
  num('top_k', { min: 1, max: 400, int: true });
  num('min_p', { min: 0, max: 1 });
  num('repetition_penalty', { min: 0.5, max: 2 });
  num('seed', { int: true, min: -2147483648, max: 2147483647 });
  num('n', { int: true, min: 1, max: limits.maxN ?? 8, why: `gateway melayani maks ${limits.maxN ?? 8} completion/request` });

  // max_tokens / max_completion_tokens
  for (const key of ['max_completion_tokens', 'max_tokens']) {
    if (!(key in out)) continue;
    const v = out[key];
    if (v === null || (typeof v === 'number' && !Number.isFinite(v))) { ignored.push({ param: key, why: 'null/NaN' }); delete out[key]; continue; }
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n) || n <= 0) { ignored.push({ param: key, why: `harus bilangan > 0 (dapat ${JSON.stringify(v)})` }); delete out[key]; continue; }
    const cap = limits.maxTokensCap ?? 32000;
    if (n > cap) { out[key] = cap; note(key, n, cap, `dibatasi kapabilitas gateway (${cap})`); }
    else out[key] = n;
    forwarded.push(key);
  }

  // stop
  if ('stop' in out) {
    if (out.stop == null || out.stop === '') { delete out.stop; ignored.push({ param: 'stop', why: 'kosong' }); }
    else {
      const arr = (Array.isArray(out.stop) ? out.stop : [out.stop]).filter((s) => typeof s === 'string' && s.length).slice(0, 4);
      if (!arr.length) { delete out.stop; ignored.push({ param: 'stop', why: 'tidak ada nilai string valid' }); }
      else { if (arr.length !== 1 || arr[0] !== out.stop) note('stop', out.stop, arr, 'dinormalisasi ke array ≤ 4'); out.stop = arr; forwarded.push('stop'); }
    }
  }

  // response_format
  if (out.response_format != null && typeof out.response_format === 'object') {
    const t = out.response_format.type;
    if (!['text', 'json_object', 'json_schema'].includes(t)) { ignored.push({ param: 'response_format', why: `type "${t}" tidak dikenal` }); delete out.response_format; }
    else if (t === 'json_object' && !hasJsonHint(body)) {
      note('response_format', t, t, 'kata "JSON" ditambahkan ke system prompt (banyak model gratis butuh isyarat eksplisit)');
      out.__lollm_jsonHint = true;
    }
    forwarded.push('response_format');
  } else if (out.response_format != null) {
    ignored.push({ param: 'response_format', why: 'harus objek {type}' });
    delete out.response_format;
  }

  if ('stream_options' in out && out.stream_options != null && typeof out.stream_options !== 'object') delete out.stream_options;
  if (out.stream === false) delete out.stream; // jangan minta SSE ke upstream untuk request non-stream
  if (out.user != null) {
    if (typeof out.user !== 'string' || !out.user) delete out.user;
    else out.user = out.user.slice(0, 512);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];

  if (path === 'completions') {
    if (out.prompt != null && Array.isArray(out.prompt)) out.prompt = out.prompt.map((p) => (Array.isArray(p) ? p.join('') : p));
    if (out.suffix === '') delete out.suffix;
    if (out.echo != null) out.echo = out.echo === true;
    if (out.logit_bias != null && typeof out.logit_bias === 'object' && !Object.keys(out.logit_bias).length) delete out.logit_bias;
    for (const k of ['best_of']) if (out[k] == null) delete out[k];
  }

  if (style === 'anthropic') {
    // Anthropic butuh max_tokens; jangan potong di 1024 diam-diam.
    if (out.max_tokens == null) { out.max_tokens = limits.anthropicMaxTokens ?? 4096; note('max_tokens', undefined, out.max_tokens, 'default Anthropic (wajib di Messages API)'); }
    for (const k of ['logprobs', 'top_logprobs', 'presence_penalty', 'frequency_penalty', 'seed', 'n', 'logit_bias', 'response_format', 'stop', 'repetition_penalty', 'min_p', 'top_k', 'frequency_penalty']) {
      if (out[k] !== undefined) {
        if (k === 'stop' && out.stop) { out.stop_sequences = out.stop; forwarded.push('stop_sequences'); }
        else if (k !== 'stop') { ignored.push({ param: k, why: 'tidak ada padanan di Messages API' }); }
        if (k !== 'stop_sequences') delete out[k];
      }
    }
  }

  // Guard konteks: kirim riwayat utuh, tapi jangan biarkan provider memotong sendiri.
  const ctx = guardContext(out, content);
  if (ctx.dropped > 0) note('messages', body.messages?.length, out.messages?.length, `riwayat dipangkas aman: ${ctx.dropped} turn tengah dibuang (pertama + ${ctx.kept} terakhir dipertahankan)`);

  const unknown = Object.keys(body).filter((k) => !KNOWN_PARAMS.includes(k) && !k.startsWith('__lollm'));
  return {
    body: out,
    meta: { forwarded, adjusted, ignored, unknown, historyTurns: ctx.history, droppedTurns: ctx.dropped },
  };
}

function hasJsonHint(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const hay = msgs.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || ''))).join(' ').slice(0, 4000);
  return /\bjson\b/i.test(hay);
}

/**
 * Pastikan multi-turn tetap utuh sebisa mungkin: system + user pertama + N turn terakhir
 * dijaga, turn tengah yang berlebihan dibuang supaya provider tidak memotong awal percakapan
 * (penyebab klasik "history seolah diabaikan").
 */
export function guardContext(body, { enabled = true, maxChars = 60000, minRecentTurns = 4 } = {}) {
  const msgs = Array.isArray(body.messages) ? body.messages : null;
  if (!msgs || msgs.length < 3) return { dropped: 0, kept: msgs?.length || 0, history: msgs?.length || 0 };
  const total = msgs.reduce((n, m) => n + contentLength(m?.content) + String(m?.role || '').length + 16, 0);
  let dropped = 0;
  if (enabled && total > maxChars && msgs.length > minRecentTurns + 2) {
    const head = msgs.filter((m) => m?.role === 'system');
    const rest = msgs.filter((m) => m?.role !== 'system');
    let keep = Math.min(rest.length, Math.max(minRecentTurns, 2));
    let trimmed = [...head, ...rest.slice(-keep)];
    let size = () => trimmed.reduce((n, m) => n + contentLength(m?.content) + 16, 0);
    while (size() > maxChars && keep > minRecentTurns) { keep--; trimmed = [...head, ...rest.slice(-keep)]; }
    dropped = rest.length - keep;
    if (dropped > 0) {
      body.messages = [
        ...head,
        { role: 'system', content: `[LoLLM] ${dropped} turn lama di awal percakapan dipangkas agar muat konteks; riwayat terbaru dikirim utuh.` },
        ...trimmed.filter((m) => m?.role !== 'system'),
      ];
    }
  }
  return { dropped, kept: (body.messages?.length || 0), history: msgs.length };
}

/**
 * Bersihkan riwayat sebelum dikirim: content array → string, buang pesan assistant kosong
 * (banyak model gratis jadi bingung/mengabaikan konteks kalau ada turn kosong), dan
 * pastikan alternating user/assistant tidak rusak.
 */
export function sanitizeHistory(body, { flattenContent = true } = {}) {
  if (!Array.isArray(body.messages)) return { changed: false, removed: 0 };
  let removed = 0;
  let changed = false;
  const out = [];
  for (const m of body.messages) {
    let msg = m;
    // Ratakan content array → string HANYA bila isinya teks semua. Bagian non-teks
    // (image_url/audio) dibiarkan utuh untuk provider yang memang mendukungnya.
    if (flattenContent && Array.isArray(msg.content)
      && msg.content.length
      && msg.content.every((p) => typeof p === 'string' || (p && p.type === 'text'))) {
      const text = msg.content.map(partText).filter(Boolean).join('\n');
      msg = { ...msg, content: text }; changed = true;
    }
    const empty = contentLength(msg.content) === 0;
    if (empty && (msg.role === 'assistant' || msg.role === 'function') && !msg.tool_calls && !msg.function_call) { removed++; changed = true; continue; }
    if (empty && msg.role === 'user' && out.length === 0) { removed++; changed = true; continue; }
    out.push(msg);
  }
  if (changed) body.messages = out;
  return { changed, removed };
}

/** Deteksi jawaban kosong dari body chat OpenAI (non-stream). */
export function isEmptyCompletion(json) {
  if (!json || typeof json !== 'object') return { empty: true, why: 'bukan objek JSON' };
  if (json.error) return { empty: false, why: 'error upstream', upstreamError: json.error };
  const choices = Array.isArray(json.choices) ? json.choices : [];
  if (!choices.length) return { empty: true, why: 'tidak ada choices' };
  const texts = [];
  for (const c of choices) {
    const msg = c?.message || {};
    const content = typeof msg.content === 'string' ? msg.content : contentLength(msg.content) ? messageTextSafe(msg.content) : '';
    if (content?.trim()) return { empty: false };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return { empty: false };
    if (msg.function_call && typeof msg.function_call === 'object') return { empty: false };
    if (msg.reasoning_content && String(msg.reasoning_content).trim()) texts.push('reasoning-only');
    if (c?.finish_reason === 'content_filter') texts.push('content_filter');
    if (c?.text && String(c.text).trim()) return { empty: false };
  }
  return { empty: true, why: texts.length ? texts.join(',') : 'content kosong' };
}

function messageTextSafe(c) {
  try { return Array.isArray(c) ? c.map(partText).filter(Boolean).join('\n') : String(c || ''); } catch { return ''; }
}

export { contentLength as textLen };
