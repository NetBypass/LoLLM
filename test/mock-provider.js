// LoLLM — Mock provider OpenAI-compatible untuk testing lokal.
// Perilaku berdasarkan API key:
//   sk-bad         → 401 (key mati)
//   sk-ratelimited → 429 + retry-after: 60 (cooldown)
//   sk-slow        → delay 30s (timeout)
//   key lain       → 200 normal (stream & non-stream)
// Pemakaian: node test/mock-provider.js [port] [--fail-all]
import http from 'node:http';

const port = Number(process.argv[2]) || 9101;
const failAll = process.argv.includes('--fail-all');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const url = req.url;

    if (failAll) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'mock 500' } }));
    }

    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'mock-1', object: 'model' }, { id: 'mock-2', object: 'model' }],
      }));
    }

    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      if (auth === 'sk-bad') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid key' } }));
      }
      if (auth === 'sk-ratelimited') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '60' });
        return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      }
      if (auth === 'sk-slow') {
        await new Promise((r) => setTimeout(r, 30000));
      }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const model = parsed.model || 'mock-1';
      const which = auth === 'sk-good' ? 'sk-good' : auth || 'nokey';
      const text = `Halo dari mock ${port} via ${which}! Model ${model}.`;

      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const chunk = (delta, finish = null, usage = null) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
            model, choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`;
        res.write(chunk({ role: 'assistant', content: '' }));
        for (const word of text.split(' ')) {
          await new Promise((r) => setTimeout(r, 25));
          res.write(chunk({ content: word + ' ' }));
        }
        res.write(chunk({}, 'stop', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url}` } }));
  });
});

server.listen(port, '127.0.0.1', () => console.log(`mock provider :${port} (${failAll ? 'fail-all' : 'behavior-by-key'})`));
