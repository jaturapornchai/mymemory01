// Job health line: cli.ts records health:<job> (ok / redacted error) around every background job; SessionStart prints ONE line
// only when a job failed or went stale, inside the 2000-char budget, the same for every app. Fault injection in an own
// throwaway schema + temp vault: a dream whose claude CLI fails, an OAuth error, a stale hourly.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-health-'));
const SCHEMA = `memhub_health_test_${process.pid}`;
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_MEMORY_VAULT: join(tmp, 'vault'),
  MEMHUB_VAULTS: '', MEMHUB_NO_REINDEX: '1' };
for (const k of ['MEMORY_HUB_INTERNAL', 'MEMHUB_ANTHROPIC_ONLY', 'ANTHROPIC_BASE_URL']) delete ENV[k];
Object.assign(process.env, ENV);
const { connect, ROOT } = await import('../src/db.ts');
const { normProject, store, syncFailed } = await import('../src/importer.ts');
const { saveNote, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { bkkDay } = await import('../src/daily.ts');

const db = connect('rw');
const PROJECT = normProject(ROOT); // the hook runs with cwd = ROOT
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const LINE = /^งานเบื้องหลังมีปัญหา: .*$/m;

function sessionStart(app?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'src', 'session-start.ts'), ...(app ? ['--app', app] : [])], { env: ENV, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve(out ? JSON.parse(out).hookSpecificOutput.additionalContext : ''));
    p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-health', cwd: ROOT }));
  });
}
const setHealth = async (job: string, v: object) => {
  await guard();
  await db.query(`INSERT INTO state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [`health:${job}`, v]);
};
const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await db.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO memhub_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO memhub_ro`);
  // a full budget: 8 long rules, so the line must fit inside the 2000 chars, not on top of them
  for (let i = 0; i < 8; i++) saveNote(`กฎ healthrule${i}: ${'ใช้พอร์ต 5441 กับ memory-hub เท่านั้น ห้ามแตะ 5434 '.repeat(6)}`, { project: PROJECT, kind: 'rule' });
  await indexVault(db, MEMORY_VAULT);
  // one finished chat the dream would summarize (2 h old)
  const ts = ago(2);
  await store(db, { tool: 'claude', path: join(tmp, 'h1.jsonl'), kind: 'main', sessionId: 'h1', project: PROJECT, size: 1, mtimeMs: 1, sha256: 'h1',
    label: 'p', replace: true }, [{ uuid: 'h1-u0', parentUuid: null, seq: 0, role: 'user', ts, text: 'ช่วยตั้ง backup ของ memhub ทุกคืนตอนตีสาม' }]);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('all jobs ok and fresh → no line', async () => {
  for (const job of ['sync', 'dream', 'consolidate', 'lint', 'daily', 'embed']) await setHealth(job, { ok: true, at: ago(1) });
  const ctx = await sessionStart();
  assert.match(ctx, /healthrule\d.*\n[^]*…อีก \d+ ข้อ/, ctx); // 8 long rules: the newest that fit, the rest counted
  assert.doesNotMatch(ctx, LINE);
  assert.ok(ctx.length <= 2000);
});

test('a dream whose claude CLI fails: the error reaches health:dream, exit code kept, SessionStart shows the line', async () => {
  // fake claude = node itself: "bad option: --model" → no output → the dream throws, like the OAuth failure did
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'dream', '--force'], { encoding: 'utf8', env: { ...ENV, MEMHUB_CLAUDE_BIN: process.execPath } });
  assert.notEqual(r.status, 0, 'a failed dream still exits non-zero');
  const v = (await db.query(`SELECT v FROM state WHERE k = 'health:dream'`)).rows[0].v;
  assert.equal(v.ok, false);
  assert.match(v.err, /^claude exited/);
  assert.ok(v.err.length <= 120 && !v.err.includes('\n'));
  const ctx = await sessionStart();
  assert.match(ctx, /^งานเบื้องหลังมีปัญหา: dream ล้มเหลว: claude exited/m);
  assert.ok(ctx.length <= 2000);
});

test('OAuth expired → the line names the fix; same line for another app; ≤150 chars, total ≤2000', async () => {
  await setHealth('dream', { ok: false, at: ago(9), err: 'claude: Failed to authenticate: OAuth session expired and could not be refreshed' });
  const [claude, codex] = await Promise.all([sessionStart(), sessionStart('codex')]);
  const line = claude.match(LINE)![0];
  assert.match(line, /dream ล้มเหลว \(แก้: claude \/login\)/);
  assert.ok(line.length <= 150, line);
  assert.equal(codex.match(LINE)?.[0], line);
  assert.ok(claude.length <= 2000 && codex.length <= 2000);
  assert.ok(claude.indexOf(line) < claude.indexOf('กฎ/ข้อตกลง'), 'shown first');
});

