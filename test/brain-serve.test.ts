// brain-serve (local viewer with real labels) answers only requests addressed to 127.0.0.1 / localhost:
// a DNS-rebinding page (its own name resolving to 127.0.0.1) is same-origin to the server and could read every route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const port = 5600 + (process.pid % 300);
const get = (path: string, host: string) => new Promise<number>((resolve, reject) => {
  request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject).end();
});

test('brain-serve refuses a foreign Host header on every route (DNS rebinding)', async () => {
  // no route below reaches the DB: the guard answers first, and a missing static file is a plain 404
  const p = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'brain-serve', '--port', String(port)],
    { cwd: ROOT, env: { ...process.env, MEMHUB_PG_SCHEMA: `memhub_brainserve_test_${process.pid}` } });
  try {
    await new Promise<void>((resolve, reject) => {
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.stdout.on('data', (d) => { if (String(d).includes(`127.0.0.1:${port}`)) resolve(); });
      p.on('exit', (c) => reject(new Error(`brain-serve exited ${c}: ${err.slice(-400)}`)));
    });
    for (const path of ['/graph.json', '/feed.json', '/live.json', '/search?q=x', '/']) assert.equal(await get(path, `evil.example:${port}`), 403, path);
    assert.equal(await get('/search?q=x', 'evil.example'), 403, 'no port');
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) assert.notEqual(await get('/no-such-file-here', host), 403, host);
  } finally { p.kill(); }
});

// --share (friends, through a tunnel): every route needs the link token, then its cookie; ลุงจืด's own AI calls never leave
test('brain-serve --share: nothing without the link token; the link sets the cookie; /live.json stays empty', async () => {
  const sp = port + 300; // beside the other test's port
  const call = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; cookie: string; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port: sp, path, headers: { host: `127.0.0.1:${sp}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? ''), body }));
    }).on('error', reject).end();
  });
  // no database at all (port 1): an empty scratch schema would fall through to the real tables (search_path ..., public)
  const p = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'brain-serve', '--share', '--no-tunnel', '--port', String(sp)],
    { cwd: ROOT, env: { ...process.env, MEMHUB_PG_PORT: '1' } });
  let out = '';
  try {
    const token = await new Promise<string>((resolve, reject) => {
      p.stdout.on('data', (d) => { out += d; const k = /\/\?k=([\w-]+)/.exec(out)?.[1]; if (k) resolve(k); });
      p.on('exit', (c) => reject(new Error(`brain-serve exited ${c}`)));
    });
    for (const path of ['/', '/graph.json', '/live.json', '/search?q=x', `/?k=${token.slice(1)}x`, `/?k=%C3%A9${token.slice(1)}`]) assert.equal((await call(path)).status, 403, path);
    assert.equal((await call('/', { cookie: `mh=é${token.slice(1)}` })).status, 403, 'a cookie of the same length, other bytes');
    assert.equal((await call('//')).status, 400, 'an unparsable URL is refused, not a 500 with the error text');
    const first = await call(`/?k=${token}`);
    assert.equal(first.status, 302);
    assert.match(first.cookie, new RegExp(`^mh=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=\\d+$`));
    const cookie = { cookie: `mh=${token}` };
    assert.deepEqual(JSON.parse((await call('/live.json', cookie)).body).calls, []);
    assert.notEqual((await call('/no-such-file-here', cookie)).status, 403, 'the cookie opens the static site');
    assert.equal((await call('/live.json', { ...cookie, host: `evil.example:${sp}` })).status, 403, 'the Host guard still runs first');
    // ลุงจืด: questions after passwords / keys / codes get no search at all (before the DB, so this answers even without one)
    for (const q of ['รหัสผ่าน wifi', 'api key ของ openai', 'mongodb uri']) assert.deepEqual(Object.values(await call(`/search?q=${encodeURIComponent(q)}`, cookie)).filter((v) => v !== ''), [422, 'secret'], q);
    // no database: the search fails (500, no error text) and must not leave the one-at-a-time lock taken
    for (const i of [1, 2]) {
      const r = await call('/search?q=%1B%5B2Jhi', cookie);
      assert.deepEqual([r.status, r.body], [500, 'error'], `search ${i}`);
    }
    assert.ok(out.includes('"\\u001b[2Jhi"') && !out.includes('\u001b'), 'a friend\'s question reaches the console quoted, no raw escape');
  } finally { p.kill(); }
});

// --open (memory.bcaicloud.com behind Caddy, ลุงจืด 2026-10-08: anyone may play): no token, the --share guards stay
test('brain-serve --open: no token needed, /live.json empty, secret questions refused, Host guard first', async () => {
  const op = port + 600;
  const call = (path: string, host = `127.0.0.1:${op}`) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port: op, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject).end();
  });
  const p = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'brain-serve', '--open', '--port', String(op)], { cwd: ROOT, env: { ...process.env, MEMHUB_PG_PORT: '1' } });
  try {
    await new Promise<void>((resolve, reject) => {
      p.stdout.on('data', (d) => { if (String(d).includes(`127.0.0.1:${op}`)) resolve(); });
      p.on('exit', (c) => reject(new Error(`brain-serve exited ${c}`)));
    });
    assert.deepEqual(JSON.parse((await call('/live.json')).body).calls, []);
    assert.deepEqual(Object.values(await call(`/search?q=${encodeURIComponent('api key ของ openai')}`)), [422, 'secret']);
    assert.deepEqual(Object.values(await call('/graph.json')), [500, 'error'], 'no database: no error text');
    assert.equal((await call('/live.json', `evil.example:${op}`)).status, 403);
  } finally { p.kill(); }
});
