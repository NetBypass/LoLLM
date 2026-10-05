# LoLLM — Local LLM Gateway

> **Satu port. Banyak key per provider. Fallback secepat kilat. Katalog provider gratis bawaan.**
> Nol dependensi — cukup Node.js ≥ 18.

LoLLM adalah gateway LLM lokal-first: dashboard + API OpenAI-compatible berjalan di **satu port**,
setiap provider bisa diisi **banyak API key** (pool + rotasi otomatis), dan setiap request otomatis
**fallback** ke key/provider berikutnya **tanpa jeda** — 429, 401, timeout, semua ditangani sebelum
Anda sempat sadar.

## ✨ Kenapa LoLLM

| | LoLLM | Router lain |
|---|---|---|
| Dashboard + API | **1 port**, path rapih | Port/config terpisah |
| Multi-key per provider | ✅ pool + rotasi LRU + cooldown | Sebagian |
| Fallback | **0ms antar percobaan**, lintas key → lintas provider | Backoff lambat |
| Provider gratis | Katalog bawaan, **tempel key langsung jalan** | Setup manual |
| Dependensi | **0 (Node.js murni)** | ratusan paket npm |
| Format | OpenAI-compatible + translasi Anthropic | — |

## 🚀 Quickstart

```bash
git clone https://github.com/NetBypass/LoLLM && cd LoLLM
node bin/lollm.js            # atau: npm start
```

Buka `http://localhost:5151` → dashboard aktif. Provider **Pollinations** (keyless, gratis)
sudah aktif otomatis, jadi API langsung bisa dipakai tanpa setup apa pun:

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
├── /healthz                 Health check
├── /v1                      API OpenAI-compatible
│   ├── POST /chat/completions   (stream & non-stream)
│   ├── POST /completions
│   ├── POST /embeddings
│   └── GET  /models
└── /api                     Admin API (untuk dashboard)
    ├── GET  /bootstrap · /status · /logs · /models
    ├── POST /keys (single & bulk) · /keys/test · /keys/toggle
    ├── POST /providers/toggle · /providers/custom
    ├── PUT  /settings · POST /gateway/rotate
    ├── GET  /config/export · POST /config/import   (backup penuh)
    └── POST /logs/clear
```

## 🎮 Playground

Tab **Playground** di dashboard: chat langsung via `/v1` (streaming) — lihat provider mana yang
menjawab, latensinya, dan **jejak fallback live** di bawah tiap jawaban. Multi-turn, system prompt,
dan autocomplete daftar model.

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
   └─ Router membangun rantai kandidat:
        [groq·key-A, groq·key-B, cerebras·key-A, pollinations·keyless]
        ├─ groq·key-A   → 429  ⟶ key di-cooldown, LANJUT (0ms)
        ├─ groq·key-B   → 401  ⟶ key ditandai mati, LANJUT (0ms)
        ├─ cerebras·key-A → timeout 8s ⟶ LANJUT (0ms)
        └─ pollinations → 200 ✅ di-stream langsung ke client
```

- **429** → key cooldown sesuai `retry-after`, request lanjut ke key lain — tanpa menunggu.
- **401/403** → key ditandai mati (hidup lagi lewat tombol Test), lanjut.
- **Timeout / 5xx / network** → lanjut ke kandidat berikutnya.
- **Model sama di provider lain** → otomatis dicoba (alias bawaan, mis. `llama-3.3-70b` → Groq ⭢ Cerebras).
- **Last resort** (opsional, default ON): kalau semua kandidat model tsb habis, provider sehat mana pun dipakai —
  model aktual dilaporkan di header `x-lollm-model`.

## 🧰 Konfigurasi

CLI: `node bin/lollm.js [--port 5151] [--host 0.0.0.0] [--data ./data] [--no-auth]`

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

OpenAI-compatible penuh di `/v1` (chat/completions, completions, embeddings, models).
Bonus header observabilitas pada setiap response: `x-lollm-provider`, `x-lollm-model`, `x-lollm-trail`
(jejak fallback). Model spesial `auto` memilih provider sehat terbaik otomatis.
Format `provider/model` (mis. `groq/llama-3.3-70b-versatile`) mem-pin provider.

## License

MIT
