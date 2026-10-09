# LoLLM — Local LLM Gateway

> **Satu port. Banyak key per provider. Fallback secepat kilat. Katalog provider gratis bawaan.**
> Nol dependensi — cukup Node.js ≥ 18.

LoLLM adalah gateway LLM lokal-first: dashboard + API OpenAI-compatible berjalan di **satu port**,
setiap provider bisa diisi **banyak API key** (pool + rotasi otomatis), dan setiap request otomatis
**fallback** ke key/provider berikutnya **tanpa jeda** — 429, 401, timeout, jawaban kosong, request
cacat, semuanya ditangani sebelum Anda sempat sadar.

## ✨ Kenapa LoLLM

| | LoLLM | Router lain |
|---|---|---|
| Dashboard + API | **1 port**, path rapih | Port/config terpisah |
| Dashboard | **React 19 + Tailwind**, responsif (sidebar desktop, bottom-nav mobile) | — |
| Multi-key per provider | ✅ pool + rotasi LRU + cooldown | Sebagian |
| Fallback | **0ms antar percobaan**, lintas key → lintas provider | Backoff lambat |
| Pemilihan model | **dinilai per kualitas + task**, stabil antar request | `models[0]` (lotre) |
| Jawaban kosong | **ditolak** → retry internal lalu 502 (bukan 200 hampa) | 200 `content: ""` |
| Transparansi | header `x-lollm-*` + field `x_lollm` di body | — |
| Provider gratis | Katalog bawaan, **tempel key langsung jalan** | Setup manual |
| Dependensi | **0 (Node.js murni)** | ratusan paket npm |
| Deploy | `node bin/lollm.js` **atau** image GHCR multi-arch (non-root + healthcheck) | butuh runtime khusus |
| Format | OpenAI-compatible + translasi Anthropic | — |

## 🚀 Quickstart

```bash
git clone https://github.com/NetBypass/LoLLM && cd LoLLM
node bin/lollm.js            # atau: npm start

# …atau lewat container (pengaturan & key bertahan di volume):
docker run -d -p 5151:5151 -v lollm-data:/app/data ghcr.io/netbypass/lollm:latest
```

Buka `http://localhost:5151` → **masuk dengan password default `Edoll123`** (ganti di tab
Admin setelah masuk). Provider **Pollinations** (keyless, gratis) sudah aktif otomatis, jadi API
langsung bisa dipakai tanpa setup apa pun:

```bash
curl http://localhost:5151/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <gateway-key-anda>" \
  -d '{"model":"auto","messages":[{"role":"user","content":"halo!"}]}'
```

Lalu tempel API key gratis dari katalog (lihat tabel di bawah) — tanpa konfigurasi manual.

## 🗺️ Struktur URL (satu port, rapih)

```
http://localhost:5151
├── /                        Dashboard (UI)
│    Overview · Playground · Providers & Keys · Routing · Logs
├── /health  /healthz  /live     Health check (publik, tanpa key)
├── /ready   /readyz             Readiness untuk load balancer (503 bila provider mati)
├── /v1                          API OpenAI-compatible
│   ├── POST /chat/completions       (stream & non-stream)
│   ├── POST /completions
│   ├── POST /embeddings
│   ├── GET  /models
│   └── GET  /health
└── /api                           Admin API (untuk dashboard)
    ├── POST /login                                (password dashboard)
    ├── GET  /bootstrap · /status · /logs · /models
    ├── GET  /routing/auto?task=chat               ← preview & alasan pemilihan model
    ├── POST /routing/warmup                       ← panaskan cache katalog + koneksi
    ├── POST /keys (single & bulk) · /keys/test · /keys/toggle
    ├── POST /providers/toggle · /providers/custom
    ├── PUT  /settings · POST /gateway/rotate
    ├── PUT  /dashboard · POST /dashboard/password · POST /stats/reset
    ├── GET  /config/export · POST /config/import   (backup penuh)
    └── POST /logs/clear
```

## 🎮 Playground

Tab **Playground** di dashboard: chat langsung via `/v1` (streaming) — lihat provider mana yang
menjawab, latensinya, dan **jejak fallback live** di bawah tiap jawaban. Multi-turn, system prompt,
dan autocomplete daftar model.

