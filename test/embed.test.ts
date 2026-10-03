// embedQuery (search hot path) against a fake Ollama: at waitMs a resident model (GPU busy) → abort + keyword-only (late
// requests pile up in Ollama's queue); a model that is not resident is worth one wait and never aborted (that cancels the load).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const fake = { resident: true, delay: 0, fail: false, aborted: 0 };
const server = createServer((req, res: ServerResponse) => {
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: fake.resident ? [{ name: 'bge-m3:latest' }] : [] }));
  req.resume();
  res.on('close', () => { if (!res.writableFinished) fake.aborted++; });
  setTimeout(() => {
    if (fake.fail) { res.statusCode = 500; return res.end('{"error":"boom"}'); }
    res.end(JSON.stringify({ embeddings: [[0.5, 0.25]] }));
  }, fake.delay);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.MEMHUB_EMBED_MODEL = 'bge-m3';
const { embedQuery } = await import('../src/embed.ts');
after(() => { server.closeAllConnections(); server.close(); });
const timed = async (waitMs: number) => { const t0 = performance.now(); const v = await embedQuery('q', waitMs); return { v, ms: performance.now() - t0 }; };

test('warm model → the vector', async () => {
  Object.assign(fake, { resident: true, delay: 5, fail: false });
  assert.deepEqual((await timed(300)).v, [0.5, 0.25]);
});

test('busy GPU (model resident, slow reply) → keyword-only at waitMs, and the request is aborted', async () => {
  Object.assign(fake, { resident: true, delay: 600, fail: false, aborted: 0 });
  const { v, ms } = await timed(100);
  assert.equal(v, null);
  assert.ok(ms < 500, `waited ${ms} ms`);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(fake.aborted, 1);
});

test('cold model (not resident = loading) → waits for the load instead of keyword-only', async () => {
  Object.assign(fake, { resident: false, delay: 600, fail: false, aborted: 0 });
  const { v, ms } = await timed(100);
  assert.deepEqual(v, [0.5, 0.25]);
  assert.ok(ms >= 550, `returned after ${ms} ms`);
  assert.equal(fake.aborted, 0);
});

test('embedder error → keyword-only right away', async () => {
  Object.assign(fake, { resident: true, delay: 0, fail: true });
  const { v, ms } = await timed(300);
  assert.equal(v, null);
  assert.ok(ms < 250, `took ${ms} ms`);
});
