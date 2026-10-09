// LoLLM — Kualitas model & pemilihan task untuk routing 'auto'.
//
// Kenapa file ini ada: daftar model live dari provider (mis. Pollinations) berubah-ubah
// urutannya, jadi "ambil model pertama" membuat kualitas jawaban naik-turun antar request
// dan kadang jatuh ke model kecil yang mencampur bahasa. Di sini setiap model diberi skor
// deterministik (nama keluarga + ukuran parameter + sinyal bahasa) sehingga `auto`
// selalu memilih kandidat terbaik yang sama selama daftar model belum berubah.

/** Task yang dikenali router. */
export const TASKS = ['coding', 'reasoning', 'translation', 'id-chat', 'structured', 'summarize', 'chat'];

// Model yang bukan model-chat sama sekali (classifier / generator / encoder).
// Dipakai untuk chat = HTTP 200 dengan content kosong, jadi selalu disingkirkan.
const HARD_NON_CHAT_RE = /\b(embed|embedding|bge-|e5-|gte-|mxbai-|snowflake-arctic|rerank|reranker|rankgpt|moderation|whisper|sensevoice|paraformer|clip-vit|dall-?e|imagen|sdxl|stable-?diffusion|flux|sdxl-|kling|llama-guard|shieldgemma|granite-guard|guard|guardrails|classifier|ocr|text-to-speech|tts-|asr-)/i;
// Sinyal lain bahwa model tidak dirancang untuk dialog bebas (dihukum skor, tidak dibuang).
const NON_CHAT_RE = /\b(embed|embedding|bge-|e5-|gte-|rerank|moderation|whisper|sensevoice|tts|asr|audio|speech|dall-?e|imagen|clip|guard|safety|shield|classifier|reranker)/i;
const AUDIO_IMAGE_RE = /\b(whisper|sensevoice|tts|asr|audio-?input|audio-?output|image-?gen|veo|sdxl|flux)\b/i;

// Model yang secara tegas dihindari untuk tugas umum (kualitas/kebahasaan tidak stabil
// untuk prompt Indonesia & reasoning). Bisa ditambah lewat settings.routing.blocklist.
export const DEFAULT_BLOCKLIST = [
  'allam',            // khusus Arab: sering campur bahasa & salah fakta pada prompt ID
  'tinyllama',
  'smollm',
  'smolvm',
  'phi-2',
  'gemma-2-2b',
  'gemma-3n-e2b',
  'gemma-3n-e4b',
  'qwen2.5-0.5b',
  'qwen2.5-1.5b',
  'qwen2.5-3b',
  'qwen2.5-coder-1.5b',
  'qwen2.5-coder-3b',
  'llama-3.2-1b',
  'llama-3.2-3b',
  'llama-guard',
  'aya-2-1b',
  'granite-3.1-2b',
  'exaone-2.5-1.8b',
  'minimax-01-230b-gguf:Q2', // kuantisasi ekstrem
];