## 🔐 Akses dashboard

Dashboard **terkunci password** secara default (password default: `Edoll123`, disimpan sebagai
hash SHA-256 di `data/config.json`). Kelola di tab **Admin**:

- Ganti password (verifikasi password lama, min. 6 karakter)
- Aktif/nonaktif panel login (saat nonaktif, dashboard terbuka langsung)
- Rotate gateway API key + reset statistik
- Login dibatasi 10 percobaan/menit per IP (anti brute-force)

**Gateway key** (yang dipakai klien di header `Authorization`) tidak pernah dicetak penuh di
log/UI — salin lewat tab Admin, atau dari terminal:

```bash
node bin/lollm.js key            # cetak key yang tersimpan
node bin/lollm.js key --rotate   # ganti dengan key baru (yang lama langsung tidak berlaku)
```

Menjalankan dengan `--no-auth` mematikan pemeriksaan key di `/v1/*` (praktis untuk develop /
di belakang reverse-proxy); dashboard tetap butuh login kecuali panel login dinonaktifkan.

## 🎨 Dashboard (React)

UI dashboard dibangun dengan **React 19 + Vite + Tailwind CSS v4** — modern, responsif
(sidebar di desktop, bottom-nav di mobile), dark-mode dengan aksen gradien, ikon **lucide**,
dan animasi halus (transisi halaman, stagger kartu, count-up statistik, shake pada error login).

- Source: `web/` · Build hasil (sudah di-commit): `public/`
- Gateway tetap **zero-dependency**: `node bin/lollm.js` langsung serve build yang ada, tanpa npm
- Ikut mengembangkan UI:

```bash
cd web && npm install
npm run dev        # vite di :5173, proxy /api & /v1 ke gateway :5151
npm run build      # rebuild ke ../public
npm test           # audit identifier + SSR render semua halaman
```

## 🐳 Docker & image

Image dipublish otomatis ke **GHCR** — multi-arch (`linux/amd64`, `linux/arm64`), tanpa dependensi
runtime di dalam image (dashboard sudah di-commit di `public/`, jadi build image tidak butuh `npm install`).

Volume `/app/data` menyimpan `config.json` (pengaturan + API key + gateway key + statistik),
jadi upgrade image tidak menghapus apa pun:

```bash
docker run -d --name lollm -p 5151:5151 -v lollm-data:/app/data ghcr.io/netbypass/lollm:latest
```

Lalu cetak gateway key (dipakai klien di header `Authorization`) dan buka dashboard:

```bash
docker exec lollm node bin/lollm.js key
docker exec lollm node bin/lollm.js key --rotate   # ganti key
curl -s localhost:5151/health | head -c 200
```

Buka `http://localhost:5151` → login dashboard (password default `Edoll123`, ganti di tab Admin).

| Hal | Detail |
|---|---|
| Image | `ghcr.io/netbypass/lollm:latest` (main), `:0.2.0` / `:0.2` (tag git `v0.2.0`), `:sha-<full>` (siapa pun commit) |
| Base | `node:22-alpine`, jalan sebagai user non-root `node` |
| Env | `PORT` (5151), `HOST` (0.0.0.0), `LOLLM_HOME` (`/app/data`), `NODE_ENV` (production) |
| Healthcheck | `GET /healthz` tiap 30s — liveness murni, tidak menyentuh upstream, jadi container tetap "sehat" walau provider belum diisi |
| Readiness | `GET /readyz` → 503 + `reasons[]` bila semua provider cooldown/mati (pakai ini untuk rollout gate, bukan untuk healthcheck image) |
| Stop | `SIGTERM` → shutdown bersih (koneksi client ditutup dulu) |
| Persistensi | mount `/app/data` (volume named atau bind); tanpa ini pengaturan & key hilang saat upgrade |

Compose:

```yaml
services:
  lollm:
    image: ghcr.io/netbypass/lollm:latest
    ports: ["5151:5151"]
    volumes: [lollm-data:/app/data]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:5151/healthz"]
volumes:
  lollm-data: {}
```

Build sendiri (mis. untuk arsitektur lain atau image internal):

```bash
docker build -t lollm:dev \
  --build-arg VERSION=$(node -p "require('./package.json').version") \
  --build-arg REVISION=$(git rev-parse HEAD) .
# atau: npm run docker:build
```

