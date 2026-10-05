#!/usr/bin/env node
// LoLLM — Local LLM Gateway. CLI entry.

import path from 'node:path';
import { startServer } from '../src/server.js';
import { VERSION } from '../src/version.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data' || a === '--config') out.dataDir = path.resolve(argv[++i]);
    else if (a === '--no-auth') out.noAuth = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.version) {
  console.log(`lollm ${VERSION}`);
  process.exit(0);
}

if (args.help) {
  console.log(`LoLLM — Local LLM Gateway v${VERSION}

Pemakaian:
  lollm [opsi]

Opsi:
  --port <n>      Port (default 5151, env PORT)
  --host <addr>   Bind address (default 0.0.0.0, env HOST)
  --data <dir>    Direktori data (default ./data, env LOLLM_HOME)
  --no-auth       Matikan autentikasi gateway key
  --version       Versi
  --help          Bantuan

Path:
  /          Dashboard
  /v1/*      API OpenAI-compatible
  /api/*     Admin API dashboard
  /healthz   Health check`);
  process.exit(0);
}

const { server, port, host } = await startServer(args);
const hostLabel = host === '0.0.0.0' ? 'localhost' : host;

console.log(`
LoLLM Gateway v${VERSION}
   Dashboard : http://${hostLabel}:${port}
   API       : http://${hostLabel}:${port}/v1   (OpenAI-compatible)
   Health    : http://${hostLabel}:${port}/healthz

   Gateway key ada di file data/config.json — buka dashboard untuk melihat/menyalinnya.
   Tekan Ctrl+C untuk berhenti.
`);

const shutdown = () => {
  console.log('\nLoLLM berhenti.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