test('stale hourly sync (5 h) → line; back to fresh → gone', async () => {
  await setHealth('dream', { ok: true, at: ago(1) });
  await setHealth('sync', { ok: true, at: ago(5) });
  assert.match(await sessionStart(), /^งานเบื้องหลังมีปัญหา: sync ไม่ได้รันมา 5 ชม\.$/m);
  await setHealth('sync', { ok: true, at: ago(0.5) });
  assert.doesNotMatch(await sessionStart(), LINE);
});

test('lint (a read-only job) still records its health row', async () => {
  await db.query(`DELETE FROM state WHERE k = 'health:lint'`);
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'lint', '--dry'], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await db.query(`SELECT v FROM state WHERE k = 'health:lint'`)).rows[0]?.v.ok, true);
});

const CLI = join(ROOT, 'src', 'cli.ts');
const allOk = async () => { for (const job of ['sync', 'dream', 'consolidate', 'lint', 'daily', 'embed']) await setHealth(job, { ok: true, at: ago(1) }); };
/** Holds job locks on its own connection, as a hung run would. */
async function holding<T>(keys: string[], f: () => Promise<T> | T): Promise<T> {
  const c = await db.connect();
  try { for (const k of keys) await c.query(`SELECT pg_advisory_lock(hashtext($1))`, [k]); return await f(); }
  finally { await c.query(`SELECT pg_advisory_unlock_all()`); c.release(); }
}
const dreamRun = () => spawnSync(process.execPath, [CLI, 'dream', '--force'], { encoding: 'utf8', env: { ...ENV, MEMHUB_CLAUDE_BIN: process.execPath } });

test('a run skipped by its lock keeps the previous health row: a hung dream still goes stale', async () => {
  await allOk();
  await setHealth('dream', { ok: true, at: ago(40) });
  const before = (await db.query(`SELECT v FROM state WHERE k = 'health:dream'`)).rows[0].v;
  const r = await holding([`${SCHEMA}:memhub-dream`], dreamRun);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"status":"locked"/);
  assert.deepEqual((await db.query(`SELECT v FROM state WHERE k = 'health:dream'`)).rows[0].v, before);
  assert.match(await sessionStart(), /^งานเบื้องหลังมีปัญหา: dream ไม่ได้รันมา 40 ชม\.$/m);
});

test('job locks are per schema: a peer scratch schema (another test file) holding its dream lock does not block this one', async () => {
  // the peer's key, and the DB-wide one every schema shared before (dream.test.ts + this file blocked each other)
  const r = await holding([`${SCHEMA}_peer:memhub-dream`, 'memhub-dream'], dreamRun);
  assert.doesNotMatch(r.stdout, /"status":"locked"/);
  assert.match((await db.query(`SELECT v FROM state WHERE k = 'health:dream'`)).rows[0].v.err, /^claude exited/); // it ran (fake claude fails)
});

test('a job error naming a local path is stored as <path>: no Windows user name in the line every app sees', async () => {
  await allOk();
  writeFileSync(join(tmp, 'afile'), 'x'); // --out under a file → mkdir fails with the full path
  spawnSync(process.execPath, [CLI, 'daily', bkkDay(new Date()), '--out', join(tmp, 'afile', 'sub')], { encoding: 'utf8', env: ENV });
  const v = (await db.query(`SELECT v FROM state WHERE k = 'health:daily'`)).rows[0].v;
  assert.equal(v.ok, false);
  assert.match(v.err, /<path>/);
  assert.doesNotMatch(v.err, /[A-Za-z]:[\/]|Users|AppData|memhub-health-/, v.err);
  assert.doesNotMatch((await sessionStart('codex')).match(LINE)![0], /Users|AppData/);
});

test('Ollama down reaches embed as "fetch failed" / ECONNREFUSED → the line says เปิด Ollama', async () => {
  await allOk();
  await setHealth('embed', { ok: false, at: ago(1), err: 'fetch failed' });
  assert.match(await sessionStart(), /^งานเบื้องหลังมีปัญหา: embed ล้มเหลว \(เปิด Ollama\): fetch failed$/m);
  await setHealth('embed', { ok: false, at: ago(1), err: 'connect ECONNREFUSED 127.0.0.1:11434' });
  assert.match(await sessionStart(), /embed ล้มเหลว \(เปิด Ollama\)/);
  await setHealth('embed', { ok: true, at: ago(1) });
});

test('a sync whose source failed or stopped (Google token refresh) counts as failed; skipped / not set up does not', () => {
  assert.equal(syncFailed({ codex: { copied: 1 }, google: { skipped: 'not logged in: node src/cli.ts google login' } }), false);
  assert.equal(syncFailed({ codex: { copied: 1 }, google: { messages: 3, stopped: 'token refresh failed: HTTP 400 invalid_grant' } }), true);
  assert.equal(syncFailed({ codex: 'failed: EPERM' }), true);
});