### Bagaimana image dipublish (CI)

`.github/workflows/docker.yml`:

1. **smoke** — image di-build (single-platform) lalu container-nya benar-benar dijalankan; yang diperiksa:
   `/healthz` + `/readyz` 200, dashboard terserve (termasuk aset hashed), `/v1/*` & `/api/*` 401 tanpa
   kredensial, `node bin/lollm.js key` bisa membaca key dari volume, `messages: []` → 400 dengan pesan jelas,
   dan **kontrak utama**: permintaan `auto` hanya boleh 200 bila `choices[0].message.content` terisi dan
   membawa `x_lollm` + `x-lollm-*`; kalau upstream rewel harus 404/502/503/429 + pesan, tidak pernah 200 hampa.
2. **publish** — hanya untuk push di branch default / tag `v*`: build `amd64+arm64`, push ke GHCR,
   lengkap dengan provenance (SLSA) + SBOM. Tag: `latest`, semver dari tag git, dan `sha-<commit>`.

PR hanya menjalankan smoke (tidak mem-push). Guard statis untuk Dockerfile/`.dockerignore`/workflow
ada di `test/packaging.test.mjs` (`npm test`), supaya perubahan yang membuat image gagal build atau
gagal jalan ketahuan tanpa perlu Docker di runner.

## 🔑 Katalog provider bawaan

Tinggal klik "Ambil key", tempel di dashboard. Tidak perlu setup provider manual.

| Provider | Tier | Ambil API key |
|---|---|---|
| Groq | 🆓 gratis | https://console.groq.com/keys |
| GitHub Models | 🆓 gratis (semua akun GitHub) | https://github.com/settings/tokens?type=beta |
| Google AI Studio (Gemini) | 🆓 gratis | https://aistudio.google.com/apikey |
| Cerebras | 🆓 gratis | https://cloud.cerebras.ai |
| Z.AI (GLM Flash) | 🆓 gratis | https://z.ai |
| Mistral | 🆓 free tier | https://console.mistral.ai/api-keys |
| LLM7 | 🆓 gratis | https://llm7.io |
| Pollinations | 🆓 gratis, **tanpa key** | — |
| OpenRouter | 🆓 ada model `:free` | https://openrouter.ai/settings/keys |
| NVIDIA NIM | 💰 kredit trial | https://build.nvidia.com |
| HuggingFace Router | 💰 kredit bulanan | https://huggingface.co/settings/tokens |
| OpenAI / Anthropic / DeepSeek / xAI / Together / Moonshot | 💰 berbayar | lihat dashboard |

## ⚡ Cara kerja fallback (secepat kilat)

```
client → POST /v1/chat/completions  (model: "llama-3.3-70b")
   └─ Router menilai SEMUA model live (kualitas + task), lalu membangun rantai kandidat:
        [groq·key-A, groq·key-B, cerebras·key-A, pollinations·keyless]
        ├─ groq·key-A   → 429  ⟶ key di-cooldown, LANJUT (0ms)
        ├─ groq·key-B   → 401  ⟶ key ditandai mati, LANJUT (0ms)
        ├─ cerebras·key-A → timeout 8s ⟶ LANJUT (0ms)
        └─ pollinations → 200 ✅ di-stream langsung ke client
```

- **429** → key cooldown sesuai `retry-after`, request lanjut ke key lain — tanpa menunggu.
- **401/403** → key ditandai mati (hidup lagi lewat tombol Test), lanjut.
- **Timeout / 5xx / network** → lanjut ke kandidat berikutnya.
- **Model sama di provider lain** → otomatis dicoba, dicocokkan dengan **daftar model live** dari endpoint masing-masing.
- **Last resort** (opsional, default ON): kalau semua kandidat model tsb habis, provider sehat mana pun dipakai —
  modelnya **dipilih yang terbaik** di provider itu (bukan model pertama), dan dilaporkan di header
  `x-lollm-model` + `x-lollm-selection: …,last-resort`.
