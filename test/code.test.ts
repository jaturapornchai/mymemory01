// src/code.ts end to end on a scratch schema: a local bare repo stands in for a GitHub clone (no network).
// Index → search (AND, identifier split, Thai, OR fallback, repo/path filter) → edit / delete / copy in a 2nd repo → re-index.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-code-'));
const SCHEMA = `memhub_code_test_${process.pid}`;
Object.assign(process.env, { MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_CODE_DIR: join(tmp, 'code') });
const { connect, ROOT } = await import('../src/db.ts');
const code = await import('../src/code.ts');
const db = connect('rw');

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });
const work = (name: string) => { const d = join(tmp, 'work', name); mkdirSync(d, { recursive: true }); git(d, 'init', '-q', '-b', 'main'); return d; };
const put = (d: string, files: Record<string, string | Buffer>) => {
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), t); }
};
/** commit the work tree, then mirror it where syncRepos would have cloned it */
const publish = (d: string, full: string) => {
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'x');
  rmSync(code.repoDir(full), { recursive: true, force: true });
  git(tmp, 'clone', '-q', '--bare', d, code.repoDir(full));
};
const state = (repos: string[]) => writeFileSync(join(tmp, 'code', '_state.json'), JSON.stringify(Object.fromEntries(repos.map((r) => [r, { pushed: 'x', branch: 'main' }]))));
const search = async (q: string, o = {}) => (await code.codeSearch(db, q, o)).map((h) => h.files.map((f) => `${f.repo}/${f.path}:${h.line0}`).join(','));

const A = work('a');
before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  execFileSync(process.execPath, ['--no-warnings', join(ROOT, 'src', 'cli.ts'), 'migrate'], { env: process.env, stdio: 'pipe' });
  assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
});
after(async () => { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await db.end(); rmSync(tmp, { recursive: true, force: true }); });

test('keepPath: source kept; deps, locks, generated, binaries, secrets, submodules, big files skipped', () => {
  const k = (p: string, size = 10, mode = '100644') => code.keepPath(p, size, mode);
  assert.ok(k('src/receipt.go') && k('lib/a.dart') && k('Makefile') && k('run.sh', 10, '100755'));
  for (const p of ['node_modules/x/i.js', 'web/dist/app.js', 'pnpm-lock.yaml', 'go.sum', 'a.min.js', 'm.g.dart', 'logo.png', 'f.woff2',
    '.env', 'cfg/.env.production', 'id_rsa', 'server.pem', 'credentials.json', 'venv/lib/python3.9/site-packages/x.py', 'lib/python3.11/os.py'])
    assert.ok(!k(p), p);
  assert.ok(!k('sub', 10, '160000') && !k('link', 10, '120000') && !k('big.cs', code.MAX_BYTES + 1) && !k('empty.ts', 0));
});

test('chunkCode: ≤60 lines per chunk, 1-based start lines, blank chunks dropped', () => {
  const c = code.chunkCode('a\r\nb\n' + 'x\n'.repeat(130));
  assert.deepEqual(c.map((x) => [x.line0, x.text.split('\n').length]), [[1, 60], [61, 60], [121, 12]]);
  assert.deepEqual(code.chunkCode('\n\n  \n'), []);
  assert.equal(code.blobText(Buffer.from([0x61, 0, 0x62])), null);
  assert.equal(code.blobText(Buffer.from([0xbb, 0xc5, 0xd2])), 'ปลา'); // TIS-620
});

test('index + search: AND across words, identifier parts, Thai, OR fallback, filters, links', async () => {
  put(A, {
    'svc/receipt.go': 'package svc\n\n// ออกใบกำกับภาษีให้ลูกค้า\nfunc CreateTaxInvoice(customerId string) error {\n  return nil\n}\n',
    'web/user.ts': 'export function getUserById(id: string) { return db.users.find(id); }\n',
    'logo.png': Buffer.from([0x89, 0x50, 0, 1]), 'notes.bin.txt': Buffer.from([0x61, 0, 0x62]),
    '.env': 'NOT_INDEXED=zzqqenvonly\n', 'node_modules/x/index.js': 'export const getUserById = 1;\n',
  });
  publish(A, 'me/app'); state(['me/app']);
  const s = await code.indexCode(db, () => {});
  assert.equal(s.repos, 1);
  assert.deepEqual((await db.query('SELECT path FROM code_files ORDER BY path')).rows.map((r) => r.path), ['notes.bin.txt', 'svc/receipt.go', 'web/user.ts']);
  assert.deepEqual(await search('tax invoice customer'), ['me/app/svc/receipt.go:1']);
  assert.deepEqual(await search('user'), ['me/app/web/user.ts:1']);           // getUserById → user
  assert.deepEqual(await search('ใบกำกับภาษี'), ['me/app/svc/receipt.go:1']);
  assert.deepEqual(await search('getuserbyid nosuchword'), ['me/app/web/user.ts:1']); // AND finds nothing → OR
  assert.deepEqual(await search("zzqqenvonly"), []); // .env never indexed
  assert.deepEqual(await search('user', { path: '.go' }), []);
  assert.deepEqual(await search('user', { repo: 'other' }), []);
  const [h] = await code.codeSearch(db, 'CreateTaxInvoice');
  const t = code.codeHitText(h, 'CreateTaxInvoice');
  assert.match(t, /^me\/app\/svc\/receipt\.go:1-6\nhttps:\/\/github\.com\/me\/app\/blob\/HEAD\/svc\/receipt\.go#L1-L6\n/);
  assert.match(t, /    4\| func CreateTaxInvoice/);
  assert.deepEqual(await code.indexCode(db, () => {}), { repos: 0, files: 0, gone: 0, blobs: 0, chunks: 0 }); // nothing changed → nothing read
});

test('re-index: edited file replaced, deleted file gone, a copy in another repo stored once', async () => {
  put(A, { 'svc/receipt.go': 'package svc\n\nfunc VoidReceipt() {}\n' });
  unlinkSync(join(A, 'web/user.ts'));
  publish(A, 'me/app');
  const B = work('b');
  put(B, { 'copy/receipt.go': 'package svc\n\nfunc VoidReceipt() {}\n' });
  publish(B, 'org/fork-ish'); state(['me/app', 'org/fork-ish']);
  const s = await code.indexCode(db, () => {});
  assert.equal(s.gone, 1);
  assert.equal(s.blobs, 1, 'the copy in org/fork-ish is not read again');
  assert.deepEqual(await search('CreateTaxInvoice'), []);
  assert.deepEqual(await search('user'), []);
  assert.deepEqual(await search('VoidReceipt'), ['me/app/svc/receipt.go:1,org/fork-ish/copy/receipt.go:1']);
  assert.equal((await db.query('SELECT count(*)::int n FROM code_chunks')).rows[0].n, 1, 'old blobs removed, the shared one kept once');
  assert.match(code.codeHitText((await code.codeSearch(db, 'VoidReceipt'))[0], 'VoidReceipt'), /\(\+1 copies: org\/fork-ish\/copy\/receipt\.go\)/);
});