// Keluarga model: [regex, skor dasar, tag kapabilitas]. Skor mentah 0..100 sebelum penyesuaian.
const FAMILIES = [
  { re: /\b(gpt-?5|gpt-?4\.1|gpt-?4o|chatgpt-4o|o[134](?:-mini|-preview)?)\b/i, score: 95, tags: ['general', 'reasoning', 'coding', 'id'] },
  { re: /\bclaude[\s-]?(opus|sonnet)[\s-]?(4|3[\s.-]?5|3[\s.-]?7)?/i, score: 94, tags: ['general', 'reasoning', 'coding', 'id'] },
  { re: /\bgemini[\s-]?(2\.[05]|25|1\.5)[\s-]?(pro|flash)?/i, score: 88, tags: ['general', 'reasoning', 'coding', 'id'] },
  { re: /\bdeepseek[\s-]?(v3|r1)[\s-]?[\d.]*/i, score: 90, tags: ['reasoning', 'coding', 'math'] },
  { re: /\bdeepseek[\s-]?(coder|llm)/i, score: 82, tags: ['coding'] },
  { re: /\bgpt-oss-(120b|20b)\b/i, score: 87, tags: ['general', 'reasoning', 'coding', 'id'] },
  { re: /\bllama[\s-]?3\.[\s-]?(1|3)[\s-]?405b/i, score: 88, tags: ['general', 'reasoning', 'id'] },
  { re: /\bllama[\s-]?3\.[\s-]?(1|3)[\s-]?70b/i, score: 82, tags: ['general', 'reasoning', 'id'] },
  { re: /\bllama[\s-]?4[\s-]?(maverick|scout|behaemoth)/i, score: 82, tags: ['general', 'id'] },
  { re: /\bqwen[\s-]?(2\.5|3|3\.[\s]?)?[\s-]?(72b|32b|235b|max|plus)/i, score: 86, tags: ['general', 'reasoning', 'coding', 'id'] },
  { re: /\bqwen[\s-]?.*coder/i, score: 84, tags: ['coding'] },
  { re: /\bqwen[\s-]?(2\.5|3)[\s-]?(7b|14b)/i, score: 74, tags: ['general', 'id'] },
  { re: /\bglm-?4\.[567]|^glm-?5\b|z-[hp]o-?glm/i, score: 84, tags: ['general', 'reasoning', 'coding', 'id'] },
  { re: /\bkimi[\s-]?k[12]/i, score: 85, tags: ['general', 'reasoning', 'coding'] },
  { re: /\bminimax-?m[12]\b/i, score: 84, tags: ['general', 'coding'] },
  { re: /\b(mistral-?large|magistral|devstral|pixtral-large)/i, score: 84, tags: ['general', 'reasoning', 'id'] },
  { re: /\bcodestral\b/i, score: 78, tags: ['coding'] },
  { re: /\bmistral-?(nemo|small|7b|8x7b)/i, score: 68, tags: ['general'] },
  { re: /\bcommand-?r[\s-]?(plus)?/i, score: 80, tags: ['general', 'id', 'rag'] },
  { re: /\bnova[\s-]?(pro|prem?ier)/i, score: 78, tags: ['general', 'id'] },
  { re: /\bgrok[\s-]?(2|3|4|fast|vision)?/i, score: 84, tags: ['general', 'reasoning'] },
  { re: /\bseed-?1\.5\b|\doubao/i, score: 80, tags: ['general', 'reasoning'] },
  { re: /\bnemotron[\s-]?(ultra|super|70b|51b)/i, score: 78, tags: ['general', 'reasoning', 'coding'] },
  { re: /\binternlm[\s-]?3[\s-]?(78b|8x)?/i, score: 76, tags: ['general'] },
  { re: /\byi-?[lc]?[\s-]?(34b|6b|9b)/i, score: 72, tags: ['general'] },
  { re: /\baquila|ring-?2c|step-?1/i, score: 70, tags: ['general'] },
  { re: /\bernie[\s-]?4\.5/i, score: 76, tags: ['general', 'id'] },
  { re: /\bphi-?4(\b|-)/i, score: 72, tags: ['reasoning', 'coding'] },
  { re: /\bmagistral|aion-?[23]\b|turbopolar/i, score: 78, tags: ['general'] },
  { re: /\bllama-?3\.1-?8b|llama-?3.2-?11b|gemma-?3-?(12b|27b)|qwen3-?4b|gpt-oss-20b|mistral-?small-?3/i, score: 66, tags: ['general'] },
];

// Model yang kapabel berbahasa Indonesia (multilingual luas) — nilaiplus untuk tugas chat ID.
const INDONESIAN_RE = /\b(gpt-?5|gpt-?4|o[134]|gemini|llama[\s-]?3\.[13]|llama[\s-]?4|command-?r|aya|jais|sea-?lion|indogemma|indolm|sakti|lucintya|wisesight|qwen[\s-]?(2\.5|3)|deepseek[\s-]?(v3|r1)|glm-?4\.5|gpt-?oss|claude|mistral-?large|devstral|aion|ernie|nova)/i;
// Model yang condong ke bahasa Arab/Ibrani/Tiongkok saja → kurangi untuk tugas chat Indonesia.
const NARROW_LANG_RE = /\ballam\b|jais-?-(?:8b|30b)\b|noor|shaik|hurrie|ilham|aqua-?xl|sillytavern-?arab|meituan-?longcat|spark-?4|internlm.*chat-?cn\b/i;

