#!/usr/bin/env node
// LoLLM — Local LLM Gateway. CLI entry.

import path from 'node:path';
import { startServer } from '../src/server.js';
import { Config, newGatewayKey, resolveDataDir } from '../src/config.js';
import { VERSION } from '../src/version.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data' || a === '--config') out.dataDir = path.resolve(argv[++i]);
    else if (a === '--no-auth') out.noAuth = true;
    else if (a === '--rotate') out.rotate = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// lollm key [--rotate] — cetak gateway key (untuk copy-paste ke klien) atau ganti sekaligus.
if (args._[0] === 'key') {
  const dir = resolveDataDir(args);
  const cfg = new Config(dir).load();
  if (args.rotate) {
    cfg.data.gateway.apiKeys = [newGatewayKey()];
    cfg.save();
    console.log(`Gateway key baru (lama tidak berlaku): ${cfg.data.gateway.apiKeys[0]}`);
  } else {
    console.log(`Data dir : ${dir}`);
    for (const k of cfg.data.gateway.apiKeys) console.log(`Key      : ${k}`);
    console.log('Pakai:   Authorization: Bearer <key>  ·  atau buka dashboard lalu salin dari tab Admin.');
  }
  process.exit(0);
}

if (args.version) {
  console.log(`lollm ${VERSION}`);
  process.exit(0);
}

if (args.help) {
  console.log(`LoLLM — Local LLM Gateway v${VERSION}

Pemakaian:
  lollm [opsi]

Perintah:
  lollm key            Cetak gateway key yang tersimpan
  lollm key --rotate   Ganti gateway key dengan yang baru

Opsi:
  --port <n>      Port (default 5151, env PORT)
  --host <addr>   Bind address (default 0.0.0.0, env HOST)
  --data <dir>    Direktori data (default ./data, env LOLLM_HOME)
  --no-auth       Matikan autentikasi gateway key
  --version       Versi
  --help          Bantuan

Path:
  /              Dashboard
  /v1/*          API OpenAI-compatible
  /api/*         Admin API dashboard
  /health        Health check (juga /healthz, /status, /v1/health)
  /live          Liveness probe — selalu 200 selama proses hidup
  /readyz        Readiness probe — 503 bila semua provider cooldown/mati

Contoh cepat:
  curl -X POST localhost:5151/v1/chat/completions \\
    -H "Authorization: Bearer <gateway-key>" -H "Content-Type: application/json" \\
    -d '{"model":"auto","messages":[{"role":"user","content":"halo"}]}'
  # respons membawa x-lollm-provider / x-lollm-model / x-lollm-fallbacks + field x_lollm`);
  process.exit(0);
}

const { server, port, host, config } = await startServer(args);
const hostLabel = host === '0.0.0.0' ? 'localhost' : host;
const dataDir = resolveDataDir(args);
const authOff = !config.data.settings.authRequired;

console.log(`
LoLLM Gateway v${VERSION}
   Dashboard : http://${hostLabel}:${port}
   API       : http://${hostLabel}:${port}/v1   (OpenAI-compatible)
   Health    : http://${hostLabel}:${port}/health   (readiness: /readyz)
   Auth      : ${authOff
    ? 'DIMATIKAN (--no-auth) — siapa pun yang menyentuh port ini bisa memakai gateway & mengubah pengaturan'
    : `aktif · gateway key di ${path.join(dataDir, 'config.json')} (salin lewat dashboard atau: node bin/lollm.js key)`}

   Tekan Ctrl+C untuk berhenti.
`);

const shutdown = () => {
  console.log('\nLoLLM berhenti.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
