// LoLLM — Header CORS & daftar header kustom yang boleh dibaca klien browser.
// Satu sumber kebenaran: dipakai server.js dan router.js supaya tidak drift.

export const EXPOSED = [
  'x-lollm-provider', 'x-lollm-model', 'x-lollm-requested-model', 'x-lollm-trail', 'x-lollm-task',
  'x-lollm-attempts', 'x-lollm-fallbacks', 'x-lollm-fallback', 'x-lollm-selection', 'x-lollm-selection-reason',
  'x-lollm-low-confidence', 'x-lollm-empty-retries', 'x-lollm-params', 'x-lollm-error',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-window', 'retry-after',
];

export const ALLOWED_REQUEST_HEADERS = 'Authorization, Content-Type, x-lollm-session, x-lollm-route-key, x-lollm-conversation-id, x-api-key, anthropic-version';

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': ALLOWED_REQUEST_HEADERS,
  'Access-Control-Expose-Headers': EXPOSED.join(', '),
};
