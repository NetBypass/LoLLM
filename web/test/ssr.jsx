// Smoke test SSR: render semua halaman dengan data fixture test-only — menangkap
// ReferenceError/undefined crash. Fixture ini TIDAK PERNAH dipakai runtime gateway;
// gateway selalu memakai data nyata dari endpoint provider.
// Jalankan: npm test (dari web/)
import { renderToString } from 'react-dom/server';
import { StoreContext } from '../src/store.jsx';
import Overview from '../src/pages/Overview.jsx';
import Playground from '../src/pages/Playground.jsx';
import Providers from '../src/pages/Providers.jsx';
import Routing from '../src/pages/Routing.jsx';
import Logs from '../src/pages/Logs.jsx';
import Admin from '../src/pages/Admin.jsx';

const now = Date.now();

const fixture = {
  tab: 'logs',
  go() {},
  boot: {
    version: '0.1.0-test',
    gatewayKeys: ['lollm-testkey'],
    catalog: [
      { id: 'groq', name: 'Groq', tier: 'free', style: 'openai', baseUrl: 'https://api.groq.com/openai/v1', getKey: 'https://x', note: 'cepat', defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], priority: 10 },
      { id: 'pollinations', name: 'Pollinations', tier: 'free', baseUrl: 'https://x', keyless: true, note: 'tanpa key', defaultModel: 'openai', models: ['openai'], priority: 30 },
    ],
    customProviders: [
      { id: 'contoh', name: 'Contoh Custom', tier: 'custom', style: 'openai', baseUrl: 'https://gateway.contoh.dev/v1', getKey: null, note: 'Custom provider', defaultModel: 'contoh-model-a', models: [], priority: 60 },
    ],
    providers: {
      groq: { enabled: true, keys: [{ id: 'k1', label: 'key-1', value: 'fixture-key', addedAt: now, status: 'ok', enabled: true, success: 3, fail: 1 }], meta: { name: 'Groq', tier: 'free', baseUrl: 'x' } },
      pollinations: { enabled: true, keys: [{ id: 'keyless', label: 'keyless', value: '', status: 'ok', enabled: true, success: 1, fail: 0 }], meta: { name: 'Pollinations', tier: 'free', baseUrl: 'x' } },
      contoh: { enabled: true, keys: [{ id: 'k2', label: 'key-2', value: 'fixture-key-mati', status: 'dead', enabled: true, success: 0, fail: 2, lastError: 'HTTP 401' }], meta: { name: 'Contoh Custom', tier: 'custom', baseUrl: 'x' } },
    },
    settings: {
      strategy: 'failover', providerOrder: ['groq', 'contoh'], maxAttempts: 6,
      authRequired: true, allowAnyFallback: true,
      timeouts: { connectMs: 8000, firstByteMs: 20000, totalMs: 180000, streamIdleMs: 60000 },
    },
    dashboard: { loginEnabled: true, defaultPassword: true },
  },
  status: {
    version: '0.1.0-test', uptimeSec: 125, port: 5151,
    stats: { requests: 12, ok: 9, fail: 3, fallbacks: 4, totalMs: 5400, tokensIn: 420, tokensOut: 210, byProvider: { groq: { ok: 8, fail: 1, ms: 3000 } } },
    health: [
      { id: 'groq', name: 'Groq', tier: 'free', state: 'up', keys: { ok: 1, cooling: 0, dead: 0, disabled: 0 }, baseUrl: 'https://api.groq.com/openai/v1', keyless: false },
      { id: 'contoh', name: 'Contoh Custom', tier: 'custom', state: 'down', keys: { ok: 0, cooling: 0, dead: 1, disabled: 0 }, baseUrl: 'http://x', keyless: false },
    ],
  },
  logs: [
    { ts: now - 4000, requestId: 'r1', model: 'auto', finalModel: 'llama-3.3-70b-versatile', provider: 'groq', key: 'key-1', stream: true, status: 200, ms: 340, usage: '11→7', trail: [] },
    { ts: now - 9000, requestId: 'r2', model: 'contoh-model-a', stream: false, status: 502, ms: 8200, trail: [{ provider: 'contoh', key: 'key-2', model: 'contoh-model-a', kind: 'auth', status: 401, error: 'HTTP 401 dari Contoh Custom', ms: 500 }, { provider: 'pollinations', key: 'keyless', model: 'openai', kind: 'network', status: 0, error: 'getaddrinfo ENOTFOUND', ms: 8000 }] },
    { ts: now - 20000, requestId: 'r3', model: 'gemini-flash', stream: true, status: 'aborted', ms: 420, trail: [] },
    { ts: now - 60000, requestId: 'r4', model: 'llama-3.3-70b', finalModel: 'llama-3.3-70b-versatile', provider: 'groq', key: 'key-1', stream: false, status: 200, ms: 900, usage: '20→15', trail: [{ provider: 'contoh', key: 'key-2', kind: 'rate', status: 429, error: '429', ms: 100 }] },
  ],
  models: [{ id: 'llama-3.3-70b-versatile', provider: 'groq' }, { id: 'openai', provider: 'pollinations' }, { id: 'contoh-model-a', provider: 'contoh' }],
  toasts: [],
  toast() {},
  reload: async () => {},
  refreshBoot: async () => {},
  refreshStatus: async () => {},
  refreshLogs: async () => {},
  refreshModels: async () => {},
};

const PAGES = [
  ['overview', Overview],
  ['playground', Playground],
  ['providers', Providers],
  ['routing', Routing],
  ['logs', Logs],
  ['admin', Admin],
];

let failed = 0;
for (const [name, Page] of PAGES) {
  try {
    const html = renderToString(
      <StoreContext.Provider value={fixture}>
        <Page />
      </StoreContext.Provider>
    );
    const checks = {
      overview: html.includes('Kesehatan provider'),
      playground: html.includes('Tulis pesan'),
      providers: html.includes('Provider gratis'),
      routing: html.includes('Strategi routing') && !html.includes('Gateway API key'),
      logs: html.includes('Log request') && html.includes('Jejak fallback'),
      admin: html.includes('Akses dashboard') && html.includes('Ganti password'),
    };
    const ok = checks[name];
    console.log(`${ok ? '✓' : '⚠'}  ${name.padEnd(11)} ${html.length.toString().padStart(6)} chars${ok ? '' : ' (konten tak terverifikasi)'}`);
    if (!ok) failed++;
  } catch (e) {
    console.error(`✗  ${name} CRASH:`, e.message);
    failed++;
  }
}

if (failed) { console.error(`\n${failed} halaman bermasalah`); process.exit(1); }
console.log('\nSEMUA HALAMAN RENDER OK');