const REASONING_RE = /\b(r1|thinking|reasoner|reasoning|quasar|olmo|smolagents-?reason|seed-?thinking|qwq)\b/i;
const CODING_RE = /\b(codestral|deepseek-?coder|qwen.*coder|starcoder|wizardcoder|codegemma|code-?llama|octoparse|swe-?agent|marco-?miner|devstral|nova-?code|kimi-?k2|lingma|ibm-?granite-?coder|atlas-?chunk-?coder|repocoder|dbrw|redpajama|codeqwen)\b/i;

// Kata kunci deteksi task (ID + EN) pada pesan user terakhir.
const TASK_HINTS = [
  {
    task: 'coding',
    re: /(```|<\/?(html|script|code)\b|\bdef\s+\w+\s*\(|\bfunction\s*\w*\s*\(|\bimport\s+\w+|\bconsole\.log|SELECT .* FROM|\b(class|struct|enum)\s+\w|error:|traceback|\bsyntax\b|\bbug\b|\bstack ?trace\b|\bregex\b|\bapi\b|json|typescript|\bpython\b|\bjavascript\b|\bgolang\b|\brust\b|\bsql\b|\bunit ?test\b|\bnpm\b|\bgit\b|kode|koding|perbaiki (kode|bug|error)|program sederhana|fungsi untuk|script|snippet|compil|compile|error compiler)/i,
  },
  {
    task: 'reasoning',
    re: /(step by step|langkah (demi|per) langkah|jelaskan mengapa|mengapa|analisis|pro ?kon|kesimpulan|buktikan|hitunglah|berapa hasil|matematika|logika|puzzle|reason|deduce|why does|prove|calculate|estimate|bandingkan lalu|urutan mana)/i,
  },
  {
    task: 'translation',
    re: /(terjemah(kan|an)?|translate|artikan|ubah (kalimat|bahasa|ke bahasa)|dari bahasa (inggris|indonesia)|ke bahasa (inggris|indonesia|arab)|bahasa inggris(nya)?|para ?phrase|cari padanan)/i,
  },
  {
    task: 'summarize',
    re: /(ringkas(kan)?|rangkum|summary|tl;?dr\b|point(-| )utama|buatkan kesimpulan dari|ideas?\s+the\s+text)/i,
  },
  {
    task: 'structured',
    re: /(json|format json|csv|tabel|yaml|schema|kunci-?nilai|key-?value|field wajib|output hanya|tanpa penjelasan tambahan|extract|parse|only (json|answer)|no prose)/i,
  },
];

const ASCII_ID_RE = /\b(saya|anda|kamu|tolong|halo|apa|bagaimana|jelaskan|buat|buatkan|terima kasih|tidak|ya|buatkan|bahasa indonesia|indonesia)\b/i;

/** Ambil teks polos dari satu pesan (string atau array bagian). */
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text' ? p.text || '' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Deteksi jenis task dari prompt. Deterministik: hanya bergantung pada isi pesan.
 * @returns {{task:string, signals:string[]}}
 */
export function detectTask(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const userTurns = msgs.filter((m) => m?.role === 'user');
  const last = messageText(userTurns.at(-1)?.content ?? body?.prompt ?? '');
  const sys = messageText(msgs.find((m) => m?.role === 'system')?.content);
  const hay = `${last}\n${sys}`.slice(0, 6000);
  const signals = [];
  let task = 'chat';

  if (Array.isArray(body?.tools) && body.tools.length > 0) { task = 'coding'; signals.push('tools'); }
  if (/json_object|json_schema/.test(String(body?.response_format?.type || ''))) { task = 'structured'; signals.push('response_format'); }

  for (const hint of TASK_HINTS) {
    const m = hay.match(hint.re);
    if (m) { signals.push(`${hint.task}:${String(m[0]).slice(0, 24)}`); task = hint.task; break; }
  }
  // Prompt bahasa Indonesia yang panjang & tanpa kode → utamakan model multilingual.
  if (task === 'chat' && ASCII_ID_RE.test(hay) && last.length > 24) { task = 'id-chat'; signals.push('id'); }
  if (task === 'id-chat' && hay.length > 400) signals.push('long-context');
  return { task, signals };
}

/** Ukuran parameter (miliar) dari nama model, atau null bila tidak terbaca. */
export function paramSize(model) {
  const s = String(model).toLowerCase();
  // MoE: 8x7b / mixtral-8x22b → total aktif kurang, tapi kapasitas besar.
  const moe = s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)b/);
  if (moe) return Math.min(+moe[1] * +moe[2], 405);
  const sizes = [...s.matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z])/g)].map((m) => +m[1]);
  if (!sizes.length) return null;
  return Math.max(...sizes);
}

function blockedBy(model, blocklist) {
  const s = String(model).toLowerCase();
  for (const b of blocklist) {
    const t = String(b || '').trim().toLowerCase();
    if (!t) continue;
    if (t.startsWith('/') && t.lastIndexOf('/') > 0) {
      try { if (new RegExp(t.slice(1, t.lastIndexOf('/')), 'i').test(s)) return true; } catch { /* pola rusak */ }
    } else if (s.includes(t)) return true;
  }
  return false;
}

/**
 * Nilai satu model id untuk task tertentu.
 * @returns {{score:number, tags:string[], reasons:string[], blocked:boolean, nonChat:boolean}}
 */
export function scoreModel(model, { task = 'chat', blocklist = [] } = {}) {
  const id = String(model || '');
  const low = id.toLowerCase();
  const reasons = [];
  const tags = new Set();
  let score = 50; // baseline untuk model yang tidak dikenal

  const isNonChat = HARD_NON_CHAT_RE.test(low);
  const looksNonChat = NON_CHAT_RE.test(low) || AUDIO_IMAGE_RE.test(low);

  let matched = false;
  for (const fam of FAMILIES) {
    if (fam.re.test(id)) {
      matched = true;
      score = Math.max(score, fam.score);
      for (const t of fam.tags) tags.add(t);
      reasons.push(`family(${fam.score})`);
      break;
    }
  }
  if (!matched) reasons.push('unknown-family:baseline');

  const size = paramSize(id);
  if (size != null) {
    if (size >= 70) { score += 8; reasons.push(`size>=70B(+8)`); }
    else if (size >= 30) { score += 4; reasons.push(`size>=30B(+4)`); }
    else if (size >= 14) { score += 0; reasons.push(`size~${size}B`); }
    else if (size >= 7) { score -= 8; reasons.push(`size ${size}B(-8)`); }
    else if (size >= 3) { score -= 20; reasons.push(`size ${size}B(-20)`); }
    else { score -= 38; reasons.push(`size ${size}B(-38)`); }
  }

  // Kuantisasi agresif merusak kualitas.
  const q = low.match(/[:_\- ]q(?:[2-8])(?:_[a-z0-9]+)?\b/);
  if (q) {
    const bits = +q[0].replace(/[^0-9]/g, '');
    if (bits <= 2) { score -= 18; reasons.push('q2(-18)'); }
    else if (bits <= 3) { score -= 8; reasons.push('q3(-8)'); }
    else if (bits <= 4) { score -= 3; reasons.push('q4(-3)'); }
  }

  if (/uncensored|abliterated|doanything|jailbreak|ducks|evil|dolphin/i.test(low)) { score -= 14; reasons.push('unaligned(-14)'); }
  if (/^(gemma|google-)/i.test(low) && !/gemma-?3?(12b|27b)|gemini/i.test(low)) { score -= 6; reasons.push('small-gemma(-6)'); }
  if (/\b(base)\b/i.test(low)) { score -= 8; reasons.push('base-not-instruct(-8)'); }
  if (/\b(it|instruct|chat|thinking|tools)\b/i.test(low)) { score += 3; reasons.push('instruct(+3)'); }

  // Bonus kapabilitas per task.
  const isCodingModel = CODING_RE.test(low);
  if (task === 'coding') {
    if (isCodingModel) { score += 16; tags.add('coding'); reasons.push('coding-model(+16)'); }
    else if (!tags.has('coding')) score -= 4;
  }
  // Model khusus-kode kurang luwes untuk chat/terjemah/rangkum — turunkan supaya
  // 'auto' tidak mengirim pertanyaan bahasa Indonesia ke model coding-only.
  if (['chat', 'id-chat', 'translation', 'summarize'].includes(task) && isCodingModel) {
    score -= 12; reasons.push('coding-only-for-chat(-12)');
  }
  if (task === 'reasoning') {
    if (REASONING_RE.test(id) || tags.has('reasoning')) { score += 12; reasons.push('reasoning(+12)'); }
  }
  if (task === 'id-chat' || task === 'translation' || task === 'summarize' || task === 'structured') {
    if (INDONESIAN_RE.test(id)) { score += 10; tags.add('id'); reasons.push('multilingual-id(+10)'); }
  }
  if (task === 'structured') {
    if (/\b(json|instruct|tools|it)\b/i.test(low)) { score += 5; reasons.push('structured(+5)'); }
    if (size != null && size < 7) { score -= 8; reasons.push('small-for-json(-8)'); }
  }
  if (task === 'translation' || task === 'id-chat') {
    if (NARROW_LANG_RE.test(low)) { score -= 30; reasons.push('narrow-language(-30)'); }
  }
  if (looksNonChat) { score -= 60; reasons.push('not-a-chat-model(-60)'); }

  const blocked = blockedBy(id, [...DEFAULT_BLOCKLIST, ...blocklist]);
  if (blocked) reasons.push('blocklisted');

  let excludedReason = null;
  if (isNonChat) excludedReason = 'bukan model chat (embedding/rerank/audio)';
  else if (blocked) excludedReason = 'di-blocklist kualitas';

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    tags: [...tags],
    reasons,
    blocked,
    nonChat: isNonChat,
    excludedReason,
  };
}

/**
 * Urutkan kandidat model untuk sebuah provider.
 * Deterministik (skor desc → nama asc) supaya `auto` tidak berganti-ganti tanpa alasan.
 *
 * @param {string[]} models daftar live
 * @param {{task?:string, blocklist?:string[], minScore?:number, path?:string, allowLowQuality?:boolean}} opts
 * @returns {Array<{model:string, score:number, tags:string[], reasons:string[], lowConfidence?:boolean}>}
 */
export function rankModels(models, opts = {}) {
  const { task = 'chat', blocklist = [], minScore = 45, path = 'chat/completions', allowLowQuality = true } = opts;
  const scored = [];
  for (const model of models || []) {
    const s = scoreModel(model, { task, blocklist });
    if (path === 'embeddings') {
      // Untuk embeddings justru model embedding yang dicari.
      if (!/\b(embed|embedding|bge-|e5-|gte-|text-embedding|snowflake|jina)/i.test(String(model))) continue;
      scored.push({ model, score: 90 - (s.blocked ? 40 : 0), tags: ['embedding'], reasons: ['embedding-path'] });
      continue;
    }
    if (s.blocked) continue;
    if (s.nonChat) continue; // model embedding/rerank tidak layak untuk chat
    scored.push({ model, score: s.score, tags: s.tags, reasons: s.reasons, lowConfidence: s.score < minScore });
  }
  scored.sort((a, b) => (b.score - a.score) || String(a.model).localeCompare(String(b.model)));

  const strong = scored.filter((m) => m.score >= minScore);
  if (strong.length) return strong;
  // Tidak ada yang lolos ambang: jangan 404 — pakai yang terbaik yang ada, tandai.
  return allowLowQuality ? scored.map((m) => ({ ...m, lowConfidence: true })) : [];
}

/** Ringkasan pendek alasan pemilihan untuk header/log. */
export function selectionReason({ task, model, score, lowConfidence, sticky }) {
  const bits = [`task=${task}`];
  if (score != null) bits.push(`score=${score}`);
  if (lowConfidence) bits.push('below-threshold');
  if (sticky) bits.push('sticky');
  return bits.join(' ');
}