- **200 kosong = gagal** — lihat [Tidak ada lagi HTTP 200 tanpa isi](#-tidak-ada-lagi-http-200-tanpa-isi).

## 🎯 Cara `auto` memilih model

`auto` **bukan** "provider pertama, model pertama". Setiap request, gateway menilai **seluruh**
model live dari **seluruh** provider sehat, lalu mengurutkannya dengan skor deterministik
(`src/quality.js`):

| Sinyal | Contoh pengaruh |
|---|---|
| Keluarga model (frontier vs murah) | `gpt-oss-120b`, `llama-3.3-70b`, `qwen2.5-72b`, `deepseek-v3/r1`, `gemini-2.x` naik |
| Ukuran parameter dari nama model | `<3B` −38, `3–7B` −20…−8, `≥70B` +8 |
| Kecocokan task | task **coding** → model code khusus +16; task **chat/translation/summarize** → model coding-only −12 |
| Kapabilitas bahasa Indonesia | model multilingual +10; model yang condong satu bahasa lain −30 |
| Kuantisasi (`q2`/`q3`) & model `base` (bukan instruct) | −18 / −8 |
| Modalitas | model embedding / rerank / audio / guard **dibuang** dari jalur chat (sumber klasik `content` kosong) |
| Blocklist kualitas | `allam`, `tinyllama`, `smollm`, `gemma-2-2b`, `qwen2.5-0.5b/1.5b/3b`, `llama-3.2-1b/3b`, `phi-2`, … |

**Deteksi task** dilakukan dari prompt (Indonesia + Inggris): `coding`, `reasoning`, `translation`,
`summarize`, `structured` (JSON), `id-chat`, `chat`. Bisa dipaksa lewat `model: "auto:coding"`.

Stabil dari tiga arah:

1. **Urutan deterministik** — skor desc, lalu prioritas provider, lalu nama model. Urutan daftar
   live provider yang berubah-ubah tidak lagi mengubah hasil.
2. **Cache rencana** — hasil penilaian disimpan 20 detik, jadi request beruntun memakai jalur yang sama.
3. **Routing lengket** — satu percakapan (hash pesan pertama, atau header `x-lollm-route-key`)
   terkunci ke satu model selama TTL (`routing.stickyTtlMin`, default 30 menit). Multi-turn tidak
   berganti "kepribadian" di tengah obrolan.

Model yang gagal beruntun (kosong/timeout/5xx) diberi **penalti lunak** sehingga turun peringkat
lalu pulih sendiri — bukan dimatikan permanen.

Yang **tidak** berubah: `provider/model` selalu mem-pin provider, dan model di blocklist tetap bisa
dipanggil eksplisit. Blocklist hanya mengatur apa yang boleh dipilih `auto`.

### Intip isi black-box

```bash
curl -s localhost:5151/api/routing/auto?task=coding -H "Authorization: Bearer <gateway-key>"
```

```jsonc
{
  "task": "coding", "providersScanned": 3, "modelsScanned": 214,
  "eligible": 180, "aboveThreshold": 96, "minQualityScore": 45,
  "candidates": [
    { "provider": "groq", "model": "qwen2.5-coder-32b", "score": 99, "base": 99, "penalty": 0,
      "tags": ["coding"], "reasons": ["family(84)", "coding-model(+16)"] }
  ],
  "excluded": [ { "provider": "pollinations", "model": "allam-2-7b", "excludedReason": "di-blocklist kualitas" } ]
}
```

Tab **Routing → Preview pemilihan "auto"** menampilkan hal yang sama + bar skor, lengkap dengan
model yang disingkirkan dan alasannya.

## 🚫 Tidak ada lagi HTTP 200 tanpa isi

`content` kosong (termasuk `choices: []`, hanya-reasoning, atau stream yang langsung `[DONE]`)
**bukan** sukses. Alurnya:

```
kandidat A → 200, content kosong  ⟶ dihitung gagal (kind: "empty"), key TIDAK dihukum
           ⟶ retry kandidat yang sama (content.emptyRetries)
           ⟶ lanjut ke kandidat berikutnya (0ms)
semua kosong ⟶ 502 { error.code: "empty_completion", provider, model, trail }
```

Dua alasan teknis kenapa ini juga berlaku untuk **streaming**: header response ke klien baru
ditulis setelah ada bukti isi (delta konten / `tool_calls`); sebelumnya chunk ditahan di memori
(katup aman 1 MB). Jadi stream kosong bisa diganti attempt lain alih-alih mengirim 200 kosong.
Kalau upstream benar-benar memotong di tengah jawaban, sebagian jawaban tetap dikirim apa adanya
dan percobaan berhenti — tidak ada pengulangan ganda.

Sesuai selera lewat `settings.content`: `{ rejectEmpty: true, emptyRetries: 1 }`
(set `rejectEmpty: false` untuk mengembalikan perilaku lama).

## 🔍 Transparansi: model mana yang benar-benar menjawab

Setiap respons `/v1` membawa:

| Header | Isi |
|---|---|
| `x-lollm-provider` | provider yang melayani |
| `x-lollm-model` | **model akhir** yang dipakai (bisa beda dari yang diminta) |
| `x-lollm-requested-model` | apa yang klien minta |
| `x-lollm-selection` | `auto:quality` · `auto:sticky` · `exact` · `fuzzy` · `pin` (+ `last-resort`, `low-confidence`) |
| `x-lollm-selection-reason` | alasan singkat, mis. `task=coding score=99` |
| `x-lollm-task` | task yang terdeteksi |
| `x-lollm-attempts` / `x-lollm-fallbacks` | jumlah percobaan / berapa kali berpindah |
| `x-lollm-fallback` | `true`/`false` |
| `x-lollm-trail` | jejak fallback (base64url JSON `provider/key:kind`) |
| `x-lollm-params` | parameter yang diubah/diabaikan (base64url) |
| `x-lollm-low-confidence` | muncul bila tak ada model di atas ambang kualitas |
| `x-lollm-empty-retries` | berapa jawaban kosong yang ditolak & diulang |

Non-stream juga menyisipkan **field `x_lollm`** di body (klien OpenAI mengabaikan field asing):

```jsonc
{
  "id": "chatcmpl-…", "model": "qwen2.5-72b-instruct", "choices": [ … ],
  "x_lollm": {
    "requested_model": "auto", "model": "qwen2.5-72b-instruct", "provider": "groq",
    "task": "id-chat", "attempts": 2, "fallbacks": 1, "fallback_occurred": true,
    "any_fallback": false, "sticky": true, "low_confidence": false, "empty_retries": 0,
    "selection": { "mode": "auto:quality", "reason": "task=id-chat score=100",
                   "best": ["groq/qwen2.5-72b-instruct:100", "groq/gpt-oss-120b:95"] },
    "params": { "forwarded": ["temperature"], "adjusted": [], "ignored": [], "unknown": [] },
    "gateway_ms": 812, "usage": { "prompt_tokens": 31, "completion_tokens": 148 }
  }
}
```

Stream: metadata yang sama ditulis sebagai **komentar SSE** di awal (`: lollm-meta {…}`) —
parser OpenAI mengabaikan komentar, jadi aman.

## 🧪 Parameter request

`temperature`, `top_p`, `max_tokens` / `max_completion_tokens`, `n`, `stop`, `seed`, `presence_penalty`,
`frequency_penalty`, `response_format`, `tools`/`tool_choice`, `logit_bias`, `logprobs`, `user`,
`stream`/`stream_options` **diteruskan ke provider**. Yang tidak sah tidak dibuang diam-diam:

* di-clamp ke rentang sah (`temperature` 0–2, `top_p` 0–1, `presence/frequency_penalty` ±2) — tercatat di `params.adjusted`;
* `null` / `NaN` / `max_tokens <= 0` dihapus (nilai-neki inilah yang sering bikin parameter "tidak berpengaruh") — `params.ignored`;
* `response_format: json_object` pada model yang butuh isyarat → satu system baris "balas hanya JSON" ditambahkan (dilaporkan, tidak senyap);
* gaya Anthropic: `max_tokens` wajib → default 4096 (bukan 1024 yang memotong jawaban), `stop → stop_sequences`,
  parameter tanpa padanan dilaporkan sebagai `ignored`;
* parameter tak dikenal **tetap diteruskan** (forward-compatible) dan muncul di `params.unknown`.

Provider tetap berhak mengabaikan apa pun di sisinya — karena itu gateway **melaporkan** apa yang
ia kirim alih-alih berjanji. Butuh daftar persis per provider? Lihat jejak di tab **Logs**.

## 🧵 Konteks multi-turn

Riwayat **selalu** dikirim utuh ke model terpilih, apa pun hasil fallback-nya. Dua hal yang membuat
"context hilang" dibereskan:

* turn `assistant` dengan `content` kosong dibuang — pada banyak model kecil ini yang membuat
  template chat rusak sehingga pertanyaan terakhir dijawab ngawur;
* `content` array (multimodal parts) diratakan ke teks untuk provider yang tidak memahaminya;
* kalau riwayat melebihi `context.maxChars` (default 60 000 karakter ≈ 15k token), yang dipotong
  adalah turn **di tengah** — `system` + turn terakhir selalu utuh — dan pemangkasan dilaporkan di
  `x_lollm.params.adjusted`. Tidak ada lagi pemotongan sepihak oleh provider.

Ditambah routing lengket (di atas), satu percakapan memakai model yang sama dari awal sampai akhir.

## 🚦 Rate limit & kapasitas

Default: **600 request/menit + burst 60 per gateway key** (per IP bila auth dimatikan) dan
**32 request upstream serentak**. Lewat batas → `429` + `Retry-After` + `x-ratelimit-*`,
dengan pesan yang menyebut batasnya. Antrean request serentak menunggu maksimal 5 detik sebelum
429 — supaya di bawah beban tinggi klien menerima "sibuk" yang jelas, bukan jawaban kosong.

```jsonc
{ "error": { "message": "Rate limit 600 request/menit tercapai. Tunggu 3s lalu kirim lagi…",
             "type": "rate_limit_error", "code": 429, "retry_after": 3 } }
```

Atur di tab **Routing → Rate limit & kapasitas** (`settings.rateLimit`: `enabled`, `requestsPerMinute`,
`burst`, `maxConcurrent`). Mengubah limit langsung mereset bucket semua klien.

## 🩺 Health check & warm-up

| Endpoint | Untuk siapa | Isi |
|---|---|---|
| `GET /live`, `/livez` | liveness (kubelet) | `{ ok, status: "alive", uptimeSec, version }` — selalu 200 selama proses hidup |
| `GET /ready`, `/readyz` | load balancer | 200 `ready` / **503 `degraded`** + `providers.{total,up,usable}`, `modelsKnown`, `reasons[]` |
| `GET /health`, `/healthz`, `/v1/health`, `/status` | monitoring | ringkasan: provider, stats (termasuk `emptyRejected`, `rateLimited`), setting rate limit |

Semua murah (tanpa ke upstream, hanya cache) dan **tidak butuh gateway key**. `/health` &
`/healthz` adalah alias yang sama; `/v1/health` ada untuk agen yang hanya boleh bicara ke `/v1`.

**Anti cold start:** saat boot gateway menarik katalog model semua provider **paralel** (dulu
sekuensial — ini penyebab request pertama lambat), sekaligus membuka koneksi TLS ke tiap endpoint,
lalu menjaganya tetap segar setiap `warmup.intervalMs` (default 4 menit, sebelum TTL 10 menit kedaluwarsa).
Resolusi `auto` ikut di-cache. Sisanya tinggal `POST /api/routing/warmup` untuk memaksa.

## 🧰 Konfigurasi

CLI: `node bin/lollm.js [--port 5151] [--host 0.0.0.0] [--data ./data] [--no-auth]`

Semua kebijakan di atas adalah `settings` di `data/config.json` (edit dari tab **Routing**, jangan
manual kalau bisa): `routing.{autoCandidates,minQualityScore,blocklist,allowLowQuality,stickyAuto,stickyTtlMin}`,
`content.{rejectEmpty,emptyRetries}`, `context.{enabled,maxChars,minRecentTurns}`,
`rateLimit.{enabled,requestsPerMinute,burst,maxConcurrent}`, `params.{maxTokensCap,maxN,anthropicMaxTokens}`,
`warmup.{enabled,intervalMs}`, `timeouts.{connectMs,firstByteMs,totalMs,streamIdleMs}`.

Env: `PORT`, `HOST`, `LOLLM_HOME` (dir data).

Data tersimpan di `data/config.json` (di-gitignore — jangan commit key Anda).
Gateway key dibuat otomatis saat pertama jalan; bisa di-rotate dari dashboard.

### Contoh: 1 provider Groq, banyak key

Dashboard → tab Providers → Groq → tempel key pertama, kedua, ketiga... selesai.
Key dipilih LRU (least-recently-used) di antara key yang sehat; statistik per key terlihat di UI.

Punya banyak key sekaligus? Klik **⇊ Bulk** dan tempel satu key per baris —
semuanya masuk pool dalam sekali klik (duplikat otomatis dilewati).

### Pindah mesin? Backup & restore

Tab **Routing → Backup & restore config**: export seluruh provider + pool key + pengaturan ke
satu file JSON, import di mesin baru. ⚠ File berisi API key asli — simpan aman.

## 📖 API

OpenAI-compatible penuh di `/v1` (chat/completions, completions, embeddings, models) — plus field
`x_lollm` di body non-stream. Model spesial `auto` memilih model **berkualitas terbaik** dari provider
sehat, sesuai task prompt, dan lengket per percakapan. Request cacat (mis. `messages: []`) langsung
`400 invalid_request_error`, jawaban kosong menghasilkan `502 empty_completion`, beban berlebih `429`.
Format `provider/model` (mis. `groq/llama-3.3-70b-versatile`) mem-pin provider.

### Daftar model selalu live — tanpa template/dummy

LoLLM **tidak menyimpan daftar model hardcode**. `/v1/models` kosong sampai ada API key aktif,
lalu terisi **langsung dari endpoint provider** (di-cache 10 menit; gagal fetch = kosong, coba lagi 30s —
tidak pernah ada daftar palsu). Fetch banyak provider berjalan paralel agar waktu muat mengikuti provider
terlambat, bukan jumlah seluruh provider.

Di tab **Providers**, setiap model tampil sebagai tag dengan checkbox. Model dapat dihapus satuan,
massal berdasarkan pilihan, atau sekaligus. Karena katalog berasal dari server provider, "hapus" berarti
menyembunyikan model secara persisten dari `/v1/models`, Playground, dan auto-routing; tombol **Pulihkan**
mengembalikannya kapan saja. Resolusi model (`auto`, pencocokan nama, last-resort) hanya memakai daftar live
yang tidak disembunyikan. Setiap perubahan key/provider otomatis mem-bust cache
(`/api/models?refresh=1` untuk paksa).

### Mode penghemat tanpa mengurangi performa

Pilih strategi **Free-first** di tab Routing. LoLLM mendahulukan seluruh provider gratis yang sehat,
sementara provider berbayar tetap menjadi fallback dengan streaming, timeout, dan kualitas request yang sama.
Tidak ada pemotongan prompt maupun `max_tokens`. Jalur request juga memakai cache model dan penulisan statistik
tertunda agar disk I/O tidak menghambat respons.

## 🧪 Test

```bash
npm test              # node --test test/*.test.mjs — nol dependensi, tanpa internet
npm run test:unit     # hanya kualitas routing & normalisasi parameter
npm run test:gateway  # end-to-end lewat mock provider (validasi, empty-200, fallback, SSE)
```

99 test tanpa jaringan (upstream di-mock): validasi 400 (`messages: []`, role aneh, prompt/input
kosong, body rusak), semua varian "200 tanpa isi" (non-stream, stream, reasoning-only, `choices: []`,
body non-JSON, JSON-dibalas-ke-request-stream), retry internal lalu fallback ke kandidat berikutnya,
pemilihan `auto` (deterministik, model lemah tersingkir, task-aware, last-resort tetap berkualitas),
transparansi (header, field `x_lollm`, komentar SSE, `/api/routing/auto`), penerusan & clamp parameter,
riwayat multi-turn + pemangkasan aman + sticky routing, `/health` & `/readyz`, 429 + `Retry-After`,
validasi admin (key duplikat 409, provider tak dikenal 400), guard packaging Dockerfile/image + konsistensi versi,
dan regresi perilaku lama (format OpenAI, streaming, auth 401, CORS, 30 request paralel tanpa jawaban kosong).

Mock upstream + helper ada di `test/helpers/` — dipakai juga sebagai contoh integrasi OpenAI-compatible
paling kecil. Dashboard punya audit identifier + smoke test SSR sendiri: `cd web && npm test`.

## License

MIT
